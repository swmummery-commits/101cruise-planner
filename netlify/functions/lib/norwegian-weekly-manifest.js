/**
 * Norwegian Cruise Line — weekly maintenance manifest builder.
 */

const {
  buildManifestFromEntries,
  indexExistingNorwegianRecords
} = require("./norwegian-discovery-writes");
const {
  isGenuineInventoryRow,
  isLegacyGenericDiscoveryRow
} = require("./norwegian-discovery-adapter");
const {
  assessPublicationEligibility,
  daysUntilDeparture,
  perthCalendarDate,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require("./norwegian-maintenance-shared");
const {
  classifyNorwegianSourceAbsence,
  extractPreviousAbsentSailingIds
} = require("./norwegian-source-absence");
const { shouldRemoveFromPublicInventory } = require("./public-discovered-cruise-inventory");

async function buildNorwegianWeeklyManifest({
  simulation,
  productionRows = [],
  cruiseLine,
  destinations = [],
  supabase = null,
  today = perthCalendarDate(),
  runId = null,
  previousRun = null,
  maxNewInserts = null
}) {
  const eligibleProducts = (simulation.products || simulation.normalised_products || []).filter(
    (p) => p.complete_eligible && p.itinerary_classification?.category === "ocean"
  );
  const sourceEligibleIds = new Set(eligibleProducts.map((p) => p.official_sailing_id).filter(Boolean));

  const genuineRows = productionRows.filter((r) => isGenuineInventoryRow(r));
  const productionByOfficial = new Map(
    genuineRows.filter((r) => r.official_sailing_id).map((r) => [r.official_sailing_id, r])
  );

  const newProducts = eligibleProducts.filter((p) => !productionByOfficial.has(p.official_sailing_id));
  const limitedNew =
    maxNewInserts == null ? newProducts : newProducts.slice(0, Math.max(0, maxNewInserts));

  const insertManifest = await buildManifestFromEntries({
    entries: limitedNew,
    cruiseLine,
    supabase,
    batchId: runId || `norwegian-weekly-${Date.now()}`,
    mode: "norwegian_weekly_maintenance",
    phase: "weekly_maintenance",
    expectedCount: limitedNew.length,
    requireDestination: true
  });
  const insertEntries = insertManifest.entries || [];

  const promotions = [];
  for (const row of genuineRows) {
    if (row.status !== "match_required") continue;
    const assessment = assessPublicationEligibility(row, { today, sourceEligibleOfficialIds: sourceEligibleIds });
    if (assessment.eligible) {
      promotions.push({
        discovered_cruise_id: row.id,
        official_sailing_id: row.official_sailing_id,
        external_key: row.external_key,
        destination_id: row.destination_id,
        departure_date: row.departure_date,
        days_until_departure: assessment.days_until_departure,
        proposed_action: "promote_active"
      });
    }
  }

  const cutoff_hides = [];
  for (const row of genuineRows) {
    if (row.status !== "active") continue;
    const days = daysUntilDeparture(row.departure_date, today);
    if (days != null && days <= PUBLIC_BOOKING_CUTOFF_DAYS) {
      cutoff_hides.push({
        id: row.id,
        official_sailing_id: row.official_sailing_id,
        departure_date: row.departure_date,
        days_until_departure: days,
        proposed_action: "hide_expired",
        reason: "within_public_booking_cutoff"
      });
    }
  }

  const sourceAbsentCandidates = genuineRows.filter(
    (r) =>
      r.status === "active" &&
      r.official_sailing_id &&
      !sourceEligibleIds.has(r.official_sailing_id) &&
      !shouldRemoveFromPublicInventory(r.departure_date, today)
  );

  const absenceClassification = classifyNorwegianSourceAbsence({
    currentAbsentRows: sourceAbsentCandidates.map((r) => ({
      id: r.id,
      discovered_cruise_id: r.id,
      official_sailing_id: r.official_sailing_id,
      departure_date: r.departure_date
    })),
    previousAbsentSailingIds: extractPreviousAbsentSailingIds(previousRun),
    enumerationHealthy: simulation?.source_fetch?.ok !== false
  });

  const source_absence_hides = absenceClassification.source_absent_actionable_records.map((entry) => ({
    discovered_cruise_id: entry.discovered_cruise_id,
    official_sailing_id: entry.official_sailing_id,
    proposed_action: "hide_source_absent",
    reason: "source_absent_actionable"
  }));

  const legacy_ignored = productionRows.filter((r) => isLegacyGenericDiscoveryRow(r)).length;

  return {
    generated_at: new Date().toISOString(),
    run_id: runId,
    perth_today: today,
    source_counts: {
      raw_sailings: simulation?.eligibility?.raw_sailings ?? null,
      ocean_total: simulation?.eligibility?.ocean_sailings ?? null,
      eligible_ocean: eligibleProducts.length,
      cruisetour_package: simulation?.eligibility?.cruisetour_package_sailings ?? null,
      within_cutoff: simulation?.eligibility?.within_public_booking_cutoff ?? null
    },
    production_genuine: genuineRows.length,
    recognised_eligible: eligibleProducts.filter((p) => productionByOfficial.has(p.official_sailing_id)).length,
    outstanding_eligible: newProducts.length,
    inserts: insertManifest.entries || [],
    insert_manifest: insertManifest,
    promotions,
    cutoff_hides,
    source_absence_hides,
    source_absence_policy: absenceClassification,
    legacy_ignored,
    hard_deletes: 0
  };
}

function validateNorwegianWeeklyManifest(manifest) {
  const failures = [];
  for (const entry of manifest.promotions || []) {
    if (entry.days_until_departure <= PUBLIC_BOOKING_CUTOFF_DAYS) {
      failures.push(`promotion_within_cutoff:${entry.official_sailing_id}`);
    }
  }
  for (const ins of manifest.inserts || []) {
    if (ins.proposed_action !== "insert_match_required") {
      failures.push(`insert_not_match_required:${ins.official_sailing_id}`);
    }
    if (ins.proposed_status && ins.proposed_status !== "match_required") {
      failures.push(`insert_not_match_required_status:${ins.official_sailing_id}`);
    }
  }
  return { passed: failures.length === 0, failures };
}

async function loadNorwegianProductionForWeekly(supabase, lineId) {
  return indexExistingNorwegianRecords(supabase, lineId);
}

module.exports = {
  buildNorwegianWeeklyManifest,
  validateNorwegianWeeklyManifest,
  loadNorwegianProductionForWeekly
};
