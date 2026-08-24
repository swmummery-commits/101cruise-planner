#!/usr/bin/env node
/**
 * Silversea weekly maintenance production tests — offline structure + planning.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const weekly = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance"));
const dispatch = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-dispatch"));
const netlifyToml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
const cronSrc = fs.readFileSync(path.join(root, "netlify/functions/silversea-weekly-maintenance-cron.js"), "utf8");
const bgSrc = fs.readFileSync(path.join(root, "netlify/functions/silversea-weekly-maintenance-background.js"), "utf8");

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

test("1 weekly ceilings conservative", () => {
  if (weekly.WEEKLY_CEILINGS.insert !== 1 || weekly.WEEKLY_CEILINGS.hide !== 0) throw new Error("ceilings");
});

test("2 action priority resolve before observation", () => {
  const orch = {
    gates: { source_healthy: true },
    observation_proposals: [
      { proposal: "OBSERVATION_INSERT_DUE", official_sailing_id: "DA280115C21" },
      { proposal: "OBSERVATION_RESOLVE_DUE", official_sailing_id: "ZZ000000001" }
    ],
    tables: { update_eligible: [], insert_eligible: [] }
  };
  const plan = weekly.selectBoundedWeeklyActions(orch);
  if (plan.actions[0]?.type !== weekly.ACTION_TYPE.RESOLVE) throw new Error(JSON.stringify(plan.actions));
});

test("3 unhealthy source blocks actions", () => {
  const plan = weekly.selectBoundedWeeklyActions({ gates: { source_healthy: false }, tables: {} });
  if (!plan.blocked) throw new Error("should block");
});

test("4 netlify schedule present", () => {
  if (!netlifyToml.includes("silversea-weekly-maintenance-cron")) throw new Error("cron");
  if (!/schedule = "0 4 \* \* 1"/.test(netlifyToml)) throw new Error("schedule slot");
});

test("5 cron dispatches background", () => {
  if (!cronSrc.includes("silversea-weekly-maintenance-background")) throw new Error("background");
});

test("6 background requires cron auth", () => {
  if (!bgSrc.includes("assertCronAuth")) throw new Error("auth");
});

test("7 apply mode blocked without confirm in runner", () => {
  const src = fs.readFileSync(path.join(root, "scripts/run-silversea-weekly-maintenance-production.mjs"), "utf8");
  if (!src.includes("SILVERSEA-WEEKLY-MAINTENANCE")) throw new Error("confirm");
});

test("8 M7B backfill script uses dedicated RPC for apply", () => {
  const src = fs.readFileSync(path.join(root, "scripts/run-silversea-m7b-m4b-historical-event-backfill.mjs"), "utf8");
  if (!src.includes("insert_m4b_historical_source_absence_observation_event")) throw new Error("rpc");
  if (!src.includes(`observationRpc(sb, RPC`)) throw new Error("apply rpc call");
});

test("9 weekly uses M6 orchestration not duplicate engine", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance.js"), "utf8");
  if (!src.includes("buildM6OrchestrationReport")) throw new Error("m6");
});

test("10 quarantine execution disabled", () => {
  if (weekly.WEEKLY_CEILINGS.hide !== 0) throw new Error("hide");
});

test("11 update protection excludes target uuid", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance.js"), "utf8");
  if (!src.includes("targetUuids")) throw new Error("targetUuids");
  if (!src.includes("action.proposal?.production_uuid")) throw new Error("update target uuid");
});

console.log(`\nWeekly production tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
