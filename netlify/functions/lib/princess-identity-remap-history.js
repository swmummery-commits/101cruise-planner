/**
 * Durable Princess official-ID remap history.
 *
 * The discovered_cruises UUID remains the voyage source of truth.
 * History is an audit record on the existing maintenance-manifest table,
 * plus the existing raw_extract.princess_p1_official_id_remap stamp.
 * No competing identity table is introduced.
 */

const { persistMaintenanceManifest } = require("./cruise-discovery-maintenance-manifests");

const LOGICAL_MANIFEST_TYPE = "princess_identity_remap";

function buildPrincessRemapHistoryRecord({
  discoveredCruiseId,
  oldOfficialSailingId,
  newOfficialSailingId,
  oldExternalKey,
  newExternalKey,
  oldIdentityKey,
  newIdentityKey,
  sourceSnapshotA,
  sourceSnapshotB,
  reason,
  changedAt,
  runRecordId,
  runId,
  cruiseLineId,
  rollbackManifestId
} = {}) {
  return {
    logical_manifest_type: LOGICAL_MANIFEST_TYPE,
    discovered_cruise_id: discoveredCruiseId || null,
    old_official_sailing_id: oldOfficialSailingId || null,
    new_official_sailing_id: newOfficialSailingId || null,
    old_external_key: oldExternalKey || null,
    new_external_key: newExternalKey || null,
    old_identity_key: oldIdentityKey || null,
    new_identity_key: newIdentityKey || null,
    source_snapshot_a: sourceSnapshotA || null,
    source_snapshot_b: sourceSnapshotB || null,
    reason: reason || "deterministic_official_id_remap",
    changed_at: changedAt || new Date().toISOString(),
    run_record_id: runRecordId || null,
    run_id: runId || null,
    cruise_line_id: cruiseLineId || null,
    cruise_line_slug: "princess-cruises",
    rollback_manifest_id: rollbackManifestId || null,
    uuid_preserved: true,
    deleted_old_row: false,
    inserted_replacement_row: false
  };
}

async function persistPrincessRemapHistory(supabase, params) {
  const manifest = buildPrincessRemapHistoryRecord(params);
  if (!manifest.discovered_cruise_id || !manifest.old_official_sailing_id || !manifest.new_official_sailing_id) {
    return { ok: false, reason: "remap_history_incomplete", manifest };
  }
  const row = await persistMaintenanceManifest(supabase, {
    manifestType: "dry_run",
    manifest
  });
  return {
    ok: Boolean(row?.id),
    manifest_record_id: row?.id || null,
    manifest
  };
}

module.exports = {
  LOGICAL_MANIFEST_TYPE,
  buildPrincessRemapHistoryRecord,
  persistPrincessRemapHistory
};
