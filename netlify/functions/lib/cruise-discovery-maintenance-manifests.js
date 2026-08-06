/**
 * Maintenance rollback and audit manifests.
 */

const MANIFEST_TABLE = "cruise_discovery_maintenance_manifests";

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

function buildRollbackManifestFromWriteResult({
  runId,
  runRecordId,
  cruiseLineId,
  lineSlug,
  triggerType,
  writeResult,
  invocationId = null
}) {
  const details = writeResult?.write_details || writeResult?.stats?.write_details || [];
  const inserted = [];
  const updated = [];

  for (const detail of details) {
    if (detail.error) continue;
    const entry = {
      discovered_cruise_id: detail.discovered_cruise_id || null,
      official_sailing_id:
        detail.official_sailing_id ||
        detail.hal_product_key ||
        detail.celebrity_sailing_id ||
        null,
      action: detail.created ? "insert" : detail.duplicate ? "duplicate_skip" : "update",
      before_values: detail.before_values || null,
      after_values: detail.after_values || null
    };
    if (detail.created && detail.discovered_cruise_id) inserted.push(entry);
    else if (!detail.duplicate && detail.discovered_cruise_id && detail.before_values) updated.push(entry);
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
  const rows = await supabase(MANIFEST_TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: {
      manifest_type: manifestType,
      run_id: manifest.run_id || null,
      run_record_id: manifest.run_record_id || null,
      cruise_line_id: manifest.cruise_line_id || null,
      cruise_line_slug: manifest.cruise_line_slug || null,
      manifest
    }
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

module.exports = {
  MANIFEST_TABLE,
  snapshotRecordForRollback,
  buildRollbackManifestFromWriteResult,
  persistMaintenanceManifest,
  persistMaintenanceRollbackManifest
};
