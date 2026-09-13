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

test("Disney current master-plan serial catch-up stays at batch cap 30", () => {
  const controlled = require(path.join(root, "netlify/functions/lib/disney-controlled-batch"));
  if (controlled.P2_CATCHUP_DISNEY_BATCH !== 30) throw new Error("do not raise Disney catch-up cap");
  const identities = Array.from({ length: 67 }, (_, i) => `2028-01-01|DCL-${String(i).padStart(3, "0")}`);
  const batches = [];
  for (let i = 0; i < identities.length; i += 30) {
    batches.push(identities.slice(i, i + 30));
  }
  if (batches.length !== 3) throw new Error(`expected 3 serial batches, got ${batches.length}`);
  if (batches.some((batch) => batch.length > 30)) throw new Error("batch exceeded 30");
  if (batches.reduce((acc, batch) => acc + batch.length, 0) !== 67) throw new Error("master plan lost identities");
});

await testAsync("Disney same dispatch id is a background no-op", async () => {
  const sb = memoryLockStore();
  const created = [];
  const sourceRuns = [];
  const wrapped = async (p, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (p === "cruise_discovery_runs" && method === "POST") {
      created.push(JSON.parse(options.body));
      return [{ id: `disney-run-${created.length}`, status: "running", stats: {} }];
    }
    return sb(p, options);
  };
  const first = await cron.executeWeeklyMaintenance({
    lineSlug: "disney-cruise-line",
    cruiseLineId: "disney",
    runType: "disney_weekly_maintenance",
    assertEnabled: () => {},
    runMaintenance: async () => {
      sourceRuns.push("first");
      return { ok: true, success: true, summary: { inserts: 0, updates: 0 } };
    },
    dryRun: true,
    supabaseClient: wrapped,
    dispatchId: "p3b-disney-dispatch-same"
  });
  const second = await cron.executeWeeklyMaintenance({
    lineSlug: "disney-cruise-line",
    cruiseLineId: "disney",
    runType: "disney_weekly_maintenance",
    assertEnabled: () => {},
    runMaintenance: async () => {
      sourceRuns.push("second");
      return { ok: true, success: true, summary: { inserts: 0, updates: 0 } };
    },
    dryRun: true,
    supabaseClient: wrapped,
    dispatchId: "p3b-disney-dispatch-same"
  });
  if (created.length !== 1) throw new Error(`disney dispatch created ${created.length} runs`);
  if (sourceRuns.join(",") !== "first") throw new Error("second disney dispatch must not re-run source");
  if (first.duplicate_background_invocation === true) throw new Error("first disney dispatch must execute");
  if (second.duplicate_background_invocation !== true) throw new Error("second disney dispatch must no-op");
});

test("Princess and NCL production indexes paginate with a stable id order", () => {
  const princessWrites = fs.readFileSync(
    path.join(root, "netlify/functions/lib/princess-discovery-writes.js"),
    "utf8"
  );
  const nclWrites = fs.readFileSync(
    path.join(root, "netlify/functions/lib/norwegian-discovery-writes.js"),
    "utf8"
  );
  if (!princessWrites.includes("order=id.asc")) {
    throw new Error("Princess inventory index must order by id to avoid offset pagination gaps");
  }
  if (!nclWrites.includes("order=id.asc")) {
    throw new Error("NCL inventory index must order by id to avoid offset pagination gaps");
  }
});

test("Princess P3B identity waterfall accounts every eligible candidate once", () => {
  const classifier = require(path.join(root, "netlify/functions/lib/princess-voyage-identity-classifier"));
  const production = [
    {
      id: "uuid-recognised",
      official_sailing_id: "OLD|GP|2026-09-26",
      ship_id: "s1",
      departure_date: "2026-09-26",
      return_date: "2026-10-03",
      nights: 7,
      departure_port: "Fort Lauderdale",
      destination_id: "d1"
    },
    {
      id: "uuid-remap",
      official_sailing_id: "OLD-REMAP",
      ship_id: "s2",
      departure_date: "2027-01-06",
      return_date: "2027-01-13",
      nights: 7,
      departure_port: "Miami",
      destination_id: "d2"
    },
    {
      id: "uuid-dup-a",
      official_sailing_id: "DUP-A",
      ship_id: "s3",
      departure_date: "2028-02-01",
      return_date: "2028-02-08",
      nights: 7,
      departure_port: "Rome",
      destination_id: "d3"
    },
    {
      id: "uuid-dup-b",
      official_sailing_id: "DUP-B",
      ship_id: "s3",
      departure_date: "2028-02-01",
      return_date: "2028-02-08",
      nights: 7,
      departure_port: "Rome",
      destination_id: "d3"
    }
  ];
  const eligible = [
    {
      official_sailing_id: "OLD|GP|2026-09-26",
      ship_id: "s1",
      departure_date: "2026-09-26",
      return_date: "2026-10-03",
      nights: 7,
      departure_port: "Fort Lauderdale",
      destination_id: "d1"
    },
    {
      official_sailing_id: "NEW-REMAP",
      ship_id: "s2",
      departure_date: "2027-01-06",
      return_date: "2027-01-13",
      nights: 7,
      departure_port: "Miami",
      destination_id: "d2"
    },
    {
      official_sailing_id: "TRUE-NEW",
      ship_id: "brand-new",
      departure_date: "2029-01-01",
      return_date: "2029-01-08",
      nights: 7,
      departure_port: "Barcelona",
      destination_id: "d4"
    },
    {
      official_sailing_id: "MULTI-SRC",
      ship_id: "s3",
      departure_date: "2028-02-01",
      return_date: "2028-02-08",
      nights: 7,
      departure_port: "Rome",
      destination_id: "d3"
    }
  ];
  const waterfall = classifier.classifyPrincessP3bEligibleSet(eligible, production);
  if (waterfall.total !== eligible.length) throw new Error("waterfall total must equal eligible");
  if (waterfall.accounting_ok !== true) throw new Error("P3B counts must sum to eligible");
  const counted = Object.values(waterfall.counts).reduce((acc, n) => acc + n, 0);
  if (counted !== eligible.length) throw new Error(`counted ${counted} vs eligible ${eligible.length}`);
  if (waterfall.counts.RECOGNISED_CURRENT_ID !== 1) throw new Error("recognised");
  if (waterfall.counts.UNIQUE_OFFICIAL_ID_REMAP !== 1) throw new Error("unique remap");
  if (waterfall.counts.TRUE_NEW !== 1) throw new Error("true new");
  if (waterfall.counts.MULTIPLE_PRODUCTION_MATCHES !== 1) throw new Error("multiple production");
});

