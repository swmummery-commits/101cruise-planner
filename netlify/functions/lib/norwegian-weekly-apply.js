/**
 * Norwegian Cruise Line — weekly maintenance apply (inserts, promotions, hides).
 */

const { applyManifestWrites } = require("./norwegian-discovery-writes");
const { promoteNorwegianToActive, hideNorwegianFromPublicInventory, perthCalendarDate } = require("./norwegian-maintenance-shared");
const { validateNorwegianWeeklyManifest } = require("./norwegian-weekly-manifest");
const { indexExistingNorwegianRecords } = require("./norwegian-discovery-writes");
const { isGenuineInventoryRow } = require("./norwegian-discovery-adapter");
const {
  buildDryRunManifest,
  applyEnrichmentManifest
} = require("./norwegian-discovery-enrichment-writes");

async function fetchRecordById(supabase, id) {
  const rows = await supabase(
    `discovered_cruises?id=eq.${encodeURIComponent(id)}&select=id,status,departure_date,official_sailing_id,destination_id,ship_id,external_key,identity_key,raw_extract,itinerary_ports&limit=1`
  );
  return rows?.[0] || null;
}

async function applyNorwegianWeeklyManifest({
  manifest,
  supabase,
  cruiseLine,
  performWrites = true,
  runId = null,
  maxWrites = null,
  skipPromotions = false,
  skipCutoffHides = false,
  skipSourceAbsenceHides = false
}) {
  const validation = validateNorwegianWeeklyManifest(manifest);
  if (!validation.passed) {
    const err = new Error(`Norwegian weekly manifest validation failed: ${validation.failures.join("; ")}`);
    err.code = "norwegian_weekly_manifest_validation_failed";
    err.failures = validation.failures;
    throw err;
  }

  const perthToday = manifest.perth_today || perthCalendarDate();
  const stats = {
    inserted: 0,
    enriched: 0,
    promoted_active: 0,
    cutoff_hidden: 0,
    source_absence_hidden: 0,
    skipped: 0,
    failed: 0,
    hard_deletes: 0,
    write_details: []
  };

  const insertLimit = maxWrites == null ? (manifest.inserts || []).length : Math.min(maxWrites, (manifest.inserts || []).length);

  if ((manifest.inserts || []).length > 0) {
    const insertManifest = {
      ...(manifest.insert_manifest || {}),
      entries: (manifest.inserts || []).slice(0, insertLimit)
    };
    if (!performWrites) {
      stats.skipped += insertManifest.entries.length;
    } else {
      const insertResult = await applyManifestWrites({
        manifest: insertManifest,
        cruiseLine,
        supabase,
        maxWrites: insertLimit,
        runId,
        requireDestination: true
      });
      stats.inserted += insertResult.stats.inserted;
      stats.failed += insertResult.stats.failed;
      stats.write_details.push(...(insertResult.stats.write_details || []));

      if (insertResult.stats.inserted > 0) {
        const indexes = await indexExistingNorwegianRecords(supabase, cruiseLine.id);
        const newRows = (indexes.rows || []).filter(
          (r) =>
            isGenuineInventoryRow(r) &&
            r.status === "match_required" &&
            insertManifest.entries.some((e) => e.official_sailing_id === r.official_sailing_id)
        );
        const dryRunManifest = await buildDryRunManifest(
          insertManifest.entries.map((e) => ({
            discovered_cruise_id: newRows.find((r) => r.official_sailing_id === e.official_sailing_id)?.id,
            official_sailing_id: e.official_sailing_id
          })).filter((e) => e.discovered_cruise_id),
          new Map(newRows.map((r) => [r.id, r])),
          { runId }
        );
        const enrichResult = await applyEnrichmentManifest({ dryRunManifest, supabase, runId });
        stats.enriched += enrichResult.updated;
        stats.failed += enrichResult.failed;
      }
    }
  }

  const indexes = await indexExistingNorwegianRecords(supabase, cruiseLine.id);
  const byOfficial = new Map(
    (indexes.rows || []).filter((r) => isGenuineInventoryRow(r)).map((r) => [r.official_sailing_id, r])
  );

  if (!skipPromotions) {
    for (const promo of manifest.promotions || []) {
      const row = byOfficial.get(promo.official_sailing_id);
      if (!row || row.status !== "match_required") {
        stats.skipped += 1;
        continue;
      }
      if (row.raw_extract?.ncl_enrichment_status !== "enrichment_ready") {
        stats.skipped += 1;
        continue;
      }
      if (!performWrites) {
        stats.skipped += 1;
        stats.write_details.push({ ...promo, result_action: "dry_run_skip" });
        continue;
      }
      try {
        const result = await promoteNorwegianToActive({ supabase, row, runId, perthToday });
        stats.promoted_active += 1;
        stats.write_details.push(result);
      } catch (error) {
        stats.failed += 1;
        stats.write_details.push({ ...promo, result_action: "failed", error: error.message });
      }
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
        const result = await hideNorwegianFromPublicInventory({
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

  if (!skipSourceAbsenceHides) {
    for (const hide of manifest.source_absence_hides || []) {
      const row = hide.discovered_cruise_id
        ? await fetchRecordById(supabase, hide.discovered_cruise_id)
        : byOfficial.get(hide.official_sailing_id);
      if (!row || row.status !== "active") {
        stats.skipped += 1;
        continue;
      }
      if (!performWrites) {
        stats.skipped += 1;
        continue;
      }
      try {
        const result = await hideNorwegianFromPublicInventory({
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

  return { stats, validation, hard_deletes: 0 };
}

module.exports = {
  applyNorwegianWeeklyManifest,
  fetchRecordById
};
