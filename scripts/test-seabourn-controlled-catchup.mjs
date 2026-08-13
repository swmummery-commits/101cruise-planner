#!/usr/bin/env node
/**
 * Seabourn controlled catch-up safeguard tests.
 *   npm run test:seabourn-controlled-catchup
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import {
  parseArgs,
  assertApplyAllowed,
  assertBatchSize,
  resolveMaxBatchSize,
  selectDeterministicBatch,
  distributionFromBatch,
  buildRunContext,
  FIRST_BATCH_MAX,
  CATCHUP_MAX,
  CONTROLLED_BATCH_MAX,
  APPLY_CONFIRMATION_TOKEN
} from "./run-seabourn-first-production-batch.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const batchSrc = fs.readFileSync(path.join(root, "scripts/run-seabourn-first-production-batch.mjs"), "utf8");
const runnerSrc = fs.readFileSync(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"),
  "utf8"
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

test("hard cap CONTROLLED_BATCH_MAX is 100", () => {
  if (CONTROLLED_BATCH_MAX !== 100) throw new Error(`expected 100 got ${CONTROLLED_BATCH_MAX}`);
  if (!batchSrc.includes("CONTROLLED_BATCH_MAX = 100")) throw new Error("missing constant in source");
});

test("batch size 101 is rejected", () => {
  let threw = false;
  try {
    assertBatchSize(101, 120);
  } catch (error) {
    threw = /<= 100/.test(error.message);
  }
  if (!threw) throw new Error("expected rejection for batch size 101");
});

test("batch sizes 1, 20, 100 accepted for catch-up", () => {
  for (const size of [1, 20, 100]) {
    if (assertBatchSize(size, 120) !== size) throw new Error(`size ${size} not accepted`);
  }
});

test("first batch when active=0 capped at 20", () => {
  let threw = false;
  try {
    assertBatchSize(100, 0);
  } catch (error) {
    threw = /first batch/.test(error.message);
  }
  if (!threw) throw new Error("expected first-batch cap when active=0");
  if (assertBatchSize(20, 0) !== 20) throw new Error("20 should be allowed for first batch");
});

test("resolveMaxBatchSize returns 20 when active=0 and 100 when active>0", () => {
  if (resolveMaxBatchSize(0) !== FIRST_BATCH_MAX) throw new Error("first batch max");
  if (resolveMaxBatchSize(120) !== CATCHUP_MAX) throw new Error("catch-up max");
});

test("apply blocked without confirmation token", () => {
  let threw = false;
  try {
    assertApplyAllowed({ apply: true, confirm: "WRONG", batchSize: 20 }, 0);
  } catch (error) {
    threw = error.code === "weekly_apply_confirmation_required";
  }
  if (!threw) throw new Error("expected confirmation error");
});

test("apply blocked without SEABOURN_DISCOVERY_WRITE_ENABLED", () => {
  const prev = process.env.SEABOURN_DISCOVERY_WRITE_ENABLED;
  delete process.env.SEABOURN_DISCOVERY_WRITE_ENABLED;
  let threw = false;
  try {
    assertApplyAllowed(
      { apply: true, confirm: APPLY_CONFIRMATION_TOKEN, batchSize: 20 },
      0
    );
  } catch (error) {
    threw = error.code === "seabourn_discovery_write_disabled";
  } finally {
    if (prev != null) process.env.SEABOURN_DISCOVERY_WRITE_ENABLED = prev;
  }
  if (!threw) throw new Error("expected write flag error");
});

test("deterministic selection excludes non-inserts and sorts by identity", () => {
  const manifest = {
    products: [
      { proposed_action: "unchanged", stable_identity_key: "B|2" },
      { proposed_action: "insert_active", stable_identity_key: "C|3" },
      { proposed_action: "insert_active", stable_identity_key: "A|1" },
      { proposed_action: "update_exact_legacy_match", stable_identity_key: "D|4" }
    ]
  };
  const selected = selectDeterministicBatch(manifest, 10);
  if (selected.length !== 2) throw new Error("expected 2 inserts");
  if (selected[0].stable_identity_key !== "A|1") throw new Error("sort order");
});

test("insert-only apply rejects proposed updates; catch-up gate uses actionable absence", () => {
  if (!batchSrc.includes("proposed updates (insert-only batch)")) throw new Error("missing update guard");
  if (!batchSrc.includes("assessCatchUpPreflightGate")) throw new Error("missing catch-up gate");
  if (!batchSrc.includes("catch-up gate failed")) throw new Error("missing catch-up gate failure");
  if (batchSrc.includes("source-absent active records")) {
    throw new Error("stale coarse source-absent apply blocker still present");
  }
});

test("catch-up mode uses distinct trigger and report prefix when active>0", () => {
  const ctx = buildRunContext(120, true);
  if (!ctx.catchUp) throw new Error("expected catch-up");
  if (!ctx.triggerApply.includes("catchup")) throw new Error("catch-up trigger");
  if (!ctx.reportPrefix.includes("catchup")) throw new Error("catch-up report prefix");
});

test("first-batch mode when active=0", () => {
  const ctx = buildRunContext(0, false);
  if (ctx.catchUp) throw new Error("not catch-up");
  if (!ctx.triggerApply.includes("first")) throw new Error("first batch trigger");
});

test("no active>=20 stop guard remains for catch-up", () => {
  if (/active >= FIRST_BATCH_MAX/.test(batchSrc)) {
    throw new Error("stale first-batch-only stop guard still present");
  }
});

test("weekly maintenance still blocks large outstanding via write cap", () => {
  if (!runnerSrc.includes("SEABOURN_MAX_WEEKLY_WRITES")) throw new Error("missing weekly cap");
  if (!runnerSrc.includes("weekly_change_volume_exceeds_initial_cap")) throw new Error("missing cap reason");
});

test("distribution helper counts ships and product types", () => {
  const { shipDist, productDist } = distributionFromBatch([
    { ship: "Encore", product_type: "ocean" },
    { ship: "Encore", product_type: "combination" },
    { ship: "Quest", product_type: "ocean" }
  ]);
  if (shipDist.Encore !== 2 || shipDist.Quest !== 1) throw new Error("ship distribution");
  if (productDist.ocean !== 2 || productDist.combination !== 1) throw new Error("product distribution");
});

test("dry-run default when --apply omitted", () => {
  const args = parseArgs(["node", "script.mjs"]);
  if (!args.dryRun || args.apply) throw new Error("expected dry-run default");
});

console.log(`\n${passed} passed, 0 failed`);
