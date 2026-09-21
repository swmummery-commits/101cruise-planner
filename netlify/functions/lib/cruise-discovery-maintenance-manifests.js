/**
 * Maintenance rollback and audit manifests.
 */

const MANIFEST_TABLE = "cruise_discovery_maintenance_manifests";
const MANIFEST_TYPE_DB = Object.freeze({
  disney_source_freeze: "dry_run",
  disney_precommit_batch: "rollback",
  partial_write_recovery: "rollback"
});

function snapshotRecordForRollback(record) {
  if (!record) return null;
  return {
    id: record.id,
    status: record.status,
    ship_id: record.ship_id,
    destination_id: record.destination_id,
    departure_date: record.departure_date,
    return_date: record.return_date,
    nights: record.nights,
    departure_port: record.departure_port,
    official_url: record.official_url,
    official_sailing_id: record.official_sailing_id,
    identity_key: record.identity_key,
    external_key: record.external_key
  };
}

function collectWriteDetails(writeResult) {
  if (!writeResult || typeof writeResult !== "object") return [];
  if (Array.isArray(writeResult.stats?.write_details)) return writeResult.stats.write_details;
  if (Array.isArray(writeResult.write_details)) return writeResult.write_details;
  return [];
}

function isInsertedWriteDetail(detail) {
  if (!detail || typeof detail !== "object") return false;
  if (detail.error && !detail.recovered_after_fetch_failure) return false;
  return Boolean(
    detail.discovered_cruise_id &&
      (detail.created || detail.result_action === "inserted" || detail.recovered_after_fetch_failure)
  );
}

function uniqueIds(ids = []) {
  return [...new Set((ids || []).filter(Boolean))];
}

function collectInsertedRecordIds({ writeResult, rollbackManifest } = {}) {
  const fromDetails = uniqueIds(
    collectWriteDetails(writeResult)
      .filter(isInsertedWriteDetail)
      .map((detail) => detail.discovered_cruise_id)
  );
  if (fromDetails.length) return fromDetails;
  return uniqueIds(rollbackManifest?.inserted_record_ids);
}

function buildRollbackManifestFromWriteResult({
  runId,
  runRecordId,
  cruiseLineId,
  lineSlug,
  triggerType,
  writeResult,
  invocationId = null
}) {
  const details = collectWriteDetails(writeResult);
  const inserted = [];
  const updated = [];

  for (const detail of details) {
    if (detail.error && !detail.recovered_after_fetch_failure) continue;
    const entry = {
      discovered_cruise_id: detail.discovered_cruise_id || null,
      official_sailing_id:
        detail.official_sailing_id ||
        detail.princess_sailing_id ||
        detail.hal_product_key ||
        detail.celebrity_sailing_id ||
        null,
      action: detail.created || detail.recovered_after_fetch_failure ? "insert" : detail.duplicate ? "duplicate_skip" : "update",
      before_values: detail.before_values || detail.rollback_before || null,
      after_values: detail.after_values || null,
      recovered_after_fetch_failure: detail.recovered_after_fetch_failure === true
    };
    const isInsert =
      detail.discovered_cruise_id &&
      (detail.created || detail.result_action === "inserted" || detail.recovered_after_fetch_failure);
    if (isInsert) inserted.push(entry);
    else if (!detail.duplicate && detail.discovered_cruise_id && (detail.before_values || detail.rollback_before)) {
      updated.push(entry);
    }
  }

  return {
    run_id: runId,
    run_record_id: runRecordId,
    cruise_line_id: cruiseLineId,
    cruise_line_slug: lineSlug,
    trigger_type: triggerType || null,
    invocation_id: invocationId,
    created_at: new Date().toISOString(),
    inserted_record_ids: inserted.map((r) => r.discovered_cruise_id).filter(Boolean),
    updated_record_ids: updated.map((r) => r.discovered_cruise_id).filter(Boolean),
    official_sailing_ids: [...inserted, ...updated]
      .map((r) => r.official_sailing_id)
      .filter(Boolean),
    inserted,
    updated,
    stats: writeResult?.stats || null
  };
}

async function persistMaintenanceManifest(supabase, { manifestType, manifest }) {
  if (!supabase || !manifest) return null;
  const dbType = MANIFEST_TYPE_DB[manifestType] || manifestType;
  const payload = {
    ...manifest,
    logical_manifest_type: manifest.logical_manifest_type || manifestType
  };
  const rows = await supabase(MANIFEST_TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      manifest_type: dbType,
      run_id: payload.run_id || null,
      run_record_id: payload.run_record_id || null,
      cruise_line_id: payload.cruise_line_id || null,
      cruise_line_slug: payload.cruise_line_slug || null,
      manifest: payload
    })
  });
  return rows?.[0] || null;
}

async function persistMaintenanceRollbackManifest(supabase, params) {
  const manifest = buildRollbackManifestFromWriteResult(params);
  if (!manifest.inserted.length && !manifest.updated.length) {
    return { skipped: true, reason: "no_writes", manifest };
  }
  const row = await persistMaintenanceManifest(supabase, {
    manifestType: "rollback",
    manifest
  });
  return { skipped: false, manifest, manifest_record_id: row?.id || null };
}

async function patchMaintenanceManifest(supabase, manifestId, manifest) {
  if (!supabase || !manifestId || !manifest) return null;
  const rows = await supabase(`${MANIFEST_TABLE}?id=eq.${encodeURIComponent(manifestId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ manifest })
  });
  return rows?.[0] || null;
}

module.exports = {
  MANIFEST_TABLE,
  MANIFEST_TYPE_DB,
  snapshotRecordForRollback,
  collectWriteDetails,
  isInsertedWriteDetail,
  collectInsertedRecordIds,
  buildRollbackManifestFromWriteResult,
  persistMaintenanceManifest,
  persistMaintenanceRollbackManifest,
  patchMaintenanceManifest
};
