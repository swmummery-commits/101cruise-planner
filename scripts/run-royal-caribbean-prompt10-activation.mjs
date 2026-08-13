#!/usr/bin/env node
/**
 * Royal Caribbean Prompt 10 — production activation orchestrator.
 *
 *   npm run royal-caribbean:prompt10-activation
 *   node scripts/run-royal-caribbean-prompt10-activation.mjs --dry-run-only
 *
 * Set ACTIVATION_ENABLE_SCHEDULE=true after successful apply to enable cron schedule in netlify.toml.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  validateFrozenWeeklyManifest,
  assertWeeklyCeilings
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-manifest"));
const { verifyPreApplyConcurrency } = require(path.join(
  root,
  "netlify/functions/lib/royal-caribbean-weekly-apply"
));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

const REPORT_DIR = path.join(root, "reports");
const NETLIFY_TOML = path.join(root, "netlify.toml");
// Sunday 23:00 UTC — Monday 07:00 Perth. Seabourn occupies 22:00 UTC.
const CRON_SCHEDULE = "0 23 * * 0";

const RC_TESTS = [
  "test:royal-caribbean-discovery",
  "test:royal-caribbean-source-enumeration",
  "test:royal-caribbean-weekly-maintenance",
  "test:royal-caribbean-prompt10-activation",
  "test:royal-caribbean-weekly-auth"
];

function parseActivationArgs(argv) {
  const base = parseWeeklyMaintenanceArgs(argv);
  return {
    ...base,
    dryRunOnly: argv.includes("--dry-run-only"),
    skipDeploy: argv.includes("--skip-deploy"),
    skipTests: argv.includes("--skip-tests"),
    enableSchedule: process.env.ACTIVATION_ENABLE_SCHEDULE === "true"
  };
}

function gitCheckpoint() {
  try {
    return {
      branch: execSync("git branch --show-current", { cwd: root, encoding: "utf8" }).trim(),
      head: execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim(),
      clean: execSync("git status --porcelain", { cwd: root, encoding: "utf8" }).trim() === ""
    };
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

function runRcTests(skipTests) {
  if (skipTests) return { skipped: true, results: [] };
  const results = [];
  for (const script of RC_TESTS) {
    const started = Date.now();
    try {
      execSync(`npm run ${script}`, { cwd: root, stdio: "pipe", encoding: "utf8" });
      results.push({ script, ok: true, elapsed_ms: Date.now() - started });
    } catch (error) {
      results.push({
        script,
        ok: false,
        elapsed_ms: Date.now() - started,
        error: error.stderr || error.stdout || error.message
      });
      return { ok: false, results };
    }
  }
  return { ok: true, results };
}

function enableWeeklyCronSchedule() {
  const src = fs.readFileSync(NETLIFY_TOML, "utf8");
  const cronBlock =
    src.match(/\[functions\."royal-caribbean-weekly-maintenance-cron"\][\s\S]*?(?=\n\[|$)/)?.[0] || "";
  if (new RegExp(`^\\s*schedule\\s*=\\s*"${CRON_SCHEDULE.replace(/\*/g, "\\*")}"`, "m").test(cronBlock)) {
    return { already_enabled: true, schedule: CRON_SCHEDULE };
  }
  const updated = src.replace(
    /(\[functions\."royal-caribbean-weekly-maintenance-cron"\][\s\S]*?)(#\s*)?schedule\s*=\s*"0 \d+ \* \* 0"/,
    `$1schedule = "${CRON_SCHEDULE}"`
  );
  if (updated === src) {
    return { ok: false, reason: "schedule_line_not_found" };
  }
  fs.writeFileSync(NETLIFY_TOML, updated);
  return { ok: true, schedule: CRON_SCHEDULE };
}

