/**
 * Royal Caribbean weekly maintenance health summary and write guardrails.
 */

const ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING = {
  max_proposed_inserts: 100,
  max_proposed_updates: 50,
  max_source_absent_actions: 20,
  max_total_proposed_changes: 150,
  rationale:
    "Catalogue ~3,000 sailings; normal weekly movement is small. Sudden hundreds of changes indicate enumeration or logic failure."
};

function evaluateRoyalCaribbeanWeeklyHealth({
  sourceRuntimeOk = false,
  enumerationHealth = {},
  reconciliationArithmeticOk = false,
  shipResolutionOk = false,
  embarkationResolutionOk = false,
  unknownStatusCount = 0,
  newEligibleCount = 0,
  proposedUpdateCount = 0,
  sourceAbsentCandidateCount = 0,
  cutoffCandidateCount = 0,
  actualWrites = 0,
  sourceAbsencePolicy = {},
  performWrites = false
} = {}) {
  const policy = sourceAbsencePolicy || {};
  const failures = [];
  if (!sourceRuntimeOk) failures.push("source_runtime_not_ok");
  if (enumerationHealth?.royal_caribbean_source_enumeration_ok !== true) {
    failures.push("source_enumeration_unhealthy");
  }
  if (!reconciliationArithmeticOk) failures.push("reconciliation_arithmetic_failed");
  if (!shipResolutionOk) failures.push("ship_resolution_failed");
  if (!embarkationResolutionOk) failures.push("embarkation_resolution_failed");
  if (Number(actualWrites) !== 0) failures.push("unexpected_writes");

  const ceiling = ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING;
  const volumeExceeded =
    newEligibleCount > ceiling.max_proposed_inserts ||
    proposedUpdateCount > ceiling.max_proposed_updates ||
    (policy.source_absent_action_eligible_count || 0) > ceiling.max_source_absent_actions ||
    newEligibleCount + proposedUpdateCount + (policy.source_absent_action_eligible_count || 0) >
      ceiling.max_total_proposed_changes;

  if (performWrites && volumeExceeded) failures.push("weekly_change_volume_exceeds_ceiling");

  const weeklyMaintenanceHealthy = failures.length === 0;

  return {
    source_runtime_ok: sourceRuntimeOk === true,
    royal_caribbean_source_enumeration_ok: enumerationHealth?.royal_caribbean_source_enumeration_ok === true,
    reconciliation_arithmetic_ok: reconciliationArithmeticOk === true,
    ship_resolution_ok: shipResolutionOk === true,
    embarkation_resolution_ok: embarkationResolutionOk === true,
    unknown_status_count: unknownStatusCount,
    new_eligible_count: newEligibleCount,
    proposed_update_count: proposedUpdateCount,
    source_absent_candidate_count: sourceAbsentCandidateCount,
    cutoff_candidate_count: cutoffCandidateCount,
    source_absence_actions_allowed: policy.source_absence_actions_allowed === true,
    actual_writes: Number(actualWrites) || 0,
    weekly_change_volume_exceeded: volumeExceeded,
    weekly_write_ceiling: ceiling,
    weekly_maintenance_healthy: weeklyMaintenanceHealthy,
    failures
  };
}

/** Approved total production mutations cap for scheduled weekly apply. */
const ROYAL_CARIBBEAN_MAX_WEEKLY_WRITES = ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING.max_total_proposed_changes;

module.exports = {
  ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING,
  ROYAL_CARIBBEAN_MAX_WEEKLY_WRITES,
  evaluateRoyalCaribbeanWeeklyHealth
};
