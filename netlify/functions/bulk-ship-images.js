/**
 * Bulk Ship Images API (Sprint 16D).
 *
 * POST /.netlify/functions/bulk-ship-images
 * Actions:
 *   list_lines | create_zip_upload | dry_run | import | apply_hero_suggestion
 *
 * ZIP staged in private media-imports bucket; images land in cruise-media
 * under ships/{ship_id}/{hash12}-{safeFilename}. Never auto-writes hero_image_url.
 */

const crypto = require("crypto");
const { requireAdmin } = require("./admin-auth");
const { loadZip, listZipPaths, readZipEntry, estimateUncompressed } = require("./lib/bulk-ship-images/zip");
const {
  LIMITS,
  sha256Hex,
  mimeFromExt,
  buildContentAddressedPath,
  safeFilename
} = require("./lib/bulk-ship-images/matching");
const {
  buildSingleLinePlan,
  buildFullLibraryPlan,
  enrichPlanWithBytes
} = require("./lib/bulk-ship-images/plan");
const { readImageDimensions } = require("./lib/bulk-ship-images/image-dims");
const path = require("path");

const MEDIA_BUCKET = "cruise-media";
const IMPORT_BUCKET = "media-imports";
const IMPORT_SOURCE = "bulk_ship_zip_single_line";

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

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server access is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

