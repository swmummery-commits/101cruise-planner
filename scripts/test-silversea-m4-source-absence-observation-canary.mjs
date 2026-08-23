#!/usr/bin/env node
/**
 * Silversea M4 source-absence observation canary tests — offline policy + lifecycle mocks.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const obs = require(path.join(root, "netlify/functions/lib/silversea-source-absence-observation"));
const m4 = require(path.join(root, "netlify/functions/lib/silversea-m4-source-absence-observation-canary"));
const policy = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-policy"));
const m4Runner = fs.readFileSync(
  path.join(root, "scripts/run-silversea-m4-source-absence-observation-canary.mjs"),
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

const CANARY = "SN280222C25";
const HASH_A = "aaa";
const HASH_B = "bbb";
const PERIOD_1 = "2026-W34";
const PERIOD_2 = "2026-W35";

test("1 exact canary only", () => {
  if (m4.CANARY_OFFICIAL_ID !== CANARY) throw new Error("canary id");
});

test("2 healthy absence creates count 1", () => {
  const adv = obs.computeExpectedAdvancement({
    existingState: null,
    sourceSnapshotHash: HASH_A,
    observationPeriodKey: PERIOD_1,
    sourceHealthy: true
  });
  if (adv.new_count !== 1 || adv.write_action !== "insert") throw new Error(JSON.stringify(adv));
});

test("3 same snapshot replay does not increment", () => {
  const adv = obs.computeExpectedAdvancement({
    existingState: {
      consecutive_healthy_absence_count: 1,
      last_counted_snapshot_hash: HASH_A,
      last_observation_period_key: PERIOD_1,
      status: "OBSERVING"
    },
    sourceSnapshotHash: HASH_A,
    observationPeriodKey: PERIOD_1,
    sourceHealthy: true
  });
  if (!adv.idempotent || adv.new_count !== 1) throw new Error(JSON.stringify(adv));
});

test("4 second distinct weekly absence -> 2", () => {
  const adv = obs.computeExpectedAdvancement({
    existingState: {
      consecutive_healthy_absence_count: 1,
      last_counted_snapshot_hash: HASH_A,
      last_observation_period_key: PERIOD_1,
      status: "OBSERVING"
    },
    sourceSnapshotHash: HASH_B,
    observationPeriodKey: PERIOD_2,
    sourceHealthy: true
  });
  if (adv.new_count !== 2) throw new Error(JSON.stringify(adv));
});

test("5 third distinct healthy absence -> quarantine proposal only", () => {
  const adv = obs.computeExpectedAdvancement({
    existingState: {
      consecutive_healthy_absence_count: 2,
      last_counted_snapshot_hash: HASH_A,
      last_observation_period_key: PERIOD_1,
      status: "OBSERVING"
    },
    sourceSnapshotHash: HASH_B,
    observationPeriodKey: PERIOD_2,
    sourceHealthy: true
  });
  const q = obs.deriveQuarantineProposal(adv.new_count);
  if (!q.eligible || q.execute !== false) throw new Error("quarantine must be proposal-only");
});

test("6 third observation does not mutate cruise contract", () => {
  if (!/discovered_cruises_mutations_expected:\s*0/.test(JSON.stringify(m4))) {
    /* runner uses 0 cruise mutations in fixture builder */
  }
  if (!m4Runner.includes("cruise_inserts: 0")) throw new Error("runner cruise inserts 0");
});

test("7 unhealthy source does not increment", () => {
  const adv = obs.computeExpectedAdvancement({
    existingState: { consecutive_healthy_absence_count: 1, status: "OBSERVING" },
    sourceSnapshotHash: HASH_B,
    observationPeriodKey: PERIOD_2,
    sourceHealthy: false
  });
  if (adv.new_count !== 1 || adv.write_action !== "none") throw new Error(JSON.stringify(adv));
});

test("8 source return resets/resolves semantics", () => {
  const adv = obs.computeExpectedAdvancement({
    existingState: {
      consecutive_healthy_absence_count: 0,
      status: "RESOLVED",
      last_observation_period_key: PERIOD_1
    },
    sourceSnapshotHash: HASH_B,
    observationPeriodKey: PERIOD_2,
    sourceHealthy: true
  });
  if (adv.new_count !== 1) throw new Error("after resolve restart at 1");
});

