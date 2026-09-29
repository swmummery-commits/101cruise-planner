#!/usr/bin/env node
/**
 * Princess P3N lifecycle re-architecture tests.
 *   node scripts/test-princess-p3n-rearchitecture.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const partition = require(path.join(root, "netlify/functions/lib/princess-canonical-reconciliation"));
const remap = require(path.join(root, "netlify/functions/lib/princess-deterministic-remap"));
const lanes = require(path.join(root, "netlify/functions/lib/princess-weekly-lanes"));
const outcome = require(path.join(root, "netlify/functions/lib/princess-weekly-outcome"));
const history = require(path.join(root, "netlify/functions/lib/princess-identity-remap-history"));
const worker = require(path.join(root, "netlify/functions/lib/princess-source-worker-watch"));
const quality = require(path.join(root, "netlify/functions/lib/princess-weekly-quality"));
const cli = require(path.join(root, "netlify/functions/lib/princess-weekly-maintenance-cli"));
const writeAccounting = require(path.join(root, "netlify/functions/lib/weekly-maintenance-write-accounting"));
const scheduleMap = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-map"));
const cutoff = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

const applyWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/princess-weekly-maintenance-apply.yml"),
  "utf8"
);
const netlifyToml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
const runnerSrc = fs.readFileSync(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"),
  "utf8"
);
const writesSrc = fs.readFileSync(
  path.join(root, "netlify/functions/lib/princess-discovery-writes.js"),
  "utf8"
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function w40Active() {
  const recognised = Array.from({ length: 1928 }, (_, i) => ({
    id: `rec-${i}`,
    official_sailing_id: `REC|${i}|2027-01-01`,
    status: "active",
    departure_date: "2027-06-01"
  }));
  const updates = Array.from({ length: 10 }, (_, i) => ({
    id: `upd-${i}`,
    official_sailing_id: `UPD|${i}|2027-02-01`,
    status: "active",
    departure_date: "2027-06-01"
  }));
  const remaps = [
    {
      id: "remap-sf",
      official_sailing_id: "SFS33A|MJ|2026-11-19",
      ship_id: "mj",
      departure_date: "2026-11-19",
      return_date: "2026-12-22",
      nights: 33,
      departure_port: "Sydney",
      destination_id: "aus",
      status: "active"
    },
    {
      id: "remap-sb",
      official_sailing_id: "SBS15A|MJ|2026-12-07",
      ship_id: "mj",
      departure_date: "2026-12-07",
      return_date: "2026-12-22",
      nights: 15,
      departure_port: "Sydney",
      destination_id: "aus",
      status: "active"
    },
    {
      id: "remap-vb",
      official_sailing_id: "SSB15C|MJ|2026-12-22",
      ship_id: "mj",
      departure_date: "2026-12-22",
      return_date: "2027-01-06",
      nights: 15,
      departure_port: "Sydney",
      destination_id: "aus",
      status: "active"
    }
  ];
  const absent = Array.from({ length: 10 }, (_, i) => ({
    id: `abs-${i}`,
    official_sailing_id: `ABS|${i}|2027-03-01`,
    status: "active",
    departure_date: "2027-06-01"
  }));
  return [...recognised, ...updates, ...remaps, ...absent];
}

test("source-absence UUID dedupe drops repeated recognition paths", () => {
  const { unique, duplicate_entries } = partition.dedupeSourceAbsentByUuid([
    { discovered_cruise_id: "u1", official_sailing_id: "SFS33A|MJ|2026-11-19" },
    { discovered_cruise_id: "u1", official_sailing_id: "SFS33A|MJ|2026-11-19" },
    { discovered_cruise_id: "u2", official_sailing_id: "SBS15A|MJ|2026-12-07" }
  ]);
  if (unique.length !== 2) throw new Error(`unique ${unique.length}`);
  if (duplicate_entries.length !== 1) throw new Error("expected one duplicate path");
});

test("all active UUIDs assigned exactly once — W40 fixture", () => {
  const active = w40Active();
  const eligible = [
    ...active.filter((r) => r.id.startsWith("rec-") || r.id.startsWith("upd-")).map((r) => r.official_sailing_id),
    "SFV33A|MJ|2026-11-19",
    "SBV15A|MJ|2026-12-07",
    "SVB15A|MJ|2026-12-22"
  ];
  const result = partition.partitionPrincessActiveProduction({
    activeRows: active,
    eligibleOfficialIds: eligible,
    recognisedUuids: active.filter((r) => r.id.startsWith("rec-") || r.id.startsWith("upd-")).map((r) => r.id),
    reviewUuids: ["remap-sf", "remap-sb", "remap-vb"],
    sourceAbsentUuids: active.filter((r) => r.id.startsWith("abs-")).map((r) => r.id)
  });
  if (!result.accounting_exact) throw new Error("accounting not exact");
  if (result.active_production_total !== 1951) throw new Error(`active ${result.active_production_total}`);
  if (result.counts.RECOGNISED_ELIGIBLE !== 1938) throw new Error(`recognised ${result.counts.RECOGNISED_ELIGIBLE}`);
  if (result.counts.REVIEW_REQUIRED !== 3) throw new Error(`review ${result.counts.REVIEW_REQUIRED}`);
  if (result.counts.SOURCE_ABSENT_RETAINED !== 10) throw new Error(`absent ${result.counts.SOURCE_ABSENT_RETAINED}`);
  if (result.counts.UNEXPLAINED !== 0) throw new Error("unexplained must be 0");
});

test("unexplained row causes write block", () => {
  const result = partition.partitionPrincessActiveProduction({
    activeRows: [
      { id: "a", official_sailing_id: "A|1|2027-01-01", departure_date: "2027-06-01", status: "active" },
      { id: "u", official_sailing_id: "", departure_date: "2027-06-01", status: "active" }
    ],
    eligibleOfficialIds: ["A|1|2027-01-01"],
    recognisedUuids: ["a"]
  });
  const gate = partition.assertPrincessCanonicalAccounting(result);
  if (gate.ok) throw new Error("unexplained must fail");
  const plan = lanes.buildPrincessWeeklyLanes({
    safeUpdates: [{ official_sailing_id: "A|1|2027-01-01", action: "update_safe_metadata_allowed" }],
    unexplainedUuids: result.uuid_lists.UNEXPLAINED,
    sourceHealthPass: true,
    sourceAccountingExact: true,
    canonicalAccountingExact: false
  });
  if (plan.can_run_safe_lane) throw new Error("safe lane must be blocked");
  if (plan.blocked_reason !== "unexplained_active_rows" && plan.blocked_reason !== "canonical_accounting_inexact") {
    throw new Error(plan.blocked_reason);
  }
});

test("deterministic remap exact one-to-one across two snapshots", () => {
  const production = {
    id: "uuid-1",
    official_sailing_id: "SFS33A|MJ|2026-11-19",
    ship_id: "mj",
    departure_date: "2026-11-19",
    return_date: "2026-12-22",
    nights: 33,
    departure_port: "Sydney",
    destination_id: "aus",
    external_key: "old-ext",
    identity_key: "old-id"
  };
  const source = {
    official_sailing_id: "SFV33A|MJ|2026-11-19",
    ship_id: "mj",
    departure_date: "2026-11-19",
    return_date: "2026-12-22",
    nights: 33,
    departure_port: "Sydney",
    destination_id: "aus",
    external_key: "new-ext",
    identity_key: "new-id"
  };
  const classified = remap.classifyPrincessIdentityRemap({
    productionRow: production,
    sourceCandidates: [source],
    productionRows: [production],
    snapshotAOfficialIds: ["SFV33A|MJ|2026-11-19"],
    snapshotBOfficialIds: ["SFV33A|MJ|2026-11-19"]
  });
  if (classified.classification !== "DETERMINISTIC_REMAP") throw new Error(classified.classification);
  if (!classified.write_allowed) throw new Error("write must be allowed");
});

test("ambiguous remap stays review", () => {
  const production = {
    id: "uuid-1",
    official_sailing_id: "OLD|1|2026-11-19",
    ship_id: "mj",
    departure_date: "2026-11-19",
    return_date: "2026-12-01",
    nights: 12,
    departure_port: "Sydney",
    destination_id: "aus"
  };
  const classified = remap.classifyPrincessIdentityRemap({
    productionRow: production,
    sourceCandidates: [
      { ...production, official_sailing_id: "NEW-A|1|2026-11-19" },
      { ...production, official_sailing_id: "NEW-B|1|2026-11-19" }
    ],
    productionRows: [production],
    snapshotAOfficialIds: ["NEW-A|1|2026-11-19", "NEW-B|1|2026-11-19"],
    snapshotBOfficialIds: ["NEW-A|1|2026-11-19", "NEW-B|1|2026-11-19"]
  });
  if (classified.classification !== "AMBIGUOUS_REMAP") throw new Error(classified.classification);
  if (classified.write_allowed) throw new Error("ambiguous must not write");
});

test("remap preserves UUID in history record", () => {
  const record = history.buildPrincessRemapHistoryRecord({
    discoveredCruiseId: "uuid-1",
    oldOfficialSailingId: "OLD",
    newOfficialSailingId: "NEW",
    runRecordId: "run-1"
  });
  if (record.discovered_cruise_id !== "uuid-1") throw new Error("uuid lost");
  if (record.deleted_old_row || record.inserted_replacement_row) throw new Error("must not delete/insert");
  if (record.uuid_preserved !== true) throw new Error("uuid_preserved");
});

test("remap collision blocks", () => {
  const production = {
    id: "uuid-1",
    official_sailing_id: "OLD|1|2026-11-19",
    ship_id: "mj",
    departure_date: "2026-11-19",
    return_date: "2026-12-01",
    nights: 12,
    departure_port: "Sydney",
    destination_id: "aus"
  };
  const other = {
    id: "uuid-2",
    official_sailing_id: "NEW|1|2026-11-19",
    ship_id: "other",
    departure_date: "2028-01-01",
    return_date: "2028-01-10",
    nights: 9,
    departure_port: "Miami",
    destination_id: "car"
  };
  const classified = remap.classifyPrincessIdentityRemap({
    productionRow: production,
    sourceCandidates: [{ ...production, official_sailing_id: "NEW|1|2026-11-19" }],
    productionRows: [production, other],
    snapshotAOfficialIds: ["NEW|1|2026-11-19"],
    snapshotBOfficialIds: ["NEW|1|2026-11-19"]
  });
  if (classified.classification !== "AMBIGUOUS_REMAP") throw new Error(classified.classification);
  if (!classified.failures.includes("official_id_collision")) throw new Error(JSON.stringify(classified.failures));
});

test("safe update executes while unrelated review exists", () => {
  const plan = lanes.buildPrincessWeeklyLanes({
    safeUpdates: [{ official_sailing_id: "SAFE|1", action: "update_safe_metadata_allowed", discovered_cruise_id: "u-safe" }],
    reviewItems: [{ official_sailing_id: "REV|1", action: "update_identity_review_required", discovered_cruise_id: "u-rev" }],
    unexplainedUuids: [],
    sourceHealthPass: true,
    sourceAccountingExact: true,
    canonicalAccountingExact: true
  });
  if (!plan.can_run_safe_lane) throw new Error("safe lane should run");
  if (!plan.review_does_not_block_safe_lane) throw new Error("review must not block");
  if (plan.lane_b_review.length < 1) throw new Error("review lane empty");
});

test("review row remains unchanged when only safe lane is frozen", () => {
  const frozen = lanes.freezePrincessMaterialPlan(
    lanes.buildPrincessWeeklyLanes({
      safeInserts: [{ official_sailing_id: "NEW|1", action: "insert_active" }],
      reviewItems: [{ official_sailing_id: "REV|1", discovered_cruise_id: "u-rev" }],
      sourceHealthPass: true,
      sourceAccountingExact: true,
      canonicalAccountingExact: true
    })
  );
  if (!frozen.lane_a_safe.some((r) => r.action === "insert_active")) throw new Error("missing insert");
  if (!frozen.lane_b_review.some((r) => r.discovered_cruise_id === "u-rev")) throw new Error("review dropped");
  if (frozen.lane_a_safe.some((r) => r.discovered_cruise_id === "u-rev")) throw new Error("review leaked into safe");
});

test("safe insert executes while unrelated review exists", () => {
  const plan = lanes.buildPrincessWeeklyLanes({
    safeInserts: [{ official_sailing_id: "NEW|1", action: "insert_active" }],
    reviewItems: [{ official_sailing_id: "REV|1" }],
    sourceHealthPass: true,
    sourceAccountingExact: true,
    canonicalAccountingExact: true
  });
  if (!plan.can_run_safe_lane) throw new Error(plan.blocked_reason);
});

test("remaining identity-review is allowed after safe-lane apply when unexplained is 0", () => {
  const result = cli.validatePostWriteReconciliation({
    active_production_total: 1951,
    eligible_total: 1941,
    recognised_existing_eligible: 1928,
    outstanding_eligible_inserts: 0,
    proposed_updates: 0,
    proposed_identity_review_updates: 3,
    source_absent_active: 10,
    daily_expiry_managed: 0,
    other_explained_non_eligible_active: 13,
    reconciliation_arithmetic_ok: true,
    unexplained_active_ok: true,
    unexplained_active_rows: 0,
    canonical_accounting_exact: true
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
});

test("review-only state is not infrastructure FAILURE", () => {
  const resolved = outcome.resolvePrincessWeeklyOutcome({
    sourceHealthy: true,
    sourceAccountingExact: true,
    canonicalAccountingExact: true,
    unexplainedCount: 0,
    safeLaneProcessed: true,
    reviewCount: 3,
    writesVerified: true
  });
  if (resolved.outcome !== "completed_with_review") throw new Error(resolved.outcome);
  if (resolved.github_exit_code !== 0) throw new Error("must not be red");
  if (resolved.infrastructure_failure) throw new Error("must not be infrastructure failure");
  if (resolved.ledger_status !== "completed") throw new Error(resolved.ledger_status);
});

test("artifact upload failure does not alter maintenance outcome", () => {
  const resolved = outcome.resolvePrincessWeeklyOutcome({
    sourceHealthy: true,
    sourceAccountingExact: true,
    canonicalAccountingExact: true,
    unexplainedCount: 0,
    safeLaneProcessed: true,
    reviewCount: 0,
    writesVerified: true,
    artifactUploadFailed: true
  });
  if (resolved.outcome !== "completed") throw new Error(resolved.outcome);
  if (resolved.github_exit_code !== 0) throw new Error("artifact must be non-authoritative");
  if (!applyWorkflow.includes("continue-on-error: true")) {
    throw new Error("artifact step must continue-on-error");
  }
  if (!/Upload apply report artifact[\s\S]*continue-on-error: true/.test(applyWorkflow)) {
    throw new Error("continue-on-error must be on the artifact step");
  }
});

test("single schedule owner is declared", () => {
  const princess = scheduleMap.WEEKLY_LINE_SCHEDULE.find((row) => row.slug === "princess-cruises");
  if (!princess) throw new Error("princess schedule missing");
  if (princess.perth_hour !== 5) throw new Error("business timing changed");
  const princessTomlBlock = netlifyToml.match(
    /\[functions\."princess-weekly-maintenance-cron"\][\s\S]*?(?=\n\[functions\.|$)/
  )?.[0] || "";
  const scheduledInToml = /^\s*schedule\s*=/m.test(princessTomlBlock);
  const githubScheduled = /schedule:[\s\S]*cron: "0 21 \* \* 0"/.test(applyWorkflow);
  const owners = [scheduledInToml && "netlify", githubScheduled && "github"].filter(Boolean);
  if (owners.length > 1) throw new Error(`two schedulers: ${owners.join(",")}`);
  if (owners.length !== 1) throw new Error("no scheduler owner");
  if (owners[0] !== "netlify") throw new Error("Netlify must own Princess weekly schedule");
});

test("scheduled lease idempotency key remains week-scoped", () => {
  const control = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control"));
  const key = control.scheduledWeeklyDispatchKey("princess-cruises", new Date("2026-09-28T00:00:00Z"));
  if (!key.includes("princess-cruises")) throw new Error(key);
  if (!key.endsWith(":scheduled")) throw new Error(key);
});

test("worker-not-started detection after grace", () => {
  const expected = Date.parse("2026-09-27T21:00:00Z");
  const late = worker.evaluatePrincessSourceWorkerStart({
    expectedStartMs: expected,
    harvestStartedMs: null,
    nowMs: expected + 21 * 60 * 1000
  });
  if (late.status !== "source_worker_not_started") throw new Error(late.status);
  const started = worker.evaluatePrincessSourceWorkerStart({
    expectedStartMs: expected,
    harvestStartedMs: expected + 60 * 1000
  });
  if (started.status !== "started") throw new Error(started.status);
});

test("manifest-before-write still required in Princess runner", () => {
  if (!runnerSrc.includes("persistPrincessPreApplyRollbackManifest")) {
    throw new Error("pre-apply rollback missing");
  }
  if (!runnerSrc.includes("if (!rollbackPersist.skipped && rollbackPersist.ok !== true)")) {
    throw new Error("persist failure must block writes");
  }
});

test("post-write verification remains mandatory", () => {
  if (!runnerSrc.includes("postWriteLifecycle") && !fs.readFileSync(
    path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-cron.js"),
    "utf8"
  ).includes("postWriteLifecycle")) {
    throw new Error("post-write lifecycle missing");
  }
});

test("max 30 writes unchanged", () => {
  if (lanes.PRINCESS_WEEKLY_WRITE_CAP !== 30) throw new Error("cap changed");
  if (quality.PRINCESS_WEEKLY_WRITE_CAP !== 30) throw new Error("quality cap changed");
  const over = lanes.buildPrincessWeeklyLanes({
    safeInserts: Array.from({ length: 31 }, (_, i) => ({ official_sailing_id: `N${i}`, action: "insert_active" })),
    sourceHealthPass: true,
    sourceAccountingExact: true,
    canonicalAccountingExact: true
  });
  if (over.can_run_safe_lane) throw new Error(">30 must not auto-apply");
  if (over.blocked_reason !== "weekly_change_volume_exceeds_initial_cap") throw new Error(over.blocked_reason);
});

test("source failure = zero writes", () => {
  const resolved = outcome.resolvePrincessWeeklyOutcome({
    sourceFailure: true,
    safeLaneProcessed: false,
    writesVerified: true
  });
  if (resolved.outcome !== "failed") throw new Error(resolved.outcome);
  const plan = lanes.buildPrincessWeeklyLanes({
    safeInserts: [{ official_sailing_id: "X", action: "insert_active" }],
    sourceHealthPass: false,
    sourceAccountingExact: true,
    canonicalAccountingExact: true
  });
  if (plan.can_run_safe_lane) throw new Error("source failure must block writes");
});

test("source absence is retained, not hidden", () => {
  const result = partition.partitionPrincessActiveProduction({
    activeRows: [{ id: "abs", official_sailing_id: "GONE|1|2027-01-01", departure_date: "2027-06-01", status: "active" }],
    eligibleOfficialIds: [],
    sourceAbsentUuids: ["abs"]
  });
  if (result.counts.SOURCE_ABSENT_RETAINED !== 1) throw new Error("must retain");
  if (result.counts.UNEXPLAINED !== 0) throw new Error("retained is explained");
  if (writesSrc.includes("source_absence_hidden") && /princess/.test(writesSrc)) {
    /* presence in generic write stats is fine */
  }
});

