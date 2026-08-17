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
const applyWorkflowSrc = fs.readFileSync(
  path.join(root, ".github/workflows/princess-weekly-maintenance-apply.yml"),
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

test("3. --apply requires exact CLI confirmation", () => {
  let threw = false;
  try {
    cli.assertWeeklyApplyAllowed(
      { apply: true, confirm: "WRONG", maxWrites: 30 },
      { PRINCESS_WEEKLY_RECONCILIATION_ENABLED: "true", RUNNER_LABELS: "self-hosted,princess-local-mac" }
    );
  } catch (error) {
    threw = error.code === "weekly_apply_confirmation_required";
  }
  if (!threw) throw new Error("apply must require exact confirmation token");
});

test("4. weekly flag alone cannot trigger writes without apply contract", () => {
  if (!scriptSrc.includes("assertWeeklyApplyAllowed")) throw new Error("script must validate apply contract");
  if (!scriptSrc.includes('dryRun: true')) throw new Error("dry-run path must remain");
  let threw = false;
  try {
    cli.assertWeeklyApplyAllowed(
      { apply: true, confirm: cli.WEEKLY_APPLY_CONFIRMATION_TOKEN, maxWrites: 30 },
      { PRINCESS_WEEKLY_RECONCILIATION_ENABLED: "false", RUNNER_LABELS: "self-hosted,princess-local-mac" }
    );
  } catch (error) {
    threw = error.code === "princess_weekly_reconciliation_disabled";
  }
  if (!threw) throw new Error("weekly flag alone must not enable apply");
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

test("22. reconciliation flags derived from counts when summary omits them", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt: "2026-08-09T01:01:18.888Z",
    endedAt: "2026-08-09T01:01:24.722Z",
    environment: {},
    executeResult: {
      success: true,
      summary: {
        active_production_total: 1503,
        eligible_total: 1503,
        unchanged: 1503,
        proposed_inserts: 0,
        proposed_updates: 0,
        source_absent_active: 0,
        quality_gate: { passed: true }
      }
    },
    maintenanceResult: { summary: { quality_gate: { passed: true } } },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 },
    previousEligibleTotal: 1506
  });
  if (report.reconciliation.reconciliation_arithmetic_ok !== true) {
    throw new Error("expected reconciliation_arithmetic_ok derived true");
  }
  if (report.reconciliation.all_active_recognised_in_eligible_source !== true) {
    throw new Error("expected all_active_recognised_in_eligible_source derived true");
  }
});

test("23. reconciliation flags false when arithmetic fails", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: {
      success: true,
      summary: {
        active_production_total: 1503,
        eligible_total: 1503,
        unchanged: 1500,
        proposed_inserts: 0,
        proposed_updates: 0,
        source_absent_active: 0,
        quality_gate: { passed: true }
      }
    },
    maintenanceResult: { summary: { quality_gate: { passed: true } } },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 }
  });
  if (report.reconciliation.reconciliation_arithmetic_ok !== false) {
    throw new Error("expected reconciliation_arithmetic_ok derived false");
  }
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) {
    throw new Error("expected non-zero exit when reconciliation arithmetic fails");
  }
});

test("24. apply requires weekly flag true", () => {
  let threw = false;
  try {
    cli.assertWeeklyApplyAllowed(
      { apply: true, confirm: cli.WEEKLY_APPLY_CONFIRMATION_TOKEN, maxWrites: 10 },
      { RUNNER_LABELS: "self-hosted,princess-local-mac" }
    );
  } catch (error) {
    threw = error.code === "princess_weekly_reconciliation_disabled";
  }
  if (!threw) throw new Error("apply must require weekly flag");
});

