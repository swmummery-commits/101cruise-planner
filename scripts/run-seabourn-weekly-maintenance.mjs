#!/usr/bin/env node
/**
 * Seabourn weekly maintenance — dry-run by default (Prompt 3).
 *
 *   npm run seabourn:weekly-maintenance
 *   node scripts/run-seabourn-weekly-maintenance.mjs --today=2026-08-13
 *
 * Apply requires ALL of:
 *   --apply
 *   --confirm=SEABOURN-WEEKLY-MAINTENANCE
 *   SEABOURN_WEEKLY_RECONCILIATION_ENABLED=true (process-scoped)
 *   local or self-hosted Mac execution
 *   --max-writes=<n> (hard-capped at SEABOURN_MAX_WEEKLY_WRITES)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const root = path.join(path.dirname(__filename), "..");
const require = createRequire(import.meta.url);

const SEABOURN_LINE_SLUG = "seabourn-cruise-line";
const WEEKLY_APPLY_CONFIRMATION_TOKEN = "SEABOURN-WEEKLY-MAINTENANCE";
const REPORT_DIR = path.join(root, "reports");

const { SEABOURN_MAX_WEEKLY_WRITES } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));

export const MAX_WEEKLY_WRITES = SEABOURN_MAX_WEEKLY_WRITES;
export { WEEKLY_APPLY_CONFIRMATION_TOKEN, SEABOURN_LINE_SLUG };

function makeError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

export function parseWeeklyMaintenanceArgs(argv = process.argv) {
  const args = argv.slice(2);
  const apply = args.some((arg) => arg === "--apply" || arg.startsWith("--apply="));
  let confirm = null;
  let maxWrites = null;
  let today = null;
  for (const arg of args) {
    if (arg.startsWith("--confirm=")) confirm = arg.slice("--confirm=".length);
    if (arg.startsWith("--max-writes=")) maxWrites = Number(arg.slice("--max-writes=".length));
    if (arg.startsWith("--today=")) today = String(arg.slice("--today=".length)).trim();
  }
  return { apply, dryRun: !apply, confirm, maxWrites, today };
}

export function isSeabournWeeklyFlagEnabled(env = process.env) {
  return String(env.SEABOURN_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";
}

export function classifyExecutionEnvironment(env = process.env, { applyMode = false } = {}) {
  const isGitHubActions = env.GITHUB_ACTIONS === "true";
  const isCi = Boolean(env.CI);
  const isNetlify = env.NETLIFY === "true" || Boolean(env.AWS_LAMBDA_FUNCTION_NAME);
  const runnerLabels = String(env.RUNNER_LABELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isSelfHosted = runnerLabels.includes("self-hosted") || runnerLabels.includes("seabourn-local-mac");
  const isCloudHosted =
    isGitHubActions && !isSelfHosted && /^(ubuntu|windows|macos)-/i.test(String(env.RUNNER_OS || ""));

  let sourceEnvironment = "local_mac";
  if (isNetlify) sourceEnvironment = "netlify";
  else if (isGitHubActions && isSelfHosted) sourceEnvironment = "github_self_hosted_mac";
  else if (isGitHubActions && isCloudHosted) sourceEnvironment = "github_hosted_cloud";
  else if (isCi && !isGitHubActions) sourceEnvironment = "ci_other";

  return {
    platform: process.platform,
    node_version: process.version,
    ci: isCi,
    github_actions: isGitHubActions,
    runner_labels: runnerLabels,
    self_hosted_detected: isSelfHosted,
    cloud_hosted_detected: isCloudHosted,
    netlify_detected: isNetlify,
    source_environment: sourceEnvironment,
    apply_enabled: applyMode
  };
}

export function resolveEffectiveWeeklyMaxWrites(requestedMax) {
  const n = Number(requestedMax);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.floor(n), MAX_WEEKLY_WRITES);
}

export function assessWeeklyChangeVolumeCap(proposedInserts, proposedUpdates) {
  const inserts = Number(proposedInserts) || 0;
  const updates = Number(proposedUpdates) || 0;
  const combined = inserts + updates;
  return {
    ok: combined <= MAX_WEEKLY_WRITES,
    reason: combined > MAX_WEEKLY_WRITES ? "weekly_change_volume_exceeds_initial_cap" : null,
    proposed_inserts: inserts,
    proposed_updates: updates,
    combined_proposed_changes: combined,
    cap: MAX_WEEKLY_WRITES
  };
}

export function assertWeeklyApplyAllowed(args, env = process.env) {
  if (!args?.apply) return;
  if (args.confirm !== WEEKLY_APPLY_CONFIRMATION_TOKEN) {
    throw makeError("weekly_apply_confirmation_required", "weekly_apply_confirmation_required");
  }
  if (!isSeabournWeeklyFlagEnabled(env)) {
    throw makeError(
      "seabourn_weekly_reconciliation_disabled",
      "Seabourn weekly maintenance is disabled (SEABOURN_WEEKLY_RECONCILIATION_ENABLED=false)"
    );
  }
  const classified = classifyExecutionEnvironment(env, { applyMode: true });
  if (classified.netlify_detected) throw makeError("weekly_apply_netlify_forbidden");
  if (classified.cloud_hosted_detected) throw makeError("weekly_apply_cloud_hosted_forbidden");
  if (classified.source_environment === "ci_other") throw makeError("weekly_apply_ci_forbidden");
  if (
    classified.source_environment !== "local_mac" &&
    classified.source_environment !== "github_self_hosted_mac"
  ) {
    throw makeError("weekly_apply_environment_forbidden");
  }
  if (resolveEffectiveWeeklyMaxWrites(args.maxWrites) == null) {
    throw makeError("weekly_apply_max_writes_required", "weekly_apply_max_writes_required");
  }
}

export function buildWeeklyMaintenanceReport({
  mode = "dry_run",
  startedAt,
  endedAt,
  environment,
  result,
  countsBefore,
  countsAfter,
  writeCapAssessment = null
}) {
  const summary = result?.summary || {};
  const rates = summary.resolution_rates || {};
  const qg = summary.quality_gate || {};
  const sourceQg = summary.source_quality_gate || {};
  const reconciliation = {
    eligible_total: summary.eligible_total ?? null,
    active_production_total: summary.active_production_total ?? null,
    recognised_existing_eligible: summary.recognised_existing_eligible ?? summary.unchanged ?? null,
    outstanding_eligible_inserts: summary.outstanding_eligible_inserts ?? summary.proposed_inserts ?? null,
    proposed_updates: summary.proposed_updates ?? null,
    reconciliation_arithmetic_ok: summary.reconciliation_arithmetic_ok ?? null,
    all_active_recognised_in_eligible_source: summary.all_active_recognised_in_eligible_source ?? null
  };

  const writeCap =
    writeCapAssessment ||
    assessWeeklyChangeVolumeCap(summary.proposed_inserts ?? summary.outstanding_eligible_inserts, summary.proposed_updates);

  const writesPerformed =
    mode === "dry_run" ? 0 : (summary.writes_performed ?? (summary.inserts || 0) + (summary.updates || 0));

  const inventoryUnchanged =
    mode === "dry_run"
      ? (countsBefore?.seabourn ?? 0) === (countsAfter?.seabourn ?? 0)
      : writesPerformed === 0 && (countsBefore?.seabourn ?? 0) === (countsAfter?.seabourn ?? 0);

  let status = "completed";
  if (result?.blocked) status = "blocked";
  else if (!result?.ok || qg.passed === false || sourceQg.passed === false) status = "failed";
  else if (reconciliation.reconciliation_arithmetic_ok === false) status = "failed";
  else if (mode === "dry_run" && !inventoryUnchanged) status = "failed";
  else if (mode === "apply" && writeCap.ok === false) status = "failed";

  return {
    mode,
    phase: mode === "apply" ? "C" : "A",
    status,
    started_at: startedAt,
    ended_at: endedAt,
    environment,
    line_slug: SEABOURN_LINE_SLUG,
    snapshot_id: summary.snapshot_id || null,
    source: {
      num_found: summary.official_source_total ?? null,
      source_row_accounting: summary.source_row_accounting || null,
      fetch_failed: result?.reason === "official_source_unreachable" || sourceQg.passed === false
    },
    eligibility_waterfall: summary.eligibility_waterfall || null,
    reconciliation,
    proposed_change_metrics: {
      proposed_inserts: summary.proposed_inserts ?? reconciliation.outstanding_eligible_inserts,
      proposed_updates: summary.proposed_updates ?? 0,
      combined_proposed_changes: writeCap.combined_proposed_changes,
      source_absent_active: summary.source_absent_active ?? 0
    },
    source_absent: {
      count: summary.source_absent_active ?? 0,
      sailing_ids: summary.source_absent_sailing_ids || [],
      policy: "source_absent_retained_active"
    },
    quality_gates: {
      source_quality_gate: sourceQg.passed === false ? "FAIL" : sourceQg.passed === true ? "PASS" : "UNKNOWN",
      identity_gate:
        (rates.duplicate_official_identities || 0) === 0 && (rates.identity_coverage_pct ?? 100) >= 100
          ? "PASS"
          : "FAIL",
      reconciliation_gate: reconciliation.reconciliation_arithmetic_ok === false ? "FAIL" : "PASS",
      resolution_gate: qg.passed === false ? "FAIL" : qg.passed === true ? "PASS" : "UNKNOWN",
      write_authorisation: mode === "dry_run" ? "DRY_RUN" : "APPLY_REQUESTED"
    },
    quality_gate: qg,
    source_quality_gate: sourceQg,
    resolution_rates: rates,
    write_cap: writeCap,
    write_authorisation: summary.write_authorisation || (mode === "dry_run" ? "dry_run" : "apply_requested"),
    writes_performed: writesPerformed,
    inventory_unchanged: inventoryUnchanged,
    counts_before: countsBefore,
    counts_after: countsAfter,
    summary,
    result_reason: result?.reason || null
  };
}

export function resolveWeeklyMaintenanceExitCode(report) {
  if (report.status === "blocked") return 2;
  if (report.status === "failed") return 1;
  return 0;
}

export function writeWeeklyMaintenanceReportFile(report, reportDir = REPORT_DIR) {
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = (report.started_at || new Date().toISOString()).replace(/[:.]/g, "-");
  const filePath = path.join(reportDir, `seabourn-weekly-maintenance-${stamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return { filePath };
}

export function formatWeeklyMaintenanceSummary(report) {
  const qg = report.quality_gates?.resolution_gate || report.quality_gate?.passed ? "PASS" : "FAIL";
  return [
    report.mode === "dry_run" ? "Seabourn weekly maintenance — DRY RUN" : "Seabourn weekly maintenance — APPLY",
    `Snapshot: ${report.snapshot_id || "—"}`,
    `Eligible: ${report.reconciliation.eligible_total ?? "—"}`,
    `Recognised existing: ${report.reconciliation.recognised_existing_eligible ?? "—"}`,
    `Outstanding inserts: ${report.reconciliation.outstanding_eligible_inserts ?? "—"}`,
    `Proposed updates: ${report.reconciliation.proposed_updates ?? "—"}`,
    `Source absent: ${report.source_absent?.count ?? "—"}`,
    `Quality gate: ${qg}`,
    `Writes performed: ${report.writes_performed ?? 0}`,
    `Status: ${report.status}`
  ].join("\n");
}

async function main() {
  const startedAt = new Date().toISOString();
  const args = parseWeeklyMaintenanceArgs(process.argv);

  const { createMaintenanceSupabase, exactCountSupabase, getSupabaseConfig } = require(path.join(
    root,
    "scripts/lib/supabase-rest.cjs"
  ));
  const { runSeabournWeeklyMaintenance } = require(path.join(
    root,
    "netlify/functions/lib/cruise-discovery-maintenance-runner"
  ));
  const { perthCalendarDate } = require(path.join(
    root,
    "netlify/functions/lib/public-discovered-cruise-inventory"
  ));

  getSupabaseConfig(root);
  if (args.apply) assertWeeklyApplyAllowed(args, process.env);

  const sb = createMaintenanceSupabase(root);
  const line = (
    await sb(`ci_cruise_lines?slug=eq.${SEABOURN_LINE_SLUG}&select=id,name,slug&limit=1`)
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${SEABOURN_LINE_SLUG}`);

  const activeCount = async () =>
    (await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`))
      .count;

  const countsBefore = { seabourn: await activeCount() };
  const environment = classifyExecutionEnvironment(process.env, { applyMode: args.apply });
  const today = args.today || perthCalendarDate();
  const maxWrites = args.apply ? resolveEffectiveWeeklyMaxWrites(args.maxWrites) : 0;

  const result = await runSeabournWeeklyMaintenance({
    dryRun: !args.apply,
    performWrites: args.apply,
    writeMode: args.apply ? "weekly_maintenance" : "production_read_only",
    maxWrites,
    today,
    runId: `seabourn-weekly-${startedAt.replace(/[:.]/g, "-")}`,
    supabase: sb,
    triggerType: args.apply ? "weekly_manual_apply" : "weekly_dry_run"
  });

  const countsAfter = { seabourn: await activeCount() };
  const report = buildWeeklyMaintenanceReport({
    mode: args.apply ? "apply" : "dry_run",
    startedAt,
    endedAt: new Date().toISOString(),
    environment,
    result,
    countsBefore,
    countsAfter
  });

  const { filePath } = writeWeeklyMaintenanceReportFile(report);
  report.report_path = filePath;

  console.log(formatWeeklyMaintenanceSummary(report));
  console.log("");
  console.log(JSON.stringify(report, null, 2));

  const exitCode = resolveWeeklyMaintenanceExitCode(report);
  if (exitCode !== 0) process.exit(exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
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
}
