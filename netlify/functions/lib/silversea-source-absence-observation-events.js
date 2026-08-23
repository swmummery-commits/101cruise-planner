/**
 * Silversea source-absence observation event history — constants and load helpers (M7A).
 */

const OBSERVATION_EVENT_TABLE = "cruise_source_observation_events";

const EVENT_TYPE_ABSENCE_ADVANCED = "ABSENCE_ADVANCED";
const EVENT_TYPE_SOURCE_RETURN_RESOLVED = "SOURCE_RETURN_RESOLVED";

const RECORD_ORIGIN_LIVE = "LIVE";
const RECORD_ORIGIN_HISTORICAL_BACKFILL = "HISTORICAL_BACKFILL";

async function loadObservationEventsForState(supabase, stateId, options = {}) {
  const limit = options.limit || 500;
  try {
    return (
      (await supabase(
        `${OBSERVATION_EVENT_TABLE}?state_id=eq.${encodeURIComponent(stateId)}&select=*&order=observed_at.asc,created_at.asc&limit=${limit}`
      )) || []
    );
  } catch (err) {
    if (err?.statusCode === 404 || /could not find the table/i.test(String(err?.message || ""))) {
      return null;
    }
    throw err;
  }
}

async function loadObservationEventsByOfficialId(supabase, { cruiseLineId, officialSailingId, observationType = "SOURCE_ABSENT" }) {
  try {
    return (
      (await supabase(
        `${OBSERVATION_EVENT_TABLE}?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&official_sailing_id=eq.${encodeURIComponent(
          String(officialSailingId).toUpperCase()
        )}&observation_type=eq.${encodeURIComponent(observationType)}&select=*&order=observed_at.asc,created_at.asc&limit=500`
      )) || []
    );
  } catch (err) {
    if (err?.statusCode === 404 || /could not find the table/i.test(String(err?.message || ""))) {
      return null;
    }
    throw err;
  }
}

async function loadAllSilverseaObservationEvents(supabase, cruiseLineId) {
  const rows = [];
  let offset = 0;
  const pageSize = 500;
  while (true) {
    let batch;
    try {
      batch =
        (await supabase(
          `${OBSERVATION_EVENT_TABLE}?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&select=*&order=official_sailing_id.asc,observed_at.asc&offset=${offset}&limit=${pageSize}`
        )) || [];
    } catch (err) {
      if (err?.statusCode === 404 || /could not find the table/i.test(String(err?.message || ""))) {
        return null;
      }
      throw err;
    }
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function buildEventStateReconciliation({ stateRow, events = [] }) {
  const aggregateCount = stateRow?.consecutive_healthy_absence_count || 0;
  const status = stateRow?.status || null;
  const advanceEvents = (events || []).filter((e) => e.event_type === EVENT_TYPE_ABSENCE_ADVANCED);
  const resolveEvents = (events || []).filter((e) => e.event_type === EVENT_TYPE_SOURCE_RETURN_RESOLVED);

  const lastResolve = resolveEvents.length ? resolveEvents[resolveEvents.length - 1] : null;
  const lastResolveAt = lastResolve?.observed_at || null;
  const unresolvedAdvances = lastResolveAt
    ? advanceEvents.filter((e) => e.observed_at > lastResolveAt)
    : advanceEvents;

  const derivedCount = unresolvedAdvances.length
    ? unresolvedAdvances[unresolvedAdvances.length - 1].new_count
    : status === "RESOLVED" ? 0 : 0;

  return {
    state_id: stateRow?.id || null,
    official_sailing_id: stateRow?.official_sailing_id || null,
    aggregate_count: aggregateCount,
    derived_unresolved_count: derivedCount,
    event_count: events.length,
    advance_event_count: advanceEvents.length,
    resolve_event_count: resolveEvents.length,
    unresolved_advance_event_count: unresolvedAdvances.length,
    latest_event: events.length ? events[events.length - 1] : null,
    count_matches_events: aggregateCount === derivedCount
  };
}

module.exports = {
  OBSERVATION_EVENT_TABLE,
  EVENT_TYPE_ABSENCE_ADVANCED,
  EVENT_TYPE_SOURCE_RETURN_RESOLVED,
  RECORD_ORIGIN_LIVE,
  RECORD_ORIGIN_HISTORICAL_BACKFILL,
  loadObservationEventsForState,
  loadObservationEventsByOfficialId,
  loadAllSilverseaObservationEvents,
  buildEventStateReconciliation
};