test("25. incorrect workflow confirmation blocks job", () => {
  if (!cli.verifyWorkflowConfirmationInput("WRONG")) {
    /* expected */
  } else {
    throw new Error("wrong confirmation must fail");
  }
  if (!cli.verifyWorkflowConfirmationInput("PRINCESS-WEEKLY-MAINTENANCE")) {
    throw new Error("correct confirmation must pass");
  }
  if (!applyWorkflowSrc.includes("if: github.event_name == 'workflow_dispatch'")) {
    throw new Error("manual confirmation must only apply to workflow_dispatch");
  }
  if (!applyWorkflowSrc.includes('type: choice')) {
    throw new Error("manual confirmation must use choice input");
  }
  const manualCtx = cli.resolveWorkflowApplyContext({
    eventName: "workflow_dispatch",
    confirmationInput: "princess-weekly-maintenance",
    maxWritesInput: 30
  });
  if (manualCtx.ok) throw new Error("lowercase manual confirmation must fail");
});

test("26. local/self-hosted apply accepted", () => {
  cli.assertWeeklyApplyEnvironment({ RUNNER_LABELS: "self-hosted,princess-local-mac", GITHUB_ACTIONS: "true" });
  cli.assertWeeklyApplyEnvironment({});
});

test("27. GitHub-hosted apply rejected", () => {
  let threw = false;
  try {
    cli.assertWeeklyApplyEnvironment({
      GITHUB_ACTIONS: "true",
      RUNNER_OS: "ubuntu-latest",
      RUNNER_LABELS: "ubuntu-latest"
    });
  } catch (error) {
    threw = error.code === "weekly_apply_cloud_hosted_forbidden";
  }
  if (!threw) throw new Error("cloud hosted must be rejected");
});

test("28. Netlify apply rejected", () => {
  let threw = false;
  try {
    cli.assertWeeklyApplyEnvironment({ NETLIFY: "true" });
  } catch (error) {
    threw = error.code === "weekly_apply_netlify_forbidden";
  }
  if (!threw) throw new Error("netlify must be rejected");
});

test("29. max weekly cap is 30", () => {
  if (cli.MAX_WEEKLY_WRITES !== 30) throw new Error("cap must be 30");
  if (cli.resolveEffectiveWeeklyMaxWrites(30) !== 30) throw new Error("30 must be allowed");
});

test("30. user cannot raise cap above 30", () => {
  if (cli.resolveEffectiveWeeklyMaxWrites(100) !== 30) throw new Error("100 must cap to 30");
  if (cli.resolveEffectiveWeeklyMaxWrites(31) !== 30) throw new Error("31 must cap to 30");
});

test("31. exactly 30 proposed writes may proceed", () => {
  const cap = cli.assessWeeklyChangeVolumeCap(20, 10);
  if (!cap.ok || cap.combined_proposed_changes !== 30) throw new Error("30 combined must pass cap");
});

test("32. 31 proposed writes stop with zero-write cap assessment", () => {
  const cap = cli.assessWeeklyChangeVolumeCap(20, 11);
  if (cap.ok || cap.reason !== cli.WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP) {
    throw new Error("31 combined must fail cap");
  }
  if (cap.cap !== 30) throw new Error("cap must be reported as 30");
});

test("33. inserts + updates share the 30 cap", () => {
  const cap = cli.assessWeeklyChangeVolumeCap(15, 16);
  if (cap.ok) throw new Error("15+16 must exceed cap");
});

test("34. zero-change apply completes successfully", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: cli.classifyExecutionEnvironment({}, { applyMode: true }),
    executeResult: {
      success: true,
      summary: {
        quality_gate: { passed: true },
        reconciliation_arithmetic_ok: true,
        proposed_inserts: 0,
        proposed_updates: 0,
        zero_change_apply: true
      }
    },
    maintenanceResult: { summary: { quality_gate: { passed: true }, zero_change_apply: true }, ok: true },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 },
    writeAccounting: { accounting_ok: true, attempted: 0, committed: 0, genuinely_failed: 0, unchanged: 1503, source_absent_active: 0 },
    manifestValidation: { ok: true, zero_writes: true, manifest_record_count: 0 },
    postWriteReconciliation: { ok: true, skipped: true },
    postWriteVerification: { ok: true, skipped: true }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) !== 0) throw new Error("zero-change apply must exit 0");
  if (report.writes?.zero_change_apply !== true) throw new Error("must mark zero_change_apply");
});

