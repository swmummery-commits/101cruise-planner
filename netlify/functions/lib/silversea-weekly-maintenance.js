/**
 * Silversea weekly maintenance — production executor (final closeout).
 * Orchestrates M1–M6 planning with bounded INSERT/UPDATE/observation apply.
 */

const crypto = require("crypto");
const adapter = require("./silversea-discovery-adapter");
const { indexExistingSilverseaRecords, buildSilverseaUpsertCandidate } = require("./silversea-discovery-writes");
const {
  buildM6OrchestrationReport,
  productionInventoryBreakdown,
  loadAllSilverseaObservationStates,
  observationStatesByOfficialId,
  M2_CANARY_ID,
  M3_CANARY_ID,
  SOURCE_ABSENCE_FIXTURE_ID
} = require("./silversea-m6-weekly-maintenance-orchestration");
const {
  loadAllSilverseaObservationEvents,
  loadObservationEventsForState
} = require("./silversea-source-absence-observation-events");
const {
  evaluateObservationForensicChain,
  assessQuarantineReadiness
} = require("./silversea-source-absence-observation-forensic");
const {
  MAINTENANCE_CLASSIFICATION,
  PROPOSED_ACTION_CEILINGS
} = require("./silversea-weekly-maintenance-policy");
const {
  advanceSourceAbsenceObservation,
  resolveSourceAbsenceObservation,
  observationPeriodKey,
  buildSourceSnapshotFingerprint
} = require("./silversea-source-absence-observation");
const { OBSERVATION_PROPOSAL } = require("./silversea-m6-weekly-maintenance-orchestration");
const { classifySilverseaOfficialInventory } = require("./silversea-classic-itinerary-ports-backfill");
const {
  snapshotProtectionRows,
  verifyProtectionSnapshots,
  normalizeStoredPorts,
  snapshotComparableFields
} = require("./silversea-expedition-itinerary-ports-backfill");
const { compareSemanticRawExtract } = require("./silversea-weekly-maintenance-proposal");
const {
  buildDiscoveredCruiseUpsertPayload,
  cruiseIdentityKey,
  upsertCandidateRecord
} = require("./cruise-discovery-ops");
const { validateCruise } = require("./cruise-discovery");
const { perthCalendarDate } = require("./public-discovered-cruise-inventory");
const { loadClassificationDestinations } = require("./destination-queries");
const {
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock,
  weeklyLockKey
} = require("./cruise-discovery-maintenance-locks");
const { withGlobalCruiseWriteLock } = require("./cruise-discovery-global-write-lock");
const { RUN_STATUS } = require("./cruise-discovery-controlled-production-run");

const LINE_SLUG = adapter.LINE_SLUG;
const RUN_TYPE = "silversea_weekly_maintenance";
const WEEKLY_CEILINGS = Object.freeze({
  insert: PROPOSED_ACTION_CEILINGS.insert,
  update: PROPOSED_ACTION_CEILINGS.update,
  observation: 1,
  resolve: 1,
  hide: 0,
  delete: 0
});

const ACTION_TYPE = Object.freeze({
  RESOLVE: "OBSERVATION_RESOLVE",
  OBSERVATION: "OBSERVATION_ADVANCE_OR_INSERT",
  UPDATE: "UPDATE",
  INSERT: "INSERT"
});

function sortByOfficialId(rows) {
  return [...(rows || [])].sort((a, b) =>
    String(a.official_sailing_id || "").localeCompare(String(b.official_sailing_id || ""))
  );
}