async function main() {
  const startedAt = new Date().toISOString();
  const args = parseActivationArgs(process.argv);
  const stamp = startedAt.replace(/[:.]/g, "-");
  const report = {
    phase: "royal_caribbean_prompt10_activation",
    started_at: startedAt,
    mode: args.apply ? "apply" : args.dryRunOnly ? "dry_run_only" : "dry_run",
    first_activation_cycle: args.firstActivationCycle,
    git_checkpoint: gitCheckpoint(),
    environment: classifyExecutionEnvironment(process.env, { applyMode: args.apply }),
    tests: null,
    dry_run: null,
    manifest: null,
    apply: null,
    post_write: null,
    schedule_enable: null,
    status: "in_progress"
  };

  getSupabaseConfig(root);

  report.tests = runRcTests(args.skipTests);
  if (!report.tests.skipped && report.tests.ok !== true) {
    report.status = "failed";
    report.reason = "tests_failed";
    writeReport(report, stamp);
    process.exit(1);
  }

  const sb = createMaintenanceSupabase(root);
  const line = (
    await sb(`ci_cruise_lines?slug=eq.${ROYAL_CARIBBEAN_LINE_SLUG}&select=id,name,slug&limit=1`)
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${ROYAL_CARIBBEAN_LINE_SLUG}`);

  const today = args.today || perthCalendarDate();
  const runId = `royal-caribbean-prompt10-${stamp}`;

  const dryRunResult = await runRoyalCaribbeanWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    skipLock: true,
    supabase: sb,
    triggerType: "prompt10_production_dry_run",
    runId,
    today,
    firstActivationCycle: args.firstActivationCycle
  });

  report.dry_run = {
    ok: dryRunResult.ok === true,
    reason: dryRunResult.reason || null,
    summary: {
      source_snapshot_id: dryRunResult.summary?.source_snapshot_id || null,
      proposed_inserts: dryRunResult.summary?.proposed_inserts ?? null,
      proposed_updates: dryRunResult.summary?.proposed_updates ?? null,
      reconciliation_arithmetic_ok: dryRunResult.summary?.reconciliation_arithmetic_ok ?? null,
      weekly_maintenance_healthy: dryRunResult.summary?.weekly_maintenance_healthy ?? null
    }
  };

  if (!dryRunResult.ok) {
    report.status = "failed";
    report.reason = "dry_run_failed";
    writeReport(report, stamp);
    process.exit(1);
  }

  const weeklyManifest = buildRoyalCaribbeanWeeklyManifestFromDryRun({
    dryRunResult,
    today,
    firstActivationCycle: args.firstActivationCycle
  });
  const manifestPath = path.join(REPORT_DIR, `royal-caribbean-prompt10-manifest-${stamp}.json`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(weeklyManifest, null, 2)}\n`);

  const manifestValidation = validateFrozenWeeklyManifest(weeklyManifest, {
    firstActivationCycle: args.firstActivationCycle
  });
  const ceilings = assertWeeklyCeilings(weeklyManifest, { firstActivationCycle: args.firstActivationCycle });

  report.manifest = {
    path: manifestPath,
    hash: weeklyManifest.manifest_hash,
    validation: manifestValidation,
    ceilings,
    counts: {
      inserts: weeklyManifest.inserts.length,
      updates: weeklyManifest.updates.length,
      cutoff_hides: weeklyManifest.cutoff_hides.length,
      source_absence_observations: weeklyManifest.source_absence_observations.length,
      source_absence_hides: weeklyManifest.source_absence_hides.length,
      review_required: weeklyManifest.review_required.length
    }
  };

  if (!manifestValidation.passed || !ceilings.ok) {
    report.status = "failed";
    report.reason = "manifest_validation_failed";
    writeReport(report, stamp);
    process.exit(1);
  }

  if (args.dryRunOnly || !args.apply) {
    report.status = "completed";
    report.ended_at = new Date().toISOString();
    writeReport(report, stamp);
    console.log(JSON.stringify({ ok: true, status: report.status, manifest_path: manifestPath }, null, 2));
    return;
  }

  assertWeeklyApplyAllowed(args, process.env);
  const maxWrites = resolveEffectiveWeeklyMaxWrites(args.maxWrites);
  const totalOps =
    weeklyManifest.inserts.length +
    weeklyManifest.updates.length +
    weeklyManifest.cutoff_hides.length +
    weeklyManifest.source_absence_hides.length;
  if (totalOps > maxWrites) {
    throw new Error(`Manifest operations ${totalOps} exceed --max-writes=${maxWrites}`);
  }

  const concurrency = await verifyPreApplyConcurrency({ manifest: weeklyManifest, supabase: sb, cruiseLine: line });
  report.pre_apply_concurrency = concurrency;
  if (!concurrency.passed) {
    report.status = "failed";
    report.reason = "pre_apply_concurrency_failed";
    writeReport(report, stamp);
    process.exit(1);
  }

  const countsBefore = {
    royal_caribbean: (
      await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`)
    ).count
  };

  const prevFlag = process.env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED;
  process.env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED = "true";
  let applyResult;
  try {
    const applyRun = await runRoyalCaribbeanWeeklyMaintenance({
      dryRun: false,
      performWrites: true,
      skipLock: true,
      supabase: sb,
      triggerType: "prompt10_first_activation_apply",
      runId,
      today,
      frozenManifest: weeklyManifest,
      firstActivationCycle: args.firstActivationCycle
    });
    applyResult = applyRun.apply_result;
    report.apply = {
      ok: applyRun.ok === true,
      stats: applyResult?.stats || null,
      reason: applyRun.reason || null
    };
  } finally {
    if (prevFlag == null) delete process.env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED;
    else process.env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED = prevFlag;
  }

  if (!applyResult?.ok) {
    report.status = "failed";
    report.reason = "apply_failed";
    writeReport(report, stamp);
    process.exit(1);
  }

  const postWriteVerification = verifyPostWriteManifestOperations({
    manifest: weeklyManifest,
    applyResult
  });

  const idempotencyDryRun = await runRoyalCaribbeanWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    skipLock: true,
    supabase: sb,
    triggerType: "prompt10_post_apply_idempotency",
    runId: `${runId}-post`,
    today,
    firstActivationCycle: args.firstActivationCycle
  });

  const countsAfter = {
    royal_caribbean: (
      await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`)
    ).count
  };

  report.post_write = {
    verification: postWriteVerification,
    counts_before: countsBefore,
    counts_after: countsAfter
  };

  const idempotencyHealthy =
    idempotencyDryRun.summary?.weekly_maintenance_healthy === true &&
    idempotencyDryRun.summary?.reconciliation_arithmetic_ok === true &&
    (idempotencyDryRun.summary?.proposed_inserts ?? 0) === 0 &&
    (idempotencyDryRun.summary?.proposed_updates ?? 0) === 0 &&
    (idempotencyDryRun.summary?.actual_writes ?? 0) === 0;

  report.post_write.idempotency = {
    ok: idempotencyHealthy,
    proposed_inserts: idempotencyDryRun.summary?.proposed_inserts ?? null,
    proposed_updates: idempotencyDryRun.summary?.proposed_updates ?? null,
    weekly_maintenance_healthy: idempotencyDryRun.summary?.weekly_maintenance_healthy ?? null,
    reconciliation_arithmetic_ok: idempotencyDryRun.summary?.reconciliation_arithmetic_ok ?? null,
    actual_writes: idempotencyDryRun.summary?.actual_writes ?? 0,
    reason: idempotencyDryRun.reason || null
  };

  const postOk = postWriteVerification.ok === true && idempotencyHealthy;

  if (!postOk) {
    report.status = "failed";
    report.reason = "post_write_verification_failed";
    writeReport(report, stamp);
    process.exit(1);
  }

  if (args.enableSchedule) {
    report.schedule_enable = enableWeeklyCronSchedule();
  } else {
    report.schedule_enable = {
      skipped: true,
      note: "Set ACTIVATION_ENABLE_SCHEDULE=true to uncomment schedule in netlify.toml after successful apply"
    };
  }

  report.status = "completed";
  report.ended_at = new Date().toISOString();
  writeReport(report, stamp);
  console.log(
    JSON.stringify(
      {
        ok: true,
        status: report.status,
        manifest_path: manifestPath,
        writes_performed: applyResult.stats.actual_writes,
        schedule_enable: report.schedule_enable
      },
      null,
      2
    )
  );
}

function writeReport(report, stamp) {
  report.ended_at = report.ended_at || new Date().toISOString();
  const filePath = path.join(REPORT_DIR, `royal-caribbean-prompt10-${stamp}.json`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`);
  report.report_path = filePath;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
  process.exit(1);
});
