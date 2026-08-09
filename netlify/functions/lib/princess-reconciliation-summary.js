/**
 * Unambiguous Princess inventory reconciliation fields for dry-run and idempotency reporting.
 *
 * Terminology (do not overload `unchanged` with pre-batch inventory counts):
 * - ACTIVE_PRODUCTION: active discovered_cruises rows in production (HEAD exact count)
 * - RECOGNISED_EXISTING_ELIGIBLE: eligible source sailings already present (duplicate_skip)
 * - OUTSTANDING_ELIGIBLE_INSERTS: eligible source sailings not yet active (insert_active)
 * - PROPOSED_UPDATES: eligible source sailings needing field updates (update_exact_legacy_match)
 * - SOURCE_ABSENT_ACTIVE: active production rows absent from current eligible source snapshot
 */

function buildPrincessReconciliationSummary({
  activeProductionTotal = 0,
  eligibleTotal = 0,
  recognisedExistingEligible = 0,
  outstandingEligibleInserts = 0,
  proposedUpdates = 0,
  sourceAbsentActive = 0,
  writesExecuted = 0
} = {}) {
  const eligibleAccounted =
    recognisedExistingEligible + outstandingEligibleInserts + proposedUpdates;
  const reconciliationArithmeticOk = eligibleTotal === eligibleAccounted;
  const allActiveRecognisedInEligibleSource =
    sourceAbsentActive === 0 ? activeProductionTotal === recognisedExistingEligible : null;

  return {
    active_production_total: activeProductionTotal,
    eligible_total: eligibleTotal,
    recognised_existing_eligible: recognisedExistingEligible,
    /** @deprecated Use recognised_existing_eligible — counts duplicate_skip in eligible source, not pre-batch inventory */
    unchanged: recognisedExistingEligible,
    outstanding_eligible_inserts: outstandingEligibleInserts,
    /** @deprecated Use outstanding_eligible_inserts */
    proposed_inserts: outstandingEligibleInserts,
    proposed_updates: proposedUpdates,
    source_absent_active: sourceAbsentActive,
    writes_executed: writesExecuted,
    reconciliation_arithmetic_ok: reconciliationArithmeticOk,
    all_active_recognised_in_eligible_source: allActiveRecognisedInEligibleSource
  };
}

module.exports = {
  buildPrincessReconciliationSummary
};
