#!/usr/bin/env node
/**
 * Cross-line weekly maintenance reliability contract tests.
 * No production writes.
 *   node scripts/test-weekly-maintenance-reliability-p0.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const tracking = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const contract = require(path.join(root, "netlify/functions/lib/weekly-maintenance-result-contract"));
const schedule = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control"));
const stale = require(path.join(root, "netlify/functions/lib/weekly-maintenance-stale-runs"));
const princessQuality = require(path.join(root, "netlify/functions/lib/princess-weekly-quality"));
const princessPolicy = require(path.join(root, "netlify/functions/lib/princess-weekly-update-policy"));
const princessCli = require(path.join(root, "netlify/functions/lib/princess-weekly-maintenance-cli"));
const seabournRec = require(path.join(root, "netlify/functions/lib/seabourn-reconciliation-summary"));
const princessRec = require(path.join(root, "netlify/functions/lib/princess-reconciliation-summary"));
const ncl = require(path.join(root, "netlify/functions/lib/norwegian-weekly-maintenance"));
const ccl = require(path.join(root, "netlify/functions/lib/carnival-weekly-maintenance"));
const carnivalMode = require(path.join(root, "netlify/functions/lib/carnival-discovery-mode"));
const cron = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-cron"));
const adminJs = fs.readFileSync(path.join(root, "js/admin-cruise-discovery.js"), "utf8");
const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");

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

function tomlBlock(name) {
  return toml.match(new RegExp(`\\[functions\\."${name}"\\][\\s\\S]*?(?=\\n\\[|$)`))?.[0] || "";
}

const CATALOGUE_FILES = [
  "data/ports/ports-catalogue.csv",
  "data/cruise-finder-v2/ci-cruise-lines-snapshot.csv",
  "data/cruise-finder-v2/ci-cruise-ships-snapshot.csv"
];

test("HAL background packaging includes ports catalogue", () => {
  const block = tomlBlock("hal-weekly-maintenance-background");
  for (const file of CATALOGUE_FILES) {
    if (!block.includes(file)) throw new Error(`missing ${file}`);
  }
  const cronBlock = tomlBlock("hal-weekly-maintenance-cron");
  if (!/timeout\s*=\s*26/.test(cronBlock)) throw new Error("HAL launcher must stay thin");
  if (!fs.existsSync(path.join(root, "netlify/functions/hal-weekly-maintenance-background.js"))) {
    throw new Error("missing HAL background function");
  }
});

test("Celebrity background packaging includes ports catalogue", () => {
  const block = tomlBlock("celebrity-weekly-maintenance-background");
  for (const file of CATALOGUE_FILES) {
    if (!block.includes(file)) throw new Error(`missing ${file}`);
  }
});

test("Princess Netlify weekly cron is unscheduled", () => {
  const block = tomlBlock("princess-weekly-maintenance-cron");
  if (/schedule\s*=/.test(block)) throw new Error("Princess Netlify schedule must be removed");
  if (maintenance.MAINTENANCE_SCHEDULES.princess_weekly.netlify_schedule_enabled !== false) {
    throw new Error("princess netlify_schedule_enabled");
  }
});

function memoryLockStore() {
  const rows = new Map();
  return async function supabase(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    if (path.startsWith("rpc/acquire_cruise_discovery_maintenance_lock")) {
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
    if (path.startsWith("rpc/release_cruise_discovery_maintenance_lock")) {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      const existing = rows.get(body.p_lock_key);
      if (existing?.owner_id === body.p_owner_id) rows.delete(body.p_lock_key);
      return true;
    }
    if (path.startsWith("cruise_discovery_maintenance_locks?lock_key=")) {
      const key = decodeURIComponent(path.split("eq.")[1].split("&")[0]);
      const row = rows.get(key);
      if (method === "GET") return row ? [row] : [];
      if (method === "DELETE") {
        rows.delete(key);
        return [];
      }
    }
    if (path === "cruise_discovery_maintenance_locks" && method === "POST") {
      const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      rows.set(body.lock_key, body);
      return [body];
    }
    if (path.startsWith("cruise_discovery_runs")) {
      if (method === "GET") return [];
      if (method === "POST") return [{ id: "run-1", status: "running", stats: {} }];
      return [];
    }
    return [];
  };
}

await testAsync("duplicate weekly launcher same line/week dispatches once", async () => {
  const sb = memoryLockStore();
  const first = await schedule.claimScheduledDispatchLease(sb, {
    periodKey: schedule.scheduledWeeklyDispatchKey("explora-journeys", new Date("2026-08-31T00:00:00+08:00")),
    ownerId: "dispatch-a",
    triggerType: "scheduled"
  });
  const second = await schedule.claimScheduledDispatchLease(sb, {
    periodKey: schedule.scheduledWeeklyDispatchKey("explora-journeys", new Date("2026-08-31T00:00:00+08:00")),
    ownerId: "dispatch-b",
    triggerType: "scheduled"
  });
  if (!first.claimed) throw new Error("first must claim");
  if (!second.already_dispatched) throw new Error("second must already-dispatch");
});

await testAsync("different week dispatches normally", async () => {
  const sb = memoryLockStore();
  const a = await schedule.claimScheduledDispatchLease(sb, {
    periodKey: schedule.scheduledWeeklyDispatchKey("explora-journeys", new Date("2026-08-24T00:00:00+08:00")),
    ownerId: "w1",
    triggerType: "scheduled"
  });
  const b = await schedule.claimScheduledDispatchLease(sb, {
    periodKey: schedule.scheduledWeeklyDispatchKey("explora-journeys", new Date("2026-08-31T00:00:00+08:00")),
    ownerId: "w2",
    triggerType: "scheduled"
  });
  if (!a.claimed || !b.claimed) throw new Error("different weeks must both claim");
});

await testAsync("manual authorised rerun remains possible", async () => {
  const sb = memoryLockStore();
  await schedule.claimScheduledDispatchLease(sb, {
    periodKey: schedule.scheduledWeeklyDispatchKey("explora-journeys"),
    ownerId: "sched",
    triggerType: "scheduled"
  });
  const manual = await schedule.claimScheduledDispatchLease(sb, {
    periodKey: schedule.scheduledWeeklyDispatchKey("explora-journeys"),
    ownerId: "manual",
    triggerType: "manual"
  });
  if (!manual.claimed || manual.skipped !== true) throw new Error("manual must skip lease");
});

await testAsync("daily expiry duplicate same Perth date is idempotent", async () => {
  const sb = memoryLockStore();
  const key = schedule.scheduledDailyExpiryDispatchKey(new Date("2026-08-31T01:30:00+08:00"));
  const first = await schedule.claimScheduledDispatchLease(sb, {
    periodKey: key,
    ownerId: "exp-1",
    triggerType: "scheduled",
    leaseSeconds: schedule.DAILY_DISPATCH_LEASE_SECONDS
  });
  const second = await schedule.claimScheduledDispatchLease(sb, {
    periodKey: key,
    ownerId: "exp-2",
    triggerType: "scheduled",
    leaseSeconds: schedule.DAILY_DISPATCH_LEASE_SECONDS
  });
  if (!first.claimed || !second.already_dispatched) throw new Error("same Perth date must dedupe");
});

await testAsync("stale running run with expired lock becomes abandoned", async () => {
  const runs = [
    {
      id: "stale-1",
      status: "running",
      started_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      stats: { run_type: "hal_weekly_maintenance", run_id: "old" }
    }
  ];
  const patched = [];
  const sb = async (p, options = {}) => {
    if (p.startsWith("cruise_discovery_maintenance_locks")) {
      return [
        {
          lock_key: "holland-america-line:weekly",
          owner_id: "old",
          run_id: "old",
          expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
        }
      ];
    }
    if (p.startsWith("cruise_discovery_runs?") && (options.method || "GET") === "GET") return runs;
    if (p.startsWith("cruise_discovery_runs?") && options.method === "PATCH") {
      patched.push(JSON.parse(options.body));
      return [];
    }
    if (p.startsWith("rpc/")) return null;
    return [];
  };
  const result = await stale.reconcileAbandonedMaintenanceRuns(sb, {
    lineSlug: "holland-america-line",
    runType: "hal_weekly_maintenance"
  });
  if (result.abandoned.length !== 1) throw new Error(`expected 1 abandoned got ${result.abandoned.length}`);
  if (patched[0]?.error_message !== "maintenance_worker_terminated_or_lease_expired") {
    throw new Error("must persist abandon reason");
  }
  if (patched[0]?.status !== "failed") throw new Error("must not invent success");
});

await testAsync("valid running lock is not touched", async () => {
  const runId = "live-run";
  const sb = async (p, options = {}) => {
    if (p.startsWith("cruise_discovery_maintenance_locks")) {
      return [
        {
          lock_key: "holland-america-line:weekly",
          owner_id: runId,
          run_id: runId,
          run_record_id: "live-1",
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
        }
      ];
    }
    if (p.startsWith("cruise_discovery_runs?") && (options.method || "GET") === "GET") {
      return [
        {
          id: "live-1",
          status: "running",
          started_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          stats: { run_type: "hal_weekly_maintenance", run_id: runId }
        }
      ];
    }
    if (options.method === "PATCH") throw new Error("must not patch valid lock run");
    return [];
  };
  const result = await stale.reconcileAbandonedMaintenanceRuns(sb, {
    lineSlug: "holland-america-line",
    runType: "hal_weekly_maintenance"
  });
  if (result.abandoned.length) throw new Error("valid lock must not be abandoned");
  if (!result.skipped.some((s) => s.reason === "valid_running_lock")) throw new Error("expected skip");
});

test("Princess identity-review returns review_required, not failure", () => {
  if (!princessQuality.isPrincessReviewRequiredOnly({ reason: "identity_critical_updates_require_review" })) {
    throw new Error("reason must be review-required");
  }
  if (
    !princessQuality.isPrincessReviewRequiredOnly({
      qualityGateFailures: ["identity_critical_updates_require_review"]
    })
  ) {
    throw new Error("quality failure must be review-required");
  }
});

test("Princess review_required exits success with zero writes", () => {
  const report = princessCli.buildWeeklyMaintenanceReport({
    mode: "apply",
    startedAt: "2026-08-31T00:00:00.000Z",
    endedAt: "2026-08-31T00:01:00.000Z",
    environment: princessCli.classifyExecutionEnvironment({}),
    executeResult: {
      success: true,
      review_required: true,
      reason: "identity_critical_updates_require_review",
      summary: { quality_gate: { passed: false, failures: ["identity_critical_updates_require_review"], review_required: true } }
    },
    maintenanceResult: {
      ok: false,
      review_required: true,
      summary: { quality_gate: { passed: false, failures: ["identity_critical_updates_require_review"], review_required: true } }
    },
    countsBefore: { princess: 2022 },
    countsAfter: { princess: 2022 }
  });
  if (report.status !== "review_required") throw new Error(report.status);
  if (princessCli.resolveWeeklyMaintenanceExitCode(report) !== 0) throw new Error("exit must be 0");
  if (report.writes_performed !== 0) throw new Error("writes must be 0");
  const summary = princessCli.buildGitHubJobSummary(report);
  if (!summary.includes("REVIEW REQUIRED — NO WRITES")) throw new Error(summary);
});

test("Princess true technical error still fails", () => {
  const report = princessCli.buildWeeklyMaintenanceReport({
    mode: "apply",
    startedAt: "2026-08-31T00:00:00.000Z",
    endedAt: "2026-08-31T00:01:00.000Z",
    environment: princessCli.classifyExecutionEnvironment({}),
    executeResult: { success: false, reason: "official_source_unreachable", summary: { quality_gate: { passed: false, failures: ["source_unreachable"] } } },
    maintenanceResult: { ok: false, summary: { quality_gate: { passed: false, failures: ["source_unreachable"] } } },
    countsBefore: { princess: 2022 },
    countsAfter: { princess: 2022 }
  });
  if (report.status !== "failed") throw new Error(report.status);
  if (princessCli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("technical failure must be non-zero");
});

const princessBase = {
  official_sailing_id: "SBR17A|MJ|2027-01-06",
  external_key: "ext1",
  identity_key: "id1",
  ship_id: "ship1",
  destination_id: "dest1",
  departure_date: "2027-01-06",
  return_date: "2027-01-23",
  nights: 17,
  departure_port: "Buenos Aires",
  status: "active",
  official_url: "https://example.com/a",
  itinerary: "Antarctica & South America",
  raw_extract: { princess_itinerary_name: "Antarctica & South America" }
};

test("Princess itinerary-only rename safe ONLY after all protected fields match", () => {
  const candidate = {
    ...princessBase,
    itinerary: "Antarctica & Patagonia",
    raw_extract: { princess_itinerary_name: "Antarctica & Patagonia" }
  };
  const action = princessPolicy.refinePrincessProposedActionForWeekly(
    "update_exact_legacy_match",
    princessBase,
    candidate
  );
  if (action !== "update_safe_metadata_allowed") throw new Error(action);
});

test("Princess itinerary + date change remains review", () => {
  const action = princessPolicy.refinePrincessProposedActionForWeekly("update_exact_legacy_match", princessBase, {
    ...princessBase,
    itinerary: "Antarctica & Patagonia",
    departure_date: "2027-01-07",
    raw_extract: { princess_itinerary_name: "Antarctica & Patagonia" }
  });
  if (action !== "update_identity_review_required") throw new Error(action);
});

test("Princess itinerary + ship change remains review", () => {
  const action = princessPolicy.refinePrincessProposedActionForWeekly("update_exact_legacy_match", princessBase, {
    ...princessBase,
    itinerary: "Antarctica & Patagonia",
    ship_id: "other",
    raw_extract: { princess_itinerary_name: "Antarctica & Patagonia" }
  });
  if (action !== "update_identity_review_required") throw new Error(action);
});

test("Seabourn identity-review candidate included in reconciliation arithmetic", () => {
  const rec = seabournRec.buildSeabournReconciliationSummary({
    eligibleTotal: 689,
    recognisedExistingEligible: 687,
    outstandingEligibleInserts: 1,
    proposedUpdates: 0,
    proposedIdentityReviewUpdates: 1,
    activeProductionTotal: 689,
    sourceAbsentActive: 1,
    sourceAbsentRetained: 1
  });
  if (!rec.reconciliation_arithmetic_ok) throw new Error("687+1+1 must equal 689");
  if (!rec.active_production_arithmetic_ok) throw new Error("687 recognised + 1 review + 1 retained must equal 689 active");
  if (rec.proposed_identity_review_updates !== 1) throw new Error("review bucket missing");
});

test("Princess identity-review candidate included in reconciliation arithmetic", () => {
  const rec = princessRec.buildPrincessReconciliationSummary({
    eligibleTotal: 2021,
    recognisedExistingEligible: 2006,
    outstandingEligibleInserts: 9,
    proposedUpdates: 0,
    proposedIdentityReviewUpdates: 6,
    activeProductionTotal: 2022,
    sourceAbsentActive: 10
  });
  if (!rec.reconciliation_arithmetic_ok) throw new Error("2006+9+6 must equal 2021");
  if (rec.proposed_identity_review_updates !== 6) throw new Error("review bucket missing");
});

test("shared runner rejects malformed result contract", () => {
  let threw = false;
  try {
    contract.assertWeeklyRunnerResult({ success: true }, "norwegian-cruise-line");
  } catch (error) {
    threw = error.code === "weekly_runner_invalid_ok_contract";
  }
  if (!threw) throw new Error("undefined ok must be rejected");
});

test("NCL valid result exposes ok=true and success=true", () => {
  const result = contract.buildWeeklyRunnerResult({ ok: true, success: true, summary: { success: true } });
  if (result.ok !== true || result.success !== true) throw new Error(JSON.stringify(result));
});

test("NCL failed result exposes ok=false and success=false", () => {
  const result = contract.buildWeeklyRunnerResult({
    ok: false,
    success: false,
    reason: "weekly_maintenance_failed"
  });
  if (result.ok !== false || result.success !== false) throw new Error(JSON.stringify(result));
});

test("Carnival same contract builder", () => {
  const ok = contract.buildWeeklyRunnerResult({ ok: true, success: true });
  const bad = contract.buildWeeklyRunnerResult({ ok: false, success: false, reason: "quality_gate_failed" });
  if (!ok.ok || bad.ok !== false) throw new Error("carnival contract");
});

test("Carnival disabled write flag fails clearly/read-only", () => {
  const prev = process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED;
  process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED = "false";
  try {
    const gate = carnivalMode.resolveCarnivalDiscoveryMode("weekly_maintenance");
    if (gate.writes_allowed) throw new Error("writes must stay disabled");
    let threw = false;
    try {
      carnivalMode.assertCarnivalWritesAllowed(gate);
    } catch (error) {
      threw = /CARNIVAL_DISCOVERY_WRITE_ENABLED/.test(error.message);
    }
    if (!threw) throw new Error("must fail clearly");
  } finally {
    if (prev == null) delete process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED;
    else process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED = prev;
  }
});

test("Royal source unhealthy always zero writes documented in runner health", () => {
  const src = [
    fs.readFileSync(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-health.js"), "utf8"),
    fs.readFileSync(path.join(root, "netlify/functions/lib/royal-caribbean-reconciliation-summary.js"), "utf8")
  ].join("\n");
  if (!/source_enumeration_unhealthy/.test(src)) {
    throw new Error("RC must keep enumeration health gate");
  }
});

test("Disney destination unresolved always zero writes / 100% gate remains", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/disney-weekly-quality.js"), "utf8");
  if (!/destination_resolution_below_100/.test(src)) throw new Error("Disney 100% destination gate missing");
});

test("Silversea central run lifecycle persisted", () => {
  if (maintenance.SILVERSEA_WEEKLY_MAINTENANCE_RUN_TYPE !== "silversea_weekly_maintenance") {
    throw new Error("missing silversea run type");
  }
  if (!maintenance.MAINTENANCE_SCHEDULES.silversea_weekly) throw new Error("missing schedule");
  const dispatch = fs.readFileSync(
    path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-dispatch.js"),
    "utf8"
  );
  if (!dispatch.includes("executeWeeklyMaintenance")) throw new Error("Silversea must persist via shared lifecycle");
});

test("Admin dashboard includes every commissioned line", () => {
  const keys = tracking.COMMISSIONED_WEEKLY_LINES.map((l) => l.dashboardKey);
  const expected = [
    "hal",
    "celebrity",
    "princess",
    "explora",
    "seabourn",
    "royal_caribbean",
    "norwegian",
    "carnival",
    "disney",
    "azamara",
    "silversea"
  ];
  for (const key of expected) {
    if (!keys.includes(key)) throw new Error(`dashboard missing ${key}`);
  }
  if (!adminJs.includes("renderMaintenancePanel") || !adminJs.includes("m.lines")) {
    throw new Error("admin UI must render all commissioned lines");
  }
  if (!adminJs.includes("top_level_warning")) throw new Error("missing overdue warning");
});

test("blocked/review/dry_run are not genuine successful refreshes", () => {
  if (tracking.isGenuineSuccessfulRefresh({ status: "completed", stats: { dry_run: true } })) {
    throw new Error("dry_run counted");
  }
  if (tracking.isGenuineSuccessfulRefresh({ status: "completed", stats: { blocked_by_lock: true } })) {
    throw new Error("blocked counted");
  }
  if (tracking.isGenuineSuccessfulRefresh({ status: "completed", stats: { review_required: true } })) {
    throw new Error("review counted");
  }
  if (!tracking.isGenuineSuccessfulRefresh({ status: "completed", stats: { inserts: 2 } })) {
    throw new Error("genuine apply rejected");
  }
});

await testAsync("executeWeeklyMaintenance rejects missing ok", async () => {
  const sb = async (p, options = {}) => {
    if ((options.method || "GET") === "POST" && p === "cruise_discovery_runs") {
      return [{ id: "r1", status: "running" }];
    }
    if (p.startsWith("cruise_discovery_maintenance_locks")) return [];
    if (p.startsWith("rpc/")) return { acquired: true };
    return [];
  };
  let threw = false;
  try {
    await cron.executeWeeklyMaintenance({
      lineSlug: "norwegian-cruise-line",
      cruiseLineId: "ncl",
      runType: "norwegian_weekly_maintenance",
      assertEnabled: () => {},
      runMaintenance: async () => ({ success: true, summary: {} }),
      dryRun: true,
      supabaseClient: sb
    });
  } catch (error) {
    threw = error.code === "weekly_runner_invalid_ok_contract";
  }
  if (!threw) throw new Error("shared runner must reject malformed ok");
});

if (failures.length) {
  console.error(`\ntest-weekly-maintenance-reliability-p0: ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`\ntest-weekly-maintenance-reliability-p0: ${passed} passed`);
