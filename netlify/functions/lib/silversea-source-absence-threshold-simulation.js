/**
 * Silversea M5 — pure source-absence threshold / quarantine-proposal simulation.
 * No database writes. No RPC mutation side effects.
 */

const {
  OBSERVATION_STATUS_OBSERVING,
  OBSERVATION_STATUS_RESOLVED,
  OBSERVATION_TYPE_SOURCE_ABSENT,
  QUARANTINE_THRESHOLD,
  computeExpectedAdvancement,
  deriveQuarantineProposal,
  classifyCutoffSeparate,
  classifySourceAbsenceCandidate
} = require("./silversea-source-absence-observation");
const { MAINTENANCE_CLASSIFICATION } = require("./silversea-weekly-maintenance-policy");

const BUSINESS_ACTION_NONE = "NONE";
const BUSINESS_ACTION_QUARANTINE_REVIEW_REQUIRED = "QUARANTINE_REVIEW_REQUIRED";

/** Future quarantine execution preconditions (design only — M5 does not mutate). */
const QUARANTINE_ACTION_PRECONDITIONS = Object.freeze([
  "durable_count_gte_3",
  "three_distinct_healthy_weekly_periods_proven",
  "fresh_healthy_source_immediately_before_action",
  "sailing_still_source_absent",
  "official_identity_unique",
  "production_row_exists",
  "not_already_expired_or_hidden",
  "cutoff_does_not_make_quarantine_redundant",
  "source_population_health_normal",
  "special_product_context_reviewed",
  "exact_target_frozen",
  "global_cruise_lock_held",
  "reversible_action_only",
  "no_physical_delete",
  "controlled_production_lifecycle",
  "exact_rollback_manifest",
  "under_lock_verification"
]);

/** Recommended future quarantine semantic (no mutation in M5). */
const RECOMMENDED_QUARANTINE_SEMANTIC = Object.freeze({
  action: "status_hidden_or_review_queue",
  preferred: "reversible_hidden_status_with_source_absence_review_marker",
  avoid: ["physical_delete", "automatic_hide_without_review", "duplicate_cutoff_expiry"],
  rationale:
    "Source-absence quarantine should be a reversible review state separate from 21-day cutoff expiry; never delete rows."
});

const PROPOSED_EVENT_HISTORY_SCHEMA = Object.freeze({
  table: "cruise_source_observation_events",
  fields: [
    "id",
    "state_id",
    "cruise_line_id",
    "official_sailing_id",
    "observation_type",
    "event_type",
    "observed_at",
    "observation_period_key",
    "source_snapshot_hash",
    "source_health",
    "run_id",
    "previous_count",
    "new_count",
    "reason",
    "metadata"
  ],
  purpose: "Append-only forensic evidence for each qualifying weekly observation before any quarantine mutation."
});

function cloneObservationState(state) {
  if (!state) return null;
  return JSON.parse(JSON.stringify(state));
}

function applyAdvancementToState(existingState, advancement, { observationPeriodKey, sourceSnapshotHash, sourceHealth, runId }) {
  const now = existingState?.last_observed_at || new Date().toISOString();
  if (!existingState) {
    return {
      observation_type: OBSERVATION_TYPE_SOURCE_ABSENT,
      status: OBSERVATION_STATUS_OBSERVING,
      consecutive_healthy_absence_count: advancement.new_count,
      first_observed_at: now,
      last_observed_at: now,
      last_observation_period_key: observationPeriodKey,
      last_counted_snapshot_hash: sourceSnapshotHash,
      last_source_health: sourceHealth,
      last_run_id: runId,
      resolved_at: null
    };
  }

  if (advancement.write_action === "none") {
    return cloneObservationState(existingState);
  }

  const next = cloneObservationState(existingState);
  next.status = OBSERVATION_STATUS_OBSERVING;
  next.consecutive_healthy_absence_count = advancement.new_count;
  next.last_observed_at = now;
  next.last_observation_period_key = observationPeriodKey;
  next.last_counted_snapshot_hash = sourceSnapshotHash;
  next.last_source_health = sourceHealth;
  next.last_run_id = runId;
  next.resolved_at = null;
  if (!next.first_observed_at) next.first_observed_at = now;
  return next;
}

/**
 * Pure simulation step for one healthy-source-absence observation window.
 * Does not mutate production. Returns simulated next state when advanced.
 */
