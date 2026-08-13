/**
 * Unambiguous Seabourn inventory reconciliation fields for dry-run and idempotency reporting.
 */

function buildSeabournReconciliationSummary({
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
    unchanged: recognisedExistingEligible,
    outstanding_eligible_inserts: outstandingEligibleInserts,
    proposed_inserts: outstandingEligibleInserts,
    proposed_updates: proposedUpdates,
    source_absent_active: sourceAbsentActive,
    writes_executed: writesExecuted,
    reconciliation_arithmetic_ok: reconciliationArithmeticOk,
    all_active_recognised_in_eligible_source: allActiveRecognisedInEligibleSource
  };
}

module.exports = {
  buildSeabournReconciliationSummary
};