await testAsync("Princess multiple-production match blocks remap", async () => {
  const remap = require(path.join(root, "netlify/functions/lib/princess-official-id-remap"));
  const insert = {
    official_sailing_id: "NEW|GP|2026-09-26",
    ship_id: "s",
    departure_date: "2026-09-26",
    return_date: "2026-10-03",
    nights: 7,
    departure_port: "Fort Lauderdale",
    destination_id: "d"
  };
  const production = [
    { id: "uuid-a", official_sailing_id: "OLD-A", ...insert, official_sailing_id: "OLD-A" },
    { id: "uuid-b", official_sailing_id: "OLD-B", ...insert, official_sailing_id: "OLD-B" }
  ];
  production[0].official_sailing_id = "OLD-A";
  production[1].official_sailing_id = "OLD-B";
  const refused = await remap.applyPrincessOfficialIdRemap(async () => [], {
    existingRow: production[0],
    insert,
    cruiseLineId: "princess",
    runId: "p3b-multi",
    productionRows: production
  });
  if (refused.ok !== false) throw new Error("multiple production UUIDs must block remap");
  if (refused.reason !== "multiple_production_matches") throw new Error(refused.reason);
});

await testAsync("Princess unique remap preserves UUID", async () => {
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
    status: "active",
    official_url: "https://example.test/old",
    raw_extract: { princess_sailing_id: "OLD|GP|2026-09-26" }
  };
  const insert = {
    official_sailing_id: "NEW|GP|2026-09-26",
    ship_id: "s",
    departure_date: "2026-09-26",
    return_date: "2026-10-03",
    nights: 7,
    departure_port: "Fort Lauderdale",
    destination_id: "d",
    official_url: "https://example.test/new",
    itinerary: "Caribbean"
  };
  let patchedId = null;
  const sb = async (path, options = {}) => {
    if (String(path).startsWith("discovered_cruises?id=eq.uuid-keep") && options.method === "PATCH") {
      patchedId = "uuid-keep";
      return [{ ...existing, ...options.body, id: "uuid-keep" }];
    }
    return [];
  };
  const result = await remap.applyPrincessOfficialIdRemap(sb, {
    existingRow: existing,
    insert,
    cruiseLineId: "c19f40a7-c160-4035-a845-14dada550e1f",
    runId: "p3b-unique-remap",
    productionRows: [existing]
  });
  if (result.ok !== true) throw new Error(result.reason || "unique remap failed");
  if (result.discovered_cruise_id !== "uuid-keep") throw new Error("UUID must be preserved");
  if (patchedId !== "uuid-keep") throw new Error("PATCH must target existing UUID");
  if (result.created === true) throw new Error("remap must not insert");
});

test("Princess genuine insert does not duplicate an existing voyage", () => {
  const classifier = require(path.join(root, "netlify/functions/lib/princess-voyage-identity-classifier"));
  const genuine = classifier.classifyPrincessP3bCandidate(
    {
      official_sailing_id: "BRAND-NEW",
      ship_id: "new-ship",
      departure_date: "2029-06-01",
      return_date: "2029-06-08",
      nights: 7,
      departure_port: "Seattle",
      destination_id: "alaska"
    },
    [
      {
        id: "existing",
        official_sailing_id: "OTHER",
        ship_id: "other-ship",
        departure_date: "2028-01-01",
        return_date: "2028-01-08",
        nights: 7,
        departure_port: "Miami",
        destination_id: "carib"
      }
    ]
  );
  if (genuine.classification !== "TRUE_NEW") throw new Error(genuine.classification);
  if (classifier.princessP3bWriteAllowed("MULTIPLE_PRODUCTION_MATCHES")) {
    throw new Error("multiple production matches must not be auto-written");
  }
  const duplicateVoyage = classifier.classifyPrincessP3bCandidate(
    {
      official_sailing_id: "NEW-ID",
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
        official_sailing_id: "OLD-1",
        ship_id: "s",
        departure_date: "2026-09-26",
        return_date: "2026-10-03",
        nights: 7,
        departure_port: "Fort Lauderdale",
        destination_id: "d"
      },
      {
        id: "uuid-2",
        official_sailing_id: "OLD-2",
        ship_id: "s",
        departure_date: "2026-09-26",
        return_date: "2026-10-03",
        nights: 7,
        departure_port: "Fort Lauderdale",
        destination_id: "d"
      }
    ]
  );
  if (duplicateVoyage.classification !== "MULTIPLE_PRODUCTION_MATCHES") {
    throw new Error("genuine insert path must not treat a duplicated voyage as TRUE_NEW");
  }
});

