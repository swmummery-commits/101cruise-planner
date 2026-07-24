/**
 * In-memory / injectable adapters for copy · promote · rollback.
 * Production CLI wires these to Supabase REST + Storage.
 */

import { IMPORT_SOURCE, MEDIA_BUCKET } from "./media-utils.js";
import {
  mediaRowFromInspection,
  promotePatchFromInspection,
  rollbackEntry
} from "./plan.js";

/**
 * Run dry-run inspections for all candidates.
 */
export async function runDryRun(candidates, { fetchAsset, inspectAsset, supabaseUrl, mediaIndex }) {
  const items = [];
  for (const candidate of candidates) {
    try {
      const { buffer } = await fetchAsset(candidate.original_url);
      items.push(inspectAsset(candidate, buffer, { supabaseUrl, mediaIndex }));
    } catch (error) {
      const code = error.code || "fetch_failed";
      const status =
        code === "ssrf_blocked" || code === "invalid_protocol" || code === "invalid_url"
          ? "ssrf_blocked"
          : code === "invalid_mime"
            ? "invalid_mime"
            : code === "too_large"
              ? "too_large"
              : "broken_url";
      items.push({
        ...candidate,
        status,
        error: error.message,
        bytes: null,
        content_hash: null
      });
    }
  }
  return items;
}

/**
 * Copy phase: upload + media_library insert. Never patches CI URL fields.
 */
export async function runCopy(inspectedItems, adapters) {
  const {
    uploadObject,
    insertMedia,
    findMediaByHash,
    verifyPublicUrl,
    now = () => new Date().toISOString()
  } = adapters;

  const results = [];
  for (const item of inspectedItems) {
    if (item.status === "already_copied" || item.status === "already_promoted") {
      results.push({
        ...item,
        copy_result: "skipped_already_present",
        ci_url_changed: false
      });
      continue;
    }
    if (item.status !== "proposed_upload") {
      results.push({
        ...item,
        copy_result: "skipped_not_eligible",
        ci_url_changed: false
      });
      continue;
    }

    const existing =
      (await findMediaByHash?.(item)) ||
      null;
    if (existing) {
      results.push({
        ...item,
        status: "already_copied",
        media_library_id: existing.id,
        proposed_public_url: existing.public_url,
        storage_path: existing.storage_path,
        copy_result: "skipped_duplicate_hash",
        ci_url_changed: false
      });
      continue;
    }

    await uploadObject({
      bucket: MEDIA_BUCKET,
      path: item.storage_path,
      buffer: item._buffer,
      contentType: item.mime_detected
    });

    const ok = await verifyPublicUrl(item.proposed_public_url);
    if (!ok) {
      results.push({
        ...item,
        copy_result: "failed_verify",
        error: "Uploaded object failed public URL verification",
        ci_url_changed: false
      });
      continue;
    }

    const row = mediaRowFromInspection(item);
    const inserted = await insertMedia(row);
    results.push({
      ...item,
      status: "copied",
      media_library_id: inserted.id,
      proposed_public_url: inserted.public_url || item.proposed_public_url,
      copy_result: "uploaded",
      copied_at: now(),
      ci_url_changed: false,
      import_source: IMPORT_SOURCE
    });
  }
  return results;
}

/**
 * Promote phase: update CI logo_url / hero_image_url only for verified copies.
 */
export async function runPromote(copiedItems, adapters) {
  const { patchCiField, now = () => new Date().toISOString() } = adapters;
  const results = [];
  const manifest = [];

  for (const item of copiedItems) {
    const eligible =
      (item.status === "copied" || item.status === "already_copied") &&
      item.media_library_id &&
      item.proposed_public_url &&
      item.copy_result !== "failed_verify";

    if (!eligible) {
      results.push({
        ...item,
        promote_result: "skipped_not_verified",
        ci_url_changed: false
      });
      continue;
    }

    if (item.original_url === item.proposed_public_url) {
      results.push({
        ...item,
        promote_result: "skipped_already_promoted",
        ci_url_changed: false
      });
      continue;
    }

    const patch = promotePatchFromInspection({
      ...item,
      proposed_canonical_change: {
        table: item.entity_type === "ship" ? "ci_cruise_ships" : "ci_cruise_lines",
        id: item.entity_id,
        field: item.field,
        from: item.original_url,
        to: item.proposed_public_url
      }
    });

    if (!patch) {
      results.push({
        ...item,
        promote_result: "skipped_incomplete",
        ci_url_changed: false
      });
      continue;
    }

    await patchCiField(patch);
    const entry = rollbackEntry({
      ...patch,
      migrated_timestamp: now()
    });
    manifest.push(entry);
    results.push({
      ...item,
      promote_result: "promoted",
      ci_url_changed: true,
      promoted_at: entry.migrated_timestamp
    });
  }

  return { results, manifest };
}

/**
 * Rollback: restore CI URLs from manifest. Does not delete Storage/Media Library.
 */
export async function runRollback(manifest, { patchCiField }) {
  const results = [];
  for (const entry of manifest || []) {
    await patchCiField({
      table: entry.entity_type === "ship" ? "ci_cruise_ships" : "ci_cruise_lines",
      id: entry.entity_uuid,
      field: entry.field_changed,
      value: entry.original_url
    });
    results.push({
      ...entry,
      rollback_result: "restored",
      storage_deleted: false,
      media_library_deleted: false
    });
  }
  return results;
}
