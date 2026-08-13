#!/usr/bin/env node
/**
 * Royal Caribbean International weekly maintenance — dry-run by default (Prompt 10).
 *
 *   npm run royal-caribbean:weekly-maintenance
 *
 * Apply requires ALL of:
 *   --apply
 *   --confirm=ROYAL-CARIBBEAN-WEEKLY-MAINTENANCE
 *   ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED=true (process-scoped)
 *   local or self-hosted Mac execution
 *   --max-writes=<n> (hard-capped at 150)
 */

import fs from "fs";
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

const {
  parseWeeklyMaintenanceArgs,
  assertWeeklyApplyAllowed,
  classifyExecutionEnvironment,
  resolveEffectiveWeeklyMaxWrites,
  buildWeeklyMaintenanceReport,
  resolveWeeklyMaintenanceExitCode,
  writeWeeklyMaintenanceReportFile,
  formatWeeklyMaintenanceSummary,
  verifyPostWriteManifestOperations,
  ROYAL_CARIBBEAN_LINE_SLUG
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance-cli"));
const { createMaintenanceSupabase, exactCountSupabase, getSupabaseConfig } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { runRoyalCaribbeanWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const {
  buildRoyalCaribbeanWeeklyManifestFromDryRun,
  validateFrozenWeeklyManifest
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-manifest"));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

const REPORT_DIR = path.join(root, "reports");

async function main() {
  const startedAt = new Date().toISOString();
  const args = parseWeeklyMaintenanceArgs(process.argv);

  getSupabaseConfig(root);
  if (args.apply) assertWeeklyApplyAllowed(args, process.env);

  const sb = createMaintenanceSupabase(root);
  const line = (
    await sb(`ci_cruise_lines?slug=eq.${ROYAL_CARIBBEAN_LINE_SLUG}&select=id,name,slug&limit=1`)
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${ROYAL_CARIBBEAN_LINE_SLUG}`);

  const activeCount = async () =>
    (await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`))
      .count;

  const countsBefore = { royal_caribbean: await activeCount() };
  const environment = classifyExecutionEnvironment(process.env, { applyMode: args.apply });
  const today = args.today || perthCalendarDate();
  const runId = `royal-caribbean-weekly-${startedAt.replace(/[:.]/g, "-")}`;

  const dryRunResult = await runRoyalCaribbeanWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    skipLock: true,
    supabase: sb,
    triggerType: args.apply ? "weekly_pre_apply_dry_run" : "weekly_dry_run",
    runId,
    today,
    firstActivationCycle: args.firstActivationCycle
  });

  let weeklyManifest = args.manifestPath ? JSON.parse(fs.readFileSync(args.manifestPath, "utf8")) : null;
  if (!weeklyManifest) {
    weeklyManifest = buildRoyalCaribbeanWeeklyManifestFromDryRun({
      dryRunResult,
      today,
      firstActivationCycle: args.firstActivationCycle
    });
    const manifestPath = path.join(
      REPORT_DIR,
      `royal-caribbean-weekly-manifest-${startedAt.replace(/[:.]/g, "-")}.json`
    );
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(weeklyManifest, null, 2)}\n`);
    weeklyManifest._saved_path = manifestPath;
  }

  let applyResult = null;
  let result = dryRunResult;

  if (args.apply) {
    const maxWrites = resolveEffectiveWeeklyMaxWrites(args.maxWrites);
    const validation = validateFrozenWeeklyManifest(weeklyManifest, {
      firstActivationCycle: args.firstActivationCycle
    });
    if (!validation.passed) {
      throw new Error(`Frozen manifest validation failed: ${validation.failures.join("; ")}`);
    }
    const totalOps =
      weeklyManifest.inserts.length +
      weeklyManifest.updates.length +
      weeklyManifest.cutoff_hides.length +
      weeklyManifest.source_absence_hides.length;
    if (totalOps > maxWrites) {
      throw new Error(`Manifest operations ${totalOps} exceed --max-writes=${maxWrites}`);
    }

    const prevReconciliation = process.env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED;
    process.env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED = "true";
    try {
      result = await runRoyalCaribbeanWeeklyMaintenance({
        dryRun: false,
        performWrites: true,
        skipLock: true,
        supabase: sb,
        triggerType: "weekly_manual_apply",
        runId,
        today,
        frozenManifest: weeklyManifest,
        firstActivationCycle: args.firstActivationCycle
      });
      applyResult = result.apply_result;
    } finally {
      if (prevReconciliation == null) delete process.env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED;
      else process.env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED = prevReconciliation;
    }
  }

  const countsAfter = { royal_caribbean: await activeCount() };
  const postWriteVerification = args.apply
    ? verifyPostWriteManifestOperations({ manifest: weeklyManifest, applyResult })
    : null;

  const report = buildWeeklyMaintenanceReport({
    mode: args.apply ? "apply" : "dry_run",
    startedAt,
    endedAt: new Date().toISOString(),
    environment,
    result,
    manifest: weeklyManifest,
    applyResult,
    countsBefore,
    countsAfter,
    postWriteVerification
  });

  const { filePath } = writeWeeklyMaintenanceReportFile(report, REPORT_DIR);
  report.report_path = filePath;
  if (weeklyManifest._saved_path) report.manifest_path = weeklyManifest._saved_path;

  console.log(formatWeeklyMaintenanceSummary(report));
  console.log("");
  console.log(JSON.stringify(report, null, 2));

  process.exit(resolveWeeklyMaintenanceExitCode(report));
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        mode: process.argv.includes("--apply") ? "apply" : "dry_run",
        status: "failed",
        writes_performed: 0,
        error: err.code || err.message || String(err)
      },
      null,
      2
    )
  );
  process.exit(1);
});