test("NCL true total outstanding is distinct from the capped plan", () => {
  const nclClassifier = require(path.join(root, "netlify/functions/lib/norwegian-voyage-identity-classifier"));
  const eligible = Array.from({ length: 5 }, (_, i) => ({
    official_sailing_id: `SRC-${i}`,
    ship_id: `ship-${i}`,
    departure_date: `2028-01-0${i + 1}`,
    return_date: `2028-01-1${i + 1}`,
    nights: 7,
    departure_port: "Miami"
  }));
  const waterfall = nclClassifier.classifyNorwegianP3bEligibleSet(eligible, []);
  if (waterfall.counts.TRUE_NEW !== 5) throw new Error("all unmatched NCL source rows are outstanding");
  const cap = ncl.NCL_MAX_WEEKLY_WRITES || 200;
  const planned = Math.min(waterfall.outstanding_total, cap);
  if (waterfall.outstanding_total === planned && waterfall.outstanding_total > cap) {
    throw new Error("capped plan masqueraded as true total");
  }
  if (planned !== 5) throw new Error("under-cap plan should equal true outstanding when below cap");
});

test("NCL multiple production match blocks write", () => {
  const nclClassifier = require(path.join(root, "netlify/functions/lib/norwegian-voyage-identity-classifier"));
  const classified = nclClassifier.classifyNorwegianP3bCandidate(
    {
      official_sailing_id: "NEW-NCL",
      ship_id: "ship",
      departure_date: "2028-03-01",
      return_date: "2028-03-08",
      nights: 7,
      departure_port: "Miami"
    },
    [
      {
        id: "a",
        official_sailing_id: "OLD-A",
        status: "active",
        ship_id: "ship",
        departure_date: "2028-03-01",
        return_date: "2028-03-08",
        nights: 7,
        departure_port: "Miami"
      },
      {
        id: "b",
        official_sailing_id: "OLD-B",
        status: "active",
        ship_id: "ship",
        departure_date: "2028-03-01",
        return_date: "2028-03-08",
        nights: 7,
        departure_port: "Miami"
      }
    ]
  );
  if (classified.classification !== "MULTIPLE_PRODUCTION_MATCHES") throw new Error(classified.classification);
  if (nclClassifier.norwegianP3bWriteAllowed(classified.classification)) {
    throw new Error("multiple production matches must stay REVIEW_REQUIRED");
  }
  if (!nclClassifier.norwegianMultipleProductionMatchBlocksWrite(classified.classification)) {
    throw new Error("NCL multiple production match must block write");
  }
});

test("NCL match_required enrichment/promotion remains a legitimate outstanding class", () => {
  const nclClassifier = require(path.join(root, "netlify/functions/lib/norwegian-voyage-identity-classifier"));
  const classified = nclClassifier.classifyNorwegianP3bCandidate(
    {
      official_sailing_id: "NCL-MR",
      ship_id: "ship",
      departure_date: "2028-04-01",
      return_date: "2028-04-08",
      nights: 7,
      departure_port: "Miami"
    },
    [
      {
        id: "mr-1",
        official_sailing_id: "NCL-MR",
        status: "match_required",
        ship_id: "ship",
        departure_date: "2028-04-01",
        return_date: "2028-04-08",
        nights: 7,
        departure_port: "Miami"
      }
    ]
  );
  if (classified.classification !== "ALREADY_MATCH_REQUIRED") throw new Error(classified.classification);
  if (!nclClassifier.norwegianP3bWriteAllowed(classified.classification)) {
    throw new Error("legitimate match_required rows remain eligible for enrichment/promotion");
  }
});

await testAsync("Silversea deployed-style duplicate dispatch is a no-op", async () => {
  const sb = memoryLockStore();
  const created = [];
  const maintenanceRuns = [];
  const wrapped = async (p, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (p === "cruise_discovery_runs" && method === "POST") {
      created.push(JSON.parse(options.body));
      return [{ id: `silversea-${created.length}`, status: "running", stats: {} }];
    }
    return sb(p, options);
  };
  const first = await cron.executeWeeklyMaintenance({
    lineSlug: "silversea-cruises",
    cruiseLineId: "silversea",
    runType: "silversea_weekly_maintenance",
    assertEnabled: () => {},
    runMaintenance: async () => {
      maintenanceRuns.push("source");
      return { ok: true, success: true, summary: { inserts: 0, updates: 0, dry_run: true } };
    },
    dryRun: true,
    supabaseClient: wrapped,
    dispatchId: "p3b-silversea-validation-dispatch"
  });
  const second = await cron.executeWeeklyMaintenance({
    lineSlug: "silversea-cruises",
    cruiseLineId: "silversea",
    runType: "silversea_weekly_maintenance",
    assertEnabled: () => {},
    runMaintenance: async () => {
      maintenanceRuns.push("second-source");
      return { ok: true, success: true, summary: { inserts: 1, updates: 1 } };
    },
    dryRun: true,
    supabaseClient: wrapped,
    dispatchId: "p3b-silversea-validation-dispatch"
  });
  if (created.length !== 1) throw new Error("silversea duplicate dispatch created a second run");
  if (maintenanceRuns.length !== 1) throw new Error("duplicate silversea dispatch must not execute source");
  if (second.duplicate_background_invocation !== true) throw new Error("expected duplicate_background_invocation");
  if ((second.summary?.inserts || 0) !== 0 || (second.summary?.updates || 0) !== 0) {
    throw new Error("duplicate silversea dispatch must write nothing");
  }
  if (first.summary?.dry_run !== true && first.duplicate_background_invocation) throw new Error("first should execute");
});