async function loadSilverseaWeeklyContext(supabase, { today = null, concurrency = 6 } = {}) {
  const calendarToday = today || perthCalendarDate();
  const line = (
    await supabase(`ci_cruise_lines?slug=eq.${LINE_SLUG}&select=id,name,slug&limit=1`)
  )?.[0];
  if (!line) throw new Error("Silversea line not found");

  const productionIndex = await indexExistingSilverseaRecords(supabase, line.id);
  const productionInventory = productionInventoryBreakdown(productionIndex.rows);
  const observationStates = await loadAllSilverseaObservationStates(supabase, line.id);
  const obsById = observationStatesByOfficialId(observationStates);
  const allEvents = await loadAllSilverseaObservationEvents(supabase, line.id);
  const observationEventsByStateId = new Map();
  if (allEvents !== null) {
    for (const state of observationStates) {
      observationEventsByStateId.set(
        state.id,
        allEvents.filter((e) => e.state_id === state.id)
      );
    }
  }

  const destinations = adapter.catalogueDestinations(await loadClassificationDestinations(supabase));
  const ships = await supabase(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows: productionIndex.rows,
    today: calendarToday,
    concurrency
  });

  const orchestration = buildM6OrchestrationReport({
    simulation,
    productionIndex,
    cruiseLine: line,
    today: calendarToday,
    observationStates,
    observationStatesById: obsById,
    observationEventsByStateId,
    eventHistoryTableAvailable: allEvents !== null,
    startingProductionInventory: productionInventory,
    canarySnapshotsBefore: new Map()
  });

  return {
    today: calendarToday,
    line,
    ships,
    destinations,
    simulation,
    productionIndex,
    productionInventory,
    observationStates,
    observationEventsByStateId,
    orchestration,
    sourceSnapshotHash: buildSourceSnapshotFingerprint(simulation),
    observationPeriod: observationPeriodKey(calendarToday)
  };
}

function selectBoundedWeeklyActions(orchestration) {
  if (!orchestration.gates?.source_healthy) {
    return {
      blocked: true,
      reason: "source_unhealthy",
      actions: [],
      skipped: { all: "source_unhealthy" }
    };
  }

  const selected = [];
  const counts = { resolve: 0, observation: 0, update: 0, insert: 0 };

  const resolveCandidates = sortByOfficialId(
    (orchestration.observation_proposals || []).filter(
      (p) => p.proposal === OBSERVATION_PROPOSAL.OBSERVATION_RESOLVE_DUE
    )
  );
  for (const row of resolveCandidates) {
    if (counts.resolve >= WEEKLY_CEILINGS.resolve) break;
    selected.push({ type: ACTION_TYPE.RESOLVE, official_sailing_id: row.official_sailing_id, proposal: row });
    counts.resolve += 1;
  }

  const obsCandidates = sortByOfficialId(
    (orchestration.observation_proposals || []).filter((p) =>
      [OBSERVATION_PROPOSAL.OBSERVATION_INSERT_DUE, OBSERVATION_PROPOSAL.OBSERVATION_ADVANCE_DUE].includes(
        p.proposal
      )
    )
  );
  for (const row of obsCandidates) {
    if (counts.observation >= WEEKLY_CEILINGS.observation) break;
    selected.push({ type: ACTION_TYPE.OBSERVATION, official_sailing_id: row.official_sailing_id, proposal: row });
    counts.observation += 1;
  }

  const updateCandidates = sortByOfficialId(orchestration.tables?.update_eligible || []);
  for (const row of updateCandidates) {
    if (counts.update >= WEEKLY_CEILINGS.update) break;
    selected.push({ type: ACTION_TYPE.UPDATE, official_sailing_id: row.official_sailing_id, proposal: row });
    counts.update += 1;
  }

  const insertCandidates = sortByOfficialId(orchestration.tables?.insert_eligible || []);
  for (const row of insertCandidates) {
    if (counts.insert >= WEEKLY_CEILINGS.insert) break;
    if (row.special_product_flag) continue;
    selected.push({ type: ACTION_TYPE.INSERT, official_sailing_id: row.official_sailing_id, proposal: row });
    counts.insert += 1;
  }

  const quarantineAlerts = (orchestration.observation_proposals || [])
    .filter((p) => p.threshold_reached || p.quarantine_proposal)
    .map((p) => ({
      official_sailing_id: p.official_sailing_id,
      count: p.current_count,
      quarantine_proposal: p.quarantine_proposal,
      quarantine_action_ready: p.quarantine_actionable === true,
      forensic_result: p.forensic_result
    }));

  return {
    blocked: false,
    actions: selected,
    counts,
    ceilings: WEEKLY_CEILINGS,
    quarantine_review_alerts: quarantineAlerts.filter((q) => q.quarantine_proposal)
  };
}