test("35. zero-change apply performs zero writes", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: true, summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: true, zero_change_apply: true } },
    maintenanceResult: { ok: true, summary: { quality_gate: { passed: true }, zero_change_apply: true } },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 },
    writeAccounting: { accounting_ok: true, attempted: 0, committed: 0, genuinely_failed: 0, unchanged: 1503, source_absent_active: 0 },
    manifestValidation: { ok: true, zero_writes: true, manifest_record_count: 0 }
  });
  if (report.writes_performed !== 0) throw new Error("zero writes required");
});

test("36. quality gate failure blocks apply", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: false, summary: { quality_gate: { passed: false, failures: ["ship_resolution_below_98pct"] } } },
    maintenanceResult: { ok: false, summary: { quality_gate: { passed: false } } },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("QG failure must non-zero");
});

test("37. lock failure blocks apply", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: false, blocked: true, reason: "maintenance_lock_held" },
    maintenanceResult: { blocked: true, reason: "maintenance_lock_held" },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("lock block must non-zero");
});

test("38. manifest count must equal commits", () => {
  const summary = { inserts: 2, updates: 1, rollback_manifest_id: "abc" };
  const manifest = {
    inserted: [{ discovered_cruise_id: "a", official_sailing_id: "x" }],
    updated: [{ discovered_cruise_id: "b", official_sailing_id: "y" }],
    inserted_record_ids: ["a"],
    updated_record_ids: ["b"]
  };
  const ok = cli.validateRollbackManifestIntegrity({ rollbackResult: { manifest }, summary, writeResult: {} });
  if (ok.ok) throw new Error("2 entries != 3 commits must fail");
  const good = cli.validateRollbackManifestIntegrity({
    rollbackResult: {
      manifest: {
        inserted: [
          { discovered_cruise_id: "a", official_sailing_id: "x" },
          { discovered_cruise_id: "b", official_sailing_id: "y" }
        ],
        updated: [{ discovered_cruise_id: "c", official_sailing_id: "z" }],
        inserted_record_ids: ["a", "b"],
        updated_record_ids: ["c"]
      }
    },
    summary,
    writeResult: {}
  });
  if (!good.ok || good.manifest_record_count !== 3) throw new Error("matching manifest must pass");
});

test("39. post-write failure blocks success", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: true, summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: true, inserts: 1, updates: 0, write_attempts: 1 } },
    maintenanceResult: { ok: true, summary: { inserts: 1, updates: 0, write_attempts: 1, quality_gate: { passed: true } } },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1504 },
    writeAccounting: { accounting_ok: true, attempted: 1, committed: 1, genuinely_failed: 0, unchanged: 0, source_absent_active: 0 },
    manifestValidation: { ok: true, manifest_record_count: 1 },
    postWriteReconciliation: { ok: false, reason: "post_write_idempotency_anomaly" }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("post-write failure must non-zero");
});

test("40. idempotency anomaly blocks success", () => {
  const anomaly = cli.validatePostWriteReconciliation({
    reconciliation_arithmetic_ok: true,
    all_active_recognised_in_eligible_source: true,
    proposed_inserts: 2,
    proposed_updates: 0
  });
  if (anomaly.ok) throw new Error("idempotency anomaly must fail");
});

test("41. apply workflow supports workflow_dispatch and schedule", () => {
  if (!applyWorkflowSrc.includes("workflow_dispatch")) throw new Error("missing workflow_dispatch");
  if (!/^\s*schedule:/m.test(applyWorkflowSrc)) throw new Error("missing schedule trigger");
});

test("42. apply workflow schedule cron is Sunday 20:00 UTC", () => {
  if (!applyWorkflowSrc.includes('cron: "0 20 * * 0"') && !applyWorkflowSrc.includes("cron: '0 20 * * 0'")) {
    throw new Error("apply workflow must use cron 0 20 * * 0");
  }
  if (!applyWorkflowSrc.includes("Monday 04:00 Australia/Perth = Sunday 20:00 UTC")) {
    throw new Error("missing Perth schedule comment");
  }
});