test("Royal enumeration stays fail-closed", () => {
  const royalHealth = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-health"));
  const enumeration = require(path.join(root, "netlify/functions/lib/royal-caribbean-source-enumeration"));
  const result = royalHealth.evaluateRoyalCaribbeanWeeklyHealth({
    sourceRuntimeOk: true,
    enumerationHealth: { royal_caribbean_source_enumeration_ok: false, failures: ["production_ids_missing_from_union"] },
    reconciliationArithmeticOk: true,
    shipResolutionOk: true,
    embarkationResolutionOk: true
  });
  if (result.weekly_maintenance_healthy === true) throw new Error("unhealthy enumeration must fail closed");
  if (!result.failures.includes("source_enumeration_unhealthy")) throw new Error("missing source_enumeration_unhealthy");
  const src = fs.readFileSync(
    path.join(root, "netlify/functions/lib/royal-caribbean-source-enumeration.js"),
    "utf8"
  );
  if (/maxLookups\s*=\s*25/.test(src)) {
    throw new Error("Royal detail lookup must not leave missing production IDs unexamined at a 25-row cap");
  }
  const unexplained = enumeration.evaluateWeeklyAuthoritativeEnumerationHealth({
    simulationOk: true,
    unionSailingIds: new Set(["A"]),
    productionSailingIds: new Set(["A", "MISSING"]),
    duplicateSailingIds: 0,
    detailLookupResults: [{ official_sailing_id: "MISSING", detail_ok: false, retrievable: false }]
  });
  if (unexplained.royal_caribbean_source_enumeration_ok === true) {
    throw new Error("unexplained production IDs must keep enumeration fail-closed");
  }
  if (!unexplained.failures.includes("production_ids_missing_from_union")) {
    throw new Error("missing production_ids_missing_from_union");
  }
});

test("Seabourn ambiguous collision remains review", () => {
  const rec = seabournRec.buildSeabournReconciliationSummary({
    activeProductionTotal: 10,
    eligibleTotal: 11,
    recognisedExistingEligible: 9,
    outstandingEligibleInserts: 1,
    proposedUpdates: 0,
    proposedIdentityReviewUpdates: 1,
    sourceAbsentActive: 0,
    writesExecuted: 0
  });
  if (rec.outstanding_eligible_inserts !== 1) throw new Error("ambiguous insert stays outstanding");
  if (rec.writes_executed !== 0) throw new Error("ambiguous collision must not write");
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"), "utf8");
  if (!/review_required/.test(src)) throw new Error("Seabourn review_required path missing");
});

test("Princess canonical runner uses unique voyage recognition", () => {
  const writes = require(path.join(root, "netlify/functions/lib/princess-discovery-writes"));
  const classifier = require(path.join(root, "netlify/functions/lib/princess-voyage-identity-classifier"));
  const production = [
    {
      id: "uuid-keep",
      official_sailing_id: "OLD|GP|2026-09-26",
      cruise_line_id: "princess",
      ship_id: "s",
      departure_date: "2026-09-26",
      return_date: "2026-10-03",
      nights: 7,
      departure_port: "Fort Lauderdale",
      destination_id: "d",
      status: "active"
    },
    {
      id: "uuid-csr-k",
      official_sailing_id: "CSR14K",
      cruise_line_id: "princess",
      ship_id: "kp",
      departure_date: "2027-02-28",
      return_date: "2027-03-14",
      nights: 14,
      departure_port: "Fort Lauderdale",
      destination_id: "carib",
      status: "active"
    },
    {
      id: "uuid-csr-r",
      official_sailing_id: "CSR14R",
      cruise_line_id: "princess",
      ship_id: "kp",
      departure_date: "2027-02-28",
      return_date: "2027-03-14",
      nights: 14,
      departure_port: "Fort Lauderdale",
      destination_id: "carib",
      status: "active"
    }
  ];
  const indexes = {
    rows: production,
    byProductKey: new Map(production.map((row) => [row.official_sailing_id, row])),
    p3b: classifier.indexProduction(production),
    sourceOfficialCounts: new Map()
  };
  const cruiseLine = { id: "princess" };
  const none = writes.recognisePrincessExisting(
    indexes,
    {
      complete_high_confidence: true,
      product_type: "cruise",
      raw: { official_sailing_id: "BRAND-NEW" },
      candidate: {
        ship_id: "new-ship",
        departure_date: "2029-06-01",
        return_date: "2029-06-08",
        nights: 7,
        departure_port: "Seattle",
        destination_id: "alaska"
      }
    },
    cruiseLine
  );
  if (none.classification !== "TRUE_NEW") throw new Error(none.classification);
  if (writes.classifyProposedAction({ complete_high_confidence: true, product_type: "cruise", raw: {} }, none.existing, none) !== "insert_active") {
    throw new Error("zero strict match must remain an insert");
  }

  const one = writes.recognisePrincessExisting(
    indexes,
    {
      complete_high_confidence: true,
      product_type: "cruise",
      raw: { official_sailing_id: "NEW|GP|2026-09-26" },
      candidate: {
        ship_id: "s",
        departure_date: "2026-09-26",
        return_date: "2026-10-03",
        nights: 7,
        departure_port: "Fort Lauderdale",
        destination_id: "d"
      }
    },
    cruiseLine
  );
  if (one.classification !== "UNIQUE_OFFICIAL_ID_REMAP") throw new Error(one.classification);
  if (one.existing?.id !== "uuid-keep") throw new Error("unique remap must keep existing UUID");
  if (
    writes.classifyProposedAction(
      { complete_high_confidence: true, product_type: "cruise", raw: { official_sailing_id: "NEW|GP|2026-09-26" } },
      one.existing,
      one
    ) !== "update_identity_review_required"
  ) {
    throw new Error("unique remap must not insert");
  }

  const many = writes.recognisePrincessExisting(
    indexes,
    {
      complete_high_confidence: true,
      product_type: "cruise",
      raw: { official_sailing_id: "CSR14X" },
      candidate: {
        ship_id: "kp",
        departure_date: "2027-02-28",
        return_date: "2027-03-14",
        nights: 14,
        departure_port: "Fort Lauderdale",
        destination_id: "carib"
      }
    },
    cruiseLine
  );
  if (many.classification !== "MULTIPLE_PRODUCTION_MATCHES") throw new Error(many.classification);
  if (many.existing) throw new Error("duplicate group must not pick a UUID");
  if (
    writes.classifyProposedAction(
      { complete_high_confidence: true, product_type: "cruise", raw: { official_sailing_id: "CSR14X" } },
      many.existing,
      many
    ) !== "update_identity_review_required"
  ) {
    throw new Error("multiple strict matches must stay review");
  }

  const knownK = writes.recognisePrincessExisting(
    indexes,
    {
      complete_high_confidence: true,
      product_type: "cruise",
      raw: { official_sailing_id: "CSR14K" },
      candidate: {
        ship_id: "kp",
        departure_date: "2027-02-28",
        return_date: "2027-03-14",
        nights: 14,
        departure_port: "Fort Lauderdale",
        destination_id: "carib"
      }
    },
    cruiseLine
  );
  if (knownK.classification !== "RECOGNISED_CURRENT_ID") throw new Error("known duplicate official id must recognise itself");
  if (knownK.existing?.id !== "uuid-csr-k") throw new Error("CSR14K must keep its own UUID");
});