async function supabase(path, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null && !(options.body instanceof Buffer)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const response = await fetch(`${url}${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const msg = data?.message || data?.error || data?.msg || `HTTP ${response.status}`;
    const err = new Error(msg);
    err.statusCode = response.status;
    err.body = data;
    throw err;
  }
  return data;
}

function publicMediaUrl(storagePath) {
  const { url } = config();
  return `${url}/storage/v1/object/public/${MEDIA_BUCKET}/${storagePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

async function downloadStorageObject(bucket, storagePath) {
  const { url, key } = config();
  const response = await fetch(
    `${url}/storage/v1/object/${bucket}/${storagePath.split("/").map(encodeURIComponent).join("/")}`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`
      }
    }
  );
  if (!response.ok) {
    throw Object.assign(new Error(`Failed to download ${bucket}/${storagePath}`), {
      statusCode: response.status
    });
  }
  const ab = await response.arrayBuffer();
  return Buffer.from(ab);
}

async function uploadMediaObject(storagePath, buffer, contentType) {
  const { url, key } = config();
  const response = await fetch(
    `${url}/storage/v1/object/${MEDIA_BUCKET}/${storagePath.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": contentType || "application/octet-stream",
        "x-upsert": "true"
      },
      body: buffer
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage upload failed: ${text || response.status}`);
  }
}

function readImageSize(buffer) {
  return readImageDimensions(buffer);
}

async function listLines() {
  const rows = await supabase(
    "/rest/v1/ci_cruise_lines?select=id,name,slug,active&order=name.asc"
  );
  return { success: true, cruise_lines: rows || [] };
}

async function createZipUpload(body, user) {
  const filename = safeFilename(body.filename || "ships.zip");
  if (!filename.toLowerCase().endsWith(".zip")) {
    throw Object.assign(new Error("Only .zip files are accepted"), { statusCode: 400 });
  }
  const sizeBytes = Number(body.size_bytes || 0);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw Object.assign(new Error("size_bytes is required"), { statusCode: 400 });
  }
  if (sizeBytes > LIMITS.maxZipBytes) {
    throw Object.assign(
      new Error(`ZIP too large. Maximum is ${Math.round(LIMITS.maxZipBytes / (1024 * 1024))} MB`),
      { statusCode: 400 }
    );
  }
  const stamp = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");
  const storagePath = `bulk-ship/${user.id}/${stamp}-${rand}-${filename}`;
  const signed = await supabase(
    `/storage/v1/object/upload/sign/${IMPORT_BUCKET}/${storagePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    { method: "POST", body: JSON.stringify({}) }
  );
  const token = signed?.token || signed?.signedToken;
  if (!token) throw new Error("Storage did not return an upload token");
  return {
    success: true,
    bucket: IMPORT_BUCKET,
    storage_path: storagePath,
    token
  };
}

async function loadLineContext(cruiseLineId) {
  const lines = await supabase(
    `/rest/v1/ci_cruise_lines?id=eq.${encodeURIComponent(cruiseLineId)}&select=id,name,slug,active&limit=1`
  );
  const line = lines?.[0];
  if (!line) throw Object.assign(new Error("Cruise line not found"), { statusCode: 404 });
  const ships = await supabase(
    `/rest/v1/ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&select=id,name,slug,cruise_line_id,hero_image_url,active&order=name.asc`
  );
  const aliases = await supabase(
    `/rest/v1/cruise_ship_aliases?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&active=eq.true&select=id,ship_id,raw_alias,normalised_alias`
  ).catch(() => []);
  return { line, ships: ships || [], aliases: aliases || [] };
}

async function loadExistingHashes(shipIds) {
  const map = new Map();
  if (!shipIds.length) return map;
  // PostgREST in() — batch
  const chunk = shipIds.slice(0, 80);
  const rows = await supabase(
    `/rest/v1/media_library?ship_id=in.(${chunk.join(",")})&content_hash=not.is.null&select=ship_id,content_hash,storage_path,id`
  ).catch(() => []);
  for (const row of rows || []) {
    if (!map.has(row.ship_id)) map.set(row.ship_id, new Set());
    map.get(row.ship_id).add(row.content_hash);
  }
  return map;
}

async function openStagedZip(zipPath) {
  if (!String(zipPath || "").startsWith("bulk-ship/")) {
    throw Object.assign(new Error("Invalid ZIP storage path"), { statusCode: 400 });
  }
  const buffer = await downloadStorageObject(IMPORT_BUCKET, zipPath);
  const zip = await loadZip(buffer);
  await estimateUncompressed(zip);
  return zip;
}

async function dryRun(body) {
  const mode = body.mode === "full_library" ? "full_library" : "single_line";
  const zipPath = String(body.zip_storage_path || "").trim();
  if (!zipPath) throw Object.assign(new Error("zip_storage_path is required"), { statusCode: 400 });

  const zip = await openStagedZip(zipPath);
  const entryPaths = listZipPaths(zip);

  if (mode === "full_library") {
    const lines = await supabase(
      "/rest/v1/ci_cruise_lines?select=id,name,slug,active&order=name.asc"
    );
    const allShips = await supabase(
      "/rest/v1/ci_cruise_ships?select=id,name,slug,cruise_line_id,hero_image_url,active&order=name.asc"
    );
    const shipsByLineId = new Map();
    for (const s of allShips || []) {
      if (!shipsByLineId.has(s.cruise_line_id)) shipsByLineId.set(s.cruise_line_id, []);
      shipsByLineId.get(s.cruise_line_id).push(s);
    }
    const report = buildFullLibraryPlan({
      entryPaths,
      lines: lines || [],
      shipsByLineId,
      aliasesByLineId: new Map()
    });
    report.zip_storage_path = zipPath;
    report.note =
      "Full-library dry-run is architecture-ready. Prefer single_line imports for production use.";
    return { success: true, dry_run: true, report };
  }

  const cruiseLineId = String(body.cruise_line_id || "").trim();
  if (!cruiseLineId) {
    throw Object.assign(new Error("cruise_line_id is required for single_line mode"), {
      statusCode: 400
    });
  }
  const { line, ships, aliases } = await loadLineContext(cruiseLineId);
  const existingHashes = await loadExistingHashes(ships.map((s) => s.id));

  // Path-only plan first
  let report = buildSingleLinePlan({
    entryPaths,
    cruiseLine: line,
    ships,
    aliases,
    existingHashesByShip: existingHashes
  });

  // Enrich matched proposed uploads with hashes (read bytes) — still no writes
  const fileRecords = [];
  for (const item of report.proposed_uploads) {
    if (!item.ship_id) continue;
    const buffer = await readZipEntry(zip, item.zip_path);
    if (buffer.length > LIMITS.maxImageBytes) {
      report.unsupported_files.push({
        path: item.zip_path,
        reason: "image_too_large",
        size_bytes: buffer.length
      });
      continue;
    }
    const dims = readImageSize(buffer);
    fileRecords.push({
      ...item,
      buffer,
      content_hash: sha256Hex(buffer),
      width: dims.width,
      height: dims.height,
      mime_type: item.mime_type || mimeFromExt(path.posix.extname(item.filename))
    });
  }

  report = enrichPlanWithBytes(report, fileRecords, existingHashes);
  report.zip_storage_path = zipPath;
  report.matched_folder_count = report.matched_ships.length;
  report.unmatched_folder_count = report.unmatched_ship_folders.length;

  // Confirm token binds cruise line + zip path for import
  const confirmToken = crypto
    .createHmac("sha256", config().key)
    .update(`${zipPath}|${cruiseLineId}|single_line`)
    .digest("hex")
    .slice(0, 32);
  report.confirm_token = confirmToken;

  return { success: true, dry_run: true, report };
}

async function runImport(body, user) {
  const zipPath = String(body.zip_storage_path || "").trim();
  const cruiseLineId = String(body.cruise_line_id || "").trim();
  const confirmToken = String(body.confirm_token || "").trim();
  if (!zipPath || !cruiseLineId || !confirmToken) {
    throw Object.assign(new Error("zip_storage_path, cruise_line_id and confirm_token are required"), {
      statusCode: 400
    });
  }
  const expected = crypto
    .createHmac("sha256", config().key)
    .update(`${zipPath}|${cruiseLineId}|single_line`)
    .digest("hex")
    .slice(0, 32);
  if (confirmToken !== expected) {
    throw Object.assign(new Error("Invalid confirm_token — run dry_run again"), { statusCode: 400 });
  }

  const dry = await dryRun({
    zip_storage_path: zipPath,
    cruise_line_id: cruiseLineId,
    mode: "single_line"
  });
  const report = dry.report;
  const zip = await openStagedZip(zipPath);

  const result = {
    cruise_line: report.cruise_line,
    ship_folders_processed: report.ship_folders.length,
    ships_matched: report.matched_ships.length,
    images_uploaded: 0,
    duplicates_skipped: 0,
    unsupported_files: report.unsupported_files,
    failed_uploads: [],
    unmatched_folders: report.unmatched_ship_folders,
    images_linked: 0,
    hero_suggestions: [],
    total_uploaded_bytes: 0,
    media_ids: []
  };

  for (const item of report.duplicate_candidates || []) {
    result.duplicates_skipped += 1;
  }

  for (const item of report.proposed_uploads || []) {
    try {
      const buffer = await readZipEntry(zip, item.zip_path);
      const hash = item.content_hash || sha256Hex(buffer);
      const storagePath = item.storage_path || buildContentAddressedPath(item.ship_id, hash, item.filename);
      const mime = item.mime_type || "image/jpeg";
      const dims = item.width ? { width: item.width, height: item.height } : readImageSize(buffer);

      // Idempotent storage upsert by content-addressed path
      await uploadMediaObject(storagePath, buffer, mime);

      const tags = ["bulk_import"];
      if (item.is_hero_candidate) tags.push("suggested_hero");

      const payload = {
        title: `${item.ship_name} — ${item.filename}`,
        alt_text: `${item.ship_name} photo`,
        media_type: "ship",
        storage_bucket: MEDIA_BUCKET,
        storage_path: storagePath,
        public_url: publicMediaUrl(storagePath),
        file_name: safeFilename(item.filename),
        original_filename: item.filename,
        mime_type: mime,
        width: dims.width,
        height: dims.height,
        file_size_bytes: buffer.length,
        cruise_line_id: item.cruise_line_id,
        ship_id: item.ship_id,
        tags,
        is_default: false,
        is_active: true,
        content_hash: hash,
        import_source: IMPORT_SOURCE,
        created_by: user.id || null
      };

      let row;
      try {
        const rows = await supabase("/rest/v1/media_library", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(payload)
        });
        row = Array.isArray(rows) ? rows[0] : rows;
      } catch (error) {
        // Unique (ship_id, content_hash) or (bucket, path) → treat as duplicate
        if (/duplicate|unique|23505/i.test(error.message || "")) {
          result.duplicates_skipped += 1;
          continue;
        }
        throw error;
      }

      result.images_uploaded += 1;
      result.images_linked += 1;
      result.total_uploaded_bytes += buffer.length;
      if (row?.id) result.media_ids.push(row.id);
      if (item.is_hero_candidate) {
        result.hero_suggestions.push({
          media_id: row?.id || null,
          ship_id: item.ship_id,
          ship_name: item.ship_name,
          public_url: payload.public_url,
          filename: item.filename,
          note: "Suggested only — hero_image_url not changed"
        });
      }
    } catch (error) {
      result.failed_uploads.push({
        path: item.zip_path,
        error: error.message || String(error)
      });
    }
  }

  return { success: true, dry_run: false, result };
}

async function applyHeroSuggestion(body, user) {
  const mediaId = String(body.media_id || "").trim();
  const shipId = String(body.ship_id || "").trim();
  if (!mediaId || !shipId) {
    throw Object.assign(new Error("media_id and ship_id are required"), { statusCode: 400 });
  }
  const mediaRows = await supabase(
    `/rest/v1/media_library?id=eq.${encodeURIComponent(mediaId)}&select=*&limit=1`
  );
  const media = mediaRows?.[0];
  if (!media || media.ship_id !== shipId) {
    throw Object.assign(new Error("Media not found for ship"), { statusCode: 404 });
  }
  // Explicit approval only — updates CI hero URL; does not clear other media.
  await supabase(`/rest/v1/ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      hero_image_url: media.public_url,
      last_verified_at: new Date().toISOString()
    })
  });
  await supabase(`/rest/v1/media_library?id=eq.${encodeURIComponent(mediaId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ is_default: true })
  });
  // clear other defaults for ship
  await supabase(
    `/rest/v1/media_library?ship_id=eq.${encodeURIComponent(shipId)}&media_type=eq.ship&is_default=eq.true&id=neq.${encodeURIComponent(mediaId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ is_default: false })
    }
  );
  return {
    success: true,
    message: "Hero image approved and applied to ci_cruise_ships.hero_image_url",
    applied_by: user.id
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }
  try {
    const user = await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").trim();

    if (action === "list_lines") return jsonResponse(200, await listLines());
    if (action === "create_zip_upload") return jsonResponse(200, await createZipUpload(body, user));
    if (action === "dry_run") return jsonResponse(200, await dryRun(body));
    if (action === "import") return jsonResponse(200, await runImport(body, user));
    if (action === "apply_hero_suggestion") {
      return jsonResponse(200, await applyHeroSuggestion(body, user));
    }

    return jsonResponse(400, { success: false, error: `Unknown action: ${action}` });
  } catch (error) {
    const status = error.statusCode || 500;
    return jsonResponse(status, {
      success: false,
      error: error.message || "Bulk ship image import failed",
      code: error.code || null
    });
  }
};
