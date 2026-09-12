/**
 * Admin-only Ship Spotlight email-asset pipeline.
 * Independent from newsletter records, but uses the same Mailchimp File Manager
 * and email image optimiser as newsletter export.
 */
const crypto = require("crypto");
const { requireAdmin, getConfig, serviceHeaders } = require("./admin-auth");
const {
  findOrCreateNewsletterFolder,
  getFile,
  hostedFileUrl,
  uploadFile
} = require("./lib/mailchimp-file-manager");
const { normalizeAssetType, optimizeEmailAsset } = require("./lib/newsletter-email-optimize");

const MAX_ASSETS_PER_INVOCATION = 1;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function appError(message, code = "ship_spotlight_assets_failed", statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function slugify(value) {
  return (
    String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "ship"
  );
}

function normalizeSourceUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return raw.split("#")[0].split("?")[0];
  }
}

function parseSupabaseStorageUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    const match = parsed.pathname.match(
      /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)/i
    );
    if (!match) return null;
    return {
      bucket: decodeURIComponent(match[1]),
      objectPath: decodeURIComponent(match[2])
    };
  } catch {
    return null;
  }
}

function checksumBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function supabaseRest(pathname, options = {}) {
  const { supabaseUrl } = getConfig();
  const headers = {
    ...serviceHeaders(),
    Prefer: options.prefer || "return=representation",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const detail = data?.message || data?.error || data?.hint || `HTTP ${response.status}`;
    throw appError(`Ship Spotlight email asset request failed (${detail}).`, "mapping_store_failed", 500);
  }
  return data;
}

async function resolveSpotlight(spotlightId) {
  const id = String(spotlightId || "").trim();
  if (!id) {
    throw appError("Save the Ship Spotlight before copying Mailchimp HTML.", "spotlight_not_saved", 400);
  }
  const rows = await supabaseRest(
    `ship_spotlights?id=eq.${encodeURIComponent(id)}&select=id,public_slug,ship_id&limit=1`
  );
  if (!Array.isArray(rows) || !rows[0]?.id) {
    throw appError("The Ship Spotlight could not be found. Save it again before exporting.", "spotlight_not_found", 404);
  }
  return rows[0];
}

