/**
 * Royal Caribbean conservative source-absence policy.
 *
 * A single healthy authoritative enumeration must never trigger hide/expire.
 * Action eligibility requires consecutive healthy absences across weekly runs.
 */

const REQUIRED_CONSECUTIVE_HEALTHY_ABSENCES = 2;

function classifyRoyalCaribbeanSourceAbsence({
  currentAbsentRows = [],
  previousAbsentSailingIds = [],
  enumerationHealthy = false
} = {}) {
  const previousSet = new Set((previousAbsentSailingIds || []).map(String));
  const candidates = [];
  const actionEligible = [];
  const firstObservation = [];
  const reappeared = [];

  for (const row of currentAbsentRows) {
    const sailingId = String(row.official_sailing_id || "").trim();
    if (!sailingId) continue;
    const consecutiveHealthyAbsences = previousSet.has(sailingId) ? 2 : 1;
    const entry = {
      discovered_cruise_id: row.discovered_cruise_id || null,
      official_sailing_id: sailingId,
      departure_date: row.departure_date || null,
      consecutive_healthy_absences: consecutiveHealthyAbsences,
      classification:
        consecutiveHealthyAbsences >= REQUIRED_CONSECUTIVE_HEALTHY_ABSENCES
          ? "source_absent_action_eligible"
          : "source_absent_candidate",
      proposed_action: "retain_active",
      hide_allowed: false
    };
    candidates.push(entry);
    if (entry.classification === "source_absent_candidate") firstObservation.push(entry);
    if (entry.classification === "source_absent_action_eligible") actionEligible.push(entry);
  }

  for (const sailingId of previousSet) {
    if (!candidates.some((row) => row.official_sailing_id === sailingId)) {
      reappeared.push({ official_sailing_id: sailingId, classification: "source_absence_cleared" });
    }
  }

  const sourceAbsenceActionsAllowed =
    enumerationHealthy === true &&
    actionEligible.length > 0 &&
    actionEligible.every((row) => row.hide_allowed === true);

  return {
    policy: "consecutive_healthy_authoritative_absence",
    required_consecutive_healthy_absences: REQUIRED_CONSECUTIVE_HEALTHY_ABSENCES,
    enumeration_healthy: enumerationHealthy === true,
    source_absence_actions_allowed: sourceAbsenceActionsAllowed,
    source_absent_candidate_count: firstObservation.length,
    source_absent_action_eligible_count: actionEligible.length,
    source_absence_cleared_count: reappeared.length,
    source_absent_candidates: firstObservation,
    source_absent_action_eligible: actionEligible,
    source_absence_cleared: reappeared,
    note:
      "First healthy absence retains active status. Hide/expire requires two consecutive healthy authoritative absences."
  };
}

function extractPreviousAbsentSailingIds(previousRun) {
  const ids = previousRun?.stats?.source_absent_sailing_ids;
  return Array.isArray(ids) ? ids.map(String) : [];
}

module.exports = {
  REQUIRED_CONSECUTIVE_HEALTHY_ABSENCES,
  classifyRoyalCaribbeanSourceAbsence,
  extractPreviousAbsentSailingIds
};
