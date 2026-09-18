/**
 * Azamara weekly rollback manifest — persist before material apply.
 */

const crypto = require("crypto");
const { snapshotRecordForRollback, persistMaintenanceManifest } = require("./cruise-discovery-maintenance-manifests");
const { buildAzamaraSafeUpdatePatch } = require("./azamara-discovery-writes");
const { mergeAzamaraStableRawExtract } = require("./azamara-weekly-safe-metadata");
const { ALLOWED_WEEKLY_UPDATE_FIELDS } = require("./azamara-weekly-update-policy");

function buildAzamaraPreApplyRollbackManifest({
  manifest,
  runId,
  runRecordId,
  cruiseLineId,
  lineSlug,
  triggerType
}) {
  const updated = [];
  for (const entry of manifest?.updates || []) {
    const existingId = entry.existing_record_id;
    if (!existingId || !entry.existing_snapshot) continue;
    const existing = {
      ...entry.existing_snapshot,
      id: existingId,
      official_sailing_id: entry.official_sailing_id,
      raw_extract: entry.existing_snapshot.raw_extract || {}
    };
    const candidate = entry.candidate || {};
    const mergedCandidate = {
      ...candidate,
      raw_extract: mergeAzamaraStableRawExtract(existing.raw_extract, candidate.raw_extract)
    };
    const plannedPatch = buildAzamaraSafeUpdatePatch(existing, mergedCandidate);
    updated.push({
      discovered_cruise_id: existingId,
      official_sailing_id: entry.official_sailing_id || null,
      action: "update",
      before_values: snapshotRecordForRollback(existing),
      planned_safe_patch: plannedPatch,
      allowed_fields: [...ALLOWED_WEEKLY_UPDATE_FIELDS, "last_seen_at", "last_verified_at"]
    });
  }

  const inserted = (manifest?.inserts || []).map((entry) => ({
    discovered_cruise_id: null,
    official_sailing_id: entry.official_sailing_id || null,
    action: "insert",
    before_values: null,
    planned_safe_patch: entry.candidate || null
  }));

  const payload = {
    run_id: runId,
    run_record_id: runRecordId,
    cruise_line_id: cruiseLineId,
    cruise_line_slug: lineSlug,
    trigger_type: triggerType || null,
    created_at: new Date().toISOString(),
    pre_apply: true,
    inserted,
    updated,
    updated_record_ids: updated.map((r) => r.discovered_cruise_id).filter(Boolean),
    official_sailing_ids: [...inserted, ...updated].map((r) => r.official_sailing_id).filter(Boolean)
  };
  payload.manifest_hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ updated: payload.updated, inserted: payload.inserted }))
    .digest("hex");
  return payload;
}

async function persistAzamaraPreApplyRollbackManifest(supabase, params) {
  const manifest = buildAzamaraPreApplyRollbackManifest(params);
  if (!manifest.updated.length && !manifest.inserted.length) {
    return { skipped: true, reason: "no_material_writes_planned", manifest };
  }
  const row = await persistMaintenanceManifest(supabase, {
    manifestType: "rollback",
    manifest
  });
  if (!row?.id) {
    return { skipped: false, ok: false, reason: "manifest_persist_failed", manifest };
  }
  return {
    skipped: false,
    ok: true,
    manifest_record_id: row.id,
    manifest_hash: manifest.manifest_hash,
    manifest
  };
}

module.exports = {
  buildAzamaraPreApplyRollbackManifest,
  persistAzamaraPreApplyRollbackManifest
};
