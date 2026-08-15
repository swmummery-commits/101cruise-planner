/**
 * Carnival Cruise Line — weekly maintenance manifest builder.
 */

const { officialSailingId } = require("./carnival-discovery-adapter");
const {
  buildCclBatchManifest,
  classifyProposedAction,
  indexExistingCclRecords,
  isLegacyGenericCclRow,
  isOfficialCclStructuredRecord
} = require("./carnival-discovery-writes");
const { isControlledBatchEligible } = require("./carnival-controlled-batch");
const {
  classifyCclSourceAbsence,
  extractPreviousAbsentSailingIds,
  isSourceSnapshotComplete
} = require("./carnival-source-absence");
const {
  daysUntilDeparture,
  perthCalendarDate,
  PUBLIC_BOOKING_CUTOFF_DAYS,
  shouldRemoveFromPublicInventory
} = require("./public-discovered-cruise-inventory");

async function buildCclWeeklyManifest({
  simulation,
  cruiseLine,
  supabase,
  today = perthCalendarDate(),
  runId = null,
  previousRun = null,
  maxNewInserts = null
}) {
  const products = simulation?.products || [];
  const eligibleProducts = products.filter((row) => isControlledBatchEligible(row, today));
  const sourceEligibleIds = new Set(eligibleProducts.map((row) => officialSailingId(row.raw)).filter(Boolean));
  const indexes = await indexExistingCclRecords(supabase, cruiseLine.id);

  const batchManifest = await buildCclBatchManifest({
    products,
    cruiseLine,
    supabase,
    selectedOnly: eligibleProducts
  });

  const inserts = [];
  const updates = [];
  const unchanged = [];
  for (const entry of batchManifest.entries || []) {
    if (entry.proposed_action === "insert_active") inserts.push(entry);
    else if (entry.proposed_action === "update_official_match") updates.push(entry);
    else if (entry.proposed_action === "duplicate_skip") unchanged.push(entry);
  }

  const limitedInserts =
    maxNewInserts == null ? inserts : inserts.slice(0, Math.max(0, maxNewInserts));

  const cutoff_hides = [];
  for (const row of indexes.rows || []) {
    if (!isOfficialCclStructuredRecord(row)) continue;
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

  const sourceAbsentCandidates = (indexes.rows || [])
    .filter(
      (row) =>
        isOfficialCclStructuredRecord(row) &&
        row.status === "active" &&
        row.official_sailing_id &&
        !sourceEligibleIds.has(row.official_sailing_id) &&
        !shouldRemoveFromPublicInventory(row.departure_date, today)
    )
    .map((row) => ({
      id: row.id,
      discovered_cruise_id: row.id,
      official_sailing_id: row.official_sailing_id,
      departure_date: row.departure_date
    }));

  const sourceComplete = isSourceSnapshotComplete(simulation);
  const absenceClassification = classifyCclSourceAbsence({
    currentAbsentRows: sourceAbsentCandidates,
    previousAbsentSailingIds: extractPreviousAbsentSailingIds(previousRun),
    enumerationHealthy: simulation?.fetch_result?.ok !== false,
    sourceComplete
  });

  const source_absence_hides = absenceClassification.source_absent_actionable_records.map((entry) => ({
    discovered_cruise_id: entry.discovered_cruise_id,
    official_sailing_id: entry.official_sailing_id,
    proposed_action: "hide_source_absent",
    reason: "source_absent_actionable"
  }));

  const legacy_ignored = (indexes.rows || []).filter((row) => isLegacyGenericCclRow(row)).length;

  return {
    generated_at: new Date().toISOString(),
    run_id: runId,
    perth_today: today,
    mode: "carnival_weekly_maintenance",
    source_complete: sourceComplete,
    source_counts: {
      raw_groups: simulation?.fetch_result?.raw_group_count,
      unique_groups: simulation?.fetch_result?.unique_group_count,
      unique_sailings: products.length,
      cutoff_eligible: simulation?.readiness_funnel?.cutoff_eligible,
      eligible_products: eligibleProducts.length
    },
    production_official: indexes.officialBySailingId?.size || 0,
    recognised_eligible: unchanged.length,
    outstanding_eligible: inserts.length,
    inserts: limitedInserts,
    updates,
    unchanged,
    cutoff_hides,
    source_absence_hides,
    source_absence_policy: absenceClassification,
    legacy_ignored,
    quality_gate: simulation?.quality_gate_metrics || null
  };
}

function validateCclWeeklyManifest(manifest) {
  const failures = [];
  if ((manifest.inserts || []).length + (manifest.updates || []).length > 250) {
    failures.push("weekly_write_cap_exceeded");
  }
  for (const hide of manifest.cutoff_hides || []) {
    if (hide.days_until_departure <= PUBLIC_BOOKING_CUTOFF_DAYS) continue;
    failures.push(`cutoff_hide_not_within_cutoff:${hide.official_sailing_id}`);
  }
  if (!manifest.source_complete && (manifest.source_absence_hides || []).length > 0) {
    failures.push("source_absence_without_complete_snapshot");
  }
  return { passed: failures.length === 0, failures };
}

module.exports = {
  buildCclWeeklyManifest,
  validateCclWeeklyManifest
};
