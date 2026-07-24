/**
 * Candidate collection + dry-run / copy / promote planning (no I/O).
 */

import { createRequire } from "node:module";
import { classifyHost, isSquarespaceHost } from "./url-safety.js";
import {
  IMPORT_SOURCE,
  LIMITS,
  MEDIA_BUCKET,
  assertAllowedMime,
  buildLineStoragePath,
  buildShipStoragePath,
  extForMime,
  filenameFromUrl,
  publicMediaUrl,
  safeFilename,
  sha256Hex,
  sniffMime
} from "./media-utils.js";

const require = createRequire(import.meta.url);
const { readImageDimensions } = require("../../../netlify/functions/lib/bulk-ship-images/image-dims.js");

/**
 * @typedef {object} Scope
 * @property {string|null} [lineId]
 * @property {string|null} [shipId]
 * @property {string[]} [entityIds]
 * @property {boolean} [logosOnly]
 * @property {boolean} [shipsOnly]
 * @property {boolean} [squarespaceOnly]
 */

/**
 * Collect CI URL candidates for migration.
 */
export function collectCandidates(lines, ships, scope = {}) {
  const logosOnly = Boolean(scope.logosOnly);
  const shipsOnly = Boolean(scope.shipsOnly);
  const squarespaceOnly = scope.squarespaceOnly !== false;
  const entityIdSet = scope.entityIds?.length ? new Set(scope.entityIds.map(String)) : null;
  const lineId = scope.lineId ? String(scope.lineId) : null;
  const shipId = scope.shipId ? String(scope.shipId) : null;

  /** @type {Array<object>} */
  const out = [];

  if (!shipsOnly) {
    for (const line of lines || []) {
      if (lineId && String(line.id) !== lineId) continue;
      if (entityIdSet && !entityIdSet.has(String(line.id))) continue;
      const url = line.logo_url;
      if (!url || !String(url).trim()) continue;
      if (squarespaceOnly && !isSquarespaceHost(url)) continue;
      out.push({
        entity_type: "cruise_line",
        entity_id: line.id,
        entity_name: line.name,
        cruise_line_id: line.id,
        ship_id: null,
        field: "logo_url",
        original_url: String(url).trim(),
        host_class: classifyHost(url),
        is_selected_canonical: true,
        media_type: "cruise_line"
      });
    }
  }

  if (!logosOnly) {
    for (const ship of ships || []) {
      if (shipId && String(ship.id) !== shipId) continue;
      if (lineId && String(ship.cruise_line_id) !== lineId) continue;
      if (entityIdSet && !entityIdSet.has(String(ship.id))) continue;
      const url = ship.hero_image_url;
      if (!url || !String(url).trim()) continue;
      if (squarespaceOnly && !isSquarespaceHost(url)) continue;
      out.push({
        entity_type: "ship",
        entity_id: ship.id,
        entity_name: ship.name,
        cruise_line_id: ship.cruise_line_id,
        ship_id: ship.id,
        field: "hero_image_url",
        original_url: String(url).trim(),
        host_class: classifyHost(url),
        is_selected_canonical: true,
        media_type: "ship"
      });
    }
  }

  return out;
}

/**
 * Index existing media_library rows for dedupe lookups.
 */
export function indexMediaLibrary(rows) {
  const byShipHash = new Map();
  const byLineHash = new Map();
  const bySourceUrl = new Map();
  const byPublicUrl = new Map();
  for (const row of rows || []) {
    if (row.ship_id && row.content_hash) {
      byShipHash.set(`${row.ship_id}:${row.content_hash}`, row);
    }
    if (row.cruise_line_id && row.content_hash) {
      byLineHash.set(`${row.cruise_line_id}:${row.content_hash}`, row);
    }
    if (row.source_url) bySourceUrl.set(String(row.source_url).trim(), row);
    if (row.public_url) byPublicUrl.set(String(row.public_url).trim(), row);
  }
  return { byShipHash, byLineHash, bySourceUrl, byPublicUrl };
}

