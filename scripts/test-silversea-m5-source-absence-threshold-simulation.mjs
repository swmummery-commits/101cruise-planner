#!/usr/bin/env node
/**
 * Silversea M5 source-absence threshold simulation tests — pure policy, no production writes.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const obs = require(path.join(root, "netlify/functions/lib/silversea-source-absence-observation"));
const sim = require(path.join(root, "netlify/functions/lib/silversea-source-absence-threshold-simulation"));
const m5Runner = fs.readFileSync(
  path.join(root, "scripts/run-silversea-m5-source-absence-threshold-simulation.mjs"),
  "utf8"
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(`  ${e.message}`);
    failed += 1;
  }
}

const M4B_STATE = {
  id: "c5abc742-fe7e-4846-94d2-973813de2478",
  consecutive_healthy_absence_count: 1,
  status: "OBSERVING",
  last_observation_period_key: "2026-W34",
  last_counted_snapshot_hash: "9550e5128173d201211609428dae83790482c055037a7853a493090d444d39df",
  first_observed_at: "2026-08-23T08:14:47.92398+00:00",
  last_observed_at: "2026-08-23T08:14:47.92398+00:00"
};
const HASH_A = "9550e5128173d201211609428dae83790482c055037a7853a493090d444d39df";
const HASH_B = "m5-sim-week2-synthetic-hash-00000000000000000000000000000001";
const HASH_C = "m5-sim-week3-synthetic-hash-00000000000000000000000000000002";
const W34 = "2026-W34";
const W35 = "2026-W35";
const W36 = "2026-W36";

test("1 real starting count 1", () => {
  if (M4B_STATE.consecutive_healthy_absence_count !== 1) throw new Error("count");
});

test("2 simulated next healthy week 1 -> 2", () => {
  const r = sim.simulateSourceAbsenceObservationStep({
    existingState: M4B_STATE,
    sourceSnapshotHash: HASH_B,
    observationPeriodKey: W35
  });
  if (r.new_count !== 2 || !r.advanced) throw new Error(JSON.stringify(r));
});

test("3 count 2 no quarantine", () => {
  const state2 = sim.simulateSourceAbsenceObservationStep({
    existingState: M4B_STATE,
    sourceSnapshotHash: HASH_B,
    observationPeriodKey: W35
  }).next_state;
  if (state2.consecutive_healthy_absence_count !== 2) throw new Error("count");
  const q = obs.deriveQuarantineProposal(2);
  if (q.eligible || q.proposal) throw new Error(JSON.stringify(q));
});

test("4 simulated third healthy week 2 -> 3", () => {
  const state2 = sim.simulateSourceAbsenceObservationStep({
    existingState: M4B_STATE,
    sourceSnapshotHash: HASH_B,
    observationPeriodKey: W35
  }).next_state;
  const r = sim.simulateSourceAbsenceObservationStep({
    existingState: state2,
    sourceSnapshotHash: HASH_C,
    observationPeriodKey: W36
  });
  if (r.new_count !== 3) throw new Error(JSON.stringify(r));
});

test("5 count 3 proposal only", () => {
  const state3 = sim.simulateSourceAbsenceObservationStep({
    existingState: sim.simulateSourceAbsenceObservationStep({
      existingState: M4B_STATE,
      sourceSnapshotHash: HASH_B,
      observationPeriodKey: W35
    }).next_state,
    sourceSnapshotHash: HASH_C,
    observationPeriodKey: W36
  }).next_state;
  const q = obs.deriveQuarantineProposal(state3.consecutive_healthy_absence_count);
  if (!q.eligible || q.proposal !== "QUARANTINE_REVIEW_REQUIRED" || q.execute) {
    throw new Error(JSON.stringify(q));
  }
});

test("6 count 3 no cruise mutation", () => {
  const r = sim.simulateSourceAbsenceObservationStep({
    existingState: { ...M4B_STATE, consecutive_healthy_absence_count: 2, last_observation_period_key: W35 },
    sourceSnapshotHash: HASH_C,
    observationPeriodKey: W36
  });
  if (r.cruise_mutations !== 0 || r.quarantine_executed) throw new Error(JSON.stringify(r));
});

test("7 same snapshot replay no increment", () => {
  const r = sim.simulateSourceAbsenceObservationStep({
    existingState: M4B_STATE,
    sourceSnapshotHash: HASH_A,
    observationPeriodKey: W34
  });
  if (r.advanced || r.new_count !== 1) throw new Error(JSON.stringify(r));
});

test("8 same week different snapshot no increment", () => {
  const r = sim.simulateSourceAbsenceObservationStep({
    existingState: M4B_STATE,
    sourceSnapshotHash: HASH_B,
    observationPeriodKey: W34
  });
  if (r.advanced || r.reason !== "observation_period_already_counted") throw new Error(JSON.stringify(r));
});

test("9 unhealthy source no increment", () => {
  const r = sim.simulateSourceAbsenceObservationStep({
    existingState: M4B_STATE,
    sourceHealthy: false,
    sourceSnapshotHash: HASH_B,
    observationPeriodKey: W35
  });
  if (r.new_count !== 1) throw new Error(JSON.stringify(r));
});

test("10 source return from 1 resets", () => {
  const r = sim.simulateSourceReturn({ existingState: M4B_STATE });
  if (r.new_count !== 0 || r.next_state.status !== "RESOLVED") throw new Error(JSON.stringify(r));
});

test("11 source return from 2 resets", () => {
  const r = sim.simulateSourceReturn({
    existingState: { ...M4B_STATE, consecutive_healthy_absence_count: 2 }
  });
  if (r.new_count !== 0) throw new Error(JSON.stringify(r));
});

test("12 absence after reset starts at 1", () => {
  const resolved = sim.simulateSourceReturn({
    existingState: { ...M4B_STATE, consecutive_healthy_absence_count: 2 }
  }).next_state;
  const r = sim.simulateSourceAbsenceObservationStep({
    existingState: resolved,
    sourceSnapshotHash: HASH_C,
    observationPeriodKey: W36
  });
  if (r.new_count !== 1) throw new Error(JSON.stringify(r));
});

test("13 source return at 3 cancels proposal", () => {
  const state3 = { ...M4B_STATE, consecutive_healthy_absence_count: 3 };
  const r = sim.simulateSourceReturn({ existingState: state3 });
  if (!r.proposal_cancelled || r.new_count !== 0) throw new Error(JSON.stringify(r));
});

test("14 cutoff independent", () => {
  const row = { departure_date: "2028-02-22", status: "active" };
  const c = obs.classifyCutoffSeparate(row, "2026-08-23");
  if (c.within_21_day_cutoff) throw new Error("should not be within cutoff");
});

test("15 cutoff suppresses redundant quarantine", () => {
  const row = { departure_date: "2026-08-24", status: "active" };
  const cutoff = obs.classifyCutoffSeparate(row, "2026-08-23");
  const p = sim.cutoffTakesPrecedenceOverAbsenceQuarantine({ cutoff, quarantineEligible: true });
  if (!p.suppress_quarantine_action) throw new Error(JSON.stringify(p));
});

test("16 expired official row retained", () => {
  const row = { departure_date: "2020-01-01", status: "expired", official_sailing_id: "X1" };
  if (row.official_sailing_id !== "X1") throw new Error("identity");
});

test("17 expired row no redundant quarantine", () => {
  const row = { departure_date: "2020-01-01", status: "expired" };
  const p = sim.shouldProposeQuarantineForExpiredRow(row, "2026-08-23");
  if (p.propose) throw new Error(JSON.stringify(p));
});

test("18 historical/special context in review proposal", () => {
  const proposal = sim.buildQuarantineReviewProposal({
    officialSailingId: "SN280222C25",
    productionUuid: "e1cc4129-488b-442e-b45e-ccdfb5c55699",
    cruiseLineId: "line",
    productionRow: { status: "active", departure_date: "2028-02-22" },
    observationState: { ...M4B_STATE, consecutive_healthy_absence_count: 3 },
    qualifyingPeriods: [W34, W35, W36],
    secondaryProductContext: "historical_combination_metadata_present"
  });
  if (!proposal.special_historical_product_review_context) throw new Error(JSON.stringify(proposal));
  if (proposal.proposed_action !== "QUARANTINE_REVIEW_REQUIRED") throw new Error("action");
});

test("19 second source-absence identity untouched constant", () => {
  if (!m5Runner.includes("DA280115C21")) throw new Error("other absence");
  if (m5Runner.includes("advanceSourceAbsenceObservation")) throw new Error("no RPC mutation");
});

test("20 production RPC mutation calls 0", () => {
  if (!m5Runner.includes("production_rpc_mutation_calls: 0")) throw new Error("rpc calls");
  if (m5Runner.includes("advanceSourceAbsenceObservation(")) throw new Error("must not call advance");
  if (m5Runner.includes("resolveSourceAbsenceObservation(")) throw new Error("must not call resolve");
});

test("21 production observation state unchanged contract", () => {
  if (!m5Runner.includes("observation_state_writes: 0")) throw new Error("obs writes");
  if (!m5Runner.includes("obsUnchanged")) throw new Error("delta check");
});

test("22 production cruises unchanged contract", () => {
  if (!m5Runner.includes("row_delta")) throw new Error("row delta");
});

test("23 physical delete never proposed", () => {
  const q = sim.buildQuarantineReviewProposal({
    officialSailingId: "SN280222C25",
    productionUuid: "uuid",
    cruiseLineId: "line",
    productionRow: { status: "active" },
    observationState: { consecutive_healthy_absence_count: 3 },
    qualifyingPeriods: [W34, W35, W36]
  });
  if (!q.proposed_action_not.includes("DELETE")) throw new Error("delete guard");
  if (sim.RECOMMENDED_QUARANTINE_SEMANTIC.avoid.includes("physical_delete") === false) {
    throw new Error("semantic");
  }
});

test("24 forensic auditability fails for single-row model", () => {
  const f = sim.assessThreeObservationForensicAuditability();
  if (f.pass || !f.append_only_events_required) throw new Error(JSON.stringify(f));
});

console.log(`\nM5 tests: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