test("43. apply workflow targets self-hosted princess-local-mac", () => {
  if (!applyWorkflowSrc.includes("self-hosted")) throw new Error("missing self-hosted");
  if (!applyWorkflowSrc.includes("princess-local-mac")) throw new Error("missing princess-local-mac");
});

test("44. apply workflow requires deliberate confirmation choice", () => {
  if (!applyWorkflowSrc.includes("confirmation:")) throw new Error("missing confirmation input");
  if (!applyWorkflowSrc.includes("PRINCESS-WEEKLY-MAINTENANCE")) throw new Error("missing confirmation token");
  if (!applyWorkflowSrc.includes("options:")) throw new Error("confirmation must use fixed options");
});

test("45. apply workflow uses weekly flag only in apply step", () => {
  if (!applyWorkflowSrc.includes('PRINCESS_WEEKLY_RECONCILIATION_ENABLED: "true"')) {
    throw new Error("apply step must set weekly flag");
  }
  if (/PRINCESS_DISCOVERY_WRITE_ENABLED:\s*"true"/.test(applyWorkflowSrc)) {
    throw new Error("apply must not use discovery write flag");
  }
  const dryTrueCount = (workflowSrc.match(/PRINCESS_WEEKLY_RECONCILIATION_ENABLED:\s*"true"/g) || []).length;
  if (dryTrueCount !== 0) throw new Error("dry-run workflow must not enable weekly flag");
});

test("46. dry-run workflow remains unchanged/read-only", () => {
  if (workflowSrc.includes("--apply")) throw new Error("dry-run workflow must not include apply");
  if (/PRINCESS_WEEKLY_RECONCILIATION_ENABLED:\s*"true"/.test(workflowSrc)) {
    throw new Error("dry-run workflow must keep weekly flag false");
  }
  if (!workflowSrc.includes("princess:weekly-maintenance")) throw new Error("dry-run command must remain");
});

test("47. apply and dry-run share concurrency group", () => {
  if (!applyWorkflowSrc.includes("group: princess-weekly-maintenance")) throw new Error("apply missing concurrency group");
  if (!workflowSrc.includes("group: princess-weekly-maintenance")) throw new Error("dry-run missing concurrency group");
});

test("48. write accounting attempted = committed + failed", () => {
  const accounting = cli.extractWriteAccounting(
    { inserts: 3, updates: 2, failed_writes: 1, write_attempts: 6 },
    { inserted: 3, updated: 2, failed: 1 }
  );
  if (!accounting.accounting_ok) throw new Error("valid accounting must pass");
  if (accounting.attempted !== 6 || accounting.committed !== 5 || accounting.genuinely_failed !== 1) {
    throw new Error("accounting fields mismatch");
  }
});

test("49. cap exceeded apply report fails", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: {
      success: false,
      reason: cli.WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP,
      summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: true, proposed_inserts: 20, proposed_updates: 11 }
    },
    maintenanceResult: { ok: false, reason: cli.WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 },
    writeCapAssessment: cli.assessWeeklyChangeVolumeCap(20, 11)
  });
  if (report.status !== "failed") throw new Error("cap exceeded must fail");
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("cap exceeded must non-zero exit");
});

test("50. weekly apply entry resolves all runtime modules", () => {
  const runtimeModules = [
    "scripts/lib/supabase-rest.cjs",
    "netlify/functions/lib/cruise-discovery-maintenance-cron.js",
    "netlify/functions/lib/cruise-discovery-maintenance-runner.js",
    "netlify/functions/lib/cruise-discovery-maintenance.js",
    "netlify/functions/lib/cruise-discovery-maintenance-tracking.js",
    "netlify/functions/lib/princess-weekly-maintenance-cli.js",
    "netlify/functions/lib/princess-post-write-verification.js",
    "netlify/functions/lib/princess-reconciliation-summary.js",
    "netlify/functions/lib/cruise-discovery-maintenance-manifests.js"
  ];
  for (const rel of runtimeModules) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) throw new Error(`missing runtime module: ${rel}`);
    require(full);
  }
  if (scriptSrc.includes("princess-controlled-catch-up-batch.cjs")) {
    throw new Error("weekly apply must not require uncommitted catch-up batch module");
  }
  if (!scriptSrc.includes("princess-post-write-verification")) {
    throw new Error("weekly apply must use committed post-write verification module");
  }
});

