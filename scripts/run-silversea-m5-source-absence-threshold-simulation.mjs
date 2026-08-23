#!/usr/bin/env node
/**
 * Silversea M5 — source-absence threshold / quarantine-proposal simulation (READ ONLY).
 *
 *   node scripts/run-silversea-m5-source-absence-threshold-simulation.mjs
 *
 * No observation RPC mutations. No cruise mutations.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {}

const REPORT_DIR = path.join(root, "reports");
const CANARY_ID = "SN280222C25";
const OTHER_ABSENCE_ID = "DA280115C21";
const M2_ID = "WH281005017";
const M3_ID = "SL270927009";
const EXPECTED_UUID = "e1cc4129-488b-442e-b45e-ccdfb5c55699";
const M4B_PERIOD = "2026-W34";
const M4B_HASH = "9550e5128173d201211609428dae83790482c055037a7853a493090d444d39df";
const SIM_PERIOD_2 = "2026-W35";
const SIM_PERIOD_3 = "2026-W36";
const SIM_HASH_2 = "m5-sim-week2-synthetic-hash-00000000000000000000000000000001";
const SIM_HASH_3 = "m5-sim-week3-synthetic-hash-00000000000000000000000000000002";

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { indexExistingSilverseaRecords } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const { classifySilverseaOfficialInventory } = require(path.join(
  root,
  "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"
));
const {
  loadObservationState,
  verifyObservationSchemaReady,
  classifyCutoffSeparate,
  classifySourceAbsenceCandidate,
  isOfficialIdInSource,
  buildSourceSnapshotFingerprint,
  deriveQuarantineProposal
} = require(path.join(root, "netlify/functions/lib/silversea-source-absence-observation"));
const sim = require(path.join(root, "netlify/functions/lib/silversea-source-absence-threshold-simulation"));
const {
  snapshotProtectionRows,
  verifyProtectionSnapshots,
  snapshotComparableFields
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function inventorySummary(rows) {
  const inv = classifySilverseaOfficialInventory(rows);
  const ids = rows.map((r) => String(r.official_sailing_id || "").toUpperCase()).filter(Boolean);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i).length;
  return {
    total: inv.total,
    official: inv.total - inv.legacy,
    classic_stored_official: inv.classic_stored_official_total,
    expedition_stored_official: inv.expedition_stored_official_total,
    legacy: inv.legacy,
    duplicate_official_ids: dupes
  };
}

function snapshotRow(row) {
  return snapshotComparableFields(row);
}

export async function runSilverseaM5SourceAbsenceThresholdSimulation(options = {}) {
  const startedAt = new Date().toISOString();
  const today = options.today || perthCalendarDate();
  const runId = options.runId || `silversea-m5-threshold-simulation-${startedAt.replace(/[:.]/g, "-")}`;
  const sb = createMaintenanceSupabase(root);

  const schema = await verifyObservationSchemaReady(sb);
  if (!schema.ok) {
    return { ok: false, phase: "M5", stopped: true, reason: "observation_schema_not_ready", schema };
  }

  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  if (!line) throw new Error("Silversea line not found");

  const productionIndexBefore = await indexExistingSilverseaRecords(sb, line.id);
  const invBefore = inventorySummary(productionIndexBefore.rows);
  const canaryBefore = productionIndexBefore.byOfficialId.get(CANARY_ID);
  const m2Before = productionIndexBefore.byOfficialId.get(M2_ID);
  const m3Before = productionIndexBefore.byOfficialId.get(M3_ID);

  const obsBefore = await loadObservationState(sb, {
    cruiseLineId: line.id,
    officialSailingId: CANARY_ID
  });

  if (!obsBefore || (obsBefore.consecutive_healthy_absence_count || 0) !== 1) {
    return {
      ok: false,
      phase: "M5",
      stopped: true,
      reason: "unexpected_production_observation_count",
      expected_count: 1,
      actual: obsBefore
    };
  }

  const destinations = adapter.catalogueDestinations(await loadClassificationDestinations(async (q) => sb(q)));
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows: productionIndexBefore.rows,
    today,
    concurrency: 6
  });

  const sourceHealthy = simulation?.health?.ok === true;
  const sourceFingerprint = buildSourceSnapshotFingerprint(simulation);
  const sourcePresent = isOfficialIdInSource(simulation, CANARY_ID);
  const candidate = classifySourceAbsenceCandidate({
    productionRow: canaryBefore,
    simulation,
    today
  });
  const cutoff = classifyCutoffSeparate(canaryBefore, today);

  const otherRow = productionIndexBefore.byOfficialId.get(OTHER_ABSENCE_ID);
  const otherObsBefore = otherRow
    ? await loadObservationState(sb, { cruiseLineId: line.id, officialSailingId: OTHER_ABSENCE_ID })
    : null;

  const m4bState = sim.cloneObservationState(obsBefore);

  const simWeek2 = sim.simulateSourceAbsenceObservationStep({
    existingState: m4bState,
    sourceHealthy: true,
    sourcePresent: false,
    sourceSnapshotHash: SIM_HASH_2,
    observationPeriodKey: SIM_PERIOD_2,
    runId: `${runId}-sim-week2`
  });

  const simWeek3 = sim.simulateSourceAbsenceObservationStep({
    existingState: simWeek2.next_state,
    sourceHealthy: true,
    sourcePresent: false,
    sourceSnapshotHash: SIM_HASH_3,
    observationPeriodKey: SIM_PERIOD_3,
    runId: `${runId}-sim-week3`
  });

  const quarantineProposal = sim.buildQuarantineReviewProposal({
    officialSailingId: CANARY_ID,
    productionUuid: canaryBefore.id,
    cruiseLineId: line.id,
    productionRow: canaryBefore,
    observationState: simWeek3.next_state,
    qualifyingPeriods: [M4B_PERIOD, SIM_PERIOD_2, SIM_PERIOD_3],
    qualifyingSnapshotHashes: [M4B_HASH, SIM_HASH_2, SIM_HASH_3],
    sourceHealth: "PASS",
    secondaryProductContext: candidate.secondary_product_context,
    cutoff
  });

  const replaySameSnapshot = sim.simulateSourceAbsenceObservationStep({
    existingState: m4bState,
    sourceHealthy: true,
    sourcePresent: false,
    sourceSnapshotHash: M4B_HASH,
    observationPeriodKey: M4B_PERIOD
  });

  const replaySameWeekDiffHash = sim.simulateSourceAbsenceObservationStep({
    existingState: m4bState,
    sourceHealthy: true,
    sourcePresent: false,
    sourceSnapshotHash: SIM_HASH_2,
    observationPeriodKey: M4B_PERIOD
  });

  const unhealthySim = sim.simulateSourceAbsenceObservationStep({
    existingState: m4bState,
    sourceHealthy: false,
    sourcePresent: false,
    sourceSnapshotHash: SIM_HASH_2,
    observationPeriodKey: SIM_PERIOD_2
  });

  const returnFrom1 = sim.simulateSourceReturn({ existingState: m4bState, runId: `${runId}-return-1` });
  const returnFrom2State = sim.cloneObservationState({
    ...m4bState,
    consecutive_healthy_absence_count: 2,
    last_observation_period_key: SIM_PERIOD_2,
    last_counted_snapshot_hash: SIM_HASH_2
  });
  const returnFrom2 = sim.simulateSourceReturn({ existingState: returnFrom2State, runId: `${runId}-return-2` });
  const afterResetAbsence = sim.simulateSourceAbsenceObservationStep({
    existingState: returnFrom2.next_state,
    sourceHealthy: true,
    sourcePresent: false,
    sourceSnapshotHash: SIM_HASH_3,
    observationPeriodKey: SIM_PERIOD_3,
    runId: `${runId}-after-reset`
  });

  const count3State = sim.cloneObservationState(simWeek3.next_state);
  const returnFrom3 = sim.simulateSourceReturn({ existingState: count3State, runId: `${runId}-return-3` });

  const forensic = sim.assessThreeObservationForensicAuditability();
  const expiredPolicy = otherRow
    ? sim.shouldProposeQuarantineForExpiredRow(otherRow, today)
    : { propose: false, reason: "not_in_production" };
  const cutoffPrecedence = sim.cutoffTakesPrecedenceOverAbsenceQuarantine({
    cutoff,
    quarantineEligible: true
  });

  const productionIndexAfter = await indexExistingSilverseaRecords(sb, line.id);
  const invAfter = inventorySummary(productionIndexAfter.rows);
  const obsAfter = await loadObservationState(sb, {
    cruiseLineId: line.id,
    officialSailingId: CANARY_ID
  });
  const otherObsAfter = otherRow
    ? await loadObservationState(sb, { cruiseLineId: line.id, officialSailingId: OTHER_ABSENCE_ID })
    : null;

  const canaryAfter = productionIndexAfter.byOfficialId.get(CANARY_ID);
  const m2After = productionIndexAfter.byOfficialId.get(M2_ID);
  const m3After = productionIndexAfter.byOfficialId.get(M3_ID);

  const canaryProtection = verifyProtectionSnapshots(
    snapshotProtectionRows([canaryBefore], new Set()),
    [canaryAfter],
    new Set()
  );
  const m2Protected = m2Before && m2After
    ? verifyProtectionSnapshots(snapshotProtectionRows([m2Before], new Set()), [m2After], new Set()).ok
    : false;
  const m3Protected = m3Before && m3After
    ? verifyProtectionSnapshots(snapshotProtectionRows([m3Before], new Set()), [m3After], new Set()).ok
    : false;

  const obsUnchanged =
    obsAfter &&
    obsBefore.id === obsAfter.id &&
    obsAfter.consecutive_healthy_absence_count === 1 &&
    obsAfter.status === "OBSERVING" &&
    obsAfter.last_observation_period_key === M4B_PERIOD &&
    obsAfter.last_counted_snapshot_hash === M4B_HASH;

  const rowDeltaOk =
    invAfter.total === invBefore.total &&
    invAfter.official === invBefore.official &&
    invAfter.legacy === invBefore.legacy &&
    invAfter.duplicate_official_ids === 0;

  const simulationOk =
    simWeek2.new_count === 2 &&
    !simWeek2.quarantine.eligible &&
    simWeek3.new_count === 3 &&
    simWeek3.quarantine.eligible &&
    simWeek3.quarantine.proposal === "QUARANTINE_REVIEW_REQUIRED" &&
    simWeek3.cruise_mutations === 0 &&
    replaySameSnapshot.idempotent &&
    replaySameWeekDiffHash.reason === "observation_period_already_counted" &&
    unhealthySim.new_count === 1 &&
    returnFrom1.new_count === 0 &&
    returnFrom2.new_count === 0 &&
    afterResetAbsence.new_count === 1 &&
    returnFrom3.proposal_cancelled === true;

  const summary = simulation.summary || {};
  const report = {
    phase: "M5",
    run_id: runId,
    started_at: startedAt,
    mode: "read_only_simulation",
    git_sha: git("git rev-parse HEAD"),
    weekly_maintenance_enabled: false,
    production_rpc_mutation_calls: 0,
    observation_state_writes: 0,
    schema_ready: true,
    current_observation: obsBefore,
    current_production: {
      uuid: canaryBefore.id,
      status: canaryBefore.status,
      departure: canaryBefore.departure_date,
      count: 1
    },
    source: {
      timestamp: simulation.fetch_result?.fetched_at || null,
      health: sourceHealthy ? "PASS" : "FAIL",
      total: (summary.classic || 0) + (summary.expedition || 0),
      classic: summary.classic,
      expedition: summary.expedition,
      fingerprint: sourceFingerprint,
      sn280222c25_present: sourcePresent
    },
    classification: candidate.classification,
    cutoff,
    simulations: {
      week2: simWeek2,
      week3: simWeek3,
      quarantine_proposal: quarantineProposal,
      replay_same_snapshot: replaySameSnapshot,
      replay_same_week_diff_hash: replaySameWeekDiffHash,
      unhealthy: unhealthySim,
      return_from_1: returnFrom1,
      return_from_2: returnFrom2,
      absence_after_reset: afterResetAbsence,
      return_from_3_cancels_proposal: returnFrom3
    },
    forensic,
    expired_row_policy: expiredPolicy,
    cutoff_precedence: cutoffPrecedence,
    other_absence: {
      official_sailing_id: OTHER_ABSENCE_ID,
      in_production: Boolean(otherRow),
      observation_state: otherObsBefore,
      observation_writes: 0
    },
    quarantine_action_preconditions: sim.QUARANTINE_ACTION_PRECONDITIONS,
    recommended_quarantine_semantic: sim.RECOMMENDED_QUARANTINE_SEMANTIC,
    production_before: invBefore,
    production_after: invAfter,
    observation_before: obsBefore,
    observation_after: obsAfter,
    observation_state_delta: obsUnchanged ? 0 : "CHANGED",
    row_delta: invAfter.total - invBefore.total,
    canary_protection: canaryProtection,
    m2_canary_protected: m2Protected,
    m3_canary_protected: m3Protected,
    other_observation_unchanged: JSON.stringify(otherObsBefore) === JSON.stringify(otherObsAfter),
    supabase_migration_history_reconciliation_deferred: true,
    ok: sourceHealthy && !sourcePresent && simulationOk && obsUnchanged && rowDeltaOk && canaryProtection.ok
  };

  report.ended_at = new Date().toISOString();

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const outPath = path.join(REPORT_DIR, `${runId}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  report.report_path = outPath;

  return report;
}

async function main() {
  const result = await runSilverseaM5SourceAbsenceThresholdSimulation();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
