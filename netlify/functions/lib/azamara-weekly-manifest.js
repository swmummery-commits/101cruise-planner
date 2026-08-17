/**
 * Azamara — weekly maintenance manifest builder.
 */

const {
  buildAzamaraWeeklyEntries,
  computeManifestHash,
  indexExistingAzamaraRecords
} = require("./azamara-discovery-writes");
const {
  isOfficialAzamaraRecord,
  isLegacyGenericAzamaraRow
} = require("./azamara-discovery-adapter");
const {
  classifyAzamaraSourceAbsence,
  extractPreviousAbsentSailingIds,
  isAzamaraSourceSnapshotComplete
} = require("./azamara-source-absence");
const { assessAzamaraWeeklyWriteSafety } = require("./azamara-weekly-update-policy");
const {
  daysUntilDeparture,
  perthCalendarDate,
  PUBLIC_BOOKING_CUTOFF_DAYS,
  shouldRemoveFromPublicInventory
} = require("./public-discovered-cruise-inventory");

const AZAMARA_MAX_WEEKLY_WRITES = 50;
const AZAMARA_MAX_WEEKLY_UPDATES = 10;

async function buildAzamaraWeeklyManifest({
  simulation,
  cruiseLine,
  supabase,
  today = perthCalendarDate(),
  runId = null,
  previousRun = null,
  maxNewInserts = null,
  maxUpdates = AZAMARA_MAX_WEEKLY_UPDATES
} = {}) {
  const indexes = await indexExistingAzamaraRecords(supabase, cruiseLine.id);
  const entries = await buildAzamaraWeeklyEntries({
    products: simulation?.products || [],
    cruiseLine,
    indexes
  });

  const inserts = entries.filter((e) => e.proposed_action === "insert_active");
  const updates = entries.filter((e) => e.proposed_action === "update_safe_metadata_allowed");
  const identityReview = entries.filter((e) => e.proposed_action === "update_identity_review_required");
  const unchanged = entries.filter((e) => e.proposed_action === "duplicate_skip");

  const limitedInserts =
    maxNewInserts == null ? inserts : inserts.slice(0, Math.max(0, maxNewInserts));
  const limitedUpdates = updates.slice(0, Math.max(0, maxUpdates));
  const actionableEntries = [...limitedInserts, ...limitedUpdates];

  const sourceEligibleIds = new Set(simulation?.source_eligible_official_ids || []);

  const cutoff_hides = [];
  for (const row of indexes.rows || []) {
    if (!isOfficialAzamaraRecord(row)) continue;
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
        isOfficialAzamaraRecord(row) &&
        row.status === "active" &&
        row.official_sailing_id &&
        !sourceEligibleIds.has(String(row.official_sailing_id).toUpperCase()) &&
        !shouldRemoveFromPublicInventory({ departureDate: row.departure_date, perthToday: today })
    )
    .map((row) => ({
      id: row.id,
      discovered_cruise_id: row.id,
      official_sailing_id: row.official_sailing_id,
      departure_date: row.departure_date
    }));

  const sourceComplete = isAzamaraSourceSnapshotComplete(simulation);
  const absenceClassification = classifyAzamaraSourceAbsence({
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

  const legacy_ignored = (indexes.rows || []).filter((row) => isLegacyGenericAzamaraRow(row)).length;
  const outcome_counts = simulation?.outcome_counts || {};

  const manifest = {
    generated_at: new Date().toISOString(),
    run_id: runId,
    perth_today: today,
    mode: "azamara_weekly_maintenance",
    source_complete: sourceComplete,
    source_counts: {
      sitemap_locs: simulation?.fetch_result?.sitemap_locs,
      eligible_urls: simulation?.fetch_result?.eligible_urls,
      urls_processed: simulation?.fetch_result?.urls_processed,
      source_eligible: sourceEligibleIds.size,
      ...outcome_counts
    },
    production_official: indexes.officialBySailingId?.size || 0,
    recognised_eligible: unchanged.length,
    outstanding_eligible: inserts.length,
    entries,
    inserts: limitedInserts,
    updates: limitedUpdates,
    identity_review: identityReview,
    unchanged,
    cutoff_hides,
    source_absence_hides,
    source_absence_policy: absenceClassification,
    legacy_ignored,
    quality_gate_metrics: simulation?.quality_gate_metrics || null,
    hard_deletes: 0
  };

  manifest.manifest_hash = computeManifestHash({
    mode: manifest.mode,
    cruise_line_id: cruiseLine.id,
    entries: actionableEntries.map((e) => ({
      official_sailing_id: e.official_sailing_id,
      proposed_action: e.proposed_action
    }))
  });

  manifest.write_safety = assessAzamaraWeeklyWriteSafety({
    sourceAbsencePolicy: absenceClassification,
    performWrites: false,
    proposedIdentityReviewUpdates: identityReview.length
  });

  return manifest;
}

function validateAzamaraWeeklyManifest(manifest) {
  const failures = [];
  const insertCount = (manifest.inserts || []).length;
  const updateCount = (manifest.updates || []).length;
  if (insertCount + updateCount > AZAMARA_MAX_WEEKLY_WRITES) {
    failures.push("weekly_write_cap_exceeded");
  }
  if (updateCount > AZAMARA_MAX_WEEKLY_UPDATES) {
    failures.push("weekly_update_cap_exceeded");
  }
  if (!manifest.source_complete && (manifest.source_absence_hides || []).length > 0) {
    failures.push("source_absence_without_complete_snapshot");
  }
  if ((manifest.quality_gate_metrics?.duplicate_official_sailing_ids || 0) > 0) {
    failures.push("duplicate_official_sailing_ids_in_source");
  }
  if ((manifest.quality_gate_metrics?.duplicate_official_identities || 0) > 0) {
    failures.push("duplicate_identities_in_source");
  }
  return { passed: failures.length === 0, failures };
}

module.exports = {
  AZAMARA_MAX_WEEKLY_WRITES,
  AZAMARA_MAX_WEEKLY_UPDATES,
  buildAzamaraWeeklyManifest,
  validateAzamaraWeeklyManifest
};
