#!/usr/bin/env node
/**
 * Princess P3M false-failure + post-write lifecycle tests.
 *   node scripts/test-princess-p3m-post-write-lifecycle.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const cli = require(path.join(root, "netlify/functions/lib/princess-weekly-maintenance-cli"));
const lifecycle = require(path.join(root, "netlify/functions/lib/princess-accepted-baseline-lifecycle"));
const manifests = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-manifests"));
const recon = require(path.join(root, "netlify/functions/lib/princess-reconciliation-summary"));
const verification = require(path.join(root, "netlify/functions/lib/princess-post-write-verification"));
const princessLifecycle = require(path.join(root, "netlify/functions/lib/princess-weekly-post-write-lifecycle"));
const princessRollback = require(path.join(root, "netlify/functions/lib/princess-weekly-rollback-manifest"));
const quality = require(path.join(root, "netlify/functions/lib/princess-weekly-quality"));
const cron = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-cron"));

const runnerSrc = fs.readFileSync(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"),
  "utf8"
);
const applyScriptSrc = fs.readFileSync(path.join(root, "scripts/run-princess-weekly-maintenance.mjs"), "utf8");
const applyWorkflowSrc = fs.readFileSync(
  path.join(root, ".github/workflows/princess-weekly-maintenance-apply.yml"),
  "utf8"
);
const cronSrc = fs.readFileSync(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-cron.js"),
  "utf8"
);

const W39 = {
  insertedUuid: "ba3373b9-5fb0-4acf-a20d-5a558e8c53cc",
  officialSailingId: "FFA25B|CB|2028-02-24",
  manifestId: "773017ba-a894-410e-82ff-971520c8822c",
  snapshot: "c14b4a71d6ab513f885c16947c1b1d4eca8fb3897db85b5455fc662197143ddd",
  writeResult: {
    stats: {
      inserted: 1,
      updated: 0,
      failed: 0,
      write_details: [
        {
          discovered_cruise_id: "ba3373b9-5fb0-4acf-a20d-5a558e8c53cc",
          princess_sailing_id: "FFA25B|CB|2028-02-24",
          created: true,
          result_action: "inserted",
          rollback_before: null
        }
      ]
    }
  },
  rollbackManifest: {
    inserted: [
      {
        discovered_cruise_id: "ba3373b9-5fb0-4acf-a20d-5a558e8c53cc",
        official_sailing_id: "FFA25B|CB|2028-02-24",
        action: "insert",
        before_state: "ABSENT",
        before_values: null
      }
    ],
    updated: [],
    inserted_record_ids: ["ba3373b9-5fb0-4acf-a20d-5a558e8c53cc"],
    updated_record_ids: [],
    official_sailing_ids: ["FFA25B|CB|2028-02-24"]
  },
  postWriteSummary: {
    active_production_total: 1968,
    eligible_total: 1958,
    recognised_existing_eligible: 1958,
    outstanding_eligible_inserts: 0,
    proposed_updates: 0,
    proposed_identity_review_updates: 0,
    source_absent_active: 10,
    reconciliation_arithmetic_ok: true
  }
};

let passed = 0;
function test(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    throw new Error(`test "${name}" returned a promise; use testAsync`);
  }
  passed += 1;
  console.log(`✓ ${name}`);
}

async function testAsync(name, fn) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function memoryLockStore() {
  const rows = new Map();
  return async function supabase(restPath, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    if (restPath.startsWith("rpc/acquire_cruise_discovery_maintenance_lock")) {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      const key = body.p_lock_key;
      const existing = rows.get(key);
      const now = Date.now();
      if (existing && new Date(existing.expires_at).getTime() > now && existing.owner_id !== body.p_owner_id) {
        return { acquired: false, reason: "maintenance_lock_held", lock_key: key, owner_id: existing.owner_id };
      }
      const expires = new Date(now + (body.p_lease_seconds || 60) * 1000).toISOString();
      rows.set(key, { lock_key: key, owner_id: body.p_owner_id, expires_at: expires, run_id: body.p_run_id });
      return { acquired: true, lock_key: key, owner_id: body.p_owner_id, expires_at: expires };
    }
    if (restPath.startsWith("rpc/release_cruise_discovery_maintenance_lock")) return true;
    if (restPath.startsWith("cruise_discovery_maintenance_locks?lock_key=")) return [];
    return [];
  };
}

function healthyQualityGate() {
  return {
    passed: true,
    failures: [],
    source_accounting: { passed: true, accounting: { accounting_exact: true, accounting_delta: 0 } }
  };
}

function w39ApplyReport({
  verification = { ok: true },
  reconciliation = null,
  manifestValidation = { ok: true, manifest_record_count: 1 },
  executeSuccess = true
} = {}) {
  const postWriteReconciliation = reconciliation || cli.validatePostWriteReconciliation(W39.postWriteSummary);
  return cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    triggerType: "scheduled",
    startedAt: "2026-09-20T23:00:36.340Z",
    endedAt: "2026-09-20T23:00:54.036Z",
    environment: cli.classifyExecutionEnvironment(
      { GITHUB_ACTIONS: "true", RUNNER_NAME: "princess-local-mac", RUNNER_OS: "macOS" },
      { applyMode: true }
    ),
    executeResult: {
      success: executeSuccess,
      summary: {
        quality_gate: healthyQualityGate(),
        source_accounting: { passed: true, accounting: { accounting_exact: true, accounting_delta: 0 } },
        reconciliation_arithmetic_ok: true,
        eligible_total: 1958,
        active_production_total: 1968,
        recognised_existing_eligible: 1958,
        outstanding_eligible_inserts: 0,
        proposed_inserts: 0,
        proposed_updates: 0,
        inserts: 1,
        updates: 0,
        failed_writes: 0,
        write_attempts: 1,
        source_absent_active: 10,
        rollback_manifest_id: W39.manifestId,
        snapshot_id: W39.snapshot
      }
    },
    maintenanceResult: { ok: executeSuccess, summary: { inserts: 1, updates: 0, quality_gate: healthyQualityGate() } },
    countsBefore: { princess: 1967 },
    countsAfter: { princess: 1968 },
    writeAccounting: {
      accounting_ok: true,
      attempted: 1,
      committed: 1,
      genuinely_failed: 0,
      unchanged: 1958,
      source_absent_active: 10
    },
    manifestValidation,
    postWriteReconciliation,
    postWriteVerification: verification
  });
}

test("W39 collectInsertedRecordIds reads write_result.stats.write_details", () => {
  const ids = manifests.collectInsertedRecordIds({ writeResult: W39.writeResult });
  if (ids.length !== 1 || ids[0] !== W39.insertedUuid) {
    throw new Error(`expected ${W39.insertedUuid}, got ${JSON.stringify(ids)}`);
  }
});

test("W39 collectInsertedRecordIds ignores the wrong top-level write_details path", () => {
  const ids = manifests.collectInsertedRecordIds({
    writeResult: { write_details: [], stats: W39.writeResult.stats }
  });
  if (ids[0] !== W39.insertedUuid) throw new Error("canonical stats.write_details must win");
});

test("W39 collectInsertedRecordIds falls back to rollback inserted_record_ids", () => {
  const ids = manifests.collectInsertedRecordIds({
    writeResult: { stats: { write_details: [] } },
    rollbackManifest: W39.rollbackManifest
  });
  if (ids[0] !== W39.insertedUuid) throw new Error("manifest fallback missing");
});

test("committed insert with no verification UUID is a hard failure", () => {
  const targets = verification.evaluateInsertedVerificationTargets({
    committedInserts: 1,
    insertedIds: []
  });
  if (targets.ok || targets.reason !== "post_write_verification_targets_missing") {
    throw new Error(JSON.stringify(targets));
  }
});

test("W39 post-write reconciliation passes with explained source-absent actives", () => {
  const result = cli.validatePostWriteReconciliation(W39.postWriteSummary);
  if (!result.ok) throw new Error(JSON.stringify(result));
  if (result.unexplained_active_rows !== 0) throw new Error("expected 0 unexplained");
  if (result.source_absent_retained !== 10) throw new Error("source-absent must remain visible");
});

test("W39 all_active_recognised_in_eligible_source is not required for PASS", () => {
  const summary = recon.buildPrincessReconciliationSummary({
    activeProductionTotal: 1968,
    eligibleTotal: 1958,
    recognisedExistingEligible: 1958,
    outstandingEligibleInserts: 0,
    proposedUpdates: 0,
    sourceAbsentActive: 10
  });
  if (summary.all_active_recognised_in_eligible_source === true) {
    throw new Error("source-absent rows must not pretend all active are recognised eligible");
  }
  const result = cli.validatePostWriteReconciliation({
    ...W39.postWriteSummary,
    all_active_recognised_in_eligible_source: summary.all_active_recognised_in_eligible_source
  });
  if (!result.ok) throw new Error("explained source-absent must PASS");
});

test("unexplained active production row fails post-write reconciliation", () => {
  const result = cli.validatePostWriteReconciliation({
    ...W39.postWriteSummary,
    source_absent_active: 9
  });
  if (result.ok || result.reason !== "post_write_unexplained_active_rows") {
    throw new Error(JSON.stringify(result));
  }
});

test("outstanding eligible insert after write fails", () => {
  const result = cli.validatePostWriteReconciliation({
    ...W39.postWriteSummary,
    outstanding_eligible_inserts: 1,
    recognised_existing_eligible: 1957
  });
  if (result.ok || result.reason !== "post_write_outstanding_inserts") {
    throw new Error(JSON.stringify(result));
  }
});

test("remaining proposed update after write fails", () => {
  const result = cli.validatePostWriteReconciliation({
    ...W39.postWriteSummary,
    proposed_updates: 1,
    recognised_existing_eligible: 1957
  });
  if (result.ok || result.reason !== "post_write_unexpected_updates") {
    throw new Error(JSON.stringify(result));
  }
});

test("remaining identity-review update after write fails", () => {
  const result = cli.validatePostWriteReconciliation({
    ...W39.postWriteSummary,
    proposed_identity_review_updates: 1,
    recognised_existing_eligible: 1957
  });
  if (result.ok || result.reason !== "post_write_unexpected_identity_reviews") {
    throw new Error(JSON.stringify(result));
  }
});

test("W39 rollback manifest validation passes", () => {
  const result = cli.validateRollbackManifestIntegrity({
    rollbackResult: { manifest: W39.rollbackManifest },
    summary: { inserts: 1, updates: 0, rollback_manifest_id: W39.manifestId },
    writeResult: W39.writeResult
  });
  if (!result.ok || result.manifest_record_count !== 1) throw new Error(JSON.stringify(result));
});

test("W39 exact one-insert fixture completes with GitHub exit 0", () => {
  const report = w39ApplyReport();
  if (report.status !== "completed") throw new Error(`status ${report.status}`);
  if (cli.resolveWeeklyMaintenanceExitCode(report) !== 0) throw new Error("expected exit 0");
  if (report.environment.self_hosted_detected !== true) throw new Error("self-hosted must be detected from RUNNER_NAME");
  if (report.environment.source_environment !== "github_self_hosted_mac") {
    throw new Error(report.environment.source_environment);
  }
  const acceptance = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: report.executeResult?.summary || {
      quality_gate: healthyQualityGate(),
      source_accounting: { passed: true, accounting: { accounting_exact: true, accounting_delta: 0 } },
      inserts: 1,
      updates: 0,
      failed_writes: 0,
      rollback_manifest_id: W39.manifestId,
      eligible_total: 1958,
      snapshot_id: W39.snapshot,
      reconciliation_arithmetic_ok: true
    },
    executeResult: { success: true },
    report,
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (!acceptance.accept) throw new Error(JSON.stringify(acceptance.failures));
});

test("W39 fixture uses today's actual insert identity", () => {
  if (W39.officialSailingId !== "FFA25B|CB|2028-02-24") throw new Error("sailing id");
  if (W39.insertedUuid !== "ba3373b9-5fb0-4acf-a20d-5a558e8c53cc") throw new Error("uuid");
});

test("missing rollback manifest fails validation when commits exist", () => {
  const result = cli.validateRollbackManifestIntegrity({
    rollbackResult: { skipped: true, reason: "no_writes" },
    summary: { inserts: 1, updates: 0 },
    writeResult: { stats: { write_details: [] } }
  });
  if (result.ok) throw new Error("missing manifest must fail");
});

test("pre-apply rollback persist failure blocks material writes", () => {
  const princessFn = runnerSrc.slice(
    runnerSrc.indexOf("async function runPrincessWeeklyMaintenance"),
    runnerSrc.indexOf("async function runExploraWeeklyMaintenance")
  );
  const persistIdx = princessFn.indexOf("persistPrincessPreApplyRollbackManifest");
  const writeIdx = princessFn.indexOf("runGlobalProtectedMaintenanceWrites");
  if (persistIdx < 0 || writeIdx < 0 || persistIdx > writeIdx) {
    throw new Error("Princess must persist rollback evidence before material mutation");
  }
  if (!princessFn.includes("rollback_manifest_persist_failed")) {
    throw new Error("missing persist-failed hard stop");
  }
});

test("pre-apply insert before_state is ABSENT", () => {
  const manifest = princessRollback.buildPrincessPreApplyRollbackManifest({
    plannedWrites: [{ official_sailing_id: W39.officialSailingId, action: "insert" }],
    runId: "run",
    cruiseLineId: "line",
    lineSlug: "princess-cruises"
  });
  if (manifest.inserted[0].before_state !== "ABSENT") throw new Error("insert before_state");
  if (manifest.inserted[0].before_values !== null) throw new Error("insert before_values");
  if (manifest.pre_apply !== true) throw new Error("pre_apply flag");
});

test("pre-apply update captures previous-row snapshot", () => {
  const manifest = princessRollback.buildPrincessPreApplyRollbackManifest({
    plannedWrites: [
      {
        official_sailing_id: "OLD|ID|2027-01-01",
        action: "update",
        existing_record_id: "existing-1",
        existing_record: {
          id: "existing-1",
          status: "active",
          ship_id: "ship",
          departure_date: "2027-01-01",
          official_sailing_id: "OLD|ID|2027-01-01"
        }
      }
    ],
    runId: "run",
    cruiseLineId: "line",
    lineSlug: "princess-cruises"
  });
  if (!manifest.updated[0].before_values) throw new Error("missing update snapshot");
  if (manifest.updated[0].before_values.id !== "existing-1") throw new Error("snapshot id");
});

test("completed rollback manifest fills inserted UUID from write details", () => {
  const pre = princessRollback.buildPrincessPreApplyRollbackManifest({
    plannedWrites: [{ official_sailing_id: W39.officialSailingId, action: "insert" }],
    runId: "run"
  });
  const completed = princessRollback.completePrincessRollbackManifestWithWriteResult(pre, W39.writeResult);
  if (completed.inserted_record_ids[0] !== W39.insertedUuid) throw new Error("completed ids");
});

await testAsync("persist failure returns ok false before any write", async () => {
  const result = await princessRollback.persistPrincessPreApplyRollbackManifest(
    async () => [],
    {
      plannedWrites: [{ official_sailing_id: W39.officialSailingId, action: "insert" }],
      runId: "run"
    }
  );
  if (result.ok !== false || result.reason !== "rollback_manifest_persist_failed") {
    throw new Error(JSON.stringify(result));
  }
});

test("source health failure still produces 0 writes in apply reports", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    triggerType: "scheduled",
    startedAt: "2026-09-20T23:00:00.000Z",
    endedAt: "2026-09-20T23:00:01.000Z",
    environment: {},
    executeResult: { success: false, reason: "official_source_unreachable" },
    maintenanceResult: { failed: true, reason: "official_source_unreachable", simulation: { fetch_result: { fetch_failed: true } } },
    countsBefore: { princess: 1967 },
    countsAfter: { princess: 1967 }
  });
  if (report.writes_performed !== 0) throw new Error("source failure must not write");
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("source failure must fail");
});

test("duplicate official identity remains a quality-gate failure", () => {
  const gate = quality.evaluatePrincessWeeklyQualityGate({
    metrics: {
      eligible_total: 1958,
      ship_resolution_pct: 100,
      departure_port_resolution_pct: 100,
      destination_resolution_pct: 100,
      identity_coverage_pct: 100,
      duplicate_official_identities: 1
    },
    previousEligible: { stats: { eligible_total: 1958 } },
    manifest: { products: [] },
    dryRun: false,
    performWrites: true,
    simulation: { products: [] },
    summary: { eligible_total: 1958, incomplete_skipped: 0, within_public_cutoff_excluded: 0, cruisetours_excluded: 0 }
  });
  if (gate.passed) throw new Error("duplicate identity must fail");
  if (!gate.failures.includes("duplicate_official_identities")) throw new Error("missing duplicate failure");
});

test(">30 material writes remain review/controlled, not uncontrolled apply", () => {
  const cap = cli.assessWeeklyChangeVolumeCap(31, 0);
  if (cap.ok || cap.reason !== cli.WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP) throw new Error("31 must exceed cap");
  if (quality.PRINCESS_WEEKLY_WRITE_CAP !== 30) throw new Error("cap changed");
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    triggerType: "scheduled",
    startedAt: "2026-09-20T23:00:00.000Z",
    endedAt: "2026-09-20T23:00:01.000Z",
    environment: {},
    executeResult: {
      success: true,
      review_required: true,
      reason: cli.WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP,
      summary: { quality_gate: { passed: false, failures: ["princess_outstanding_inserts_exceed_weekly_cap"] } }
    },
    maintenanceResult: { review_required: true },
    countsBefore: { princess: 1967 },
    countsAfter: { princess: 1967 }
  });
  if (report.status !== "review_required") throw new Error(report.status);
  if (report.writes_performed !== 0) throw new Error("cap exceed must not write");
});

test("self-hosted detection uses RUNNER_NAME when RUNNER_LABELS is empty", () => {
  const env = cli.classifyExecutionEnvironment(
    { GITHUB_ACTIONS: "true", RUNNER_NAME: "princess-local-mac", RUNNER_OS: "macOS" },
    { applyMode: true }
  );
  if (!env.self_hosted_detected) throw new Error("RUNNER_NAME must detect self-hosted");
  if (env.source_environment !== "github_self_hosted_mac") throw new Error(env.source_environment);
  cli.assertWeeklyApplyEnvironment({
    GITHUB_ACTIONS: "true",
    RUNNER_NAME: "princess-local-mac",
    RUNNER_OS: "macOS",
    PRINCESS_WEEKLY_RECONCILIATION_ENABLED: "true"
  });
});

test("github-hosted APPLY remains forbidden", () => {
  let threw = false;
  try {
    cli.assertWeeklyApplyEnvironment({
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Linux",
      ImageOS: "ubuntu22"
    });
  } catch (error) {
    threw = error.code === "weekly_apply_cloud_hosted_forbidden";
  }
  if (!threw) throw new Error("github-hosted must stay forbidden");
});

test("today's 120-minute GitHub delay is WARN only", () => {
  const delay = cli.evaluatePrincessScheduleObservability({
    eventName: "schedule",
    cron: "0 21 * * 0",
    actualStartedAt: "2026-09-20T23:00:10Z"
  });
  if (delay.delay_minutes !== 120) throw new Error(`delay ${delay.delay_minutes}`);
  if (delay.severity !== "warn") throw new Error(delay.severity);
  if (delay.inventory_failure !== false) throw new Error("delay must not fail inventory");
  const report = w39ApplyReport();
  report.schedule_observability = delay;
  if (cli.resolveWeeklyMaintenanceExitCode(report) !== 0) throw new Error("delay must not change exit code");
  const summary = cli.buildGitHubJobSummary(report);
  if (!summary.includes("Schedule delay")) throw new Error("job summary should show delay warn");
});

test("apply workflow cron is unchanged", () => {
  if (!applyWorkflowSrc.includes('cron: "0 21 * * 0"')) throw new Error("cron changed");
  if (!applyWorkflowSrc.includes("PRINCESS_SCHEDULE_CRON")) throw new Error("missing schedule observability env");
  if (!applyWorkflowSrc.includes("Observe GitHub schedule delay")) throw new Error("missing delay step");
});

test("apply CLI finalises through shared post-write lifecycle", () => {
  if (!applyScriptSrc.includes("postWriteLifecycle")) throw new Error("CLI must pass postWriteLifecycle");
  if (!applyScriptSrc.includes("completePrincessApplyPostWriteLifecycle")) {
    throw new Error("CLI must use shared post-write helper");
  }
  if (applyScriptSrc.includes("write_result?.write_details")) {
    throw new Error("CLI must not keep the broken top-level write_details path");
  }
  if (!cronSrc.includes("postWriteLifecycle")) throw new Error("executeWeeklyMaintenance must accept the hook");
});

await testAsync("ledger finalises after post-write lifecycle failure", async () => {
  const order = [];
  const finalized = [];
  const base = memoryLockStore();
  const sb = async (restPath, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (restPath === "cruise_discovery_runs" && method === "POST") {
      return [{ id: "run-p3m", status: "running" }];
    }
    if (restPath.startsWith("cruise_discovery_runs?") && method === "PATCH") {
      finalized.push(JSON.parse(options.body));
      return [];
    }
    if (restPath === "cruise_discovery_maintenance_manifests" && method === "POST") return [];
    return base(restPath, options);
  };
  const result = await cron.executeWeeklyMaintenance({
    lineSlug: "princess-cruises",
    cruiseLineId: "c19f40a7-c160-4035-a845-14dada550e1f",
    runType: "princess_weekly_maintenance",
    assertEnabled: () => {},
    dryRun: false,
    supabaseClient: sb,
    runMaintenance: async () => {
      order.push("write");
      return {
        ok: true,
        summary: {
          inserts: 1,
          updates: 0,
          failed_writes: 0,
          inventory_changed: true,
          quality_gate: healthyQualityGate(),
          rollback_manifest_id: W39.manifestId
        },
        write_result: W39.writeResult,
        rollback_manifest: W39.rollbackManifest
      };
    },
    postWriteLifecycle: async () => {
      order.push("post_write");
      return { ok: false, reason: "post_write_verification_targets_missing" };
    }
  });
  if (result.success !== false) throw new Error("post-write failure must fail executeWeeklyMaintenance");
  if (finalized[0]?.status !== "failed") throw new Error(`ledger ${finalized[0]?.status}`);
  if (order.join(">") !== "write>post_write") throw new Error(order.join(">"));
});

await testAsync("healthy post-write lifecycle completes ledger and execute together", async () => {
  const finalized = [];
  const base = memoryLockStore();
  const sb = async (restPath, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (restPath === "cruise_discovery_runs" && method === "POST") {
      return [{ id: "run-p3m-ok", status: "running" }];
    }
    if (restPath.startsWith("cruise_discovery_runs?") && method === "PATCH") {
      finalized.push(JSON.parse(options.body));
      return [];
    }
    if (restPath === "cruise_discovery_maintenance_manifests" && method === "POST") return [];
    return base(restPath, options);
  };
  const result = await cron.executeWeeklyMaintenance({
    lineSlug: "princess-cruises",
    cruiseLineId: "c19f40a7-c160-4035-a845-14dada550e1f",
    runType: "princess_weekly_maintenance",
    assertEnabled: () => {},
    dryRun: false,
    supabaseClient: sb,
    runMaintenance: async () => ({
      ok: true,
      summary: {
        inserts: 1,
        updates: 0,
        failed_writes: 0,
        inventory_changed: true,
        quality_gate: healthyQualityGate(),
        rollback_manifest_id: W39.manifestId
      },
      write_result: W39.writeResult,
      rollback_manifest: W39.rollbackManifest
    }),
    postWriteLifecycle: async () => ({
      ok: true,
      manifest_validation: { ok: true },
      post_write_verification: { ok: true },
      post_write_reconciliation: { ok: true }
    })
  });
  if (result.success !== true) throw new Error("healthy lifecycle must succeed");
  if (finalized[0]?.status !== "completed") throw new Error(`ledger ${finalized[0]?.status}`);
  if (result.post_write_verification?.ok !== true) throw new Error("missing verification on result");
});

await testAsync("completePrincessApplyPostWriteLifecycle fails when insert IDs are missing", async () => {
  const missing = await princessLifecycle.completePrincessApplyPostWriteLifecycle({
    summary: { inserts: 1, updates: 0, rollback_manifest_id: W39.manifestId },
    writeResult: { stats: { inserted: 1, write_details: [] } },
    rollbackManifest: { inserted: [], inserted_record_ids: [], updated: [] },
    rollbackResult: {
      manifest: {
        inserted: [{ discovered_cruise_id: null, official_sailing_id: W39.officialSailingId }],
        updated: [],
        inserted_record_ids: []
      }
    },
    fetchInsertedRows: async () => [],
    runPostWriteReconciliationDryRun: async () => ({ ok: true, summary: W39.postWriteSummary })
  });
  if (missing.ok !== false || missing.reason !== "post_write_verification_targets_missing") {
    throw new Error(JSON.stringify(missing));
  }
});

await testAsync("completePrincessApplyPostWriteLifecycle passes the W39 one-insert case", async () => {
  const result = await princessLifecycle.completePrincessApplyPostWriteLifecycle({
    summary: { inserts: 1, updates: 0, rollback_manifest_id: W39.manifestId },
    writeResult: W39.writeResult,
    rollbackManifest: W39.rollbackManifest,
    rollbackResult: { manifest: W39.rollbackManifest },
    fetchInsertedRows: async (_sb, ids) => {
      if (ids[0] !== W39.insertedUuid) throw new Error("wrong id");
      return [
        {
          id: W39.insertedUuid,
          cruise_line_id: verification.PRINCESS_LINE_ID,
          status: "active",
          official_sailing_id: W39.officialSailingId,
          ship_id: "ship",
          destination_id: "dest",
          departure_port: "Fort Lauderdale",
          official_url: "https://www.princess.com/cruise/FFA25B",
          departure_date: "2028-02-24",
          raw_extract: {}
        }
      ];
    },
    runPostWriteReconciliationDryRun: async () => ({ ok: true, summary: W39.postWriteSummary })
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  if (!result.post_write_verification.ok) throw new Error("verification");
  if (!result.post_write_reconciliation.ok) throw new Error("reconciliation");
  if (!result.manifest_validation.ok) throw new Error("manifest");
});

console.log(`\ntest-princess-p3m-post-write-lifecycle: ${passed} passed`);