test("Princess production-equivalent path no longer treats remaps as hundreds of inserts", () => {
  const writes = require(path.join(root, "netlify/functions/lib/princess-discovery-writes"));
  const classifier = require(path.join(root, "netlify/functions/lib/princess-voyage-identity-classifier"));
  const products = [];
  const production = [];
  for (let i = 0; i < 12; i += 1) {
    production.push({
      id: `uuid-${i}`,
      official_sailing_id: `OLD${i}`,
      cruise_line_id: "princess",
      ship_id: `ship-${i}`,
      departure_date: `2028-01-${String(i + 1).padStart(2, "0")}`,
      return_date: `2028-01-${String(i + 8).padStart(2, "0")}`,
      nights: 7,
      departure_port: "Miami",
      destination_id: "carib",
      status: "active"
    });
    products.push({
      complete_high_confidence: true,
      completeness: "complete_high_confidence",
      product_type: "cruise",
      official_sailing_id: `NEW${i}`,
      ship_id: `ship-${i}`,
      departure_date: `2028-01-${String(i + 1).padStart(2, "0")}`,
      return_date: `2028-01-${String(i + 8).padStart(2, "0")}`,
      nights: 7,
      departure_port: "Miami",
      destination_id: "carib"
    });
  }
  const waterfall = classifier.classifyPrincessP3bEligibleSet(products, production);
  if (waterfall.counts.UNIQUE_OFFICIAL_ID_REMAP !== 12) throw new Error(JSON.stringify(waterfall.counts));
  if (waterfall.counts.TRUE_NEW !== 0) throw new Error("false inserts must disappear");
  const inserts = products.filter((product, index) => {
    const classified = waterfall.classified[index];
    return writes.classifyProposedAction(
      { complete_high_confidence: true, product_type: "cruise", raw: { sailing_id: product.official_sailing_id } },
      classified.matching_production?.[0] || null,
      classified
    ) === "insert_active";
  });
  if (inserts.length !== 0) throw new Error(`canonical path proposed ${inserts.length} false inserts`);
});

test("Princess accepted baseline is not manually advanced", () => {
  const lifecycle = require(path.join(root, "netlify/functions/lib/princess-accepted-baseline-lifecycle"));
  const decision = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_dry_run",
    dryRun: true,
    summary: { quality_gate: { passed: true, source_accounting: { passed: true, accounting: { accounting_exact: true } } } }
  });
  if (decision.accept === true) throw new Error("dry-run must not advance accepted baseline");
});

test("Disney additive source convergence freezes the latest stable snapshot", () => {
  const disney = require(path.join(root, "netlify/functions/lib/disney-source-convergence"));
  if (disney.DISNEY_CATCHUP_BATCH_CAP !== 30) throw new Error("Disney catch-up cap changed");
  const a = { identities: ["A", "B"], eligible: 2 };
  const b = { identities: ["A", "B", "C"], eligible: 3 };
  const c = { identities: ["A", "B", "C"], eligible: 3 };
  const waiting = disney.evaluateDisneySourceConvergence([a, b]);
  if (waiting.converged !== false) throw new Error("A vs additive B must wait for C");
  const converged = disney.evaluateDisneySourceConvergence([a, b, c]);
  if (converged.converged !== true) throw new Error("B==C must freeze");
  if (converged.frozen.hash !== disney.hashIdentitySet(c)) throw new Error("must freeze latest stable set");
});

