/**
 * Authoritative Princess weekly maintenance outcomes.
 *
 * Inventory success is never determined by GitHub artifact upload,
 * schedule delay, or ordinary Review Lane items.
 */

const PRINCESS_OUTCOMES = Object.freeze({
  COMPLETED: "completed",
  COMPLETED_WITH_REVIEW: "completed_with_review",
  REVIEW_REQUIRED_BLOCKED: "review_required_blocked",
  FAILED: "failed",
  SOURCE_WORKER_NOT_STARTED: "source_worker_not_started"
});

function resolvePrincessWeeklyOutcome({
  sourceHealthy = false,
  sourceAccountingExact = false,
  canonicalAccountingExact = false,
  unexplainedCount = 0,
  safeLaneProcessed = false,
  reviewCount = 0,
  writesVerified = true,
  writeFailure = false,
  verificationFailure = false,
  lockFailure = false,
  sourceFailure = false,
  accountingFailure = false,
  partialWrite = false,
  artifactUploadFailed = false,
  scheduleDelayMinutes = 0
} = {}) {
  void artifactUploadFailed;
  void scheduleDelayMinutes;

  if (
    sourceFailure ||
    accountingFailure ||
    writeFailure ||
    verificationFailure ||
    lockFailure ||
    partialWrite ||
    writesVerified === false
  ) {
    return {
      outcome: PRINCESS_OUTCOMES.FAILED,
      ledger_status: "failed",
      github_exit_code: 1,
      infrastructure_failure: true,
      reason: sourceFailure
        ? "source_failure"
        : accountingFailure
          ? "accounting_failure"
          : writeFailure
            ? "write_failure"
            : verificationFailure
              ? "verification_failure"
              : lockFailure
                ? "lock_control_plane_failure"
                : partialWrite
                  ? "partial_write"
                  : "verification_incomplete"
    };
  }

  if (!sourceHealthy || !sourceAccountingExact || !canonicalAccountingExact || unexplainedCount > 0) {
    return {
      outcome: PRINCESS_OUTCOMES.REVIEW_REQUIRED_BLOCKED,
      ledger_status: "completed",
      github_exit_code: 0,
      infrastructure_failure: false,
      reason: unexplainedCount > 0 ? "unexplained_active_rows" : "unsafe_plan_not_trusted"
    };
  }

  if (safeLaneProcessed && reviewCount > 0) {
    return {
      outcome: PRINCESS_OUTCOMES.COMPLETED_WITH_REVIEW,
      ledger_status: "completed",
      github_exit_code: 0,
      infrastructure_failure: false,
      reason: "safe_lane_processed_reviews_remain"
    };
  }

  return {
    outcome: PRINCESS_OUTCOMES.COMPLETED,
    ledger_status: "completed",
    github_exit_code: 0,
    infrastructure_failure: false,
    reason: reviewCount === 0 ? "healthy_zero_or_applied_safe_lane" : "completed"
  };
}

function princessOutcomeIsInfrastructureFailure(outcome) {
  return outcome === PRINCESS_OUTCOMES.FAILED;
}

module.exports = {
  PRINCESS_OUTCOMES,
  resolvePrincessWeeklyOutcome,
  princessOutcomeIsInfrastructureFailure
};
