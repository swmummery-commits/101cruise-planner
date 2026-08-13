#!/usr/bin/env node
/**
 * Royal Caribbean weekly auth helpers — cron secret only (no branch proof).
 *   npm run test:royal-caribbean-weekly-auth
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const auth = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-auth"));
const dispatch = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance-dispatch"));
const smoke = require(path.join(root, "netlify/functions/royal-caribbean-discovery-smoke"));
const background = require(path.join(root, "netlify/functions/royal-caribbean-weekly-maintenance-background"));
const cronLauncher = require(path.join(root, "netlify/functions/royal-caribbean-weekly-maintenance-cron"));
const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message || String(error) });
    console.log(`✗ ${name} — ${error.message || error}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message || String(error) });
    console.log(`✗ ${name} — ${error.message || error}`);
  }
}

test("1. smoke module exports handler", () => {
  if (typeof smoke.handler !== "function") throw new Error("smoke handler missing");
});

test("2. background worker exports handler", () => {
  if (typeof background.handler !== "function") throw new Error("background handler missing");
});

test("3. cron launcher exports handler", () => {
  if (typeof cronLauncher.handler !== "function") throw new Error("cron launcher missing");
});

test("4. RC schedule uses launcher + background at 23:00 UTC", () => {
  const schedule = maintenance.MAINTENANCE_SCHEDULES.royal_caribbean_weekly;
  if (schedule.schedule_registered !== true) throw new Error("schedule must be registered after activation");
  if (schedule.cron_utc !== "0 23 * * 0") throw new Error("expected Sunday 23:00 UTC (after Seabourn 22:00)");
  if (schedule.function !== "royal-caribbean-weekly-maintenance-cron") throw new Error(schedule.function);
  if (schedule.background_function !== "royal-caribbean-weekly-maintenance-background") {
    throw new Error(schedule.background_function);
  }
  const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
  const bgBlock =
    toml.match(/\[functions\."royal-caribbean-weekly-maintenance-background"\][\s\S]*?(?=\n\[|$)/)?.[0] || "";
  if (/^\s*schedule\s*=/m.test(bgBlock)) throw new Error("background must not be scheduled");
  const cronBlock =
    toml.match(/\[functions\."royal-caribbean-weekly-maintenance-cron"\][\s\S]*?(?=\n\[|$)/)?.[0] || "";
  if (!/^\s*schedule\s*=\s*"0 23 \* \* 0"/m.test(cronBlock)) {
    throw new Error("cron block must enable Sunday 23:00 UTC schedule");
  }
});

test("5. cron auth required", () => {
  try {
    auth.assertCronAuth({ headers: {} }, { DISCOVERY_CRON_SECRET: "abc" });
    throw new Error("expected unauthorized");
  } catch (error) {
    if (error.statusCode !== 401) throw error;
  }
});

test("6. smoke auth uses cron secret only", () => {
  auth.assertSmokeAuth(
    { headers: { "x-discovery-cron-secret": "abc" } },
    { DISCOVERY_CRON_SECRET: "abc" }
  );
});

test("6b. smoke handler must not pass request body as auth env", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/royal-caribbean-discovery-smoke.js"), "utf8");
  if (/assertSmokeAuth\(event,\s*body\)/.test(src)) {
    throw new Error("smoke must call assertSmokeAuth(event) — body is not process.env");
  }
});

test("7. dry-run default when weekly reconciliation disabled", () => {
  if (dispatch.resolveDryRun({}, {}) !== true) throw new Error("expected dry-run");
});

test("8. discovery_cron_secret_present is boolean-only helper", () => {
  if (auth.discoveryCronSecretPresent({ DISCOVERY_CRON_SECRET: "hidden" }) !== true) {
    throw new Error("expected true");
  }
  if (auth.discoveryCronSecretPresent({}) !== false) throw new Error("expected false");
});

await testAsync("9. launcher dispatches without waiting for enumeration", async () => {
  const fetchImpl = async () => ({ status: 202, text: async () => "{}" });
  const started = Date.now();
  const kick = await dispatch.dispatchRoyalCaribbeanWeeklyBackground({
    dryRun: true,
    triggerType: "manual",
    runId: "test-run",
    dispatchId: "test-dispatch",
    env: { URL: "https://example.netlify.app", DISCOVERY_CRON_SECRET: "abc" },
    fetchImpl
  });
  const elapsed = Date.now() - started;
  if (!kick.accepted) throw new Error("dispatch not accepted");
  if (elapsed > 500) throw new Error(`launcher path too slow: ${elapsed}ms`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
