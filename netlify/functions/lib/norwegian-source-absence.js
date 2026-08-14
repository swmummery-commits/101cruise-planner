/**
 * Norwegian Cruise Line — conservative source-absence policy.
 */

const REQUIRED_CONSECUTIVE_HEALTHY_ABSENCES = 2;

function classifyNorwegianSourceAbsence({
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
      discovered_cruise_id: row.discovered_cruise_id || row.id || null,
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
    hard_deletes_voyages: false
  };
}

function extractPreviousAbsentSailingIds(previousRun) {
  const ids = previousRun?.stats?.source_absent_sailing_ids;
  return Array.isArray(ids) ? ids.map(String) : [];
}

module.exports = {
  REQUIRED_CONSECUTIVE_HEALTHY_ABSENCES,
  classifyNorwegianSourceAbsence,
  extractPreviousAbsentSailingIds
};
