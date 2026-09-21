/**
 * Princess weekly rollback evidence — persist before material apply.
 *
 * Inserts: before_state = ABSENT.
 * Updates: full previous-row snapshot.
 * If persistence fails, callers must perform 0 material writes.
 */

const {
  snapshotRecordForRollback,
  collectWriteDetails,
  isInsertedWriteDetail,
  persistMaintenanceManifest,
  patchMaintenanceManifest
} = require("./cruise-discovery-maintenance-manifests");

function officialIdFromDetail(detail) {
  return (
    detail?.official_sailing_id ||
    detail?.princess_sailing_id ||
    null
  );
}

function buildPrincessPreApplyRollbackManifest({
  plannedWrites = [],
  runId,
  runRecordId,
  cruiseLineId,
  lineSlug,
  triggerType
} = {}) {
  const inserted = [];
  const updated = [];

  for (const planned of plannedWrites) {
    const official = planned.official_sailing_id || null;
    if (!official) continue;
    if (planned.action === "insert") {
      inserted.push({
        discovered_cruise_id: null,
        official_sailing_id: official,
        action: "insert",
        before_state: "ABSENT",
        before_values: null
      });
      continue;
    }
    if (planned.action === "update") {
      const existing = planned.existing_record || planned.rollback || null;
      const existingId = planned.existing_record_id || existing?.id || null;
      updated.push({
        discovered_cruise_id: existingId,
        official_sailing_id: official,
        action: "update",
        before_values: existing ? snapshotRecordForRollback({ ...existing, id: existingId }) : null
      });
    }
  }

  return {
    run_id: runId,
    run_record_id: runRecordId,
    cruise_line_id: cruiseLineId,
    cruise_line_slug: lineSlug,
    trigger_type: triggerType || null,
    created_at: new Date().toISOString(),
    pre_apply: true,
    inserted,
    updated,
    inserted_record_ids: [],
    updated_record_ids: updated.map((row) => row.discovered_cruise_id).filter(Boolean),
    official_sailing_ids: [...inserted, ...updated].map((row) => row.official_sailing_id).filter(Boolean)
  };
}

async function persistPrincessPreApplyRollbackManifest(supabase, params) {
  const manifest = buildPrincessPreApplyRollbackManifest(params);
  if (!manifest.inserted.length && !manifest.updated.length) {
    return { skipped: true, ok: true, reason: "no_material_writes_planned", manifest };
  }
  try {
    const row = await persistMaintenanceManifest(supabase, {
      manifestType: "rollback",
      manifest
    });
    if (!row?.id) {
      return { skipped: false, ok: false, reason: "rollback_manifest_persist_failed", manifest };
    }
    return {
      skipped: false,
      ok: true,
      manifest_record_id: row.id,
      manifest
    };
  } catch (error) {
    return {
      skipped: false,
      ok: false,
      reason: "rollback_manifest_persist_failed",
      error: error.message || String(error),
      manifest
    };
  }
}

function completePrincessRollbackManifestWithWriteResult(preApplyManifest, writeResult) {
  const base = preApplyManifest && typeof preApplyManifest === "object" ? preApplyManifest : {};
  const details = collectWriteDetails(writeResult);
  const byOfficial = new Map();
  for (const detail of details) {
    const official = officialIdFromDetail(detail);
    if (official) byOfficial.set(official, detail);
  }

  const inserted = (base.inserted || []).map((entry) => {
    const detail = byOfficial.get(entry.official_sailing_id);
    return {
      ...entry,
      discovered_cruise_id: detail?.discovered_cruise_id || entry.discovered_cruise_id || null,
      after_values: detail?.after_values || entry.after_values || null
    };
  });

  for (const detail of details) {
    if (!isInsertedWriteDetail(detail)) continue;
    const official = officialIdFromDetail(detail);
    const already = inserted.some(
      (entry) =>
        entry.official_sailing_id === official ||
        entry.discovered_cruise_id === detail.discovered_cruise_id
    );
    if (already) continue;
    inserted.push({
      discovered_cruise_id: detail.discovered_cruise_id,
      official_sailing_id: official,
      action: "insert",
      before_state: "ABSENT",
      before_values: null
    });
  }

  const updated = (base.updated || []).map((entry) => {
    const detail = byOfficial.get(entry.official_sailing_id);
    return {
      ...entry,
      discovered_cruise_id:
        detail?.discovered_cruise_id || entry.discovered_cruise_id || null,
      after_values: detail?.after_values || entry.after_values || null
    };
  });

  return {
    ...base,
    pre_apply: true,
    write_completed: true,
    inserted,
    updated,
    inserted_record_ids: inserted.map((row) => row.discovered_cruise_id).filter(Boolean),
    updated_record_ids: updated.map((row) => row.discovered_cruise_id).filter(Boolean),
    official_sailing_ids: [...inserted, ...updated]
      .map((row) => row.official_sailing_id)
      .filter(Boolean),
    stats: writeResult?.stats || base.stats || null
  };
}

async function completePersistedPrincessRollbackManifest(supabase, manifestRecordId, completedManifest) {
  if (!supabase || !manifestRecordId || !completedManifest) return null;
  try {
    return await patchMaintenanceManifest(supabase, manifestRecordId, completedManifest);
  } catch {
    return null;
  }
}

module.exports = {
  buildPrincessPreApplyRollbackManifest,
  persistPrincessPreApplyRollbackManifest,
  completePrincessRollbackManifestWithWriteResult,
  completePersistedPrincessRollbackManifest
};
