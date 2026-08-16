/**
 * Disney Cruise Line — conservative source-absence policy.
 *
 * Two consecutive complete PAVAS absences required before lifecycle action.
 * 14-day confirmation window — stale first observations reset the streak.
 */

const REQUIRED_CONSECUTIVE_COMPLETE_ABSENCES = 2;
const CONFIRMATION_WINDOW_DAYS = 14;

function daysBetween(isoA, isoB) {
  const a = new Date(isoA);
  const b = new Date(isoB);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.floor(Math.abs(b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function extractPreviousObservationMap(previousRun) {
  const map = previousRun?.stats?.source_absence_observations;
  if (map && typeof map === "object" && !Array.isArray(map)) return { ...map };
  const ids = previousRun?.stats?.source_absent_sailing_ids;
  if (!Array.isArray(ids)) return {};
  const observedAt = previousRun?.stats?.finished_at || previousRun?.finished_at || null;
  const out = {};
  for (const id of ids) {
    out[String(id)] = {
      first_observed_at: observedAt,
      last_observed_at: observedAt,
      consecutive_complete_absences: 1
    };
  }
  return out;
}

function classifyDisneySourceAbsence({
  currentAbsentRows = [],
  previousObservationBySailingId = {},
  enumerationHealthy = false,
  sourceComplete = false,
  deactivationEnabled = false,
  now = new Date()
} = {}) {
  const nowIso = now instanceof Date ? now.toISOString() : String(now);
  const previousMap = previousObservationBySailingId || {};
  const observed = [];
  const confirmed = [];
  const retained = [];
  const observations = {};

  for (const row of currentAbsentRows) {
    const sailingId = String(row.official_sailing_id || "").trim();
    if (!sailingId) continue;

    const prev = previousMap[sailingId] || null;
    let consecutive = 1;
    let firstObservedAt = nowIso;
    let classification = "source_absent_observed";
    let deactivationAllowed = false;

    if (prev?.first_observed_at) {
      const elapsed = daysBetween(prev.first_observed_at, nowIso);
      if (elapsed != null && elapsed <= CONFIRMATION_WINDOW_DAYS) {
        consecutive = Math.min(
          REQUIRED_CONSECUTIVE_COMPLETE_ABSENCES,
          Number(prev.consecutive_complete_absences || 1) + 1
        );
        firstObservedAt = prev.first_observed_at;
        if (consecutive >= REQUIRED_CONSECUTIVE_COMPLETE_ABSENCES) {
          classification = "source_absent_confirmed";
          deactivationAllowed = deactivationEnabled === true;
        }
      }
    }

    const entry = {
      discovered_cruise_id: row.discovered_cruise_id || row.id || null,
      official_sailing_id: sailingId,
      departure_date: row.departure_date || null,
      consecutive_complete_absences: consecutive,
      first_observed_at: firstObservedAt,
      last_observed_at: nowIso,
      classification,
      proposed_action: classification === "source_absent_confirmed" ? "source_absence_lifecycle" : "retain_active",
      deactivation_allowed: deactivationAllowed,
      hard_delete: false,
      cancellation_inferred: false
    };

    observations[sailingId] = {
      first_observed_at: firstObservedAt,
      last_observed_at: nowIso,
      consecutive_complete_absences: consecutive,
      classification
    };

    retained.push(entry);
    if (classification === "source_absent_observed") observed.push(entry);
    if (classification === "source_absent_confirmed") confirmed.push(entry);
  }

  const cleared = [];
  for (const sailingId of Object.keys(previousMap)) {
    if (!observations[sailingId]) {
      cleared.push({ official_sailing_id: sailingId, classification: "source_absence_cleared" });
    }
  }

  const sourceAbsenceActionsAllowed =
    enumerationHealthy === true &&
    sourceComplete === true &&
    confirmed.length > 0 &&
    confirmed.every((row) => row.deactivation_allowed === true);

  return {
    policy: "consecutive_complete_pavas_absence",
    required_consecutive_complete_absences: REQUIRED_CONSECUTIVE_COMPLETE_ABSENCES,
    confirmation_window_days: CONFIRMATION_WINDOW_DAYS,
    enumeration_healthy: enumerationHealthy === true,
    source_complete: sourceComplete === true,
    source_absence_actions_allowed: sourceAbsenceActionsAllowed,
    source_absent_observed: observed.length,
    source_absent_confirmed: confirmed.length,
    source_absent_retained: retained.length,
    source_absence_cleared_count: cleared.length,
    source_absent_observed_records: observed,
    source_absent_confirmed_records: confirmed,
    source_absent_retained_records: retained,
    source_absence_cleared: cleared,
    source_absence_observations: observations,
    legacy_excluded: true,
    hard_deletes_voyages: false,
    cancellation_inferred_from_absence: false,
    note:
      "First complete PAVAS absence is observed and retained active. Confirmed absence requires two consecutive complete snapshots within the confirmation window."
  };
}

function extractPreviousAbsentSailingIds(previousRun) {
  const ids = previousRun?.stats?.source_absent_sailing_ids;
  return Array.isArray(ids) ? ids.map(String) : [];
}

module.exports = {
  REQUIRED_CONSECUTIVE_COMPLETE_ABSENCES,
  CONFIRMATION_WINDOW_DAYS,
  classifyDisneySourceAbsence,
  extractPreviousObservationMap,
  extractPreviousAbsentSailingIds
};