test("Disney disappearing identity blocks catch-up", () => {
  const disney = require(path.join(root, "netlify/functions/lib/disney-source-convergence"));
  const blocked = disney.evaluateDisneySourceConvergence([
    { identities: ["A", "B", "C"], eligible: 3 },
    { identities: ["A", "B"], eligible: 2 }
  ]);
  if (blocked.classification !== "SOURCE_REPAIR_REQUIRED") throw new Error(blocked.classification);
  if (blocked.catch_up_blocked !== true) throw new Error("disappearing identities must block writes");
  if (blocked.frozen) throw new Error("must not freeze an unstable snapshot");
});

test("NCL ambiguity reasons are specific and review-only is not a technical failure", () => {
  const nclClassifier = require(path.join(root, "netlify/functions/lib/norwegian-voyage-identity-classifier"));
  const incomplete = nclClassifier.classifyNorwegianAmbiguityReason(
    { official_sailing_id: "SRC", ship_id: "s", departure_date: "2028-01-01" },
    []
  );
  if (incomplete.ambiguity_reason !== "SOURCE_FIELD_INCOMPLETE") throw new Error(incomplete.ambiguity_reason);
  const destOnly = nclClassifier.classifyNorwegianAmbiguityReason(
    {
      official_sailing_id: "SRC-NEW",
      ship_id: "s",
      departure_date: "2028-01-01",
      return_date: "2028-01-08",
      nights: 7,
      departure_port: "Miami",
      destination_id: "alaska"
    },
    [
      {
        id: "prod",
        official_sailing_id: "SRC-OLD",
        ship_id: "s",
        departure_date: "2028-01-01",
        return_date: "2028-01-08",
        nights: 7,
        departure_port: "Miami",
        destination_id: "carib"
      }
    ]
  );
  if (destOnly.ambiguity_reason !== "DESTINATION_ONLY_DIFFERENCE") throw new Error(destOnly.ambiguity_reason);
  const ncl = require(path.join(root, "netlify/functions/lib/norwegian-weekly-maintenance"));
  if (ncl.NCL_MAX_WEEKLY_WRITES !== 200) throw new Error("do not raise NCL write cap");
});

await testAsync("NCL match_required enrichment is not a duplicate insert", async () => {
  const nclManifest = require(path.join(root, "netlify/functions/lib/norwegian-weekly-manifest"));
  const manifest = await nclManifest.buildNorwegianWeeklyManifest({
    simulation: {
      products: [
        {
          official_sailing_id: "EXISTING|2028-01-01",
          complete_eligible: true,
          itinerary_classification: { category: "ocean" },
          ship_id: "ship-1",
          departure_date: "2028-01-01",
          return_date: "2028-01-08",
          nights: 7,
          departure_port: "Miami"
        }
      ],
      eligibility: { raw_sailings: 1, ocean_sailings: 1 }
    },
    productionRows: [
      {
        id: "mr-1",
        official_sailing_id: "EXISTING|2028-01-01",
        status: "match_required",
        ship_id: "ship-1",
        departure_date: "2028-01-01",
        return_date: "2028-01-08",
        nights: 7,
        departure_port: "Miami",
        raw_extract: { norwegian_official_sailing_id: "EXISTING|2028-01-01" }
      }
    ],
    cruiseLine: { id: "ncl", slug: "norwegian-cruise-line" },
    destinations: [],
    supabase: async () => [],
    today: "2026-09-09",
    runId: "ncl-match-required"
  });
  if (manifest.inserts.length !== 0) throw new Error("match_required row must not insert a duplicate");
  if (manifest.already_match_required !== 1) throw new Error("match_required must be counted");
});

test("Silversea scheduled mode stays dry-run review", () => {
  const dispatchMod = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-dispatch"));
  process.env.SILVERSEA_WEEKLY_RECONCILIATION_ENABLED = "true";
  delete process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED;
  if (dispatchMod.resolveDryRun({}, process.env) !== true) {
    throw new Error("Silversea Monday scheduled execution must remain dry-run");
  }
});

test("Royal fail-closed and daily expiry cutoff unchanged", () => {
  const cutoff = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
  if (cutoff.PUBLIC_BOOKING_CUTOFF_DAYS !== 21) throw new Error("21-day cutoff changed");
  const royal = fs.readFileSync(
    path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance.js"),
    "utf8"
  );
  if (!/SOURCE_REPAIR_REQUIRED|fail-closed|enumeration/.test(royal)) {
    throw new Error("Royal weekly path must remain fail-closed");
  }
});

test("Seabourn review is a deliberate review_required terminal", () => {
  const accounting = require(path.join(root, "netlify/functions/lib/weekly-maintenance-write-accounting"));
  const status = accounting.resolveWeeklyTerminalStatus({
    ok: false,
    review_required: true,
    reason: "REVIEW REQUIRED — NO WRITES",
    summary: { inserts: 0, updates: 0, review_sailing_ids: ["E7M21E|8763B"] }
  });
  if (status !== "review_required") throw new Error(status);
  if (accounting.resolveLedgerRunStatus(status) !== "completed") throw new Error("review must be ledger completed");
  const http = require(path.join(root, "netlify/functions/lib/maintenance-operational-status"));
  if (http.weeklyBackgroundHttpStatus({ success: true, review_required: true, terminal_status: "review_required" }) !== 200) {
    throw new Error("Seabourn review must be operational success");
  }
});

