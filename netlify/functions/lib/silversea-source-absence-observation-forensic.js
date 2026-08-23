/**
 * Silversea source-absence observation forensic chain evaluator (M7A).
 * Read-only. Reconstructs unresolved absence evidence from append-only events.
 */

const {
  EVENT_TYPE_ABSENCE_ADVANCED,
  EVENT_TYPE_SOURCE_RETURN_RESOLVED,
  buildEventStateReconciliation
} = require("./silversea-source-absence-observation-events");
const { QUARANTINE_THRESHOLD } = require("./silversea-source-absence-observation");

const FORENSIC_RESULT = Object.freeze({
  FORENSIC_CHAIN_COMPLETE: "FORENSIC_CHAIN_COMPLETE",
  FORENSIC_CHAIN_MISSING_EVENTS: "FORENSIC_CHAIN_MISSING_EVENTS",
  FORENSIC_CHAIN_COUNT_MISMATCH: "FORENSIC_CHAIN_COUNT_MISMATCH",
  FORENSIC_CHAIN_DUPLICATE_PERIOD: "FORENSIC_CHAIN_DUPLICATE_PERIOD",
  FORENSIC_CHAIN_DUPLICATE_SNAPSHOT: "FORENSIC_CHAIN_DUPLICATE_SNAPSHOT",
  FORENSIC_CHAIN_BROKEN_TRANSITION: "FORENSIC_CHAIN_BROKEN_TRANSITION",
  FORENSIC_CHAIN_IDENTITY_MISMATCH: "FORENSIC_CHAIN_IDENTITY_MISMATCH",
  FORENSIC_CHAIN_UNHEALTHY_EVENT: "FORENSIC_CHAIN_UNHEALTHY_EVENT",
  FORENSIC_CHAIN_RESOLUTION_MISMATCH: "FORENSIC_CHAIN_RESOLUTION_MISMATCH",
  FORENSIC_CHAIN_NOT_APPLICABLE: "FORENSIC_CHAIN_NOT_APPLICABLE"
});

function isHealthySourceHealth(value) {
  const v = String(value || "").trim().toUpperCase();
  return v === "HEALTHY" || v === "PASS";
}

function unresolvedAdvanceEvents(events, stateRow) {
  const sorted = [...(events || [])].sort((a, b) => {
    const ta = new Date(a.observed_at || a.created_at).getTime();
    const tb = new Date(b.observed_at || b.created_at).getTime();
    return ta - tb || String(a.id).localeCompare(String(b.id));
  });

  const resolveEvents = sorted.filter((e) => e.event_type === EVENT_TYPE_SOURCE_RETURN_RESOLVED);
  const lastResolve = resolveEvents.length ? resolveEvents[resolveEvents.length - 1] : null;
  const lastResolveAt = lastResolve ? new Date(lastResolve.observed_at || lastResolve.created_at).getTime() : null;

  return sorted.filter((e) => {
    if (e.event_type !== EVENT_TYPE_ABSENCE_ADVANCED) return false;
    if (lastResolveAt == null) return true;
    return new Date(e.observed_at || e.created_at).getTime() > lastResolveAt;
  });
}

