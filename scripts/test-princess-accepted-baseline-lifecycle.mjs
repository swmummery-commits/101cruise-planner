#!/usr/bin/env node
/**
 * Princess accepted baseline lifecycle tests (Incident P4).
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const lifecycle = require(path.join(root, "netlify/functions/lib/princess-accepted-baseline-lifecycle"));
const quality = require(path.join(root, "netlify/functions/lib/princess-weekly-quality"));
const cli = require(path.join(root, "netlify/functions/lib/princess-weekly-maintenance-cli"));

const RUN_TYPE = "princess_weekly_maintenance";
const P3_HASH = "5161b08de272b733756aff82515bbf1a3faa2f112d4d2d2fe12f2b0bd86be817";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${passed}. ${name}`);
}

function healthySummary(eligible = 2061, overrides = {}) {
  return {
    eligible_total: eligible,
    snapshot_id: P3_HASH,
    inserts: 0,
    updates: 0,
    failed_writes: 0,
    proposed_inserts: 0,
    proposed_updates: 0,
    reconciliation_arithmetic_ok: true,
    zero_change_apply: true,
    quality_gate: {
      passed: true,
      failures: [],
      source_accounting: { passed: true, accounting: { accounting_exact: true, accounting_delta: 0 } },
      expansion_anomaly: { passed: true, previous_eligible_total: 2061, current_eligible_total: eligible },
      auto_apply_permitted: true
    },
    source_accounting: { accounting_exact: true, accounting_delta: 0 },
    ...overrides
  };
}

function healthyExecute(overrides = {}) {
  return { success: true, blocked: false, review_required: false, zero_change_apply: true, ...overrides };
}

function healthyReport(overrides = {}) {
  return {
    manifestValidation: { ok: true, skipped: true },
    postWriteVerification: { ok: true, skipped: true },
    postWriteReconciliation: { ok: true, skipped: true },
    ...overrides
  };
}

const p3Run = {
  id: "p3-baseline-id",
  finished_at: "2026-08-17T03:16:00.000Z",
  stats: {
    run_type: RUN_TYPE,
    trigger_type: "incident_p3_baseline_acceptance",
    accepted_inventory_baseline: true,
    accepted_eligible_total: 2061,
    accepted_eligible_hash: P3_HASH,
    accepted_at: "2026-08-17T03:16:00.000Z",
    accepted_reason: lifecycle.PRINCESS_P3_BASELINE_REASON
  }
};

const oldScheduled = {
  id: "old-sched",
  finished_at: "2026-08-01T00:00:00.000Z",
  stats: { run_type: RUN_TYPE, trigger_type: "scheduled", eligible_total: 1502 }
};

test("P3 baseline record recognised", () => {
  const selected = lifecycle.selectLatestPrincessAcceptedBaseline([oldScheduled, p3Run], RUN_TYPE);
  if (selected.id !== "p3-baseline-id") throw new Error("expected P3 baseline");
});

test("accepted baseline 2061 selected over older scheduled runs", () => {
  const lookup = lifecycle.resolvePrincessAcceptedBaselineLookup([oldScheduled, p3Run], RUN_TYPE, oldScheduled);
  if (lookup.baseline_source !== "accepted_baseline") throw new Error("expected accepted_baseline source");
  if (lookup.baseline_eligible_total !== 2061) throw new Error("expected 2061");
});

test("healthy scheduled zero-change run advances baseline", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: healthySummary(2061),
    executeResult: healthyExecute(),
    report: healthyReport(),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (!result.accept) throw new Error(JSON.stringify(result.failures));
});

test("healthy scheduled successful insert run advances baseline", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: healthySummary(2070, {
      inserts: 9,
      zero_change_apply: false,
      proposed_inserts: 9,
      rollback_manifest_id: "test-manifest-id"
    }),
    executeResult: healthyExecute({ zero_change_apply: false }),
    report: healthyReport({
      manifestValidation: { ok: true },
      postWriteVerification: { ok: true },
      postWriteReconciliation: { ok: true }
    }),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (!result.accept) throw new Error(JSON.stringify(result.failures));
  const stats = lifecycle.buildPrincessAcceptedBaselineStats(healthySummary(2070, { inserts: 9 }), {});
  if (stats.accepted_eligible_total !== 2070) throw new Error("expected 2070 stored");
});

test("accepted eligible total stored", () => {
  const stats = lifecycle.buildPrincessAcceptedBaselineStats({ eligible_total: 2070, snapshot_id: "abc" }, {});
  if (stats.accepted_eligible_total !== 2070) throw new Error("missing total");
});

test("accepted eligible hash stored", () => {
  const stats = lifecycle.buildPrincessAcceptedBaselineStats({ eligible_total: 2070, snapshot_id: "abc" }, {});
  if (stats.accepted_eligible_hash !== "abc") throw new Error("missing hash");
});

test("accepted_at stored", () => {
  const stats = lifecycle.buildPrincessAcceptedBaselineStats({ eligible_total: 2061, snapshot_id: P3_HASH }, {
    acceptedAt: "2026-08-17T00:00:00.000Z"
  });
  if (!stats.accepted_at) throw new Error("missing accepted_at");
});

test("accepted_reason stored", () => {
  const stats = lifecycle.buildPrincessAcceptedBaselineStats({ eligible_total: 2061, snapshot_id: P3_HASH }, {});
  if (!stats.accepted_reason) throw new Error("missing reason");
});

test("review_required does NOT advance baseline", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: healthySummary(2485),
    executeResult: healthyExecute({ review_required: true }),
    report: healthyReport(),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (result.accept) throw new Error("review_required must not advance");
});

test("review_required exit-0 cannot accidentally count as accepted", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: { ...healthySummary(), review_required: true },
    executeResult: { success: true, review_required: true },
    report: healthyReport(),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (result.accept) throw new Error("exit-0 review_required must not accept");
});

test("failed source run does not advance", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: healthySummary(),
    executeResult: { success: false },
    report: healthyReport(),
    maintenanceResult: { ok: false },
    dryRun: false,
    simulation: { fetch_failed: true }
  });
  if (result.accept) throw new Error("source failure must not advance");
});

test("blocked run does not advance", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: healthySummary(),
    executeResult: { success: true, blocked: true },
    report: healthyReport(),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (result.accept) throw new Error("blocked must not advance");
});

test("accounting failure does not advance", () => {
  const summary = healthySummary();
  summary.quality_gate.source_accounting = { passed: false, accounting: { accounting_exact: false, accounting_delta: 1 } };
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary,
    executeResult: healthyExecute(),
    report: healthyReport(),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (result.accept) throw new Error("accounting failure must not advance");
});

test(">20% positive expansion does not advance", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: {
      ...healthySummary(2485),
      quality_gate: {
        passed: false,
        failures: ["princess_eligible_inventory_expansion_requires_review"],
        source_accounting: { passed: true, accounting: { accounting_exact: true, accounting_delta: 0 } }
      }
    },
    executeResult: healthyExecute({ review_required: true }),
    report: healthyReport(),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (result.accept) throw new Error("expansion review must not advance");
});

test("negative collapse does not advance", () => {
  const summary = healthySummary(1600);
  summary.quality_gate.passed = false;
  summary.quality_gate.failures = ["eligible_inventory_collapse_gt_20pct"];
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary,
    executeResult: healthyExecute(),
    report: healthyReport(),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (result.accept) throw new Error("collapse must not advance");
});

test("partial write does not advance", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: healthySummary(2070, { inserts: 5, failed_writes: 2, zero_change_apply: false }),
    executeResult: healthyExecute({ zero_change_apply: false }),
    report: healthyReport(),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (result.accept) throw new Error("partial write must not advance");
});

test("rollback failure does not advance", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: healthySummary(2070, { inserts: 3, zero_change_apply: false }),
    executeResult: healthyExecute({ zero_change_apply: false }),
    report: healthyReport({ manifestValidation: { ok: false } }),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (result.accept) throw new Error("rollback failure must not advance");
});

test("post-write verification failure does not advance", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: healthySummary(2070, { inserts: 3, zero_change_apply: false }),
    executeResult: healthyExecute({ zero_change_apply: false }),
    report: healthyReport({ postWriteVerification: { ok: false } }),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (result.accept) throw new Error("verification failure must not advance");
});

test("post-write reconciliation failure does not advance", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_scheduled_apply",
    summary: healthySummary(2070, { inserts: 3, zero_change_apply: false }),
    executeResult: healthyExecute({ zero_change_apply: false }),
    report: healthyReport({ postWriteReconciliation: { ok: false } }),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (result.accept) throw new Error("reconciliation failure must not advance");
});

test("manual run does not auto-advance", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "weekly_manual_apply",
    summary: healthySummary(),
    executeResult: healthyExecute(),
    report: healthyReport(),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (result.accept) throw new Error("manual must not auto-advance");
});

test("P3 controlled batch does not auto-advance", () => {
  const result = lifecycle.evaluatePrincessBaselineAcceptance({
    triggerType: "incident_p3_controlled_remediation",
    summary: healthySummary(2061, { incident_p3: true }),
    executeResult: healthyExecute(),
    report: healthyReport(),
    maintenanceResult: { ok: true },
    dryRun: false
  });
  if (result.accept) throw new Error("P3 batch must not auto-advance");
});

test("latest healthy accepted run becomes next comparison baseline", () => {
  const weekA = {
    id: "week-a",
    finished_at: "2026-08-24T00:00:00.000Z",
    stats: {
      run_type: RUN_TYPE,
      accepted_inventory_baseline: true,
      accepted_eligible_total: 2070,
      accepted_at: "2026-08-24T00:00:00.000Z"
    }
  };
  const selected = lifecycle.selectLatestPrincessAcceptedBaseline([p3Run, weekA], RUN_TYPE);
  if (selected.stats.accepted_eligible_total !== 2070) throw new Error("expected latest 2070");
});

test("future normal small change compared against latest baseline", () => {
  const expansion = quality.evaluatePrincessEligibleExpansionAnomaly({
    currentEligible: 2079,
    previousEligible: 2070,
    proposedInserts: 9
  });
  if (!expansion.passed) throw new Error("9 insert against 2070 should pass expansion gate");
  if (expansion.previous_eligible_total !== 2070) throw new Error("must compare vs 2070 not 2061");
});

test("future >20% expansion still review_required", () => {
  const expansion = quality.evaluatePrincessEligibleExpansionAnomaly({
    currentEligible: 2485,
    previousEligible: 2070,
    proposedInserts: 0
  });
  if (expansion.passed) throw new Error(">20% must fail expansion gate");
  if (!expansion.failures.includes("princess_eligible_inventory_expansion_requires_review")) {
    throw new Error("expected expansion review reason");
  }
});

test(">30 proposed writes still review_required", () => {
  const expansion = quality.evaluatePrincessEligibleExpansionAnomaly({
    currentEligible: 2061,
    previousEligible: 2061,
    proposedInserts: 31
  });
  if (expansion.passed) throw new Error("31 inserts must fail cap");
});

test("post-P3 readiness uses previous_eligible_total=2061 via extractPreviousEligibleTotal", () => {
  const prev = quality.extractPreviousEligibleTotal(p3Run);
  if (prev !== 2061) throw new Error(`expected 2061 got ${prev}`);
});

test("readiness APPLY semantics flag exists on weekly maintenance script", () => {
  const readiness = require(path.join(root, "netlify/functions/lib/princess-weekly-readiness"));
  if (typeof readiness.evaluatePrincessScheduledApplyReadiness !== "function") {
    throw new Error("missing readiness helper");
  }
});

test("maintenance runner exports simulateApplyQualityGates path", () => {
  const src = require("fs").readFileSync(
    path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner.js"),
    "utf8"
  );
  if (!src.includes("simulateApplyQualityGates")) throw new Error("missing simulateApplyQualityGates");
});

test("weekly apply records baseline acceptance evaluation", () => {
  const src = require("fs").readFileSync(path.join(root, "scripts/run-princess-weekly-maintenance.mjs"), "utf8");
  if (!src.includes("evaluatePrincessBaselineAcceptance")) throw new Error("missing baseline acceptance in apply");
  if (!src.includes("patchMaintenanceRunAcceptedBaseline")) throw new Error("missing baseline patch in apply");
});

test("review_required resolveWeeklyMaintenanceExitCode remains zero", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: true, review_required: true, summary: { quality_gate: { passed: false } } },
    maintenanceResult: { summary: { quality_gate: { passed: false, failures: ["princess_eligible_inventory_expansion_requires_review"] } } },
    countsBefore: { princess: 2062 },
    countsAfter: { princess: 2062 }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) !== 0) throw new Error("review_required must exit 0");
});

console.log(`\ntest-princess-accepted-baseline-lifecycle: ${passed} passed`);