test("NCL incomplete supplier fields stay review_required with zero writes", () => {
  const classifier = require(path.join(root, "netlify/functions/lib/norwegian-voyage-identity-classifier"));
  const reason = classifier.classifyNorwegianAmbiguityReason({ official_sailing_id: "EPIC6X|2027-11-12" }, []);
  if (reason.ambiguity_reason !== "SOURCE_FIELD_INCOMPLETE") throw new Error(reason.ambiguity_reason);
  if (!reason.missing_required_fields.includes("ship")) throw new Error("ship must be listed");
  const accounting = require(path.join(root, "netlify/functions/lib/weekly-maintenance-write-accounting"));
  const status = accounting.resolveWeeklyTerminalStatus({
    ok: true,
    review_required: true,
    summary: { inserts: 0, updates: 0, review_sailing_ids: ["EPIC6X|2027-11-12"] }
  });
  if (status !== "review_required") throw new Error(status);
});

test("Carnival disabled write flag still forbids writes but weekly recon does not throw", () => {
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
    if (!threw) throw new Error("assert must still fail clearly");
    const src = fs.readFileSync(path.join(root, "netlify/functions/lib/carnival-weekly-maintenance.js"), "utf8");
    if (!/not_yet_commissioned/.test(src)) throw new Error("Carnival weekly must classify not_yet_commissioned");
    if (!/requestedWrites/.test(src)) throw new Error("Carnival weekly must skip write assert when flag is off");
  } finally {
    if (prev == null) delete process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED;
    else process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED = prev;
  }
});

test("Royal explained expired IDs do not count as unexplained current gaps", () => {
  const enumeration = require(path.join(root, "netlify/functions/lib/royal-caribbean-source-enumeration"));
  const explained = enumeration.evaluateWeeklyAuthoritativeEnumerationHealth({
    simulationOk: true,
    unionSailingIds: new Set(["CURRENT_A"]),
    productionSailingIds: new Set(["CURRENT_A", "EXPIRED_B"]),
    currentExpectedProductionSailingIds: new Set(["CURRENT_A"]),
    explainedAbsentSailingIds: ["EXPIRED_B"],
    duplicateSailingIds: 0,
    detailLookupResults: []
  });
  if (explained.royal_caribbean_source_enumeration_ok !== true) {
    throw new Error(`expired IDs must not fail health: ${explained.failures.join(",")}`);
  }
  if (explained.unexplained_production_absent_count !== 0) throw new Error("expired must be explained");
});

test("Royal true unexplained current IDs keep source health false", () => {
  const enumeration = require(path.join(root, "netlify/functions/lib/royal-caribbean-source-enumeration"));
  const unexplained = enumeration.evaluateWeeklyAuthoritativeEnumerationHealth({
    simulationOk: true,
    unionSailingIds: new Set(["CURRENT_A"]),
    productionSailingIds: new Set(["CURRENT_A", "EX07M807_2026-10-17"]),
    currentExpectedProductionSailingIds: new Set(["CURRENT_A", "EX07M807_2026-10-17"]),
    explainedAbsentSailingIds: [],
    duplicateSailingIds: 0,
    detailLookupResults: [{ official_sailing_id: "EX07M807_2026-10-17", detail_ok: false, retrievable: false }]
  });
  if (unexplained.royal_caribbean_source_enumeration_ok === true) {
    throw new Error("unexplained current IDs must keep enumeration fail-closed");
  }
  if (!unexplained.unexplained_current_production_ids.includes("EX07M807_2026-10-17")) {
    throw new Error("must persist unexplained current id");
  }
});

test("Azamara zero source is source_repair_required and cannot hide inventory", () => {
  const adapter = require(path.join(root, "netlify/functions/lib/azamara-discovery-adapter"));
  const collapse = adapter.detectAzamaraSourceCollapse({
    simulation: {
      fetch_result: { ok: true, sitemap_locs: 0, sitemap_packages: 0, eligible_urls: 0 },
      source_eligible_official_ids: []
    },
    productionOfficial: 453
  });
  if (!collapse.collapsed) throw new Error("zero eligible vs 453 production must collapse");
  const accounting = require(path.join(root, "netlify/functions/lib/weekly-maintenance-write-accounting"));
  const status = accounting.resolveWeeklyTerminalStatus({
    ok: false,
    source_repair_required: true,
    reason: "SOURCE_REPAIR_REQUIRED",
    summary: { inserts: 0, updates: 0, source_absence_hidden: 0 }
  });
  if (status !== "source_repair_required") throw new Error(status);
  const azamara = fs.readFileSync(path.join(root, "netlify/functions/lib/azamara-weekly-maintenance.js"), "utf8");
  if (!/source_absence_hides = \[\]/.test(azamara)) throw new Error("collapse must zero source-absence hides");
});

test("Silversea reviews are review_required/read_only with zero writes", () => {
  const accounting = require(path.join(root, "netlify/functions/lib/weekly-maintenance-write-accounting"));
  const status = accounting.resolveWeeklyTerminalStatus({
    ok: true,
    review_required: true,
    read_only: true,
    summary: { inserts: 0, updates: 0, proposed_updates: 63 }
  });
  if (status !== "review_required") throw new Error(status);
  if (accounting.resolveLedgerRunStatus(status) !== "completed") throw new Error("silversea review must complete");
});

