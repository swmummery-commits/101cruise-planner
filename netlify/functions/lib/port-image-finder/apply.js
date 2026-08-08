/**
 * Apply a selected port image candidate to ports + media_library.
 */

const crypto = require("crypto");
const { primaryName } = require("./queries");
const {
  licenseIsUsable,
  scorePortImageCandidate,
  statusForCandidate,
  candidatePassesEligibility,
  isMilitaryWarDestinationImagery
} = require("./scoring");
const { assertCanonicalApplyTarget } = require("./port-resolution");
const { editorialRating, hasWrongGeographyForPort } = require("./public-image-audit");

const BUCKET = "cruise-media";
const VALID_STATUS = new Set(["MANUAL", "AUTO_APPROVED", "NEEDS_REVIEW", "NO_IMAGE"]);
const MIN_WIKIMEDIA_DOWNLOAD_INTERVAL_MS = 3000;

let lastWikimediaDownloadAt = 0;

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "port";
}

function guessContentType(url) {
  const lower = String(url || "").toLowerCase();
  if (/\.png(\?|$)/.test(lower)) return "image/png";
  if (/\.webp(\?|$)/.test(lower)) return "image/webp";
  return "image/jpeg";
}

function extensionForType(contentType) {
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  return ".jpg";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDuplicateStoragePathError(error) {
  return /duplicate key|media_library_storage_path_uidx|already exists/i.test(String(error?.message || ""));
}

async function getMediaByStoragePath(supabase, storagePath) {
  const rows = await supabase.fetchRest(
    `media_library?select=id,title,storage_path,public_url,source_url,import_source&storage_path=eq.${encodeURIComponent(storagePath)}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

function isWikimediaUrl(url) {
  return /wikimedia\.org|upload\.wikimedia/i.test(String(url || ""));
}

async function downloadImage(url, timeoutMs = 12_000, attempt = 0) {
  if (isWikimediaUrl(url)) {
    const wait = Math.max(0, MIN_WIKIMEDIA_DOWNLOAD_INTERVAL_MS - (Date.now() - lastWikimediaDownloadAt));
    if (wait > 0) await sleep(wait);
    lastWikimediaDownloadAt = Date.now();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "image/*" }
    });
    if (response.status === 429 && attempt < 2) {
      clearTimeout(timer);
      const retryAfter = Number(response.headers.get("retry-after") || "3");
      await sleep(Math.min(Math.max(retryAfter, 3) * 1000, 60_000));
      return downloadImage(url, timeoutMs, attempt + 1);
    }
    if (!response.ok) {
      throw new Error(`Image download failed (${response.status})`);
    }
    const contentType = response.headers.get("content-type") || guessContentType(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 2048) throw new Error("Downloaded image is too small");
    if (buffer.length > 10 * 1024 * 1024) throw new Error("Downloaded image exceeds 10MB limit");
    return { buffer, contentType };
  } finally {
    clearTimeout(timer);
  }
}

function canOverwritePortImage(port, { force = false, replaceAutoApproved = false } = {}) {
  if (!port) return false;
  const status = String(port.image_status || "").toUpperCase();
  if (status === "MANUAL" && port.hero_media_id && !force) return false;
  if (status === "AUTO_APPROVED" && port.hero_media_id && !replaceAutoApproved) return false;
  return true;
}

function canReplaceAutoApprovedPortImage(port) {
  return (
    String(port?.image_status || "").toUpperCase() === "AUTO_APPROVED" &&
    Boolean(port?.hero_media_id)
  );
}

function assertCandidateApplicable(candidate, { imageStatus = "MANUAL" } = {}) {
  const provider = String(candidate?.provider || "").toLowerCase();
  if (provider === "brave" && !licenseIsUsable(candidate)) {
    const err = new Error(
      "Brave images cannot be applied without a clear reusable licence. Use Wikimedia or approve manually after verifying rights."
    );
    err.statusCode = 400;
    err.calm = true;
    throw err;
  }
  if (provider === "brave" && imageStatus === "AUTO_APPROVED" && !licenseIsUsable(candidate)) {
    const err = new Error("Unlicensed Brave candidates cannot be auto-approved.");
    err.statusCode = 400;
    err.calm = true;
    throw err;
  }
}

/**
 * Promote a stored NEEDS_REVIEW image to MANUAL without re-downloading or creating duplicate media.
 */
async function approveReviewedPortImage(supabase, port) {
  if (!port?.id) {
    const err = new Error("Port is required.");
    err.statusCode = 400;
    err.calm = true;
    throw err;
  }
  if (String(port.image_status || "").toUpperCase() !== "NEEDS_REVIEW" || !port.hero_media_id) {
    const err = new Error("Only stored NEEDS_REVIEW images can be approved for Explore display.");
    err.statusCode = 400;
    err.calm = true;
    throw err;
  }

  const rows = await supabase.fetchRest(`ports?id=eq.${encodeURIComponent(port.id)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: { image_status: "MANUAL" }
  });
  const updated = Array.isArray(rows) ? rows[0] : rows;
  if (!updated?.id) throw new Error("Port was not updated after approval.");

  return { port: updated, media: null, approved_existing: true };
}

/**
 * @param {object} supabase - { fetchRest(path, options) }
 * @param {object} port
 * @param {object} candidate
 * @param {{ imageStatus?: string, force?: boolean }} [options]
 */
async function applyPortImageCandidate(supabase, port, candidate, options = {}) {
  if (options.resolutionSpec) {
    assertCanonicalApplyTarget(options.resolutionSpec, port);
  }
  if (!canOverwritePortImage(port, options)) {
    const status = String(port.image_status || "").toUpperCase();
    const err = new Error(
      status === "AUTO_APPROVED"
        ? "This port has an AUTO_APPROVED image. Use replace_auto_approved to replace it deliberately."
        : "This port has a manual image and cannot be overwritten automatically."
    );
    err.statusCode = 409;
    err.calm = true;
    throw err;
  }

  const imageUrl = String(candidate?.url || "").trim();
  if (!imageUrl || !/^https:\/\//i.test(imageUrl)) {
    const err = new Error("A valid HTTPS image URL is required.");
    err.statusCode = 400;
    err.calm = true;
    throw err;
  }

  const imageStatus = String(options.imageStatus || "MANUAL").trim().toUpperCase();
  if (!VALID_STATUS.has(imageStatus)) {
    const err = new Error("Invalid image status.");
    err.statusCode = 400;
    err.calm = true;
    throw err;
  }

  assertCandidateApplicable(candidate, { imageStatus });

  const portName = primaryName(port);
  const { buffer, contentType } = await downloadImage(imageUrl);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  const ext = extensionForType(contentType);
  const storagePath = `ports/${slugify(portName)}/${hash}${ext}`;
  const publicUrl = supabase.publicObjectUrl(storagePath);

  await supabase.uploadObject(BUCKET, storagePath, buffer, contentType);

  const mediaPayload = {
    title: candidate?.title || `${portName} cruise port`,
    alt_text: candidate?.title || `${portName} cruise port`,
    media_type: "port",
    storage_bucket: BUCKET,
    storage_path: storagePath,
    public_url: publicUrl,
    file_name: `${slugify(portName)}${ext}`,
    mime_type: contentType,
    width: candidate?.width || null,
    height: candidate?.height || null,
    file_size_bytes: buffer.length,
    port_name: portName,
    destination_name: port?.country || null,
    source_url: candidate?.sourceUrl || candidate?.pageUrl || imageUrl,
    import_source: `port_image_finder:${candidate?.provider || "unknown"}`,
    is_default: true,
    is_active: true
  };

  let media = await getMediaByStoragePath(supabase, storagePath);
  if (!media) {
    try {
      const mediaRows = await supabase.fetchRest("media_library", {
        method: "POST",
        prefer: "return=representation",
        body: mediaPayload
      });
      media = Array.isArray(mediaRows) ? mediaRows[0] : mediaRows;
    } catch (error) {
      if (!isDuplicateStoragePathError(error)) throw error;
      media = await getMediaByStoragePath(supabase, storagePath);
      if (!media?.id) throw error;
    }
  }
  if (!media?.id) throw new Error("media_library row was not created");

  const portPatch = {
    hero_media_id: media.id,
    image_status: imageStatus,
    image_source: candidate?.provider || "manual",
    image_source_url: candidate?.sourceUrl || candidate?.pageUrl || imageUrl,
    image_credit: candidate?.credit || null,
    image_license: candidate?.license || null,
    image_search_query: options.searchQuery || null,
    image_confidence: candidate?.confidence ?? options.confidence ?? null,
    image_last_checked_at: new Date().toISOString(),
    image_candidates: []
  };

  const updatedRows = await supabase.fetchRest(`ports?id=eq.${encodeURIComponent(port.id)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: portPatch
  });
  const updated = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;

  return { port: updated, media, approved_existing: false };
}

function repairReplacementEligible(scored, port, candidate) {
  if (!licenseIsUsable(candidate)) return false;
  if (scored.vesselPrimary || isMilitaryWarDestinationImagery(candidate)) return false;
  if (hasWrongGeographyForPort(port, candidate)) return false;
  const editorial = editorialRating(scored, port, candidate);
  if (editorial !== "GOOD" && editorial !== "ACCEPTABLE") return false;
  if (scored.geographic < 55 || scored.suitability < 50) return false;
  return true;
}

/**
 * Deliberately replace an existing AUTO_APPROVED port image.
 * Does not delete the previous media_library row (may still be referenced elsewhere).
 */
async function replaceAutoApprovedPortImage(supabase, port, candidate, options = {}) {
  if (!canReplaceAutoApprovedPortImage(port)) {
    const err = new Error("Only stored AUTO_APPROVED port images can be replaced through this action.");
    err.statusCode = 409;
    err.calm = true;
    throw err;
  }

  if (options.resolutionSpec) {
    assertCanonicalApplyTarget(options.resolutionSpec, port);
  }

  const scored = { candidate, ...scorePortImageCandidate(candidate, port) };
  if (!repairReplacementEligible(scored, port, candidate)) {
    const err = new Error("Replacement candidate is not eligible under current port image rules.");
    err.statusCode = 400;
    err.calm = true;
    throw err;
  }

  const editorial = editorialRating(scored, port, candidate);
  let imageStatus = String(options.imageStatus || "AUTO_APPROVED").trim().toUpperCase();
  if (imageStatus === "AUTO_APPROVED") {
    const autoEligible = statusForCandidate(scored) === "AUTO_APPROVED";
    const repairAuto =
      editorial === "GOOD" ||
      (editorial === "ACCEPTABLE" && scored.geographic >= 70 && scored.suitability >= 55);
    if (!autoEligible && !repairAuto) {
      imageStatus = "NEEDS_REVIEW";
    }
  }

  const previousMediaId = port.hero_media_id;
  const result = await applyPortImageCandidate(supabase, port, candidate, {
    ...options,
    imageStatus,
    replaceAutoApproved: true
  });

  return {
    ...result,
    previous_media_id: previousMediaId,
    replaced: true,
    editorial
  };
}

function __resetDownloadThrottleForTests() {
  lastWikimediaDownloadAt = 0;
}

module.exports = {
  applyPortImageCandidate,
  approveReviewedPortImage,
  replaceAutoApprovedPortImage,
  canOverwritePortImage,
  canReplaceAutoApprovedPortImage,
  downloadImage,
  assertCandidateApplicable,
  assertCanonicalApplyTarget,
  getMediaByStoragePath,
  isDuplicateStoragePathError,
  __resetDownloadThrottleForTests
};
