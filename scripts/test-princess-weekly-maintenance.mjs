#!/usr/bin/env node
/**
 * Princess weekly maintenance wrapper + workflow contract tests (Phase A).
 *   node scripts/test-princess-weekly-maintenance.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const cli = require(path.join(root, "netlify/functions/lib/princess-weekly-maintenance-cli"));

const scriptSrc = fs.readFileSync(path.join(root, "scripts/run-princess-weekly-maintenance.mjs"), "utf8");
const workflowSrc = fs.readFileSync(
  path.join(root, ".github/workflows/princess-weekly-maintenance.yml"),
  "utf8"
);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

test("1. default script mode is dry-run", () => {
  const args = cli.parseWeeklyMaintenanceArgs(["node", "script"]);
  if (args.apply || !args.dryRun) throw new Error("expected dry-run default");
  if (!scriptSrc.includes("dryRun: true")) throw new Error("script must force dryRun true");
  if (!scriptSrc.includes('mode: "dry_run"')) throw new Error("missing dry_run mode");
});

test("2. writes_performed = 0 in report builder", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: cli.classifyExecutionEnvironment({}),
    executeResult: { success: true, summary: { quality_gate: { passed: true } } },
    maintenanceResult: { summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: true } },
    countsBefore: { princess: 1506 },
    countsAfter: { princess: 1506 }
  });
  if (report.writes_performed !== 0) throw new Error("writes_performed must be 0");
});

test("3. apply is blocked in Phase A", () => {
  let threw = false;
  try {
    cli.assertPhaseAApplyBlocked({ apply: true });
  } catch (error) {
    threw = error.code === cli.PHASE_A_APPLY_BLOCKED;
  }
  if (!threw) throw new Error("apply must be blocked");
  if (!scriptSrc.includes("assertPhaseAApplyBlocked")) throw new Error("script must block apply");
});

test("4. weekly write flag cannot enable apply path in Phase A script", () => {
  if (scriptSrc.includes("performWrites: true")) throw new Error("script must not perform writes");
  if (scriptSrc.includes("PRINCESS_WEEKLY_RECONCILIATION_ENABLED=true")) {
    throw new Error("script must not enable weekly flag");
  }
  if (!scriptSrc.includes("dryRun: true")) throw new Error("must remain dry run");
});

test("5. quality-gate success => exit 0", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: true, summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: true } },
    maintenanceResult: { summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: true } },
    countsBefore: { princess: 1506 },
    countsAfter: { princess: 1506 }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) !== 0) throw new Error("expected exit 0");
});

test("6. source failure => non-zero", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: false, reason: "official_source_unreachable" },
    maintenanceResult: { failed: true, reason: "official_source_unreachable", simulation: { fetch_result: { fetch_failed: true } } },
    countsBefore: { princess: 1506 },
    countsAfter: { princess: 1506 }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("expected non-zero on source failure");
});

test("7. quality-gate failure => non-zero", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: false, summary: { quality_gate: { passed: false, failures: ["ship_resolution_below_98pct"] } } },
    maintenanceResult: { summary: { quality_gate: { passed: false, failures: ["ship_resolution_below_98pct"] } } },
    countsBefore: { princess: 1506 },
    countsAfter: { princess: 1506 }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("expected non-zero on QG failure");
});

test("8. reconciliation failure => non-zero", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: true, summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: false } },
    maintenanceResult: { summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: false } },
    countsBefore: { princess: 1506 },
    countsAfter: { princess: 1506 }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("expected non-zero on reconciliation failure");
});

test("9. source-absent records reported with retain policy", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: {
      success: true,
      summary: {
        quality_gate: { passed: true },
        reconciliation_arithmetic_ok: true,
        source_absent_active: 2,
        source_absent_sailing_ids: ["A|B|2027-01-01"]
      }
    },
    maintenanceResult: {
      summary: {
        quality_gate: { passed: true },
        reconciliation_arithmetic_ok: true,
        source_absent_active: 2,
        source_absent_sailing_ids: ["A|B|2027-01-01"]
      }
    },
    countsBefore: { princess: 1506 },
    countsAfter: { princess: 1506 }
  });
  if (report.source_absent.count !== 2) throw new Error("expected source absent count");
  if (report.source_absent.policy !== "source_absent_retained_active") throw new Error("policy mismatch");
});

test("10. reconciliation fields emitted", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: {
      success: true,
      summary: {
        active_production_total: 1506,
        eligible_total: 1506,
        recognised_existing_eligible: 1501,
        outstanding_eligible_inserts: 5,
        proposed_updates: 0,
        reconciliation_arithmetic_ok: true,
        quality_gate: { passed: true }
      }
    },
    maintenanceResult: { summary: { quality_gate: { passed: true } } },
    countsBefore: { princess: 1506 },
    countsAfter: { princess: 1506 },
    previousEligibleTotal: 1500
  });
  if (report.reconciliation.eligible_total !== 1506) throw new Error("missing eligible");
  if (report.proposed_change_metrics.combined_proposed_changes !== 5) throw new Error("combined changes");
  if (report.reconciliation.previous_eligible_total !== 1500) throw new Error("previous eligible");
});

test("11. snapshot emitted", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: true, summary: { snapshot_id: "abc123", quality_gate: { passed: true }, reconciliation_arithmetic_ok: true } },
    maintenanceResult: { summary: { snapshot_id: "abc123", quality_gate: { passed: true } } },
    countsBefore: { princess: 1506 },
    countsAfter: { princess: 1506 }
  });
  if (report.snapshot_id !== "abc123") throw new Error("snapshot missing");
});

test("12. no credentials emitted into report", () => {
  const redacted = cli.redactSecrets({
    SUPABASE_SERVICE_ROLE_KEY: "secret-value",
    nested: { cookie: "abc", ok: true }
  });
  if (redacted.SUPABASE_SERVICE_ROLE_KEY !== "[REDACTED]") throw new Error("service role not redacted");
  if (redacted.nested.cookie !== "[REDACTED]") throw new Error("cookie not redacted");
});

test("13. workflow has workflow_dispatch", () => {
  if (!workflowSrc.includes("workflow_dispatch")) throw new Error("missing workflow_dispatch");
});

test("14. workflow has NO schedule", () => {
  if (/^\s*schedule:/m.test(workflowSrc) || workflowSrc.includes("cron:")) {
    throw new Error("workflow must not include schedule/cron in Phase A");
  }
});

test("15. workflow requires self-hosted + princess-local-mac", () => {
  if (!workflowSrc.includes("self-hosted")) throw new Error("missing self-hosted");
  if (!workflowSrc.includes("princess-local-mac")) throw new Error("missing princess-local-mac label");
});

test("16. workflow does NOT target GitHub-hosted runner", () => {
  if (workflowSrc.includes("ubuntu-latest")) throw new Error("must not use ubuntu-latest");
  if (workflowSrc.includes("macos-latest")) throw new Error("must not use macos-latest");
});

test("17. workflow contains no weekly write flag true", () => {
  if (/PRINCESS_WEEKLY_RECONCILIATION_ENABLED:\s*"true"/.test(workflowSrc)) {
    throw new Error("weekly write flag must not be true");
  }
});

test("18. workflow contains no discovery write flag true", () => {
  if (/PRINCESS_DISCOVERY_WRITE_ENABLED:\s*"true"/.test(workflowSrc)) {
    throw new Error("discovery write flag must not be true");
  }
});

test("19. workflow has concurrency group", () => {
  if (!workflowSrc.includes("concurrency:")) throw new Error("missing concurrency");
  if (!workflowSrc.includes("group: princess-weekly-maintenance")) throw new Error("missing concurrency group");
});

test("20. npm script points to weekly maintenance entry", () => {
  if (packageJson.scripts["princess:weekly-maintenance"] !== "node scripts/run-princess-weekly-maintenance.mjs") {
    throw new Error("missing princess:weekly-maintenance npm script");
  }
});

test("21. successful dry-run with proposed inserts still exit 0", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: {
      success: true,
      summary: {
        quality_gate: { passed: true },
        reconciliation_arithmetic_ok: true,
        outstanding_eligible_inserts: 5,
        proposed_inserts: 5
      }
    },
    maintenanceResult: { summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: true } },
    countsBefore: { princess: 1506 },
    countsAfter: { princess: 1506 }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) !== 0) throw new Error("proposed inserts should not fail dry-run");
});

console.log(`\ntest-princess-weekly-maintenance: ${passed} passed`);
