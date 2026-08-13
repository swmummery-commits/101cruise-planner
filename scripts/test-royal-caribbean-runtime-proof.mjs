#!/usr/bin/env node
/**
 * Royal Caribbean Prompt 9 — launcher/background/runtime-proof architecture tests.
 * No network / no production writes.
 *   npm run test:royal-caribbean-runtime-proof
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const proof = require(path.join(root, "netlify/functions/lib/royal-caribbean-runtime-proof"));
const dispatch = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance-dispatch"));
const resultStore = require(path.join(root, "netlify/functions/lib/royal-caribbean-runtime-result-store"));
const smoke = require(path.join(root, "netlify/functions/royal-caribbean-discovery-smoke"));
const background = require(path.join(root, "netlify/functions/royal-caribbean-weekly-maintenance-background"));
const proofLauncher = require(path.join(root, "netlify/functions/royal-caribbean-runtime-proof-launcher"));
const cronLauncher = require(path.join(root, "netlify/functions/royal-caribbean-weekly-maintenance-cron"));
const resultFn = require(path.join(root, "netlify/functions/royal-caribbean-runtime-proof-result"));
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

const BRANCH_HOST = proof.BRANCH_RUNTIME_PROOF_HOST;
const CONFIRMATION = proof.BRANCH_RUNTIME_PROOF_CONFIRMATION;
const PROOF_BODY = { mode: proof.BRANCH_RUNTIME_PROOF_MODE, confirmation: CONFIRMATION };

function branchEvent(extra = {}) {
  return {
    httpMethod: "POST",
    headers: { host: BRANCH_HOST, "content-type": "application/json" },
    body: JSON.stringify({ ...PROOF_BODY, ...extra }),
    ...extra
  };
}

test("1. smoke module exports handler", () => {
  if (typeof smoke.handler !== "function") throw new Error("smoke handler missing");
});

test("2. background worker exports handler", () => {
  if (typeof background.handler !== "function") throw new Error("background handler missing");
});

test("3. proof launcher exports handler", () => {
  if (typeof proofLauncher.handler !== "function") throw new Error("proof launcher missing");
});

test("4. cron launcher exports handler", () => {
  if (typeof cronLauncher.handler !== "function") throw new Error("cron launcher missing");
});

test("5. RC schedule uses launcher + background and remains unregistered", () => {
  const schedule = maintenance.MAINTENANCE_SCHEDULES.royal_caribbean_weekly;
  if (schedule.schedule_registered !== false) throw new Error("schedule must stay disabled");
  if (schedule.function !== "royal-caribbean-weekly-maintenance-cron") throw new Error(schedule.function);
  if (schedule.background_function !== "royal-caribbean-weekly-maintenance-background") {
    throw new Error(schedule.background_function);
  }
  const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
  const bgBlock =
    toml.match(/\[functions\."royal-caribbean-weekly-maintenance-background"\][\s\S]*?(?=\n\[|$)/)?.[0] || "";
  if (/^\s*schedule\s*=/m.test(bgBlock)) throw new Error("background must not be scheduled");
  const smokeBlock =
    toml.match(/\[functions\."royal-caribbean-discovery-smoke"\][\s\S]*?(?=\n\[|$)/)?.[0] || "";
  if (!/timeout\s*=\s*26/.test(smokeBlock)) throw new Error("smoke timeout must be bounded (26s)");
  if (/timeout\s*=\s*900/.test(smokeBlock)) throw new Error("misleading 900s smoke timeout must be removed");
});

test("6. branch host + proof mode allowed when enabled", () => {
  const env = { ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED: "true" };
  if (!proof.isBranchRuntimeProofRequest(branchEvent(), PROOF_BODY, env)) {
    throw new Error("expected branch proof request");
  }
  proof.assertBranchRuntimeProofAccess(branchEvent(), PROOF_BODY, env);
});

test("7. production host rejected", () => {
  const env = { ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED: "true" };
  const event = branchEvent({ headers: { host: proof.PRODUCTION_HOST } });
  try {
    proof.assertBranchRuntimeProofAccess(event, PROOF_BODY, env);
    throw new Error("expected rejection");
  } catch (error) {
    if (error.code !== "branch_runtime_proof_forbidden_on_production_host") throw error;
  }
});

test("8. unknown host rejected", () => {
  const env = { ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED: "true" };
  const event = branchEvent({ headers: { host: "other-branch.netlify.app" } });
  try {
    proof.assertBranchRuntimeProofAccess(event, PROOF_BODY, env);
    throw new Error("expected rejection");
  } catch (error) {
    if (error.code !== "branch_runtime_proof_host_mismatch") throw error;
  }
});

test("9. write/apply mode rejected on branch proof", () => {
  const env = { ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED: "true" };
  try {
    proof.assertBranchRuntimeProofAccess(branchEvent(), { ...PROOF_BODY, apply: true }, env);
    throw new Error("expected rejection");
  } catch (error) {
    if (error.code !== "branch_runtime_proof_write_mode_forbidden") throw error;
  }
});

test("10. branch proof disabled when env flag false", () => {
  const env = { ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED: "false" };
  try {
    proof.assertBranchRuntimeProofAccess(branchEvent(), PROOF_BODY, env);
    throw new Error("expected rejection");
  } catch (error) {
    if (error.code !== "branch_runtime_proof_disabled") throw error;
  }
});

test("11. cron auth required without branch proof", () => {
  try {
    proof.assertCronAuth({ headers: {} }, { DISCOVERY_CRON_SECRET: "abc" });
    throw new Error("expected unauthorized");
  } catch (error) {
    if (error.statusCode !== 401) throw error;
  }
});

test("12. dry-run default when weekly reconciliation disabled", () => {
  if (dispatch.resolveDryRun({}, {}) !== true) throw new Error("expected dry-run");
  if (dispatch.resolveDryRun(PROOF_BODY, {}) !== true) throw new Error("branch proof must force dry-run");
});

await testAsync("13. launcher dispatches without waiting for enumeration", async () => {
  const fetchImpl = async () => ({ status: 202, text: async () => "{}" });
  const started = Date.now();
  const kick = await dispatch.dispatchRoyalCaribbeanWeeklyBackground({
    dryRun: true,
    triggerType: "branch_runtime_proof",
    runId: "test-run",
    dispatchId: "test-dispatch",
    body: PROOF_BODY,
    env: { URL: `https://${BRANCH_HOST}` },
    fetchImpl
  });
  const elapsed = Date.now() - started;
  if (!kick.accepted) throw new Error("dispatch not accepted");
  if (elapsed > 500) throw new Error(`launcher path too slow: ${elapsed}ms`);
});

await testAsync("14. proof launcher returns 202 promptly", async () => {
  const originalFetch = global.fetch;
  const prevFlag = process.env.ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED;
  const prevUrl = process.env.URL;
  process.env.ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED = "true";
  process.env.URL = `https://${BRANCH_HOST}`;
  global.fetch = async () => ({ status: 202, text: async () => "{}" });
  try {
    const response = await proofLauncher.handler(branchEvent());
    const body = JSON.parse(response.body);
    if (response.statusCode !== 202) throw new Error(String(response.statusCode));
    if (body.ok !== true) throw new Error("expected ok");
    if (body.elapsed_ms > 500) throw new Error(`launcher too slow: ${body.elapsed_ms}ms`);
  } finally {
    global.fetch = originalFetch;
    if (prevFlag == null) delete process.env.ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED;
    else process.env.ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED = prevFlag;
    if (prevUrl == null) delete process.env.URL;
    else process.env.URL = prevUrl;
  }
});

test("15. compact runtime summary excludes secret keys", () => {
  const summary = proof.buildCompactRuntimeSummary(
    {
      ok: true,
      summary: {
        run_id: "r1",
        proposed_insert_sample: [],
        enumeration_health: { royal_caribbean_source_enumeration_ok: true },
        weekly_health: { weekly_maintenance_healthy: true, failures: [] }
      }
    },
    { run_id: "r1" }
  );
  const json = JSON.stringify(summary);
  if (/DISCOVERY_CRON_SECRET|service_role|x-discovery-cron-secret/i.test(json)) {
    throw new Error("secrets leaked into summary");
  }
  if (summary.actual_writes !== 0) throw new Error("actual_writes must be 0");
});

await testAsync("16. runtime result store round-trip", async () => {
  const runId = `test-runtime-${Date.now()}`;
  await resultStore.saveRuntimeProofResult(runId, { ok: true, actual_writes: 0, run_id: runId });
  const loaded = await resultStore.loadRuntimeProofResult(runId);
  if (!loaded || loaded.run_id !== runId) throw new Error("round-trip failed");
});

await testAsync("17. smoke rejects write mode via branch guard", async () => {
  const event = {
    httpMethod: "POST",
    headers: { host: BRANCH_HOST },
    body: JSON.stringify({ ...PROOF_BODY, perform_writes: true })
  };
  const env = { ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED: "true" };
  const prev = process.env.ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED;
  process.env.ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED = "true";
  try {
    try {
      proof.assertBranchRuntimeProofAccess(event, { ...PROOF_BODY, perform_writes: true }, env);
      throw new Error("expected write rejection at guard");
    } catch (error) {
      if (error.code !== "branch_runtime_proof_write_mode_forbidden") throw error;
    }
  } finally {
    if (prev == null) delete process.env.ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED;
    else process.env.ROYAL_CARIBBEAN_BRANCH_RUNTIME_PROOF_ENABLED = prev;
  }
});

test("18. discovery_cron_secret_present is boolean-only helper", () => {
  const present = proof.discoveryCronSecretPresent({ DISCOVERY_CRON_SECRET: "hidden" });
  if (present !== true) throw new Error("expected true");
  if (proof.discoveryCronSecretPresent({}) !== false) throw new Error("expected false");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