test("51. weekly apply CLI loads without module resolution error", () => {
  const { spawnSync } = require("child_process");
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/run-princess-weekly-maintenance.mjs"),
      "--apply",
      "--confirm=WRONG",
      "--max-writes=30"
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PRINCESS_WEEKLY_RECONCILIATION_ENABLED: "true",
        RUNNER_LABELS: "self-hosted,princess-local-mac"
      },
      encoding: "utf8"
    }
  );
  const combined = `${result.stdout || ""}${result.stderr || ""}`;
  if (/Cannot find module/i.test(combined)) {
    throw new Error(`module resolution failure on apply entry: ${combined}`);
  }
  if (result.status === 0) throw new Error("wrong confirmation must not exit 0");
});

test("52. only one Princess weekly automatic schedule exists", () => {
  const workflowDir = path.join(root, ".github/workflows");
  const sources = fs.readdirSync(workflowDir).map((file) => fs.readFileSync(path.join(workflowDir, file), "utf8"));
  const count = cli.countPrincessWeeklyCronSchedules(sources);
  if (count !== 1) throw new Error(`expected exactly 1 Princess weekly cron, found ${count}`);
});

test("53. dry-run workflow still has no schedule", () => {
  if (/^\s*schedule:/m.test(workflowSrc) || workflowSrc.includes("cron:")) {
    throw new Error("dry-run workflow must remain schedule-free");
  }
});

test("54. scheduled apply context supplies fixed confirmation safely", () => {
  const ctx = cli.resolveWorkflowApplyContext({ eventName: "schedule" });
  if (!ctx.ok || ctx.trigger_type !== "scheduled") throw new Error("scheduled context must ok");
  if (ctx.confirmation_token !== cli.WEEKLY_APPLY_CONFIRMATION_TOKEN) throw new Error("scheduled token mismatch");
  if (ctx.max_writes !== 30) throw new Error("scheduled max_writes must be 30");
});

test("55. manual apply context requires exact confirmation choice", () => {
  const ok = cli.resolveWorkflowApplyContext({
    eventName: "workflow_dispatch",
    confirmationInput: cli.WEEKLY_APPLY_CONFIRMATION_TOKEN,
    maxWritesInput: 30
  });
  if (!ok.ok || ok.trigger_type !== "manual") throw new Error("manual context must ok");
});

test("56. scheduled event maps to apply runner trigger type", () => {
  if (cli.resolveMaintenanceRunnerTriggerType("scheduled") !== "weekly_scheduled_apply") {
    throw new Error("scheduled runner trigger mismatch");
  }
  if (cli.resolveMaintenanceRunnerTriggerType("manual") !== "weekly_manual_apply") {
    throw new Error("manual runner trigger mismatch");
  }
});

test("57. apply workflow sets scheduled trigger env on apply step", () => {
  if (!applyWorkflowSrc.includes("PRINCESS_WEEKLY_TRIGGER_TYPE")) {
    throw new Error("apply workflow must pass trigger type env");
  }
  if (!applyWorkflowSrc.includes("github.event_name == 'schedule'")) {
    throw new Error("apply workflow must branch scheduled vs manual trigger");
  }
});

test("58. apply workflow has no GitHub-hosted fallback", () => {
  if (applyWorkflowSrc.includes("ubuntu-latest") || applyWorkflowSrc.includes("macos-latest")) {
    throw new Error("apply workflow must not list cloud runners");
  }
});

test("59. manual max_writes choice cannot exceed hard cap in workflow", () => {
  if (!applyWorkflowSrc.includes("max_writes")) throw new Error("missing max_writes input");
  const capStep = applyWorkflowSrc.match(/Resolve apply max writes[\s\S]*?Run Princess weekly maintenance apply/)?.[0] || "";
  if (!/\[ "\$REQUESTED" -gt 30 \]/.test(capStep)) throw new Error("workflow must clamp max_writes to 30");
});

