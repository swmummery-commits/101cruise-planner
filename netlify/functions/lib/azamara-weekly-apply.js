/**
 * Azamara — weekly maintenance apply.
 */

const { applyAzamaraBatchWrites, computeManifestHash } = require("./azamara-discovery-writes");
const { validateAzamaraWeeklyManifest, AZAMARA_MAX_WEEKLY_WRITES } = require("./azamara-weekly-manifest");
const {
  expirationMetadataForMaintenance,
  perthCalendarDate
} = require("./public-discovered-cruise-inventory");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");

async function fetchRecordById(supabase, id) {
  const rows = await supabase(
    `discovered_cruises?id=eq.${encodeURIComponent(id)}&select=id,status,departure_date,official_sailing_id,raw_extract,cruise_line_id&limit=1`
  );
  return rows?.[0] || null;
}

async function hideAzamaraFromPublicInventory({ supabase, row, runId, perthToday, reason = "within_public_booking_cutoff" }) {
  const now = new Date().toISOString();
  const rawExtract = { ...(row.raw_extract || {}) };
  const meta = expirationMetadataForMaintenance({ departureDate: row.departure_date, perthToday });
  rawExtract.expired_at = now;
  rawExtract.expiration_reason = meta?.expiration_reason || reason;
  rawExtract.public_unavailability = meta?.public_unavailability || reason;
  rawExtract.expiration_run_id = runId || null;
  rawExtract.previous_status = row.status;
  rawExtract.maintenance_expired_at = now;

  await supabase(`discovered_cruises?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "expired", last_changed_at: now, raw_extract: rawExtract })
  });

  return {
    discovered_cruise_id: row.id,
    official_sailing_id: row.official_sailing_id || null,
    result_action: "expired",
    rollback_snapshot: snapshotRecordForRollback(row)
  };
}

async function applyAzamaraWeeklyManifest({
  manifest,
  supabase,
  cruiseLine,
  performWrites = true,
  runId = null,
  maxWrites = AZAMARA_MAX_WEEKLY_WRITES,
  skipCutoffHides = false,
  skipSourceAbsenceHides = false
}) {
  const validation = validateAzamaraWeeklyManifest(manifest);
  if (!validation.passed) {
    const err = new Error(`Azamara weekly manifest validation failed: ${validation.failures.join("; ")}`);
    err.code = "azamara_weekly_manifest_validation_failed";
    err.failures = validation.failures;
    throw err;
  }

  const perthToday = manifest.perth_today || perthCalendarDate();
  const stats = {
    inserted: 0,
    updated: 0,
    cutoff_hidden: 0,
    source_absence_hidden: 0,
    skipped: 0,
    failed: 0,
    write_details: []
  };

  const actionableEntries = [...(manifest.inserts || []), ...(manifest.updates || [])];
  const applyManifest = {
    generated_at: manifest.generated_at,
    mode: "azamara_weekly_maintenance_apply",
    run_id: runId,
    cruise_line_id: cruiseLine.id,
    entries: actionableEntries.slice(0, maxWrites),
    manifest_hash: computeManifestHash({
      mode: "azamara_weekly_maintenance_apply",
      cruise_line_id: cruiseLine.id,
      entries: actionableEntries.slice(0, maxWrites)
    })
  };

  if (actionableEntries.length > 0) {
    if (!performWrites) {
      stats.skipped += actionableEntries.length;
    } else {
      const writeResult = await applyAzamaraBatchWrites({
        manifest: applyManifest,
        cruiseLine,
        maxWrites,
        runId,
        supabase,
        performWrites: true,
        expectedHash: applyManifest.manifest_hash
      });
      stats.inserted += writeResult.stats.inserted;
      stats.updated += writeResult.stats.updated;
      stats.failed += writeResult.stats.failed;
      stats.write_details.push(...(writeResult.stats.write_details || []));
    }
  }

  if (!skipCutoffHides) {
    for (const hide of manifest.cutoff_hides || []) {
      const row = await fetchRecordById(supabase, hide.id);
      if (!row || row.status !== "active") {
        stats.skipped += 1;
        continue;
      }
      if (!performWrites) {
        stats.skipped += 1;
        continue;
      }
      try {
        const result = await hideAzamaraFromPublicInventory({
          supabase,
          row,
          runId,
          perthToday,
          reason: hide.reason || "within_public_booking_cutoff"
        });
        stats.cutoff_hidden += 1;
        stats.write_details.push(result);
      } catch (error) {
        stats.failed += 1;
        stats.write_details.push({ ...hide, result_action: "failed", error: error.message });
      }
    }
  }

  if (!skipSourceAbsenceHides && manifest.source_complete === true) {
    for (const hide of manifest.source_absence_hides || []) {
      const row = await fetchRecordById(supabase, hide.discovered_cruise_id);
      if (!row || row.status !== "active") {
        stats.skipped += 1;
        continue;
      }
      if (!performWrites) {
        stats.skipped += 1;
        continue;
      }
      try {
        const result = await hideAzamaraFromPublicInventory({
          supabase,
          row,
          runId,
          perthToday,
          reason: "source_absent"
        });
        stats.source_absence_hidden += 1;
        stats.write_details.push(result);
      } catch (error) {
        stats.failed += 1;
        stats.write_details.push({ ...hide, result_action: "failed", error: error.message });
      }
    }
  }

  return { stats, performWrites: performWrites === true };
}

module.exports = {
  applyAzamaraWeeklyManifest,
  hideAzamaraFromPublicInventory
};
