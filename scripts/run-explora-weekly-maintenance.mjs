#!/usr/bin/env node
/**
 * Explora Journeys weekly maintenance — dry-run by default.
 *
 *   npm run explora:weekly-maintenance
 *   node scripts/run-explora-weekly-maintenance.mjs
 *
 * Apply requires ALL of:
 *   --apply
 *   --confirm=EXPLORA-WEEKLY-MAINTENANCE
 *   EXPLORA_WEEKLY_RECONCILIATION_ENABLED=true (process-scoped, never committed)
 *   local or self-hosted Mac execution (never Netlify, never cloud CI)
 *   --max-writes=<n> (hard-capped at EXPLORA_MAX_WEEKLY_WRITES)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const root = path.join(path.dirname(__filename), "..");
const require = createRequire(import.meta.url);

const EXPLORA_LINE_SLUG = "explora-journeys";
const EXPLORA_LINE_ID = "8b28c83e-2bf0-44ce-9795-ec3051c34050";
const WEEKLY_APPLY_CONFIRMATION_TOKEN = "EXPLORA-WEEKLY-MAINTENANCE";
const REPORT_DIR = path.join(root, "reports");

const { EXPLORA_MAX_WEEKLY_WRITES } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));

export const MAX_WEEKLY_WRITES = EXPLORA_MAX_WEEKLY_WRITES;
export { WEEKLY_APPLY_CONFIRMATION_TOKEN, EXPLORA_LINE_ID, EXPLORA_LINE_SLUG };

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
  for (const arg of args) {
    if (arg.startsWith("--confirm=")) confirm = arg.slice("--confirm=".length);
    if (arg.startsWith("--max-writes=")) maxWrites = Number(arg.slice("--max-writes=".length));
  }
  return { apply, dryRun: !apply, confirm, maxWrites };
}

export function isExploraWeeklyFlagEnabled(env = process.env) {
  return String(env.EXPLORA_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";
}

export function classifyExecutionEnvironment(env = process.env, { applyMode = false } = {}) {
  const isGitHubActions = env.GITHUB_ACTIONS === "true";
  const isCi = Boolean(env.CI);
  const isNetlify = env.NETLIFY === "true" || Boolean(env.AWS_LAMBDA_FUNCTION_NAME);
  const runnerLabels = String(env.RUNNER_LABELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isSelfHosted = runnerLabels.includes("self-hosted") || runnerLabels.includes("explora-local-mac");
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
  if (!isExploraWeeklyFlagEnabled(env)) {
    throw makeError(
      "explora_weekly_reconciliation_disabled",
      "Explora weekly maintenance is disabled (EXPLORA_WEEKLY_RECONCILIATION_ENABLED=false)"
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
  writeCapAssessment = null,
  postWriteVerification = null
}) {
  const summary = result?.summary || {};
  const rates = summary.resolution_rates || {};
  const capAssessment =
    writeCapAssessment || assessWeeklyChangeVolumeCap(summary.proposed_inserts, summary.proposed_updates);
  const writesPerformed = mode === "apply" ? (summary.inserts || 0) + (summary.updates || 0) : 0;

  const report = {
    mode,
    execution_mode: mode,
    started_at: startedAt,
    ended_at: endedAt,
    environment,
    line_slug: EXPLORA_LINE_SLUG,
    run_id: summary.run_id || null,
    source: {
      fetch_failed: result?.reason === "official_source_unreachable",
      official_source_total: summary.official_source_total ?? null,
      within_public_cutoff_excluded: summary.within_public_cutoff_excluded ?? null,
      incomplete_skipped: summary.incomplete_skipped ?? null,
      non_cruise_excluded: summary.non_cruise_excluded ?? null,
      error: result?.reason || null
    },
    quality_gate: {
      passed: summary.quality_gate?.passed === true,
      failures: summary.quality_gate?.failures || [],
      blocked: summary.quality_gate?.blocked === true
    },
    resolution: {
      ship_resolution_pct: rates.ship_resolution_pct ?? null,
      departure_port_resolution_pct: rates.departure_port_resolution_pct ?? null,
      destination_resolution_pct: rates.destination_resolution_pct ?? null,
      identity_coverage_pct: rates.identity_coverage_pct ?? null
    },
    reconciliation: {
      active_production_total: summary.active_production_total ?? null,
      eligible_total: summary.eligible_total ?? null,
      recognised_existing_eligible: summary.recognised_existing_eligible ?? summary.unchanged ?? null,
      outstanding_eligible_inserts: summary.outstanding_eligible_inserts ?? summary.proposed_inserts ?? null,
      proposed_updates: summary.proposed_updates ?? null,
      source_absent_active: summary.source_absent_active ?? null,
      reconciliation_arithmetic_ok: summary.reconciliation_arithmetic_ok ?? null,
      all_active_recognised_in_eligible_source: summary.all_active_recognised_in_eligible_source ?? null
    },
    write_cap: capAssessment,
    source_absent: {
      count: summary.source_absent_active ?? 0,
      sailing_ids: summary.source_absent_sailing_ids || [],
      policy: "source_absent_retained_active"
    },
    snapshot_id: summary.snapshot_id ?? null,
    counts_before: countsBefore,
    counts_after: countsAfter,
    inventory_unchanged:
      countsBefore?.explora != null && countsAfter?.explora != null && countsBefore.explora === countsAfter.explora,
    writes_performed: writesPerformed,
    blocked: result?.blocked === true,
    post_write_verification: postWriteVerification
  };

  report.status = resolveWeeklyMaintenanceStatus(report, result, mode);
  return report;
}

export function resolveWeeklyMaintenanceStatus(report, result, mode = "dry_run") {
  if (report.source.fetch_failed) return "failed";
  if (result?.failed === true) return "failed";
  if (report.quality_gate.passed === false) return "failed";
  if (report.reconciliation.reconciliation_arithmetic_ok === false) return "failed";
  if (mode === "apply" && report.write_cap?.ok === false) return "failed";
  if (mode === "apply" && report.post_write_verification?.ok === false) return "failed";
  if (mode === "dry_run" && report.inventory_unchanged === false) return "failed";
  if (result?.ok === false && !result?.blocked) return "failed";
  if (result?.blocked === true) return "blocked";
  return "completed";
}

export function resolveWeeklyMaintenanceExitCode(report) {
  if (!report) return 1;
  if (report.status === "completed") return 0;
  if (report.status === "blocked") return 2;
  return 1;
}

export function writeWeeklyMaintenanceReportFile(report, reportsDir = REPORT_DIR) {
  const stamp = (report.started_at || new Date().toISOString()).replace(/[:.]/g, "-");
  const filename = `explora-weekly-${report.mode === "apply" ? "apply" : "maintenance"}-${stamp}.json`;
  const filePath = path.join(reportsDir, filename);
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`);
  return { filePath, filename };
}

export function formatWeeklyMaintenanceSummary(report) {
  const r = report.reconciliation || {};
  const qg = report.quality_gate?.passed === true ? "passed" : "failed";
  return [
    report.mode === "apply" ? "Explora Weekly Maintenance" : "Explora Weekly Maintenance — DRY RUN",
    `Active: ${r.active_production_total ?? "—"}`,
    `Eligible: ${r.eligible_total ?? "—"}`,
    `Recognised: ${r.recognised_existing_eligible ?? "—"}`,
    `Proposed inserts: ${r.outstanding_eligible_inserts ?? "—"}`,
    `Proposed updates: ${r.proposed_updates ?? "—"}`,
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
  const { runExploraWeeklyMaintenance } = require(path.join(
    root,
    "netlify/functions/lib/cruise-discovery-maintenance-runner"
  ));
  const postWriteVerification = require(path.join(
    root,
    "netlify/functions/lib/explora-post-write-verification"
  ));

  getSupabaseConfig(root);
  if (args.apply) assertWeeklyApplyAllowed(args, process.env);

  const environment = classifyExecutionEnvironment(process.env, { applyMode: args.apply });
  const activeCount = async () =>
    (await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${EXPLORA_LINE_ID}&status=eq.active`))
      .count;

  const countsBefore = { explora: await activeCount() };
  const sb = createMaintenanceSupabase(root);

  const maxWrites = args.apply ? resolveEffectiveWeeklyMaxWrites(args.maxWrites) : 0;
  const result = await runExploraWeeklyMaintenance({
    dryRun: !args.apply,
    performWrites: args.apply,
    writeMode: args.apply ? "weekly_maintenance" : "production_read_only",
    maxWrites,
    runId: `explora-weekly-${startedAt.replace(/[:.]/g, "-")}`,
    supabase: sb,
    triggerType: args.apply ? "weekly_manual_apply" : "weekly_dry_run"
  });

  let verification = null;
  if (args.apply) {
    const insertedIds = (result.write_result?.stats?.write_details || [])
      .filter((d) => d.created || d.result_action === "inserted")
      .map((d) => d.discovered_cruise_id)
      .filter(Boolean);
    verification = insertedIds.length
      ? postWriteVerification.verifyInsertedRows(
          await postWriteVerification.fetchExploraActiveRows(sb, insertedIds)
        )
      : { ok: true, skipped: true, reason: "no_inserts_to_verify" };
  }

  const countsAfter = { explora: await activeCount() };
  const report = buildWeeklyMaintenanceReport({
    mode: args.apply ? "apply" : "dry_run",
    startedAt,
    endedAt: new Date().toISOString(),
    environment,
    result,
    countsBefore,
    countsAfter,
    postWriteVerification: verification
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