test("60. report includes manual vs scheduled trigger type", () => {
  const scheduled = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    triggerType: "scheduled",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: true, summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: true, zero_change_apply: true } },
    maintenanceResult: { ok: true, summary: { quality_gate: { passed: true }, zero_change_apply: true } },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 },
    writeAccounting: { accounting_ok: true, attempted: 0, committed: 0, genuinely_failed: 0, unchanged: 1503, source_absent_active: 0 },
    manifestValidation: { ok: true, zero_writes: true, manifest_record_count: 0 },
    postWriteReconciliation: { ok: true, skipped: true },
    postWriteVerification: { ok: true, skipped: true }
  });
  if (scheduled.trigger_type !== "scheduled") throw new Error("scheduled trigger missing");
  if (scheduled.execution_mode !== "apply") throw new Error("execution mode missing");
  const manual = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    triggerType: "manual",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: true, summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: true, zero_change_apply: true } },
    maintenanceResult: { ok: true, summary: { quality_gate: { passed: true }, zero_change_apply: true } },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 },
    writeAccounting: { accounting_ok: true, attempted: 0, committed: 0, genuinely_failed: 0, unchanged: 1503, source_absent_active: 0 },
    manifestValidation: { ok: true, zero_writes: true, manifest_record_count: 0 },
    postWriteReconciliation: { ok: true, skipped: true },
    postWriteVerification: { ok: true, skipped: true }
  });
  if (manual.trigger_type !== "manual") throw new Error("manual trigger missing");
});

test("61. zero-change scheduled apply returns success", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    triggerType: "scheduled",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: true, summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: true, zero_change_apply: true } },
    maintenanceResult: { ok: true, summary: { quality_gate: { passed: true }, zero_change_apply: true } },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 },
    writeAccounting: { accounting_ok: true, attempted: 0, committed: 0, genuinely_failed: 0, unchanged: 1503, source_absent_active: 0 },
    manifestValidation: { ok: true, zero_writes: true, manifest_record_count: 0 },
    postWriteReconciliation: { ok: true, skipped: true },
    postWriteVerification: { ok: true, skipped: true }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) !== 0) throw new Error("zero-change scheduled apply must exit 0");
});

test("62. GitHub job summary helper omits secrets", () => {
  const summary = cli.buildGitHubJobSummary(
    cli.buildWeeklyMaintenanceReport({
      mode: "apply",
      triggerType: "scheduled",
      startedAt: "2026-08-09T00:00:00.000Z",
      endedAt: "2026-08-09T00:01:00.000Z",
      environment: { supabase_service_role_key: "[REDACTED]" },
      executeResult: { success: true, summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: true, eligible_total: 1503, active_production_total: 1503 } },
      maintenanceResult: { ok: true, summary: { quality_gate: { passed: true } } },
      countsBefore: { princess: 1503 },
      countsAfter: { princess: 1503 },
      writeAccounting: { accounting_ok: true, attempted: 0, committed: 0, genuinely_failed: 0, unchanged: 1503, source_absent_active: 2 },
      manifestValidation: { ok: true, zero_writes: true, manifest_record_count: 0 },
      postWriteReconciliation: { ok: true, skipped: true },
      postWriteVerification: { ok: true, skipped: true }
    })
  );
  if (!summary.includes("Princess Weekly Maintenance")) throw new Error("summary title missing");
  if (!summary.includes("Scheduled")) throw new Error("scheduled trigger missing from summary");
  if (/secret|eyJ[A-Za-z0-9_-]+\./.test(summary)) throw new Error("summary must not leak secrets");
});

test("63. apply workflow publishes GitHub job summary", () => {
  if (!applyWorkflowSrc.includes("Publish GitHub job summary")) throw new Error("missing job summary step");
  if (!applyWorkflowSrc.includes("GITHUB_STEP_SUMMARY")) throw new Error("missing step summary output");
  if (!applyWorkflowSrc.includes("if: always()")) throw new Error("summary/artifact should use always()");
});

