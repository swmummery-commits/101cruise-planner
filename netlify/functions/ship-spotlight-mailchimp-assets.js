/**
 * Admin-only Ship Spotlight email-asset pipeline.
 *
 * POST /.netlify/functions/ship-spotlight-mailchimp-assets
 * Body: {
 *   spotlight_id,
 *   asset_index?, asset_total?,
 *   assets: [{ source_url, asset_type: 'hero'|'other', label }]
 * }
 *
 * One image per invocation, using the same optimiser and Mailchimp File Manager
 * folder as newsletter imagery. Mappings are stored independently against the
 * Ship Spotlight so the cruise-specials newsletter export remains untouched.
 */

const { requireAdmin, getConfig, serviceHeaders } = require("./admin-auth");
const {
  findOrCreateNewsletterFolder,
  getFile,
  hostedFileUrl,
  uploadFile
} = require("./lib/mailchimp-file-manager");
const { normalizeAssetType, optimizeEmailAsset } = require("./lib/newsletter-email-optimize");
const {
  normalizeSourceUrl,
  checksumBuffer,
  downloadSourceBytes
} = require("./lib/newsletter-email-assets");

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

function spotlightError(message, { code = "ship_spotlight_assets_failed", statusCode = 500 } = {}) {
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

async function supabaseRest(pathname, options = {}) {
  const { supabaseUrl } = getConfig();
  const headers = {
    ...serviceHeaders(),
    Prefer: options.prefer || "return=representation",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) headers["Content-Type"] = "application/json";
  const response = await fetch(`${supabaseUrl}/rest/v1/${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = data?.message || data?.error || data?.hint || `HTTP ${response.status}`;
    throw spotlightError(`Ship Spotlight image service failed (${detail}).`, {
      code: "spotlight_store_failed",
      statusCode: response.status >= 400 && response.status < 600 ? response.status : 500
    });
  }
  return data;
}

async function resolveSpotlight(id) {
  const spotlightId = String(id || "").trim();
  if (!spotlightId) {
    throw spotlightError("Save the Ship Spotlight before copying its newsletter block.", {
      code: "spotlight_not_saved",
      statusCode: 400
    });
  }
  const rows = await supabaseRest(
    `ship_spotlights?id=eq.${encodeURIComponent(spotlightId)}&select=id,ship_id,public_slug,newsletter_heading&limit=1`
  );
  const spotlight = Array.isArray(rows) ? rows[0] : null;
  if (!spotlight?.id) {
    throw spotlightError("The saved Ship Spotlight could not be found.", {
      code: "spotlight_not_found",
      statusCode: 404
    });
  }
  return spotlight;
}

async function loadMappingByChecksum(spotlightId, checksum) {
  const rows = await supabaseRest(
    `ship_spotlight_email_assets?spotlight_id=eq.${encodeURIComponent(spotlightId)}&source_checksum=eq.${encodeURIComponent(checksum)}&select=*&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function mappingStillValid(row) {
  if (!row?.mailchimp_file_id || !row?.mailchimp_file_url) return false;
  if (!/^https:\/\//i.test(String(row.mailchimp_file_url))) return false;
  const file = await getFile(row.mailchimp_file_id);
  if (!file) return false;
  return Boolean(hostedFileUrl(file) || row.mailchimp_file_url);
}

async function saveMapping(row) {
  const existingRows = await supabaseRest(
    `ship_spotlight_email_assets?spotlight_id=eq.${encodeURIComponent(row.spotlight_id)}&source_checksum=eq.${encodeURIComponent(row.source_checksum)}&select=id&limit=1`
  );
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  if (existing?.id) {
    const rows = await supabaseRest(
      `ship_spotlight_email_assets?id=eq.${encodeURIComponent(existing.id)}`,
      { method: "PATCH", body: row }
    );
    return Array.isArray(rows) ? rows[0] : rows;
  }
  const rows = await supabaseRest("ship_spotlight_email_assets", { method: "POST", body: row });
  return Array.isArray(rows) ? rows[0] : rows;
}

function buildFilename({ spotlight, assetType, checksum, extension }) {
  const type = normalizeAssetType(assetType) === "hero" ? "hero" : "image";
  const label = slugify(spotlight.public_slug || spotlight.newsletter_heading || "ship");
  return `ship-spotlight-${label}-${type}-${String(checksum).slice(0, 8)}.${extension}`;
}

async function processAsset({ spotlight, asset }) {
  const sourceUrl = String(asset?.source_url || asset?.url || "").trim();
  if (!sourceUrl || !/^https:\/\//i.test(sourceUrl)) {
    throw spotlightError("Every Ship Spotlight image must have an absolute https address.", {
      code: "invalid_source_url",
      statusCode: 400
    });
  }

  const { buffer, sourcePath } = await downloadSourceBytes(sourceUrl);
  const checksum = checksumBuffer(buffer);
  const existing = await loadMappingByChecksum(spotlight.id, checksum);
  if (existing && await mappingStillValid(existing)) {
    return {
      source_url: sourceUrl,
      source_url_normalized: normalizeSourceUrl(sourceUrl),
      mailchimp_file_url: existing.mailchimp_file_url,
      mailchimp_file_id: String(existing.mailchimp_file_id),
      generated_filename: existing.generated_filename,
      reused: true,
      uploaded: false
    };
  }

  const assetType = normalizeAssetType(asset.asset_type || asset.type || "other");
  let optimised;
  try {
    optimised = await optimizeEmailAsset(buffer, assetType);
  } catch (error) {
    throw spotlightError(`Could not optimise the Ship Spotlight image for email: ${error.message || "optimisation failed"}.`, {
      code: error.code || "optimize_failed",
      statusCode: error.statusCode || 500
    });
  }

  const folder = await findOrCreateNewsletterFolder();
  const generatedFilename = buildFilename({
    spotlight,
    assetType,
    checksum,
    extension: optimised.extension
  });

  let uploadedFile;
  try {
    uploadedFile = await uploadFile({
      name: generatedFilename,
      buffer: optimised.buffer,
      folderId: folder.id,
      mimeType: optimised.mimeType
    });
  } catch (error) {
    const wrapped = spotlightError(
      `Mailchimp upload failed for ${generatedFilename}: ${error.message || "upload failed"}.`,
      { code: error.code || "mailchimp_upload_failed", statusCode: error.statusCode || 502 }
    );
    wrapped.generatedFilename = generatedFilename;
    throw wrapped;
  }

  const mailchimpUrl = hostedFileUrl(uploadedFile) || uploadedFile.url;
  if (!mailchimpUrl) {
    throw spotlightError("Mailchimp did not return a hosted URL for the Ship Spotlight image.", {
      code: "mailchimp_url_missing",
      statusCode: 502
    });
  }

  await saveMapping({
    spotlight_id: spotlight.id,
    asset_type: assetType === "hero" ? "hero" : "other",
    source_url: sourceUrl,
    source_url_normalized: normalizeSourceUrl(sourceUrl),
    source_path: sourcePath,
    source_checksum: checksum,
    mailchimp_file_id: String(uploadedFile.id),
    mailchimp_file_url: mailchimpUrl,
    mailchimp_folder_id: String(uploadedFile.folderId || folder.id),
    generated_filename: generatedFilename,
    updated_at: new Date().toISOString()
  });

  return {
    source_url: sourceUrl,
    source_url_normalized: normalizeSourceUrl(sourceUrl),
    mailchimp_file_url: mailchimpUrl,
    mailchimp_file_id: String(uploadedFile.id),
    generated_filename: generatedFilename,
    reused: false,
    uploaded: true
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "POST") return jsonResponse(405, { success: false, error: "Method not allowed" });

  try {
    await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const assets = Array.isArray(body.assets) ? body.assets : [];
    const index = Number(body.asset_index) || 1;
    const total = Number(body.asset_total) || assets.length || 1;
    if (assets.length !== 1 || assets.length > MAX_ASSETS_PER_INVOCATION) {
      return jsonResponse(400, {
        success: false,
        error: "Send exactly one Ship Spotlight image per request.",
        asset_index: index,
        asset_total: total
      });
    }

    const spotlight = await resolveSpotlight(body.spotlight_id || body.spotlightId);
    const mapping = await processAsset({ spotlight, asset: assets[0] });
    return jsonResponse(200, {
      success: true,
      spotlight_id: spotlight.id,
      asset_index: index,
      asset_total: total,
      reused: mapping.reused ? 1 : 0,
      uploaded: mapping.uploaded ? 1 : 0,
      mappings: [mapping]
    });
  } catch (error) {
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || "Ship Spotlight image preparation failed.",
      code: error.code || "ship_spotlight_assets_failed",
      generated_filename: error.generatedFilename || null
    });
  }
};

exports.MAX_ASSETS_PER_INVOCATION = MAX_ASSETS_PER_INVOCATION;
