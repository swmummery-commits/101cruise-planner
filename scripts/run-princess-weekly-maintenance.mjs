#!/usr/bin/env node
/**
 * Princess weekly maintenance — Phase A (dry-run only).
 *
 *   npm run princess:weekly-maintenance
 *   node scripts/run-princess-weekly-maintenance.mjs
 *
 * Apply is intentionally blocked in Phase A regardless of environment flags.
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

async function main() {
  const startedAt = new Date().toISOString();
  const args = cli.parseWeeklyMaintenanceArgs(process.argv);
  cli.assertPhaseAApplyBlocked(args);

  getSupabaseConfig(root);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const environment = cli.classifyExecutionEnvironment(process.env);
  const countsBefore = { princess: await exactPrincessActive() };
  const sb = createMaintenanceSupabase(root);
  const previousEligibleTotal = await loadPreviousEligibleTotal(sb);

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

  const report = cli.buildWeeklyMaintenanceReport({
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
    mode: "dry_run",
    phase: "A",
    status: "failed",
    writes_performed: 0,
    error: err.code === cli.PHASE_A_APPLY_BLOCKED ? cli.PHASE_A_APPLY_BLOCKED : err.message || String(err)
  });
  console.error(JSON.stringify(payload, null, 2));
  process.exit(err.code === cli.PHASE_A_APPLY_BLOCKED ? 1 : 1);
});
