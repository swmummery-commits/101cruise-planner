/**
 * Seabourn conservative source-absence policy.
 *
 * A single healthy Solr enumeration miss must never trigger hide/expire/deactivation.
 * Action eligibility requires consecutive healthy absences across maintenance runs.
 */

const REQUIRED_CONSECUTIVE_HEALTHY_ABSENCES = 2;

/** Fraction of active official inventory absent before catch-up hard-stops (systemic). */
const CATCHUP_SYSTEMIC_ABSENCE_ACTIVE_RATIO = 0.1;

/** Minimum absent count with ratio threshold before systemic stop (avoids noise on tiny inventories). */
const CATCHUP_SYSTEMIC_ABSENCE_MIN_COUNT = 5;

function classifySeabournSourceAbsence({
  currentAbsentRows = [],
  previousAbsentSailingIds = [],
  enumerationHealthy = false
} = {}) {
  const previousSet = new Set((previousAbsentSailingIds || []).map(String));
  const observed = [];
  const actionable = [];
  const retained = [];

  for (const row of currentAbsentRows) {
    const sailingId = String(row.official_sailing_id || "").trim();
    if (!sailingId) continue;
    const consecutiveHealthyAbsences = previousSet.has(sailingId) ? 2 : 1;
    const classification =
      consecutiveHealthyAbsences >= REQUIRED_CONSECUTIVE_HEALTHY_ABSENCES
        ? "source_absent_actionable"
        : "source_absent_observed";
    const entry = {
      discovered_cruise_id: row.discovered_cruise_id || null,
      official_sailing_id: sailingId,
      departure_date: row.departure_date || null,
      consecutive_healthy_absences: consecutiveHealthyAbsences,
      classification,
      proposed_action: "retain_active",
      deactivation_allowed: false
    };
    retained.push(entry);
    if (classification === "source_absent_observed") observed.push(entry);
    if (classification === "source_absent_actionable") actionable.push(entry);
  }

  const cleared = [];
  for (const sailingId of previousSet) {
    if (!retained.some((row) => row.official_sailing_id === sailingId)) {
      cleared.push({ official_sailing_id: sailingId, classification: "source_absence_cleared" });
    }
  }

  const sourceAbsenceActionsAllowed =
    enumerationHealthy === true &&
    actionable.length > 0 &&
    actionable.every((row) => row.deactivation_allowed === true);

  return {
    policy: "consecutive_healthy_authoritative_absence",
    required_consecutive_healthy_absences: REQUIRED_CONSECUTIVE_HEALTHY_ABSENCES,
    enumeration_healthy: enumerationHealthy === true,
    source_absence_actions_allowed: sourceAbsenceActionsAllowed,
    source_absent_observed: observed.length,
    source_absent_actionable: actionable.length,
    source_absent_retained: retained.length,
    source_absence_cleared_count: cleared.length,
    source_absent_observed_records: observed,
    source_absent_actionable_records: actionable,
    source_absent_retained_records: retained,
    source_absence_cleared: cleared,
    note:
      "First healthy Solr absence is observed and retained active. Deactivation requires consecutive healthy authoritative absences and explicit maintenance policy."
  };
}

function extractPreviousAbsentSailingIds(previousRun) {
  const ids = previousRun?.stats?.source_absent_sailing_ids;
  return Array.isArray(ids) ? ids.map(String) : [];
}

function assessSeabournCatchUpSafety({
  sourceAbsencePolicy,
  activeProductionTotal = 0,
  sourceQualityGatePassed = true,
  reconciliationArithmeticOk = true,
  proposedUpdates = 0
} = {}) {
  const observed = Number(sourceAbsencePolicy?.source_absent_observed || 0);
  const actionable = Number(sourceAbsencePolicy?.source_absent_actionable || 0);
  const failures = [];

  if (!sourceQualityGatePassed) failures.push("source_quality_gate_failed");
  if (!reconciliationArithmeticOk) failures.push("reconciliation_arithmetic_failed");
  if (Number(proposedUpdates) > 0) failures.push("proposed_updates_gt_zero");
  if (actionable > 0) failures.push("source_absent_actionable_gt_zero");

  if (activeProductionTotal > 0 && observed > 0) {
    const ratio = observed / activeProductionTotal;
    if (observed >= CATCHUP_SYSTEMIC_ABSENCE_MIN_COUNT && ratio >= CATCHUP_SYSTEMIC_ABSENCE_ACTIVE_RATIO) {
      failures.push("systemic_source_absence_detected");
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    source_absent_observed: observed,
    source_absent_actionable: actionable,
    catch_up_permitted_with_observed_absence: observed > 0 && actionable === 0 && failures.length === 0
  };
}

module.exports = {
  REQUIRED_CONSECUTIVE_HEALTHY_ABSENCES,
  CATCHUP_SYSTEMIC_ABSENCE_ACTIVE_RATIO,
  CATCHUP_SYSTEMIC_ABSENCE_MIN_COUNT,
  classifySeabournSourceAbsence,
  extractPreviousAbsentSailingIds,
  assessSeabournCatchUpSafety
};