function simulateSourceAbsenceObservationStep({
  existingState = null,
  sourceHealthy = true,
  sourcePresent = false,
  sourceSnapshotHash,
  observationPeriodKey,
  runId = "simulation",
  sourceHealth = "healthy"
}) {
  if (sourcePresent) {
    return {
      ok: false,
      advanced: false,
      reason: "source_present_not_absent",
      prior_count: existingState?.consecutive_healthy_absence_count || 0,
      new_count: existingState?.consecutive_healthy_absence_count || 0,
      next_state: cloneObservationState(existingState),
      quarantine: deriveQuarantineProposal(existingState?.consecutive_healthy_absence_count || 0),
      business_action: BUSINESS_ACTION_NONE,
      cruise_mutations: 0
    };
  }

  const advancement = computeExpectedAdvancement({
    existingState,
    sourceSnapshotHash,
    observationPeriodKey,
    sourceHealthy
  });

  const priorCount = advancement.prior_count ?? existingState?.consecutive_healthy_absence_count ?? 0;
  const newCount = advancement.new_count ?? priorCount;
  const quarantine = deriveQuarantineProposal(newCount);
  const advanced = advancement.write_action !== "none" && newCount > priorCount;

  let nextState = cloneObservationState(existingState);
  if (advanced) {
    nextState = applyAdvancementToState(existingState, advancement, {
      observationPeriodKey,
      sourceSnapshotHash,
      sourceHealth,
      runId
    });
  }

  const businessAction =
    quarantine.eligible && quarantine.proposal === "QUARANTINE_REVIEW_REQUIRED"
      ? BUSINESS_ACTION_QUARANTINE_REVIEW_REQUIRED
      : BUSINESS_ACTION_NONE;

  return {
    ok: advancement.ok !== false,
    advanced,
    reason: advancement.reason || (advanced ? "count_advanced" : "no_advancement"),
    prior_count: priorCount,
    new_count: newCount,
    write_action: advancement.write_action,
    idempotent: advancement.idempotent === true,
    next_state: nextState,
    quarantine,
    business_action: businessAction,
    cruise_mutations: 0,
    quarantine_executed: false
  };
}

/** Pure source-return resolution (no RPC). */
function simulateSourceReturn({ existingState, runId = "simulation-return" }) {
  if (!existingState) {
    return {
      ok: false,
      reason: "no_observation_state",
      next_state: null,
      quarantine: deriveQuarantineProposal(0),
      business_action: BUSINESS_ACTION_NONE,
      proposal_cancelled: false
    };
  }

  const hadProposal = deriveQuarantineProposal(existingState.consecutive_healthy_absence_count || 0).eligible;

  const next = cloneObservationState(existingState);
  next.status = OBSERVATION_STATUS_RESOLVED;
  next.consecutive_healthy_absence_count = 0;
  next.resolved_at = new Date().toISOString();
  next.last_run_id = runId;

  return {
    ok: true,
    reason: "source_return_resolved",
    prior_count: existingState.consecutive_healthy_absence_count || 0,
    new_count: 0,
    next_state: next,
    quarantine: deriveQuarantineProposal(0),
    business_action: BUSINESS_ACTION_NONE,
    proposal_cancelled: hadProposal,
    cruise_mutations: 0
  };
}

function buildQuarantineReviewProposal({
  officialSailingId,
  productionUuid,
  cruiseLineId,
  productionRow,
  observationState,
  qualifyingPeriods = [],
  qualifyingSnapshotHashes = [],
  sourceHealth = "PASS",
  secondaryProductContext = null,
  cutoff = null
}) {
  const count = observationState?.consecutive_healthy_absence_count || 0;
  const quarantine = deriveQuarantineProposal(count);
  if (!quarantine.eligible) return null;

  return {
    official_sailing_id: officialSailingId,
    production_uuid: productionUuid,
    cruise_line_id: cruiseLineId,
    current_cruise_status: productionRow?.status || null,
    departure_date: productionRow?.departure_date || null,
    cutoff_state: cutoff,
    first_absence_observed: observationState?.first_observed_at || null,
    latest_absence_observed: observationState?.last_observed_at || null,
    consecutive_healthy_absence_count: count,
    qualifying_observation_periods: qualifyingPeriods,
    qualifying_snapshot_hashes: qualifyingSnapshotHashes,
    current_source_health: sourceHealth,
    secondary_product_context: secondaryProductContext,
    special_historical_product_review_context:
      secondaryProductContext === "historical_combination_metadata_present" ? true : false,
    reason_code: "source_absent_threshold_reached",
    proposed_action: "QUARANTINE_REVIEW_REQUIRED",
    proposed_action_not: ["HIDE_NOW", "DELETE", "AUTO_HIDE", "AUTO_EXPIRE"],
    execute: false
  };
}