test("daily cutoff unchanged at 21 days", () => {
  if (cutoff.PUBLIC_BOOKING_CUTOFF_DAYS !== 21) throw new Error("cutoff changed");
});

test("identity review no longer fails the quality gate by itself", () => {
  const gate = quality.evaluatePrincessWeeklyQualityGate({
    metrics: {
      eligible_total: 1941,
      ship_resolution_pct: 100,
      departure_port_resolution_pct: 100,
      destination_resolution_pct: 100,
      identity_coverage_pct: 100,
      duplicate_official_identities: 0
    },
    previousEligible: { stats: { accepted_inventory_baseline: true, accepted_eligible_total: 1958 } },
    manifest: {
      products: [
        { proposed_action: "update_identity_review_required" },
        { proposed_action: "update_safe_metadata_allowed" }
      ]
    },
    dryRun: false,
    performWrites: true,
    simulation: {
      raw_sailing_count: 1997,
      raw_group_count: 974,
      metrics: { expanded_dated_sailings: 1997 },
      products: []
    },
    summary: {
      eligible_total: 1941,
      official_source_total: 974,
      disjoint_accounting: {
        expanded_dated_sailings: 1997,
        within_public_cutoff: 56,
        public_eligible_complete: 1941,
        public_incomplete: 0,
        other_excluded: 0,
        accounted_total: 1997,
        accounting_delta: 0,
        accounting_exact: true
      }
    }
  });
  if (!gate.passed) throw new Error(JSON.stringify(gate.failures));
  if (!gate.auto_apply_permitted) throw new Error("safe lane must still be permitted");
  if (!gate.review_required) throw new Error("reviews must still be flagged");
});