function buildInsertPayload(normalised, cruiseLine, runId) {
  const candidate = buildSilverseaUpsertCandidate(normalised, cruiseLine);
  if (!candidate) throw new Error("insert_candidate_build_failed");
  const identity_key =
    candidate.identity_key ||
    cruiseIdentityKey({
      cruiseLineId: candidate.cruise_line_id,
      shipId: candidate.ship_id,
      departureDate: candidate.departure_date,
      officialUrl: candidate.official_url,
      nights: candidate.nights,
      returnDate: candidate.return_date,
      officialSailingId: candidate.official_sailing_id
    });
  const mergedDeparture = {
    departure_port: candidate.departure_port,
    departure_port_meta: candidate.departure_port_meta || candidate.raw_extract?.departure_port_meta || null,
    blocked: false,
    reason: "new"
  };
  const reasons = validateCruise({
    ...candidate,
    departure_port: mergedDeparture.departure_port,
    departure_port_meta: mergedDeparture.departure_port_meta
  });
  const now = new Date().toISOString();
  return buildDiscoveredCruiseUpsertPayload(candidate, mergedDeparture, {
    identity_key,
    status: "active",
    reasons,
    now,
    includeItineraryPorts: true
  });
}

async function applyWeeklyUpdate(supabase, action, productionIndex) {
  const rec = action.proposal;
  const uuid = rec.production_uuid;
  const officialId = String(rec.official_sailing_id).toUpperCase();
  const currentRows = await supabase(
    `discovered_cruises?id=eq.${encodeURIComponent(uuid)}&official_sailing_id=eq.${encodeURIComponent(
      officialId
    )}&select=*&limit=1`
  );
  const current = currentRows?.[0];
  if (!current) return { ok: false, reason: "target_missing", type: ACTION_TYPE.UPDATE };

  const patchBody = {};
  for (const field of rec.changed_fields || []) {
    patchBody[field] =
      field === "itinerary_ports" ? normalizeStoredPorts(rec.after[field]) : rec.after[field];
  }
  patchBody.last_changed_at = new Date().toISOString();

  const updated = await supabase(`discovered_cruises?id=eq.${encodeURIComponent(uuid)}`, {
    method: "PATCH",
    body: patchBody,
    prefer: "return=representation"
  });
  const row = Array.isArray(updated) ? updated[0] : updated;
  return { ok: Boolean(row?.id), type: ACTION_TYPE.UPDATE, official_sailing_id: officialId, row };
}

async function applyWeeklyInsert(supabase, action, context) {
  const officialId = String(action.official_sailing_id).toUpperCase();
  const normalised = (context.simulation.products || []).find(
    (p) => String(p.official_sailing_id).toUpperCase() === officialId
  );
  if (!normalised) return { ok: false, reason: "source_row_missing", type: ACTION_TYPE.INSERT };
  if (context.productionIndex.byOfficialId.has(officialId)) {
    return { ok: false, reason: "already_in_production", type: ACTION_TYPE.INSERT };
  }
  const payload = buildInsertPayload(normalised, context.line, context.runId);
  const row = await upsertCandidateRecord(supabase, payload);
  return {
    ok: Boolean(row?.id),
    type: ACTION_TYPE.INSERT,
    official_sailing_id: officialId,
    row
  };
}

