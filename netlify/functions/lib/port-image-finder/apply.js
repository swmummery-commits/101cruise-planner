/**
 * Apply a selected port image candidate to ports + media_library.
 */

const crypto = require("crypto");
const { primaryName } = require("./queries");

const BUCKET = "cruise-media";
const VALID_STATUS = new Set(["MANUAL", "AUTO_APPROVED", "NEEDS_REVIEW", "NO_IMAGE"]);

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

async function downloadImage(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "image/*" }
    });
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

function canOverwritePortImage(port, { force = false } = {}) {
  if (!port) return false;
  if (port.image_status === "MANUAL" && port.hero_media_id && !force) return false;
  return true;
}

/**
 * @param {object} supabase - { fetchRest(path, options) }
 * @param {object} port
 * @param {object} candidate
 * @param {{ imageStatus?: string, force?: boolean }} [options]
 */
async function applyPortImageCandidate(supabase, port, candidate, options = {}) {
  if (!canOverwritePortImage(port, options)) {
    const err = new Error("This port has a manual image and cannot be overwritten automatically.");
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

  const mediaRows = await supabase.fetchRest("media_library", {
    method: "POST",
    prefer: "return=representation",
    body: mediaPayload
  });
  const media = Array.isArray(mediaRows) ? mediaRows[0] : mediaRows;
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

  return { port: updated, media };
}

module.exports = {
  applyPortImageCandidate,
  canOverwritePortImage,
  downloadImage
};