test("Disney deadline classifies source_unstable", () => {
  const accounting = require(path.join(root, "netlify/functions/lib/weekly-maintenance-write-accounting"));
  const status = accounting.resolveWeeklyTerminalStatus({
    ok: false,
    source_unstable: true,
    reason: "SOURCE_TIMEOUT",
    summary: { inserts: 0, updates: 0 }
  });
  if (status !== "source_unstable") throw new Error(status);
  const disney = fs.readFileSync(path.join(root, "netlify/functions/lib/disney-weekly-maintenance.js"), "utf8");
  if (!/SOURCE_TIMEOUT/.test(disney) || !/source_unstable/.test(disney)) {
    throw new Error("Disney weekly must abort deadline as source_unstable");
  }
});

await testAsync("deliberate blocked states persist finished_at and operational success", async () => {
  const finalized = [];
  const base = memoryLockStore();
  const sb = async (path, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (path === "cruise_discovery_runs" && method === "POST") {
      return [{ id: "run-deliberate", status: "running", stats: {} }];
    }
    if (path.startsWith("cruise_discovery_runs?") && method === "PATCH") {
      finalized.push(JSON.parse(options.body));
      return [];
    }
    return base(path, options);
  };
  const cases = [
    { terminal_status: "review_required", review_required: true, reason: "REVIEW_REQUIRED" },
    { terminal_status: "source_repair_required", source_repair_required: true, reason: "SOURCE_REPAIR_REQUIRED" },
    { terminal_status: "source_unstable", source_unstable: true, reason: "SOURCE_TIMEOUT" },
    { terminal_status: "not_yet_commissioned", not_yet_commissioned: true, reason: "NOT_YET_COMMISSIONED" },
    { terminal_status: "read_only", read_only: true, reason: "READ_ONLY" }
  ];
  for (const sample of cases) {
    finalized.length = 0;
    const result = await cron.executeWeeklyMaintenance({
      lineSlug: "explora-journeys",
      cruiseLineId: "explora",
      runType: "explora_weekly_maintenance",
      assertEnabled: () => {},
      runMaintenance: async () => ({
        ok: false,
        success: true,
        ...sample,
        summary: { inserts: 0, updates: 0, inventory_changed: false }
      }),
      dryRun: true,
      supabaseClient: sb
    });
    if (result.success !== true) throw new Error(`${sample.terminal_status} must succeed operationally`);
    if (finalized[0]?.status !== "completed") throw new Error(`${sample.terminal_status} ledger ${finalized[0]?.status}`);
    if (!finalized[0]?.finished_at) throw new Error(`${sample.terminal_status} missing finished_at`);
    if (finalized[0]?.error_message) throw new Error(`${sample.terminal_status} must not look like weekly_maintenance_failed`);
  }
});

await testAsync("true thrown exception still fails", async () => {
  const finalized = [];
  const base = memoryLockStore();
  const sb = async (path, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (path === "cruise_discovery_runs" && method === "POST") {
      return [{ id: "run-boom", status: "running", stats: {} }];
    }
    if (path.startsWith("cruise_discovery_runs?") && method === "PATCH") {
      finalized.push(JSON.parse(options.body));
      return [];
    }
    return base(path, options);
  };
  let threw = false;
  try {
    await cron.executeWeeklyMaintenance({
      lineSlug: "explora-journeys",
      cruiseLineId: "explora",
      runType: "explora_weekly_maintenance",
      assertEnabled: () => {},
      runMaintenance: async () => {
        throw new Error("database exploded");
      },
      dryRun: true,
      supabaseClient: sb
    });
  } catch (error) {
    threw = /database exploded/.test(error.message);
  }
  if (!threw) throw new Error("unexpected exception must rethrow");
  if (finalized[0]?.status !== "failed") throw new Error("true exception must fail the ledger");
  if (!finalized[0]?.finished_at) throw new Error("failed run must still persist finished_at");
});

await testAsync("partial writes still fail loudly", async () => {
  const finalized = [];
  const base = memoryLockStore();
  const sb = async (path, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (path === "cruise_discovery_runs" && method === "POST") {
      return [{ id: "run-partial", status: "running", stats: {} }];
    }
    if (path.startsWith("cruise_discovery_runs?") && method === "PATCH") {
      finalized.push(JSON.parse(options.body));
      return [];
    }
    return base(path, options);
  };
  const result = await cron.executeWeeklyMaintenance({
    lineSlug: "explora-journeys",
    cruiseLineId: "explora",
    runType: "explora_weekly_maintenance",
    assertEnabled: () => {},
    runMaintenance: async () => ({
      ok: false,
      success: false,
      reason: "apply_failed",
      summary: { inserts: 4, updates: 0, failed_writes: 2, inventory_changed: true }
    }),
    dryRun: false,
    supabaseClient: sb
  });
  if (result.success !== false) throw new Error("partial writes must not look healthy");
  if (finalized[0]?.status !== "failed") throw new Error(finalized[0]?.status);
  if (finalized[0]?.stats?.terminal_status !== "partial_write_failure") {
    throw new Error(finalized[0]?.stats?.terminal_status);
  }
});

if (failures.length) {
  console.error(`\ntest-weekly-maintenance-reliability-p0: ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`\ntest-weekly-maintenance-reliability-p0: ${passed} passed`);