function findExisting(candidate, hash, index) {
  if (candidate.entity_type === "ship") {
    const hit = index.byShipHash.get(`${candidate.ship_id}:${hash}`);
    if (hit) return hit;
  } else {
    const hit = index.byLineHash.get(`${candidate.cruise_line_id}:${hash}`);
    if (hit) return hit;
  }
  return (
    index.bySourceUrl.get(candidate.original_url) ||
    index.byPublicUrl.get(candidate.original_url) ||
    null
  );
}

/**
 * Inspect one downloaded buffer and produce a dry-run / copy plan row.
 */
export function inspectAsset(candidate, buffer, { supabaseUrl, mediaIndex }) {
  const size = buffer.length;
  const mime = sniffMime(buffer);
  try {
    assertAllowedMime(mime);
  } catch (error) {
    return {
      ...candidate,
      status: "invalid_mime",
      error: error.message,
      mime_detected: mime,
      bytes: size,
      content_hash: null
    };
  }

  if (size > LIMITS.maxUploadBytes) {
    return {
      ...candidate,
      status: "too_large",
      error: `File exceeds cruise-media limit (${LIMITS.maxUploadBytes} bytes)`,
      mime_detected: mime,
      bytes: size,
      content_hash: sha256Hex(buffer),
      oversized: true
    };
  }

  const hash = sha256Hex(buffer);
  const dims = readImageDimensions(buffer);
  let filename = filenameFromUrl(candidate.original_url);
  if (!/\.(jpe?g|png|webp)$/i.test(filename)) {
    filename = safeFilename(`${filename.replace(/\.[^.]+$/, "") || "image"}${extForMime(mime)}`);
  }

  const storagePath =
    candidate.entity_type === "ship"
      ? buildShipStoragePath(candidate.ship_id, hash, filename)
      : buildLineStoragePath(candidate.cruise_line_id, hash, filename);

  const proposedUrl = publicMediaUrl(supabaseUrl, storagePath);
  const existing = findExisting(candidate, hash, mediaIndex);
  const alreadyOnSupabase = candidate.host_class === "supabase";
  const alreadyMigrated = Boolean(existing);
  const alreadyPromoted =
    alreadyOnSupabase ||
    (existing &&
      candidate.original_url === existing.public_url);

  const oversized =
    size >= LIMITS.oversizedWarnBytes ||
    (candidate.field === "logo_url" && size >= LIMITS.logoSoftMaxBytes);

  let status = "proposed_upload";
  if (alreadyPromoted && alreadyOnSupabase) status = "already_promoted";
  else if (alreadyMigrated) status = "already_copied";
  else if (alreadyOnSupabase) status = "already_on_supabase";

  return {
    ...candidate,
    status,
    mime_detected: mime,
    bytes: size,
    width: dims.width,
    height: dims.height,
    content_hash: hash,
    original_filename: filename,
    storage_bucket: MEDIA_BUCKET,
    storage_path: storagePath,
    proposed_public_url: existing?.public_url || proposedUrl,
    media_library_id: existing?.id || null,
    import_source: IMPORT_SOURCE,
    source_url: candidate.original_url,
    oversized,
    already_migrated: alreadyMigrated,
    already_promoted: Boolean(alreadyPromoted && alreadyOnSupabase),
    ci_url_unchanged_after_copy: true,
    proposed_media_library: existing
      ? null
      : {
          title:
            candidate.entity_type === "ship"
              ? `${candidate.entity_name} hero`
              : `${candidate.entity_name} logo`,
          alt_text:
            candidate.entity_type === "ship"
              ? `${candidate.entity_name}`
              : `${candidate.entity_name} logo`,
          media_type: candidate.media_type,
          storage_bucket: MEDIA_BUCKET,
          storage_path: storagePath,
          public_url: proposedUrl,
          file_name: filename,
          original_filename: filename,
          mime_type: mime,
          width: dims.width,
          height: dims.height,
          file_size_bytes: size,
          cruise_line_id: candidate.cruise_line_id,
          ship_id: candidate.ship_id,
          content_hash: hash,
          import_source: IMPORT_SOURCE,
          source_url: candidate.original_url,
          tags: ["squarespace_migration", candidate.field === "logo_url" ? "logo" : "hero"],
          is_default: candidate.field === "hero_image_url" || candidate.field === "logo_url",
          is_active: true
        },
    proposed_canonical_change:
      status === "already_promoted"
        ? null
        : {
            table:
              candidate.entity_type === "ship" ? "ci_cruise_ships" : "ci_cruise_lines",
            id: candidate.entity_id,
            field: candidate.field,
            from: candidate.original_url,
            to: existing?.public_url || proposedUrl
          }
  };
}