async function downloadSourceBytes(sourceUrl) {
  const raw = String(sourceUrl || "").trim();
  if (!/^https:\/\//i.test(raw)) {
    throw appError("Every Ship Spotlight image must use an absolute https address.", "source_invalid", 400);
  }

  const parsed = parseSupabaseStorageUrl(raw);
  if (parsed) {
    const { supabaseUrl } = getConfig();
    const encoded = parsed.objectPath
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const response = await fetch(`${supabaseUrl}/storage/v1/object/${parsed.bucket}/${encoded}`, {
      headers: serviceHeaders()
    });
    if (!response.ok) {
      throw appError(
        `Could not download Ship Spotlight image from Supabase: HTTP ${response.status}.`,
        "source_download_failed",
        502
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw appError("The Ship Spotlight image was empty.", "source_empty", 502);
    return { buffer, sourcePath: `${parsed.bucket}/${parsed.objectPath}` };
  }

  const response = await fetch(raw);
  if (!response.ok) {
    throw appError(`Could not download Ship Spotlight image: HTTP ${response.status}.`, "source_download_failed", 502);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw appError("The Ship Spotlight image was empty.", "source_empty", 502);
  return { buffer, sourcePath: null };
}

async function mappingByChecksum(spotlightId, checksum) {
  const rows = await supabaseRest(
    `ship_spotlight_email_assets?spotlight_id=eq.${encodeURIComponent(
      spotlightId
    )}&source_checksum=eq.${encodeURIComponent(checksum)}&select=*&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function mappingStillValid(row) {
  if (!row?.mailchimp_file_id || !row?.mailchimp_file_url) return false;
  try {
    const file = await getFile(row.mailchimp_file_id);
    return Boolean(file && (hostedFileUrl(file) || row.mailchimp_file_url));
  } catch {
    return false;
  }
}

async function upsertMapping(row) {
  const saved = await supabaseRest(
    "ship_spotlight_email_assets?on_conflict=spotlight_id,source_checksum",
    {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: row
    }
  );
  return Array.isArray(saved) ? saved[0] : saved;
}

async function processOne({ spotlight, asset }) {
  const sourceUrl = String(asset?.source_url || "").trim();
  if (!sourceUrl) throw appError("Ship Spotlight image URL is missing.", "source_missing", 400);
  const sourceUrlNormalized = normalizeSourceUrl(sourceUrl);
  const { buffer, sourcePath } = await downloadSourceBytes(sourceUrl);
  const checksum = checksumBuffer(buffer);

  const existing = await mappingByChecksum(spotlight.id, checksum);
  if (existing && (await mappingStillValid(existing))) {
    return {
      mapping: {
        source_url: sourceUrl,
        source_url_normalized: sourceUrlNormalized,
        mailchimp_file_url: existing.mailchimp_file_url,
        mailchimp_file_id: String(existing.mailchimp_file_id),
        generated_filename: existing.generated_filename,
        reused: true,
        uploaded: false
      },
      reused: 1,
      uploaded: 0
    };
  }

  const assetType = normalizeAssetType(asset?.asset_type || "hero");
  let optimised;
  try {
    optimised = await optimizeEmailAsset(buffer, assetType);
  } catch (error) {
    throw appError(
      `Could not optimise Ship Spotlight image for email: ${error.message || "optimisation failed"}.`,
      error.code || "optimize_failed",
      error.statusCode || 500
    );
  }

  const folder = await findOrCreateNewsletterFolder();
  const generatedFilename = `ship-spotlight-${slugify(
    spotlight.public_slug
  )}-${assetType === "hero" ? "hero" : "image"}-${checksum.slice(0, 8)}.${optimised.extension}`;

  let uploadedFile;
  try {
    uploadedFile = await uploadFile({
      name: generatedFilename,
      buffer: optimised.buffer,
      folderId: folder.id,
      mimeType: optimised.mimeType
    });
  } catch (error) {
    throw appError(
      `Mailchimp upload failed for ${generatedFilename}: ${error.message || "upload failed"}.`,
      error.code || "mailchimp_upload_failed",
      error.statusCode || 502
    );
  }

  const row = {
    spotlight_id: spotlight.id,
    asset_type: assetType,
    source_url: sourceUrl,
    source_url_normalized: sourceUrlNormalized,
    source_path: sourcePath,
    source_checksum: checksum,
    mailchimp_file_id: String(uploadedFile.id),
    mailchimp_file_url: uploadedFile.url,
    mailchimp_folder_id: String(uploadedFile.folderId || folder.id),
    generated_filename: generatedFilename,
    updated_at: new Date().toISOString()
  };
  await upsertMapping(row);

  return {
    mapping: {
      source_url: sourceUrl,
      source_url_normalized: sourceUrlNormalized,
      mailchimp_file_url: uploadedFile.url,
      mailchimp_file_id: String(uploadedFile.id),
      generated_filename: generatedFilename,
      reused: false,
      uploaded: true
    },
    reused: 0,
    uploaded: 1
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const assets = Array.isArray(body.assets) ? body.assets.filter(Boolean) : [];
    if (!assets.length) {
      return jsonResponse(400, { success: false, error: "One Ship Spotlight image is required." });
    }
    if (assets.length > MAX_ASSETS_PER_INVOCATION) {
      return jsonResponse(400, {
        success: false,
        error: `Send one Ship Spotlight image per request (received ${assets.length}).`
      });
    }

    const spotlight = await resolveSpotlight(body.spotlight_id || body.spotlightId);
    const result = await processOne({ spotlight, asset: assets[0] });

    return jsonResponse(200, {
      success: true,
      spotlight_id: spotlight.id,
      mappings: [result.mapping],
      reused: result.reused,
      uploaded: result.uploaded
    });
  } catch (error) {
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || "Ship Spotlight image upload failed.",
      code: error.code || "ship_spotlight_assets_failed"
    });
  }
};

exports.MAX_ASSETS_PER_INVOCATION = MAX_ASSETS_PER_INVOCATION;
