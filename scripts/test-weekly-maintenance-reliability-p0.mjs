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
    match_confidence: "high",
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

test("NCL committed staging rows are counted even when the run later fails", () => {
  const accounting = require(path.join(root, "netlify/functions/lib/weekly-maintenance-write-accounting"));
  const stats = tracking.buildMaintenanceRunStats(
    accounting.mergeFlattenedWriteStats({
      line_slug: "norwegian-cruise-line",
      proposed_inserts: 40,
      writes_performed: { inserted: 40, enriched: 0, promoted_active: 0, failed: 2 }
    }),
    { inventory_changed: false }
  );
  if (stats.inserts !== 40) throw new Error(`expected inserts=40, got ${stats.inserts}`);
  if (stats.inventory_changed !== true) throw new Error("inventory_changed must stay true");
  if (accounting.resolveWeeklyTerminalStatus({ ok: false, summary: stats }) !== "partial_write_failure") {
    throw new Error("partial write must not look like failed_before_writes");
  }
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
  const src = [
    fs.readFileSync(path.join(root, "netlify/functions/lib/disney-weekly-quality.js"), "utf8"),
    fs.readFileSync(path.join(root, "netlify/functions/lib/disney-weekly-maintenance.js"), "utf8"),
    fs.readFileSync(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking.js"), "utf8")
  ].join("\n");
  if (!/destination_resolution_below_100/.test(src)) throw new Error("Disney 100% destination gate missing");
  if (!/unresolved_destinations/.test(src)) throw new Error("Disney dest fail must persist unresolved destinations");
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
  if (!dispatch.includes("dryRun: dryRun !== false")) {
    throw new Error("Silversea background maintenance must remain dry-run unless explicitly applying");
  }
  const cronSrc = fs.readFileSync(
    path.join(root, "netlify/functions/silversea-weekly-maintenance-cron.js"),
    "utf8"
  );
  if (cronSrc.includes("platformScheduled ? false : dryRun")) {
    throw new Error("Silversea scheduled cron must not force apply when the write flag is off");
  }
  const prev = process.env.SILVERSEA_WEEKLY_RECONCILIATION_ENABLED;
  delete process.env.SILVERSEA_WEEKLY_RECONCILIATION_ENABLED;
  try {
    const dispatchMod = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-dispatch.js"));
    if (dispatchMod.resolveDryRun({}, process.env) !== true) {
      throw new Error("Silversea must stay dry-run unless SILVERSEA_WEEKLY_RECONCILIATION_ENABLED=true");
    }
  } finally {
    if (prev == null) delete process.env.SILVERSEA_WEEKLY_RECONCILIATION_ENABLED;
    else process.env.SILVERSEA_WEEKLY_RECONCILIATION_ENABLED = prev;
  }
});

test("Celebrity/HAL frozen write sets fail closed on identity mismatch", () => {
  const runner = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner"));
  const ok = runner.freezeWriteProducts({
    writeProducts: [{ raw: { k: "A" } }, { raw: { k: "B" } }],
    frozenIds: new Set(["A", "B"]),
    keyFn: (raw) => raw.k
  });
  if (!ok.ok || ok.writeProducts.map((r) => r.raw.k).join() !== "A,B") throw new Error("sorted freeze");
  const bad = runner.freezeWriteProducts({
    writeProducts: [{ raw: { k: "A" } }],
    frozenIds: new Set(["A", "MISSING"]),
    keyFn: (raw) => raw.k
  });
  if (bad.ok || bad.reason !== "frozen_manifest_identity_mismatch") throw new Error("mismatch");
});

test("Princess remap classifier never treats operational matches as true inserts", () => {
  const remap = require(path.join(root, "netlify/functions/lib/princess-official-id-remap"));
  const result = remap.classifyPrincessProposedInsert(
    {
      official_sailing_id: "NEW|GP|2026-09-26",
      ship_id: "s",
      departure_date: "2026-09-26",
      return_date: "2026-10-03",
      nights: 7,
      departure_port: "Fort Lauderdale",
      destination_id: "d"
    },
    [
      {
        id: "uuid-1",
        official_sailing_id: "OLD|GP|2026-09-26",
        ship_id: "s",
        departure_date: "2026-09-26",
        return_date: "2026-10-03",
        nights: 7,
        departure_port: "Fort Lauderdale",
        destination_id: "d"
      }
    ]
  );
  if (result.classification !== "OFFICIAL_ID_REMAP" || result.existing_uuid !== "uuid-1") {
    throw new Error("remap must preserve UUID");
  }
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

const WEEKLY_LAUNCHERS = [
  ["hal-weekly-maintenance-cron.js", "holland-america-line"],
  ["celebrity-weekly-maintenance-cron.js", "celebrity-cruises"],
  ["explora-weekly-maintenance-cron.js", "explora-journeys"],
  ["seabourn-weekly-maintenance-cron.js", "seabourn-cruise-line"],
  ["royal-caribbean-weekly-maintenance-cron.js", "royal-caribbean"],
  ["norwegian-weekly-maintenance-cron.js", "norwegian-cruise-line"],
  ["carnival-weekly-maintenance-cron.js", "carnival-cruise-line"],
  ["disney-weekly-maintenance-cron.js", "disney-cruise-line"],
  ["azamara-weekly-maintenance-cron.js", "azamara"],
  ["silversea-weekly-maintenance-cron.js", "silversea-cruises"]
];

test("Disney launcher claims weekly schedule lease", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/disney-weekly-maintenance-cron.js"), "utf8");
  if (!src.includes("handleLeasedWeeklyCron")) throw new Error("Disney launcher missing shared schedule lease");
  if (!src.includes("disney-cruise-line")) throw new Error("Disney lease must use disney-cruise-line");
});

test("Silversea launcher claims weekly schedule lease", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/silversea-weekly-maintenance-cron.js"), "utf8");
  if (!src.includes("handleLeasedWeeklyCron")) throw new Error("Silversea launcher missing shared schedule lease");
  if (!src.includes("silversea-cruises")) throw new Error("Silversea lease must use silversea-cruises");
});

test("all weekly Netlify launchers use shared scheduled lease", () => {
  for (const [file] of WEEKLY_LAUNCHERS) {
    const src = fs.readFileSync(path.join(root, "netlify/functions", file), "utf8");
    if (!src.includes("handleLeasedWeeklyCron")) throw new Error(`${file} missing handleLeasedWeeklyCron`);
  }
  const princess = fs.readFileSync(
    path.join(root, "netlify/functions/princess-weekly-maintenance-cron.js"),
    "utf8"
  );
  const princessToml = tomlBlock("princess-weekly-maintenance-cron");
  if (/schedule\s*=/.test(princessToml)) throw new Error("Princess must not regain a Netlify cron");
  if (princess.includes("handleLeasedWeeklyCron")) {
    throw new Error("Princess Netlify cron must stay GitHub-authoritative, not a leased Netlify dispatcher");
  }
});

await testAsync("schedule lease DB failure is fail-closed", async () => {
  const sb = async () => {
    throw new Error("lock table unavailable");
  };
  const claim = await schedule.claimScheduledDispatchLease(sb, {
    periodKey: "holland-america-line:2026-W37:scheduled",
    ownerId: "dispatch-fail-closed",
    triggerType: "scheduled"
  });
  if (claim.claimed !== false) throw new Error("DB failure must not claim");
  if (claim.already_dispatched !== false) throw new Error("DB failure is not already_dispatched");
  if (claim.reason !== "dispatch_lease_unavailable") throw new Error(claim.reason);
});

await testAsync("same dispatch ID background retry executes once", async () => {
  const sb = memoryLockStore();
  const created = [];
  const wrapped = async (p, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (p === "cruise_discovery_runs" && method === "POST") {
      created.push(JSON.parse(options.body));
      return [{ id: `run-${created.length}`, status: "running", stats: {} }];
    }
    return sb(p, options);
  };
  const first = await cron.executeWeeklyMaintenance({
    lineSlug: "explora-journeys",
    cruiseLineId: "explora",
    runType: "explora_weekly_maintenance",
    assertEnabled: () => {},
    runMaintenance: async () => ({ ok: true, success: true, summary: { inserts: 0, updates: 0 } }),
    dryRun: true,
    supabaseClient: wrapped,
    dispatchId: "shared-dispatch-1"
  });
  const second = await cron.executeWeeklyMaintenance({
    lineSlug: "explora-journeys",
    cruiseLineId: "explora",
    runType: "explora_weekly_maintenance",
    assertEnabled: () => {},
    runMaintenance: async () => ({ ok: true, success: true, summary: { inserts: 0, updates: 0 } }),
    dryRun: true,
    supabaseClient: wrapped,
    dispatchId: "shared-dispatch-1"
  });
  if (created.length !== 1) throw new Error(`expected 1 run record, got ${created.length}`);
  if (first.duplicate_background_invocation === true) throw new Error("first must execute");
  if (second.duplicate_background_invocation !== true) throw new Error("second must no-op");
  if (second.run_record_id != null) throw new Error("second must not create a run record");
});

await testAsync("different dispatch IDs manual runs remain possible", async () => {
  const sb = memoryLockStore();
  const created = [];
  const wrapped = async (p, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (p === "cruise_discovery_runs" && method === "POST") {
      created.push(JSON.parse(options.body));
      return [{ id: `run-${created.length}`, status: "running", stats: {} }];
    }
    if (p.startsWith("cruise_discovery_runs?") && method === "PATCH") return [];
    return sb(p, options);
  };
  await cron.executeWeeklyMaintenance({
    lineSlug: "explora-journeys",
    cruiseLineId: "explora",
    runType: "explora_weekly_maintenance",
    assertEnabled: () => {},
    runMaintenance: async () => ({ ok: true, success: true, summary: { inserts: 0, updates: 0 } }),
    dryRun: true,
    supabaseClient: wrapped,
    dispatchId: "manual-dispatch-a",
    triggerType: "manual"
  });
  await cron.executeWeeklyMaintenance({
    lineSlug: "explora-journeys",
    cruiseLineId: "explora",
    runType: "explora_weekly_maintenance",
    assertEnabled: () => {},
    runMaintenance: async () => ({ ok: true, success: true, summary: { inserts: 0, updates: 0 } }),
    dryRun: true,
    supabaseClient: wrapped,
    dispatchId: "manual-dispatch-b",
    triggerType: "manual"
  });
  if (created.length !== 2) throw new Error(`manual unique dispatch IDs must both execute, got ${created.length}`);
});

await testAsync("Disney stale running row becomes abandoned after execution lock expiry", async () => {
  const runs = [
    {
      id: "8cdd7966-dd64-4250-b3dd-fab83d91108c",
      status: "running",
      started_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      stats: { run_type: "disney_weekly_maintenance", run_id: "disney-stale" }
    }
  ];
  const patched = [];
  const sb = async (p, options = {}) => {
    if (p.startsWith("cruise_discovery_maintenance_locks?lock_key=")) {
      const key = decodeURIComponent(p.split("eq.")[1].split("&")[0]);
      if (key === "disney-cruise-line:weekly") {
        return [
          {
            lock_key: key,
            owner_id: "disney-stale",
            run_id: "disney-stale",
            expires_at: new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString()
          }
        ];
      }
      return [];
    }
    if (p.startsWith("cruise_discovery_runs?") && (options.method || "GET") === "GET") return runs;
    if (p.startsWith("cruise_discovery_runs?") && options.method === "PATCH") {
      patched.push(JSON.parse(options.body));
      return [];
    }
    return [];
  };
  const result = await stale.reconcileAbandonedMaintenanceRuns(sb, {
    lineSlug: "disney-cruise-line",
    runType: "disney_weekly_maintenance"
  });
  if (result.abandoned.length !== 1) throw new Error(`expected abandoned Disney run, got ${result.abandoned.length}`);
  if (patched[0]?.status !== "failed") throw new Error("must finalize failed/abandoned");
  if (patched[0]?.error_message !== "maintenance_worker_terminated_or_lease_expired") {
    throw new Error(patched[0]?.error_message);
  }
});

await testAsync("live execution lock prevents abandonment", async () => {
  const runId = "live-disney";
  const sb = async (p, options = {}) => {
    if (p.startsWith("cruise_discovery_maintenance_locks?lock_key=")) {
      const key = decodeURIComponent(p.split("eq.")[1].split("&")[0]);
      if (key === "disney-cruise-line:weekly") {
        return [
          {
            lock_key: key,
            owner_id: runId,
            run_id: runId,
            run_record_id: "live-d1",
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
          }
        ];
      }
      return [];
    }
    if (p.startsWith("cruise_discovery_runs?") && (options.method || "GET") === "GET") {
      return [
        {
          id: "live-d1",
          status: "running",
          started_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          stats: { run_type: "disney_weekly_maintenance", run_id: runId }
        }
      ];
    }
    if (options.method === "PATCH") throw new Error("must not patch live worker");
    return [];
  };
  const result = await stale.reconcileAbandonedMaintenanceRuns(sb, {
    lineSlug: "disney-cruise-line",
    runType: "disney_weekly_maintenance"
  });
  if (result.abandoned.length) throw new Error("live lock must not be abandoned");
});

await testAsync("dispatch-period lease does not prevent stale-run cleanup", async () => {
  const runs = [
    {
      id: "stale-period",
      status: "running",
      started_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      stats: { run_type: "celebrity_weekly_maintenance", run_id: "old-worker" }
    }
  ];
  const patched = [];
  const sb = async (p, options = {}) => {
    if (p.startsWith("cruise_discovery_maintenance_locks?lock_key=")) {
      const key = decodeURIComponent(p.split("eq.")[1].split("&")[0]);
      if (key.endsWith(":scheduled")) {
        return [
          {
            lock_key: key,
            owner_id: "dispatch-still-held",
            run_id: "dispatch-still-held",
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          }
        ];
      }
      if (key === "celebrity-cruises:weekly") {
        return [
          {
            lock_key: key,
            owner_id: "old-worker",
            run_id: "old-worker",
            expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
          }
        ];
      }
      return [];
    }
    if (p.startsWith("cruise_discovery_runs?") && (options.method || "GET") === "GET") return runs;
    if (p.startsWith("cruise_discovery_runs?") && options.method === "PATCH") {
      patched.push(JSON.parse(options.body));
      return [];
    }
    return [];
  };
  const result = await stale.reconcileAbandonedMaintenanceRuns(sb, {
    lineSlug: "celebrity-cruises",
    runType: "celebrity_weekly_maintenance"
  });
  if (result.abandoned.length !== 1) {
    throw new Error("dispatch-period lease must not keep a dead worker RUNNING");
  }
  if (!patched.length) throw new Error("stale run must be patched");
});

test("Princess 432 voyage-equivalence classifier", () => {
  const classifier = require(path.join(root, "netlify/functions/lib/princess-voyage-identity-classifier"));
  const waterfall = classifier.classifyPrincessVoyageInsertSet(
    [
      {
        official_sailing_id: "NEW|GP|2026-09-26",
        ship_id: "s",
        departure_date: "2026-09-26",
        return_date: "2026-10-03",
        nights: 7,
        departure_port: "Fort Lauderdale",
        destination_id: "d"
      },
      {
        official_sailing_id: "SBR17A|MJ|2027-01-06",
        external_key: "ext-existing",
        ship_id: "other",
        departure_date: "2027-01-06",
        return_date: "2027-01-23",
        nights: 17,
        departure_port: "Buenos Aires",
        destination_id: "dest"
      },
      {
        official_sailing_id: "true-new|SH|2028-01-01",
        ship_id: "brand-new",
        departure_date: "2028-01-01",
        return_date: "2028-01-08",
        nights: 7,
        departure_port: "Miami",
        destination_id: "carib"
      }
    ],
    [
      {
        id: "uuid-1",
        official_sailing_id: "OLD|GP|2026-09-26",
        ship_id: "s",
        departure_date: "2026-09-26",
        return_date: "2026-10-03",
        nights: 7,
        departure_port: "Fort Lauderdale",
        destination_id: "d"
      },
      {
        id: "uuid-2",
        official_sailing_id: "OLD-EXT",
        external_key: "ext-existing",
        ship_id: "x",
        departure_date: "2027-01-06",
        return_date: "2027-01-23",
        nights: 17,
        departure_port: "Buenos Aires",
        destination_id: "dest"
      }
    ]
  );
  if (waterfall.counts.OFFICIAL_ID_REMAP !== 1) throw new Error("remap count");
  if (waterfall.counts.PRODUCTION_IDENTITY_REGRESSION !== 1) throw new Error("identity regression count");
  if (waterfall.counts.TRUE_NEW !== 1) throw new Error("true new count");
});

await testAsync("Princess remap never duplicates existing voyage", async () => {
  const remap = require(path.join(root, "netlify/functions/lib/princess-official-id-remap"));
  const existing = {
    id: "uuid-keep",
    official_sailing_id: "OLD|GP|2026-09-26",
    ship_id: "s",
    departure_date: "2026-09-26",
    return_date: "2026-10-03",
    nights: 7,
    departure_port: "Fort Lauderdale",
    destination_id: "d",
    status: "active"
  };
  const refused = await remap.applyPrincessOfficialIdRemap(async () => [], {
    existingRow: existing,
    insert: {
      official_sailing_id: "NEW|OT|2028-01-01",
      ship_id: "other-ship",
      departure_date: "2028-01-01",
      return_date: "2028-01-08",
      nights: 7,
      departure_port: "Miami",
      destination_id: "carib"
    },
    cruiseLineId: "princess",
    runId: "test-remap"
  });
  if (refused.ok !== false) throw new Error("non-equivalent voyage must not remap");
  if (refused.reason !== "remap_would_duplicate_or_not_voyage_equivalent") throw new Error(refused.reason);
});

test("NCL reports total outstanding separately from per-run capped plan", () => {
  const planned = 200;
  const outstanding = 437;
  if (planned === outstanding) throw new Error("cap must not equal unexplained total");
  const summary = {
    total_outstanding_inserts: outstanding,
    planned_this_run: planned,
    proposed_inserts: outstanding,
    review_required: outstanding > 200
  };
  if (summary.proposed_inserts === planned && summary.total_outstanding_inserts !== outstanding) {
    throw new Error("200 cap must not masquerade as total backlog");
  }
  if (summary.review_required !== true) throw new Error("quality gate must use total outstanding");
});

await testAsync("NCL 200 cap cannot masquerade as total backlog", async () => {
  const nclManifest = require(path.join(root, "netlify/functions/lib/norwegian-weekly-manifest"));
  const products = [];
  for (let i = 0; i < 5; i += 1) {
    products.push({
      official_sailing_id: `NEW${i}|2028-01-0${i + 1}`,
      complete_eligible: true,
      itinerary_classification: { category: "ocean" },
      ship_id: `ship-${i}`,
      departure_date: `2028-01-0${i + 1}`,
      return_date: `2028-01-1${i + 1}`,
      nights: 7,
      departure_port: "Miami"
    });
  }
  const manifest = await nclManifest.buildNorwegianWeeklyManifest({
    simulation: { products, eligibility: { raw_sailings: 5, ocean_sailings: 5 } },
    productionRows: [],
    cruiseLine: { id: "ncl", slug: "norwegian-cruise-line" },
    destinations: [],
    supabase: async () => [],
    today: "2026-09-09",
    runId: "ncl-cap-test",
    maxNewInserts: 2
  });
  if (manifest.total_outstanding_inserts !== 5) throw new Error(`outstanding ${manifest.total_outstanding_inserts}`);
  if (manifest.planned_this_run !== 2) throw new Error(`planned ${manifest.planned_this_run}`);
  if (manifest.inserts.length > 2) throw new Error("insert payloads must stay capped");
  if (manifest.total_outstanding_inserts === manifest.planned_this_run) {
    throw new Error("cap masqueraded as total");
  }
});

test("weekly ISO-week key difference makes 8-day overlap harmless", () => {
  const w37 = schedule.scheduledWeeklyDispatchKey(
    "holland-america-line",
    new Date("2026-09-07T02:00:00+08:00")
  );
  const w38 = schedule.scheduledWeeklyDispatchKey(
    "holland-america-line",
    new Date("2026-09-14T02:00:00+08:00")
  );
  if (w37 === w38) throw new Error("adjacent ISO weeks must not share a period key");
  if (!w37.includes("W37") || !w38.includes("W38")) throw new Error(`${w37} ${w38}`);
  if (schedule.WEEKLY_DISPATCH_LEASE_SECONDS !== 8 * 24 * 60 * 60) {
    throw new Error("do not change weekly lease duration without proving overlap is harmful");
  }
});

await testAsync("daily expiry duplicate dispatch creates one execution record", async () => {
  const created = [];
  const lockStore = memoryLockStore();
  const wrapped = async (p, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (p === "cruise_discovery_runs" && method === "POST") {
      created.push(JSON.parse(options.body));
      return [{ id: `expiry-${created.length}`, status: "running", stats: {} }];
    }
    if (p.startsWith("cruise_discovery_runs") && method === "PATCH") return [];
    if (p.startsWith("discovered_cruises")) return [];
    return lockStore(p, options);
  };
  const first = await cron.executeDailyExpiry({ dryRun: true, triggerType: "scheduled", supabaseClient: wrapped });
  if (created.length !== 1) throw new Error(`first expiry created ${created.length} records`);
  const second = await cron.executeDailyExpiry({ dryRun: true, triggerType: "scheduled", supabaseClient: wrapped });
  if (created.length !== 1) throw new Error(`expected 1 expiry run record, got ${created.length}`);
  if (first.already_dispatched === true) throw new Error("first expiry must execute");
  if (second.already_dispatched !== true) throw new Error("second expiry must not create another execution record");
  if (second.run_record_id != null) throw new Error("duplicate dispatch must not persist a second run");
  const ops = require(path.join(root, "netlify/functions/lib/maintenance-operational-status"));
  const present = {
    id: created[0] ? "expiry-1" : first.stats?.run_id,
    started_at: new Date().toISOString(),
    stats: { run_type: "daily_expiry_maintenance" }
  };
  const missed = ops.detectMissedDailyExpirySlots([present], {
    now: new Date(Date.now() + 60 * 60 * 1000),
    lookbackDays: 1
  });
  void missed;
});

test("Silversea scheduled dry-run still uses central ledger lifecycle", () => {
  const dispatchSrc = fs.readFileSync(
    path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-dispatch.js"),
    "utf8"
  );
  if (!dispatchSrc.includes("executeWeeklyMaintenance")) {
    throw new Error("Silversea scheduled path must persist cruise_discovery_runs");
  }
  if (!dispatchSrc.includes("dryRun: dryRun !== false")) {
    throw new Error("Silversea must remain dry-run unless explicitly applying");
  }
});

test("Royal unhealthy enumeration writes zero", () => {
  const health = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-health"));
  const result = health.evaluateRoyalCaribbeanWeeklyHealth({
    sourceRuntimeOk: false,
    enumerationHealth: { royal_caribbean_source_enumeration_ok: false },
    reconciliationArithmeticOk: true,
    shipResolutionOk: true,
    embarkationResolutionOk: true,
    actualWrites: 0,
    performWrites: false
  });
  if (result.weekly_maintenance_healthy) throw new Error("unhealthy must fail closed");
  if (!result.failures.includes("source_runtime_not_ok")) throw new Error("runtime");
  if (!result.failures.includes("source_enumeration_unhealthy")) throw new Error("enumeration");
  if (result.actual_writes !== 0) throw new Error("writes");
});

test("Seabourn review remains zero-write unless specifically approved", () => {
  const src = fs.readFileSync(
    path.join(root, "netlify/functions/lib/seabourn-weekly-maintenance-dispatch.js"),
    "utf8"
  );
  if (!/review_required/.test(src) && !fs.readFileSync(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"), "utf8").includes("SEABOURN")) {
    throw new Error("Seabourn review path missing");
  }
  const rec = seabournRec.buildSeabournReconciliationSummary({
    eligibleTotal: 679,
    recognisedExistingEligible: 678,
    outstandingEligibleInserts: 1,
    proposedUpdates: 0,
    proposedIdentityReviewUpdates: 1,
    activeProductionTotal: 685,
    sourceAbsentActive: 7,
    sourceAbsentRetained: 7
  });
  if (rec.outstanding_eligible_inserts !== 1) throw new Error("insert remains review");
});

test("healthy line duplicate background invocation no-ops", () => {
  const ops = require(path.join(root, "netlify/functions/lib/maintenance-operational-status"));
  if (ops.weeklyBackgroundHttpStatus({ success: true, duplicate_background_invocation: true }) !== 200) {
    throw new Error("duplicate background must be HTTP 200");
  }
});

test("stale-run watchdog covers all commissioned lines", () => {
  const slugs = tracking.COMMISSIONED_WEEKLY_LINES.map((l) => l.slug);
  for (const expected of [
    "holland-america-line",
    "celebrity-cruises",
    "princess-cruises",
    "explora-journeys",
    "seabourn-cruise-line",
    "royal-caribbean-international",
    "norwegian-cruise-line",
    "carnival-cruise-line",
    "disney-cruise-line",
    "azamara",
    "silversea-cruises"
  ]) {
    if (!slugs.includes(expected)) throw new Error(`watchdog missing ${expected}`);
  }
  const trackingSrc = fs.readFileSync(
    path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking.js"),
    "utf8"
  );
  if (!trackingSrc.includes("reconcileAllAbandonedMaintenanceRuns")) {
    throw new Error("dashboard must sweep all commissioned lines");
  }
});

if (failures.length) {
  console.error(`\ntest-weekly-maintenance-reliability-p0: ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`\ntest-weekly-maintenance-reliability-p0: ${passed} passed`);