function shouldProposeQuarantineForExpiredRow(productionRow, today) {
  const cutoff = classifyCutoffSeparate(productionRow, today);
  if (String(productionRow?.status || "").trim() === "expired") {
    return { propose: false, reason: "already_expired" };
  }
  if (cutoff.within_cutoff || cutoff.within_21_day_cutoff) {
    return { propose: false, reason: "cutoff_lifecycle_authoritative" };
  }
  return { propose: true, reason: "eligible_for_review_if_threshold_met" };
}

function cutoffTakesPrecedenceOverAbsenceQuarantine({ cutoff, quarantineEligible }) {
  if (!quarantineEligible) return { precedence: "none", suppress_quarantine_action: false };
  if (cutoff?.within_cutoff || cutoff?.within_21_day_cutoff) {
    return {
      precedence: "cutoff_lifecycle",
      suppress_quarantine_action: true,
      reason: "daily_expiry_handles_public_lifecycle"
    };
  }
  if (String(cutoff?.lifecycle_status || "").trim() === "expired") {
    return {
      precedence: "expired_status",
      suppress_quarantine_action: true,
      reason: "row_already_expired"
    };
  }
  return { precedence: "absence_threshold", suppress_quarantine_action: false };
}

/**
 * Current single-row state cannot independently prove three distinct weekly observations.
 * Only latest period/hash are retained; count alone is insufficient forensic evidence.
 */
function assessThreeObservationForensicAuditability({ observationStateModel = "single_row_current_state" } = {}) {
  if (observationStateModel !== "single_row_current_state") {
    return { pass: true, append_only_events_required: false };
  }
  return {
    pass: false,
    append_only_events_required: true,
    reason:
      "cruise_source_observation_state stores only latest period/hash and aggregate count; cannot independently prove each of three qualifying weekly observations occurred.",
    recommended_schema: PROPOSED_EVENT_HISTORY_SCHEMA,
    block_real_quarantine_mutation_until: "append_only_observation_events_proven"
  };
}

function runThresholdSequenceSimulation({
  startingState,
  steps = [],
  productionRow = null,
  today = "2026-08-23",
  secondaryProductContext = null
}) {
  let state = cloneObservationState(startingState);
  const trace = [];

  for (const step of steps) {
    let result;
    if (step.type === "return") {
      result = simulateSourceReturn({ existingState: state, runId: step.runId });
    } else {
      result = simulateSourceAbsenceObservationStep({
        existingState: state,
        sourceHealthy: step.sourceHealthy !== false,
        sourcePresent: step.sourcePresent === true,
        sourceSnapshotHash: step.sourceSnapshotHash,
        observationPeriodKey: step.observationPeriodKey,
        runId: step.runId || "simulation",
        sourceHealth: step.sourceHealth || "healthy"
      });
    }
    if (result.next_state) state = result.next_state;
    trace.push({ step, result });
  }

  const cutoff = productionRow ? classifyCutoffSeparate(productionRow, today) : null;
  const proposal =
    state && productionRow
      ? buildQuarantineReviewProposal({
          officialSailingId: productionRow.official_sailing_id,
          productionUuid: productionRow.id,
          cruiseLineId: productionRow.cruise_line_id,
          productionRow,
          observationState: state,
          qualifyingPeriods: steps.filter((s) => s.type !== "return").map((s) => s.observationPeriodKey),
          qualifyingSnapshotHashes: steps.filter((s) => s.type !== "return").map((s) => s.sourceSnapshotHash),
          secondaryProductContext,
          cutoff
        })
      : null;

  return {
    final_state: state,
    trace,
    quarantine_proposal: proposal,
    forensic: assessThreeObservationForensicAuditability()
  };
}

module.exports = {
  BUSINESS_ACTION_NONE,
  BUSINESS_ACTION_QUARANTINE_REVIEW_REQUIRED,
  QUARANTINE_ACTION_PRECONDITIONS,
  RECOMMENDED_QUARANTINE_SEMANTIC,
  PROPOSED_EVENT_HISTORY_SCHEMA,
  cloneObservationState,
  simulateSourceAbsenceObservationStep,
  simulateSourceReturn,
  buildQuarantineReviewProposal,
  shouldProposeQuarantineForExpiredRow,
  cutoffTakesPrecedenceOverAbsenceQuarantine,
  assessThreeObservationForensicAuditability,
  runThresholdSequenceSimulation,
  classifySourceAbsenceCandidate
};