test("completed_with_review is a healthy CLI status", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    startedAt: "2026-09-28T00:00:00.000Z",
    endedAt: "2026-09-28T00:01:00.000Z",
    environment: cli.classifyExecutionEnvironment({}),
    executeResult: {
      success: true,
      review_required: true,
      terminal_status: "completed_with_review",
      summary: { quality_gate: { passed: true }, terminal_status: "completed_with_review" }
    },
    maintenanceResult: {
      ok: true,
      review_required: true,
      terminal_status: "completed_with_review",
      summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: true }
    },
    countsBefore: { princess: 1951 },
    countsAfter: { princess: 1951 }
  });
  if (!["completed", "completed_with_review", "review_required"].includes(report.status)) {
    throw new Error(report.status);
  }
  if (cli.resolveWeeklyMaintenanceExitCode(report) !== 0) throw new Error("exit must be 0");
});

test("write-accounting accepts completed_with_review as healthy", () => {
  const terminal = writeAccounting.resolveWeeklyTerminalStatus({
    ok: true,
    review_required: true,
    terminal_status: "completed_with_review",
    summary: { inserts: 0, updates: 10, failed_writes: 0, inventory_changed: true }
  });
  if (!["completed", "completed_with_review"].includes(terminal)) throw new Error(terminal);
  if (writeAccounting.resolveLedgerRunStatus("completed_with_review") !== "completed") {
    throw new Error("ledger must stay completed");
  }
});

console.log(`\n${passed} Princess P3N tests passed`);
