#!/usr/bin/env node
/**
 * Princess weekly maintenance — Phase A dry-run (default) + Phase C apply (manual or scheduled).
 *
 *   npm run princess:weekly-maintenance
 *   node scripts/run-princess-weekly-maintenance.mjs
 *
 * Manual apply requires ALL of:
 *   --apply
 *   --confirm=PRINCESS-WEEKLY-MAINTENANCE
 *   PRINCESS_WEEKLY_RECONCILIATION_ENABLED=true (process-scoped)
 *   local or self-hosted Mac execution
 *   --max-writes=<n> (hard-capped at 30)
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const { createMaintenanceSupabase, exactCountSupabase, getSupabaseConfig } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { executeWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-cron"
));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const {
  PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
  assertPrincessWeeklyMaintenanceEnabled
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const { loadWeeklyMaintenanceStatus } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-tracking"
));
const cli = require(path.join(root, "netlify/functions/lib/princess-weekly-maintenance-cli"));
const postWriteVerification = require(path.join(
  root,
  "netlify/functions/lib/princess-post-write-verification"
));

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const REPORT_DIR = path.join(root, "reports");

async function exactPrincessActive() {
  const { count } = await exactCountSupabase(
    root,
    "discovered_cruises",
    `cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active`
  );
  return count;
}

async function loadPreviousEligibleTotal(sb) {
  try {
    const status = await loadWeeklyMaintenanceStatus(
      sb,
      PRINCESS_LINE_ID,
      "princess-cruises",
      PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
      "princess_weekly"
    );
    return status?.official_eligible_inventory ?? null;
  } catch {
    return null;
  }
}

async function runPostWriteVerification(sb, insertedIds) {
  if (!insertedIds?.length) {
    return { ok: true, skipped: true, reason: "no_inserts_to_verify" };
  }
  const rows = await postWriteVerification.fetchPrincessActiveRows(sb, insertedIds);
  const verification = postWriteVerification.verifyInsertedRows(rows);
  return {
    ok: verification.ok,
    issues: verification.issues,
    verified_count: rows.length,
    min_departure: verification.minDeparture
  };
}

async function runPostWriteReconciliationDryRun(sb, runIdPrefix) {
  const result = await runPrincessWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    maxWrites: 0,
    runId: `${runIdPrefix}-post-write-reconciliation`,
    supabase: sb,
    triggerType: "weekly_post_write_reconciliation",
    writeMode: "production_read_only"
  });
  return {
    ok: result.ok === true,
    summary: result.summary || null,
    reason: result.reason || null
  };
}

async function runDryRun({ startedAt, environment, countsBefore, sb, previousEligibleTotal }) {
  const executeResult = await executeWeeklyMaintenance({
    lineSlug: "princess-cruises",
    cruiseLineId: PRINCESS_LINE_ID,
    runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: assertPrincessWeeklyMaintenanceEnabled,
    runMaintenance: runPrincessWeeklyMaintenance,
    dryRun: true,
    maxWrites: 0,
    triggerType: "weekly_dry_run",
    supabaseClient: sb
  });

  const countsAfter = { princess: await exactPrincessActive() };
  const endedAt = new Date().toISOString();

  return cli.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt,
    endedAt,
    environment,
    executeResult,
    maintenanceResult: { summary: executeResult.summary },
    countsBefore,
    countsAfter,
    previousEligibleTotal
  });
}

async function runApply({ startedAt, environment, countsBefore, sb, previousEligibleTotal, maxWrites, triggerType }) {
  const runnerTriggerType = cli.resolveMaintenanceRunnerTriggerType(triggerType);
  const executeResult = await executeWeeklyMaintenance({
    lineSlug: "princess-cruises",
    cruiseLineId: PRINCESS_LINE_ID,
    runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: assertPrincessWeeklyMaintenanceEnabled,
    runMaintenance: (ctx) =>
      runPrincessWeeklyMaintenance({
        ...ctx,
        writeMode: "weekly_maintenance",
        triggerType: runnerTriggerType
      }),
    dryRun: false,
    maxWrites,
    triggerType: runnerTriggerType,
    supabaseClient: sb
  });

  const summary = executeResult.summary || {};
  const maintenanceResult = {
    summary,
    write_result: executeResult.write_result || null,
    rollback_manifest: executeResult.rollback_manifest || null,
    ok: executeResult.success !== false,
    simulation: executeResult.simulation || null
  };

  const writeCapAssessment = cli.assessWeeklyChangeVolumeCap(
    summary.proposed_inserts ?? summary.outstanding_eligible_inserts,
    summary.proposed_updates
  );
  if (executeResult.reason === cli.WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP) {
    writeCapAssessment.ok = false;
    writeCapAssessment.reason = cli.WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP;
  }

  const writeAccounting = cli.extractWriteAccounting(summary, maintenanceResult.write_result?.stats || maintenanceResult.write_result);
  const manifestValidation = cli.validateRollbackManifestIntegrity({
    rollbackResult:
      executeResult.rollback_result ||
      (maintenanceResult.rollback_manifest
        ? { manifest: maintenanceResult.rollback_manifest }
        : { skipped: summary.zero_change_apply === true, reason: "no_writes" }),
    summary,
    writeResult: maintenanceResult.write_result,
    runMeta: {
      runId: executeResult.run_id,
      runRecordId: executeResult.run_record_id,
      cruiseLineId: PRINCESS_LINE_ID,
      triggerType: runnerTriggerType
    }
  });

  let postWriteReconciliation = null;
  let postWriteVerification = null;

  if (writeAccounting.committed > 0 && executeResult.success !== false) {
    const insertedIds = (maintenanceResult.write_result?.write_details || [])
      .filter((d) => d.created || d.result_action === "inserted" || d.recovered_after_fetch_failure)
      .map((d) => d.discovered_cruise_id)
      .filter(Boolean);

    postWriteVerification = await runPostWriteVerification(sb, insertedIds);

    const reconciliationRun = await runPostWriteReconciliationDryRun(sb, executeResult.run_id || "weekly-apply");
    postWriteReconciliation = cli.validatePostWriteReconciliation(reconciliationRun.summary);
    postWriteReconciliation.raw_summary = reconciliationRun.summary;
    if (!reconciliationRun.ok) {
      postWriteReconciliation.ok = false;
      postWriteReconciliation.reason = reconciliationRun.reason || postWriteReconciliation.reason;
    }
    if (!postWriteVerification.ok) {
      postWriteReconciliation = postWriteReconciliation || {};
      postWriteReconciliation.ok = false;
      postWriteReconciliation.reason = postWriteReconciliation.reason || "post_write_record_verification_failed";
    }
  } else if (writeAccounting.committed === 0) {
    postWriteReconciliation = { ok: true, skipped: true, reason: "zero_change_apply" };
    postWriteVerification = { ok: true, skipped: true, reason: "zero_change_apply" };
  }

  const countsAfter = { princess: await exactPrincessActive() };
  const endedAt = new Date().toISOString();

  return cli.buildWeeklyMaintenanceReport({
    mode: "apply",
    triggerType,
    startedAt,
    endedAt,
    environment,
    executeResult,
    maintenanceResult,
    countsBefore,
    countsAfter,
    previousEligibleTotal,
    writeCapAssessment,
    writeAccounting,
    manifestValidation,
    postWriteReconciliation,
    postWriteVerification
  });
}

async function main() {
  const startedAt = new Date().toISOString();
  const args = cli.parseWeeklyMaintenanceArgs(process.argv);

  getSupabaseConfig(root);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const applyMode = args.apply;
  const triggerType =
    process.env.PRINCESS_WEEKLY_TRIGGER_TYPE === "scheduled"
      ? "scheduled"
      : applyMode
        ? "manual"
        : null;
  if (applyMode) {
    cli.assertWeeklyApplyAllowed(args, process.env);
  }

  const environment = cli.classifyExecutionEnvironment(process.env, { applyMode });
  const countsBefore = { princess: await exactPrincessActive() };
  const sb = createMaintenanceSupabase(root);
  const previousEligibleTotal = await loadPreviousEligibleTotal(sb);

  const report = applyMode
    ? await runApply({
        startedAt,
        environment,
        countsBefore,
        sb,
        previousEligibleTotal,
        maxWrites: cli.resolveEffectiveWeeklyMaxWrites(args.maxWrites),
        triggerType
      })
    : await runDryRun({
        startedAt,
        environment,
        countsBefore,
        sb,
        previousEligibleTotal
      });

  const { filePath } = cli.writeWeeklyMaintenanceReportFile(report, REPORT_DIR);
  report.report_path = filePath;

  console.log(cli.formatWeeklyMaintenanceSummary(report));
  console.log("");
  console.log(JSON.stringify(cli.redactSecrets(report), null, 2));

  const exitCode = cli.resolveWeeklyMaintenanceExitCode(report);
  if (exitCode !== 0) process.exit(exitCode);
}

main().catch((err) => {
  const payload = cli.redactSecrets({
    mode: process.argv.includes("--apply") ? "apply" : "dry_run",
    phase: process.argv.includes("--apply") ? "C" : "A",
    status: "failed",
    writes_performed: 0,
    error: err.code || err.message || String(err)
  });
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
});
