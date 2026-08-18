/**
 * Newsletter email-asset pipeline:
 * download master images from Supabase → optimise for email → upload to Mailchimp File Manager.
 *
 * Dedupes by source checksum within a newsletter so Airline Staff and General share one upload.
 * Re-export reuses the stored Mailchimp file when the source bytes have not changed.
 * Never falls back to Supabase URLs — callers must fail the export on error.
 */

const crypto = require("crypto");
const { getConfig, serviceHeaders } = require("../admin-auth");
const {
  findOrCreateNewsletterFolder,
  getFile,
  hostedFileUrl,
  uploadFile
} = require("./mailchimp-file-manager");
const { normalizeAssetType, optimizeEmailAsset } = require("./newsletter-email-optimize");

function assetError(message, { code = "newsletter_assets_failed", statusCode = 500 } = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function slugify(value) {
  return (
    String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "cruise"
  );
}

function padNewsletterNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1) return "000";
  return String(Math.trunc(num)).padStart(3, "0");
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

function isSupabaseStorageUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("supabase.co") && !host.includes("supabase.in")) return false;
    return /\/storage\/v1\/object\//i.test(parsed.pathname);
  } catch {
    return /supabase\.(co|in)\/storage\/v1\/object\//i.test(raw);
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

function buildGeneratedFilename({ newsletterNumber, label, assetType, checksum, extension }) {
  const type = normalizeAssetType(assetType);
  const typeSlug = type === "route_map" ? "route-map" : type === "hero" ? "hero" : "image";
  const short = String(checksum || "file").slice(0, 8);
  return `newsletter-${padNewsletterNumber(newsletterNumber)}-${slugify(label)}-${typeSlug}-${short}.${extension}`;
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
    if (response.status === 404 || /does not exist|could not find the table/i.test(String(detail))) {
      throw assetError(
        "Newsletter email asset mapping table is missing. Apply supabase/migrations/20260818_newsletter_email_assets.sql before exporting Mailchimp HTML.",
        { code: "mapping_table_missing", statusCode: 503 }
      );
    }
    throw assetError(`Could not save newsletter email asset mapping (${detail}).`, {
      code: "mapping_store_failed",
      statusCode: 500
    });
  }
  return data;
}

async function resolveNewsletter({ newsletterId, newsletterNumber }) {
  const id = String(newsletterId || "").trim();
  if (id) {
    const rows = await supabaseRest(
      `newsletters?id=eq.${encodeURIComponent(id)}&select=id,newsletter_number&limit=1`
    );
    if (Array.isArray(rows) && rows[0]?.id) return rows[0];
  }
  const number = Number(newsletterNumber);
  if (Number.isFinite(number) && number >= 1) {
    const rows = await supabaseRest(
      `newsletters?newsletter_number=eq.${encodeURIComponent(String(number))}&select=id,newsletter_number&limit=1`
    );
    if (Array.isArray(rows) && rows[0]?.id) return rows[0];
  }
  throw assetError(
    "Save the newsletter before generating Mailchimp HTML so images can be hosted in Mailchimp File Manager.",
    { code: "newsletter_not_saved", statusCode: 400 }
  );
}