async function applyWeeklyObservation(supabase, action, context) {
  const officialId = String(action.official_sailing_id).toUpperCase();
  const productionRow = context.productionIndex.byOfficialId.get(officialId);
  const result = await advanceSourceAbsenceObservation(supabase, {
    cruiseLineId: context.line.id,
    officialSailingId: officialId,
    productionUuid: productionRow?.id || action.proposal?.production_uuid,
    sourceSnapshotHash: context.sourceSnapshotHash,
    sourceHealth: "healthy",
    observationPeriodKey: context.observationPeriod,
    runId: context.runId,
    reasonCode: "healthy_source_miss",
    metadata: { phase: "weekly_maintenance", run_id: context.runId }
  });
  return {
    ok: result?.ok === true && result?.advanced === true,
    idempotent: result?.advanced === false,
    type: ACTION_TYPE.OBSERVATION,
    official_sailing_id: officialId,
    result
  };
}

async function applyWeeklyResolve(supabase, action, context) {
  const officialId = String(action.official_sailing_id).toUpperCase();
  const result = await resolveSourceAbsenceObservation(supabase, {
    cruiseLineId: context.line.id,
    officialSailingId: officialId,
    runId: context.runId,
    metadata: { phase: "weekly_maintenance", run_id: context.runId },
    sourcePresent: true
  });
  return {
    ok: result?.ok === true && result?.action === "resolved",
    idempotent: result?.action === "idempotent_noop",
    type: ACTION_TYPE.RESOLVE,
    official_sailing_id: officialId,
    result
  };
}

async function verifyForensicAfterObservationMutation(supabase, context, officialId) {
  const stateRows = await loadAllSilverseaObservationStates(supabase, context.line.id);
  const state = stateRows.find((r) => String(r.official_sailing_id).toUpperCase() === officialId);
  if (!state) return { ok: true, skipped: true };
  const events = (await loadObservationEventsForState(supabase, state.id)) || [];
  const forensic = evaluateObservationForensicChain({ stateRow: state, events });
  return {
    ok: forensic.pass || forensic.result === "FORENSIC_CHAIN_NOT_APPLICABLE",
    forensic,
    reconciliation: forensic.reconciliation
  };
}

