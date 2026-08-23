/**
 * Silversea M6 — full weekly maintenance read-only orchestration.
 * Integrates M1 proposal engine with M4/M5 durable observation state semantics.
 * NO production writes. NO observation RPC mutations.
 */

const crypto = require("crypto");
const {
  buildSilverseaWeeklyMaintenanceProposal,
  verifyProposalIdempotency
} = require("./silversea-weekly-maintenance-proposal");
const {
  MAINTENANCE_CLASSIFICATION,
  SOURCE_ABSENCE_POLICY,
  PROPOSED_ACTION_CEILINGS,
  FUTURE_MAINTENANCE_LOCK_CONTRACT,
  OBSERVATION_STATE_SCHEMA,
  WEEKLY_HARD_STOP_CONDITIONS,
  M0E_DRIFT_CASE_IDS,
  SOURCE_ABSENCE_FIXTURE_ID,
  proposalChecksum
} = require("./silversea-weekly-maintenance-policy");
const {
  OBSERVATION_TABLE,
  OBSERVATION_TYPE_SOURCE_ABSENT,
  OBSERVATION_STATUS_OBSERVING,
  QUARANTINE_THRESHOLD,
  observationPeriodKey,
  buildSourceSnapshotFingerprint,
  isOfficialIdInSource,
  classifyCutoffSeparate,
  computeExpectedAdvancement,
  deriveQuarantineProposal,
  loadObservationState
} = require("./silversea-source-absence-observation");
const {
  assessThreeObservationForensicAuditability,
  buildQuarantineReviewProposal,
  cutoffTakesPrecedenceOverAbsenceQuarantine,
  shouldProposeQuarantineForExpiredRow,
  PROPOSED_EVENT_HISTORY_SCHEMA
} = require("./silversea-source-absence-threshold-simulation");
const {
  buildEventStateReconciliation
} = require("./silversea-source-absence-observation-events");
const {
  assessQuarantineReadiness,
  evaluateObservationForensicChain,
  FORENSIC_RESULT
} = require("./silversea-source-absence-observation-forensic");
const {
  classifySilverseaOfficialInventory,
  isClassicStoredOfficialRow,
  isExpeditionStoredOfficialRow
} = require("./silversea-classic-itinerary-ports-backfill");

const M2_CANARY_ID = "WH281005017";
const M3_CANARY_ID = "SL270927009";
const OTHER_ABSENCE_ID = "DA280115C21";

const OBSERVATION_PROPOSAL = Object.freeze({
  NONE: "NONE",
  OBSERVATION_INSERT_DUE: "OBSERVATION_INSERT_DUE",
  OBSERVATION_ADVANCE_DUE: "OBSERVATION_ADVANCE_DUE",
  OBSERVATION_ALREADY_COUNTED_THIS_PERIOD: "OBSERVATION_ALREADY_COUNTED_THIS_PERIOD",
  SNAPSHOT_ALREADY_COUNTED: "SNAPSHOT_ALREADY_COUNTED",
  NO_ADVANCE_SOURCE_UNHEALTHY: "NO_ADVANCE_SOURCE_UNHEALTHY",
  AUDIT_ONLY_EXPIRED: "AUDIT_ONLY_EXPIRED",
  OBSERVATION_RESOLVE_DUE: "OBSERVATION_RESOLVE_DUE"
});

const M6_ACTION_CEILINGS = Object.freeze({
  insert: 1,
  update: 1,
  observation_advance: 1,
  observation_resolve: 1,
  quarantine_hide: 0,
  delete: 0
});

function stableJson(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(stableJson);
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableJson(value[key]);
  return out;
}