async function downloadSourceBytes(sourceUrl) {
  const raw = String(sourceUrl || "").trim();
  if (!raw) {
    throw assetError("A newsletter image URL is missing.", { code: "source_missing", statusCode: 400 });
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
      throw assetError(
        `Could not download newsletter image from Supabase (${parsed.bucket}/${parsed.objectPath}): HTTP ${response.status}. Export stopped.`,
        { code: "source_download_failed", statusCode: 502 }
      );
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (!buf.length) {
      throw assetError(`Supabase image ${parsed.objectPath} was empty. Export stopped.`, {
        code: "source_empty",
        statusCode: 502
      });
    }
    return { buffer: buf, sourcePath: `${parsed.bucket}/${parsed.objectPath}` };
  }

  const response = await fetch(raw);
  if (!response.ok) {
    throw assetError(
      `Could not download newsletter image (${raw}): HTTP ${response.status}. Export stopped.`,
      { code: "source_download_failed", statusCode: 502 }
    );
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (!buf.length) {
    throw assetError("A newsletter image downloaded empty. Export stopped.", {
      code: "source_empty",
      statusCode: 502
    });
  }
  return { buffer: buf, sourcePath: null };
}

async function loadMappingByChecksum(newsletterId, checksum) {
  const rows = await supabaseRest(
    `newsletter_email_assets?newsletter_id=eq.${encodeURIComponent(newsletterId)}&source_checksum=eq.${encodeURIComponent(checksum)}&select=*&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function upsertMapping(row) {
  const saved = await supabaseRest(
    "newsletter_email_assets?on_conflict=newsletter_id,source_checksum",
    {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: row
    }
  );
  return Array.isArray(saved) ? saved[0] : saved;
}

async function mappingStillValid(row, deps) {
  if (!row?.mailchimp_file_id || !row?.mailchimp_file_url) return false;
  if (!/^https:\/\//i.test(String(row.mailchimp_file_url))) return false;
  const getFileFn = deps.getFile || getFile;
  const file = await getFileFn(row.mailchimp_file_id);
  if (!file) return false;
  const url = hostedFileUrl(file) || String(row.mailchimp_file_url);
  return Boolean(url);
}

/**
 * Process unique newsletter images. `assets` items: { source_url, asset_type, label }
 */
async function processNewsletterEmailAssets(input = {}, deps = {}) {
  const newsletter = await (deps.resolveNewsletter || resolveNewsletter)({
    newsletterId: input.newsletterId,
    newsletterNumber: input.newsletterNumber
  });
  const list = Array.isArray(input.assets) ? input.assets : [];
  if (!list.length) {
    return { newsletter, folder: null, mappings: [], reused: 0, uploaded: 0 };
  }

  const download = deps.downloadSourceBytes || downloadSourceBytes;
  const optimize = deps.optimizeEmailAsset || optimizeEmailAsset;
  const findFolder = deps.findOrCreateNewsletterFolder || findOrCreateNewsletterFolder;
  const upload = deps.uploadFile || uploadFile;

  const unique = [];
  const seen = new Set();
  for (const item of list) {
    const sourceUrl = String(item?.source_url || item?.url || "").trim();
    if (!sourceUrl) continue;
    const key = normalizeSourceUrl(sourceUrl) || sourceUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      source_url: sourceUrl,
      source_url_normalized: key,
      asset_type: normalizeAssetType(item.asset_type || item.type),
      label: String(item.label || item.name || "cruise").trim() || "cruise"
    });
  }

  const folder = await findFolder();
  const byChecksum = new Map();
  const mappings = [];
  let reused = 0;
  let uploaded = 0;

  for (const asset of unique) {
    const { buffer, sourcePath } = await download(asset.source_url);
    const sourceChecksum = checksumBuffer(buffer);

    if (byChecksum.has(sourceChecksum)) {
      const prior = byChecksum.get(sourceChecksum);
      mappings.push({
        source_url: asset.source_url,
        source_url_normalized: asset.source_url_normalized,
        mailchimp_file_url: prior.mailchimp_file_url,
        mailchimp_file_id: prior.mailchimp_file_id,
        generated_filename: prior.generated_filename,
        reused: true,
        uploaded: false
      });
      continue;
    }

    const existing = await (deps.loadMappingByChecksum || loadMappingByChecksum)(
      newsletter.id,
      sourceChecksum
    );
    if (existing && (await mappingStillValid(existing, deps))) {
      const mapped = {
        source_url: asset.source_url,
        source_url_normalized: asset.source_url_normalized,
        mailchimp_file_url: existing.mailchimp_file_url,
        mailchimp_file_id: String(existing.mailchimp_file_id),
        generated_filename: existing.generated_filename,
        reused: true,
        uploaded: false
      };
      byChecksum.set(sourceChecksum, mapped);
      mappings.push(mapped);
      reused += 1;
      continue;
    }

    let optimised;
    try {
      optimised = await optimize(buffer, asset.asset_type);
    } catch (error) {
      throw assetError(
        `Could not optimise ${asset.label} (${asset.asset_type}) for email: ${error.message || "optimisation failed"}. Export stopped.`,
        { code: error.code || "optimize_failed", statusCode: error.statusCode || 500 }
      );
    }

    const generatedFilename = buildGeneratedFilename({
      newsletterNumber: newsletter.newsletter_number,
      label: asset.label,
      assetType: asset.asset_type,
      checksum: sourceChecksum,
      extension: optimised.extension
    });

    let uploadedFile;
    try {
      uploadedFile = await upload({
        name: generatedFilename,
        buffer: optimised.buffer,
        folderId: folder.id,
        mimeType: optimised.mimeType
      });
    } catch (error) {
      const wrapped = assetError(
        `Mailchimp upload failed for ${generatedFilename}: ${error.message || "upload failed"}. Export stopped so the newsletter would not keep using Supabase image links.`,
        { code: error.code || "mailchimp_upload_failed", statusCode: error.statusCode || 502 }
      );
      wrapped.generatedFilename = generatedFilename;
      wrapped.httpStatus = error.httpStatus || error.statusCode || null;
      throw wrapped;
    }

    const row = {
      newsletter_id: newsletter.id,
      variant_scope: "shared",
      asset_type: asset.asset_type,
      source_url: asset.source_url,
      source_url_normalized: asset.source_url_normalized,
      source_path: sourcePath,
      source_checksum: sourceChecksum,
      mailchimp_file_id: uploadedFile.id,
      mailchimp_file_url: uploadedFile.url,
      mailchimp_folder_id: String(uploadedFile.folderId || folder.id),
      generated_filename: generatedFilename
    };
    await (deps.upsertMapping || upsertMapping)(row);

    const mapped = {
      source_url: asset.source_url,
      source_url_normalized: asset.source_url_normalized,
      mailchimp_file_url: uploadedFile.url,
      mailchimp_file_id: uploadedFile.id,
      generated_filename: generatedFilename,
      reused: false,
      uploaded: true
    };
    byChecksum.set(sourceChecksum, mapped);
    mappings.push(mapped);
    uploaded += 1;
  }

  return { newsletter, folder, mappings, reused, uploaded };
}

module.exports = {
  slugify,
  padNewsletterNumber,
  normalizeSourceUrl,
  isSupabaseStorageUrl,
  parseSupabaseStorageUrl,
  checksumBuffer,
  buildGeneratedFilename,
  resolveNewsletter,
  downloadSourceBytes,
  processNewsletterEmailAssets
};