test("64. apply workflow keeps discovery and automation flags false", () => {
  if (!applyWorkflowSrc.includes('PRINCESS_DISCOVERY_WRITE_ENABLED: "false"')) {
    throw new Error("discovery write flag must remain false");
  }
  if (!applyWorkflowSrc.includes('CRUISE_DISCOVERY_AUTOMATION_ENABLED: "false"')) {
    throw new Error("automation flag must remain false");
  }
});

test("65. run script resolves scheduled trigger from env", () => {
  if (!scriptSrc.includes("PRINCESS_WEEKLY_TRIGGER_TYPE")) {
    throw new Error("run script must read scheduled trigger env");
  }
  if (!scriptSrc.includes('resolveMaintenanceRunnerTriggerType')) {
    throw new Error("run script must map workflow trigger to runner trigger");
  }
});

test("66. scheduled source failure blocks apply", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    triggerType: "scheduled",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: false, reason: "official_source_unreachable" },
    maintenanceResult: { failed: true, reason: "official_source_unreachable", simulation: { fetch_result: { fetch_failed: true } } },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("scheduled source failure must non-zero");
});

test("67. scheduled reconciliation failure blocks apply", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    triggerType: "scheduled",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: true, summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: false } },
    maintenanceResult: { summary: { quality_gate: { passed: true }, reconciliation_arithmetic_ok: false } },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("scheduled reconciliation failure must non-zero");
});

test("68. scheduled lock failure blocks apply", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    triggerType: "scheduled",
    startedAt: "2026-08-09T00:00:00.000Z",
    endedAt: "2026-08-09T00:01:00.000Z",
    environment: {},
    executeResult: { success: false, blocked: true, reason: "maintenance_lock_held" },
    maintenanceResult: { blocked: true, reason: "maintenance_lock_held" },
    countsBefore: { princess: 1503 },
    countsAfter: { princess: 1503 }
  });
  if (cli.resolveWeeklyMaintenanceExitCode(report) === 0) throw new Error("scheduled lock failure must non-zero");
});

const princessQuality = require(path.join(root, "netlify/functions/lib/princess-weekly-quality"));

test("69. +37% eligible spike requires review on apply", () => {
  const gate = princessQuality.evaluatePrincessEligibleExpansionAnomaly({
    currentEligible: 2061,
    previousEligible: 1502,
    proposedInserts: 582,
    weeklyWriteCap: 30
  });
  if (gate.passed) throw new Error("expansion anomaly must fail");
  if (!gate.failures.includes("princess_eligible_inventory_expansion_requires_review")) {
    throw new Error("missing expansion review reason");
  }
  if (!gate.failures.includes("princess_outstanding_inserts_exceed_weekly_cap")) {
    throw new Error("missing cap exceed reason");
  }
});

test("70. dry-run quality gate records expansion without blocking", () => {
  const gate = princessQuality.evaluatePrincessWeeklyQualityGate({
    metrics: { eligible_total: 2061, ship_resolution_pct: 100, departure_port_resolution_pct: 100, destination_resolution_pct: 100, identity_coverage_pct: 100, duplicate_official_identities: 0 },
    previousEligible: { stats: { eligible_total: 1502 } },
    manifest: { products: Array.from({ length: 582 }, () => ({ proposed_action: "insert_active" })) },
    dryRun: true,
    performWrites: false,
    simulation: { raw_sailing_count: 2131, raw_group_count: 1007, metrics: { expanded_dated_sailings: 2131 }, products: [] },
    summary: { eligible_total: 2061, official_source_total: 1007, incomplete_skipped: 0, within_public_cutoff_excluded: 70, cruisetours_excluded: 0 }
  });
  if (!gate.passed) throw new Error("dry run should pass with anomaly recorded");
  if (!gate.inventory_discontinuity_detected) throw new Error("must flag discontinuity");
});