async function runSilverseaWeeklyMaintenance(options = {}) {
  const supabase = options.supabase;
  if (!supabase) throw new Error("supabase_required");
  const dryRun = options.dryRun !== false && options.performWrites !== true;
  const performWrites = options.performWrites === true && dryRun === false;
  const runId = options.runId || `silversea-weekly-maintenance-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const startedAt = new Date().toISOString();

  const context = await loadSilverseaWeeklyContext(supabase, { today: options.today });
  context.runId = runId;
  const plan = selectBoundedWeeklyActions(context.orchestration);

  const writeStats = {
    inserts: 0,
    updates: 0,
    observation_advances: 0,
    observation_resolves: 0,
    hides: 0,
    deletes: 0,
    reference_writes: 0,
    event_writes: 0,
    observation_state_writes: 0
  };

  const report = {
    run_id: runId,
    run_type: RUN_TYPE,
    started_at: startedAt,
    mode: dryRun ? "dry-run" : "apply",
    read_only: !performWrites,
    weekly_maintenance_enabled: true,
    source: context.orchestration.source,
    production_inventory: context.productionInventory,
    orchestration: {
      action_summary: context.orchestration.action_summary,
      identity_reconciliation: context.orchestration.identity_reconciliation,
      gates: context.orchestration.gates
    },
    plan,
    writes: writeStats,
    verification: null,
    lock: null,
    status: dryRun ? RUN_STATUS.PREPARED : RUN_STATUS.PREPARED
  };

  if (!performWrites) {
    report.ended_at = new Date().toISOString();
    report.status = "DRY_RUN_COMPLETE";
    return report;
  }

  if (plan.blocked) {
    report.status = RUN_STATUS.BLOCKED;
    report.block_reason = plan.reason;
    report.ended_at = new Date().toISOString();
    return report;
  }

  const lineLock = await acquireMaintenanceDbLock(supabase, {
    lockKey: weeklyLockKey(LINE_SLUG),
    ownerId: runId,
    runId,
    leaseSeconds: 1800
  });
  report.lock = { line: lineLock };
  if (!lineLock.acquired) {
    report.status = RUN_STATUS.BLOCKED;
    report.block_reason = "weekly_line_lock_unavailable";
    report.ended_at = new Date().toISOString();
    return report;
  }

  const applyResults = [];
  const cruiseActions = plan.actions.filter((a) => a.type === ACTION_TYPE.INSERT || a.type === ACTION_TYPE.UPDATE);
  const obsActions = plan.actions.filter(
    (a) => a.type === ACTION_TYPE.OBSERVATION || a.type === ACTION_TYPE.RESOLVE
  );

  try {
    for (const action of obsActions) {
      let result;
      if (action.type === ACTION_TYPE.OBSERVATION) {
        result = await applyWeeklyObservation(supabase, action, context);
        if (result.ok) writeStats.observation_advances += 1;
      } else {
        result = await applyWeeklyResolve(supabase, action, context);
        if (result.ok) writeStats.observation_resolves += 1;
      }
      applyResults.push(result);
      if (result.ok) {
        const forensic = await verifyForensicAfterObservationMutation(
          supabase,
          context,
          action.official_sailing_id
        );
        if (!forensic.ok) {
          throw new Error(`forensic_mismatch_${action.official_sailing_id}`);
        }
      }
    }

    if (cruiseActions.length) {
      await withGlobalCruiseWriteLock(
        supabase,
        { ownerId: runId, runId, lineSlug: LINE_SLUG, operation: RUN_TYPE },
        async () => {
          const targetUuids = new Set(
            cruiseActions
              .map((action) => {
                if (action.type === ACTION_TYPE.UPDATE) return action.proposal?.production_uuid;
                return null;
              })
              .filter(Boolean)
          );
          const protectionBefore = snapshotProtectionRows(context.productionIndex.rows, targetUuids);
          for (const action of cruiseActions) {
            const freshIndex = await indexExistingSilverseaRecords(supabase, context.line.id);
            context.productionIndex = freshIndex;
            let result;
            if (action.type === ACTION_TYPE.UPDATE) {
              result = await applyWeeklyUpdate(supabase, action, freshIndex);
              if (result.ok) writeStats.updates += 1;
            } else {
              result = await applyWeeklyInsert(supabase, action, context);
              if (result.ok) writeStats.inserts += 1;
            }
            applyResults.push(result);
            if (!result.ok) throw new Error(`${action.type}_failed:${action.official_sailing_id}`);
          }
          const afterIndex = await indexExistingSilverseaRecords(supabase, context.line.id);
          const protection = verifyProtectionSnapshots(protectionBefore, afterIndex.rows, targetUuids, {
            perthToday: context.today
          });
          report.verification = { protection, apply_results: applyResults };
          if (!protection.ok) throw new Error("non_target_protection_failed");
        }
      );
    } else {
      report.verification = { apply_results: applyResults };
    }

    report.status = RUN_STATUS.COMPLETE;
  } catch (err) {
    report.status = RUN_STATUS.FAILED;
    report.error = err.message || String(err);
    report.verification = { apply_results: applyResults, error: report.error };
  } finally {
    await releaseMaintenanceDbLock(supabase, { lockKey: weeklyLockKey(LINE_SLUG), ownerId: runId });
    report.lock.line_released = true;
    report.ended_at = new Date().toISOString();
    report.writes = writeStats;
  }

  return report;
}

module.exports = {
  LINE_SLUG,
  RUN_TYPE,
  WEEKLY_CEILINGS,
  ACTION_TYPE,
  loadSilverseaWeeklyContext,
  selectBoundedWeeklyActions,
  runSilverseaWeeklyMaintenance
};
