/**
 * Unambiguous Seabourn inventory reconciliation fields for dry-run and idempotency reporting.
 */

function buildSeabournReconciliationSummary({
  activeProductionTotal = 0,
  eligibleTotal = 0,
  recognisedExistingEligible = 0,
  outstandingEligibleInserts = 0,
  proposedUpdates = 0,
  proposedIdentityReviewUpdates = 0,
  sourceAbsentActive = 0,
  sourceAbsentObserved = null,
  sourceAbsentRetained = null,
  writesExecuted = 0
} = {}) {
  const retained =
    sourceAbsentRetained != null ? Number(sourceAbsentRetained) : Number(sourceAbsentActive || 0);
  const observed =
    sourceAbsentObserved != null ? Number(sourceAbsentObserved) : Number(sourceAbsentActive || 0);

  const reviewUpdates = Number(proposedIdentityReviewUpdates || 0);
  const existingEligibleUpdates = Number(proposedUpdates || 0);
  const eligibleAccounted =
    recognisedExistingEligible +
    outstandingEligibleInserts +
    existingEligibleUpdates +
    reviewUpdates;
  const reconciliationArithmeticOk = eligibleTotal === eligibleAccounted;

  // Existing production rows = unchanged + safe/exact updates + identity-review + retained absences.
  // Inserts are not yet in production and must not be counted here.
  const activeAccounted = recognisedExistingEligible + existingEligibleUpdates + reviewUpdates + retained;
  const activeProductionArithmeticOk = activeProductionTotal === activeAccounted;

  return {
    active_production_total: activeProductionTotal,
    eligible_total: eligibleTotal,
    recognised_existing_eligible: recognisedExistingEligible,
    unchanged: recognisedExistingEligible,
    outstanding_eligible_inserts: outstandingEligibleInserts,
    proposed_inserts: outstandingEligibleInserts,
    proposed_updates: proposedUpdates,
    proposed_identity_review_updates: Number(proposedIdentityReviewUpdates || 0),
    source_absent_active: Number(sourceAbsentActive || 0),
    source_absent_observed: observed,
    source_absent_retained: retained,
    writes_executed: writesExecuted,
    reconciliation_arithmetic_ok: reconciliationArithmeticOk,
    active_production_arithmetic_ok: activeProductionArithmeticOk,
    all_active_recognised_in_eligible_source:
      retained === 0 ? activeProductionTotal === recognisedExistingEligible : null
  };
}

module.exports = {
  buildSeabournReconciliationSummary
};