export function emptyReport() {
  return {
    assets_inspected: 0,
    assets_reachable: 0,
    broken_urls: 0,
    invalid_mime_types: 0,
    too_large: 0,
    ssrf_blocked: 0,
    duplicate_binaries: 0,
    already_migrated: 0,
    already_promoted: 0,
    proposed_uploads: 0,
    proposed_media_library_records: 0,
    proposed_canonical_url_changes: 0,
    estimated_download_bytes: 0,
    estimated_upload_bytes: 0,
    oversized_assets: [],
    items: []
  };
}

export function summariseInspection(items) {
  const report = emptyReport();
  report.assets_inspected = items.length;
  report.items = items;

  const hashCounts = new Map();
  for (const item of items) {
    if (item.content_hash) {
      hashCounts.set(item.content_hash, (hashCounts.get(item.content_hash) || 0) + 1);
    }
    if (item.status === "broken_url") report.broken_urls += 1;
    else if (item.status === "invalid_mime") report.invalid_mime_types += 1;
    else if (item.status === "too_large") report.too_large += 1;
    else if (item.status === "ssrf_blocked") report.ssrf_blocked += 1;
    else if (item.status === "already_copied") {
      report.already_migrated += 1;
      report.assets_reachable += 1;
    } else if (item.status === "already_promoted" || item.status === "already_on_supabase") {
      report.already_promoted += 1;
      report.assets_reachable += 1;
    } else if (item.status === "proposed_upload") {
      report.proposed_uploads += 1;
      report.assets_reachable += 1;
      report.estimated_download_bytes += item.bytes || 0;
      report.estimated_upload_bytes += item.bytes || 0;
      if (item.proposed_media_library) report.proposed_media_library_records += 1;
      if (item.proposed_canonical_change) report.proposed_canonical_url_changes += 1;
    } else if (item.bytes != null) {
      report.assets_reachable += 1;
    }
    if (item.oversized) {
      report.oversized_assets.push({
        entity_type: item.entity_type,
        entity_id: item.entity_id,
        entity_name: item.entity_name,
        field: item.field,
        bytes: item.bytes,
        width: item.width,
        height: item.height,
        original_url: item.original_url
      });
    }
  }

  for (const c of hashCounts.values()) {
    if (c > 1) report.duplicate_binaries += c;
  }
  return report;
}

/**
 * Build media_library insert payload from an inspected proposed item.
 */
export function mediaRowFromInspection(item) {
  return item.proposed_media_library;
}

/**
 * Promote payload — only when copy verified.
 */
export function promotePatchFromInspection(item) {
  if (!item.proposed_canonical_change) return null;
  if (!item.media_library_id && item.status === "proposed_upload") {
    // After copy, media_library_id must be set
    return null;
  }
  return {
    table: item.proposed_canonical_change.table,
    id: item.proposed_canonical_change.id,
    field: item.proposed_canonical_change.field,
    original_url: item.proposed_canonical_change.from,
    new_url: item.proposed_canonical_change.to,
    media_library_id: item.media_library_id,
    storage_path: item.storage_path,
    content_hash: item.content_hash,
    entity_type: item.entity_type,
    entity_id: item.entity_id
  };
}

export function rollbackEntry(promoteRecord) {
  return {
    entity_type: promoteRecord.entity_type,
    entity_uuid: promoteRecord.entity_id,
    field_changed: promoteRecord.field,
    original_url: promoteRecord.original_url,
    new_url: promoteRecord.new_url,
    media_library_id: promoteRecord.media_library_id,
    storage_path: promoteRecord.storage_path,
    content_hash: promoteRecord.content_hash,
    migrated_timestamp: promoteRecord.migrated_timestamp || new Date().toISOString()
  };
}
