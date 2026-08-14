/**
 * Norwegian Cruise Line — Phase 13 publication manifest builder.
 */

const { indexExistingNorwegianRecords } = require("./norwegian-discovery-writes");
const { isGenuineInventoryRow, isLegacyGenericDiscoveryRow } = require("./norwegian-discovery-adapter");
const {
  assessPublicationEligibility,
  daysUntilDeparture,
  perthCalendarDate,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require("./norwegian-maintenance-shared");

function buildPublicationManifest({
  productionRows = [],
  sourceEligibleOfficialIds = new Set(),
  today = perthCalendarDate(),
  runId = null,
  sourceTimestamp = null
}) {
  const exclusionCounts = {
    within_cutoff: 0,
    source_absent: 0,
    quality_review: 0,
    quality_fail: 0,
    incomplete_enrichment: 0,
    invalid_destination: 0,
    duplicate: 0,
    legacy: 0,
    not_match_required: 0,
    other: 0
  };

  const entries = [];
  const seenOfficial = new Set();
  const genuine = productionRows.filter((r) => isGenuineInventoryRow(r));

  for (const row of genuine) {
    if (seenOfficial.has(row.official_sailing_id)) {
      exclusionCounts.duplicate += 1;
      continue;
    }
    seenOfficial.add(row.official_sailing_id);

    const assessment = assessPublicationEligibility(row, { today, sourceEligibleOfficialIds });
    if (assessment.eligible) {
      entries.push({
        publication_position: entries.length + 1,
        discovered_cruise_id: row.id,
        official_sailing_id: row.official_sailing_id,
        external_key: row.external_key,
        identity_key: row.identity_key,
        ship_id: row.ship_id,
        destination_id: row.destination_id,
        departure_date: row.departure_date,
        departure_port: row.departure_port,
        days_until_departure: assessment.days_until_departure,
        proposed_action: "promote_active",
        proposed_status: "active"
      });
      continue;
    }

    for (const reason of assessment.exclusions) {
      if (reason === "within_cutoff") exclusionCounts.within_cutoff += 1;
      else if (reason === "source_absent") exclusionCounts.source_absent += 1;
      else if (reason === "null_destination_id") exclusionCounts.invalid_destination += 1;
      else if (reason === "incomplete_enrichment" || reason === "missing_itinerary_ports") {
        exclusionCounts.incomplete_enrichment += 1;
      } else if (reason.startsWith("status_")) exclusionCounts.not_match_required += 1;
      else exclusionCounts.other += 1;
    }
  }

  const legacyRows = productionRows.filter((r) => isLegacyGenericDiscoveryRow(r));
  exclusionCounts.legacy = legacyRows.length;

  const cutoffCandidates = genuine.filter(
    (r) =>
      r.status === "match_required" &&
      daysUntilDeparture(r.departure_date, today) <= PUBLIC_BOOKING_CUTOFF_DAYS
  );

  const sourceAbsentGenuine = genuine.filter(
    (r) => r.official_sailing_id && !sourceEligibleOfficialIds.has(r.official_sailing_id)
  );

  return {
    generated_at: new Date().toISOString(),
    run_id: runId,
    source_timestamp: sourceTimestamp,
    perth_today: today,
    publication_target: entries.length,
    exclusion_counts: exclusionCounts,
    cutoff_candidate_count: cutoffCandidates.length,
    source_absent_genuine_count: sourceAbsentGenuine.length,
    entries
  };
}

async function loadProductionRowsForPublication(supabase, lineId) {
  const indexes = await indexExistingNorwegianRecords(supabase, lineId);
  return indexes.rows || [];
}

function evaluatePublicationDryRunGate(manifest) {
  const failures = [];
  const entries = manifest.entries || [];
  if (entries.some((e) => e.days_until_departure <= PUBLIC_BOOKING_CUTOFF_DAYS)) {
    failures.push("cutoff_violation");
  }
  if (entries.some((e) => !e.destination_id)) failures.push("null_destination");
  if (new Set(entries.map((e) => e.official_sailing_id)).size !== entries.length) {
    failures.push("duplicate_official_sailing_id");
  }
  return {
    passed: failures.length === 0,
    failures,
    proposed_promotions: entries.length,
    proposed_deletes: 0
  };
}

module.exports = {
  buildPublicationManifest,
  loadProductionRowsForPublication,
  evaluatePublicationDryRunGate
};