function evaluateObservationForensicChain({ stateRow, events = [] }) {
  const reconciliation = buildEventStateReconciliation({ stateRow, events });
  const aggregateCount = stateRow?.consecutive_healthy_absence_count || 0;
  const status = stateRow?.status || null;

  if (!stateRow) {
    return {
      result: FORENSIC_RESULT.FORENSIC_CHAIN_NOT_APPLICABLE,
      pass: false,
      aggregate_count: 0,
      derived_count: 0,
      qualifying_advance_events: 0,
      three_week_forensic_ready: false,
      quarantine_action_ready: false,
      reconciliation,
      issues: ["no_state_row"]
    };
  }

  if (status === "RESOLVED" && aggregateCount === 0) {
    const chain = unresolvedAdvanceEvents(events, stateRow);
    return {
      result: chain.length
        ? FORENSIC_RESULT.FORENSIC_CHAIN_COMPLETE
        : FORENSIC_RESULT.FORENSIC_CHAIN_NOT_APPLICABLE,
      pass: chain.length === 0,
      aggregate_count: 0,
      derived_count: 0,
      qualifying_advance_events: chain.length,
      three_week_forensic_ready: false,
      quarantine_action_ready: false,
      reconciliation,
      issues: chain.length ? [] : ["resolved_without_unresolved_chain"]
    };
  }

  const chain = unresolvedAdvanceEvents(events, stateRow);
  const issues = [];

  for (const event of events) {
    if (stateRow.id && event.state_id && event.state_id !== stateRow.id) {
      issues.push("FORENSIC_CHAIN_IDENTITY_MISMATCH");
    }
    if (
      event.cruise_line_id &&
      stateRow.cruise_line_id &&
      event.cruise_line_id !== stateRow.cruise_line_id
    ) {
      issues.push("FORENSIC_CHAIN_IDENTITY_MISMATCH");
    }
    if (
      event.official_sailing_id &&
      stateRow.official_sailing_id &&
      String(event.official_sailing_id).toUpperCase() !== String(stateRow.official_sailing_id).toUpperCase()
    ) {
      issues.push("FORENSIC_CHAIN_IDENTITY_MISMATCH");
    }
  }

  if (aggregateCount === 0 && chain.length === 0) {
    return {
      result: FORENSIC_RESULT.FORENSIC_CHAIN_NOT_APPLICABLE,
      pass: true,
      aggregate_count: 0,
      derived_count: 0,
      qualifying_advance_events: 0,
      three_week_forensic_ready: false,
      quarantine_action_ready: false,
      reconciliation,
      issues: []
    };
  }

  if (aggregateCount > 0 && chain.length === 0) {
    return {
      result: FORENSIC_RESULT.FORENSIC_CHAIN_MISSING_EVENTS,
      pass: false,
      aggregate_count: aggregateCount,
      derived_count: 0,
      qualifying_advance_events: 0,
      three_week_forensic_ready: false,
      quarantine_action_ready: false,
      reconciliation,
      issues: ["missing_advance_events"]
    };
  }

  const periods = new Set();
  const snapshots = new Set();
  let expectedPrior = 0;

  for (const event of chain) {
    if (event.event_type !== EVENT_TYPE_ABSENCE_ADVANCED) continue;

    if (event.source_present !== false) {
      issues.push("FORENSIC_CHAIN_UNHEALTHY_EVENT");
    }
    if (!isHealthySourceHealth(event.source_health)) {
      issues.push("FORENSIC_CHAIN_UNHEALTHY_EVENT");
    }
    if (!event.observation_period_key) {
      issues.push("FORENSIC_CHAIN_BROKEN_TRANSITION");
    }
    if (!event.source_snapshot_hash) {
      issues.push("FORENSIC_CHAIN_BROKEN_TRANSITION");
    }

    if (event.observation_period_key) {
      if (periods.has(event.observation_period_key)) issues.push("FORENSIC_CHAIN_DUPLICATE_PERIOD");
      periods.add(event.observation_period_key);
    }
    if (event.source_snapshot_hash) {
      if (snapshots.has(event.source_snapshot_hash)) issues.push("FORENSIC_CHAIN_DUPLICATE_SNAPSHOT");
      snapshots.add(event.source_snapshot_hash);
    }

    if (event.previous_count !== expectedPrior || event.new_count !== expectedPrior + 1) {
      issues.push("FORENSIC_CHAIN_BROKEN_TRANSITION");
    }
    expectedPrior = event.new_count;
  }

  const derivedCount = chain.length ? chain[chain.length - 1].new_count : 0;
  if (derivedCount !== aggregateCount) {
    issues.push("FORENSIC_CHAIN_COUNT_MISMATCH");
  }

  const resolveEvents = (events || []).filter((e) => e.event_type === EVENT_TYPE_SOURCE_RETURN_RESOLVED);
  for (const resolve of resolveEvents) {
    if (resolve.new_count !== 0) issues.push("FORENSIC_CHAIN_RESOLUTION_MISMATCH");
    if (resolve.previous_count < 1) issues.push("FORENSIC_CHAIN_RESOLUTION_MISMATCH");
  }

  const uniqueIssues = [...new Set(issues)];
  let result = FORENSIC_RESULT.FORENSIC_CHAIN_COMPLETE;
  if (uniqueIssues.includes("FORENSIC_CHAIN_MISSING_EVENTS") || chain.length < aggregateCount) {
    result = FORENSIC_RESULT.FORENSIC_CHAIN_MISSING_EVENTS;
  } else if (uniqueIssues.includes("FORENSIC_CHAIN_IDENTITY_MISMATCH")) {
    result = FORENSIC_RESULT.FORENSIC_CHAIN_IDENTITY_MISMATCH;
  } else if (uniqueIssues.includes("FORENSIC_CHAIN_DUPLICATE_PERIOD")) {
    result = FORENSIC_RESULT.FORENSIC_CHAIN_DUPLICATE_PERIOD;
  } else if (uniqueIssues.includes("FORENSIC_CHAIN_DUPLICATE_SNAPSHOT")) {
    result = FORENSIC_RESULT.FORENSIC_CHAIN_DUPLICATE_SNAPSHOT;
  } else if (uniqueIssues.includes("FORENSIC_CHAIN_BROKEN_TRANSITION")) {
    result = FORENSIC_RESULT.FORENSIC_CHAIN_BROKEN_TRANSITION;
  } else if (uniqueIssues.includes("FORENSIC_CHAIN_UNHEALTHY_EVENT")) {
    result = FORENSIC_RESULT.FORENSIC_CHAIN_UNHEALTHY_EVENT;
  } else if (uniqueIssues.includes("FORENSIC_CHAIN_COUNT_MISMATCH")) {
    result = FORENSIC_RESULT.FORENSIC_CHAIN_COUNT_MISMATCH;
  } else if (uniqueIssues.includes("FORENSIC_CHAIN_RESOLUTION_MISMATCH")) {
    result = FORENSIC_RESULT.FORENSIC_CHAIN_RESOLUTION_MISMATCH;
  }

  const pass = result === FORENSIC_RESULT.FORENSIC_CHAIN_COMPLETE && derivedCount === aggregateCount;
  const threeWeekReady =
    pass &&
    aggregateCount >= QUARANTINE_THRESHOLD &&
    chain.length >= QUARANTINE_THRESHOLD &&
    periods.size >= QUARANTINE_THRESHOLD;

  return {
    result,
    pass,
    aggregate_count: aggregateCount,
    derived_count: derivedCount,
    qualifying_advance_events: chain.length,
    distinct_periods: periods.size,
    distinct_snapshots: snapshots.size,
    three_week_forensic_ready: threeWeekReady,
    quarantine_action_ready: false,
    threshold_reached: aggregateCount >= QUARANTINE_THRESHOLD,
    forensic_chain_complete: pass,
    reconciliation,
    issues: uniqueIssues,
    unresolved_chain: chain
  };
}

function assessQuarantineReadiness({ stateRow, events, sourceHealthy, sourceStillAbsent }) {
  const forensic = evaluateObservationForensicChain({ stateRow, events });
  const thresholdReached = (stateRow?.consecutive_healthy_absence_count || 0) >= QUARANTINE_THRESHOLD;

  return {
    threshold_reached: thresholdReached,
    forensic_chain_complete: forensic.forensic_chain_complete,
    three_week_forensic_ready: forensic.three_week_forensic_ready,
    quarantine_review_proposable: thresholdReached,
    quarantine_action_ready:
      thresholdReached &&
      forensic.forensic_chain_complete &&
      forensic.three_week_forensic_ready &&
      sourceHealthy === true &&
      sourceStillAbsent === true,
    forensic,
    quarantine_hide_execution_authorised: false
  };
}

module.exports = {
  FORENSIC_RESULT,
  evaluateObservationForensicChain,
  assessQuarantineReadiness,
  unresolvedAdvanceEvents,
  isHealthySourceHealth
};