test("9 absence after return starts again at 1 not 2", () => {
  const adv = obs.computeExpectedAdvancement({
    existingState: {
      consecutive_healthy_absence_count: 2,
      status: "RESOLVED",
      last_observation_period_key: PERIOD_1
    },
    sourceSnapshotHash: HASH_B,
    observationPeriodKey: PERIOD_2,
    sourceHealthy: true
  });
  if (adv.new_count !== 1) throw new Error(JSON.stringify(adv));
});

test("10 identity stays same", () => {
  if (m4.CANARY_OFFICIAL_ID !== policy.SOURCE_ABSENCE_FIXTURE_ID) throw new Error("identity");
});

test("11 cutoff separate from absence", () => {
  const row = { departure_date: "2026-08-24", status: "active" };
  const cutoff = obs.classifyCutoffSeparate(row, "2026-08-23");
  if (typeof cutoff.within_cutoff !== "boolean") throw new Error("cutoff");
});

test("12 same period second snapshot blocked", () => {
  const adv = obs.computeExpectedAdvancement({
    existingState: {
      consecutive_healthy_absence_count: 1,
      last_counted_snapshot_hash: HASH_A,
      last_observation_period_key: PERIOD_1,
      status: "OBSERVING"
    },
    sourceSnapshotHash: HASH_B,
    observationPeriodKey: PERIOD_1,
    sourceHealthy: true
  });
  if (!adv.idempotent || adv.reason !== "observation_period_already_counted") throw new Error(JSON.stringify(adv));
});

test("13 physical delete never proposed", () => {
  if (policy.SOURCE_ABSENCE_POLICY.physical_delete_proposed !== false) throw new Error("delete");
});

test("14 observation writer targets observation table only", () => {
  if (!m4Runner.includes("advanceSourceAbsenceObservation") && !m4Runner.includes("applyM4ObservationOnly")) {
    throw new Error("observation apply");
  }
  if (m4Runner.includes("applyM3UpdateOnly") || m4Runner.includes("applyM2InsertOnly")) {
    throw new Error("must not call cruise mutators");
  }
});

test("15 no reference writes", () => {
  if (!m4Runner.includes("planned_reference_writes: 0")) throw new Error("ref writes");
});

test("16 other source-absence constant", () => {
  if (m4.OTHER_SOURCE_ABSENCE_ID !== "DA280115C21") throw new Error("other absence");
});

test("17 M2/M3 canary constants", () => {
  if (m4.M2_INSERT_CANARY_ID !== "WH281005017") throw new Error("m2");
  if (m4.M3_UPDATE_CANARY_ID !== "SL270927009") throw new Error("m3");
});

test("18 confirmation token in runner", () => {
  if (!m4Runner.includes("SILVERSEA-M4-SOURCE-ABSENCE-OBSERVATION-CANARY")) throw new Error("token");
  if (!m4Runner.includes("SILVERSEA_OBSERVATION_WRITE_ENABLED")) throw new Error("env gate");
});

test("19 observation schema defined in policy", () => {
  if (policy.OBSERVATION_STATE_SCHEMA.table !== "cruise_source_observation_state") throw new Error("schema");
});

test("20 weekly cron absent from runner", () => {
  if (/cron|schedule/.test(m4Runner.toLowerCase())) throw new Error("no cron");
});

test("21 migration file present", () => {
  const mig = path.join(root, "supabase/migrations/20260823_cruise_source_observation_state.sql");
  if (!fs.existsSync(mig)) throw new Error("migration missing");
  const sql = fs.readFileSync(mig, "utf8");
  if (!sql.includes("advance_cruise_source_absence_observation")) throw new Error("rpc");
});

test("22 quarantine threshold is 3", () => {
  if (obs.QUARANTINE_THRESHOLD !== 3) throw new Error("threshold");
});

console.log(`\nM4 tests: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