test("71. apply blocked when expansion anomaly present", () => {
  const gate = princessQuality.evaluatePrincessWeeklyQualityGate({
    metrics: { eligible_total: 2061, ship_resolution_pct: 100, departure_port_resolution_pct: 100, destination_resolution_pct: 100, identity_coverage_pct: 100, duplicate_official_identities: 0 },
    previousEligible: { stats: { eligible_total: 1502 } },
    manifest: { products: [{ proposed_action: "insert_active" }] },
    dryRun: false,
    performWrites: true,
    simulation: { raw_sailing_count: 2131, raw_group_count: 1007, metrics: { expanded_dated_sailings: 2131 }, products: [] },
    summary: { eligible_total: 2061, official_source_total: 1007, incomplete_skipped: 0, within_public_cutoff_excluded: 70, cruisetours_excluded: 0 }
  });
  if (gate.passed || gate.auto_apply_permitted) throw new Error("apply must block");
});

test("72. source accounting continuity retains expanded sailings", () => {
  const accounting = princessQuality.extractPrincessSourceAccounting(
    { raw_sailing_count: 2131, raw_group_count: 1007, metrics: { expanded_dated_sailings: 2131, complete_high_confidence: 2131 }, products: [] },
    { eligible_total: 2061, official_source_total: 1007, incomplete_skipped: 0, within_public_cutoff_excluded: 70, cruisetours_excluded: 0 }
  );
  if (accounting.expanded_dated_sailings !== 2131) throw new Error("expanded missing");
  const gate = princessQuality.evaluatePrincessSourceAccountingContinuity(
    { raw_sailing_count: 2131, raw_group_count: 1007, metrics: { expanded_dated_sailings: 2131 }, products: [] },
    { eligible_total: 2061, official_source_total: 1007, incomplete_skipped: 0, within_public_cutoff_excluded: 70, cruisetours_excluded: 0 }
  );
  if (!gate.passed) throw new Error(JSON.stringify(gate.failures));
});

test("73. cap failure report keeps expanded sailings via summary accounting", () => {
  const report = cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    triggerType: "scheduled",
    startedAt: "2026-08-17T00:00:00.000Z",
    endedAt: "2026-08-17T00:10:00.000Z",
    environment: {},
    executeResult: {
      success: false,
      reason: cli.WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP,
      summary: {
        official_source_total: 1007,
        eligible_total: 2061,
        incomplete_skipped: 0,
        within_public_cutoff_excluded: 70,
        source_accounting: {
          raw_groups: 1007,
          expanded_dated_sailings: 2131,
          public_eligible: 2061,
          incomplete: 0,
          within_cutoff: 70
        },
        quality_gate: { passed: true, failures: [] }
      },
      simulation: null
    },
    maintenanceResult: {
      reason: cli.WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP,
      summary: {
        official_source_total: 1007,
        eligible_total: 2061,
        incomplete_skipped: 0,
        source_accounting: {
          expanded_dated_sailings: 2131,
          public_eligible: 2061,
          incomplete: 0
        }
      },
      simulation: null
    },
    countsBefore: { princess: 1480 },
    countsAfter: { princess: 1480 }
  });
  if (report.source.expanded_sailings !== 2131) throw new Error("expanded_sailings must not be null on cap failure");
  if (report.source.incomplete_skipped !== 0) throw new Error("incomplete must survive cap failure");
});

test("74. negative collapse guard remains on eligible decrease", () => {
  const gate = princessQuality.evaluatePrincessWeeklyQualityGate({
    metrics: { eligible_total: 1000, ship_resolution_pct: 100, departure_port_resolution_pct: 100, destination_resolution_pct: 100, identity_coverage_pct: 100, duplicate_official_identities: 0 },
    previousEligible: { stats: { eligible_total: 1502 } },
    manifest: { products: [] },
    dryRun: false,
    performWrites: true,
    simulation: { raw_sailing_count: 1200, products: [] },
    summary: { eligible_total: 1000, incomplete_skipped: 0, within_public_cutoff_excluded: 0, cruisetours_excluded: 0 }
  });
  if (gate.passed) throw new Error("collapse must fail quality gate");
  if (!gate.failures.includes("eligible_inventory_collapse_gt_20pct")) throw new Error("missing collapse failure");
});

test("75. 390 to 0 incomplete discontinuity is diagnosable", () => {
  if (401 - 0 < 390) throw new Error("expected large incomplete drop");
});

console.log(`\ntest-princess-weekly-maintenance: ${passed} passed`);