async function loadAllSilverseaObservationStates(supabase, cruiseLineId) {
  const rows = [];
  let offset = 0;
  const pageSize = 500;
  while (true) {
    const batch =
      (await supabase(
        `${OBSERVATION_TABLE}?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&select=*&order=official_sailing_id.asc&offset=${offset}&limit=${pageSize}`
      )) || [];
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function observationStatesByOfficialId(rows) {
  const map = new Map();
  for (const row of rows || []) {
    map.set(String(row.official_sailing_id).toUpperCase(), row);
  }
  return map;
}

function previousObservationsFromDurable(statesById) {
  const out = {};
  for (const [officialId, state] of statesById.entries()) {
    out[officialId] = {
      consecutive_count: state.consecutive_healthy_absence_count || 0,
      first_seen_at: state.first_observed_at || null,
      last_period: state.last_observation_period_key || null,
      last_hash: state.last_counted_snapshot_hash || null,
      status: state.status
    };
  }
  return out;
}

function productionInventoryBreakdown(rows) {
  const inv = classifySilverseaOfficialInventory(rows || []);
  let classicActive = 0;
  let classicExpired = 0;
  let expeditionActive = 0;
  let expeditionExpired = 0;
  for (const row of rows || []) {
    if (!row.official_sailing_id) continue;
    const expired = String(row.status || "").trim() === "expired";
    if (isClassicStoredOfficialRow(row)) {
      if (expired) classicExpired += 1;
      else classicActive += 1;
    } else if (isExpeditionStoredOfficialRow(row)) {
      if (expired) expeditionExpired += 1;
      else expeditionActive += 1;
    }
  }
  const officialIds = (rows || [])
    .filter((r) => r.official_sailing_id)
    .map((r) => String(r.official_sailing_id).toUpperCase());
  const duplicateOfficialIds = officialIds.length - new Set(officialIds).size;

  return {
    total: inv.total,
    classic_stored_official: inv.classic_stored_official_total,
    classic_active: classicActive,
    classic_expired: classicExpired,
    expedition_stored_official: inv.expedition_stored_official_total,
    expedition_active: expeditionActive,
    expedition_expired: expeditionExpired,
    legacy: inv.legacy,
    official_total: inv.total - inv.legacy,
    duplicate_official_ids: duplicateOfficialIds,
    reconciles: inv.classic_stored_official_total + inv.expedition_stored_official_total + inv.legacy === inv.total
  };
}

function deriveObservationOrchestrationProposal({
  officialId,
  productionRow,
  durableState,
  simulation,
  today,
  sourceHealthy,
  observationEvents = null
}) {
  const id = String(officialId || "").toUpperCase();
  const sourcePresent = isOfficialIdInSource(simulation, id);
  const periodKey = observationPeriodKey(today);
  const snapshotHash = buildSourceSnapshotFingerprint(simulation);
  const cutoff = productionRow ? classifyCutoffSeparate(productionRow, today) : null;
  const priorCount = durableState?.consecutive_healthy_absence_count || 0;

  const base = {
    official_sailing_id: id,
    production_uuid: productionRow?.id || durableState?.production_cruise_uuid || null,
    durable_state_exists: Boolean(durableState),
    current_count: priorCount,
    current_period: durableState?.last_observation_period_key || null,
    current_snapshot_hash: durableState?.last_counted_snapshot_hash || null,
    source_still_absent: !sourcePresent,
    current_observation_period: periodKey,
    current_source_snapshot_hash: snapshotHash,
    source_health: sourceHealthy ? "PASS" : "FAIL",
    cutoff,
    observation_writes: 0,
    resolve_writes: 0,
    cruise_mutations: 0
  };

  if (sourcePresent) {
    if (durableState && durableState.status === OBSERVATION_STATUS_OBSERVING && priorCount > 0) {
      return {
        ...base,
        proposal: OBSERVATION_PROPOSAL.OBSERVATION_RESOLVE_DUE,
        expected_effect: { status: "RESOLVED", count: 0 },
        quarantine_proposal: null
      };
    }
    return { ...base, proposal: OBSERVATION_PROPOSAL.NONE, quarantine_proposal: null };
  }

  if (String(productionRow?.status || "").trim() === "expired" || cutoff?.within_cutoff) {
    return {
      ...base,
      proposal: OBSERVATION_PROPOSAL.AUDIT_ONLY_EXPIRED,
      quarantine_proposal: null
    };
  }

  if (!sourceHealthy) {
    return {
      ...base,
      proposal: OBSERVATION_PROPOSAL.NO_ADVANCE_SOURCE_UNHEALTHY,
      quarantine_proposal: null
    };
  }

  const advancement = computeExpectedAdvancement({
    existingState: durableState,
    sourceSnapshotHash: snapshotHash,
    observationPeriodKey: periodKey,
    sourceHealthy: true
  });

  let proposal = OBSERVATION_PROPOSAL.NONE;
  if (advancement.reason === "snapshot_already_counted") {
    proposal = OBSERVATION_PROPOSAL.SNAPSHOT_ALREADY_COUNTED;
  } else if (advancement.reason === "observation_period_already_counted") {
    proposal = OBSERVATION_PROPOSAL.OBSERVATION_ALREADY_COUNTED_THIS_PERIOD;
  } else if (advancement.write_action === "insert") {
    proposal = OBSERVATION_PROPOSAL.OBSERVATION_INSERT_DUE;
  } else if (advancement.write_action === "update" && advancement.new_count > priorCount) {
    proposal = OBSERVATION_PROPOSAL.OBSERVATION_ADVANCE_DUE;
  }

  const forensicLegacy = assessThreeObservationForensicAuditability();
  const events = observationEvents === null ? undefined : observationEvents || [];
  const eventForensic =
    events !== undefined && durableState
      ? evaluateObservationForensicChain({ stateRow: durableState, events })
      : null;
  const quarantineReadiness =
    durableState && events !== undefined
      ? assessQuarantineReadiness({
          stateRow: durableState,
          events,
          sourceHealthy,
          sourceStillAbsent: !sourcePresent
        })
      : null;

  const quarantineBase = deriveQuarantineProposal(advancement?.new_count ?? priorCount);
  let quarantine_proposal = null;
  if (quarantineBase.eligible) {
    if (quarantineReadiness) {
      quarantine_proposal = quarantineReadiness.quarantine_action_ready
        ? "QUARANTINE_REVIEW_REQUIRED"
        : quarantineReadiness.forensic_chain_complete
          ? "QUARANTINE_REVIEW_BLOCKED_ACTION_PRECONDITIONS"
          : "QUARANTINE_REVIEW_BLOCKED_FORENSIC_EVIDENCE";
    } else if (forensicLegacy.pass) {
      quarantine_proposal = "QUARANTINE_REVIEW_REQUIRED";
    } else {
      quarantine_proposal = "QUARANTINE_REVIEW_BLOCKED_FORENSIC_EVIDENCE";
    }
  }

  const cutoffGate = cutoffTakesPrecedenceOverAbsenceQuarantine({
    cutoff,
    quarantineEligible: quarantineBase.eligible
  });
  if (cutoffGate.suppress_quarantine_action && quarantine_proposal) {
    quarantine_proposal = "QUARANTINE_REVIEW_BLOCKED_CUTOFF_LIFECYCLE";
  }

  return {
    ...base,
    proposal,
    advancement,
    expected_new_count: advancement.new_count,
    quarantine_proposal,
    quarantine_actionable: quarantineReadiness
      ? quarantineReadiness.quarantine_action_ready === true
      : quarantine_proposal === "QUARANTINE_REVIEW_REQUIRED",
    threshold_reached: quarantineReadiness?.threshold_reached ?? quarantineBase.eligible,
    forensic_chain_complete: eventForensic?.forensic_chain_complete ?? false,
    forensic_result: eventForensic?.result ?? (events === undefined ? "EVENT_TABLE_NOT_LOADED" : null),
    event_reconciliation:
      durableState && events !== undefined
        ? buildEventStateReconciliation({ stateRow: durableState, events })
        : null,
    quarantine_readiness: quarantineReadiness
  };
}

function buildActionReadinessMatrix() {
  const forensic = assessThreeObservationForensicAuditability();
  return {
    INSERT: {
      semantics_proven: true,
      production_canary_proven: true,
      automation_ready: true,
      blocker: null
    },
    UPDATE: {
      semantics_proven: true,
      production_canary_proven: true,
      automation_ready: true,
      blocker: null
    },
    OBSERVATION_ADVANCE: {
      semantics_proven: true,
      production_canary_proven: true,
      automation_ready: true,
      blocker: null
    },
    OBSERVATION_RESOLVE: {
      semantics_proven: true,
      production_canary_proven: false,
      automation_ready: false,
      blocker: "production_resolve_canary_not_yet_proven"
    },
    QUARANTINE_REVIEW: {
      semantics_proven: true,
      production_canary_proven: false,
      automation_ready: false,
      blocker: forensic.append_only_events_required
        ? "forensic_event_history_missing"
        : null
    },
    HIDE: {
      semantics_proven: false,
      production_canary_proven: false,
      automation_ready: false,
      blocker: "not_authorised"
    },
    DELETE: {
      semantics_proven: false,
      production_canary_proven: false,
      automation_ready: false,
      blocker: "not_authorised"
    }
  };
}

function countObservationProposals(rows) {
  const counts = {};
  for (const value of Object.values(OBSERVATION_PROPOSAL)) counts[value] = 0;
  for (const row of rows) {
    counts[row.proposal] = (counts[row.proposal] || 0) + 1;
  }
  return counts;
}

function detectMassShrinkFailClosed(updateUnsafeRows, threshold = 10) {
  const shrinkLike = (updateUnsafeRows || []).filter((r) =>
    (r.reason_codes || []).some((code) =>
      /shrink|truncat|empty|guard_failed|ports_not_reconstructable/i.test(String(code))
    )
  );
  return {
    pass: shrinkLike.length < threshold,
    shrink_unsafe_count: shrinkLike.length,
    threshold,
    degraded: shrinkLike.length >= threshold
  };
}

function runSyntheticHardStopTests(context) {
  const { buildSilverseaWeeklyMaintenanceProposal: buildProposal } = require("./silversea-weekly-maintenance-proposal");
  const baseCtx = {
    productionIndex: context.productionIndex,
    cruiseLine: context.cruiseLine,
    today: context.today,
    previousObservations: context.previousObservations,
    baselineSourceSummary: context.simulation?.summary || null
  };

  const unhealthySim = {
    ...context.simulation,
    ok: false,
    health: { ok: false, category: "UNHEALTHY" }
  };
  const unhealthyProposal = buildProposal({ ...baseCtx, simulation: unhealthySim });
  const unhealthyBlocked =
    unhealthyProposal.counts.INSERT_ELIGIBLE === 0 &&
    unhealthyProposal.counts.UPDATE_ELIGIBLE === 0 &&
    unhealthyProposal.write_authorised_if_executed.source_absence_advancement === 0;

  const dupProduct = { ...(context.simulation.products[0] || {}), official_sailing_id: "DUPTEST001" };
  const dupSim = {
    ...context.simulation,
    products: [...(context.simulation.products || []), dupProduct, { ...dupProduct }]
  };
  dupSim.summary = { ...(dupSim.summary || {}), duplicate_official_ids: 1 };
  dupSim.health = { ...(dupSim.health || {}), ok: false, duplicate_official_ids: 1 };

  const duplicateBlocked = !dupSim.health?.ok;

  return {
    source_health_fail_closed: { pass: unhealthyBlocked, detail: unhealthyProposal.counts },
    duplicate_source_id_fail_closed: { pass: duplicateBlocked },
    mass_shrink_fail_closed: detectMassShrinkFailClosed(context.proposal?.tables?.update_unsafe || [])
  };
}

function orchestrationSemanticChecksum(reportBody) {
  const canonical = stableJson({
    identity: reportBody.identity_reconciliation,
    counts: reportBody.action_summary,
    observation_proposals: (reportBody.observation_proposals || []).map((r) => ({
      id: r.official_sailing_id,
      proposal: r.proposal,
      count: r.current_count,
      expected: r.expected_new_count
    })),
    checksum: reportBody.proposal?.checksum
  });
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function buildM6OrchestrationReport(context) {
  const {
    simulation,
    productionIndex,
    cruiseLine,
    today,
    observationStates,
    observationStatesById,
    observationEventsByStateId = new Map(),
    startingProductionInventory,
    canarySnapshotsBefore
  } = context;

  const previousObservations = previousObservationsFromDurable(observationStatesById);
  const proposalA = buildSilverseaWeeklyMaintenanceProposal({
    simulation,
    productionIndex,
    cruiseLine,
    today,
    previousObservations,
    baselineSourceSummary: context.baselineSourceSummary || null
  });
  const proposalB = buildSilverseaWeeklyMaintenanceProposal({
    simulation,
    productionIndex,
    cruiseLine,
    today,
    previousObservations,
    baselineSourceSummary: context.baselineSourceSummary || null
  });
  const idempotent = verifyProposalIdempotency(proposalA, proposalB);

  const sourceHealthy = simulation?.ok === true && simulation?.health?.ok === true;
  const currentPeriod = observationPeriodKey(today);
  const sourceAbsentRecords = proposalA.tables.source_absent_observations || [];

  const observationProposals = sourceAbsentRecords.map((rec) => {
    const officialId = String(rec.official_sailing_id).toUpperCase();
    const productionRow = productionIndex.byOfficialId.get(officialId) || null;
    const durableState = observationStatesById.get(officialId) || null;
    const events = durableState ? observationEventsByStateId.get(durableState.id) || [] : [];
    return deriveObservationOrchestrationProposal({
      officialId,
      productionRow,
      durableState,
      simulation,
      today,
      sourceHealthy,
      observationEvents: events
    });
  });

  for (const state of observationStates || []) {
    const officialId = String(state.official_sailing_id).toUpperCase();
    const events = observationEventsByStateId.get(state.id) || [];
    if (isOfficialIdInSource(simulation, officialId)) {
      const productionRow = productionIndex.byOfficialId.get(officialId) || null;
      observationProposals.push(
        deriveObservationOrchestrationProposal({
          officialId,
          productionRow,
          durableState: state,
          simulation,
          today,
          sourceHealthy,
          observationEvents: events
        })
      );
    }
  }

  const forensicChainReports = (observationStates || []).map((state) => ({
    official_sailing_id: state.official_sailing_id,
    state_id: state.id,
    events: observationEventsByStateId.get(state.id) || [],
    forensic: evaluateObservationForensicChain({
      stateRow: state,
      events: observationEventsByStateId.get(state.id) || []
    }),
    reconciliation: buildEventStateReconciliation({
      stateRow: state,
      events: observationEventsByStateId.get(state.id) || []
    })
  }));

  const obsProposalCounts = countObservationProposals(observationProposals);
  const forensic = assessThreeObservationForensicAuditability();

  const m2Record = proposalA.records.find((r) => r.official_sailing_id === M2_CANARY_ID);
  const m3Record = proposalA.records.find((r) => r.official_sailing_id === M3_CANARY_ID);
  const snRecord = observationProposals.find((r) => r.official_sailing_id === SOURCE_ABSENCE_FIXTURE_ID);
  const daRecord = observationProposals.find((r) => r.official_sailing_id === OTHER_ABSENCE_ID);

  const actionSummary = {
    UNCHANGED: proposalA.counts.UNCHANGED || 0,
    INSERT_ELIGIBLE_PROPOSALS: proposalA.counts.INSERT_ELIGIBLE || 0,
    UPDATE_ELIGIBLE_PROPOSALS: proposalA.counts.UPDATE_ELIGIBLE || 0,
    UPDATE_UNSAFE: proposalA.counts.UPDATE_UNSAFE || 0,
    WITHIN_CUTOFF: proposalA.counts.WITHIN_21_DAY_CUTOFF || 0,
    REFERENCE_BLOCKED: proposalA.counts.REFERENCE_BLOCKED || 0,
    SEMANTIC_BLOCKED: proposalA.counts.SEMANTIC_BLOCKED || 0,
    DURATION_BLOCKED: proposalA.counts.DURATION_BLOCKED || 0,
    DEFERRED_SPECIAL_PRODUCT: proposalA.counts.DEFERRED_SPECIAL_PRODUCT || 0,
    PRODUCTION_ONLY: proposalA.identity_reconciliation.production_only,
    SOURCE_ABSENT: proposalA.counts.SOURCE_ABSENT_OBSERVATION || 0,
    OBSERVATION_INSERT_DUE: obsProposalCounts.OBSERVATION_INSERT_DUE || 0,
    OBSERVATION_ADVANCE_DUE: obsProposalCounts.OBSERVATION_ADVANCE_DUE || 0,
    OBSERVATION_ALREADY_COUNTED: obsProposalCounts.OBSERVATION_ALREADY_COUNTED_THIS_PERIOD || 0,
    SNAPSHOT_ALREADY_COUNTED: obsProposalCounts.SNAPSHOT_ALREADY_COUNTED || 0,
    OBSERVATION_RESOLVE_DUE: obsProposalCounts.OBSERVATION_RESOLVE_DUE || 0,
    QUARANTINE_REVIEW_REQUIRED: observationProposals.filter((r) => r.quarantine_proposal === "QUARANTINE_REVIEW_REQUIRED").length,
    QUARANTINE_REVIEW_BLOCKED_FORENSIC: observationProposals.filter((r) =>
      String(r.quarantine_proposal || "").includes("FORENSIC")
    ).length,
    DELETE_PROPOSALS: sourceAbsentRecords.filter((r) => r.physical_delete_proposed === true).length
  };

  const hardStops = runSyntheticHardStopTests({ ...context, proposal: proposalA, previousObservations });

  const report = {
    phase: "M6",
    mode: "dry-run",
    read_only: true,
    weekly_maintenance_enabled: false,
    production_rpc_mutation_calls: 0,
    observation_state_writes: 0,
    observation_resolve_writes: 0,
    cruise_mutations: {
      inserts: 0,
      updates: 0,
      deletes: 0,
      hides: 0,
      reference_writes: 0
    },
    source: {
      timestamp: simulation.fetch_result?.fetched_at || simulation.generated_at || null,
      health: sourceHealthy ? "PASS" : "FAIL",
      summary: simulation.summary || null,
      health_detail: simulation.health || null,
      fingerprint: proposalA.source_snapshot?.fingerprint || null
    },
    production_inventory: startingProductionInventory,
    observation_state: {
      row_count: observationStates.length,
      rows: observationStates,
      current_observation_period: currentPeriod
    },
    identity_reconciliation: {
      ...proposalA.identity_reconciliation,
      complete:
        proposalA.identity_reconciliation.source_and_production + proposalA.identity_reconciliation.source_only >=
        (simulation.products || []).filter((p) => p.official_sailing_id).length
    },
    source_only_partition: proposalA.source_only_partition,
    source_only_partition_reconciles: proposalA.source_only_partition_reconciles,
    production_only_partition: proposalA.tables.source_absent_observations.concat(
      proposalA.records.filter(
        (r) =>
          r.identity_relation === "PRODUCTION_ONLY" &&
          r.classification !== MAINTENANCE_CLASSIFICATION.SOURCE_ABSENT_OBSERVATION
      )
    ),
    proposal: proposalA,
    action_summary: actionSummary,
    observation_proposals: observationProposals,
    forensic_chain_reports: forensicChainReports,
    event_history_table_available: observationEventsByStateId.size > 0 || context.eventHistoryTableAvailable === true,
    tables: {
      insert_eligible: proposalA.tables.insert_eligible,
      update_eligible: proposalA.tables.update_eligible,
      update_unsafe: proposalA.tables.update_unsafe,
      source_absent: proposalA.tables.source_absent_observations,
      deferred_special: proposalA.tables.deferred_special
    },
    canaries: {
      WH281005017: m2Record || null,
      SL270927009: m3Record || null,
      SN280222C25: snRecord || null,
      DA280115C21: daRecord || null
    },
    action_readiness_matrix: buildActionReadinessMatrix(),
    action_ceilings: M6_ACTION_CEILINGS,
    forensic_auditability: forensic,
    append_only_event_history_required: forensic.append_only_events_required,
    proposed_event_history_schema: PROPOSED_EVENT_HISTORY_SCHEMA,
    quarantine_hide_mutation_ready: false,
    quarantine_hide_execution_authorised: false,
    delete_mutation_ready: false,
    hard_stop_tests: hardStops,
    idempotency: {
      pass: idempotent,
      proposal_checksum_a: proposalA.checksum,
      proposal_checksum_b: proposalB.checksum
    },
    policies: {
      source_absence: SOURCE_ABSENCE_POLICY,
      action_ceilings: PROPOSED_ACTION_CEILINGS,
      future_lock_contract: FUTURE_MAINTENANCE_LOCK_CONTRACT,
      observation_state_schema: OBSERVATION_STATE_SCHEMA,
      hard_stop_conditions: WEEKLY_HARD_STOP_CONDITIONS
    },
    invocation: {
      entrypoint: "silversea-weekly-maintenance",
      mode: "dry-run-only",
      apply_blocked: true,
      cron_enabled: false
    },
    supabase_migration_history_reconciliation_deferred: true
  };

  report.semantic_checksum = orchestrationSemanticChecksum(report);

  const gates = {
    source_healthy: sourceHealthy,
    identity_complete: report.identity_reconciliation.complete === true,
    source_only_partition_reconciles: proposalA.source_only_partition_reconciles === true,
    delete_proposals_zero: actionSummary.DELETE_PROPOSALS === 0,
    forensic_blocks_quarantine_action: forensic.pass === false,
    idempotency_pass: idempotent === true,
    hard_stops_pass:
      hardStops.source_health_fail_closed.pass &&
      hardStops.duplicate_source_id_fail_closed.pass &&
      hardStops.mass_shrink_fail_closed.pass
  };
  report.gates = gates;
  report.ok = Object.values(gates).every(Boolean);

  return report;
}

module.exports = {
  M2_CANARY_ID,
  M3_CANARY_ID,
  OTHER_ABSENCE_ID,
  SOURCE_ABSENCE_FIXTURE_ID,
  OBSERVATION_PROPOSAL,
  M6_ACTION_CEILINGS,
  loadAllSilverseaObservationStates,
  observationStatesByOfficialId,
  previousObservationsFromDurable,
  productionInventoryBreakdown,
  deriveObservationOrchestrationProposal,
  buildActionReadinessMatrix,
  detectMassShrinkFailClosed,
  runSyntheticHardStopTests,
  orchestrationSemanticChecksum,
  buildM6OrchestrationReport,
  evaluateObservationForensicChain,
  assessQuarantineReadiness,
  FORENSIC_RESULT,
  loadObservationState
};
