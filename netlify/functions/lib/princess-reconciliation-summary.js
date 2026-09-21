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

function explainPrincessActiveProduction({
  activeProductionTotal = 0,
  recognisedExistingEligible = 0,
  sourceAbsentActive = 0,
  dailyExpiryManaged = 0,
  otherExplainedNonEligibleActive = 0
} = {}) {
  const recognised = Number(recognisedExistingEligible) || 0;
  const sourceAbsent = Number(sourceAbsentActive) || 0;
  const dailyExpiry = Number(dailyExpiryManaged) || 0;
  const otherExplained = Number(otherExplainedNonEligibleActive) || 0;
  const explained = recognised + sourceAbsent + dailyExpiry + otherExplained;
  const unexplained = (Number(activeProductionTotal) || 0) - explained;
  return {
    active_production_total: Number(activeProductionTotal) || 0,
    explained_active_total: explained,
    unexplained_active_rows: unexplained,
    unexplained_active_ok: unexplained === 0,
    explained_active_buckets: {
      recognised_existing_eligible: recognised,
      source_absent_active: sourceAbsent,
      daily_expiry_managed: dailyExpiry,
      other_explained_non_eligible_active: otherExplained
    }
  };
}

function buildPrincessReconciliationSummary({
  activeProductionTotal = 0,
  eligibleTotal = 0,
  recognisedExistingEligible = 0,
  outstandingEligibleInserts = 0,
  proposedUpdates = 0,
  proposedIdentityReviewUpdates = 0,
  sourceAbsentActive = 0,
  dailyExpiryManaged = 0,
  otherExplainedNonEligibleActive = 0,
  writesExecuted = 0
} = {}) {
  const reviewUpdates = Number(proposedIdentityReviewUpdates || 0);
  const eligibleAccounted =
    recognisedExistingEligible +
    outstandingEligibleInserts +
    proposedUpdates +
    reviewUpdates;
  const reconciliationArithmeticOk = eligibleTotal === eligibleAccounted;
  const allActiveRecognisedInEligibleSource =
    sourceAbsentActive === 0 && reviewUpdates === 0
      ? activeProductionTotal === recognisedExistingEligible
      : null;
  const activeAccounting = explainPrincessActiveProduction({
    activeProductionTotal,
    recognisedExistingEligible,
    sourceAbsentActive,
    dailyExpiryManaged,
    otherExplainedNonEligibleActive
  });

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
    proposed_identity_review_updates: reviewUpdates,
    source_absent_active: sourceAbsentActive,
    daily_expiry_managed: Number(dailyExpiryManaged) || 0,
    writes_executed: writesExecuted,
    reconciliation_arithmetic_ok: reconciliationArithmeticOk,
    all_active_recognised_in_eligible_source: allActiveRecognisedInEligibleSource,
    unexplained_active_rows: activeAccounting.unexplained_active_rows,
    unexplained_active_ok: activeAccounting.unexplained_active_ok,
    explained_active_total: activeAccounting.explained_active_total,
    explained_active_buckets: activeAccounting.explained_active_buckets
  };
}

module.exports = {
  explainPrincessActiveProduction,
  buildPrincessReconciliationSummary
};
