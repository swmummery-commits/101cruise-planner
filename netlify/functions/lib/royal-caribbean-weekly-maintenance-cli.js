/**
 * Royal Caribbean weekly maintenance CLI helpers (dry-run + apply).
 */

const fs = require("fs");
const path = require("path");
const { ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING } = require("./royal-caribbean-weekly-health");
const { WEEKLY_APPLY_CONFIRMATION_TOKEN } = require("./royal-caribbean-weekly-manifest");

const ROYAL_CARIBBEAN_LINE_SLUG = "royal-caribbean-international";
const MAX_WEEKLY_WRITES = ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING.max_total_proposed_changes;

function makeError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function parseWeeklyMaintenanceArgs(argv = process.argv) {
  const args = argv.slice(2);
  const apply = args.some((arg) => arg === "--apply" || arg.startsWith("--apply="));
  let confirm = null;
  let maxWrites = null;
  let today = null;
  let manifestPath = null;
  let firstActivationCycle = false;
  for (const arg of args) {
    if (arg.startsWith("--confirm=")) confirm = arg.slice("--confirm=".length);
    if (arg.startsWith("--max-writes=")) maxWrites = Number(arg.slice("--max-writes=".length));
    if (arg.startsWith("--today=")) today = String(arg.slice("--today=".length)).trim();
    if (arg.startsWith("--manifest-path=")) manifestPath = String(arg.slice("--manifest-path=".length)).trim();
    if (arg === "--first-activation-cycle") firstActivationCycle = true;
  }
  return {
    apply,
    dryRun: !apply,
    confirm,
    maxWrites,
    today,
    manifestPath,
    firstActivationCycle
  };
}

function isRoyalCaribbeanWeeklyFlagEnabled(env = process.env) {
  return String(env.ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";
}

function classifyExecutionEnvironment(env = process.env, { applyMode = false } = {}) {
  const isGitHubActions = env.GITHUB_ACTIONS === "true";
  const isCi = Boolean(env.CI);
  const isNetlify = env.NETLIFY === "true" || Boolean(env.AWS_LAMBDA_FUNCTION_NAME);
  const runnerLabels = String(env.RUNNER_LABELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isSelfHosted =
    runnerLabels.includes("self-hosted") || runnerLabels.includes("royal-caribbean-local-mac");
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

function resolveEffectiveWeeklyMaxWrites(requestedMax) {
  const n = Number(requestedMax);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.floor(n), MAX_WEEKLY_WRITES);
}

function assessWeeklyChangeVolumeCap(proposedInserts, proposedUpdates, proposedHides = 0) {
  const inserts = Number(proposedInserts) || 0;
  const updates = Number(proposedUpdates) || 0;
  const hides = Number(proposedHides) || 0;
  const combined = inserts + updates + hides;
  const ceiling = ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING;
  return {
    ok:
      inserts <= ceiling.max_proposed_inserts &&
      updates <= ceiling.max_proposed_updates &&
      hides <= ceiling.max_source_absent_actions &&
      combined <= ceiling.max_total_proposed_changes,
    reason:
      combined > ceiling.max_total_proposed_changes ? "weekly_change_volume_exceeds_initial_cap" : null,
    proposed_inserts: inserts,
    proposed_updates: updates,
    proposed_hides: hides,
    combined_proposed_changes: combined,
    cap: ceiling.max_total_proposed_changes,
    ceiling
  };
}

function assertWeeklyApplyAllowed(args, env = process.env) {
  if (!args?.apply) return;
  if (args.confirm !== WEEKLY_APPLY_CONFIRMATION_TOKEN) {
    throw makeError("weekly_apply_confirmation_required", "weekly_apply_confirmation_required");
  }
  if (!isRoyalCaribbeanWeeklyFlagEnabled(env)) {
    throw makeError(
      "royal_caribbean_weekly_reconciliation_disabled",
      "Royal Caribbean weekly maintenance is disabled (ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED=false)"
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

function verifyPostWriteManifestOperations({ manifest, applyResult }) {
  if (!manifest || !applyResult?.stats) {
    return { ok: false, reason: "missing_manifest_or_apply_result" };
  }
  const stats = applyResult.stats;
  const expected =
    (manifest.inserts || []).length +
    (manifest.updates || []).length +
    (manifest.cutoff_hides || []).length +
    (manifest.source_absence_hides || []).length;
  const actual = stats.inserted + stats.updated + stats.expired;
  return {
    ok: stats.failed === 0 && !stats.stopped_early && stats.actual_writes === actual && actual <= expected,
    expected_operations: expected,
    actual_writes: actual,
    inserted: stats.inserted,
    updated: stats.updated,
    expired: stats.expired,
    failed: stats.failed,
    stopped_early: stats.stopped_early === true
  };
}

function buildWeeklyMaintenanceReport({
  mode = "dry_run",
  startedAt,
  endedAt,
  environment,
  result,
  manifest = null,
  applyResult = null,
  countsBefore,
  countsAfter,
  writeCapAssessment = null,
  postWriteVerification = null
}) {
  const summary = result?.summary || {};
  const writeCap =
    writeCapAssessment ||
    assessWeeklyChangeVolumeCap(
      manifest?.inserts?.length ?? summary.proposed_inserts,
      manifest?.updates?.length ?? summary.proposed_updates,
      (manifest?.cutoff_hides?.length ?? 0) + (manifest?.source_absence_hides?.length ?? 0)
    );
  const writesPerformed = mode === "apply" ? applyResult?.stats?.actual_writes ?? 0 : 0;
  const weeklyHealth = summary.weekly_health || {};
  const enumerationOk = summary.enumeration_health?.royal_caribbean_source_enumeration_ok === true;

  let status = "completed";
  if (result?.blocked && !result?.ok) status = "blocked";
  else if (!result?.ok || weeklyHealth.weekly_maintenance_healthy === false) status = "failed";
  else if (summary.reconciliation_arithmetic_ok === false) status = "failed";
  else if (mode === "apply" && applyResult?.ok !== true) status = "failed";
  else if (mode === "apply" && writeCap.ok === false) status = "failed";
  else if (mode === "apply" && postWriteVerification?.ok === false) status = "failed";

  return {
    mode,
    phase: mode === "apply" ? "C" : "A",
    status,
    started_at: startedAt,
    ended_at: endedAt,
    environment,
    line_slug: ROYAL_CARIBBEAN_LINE_SLUG,
    source_snapshot_id: summary.source_snapshot_id || manifest?.source_snapshot_id || null,
    manifest_hash: manifest?.manifest_hash || null,
    first_activation_cycle: manifest?.first_activation_cycle === true,
    reconciliation: {
      union_sailing_identities: summary.union_sailing_identities ?? null,
      recognised_existing_eligible_sailings: summary.recognised_existing_eligible_sailings ?? null,
      proposed_inserts: summary.proposed_inserts ?? (manifest?.inserts || []).length,
      proposed_updates: summary.proposed_updates ?? (manifest?.updates || []).length,
      reconciliation_arithmetic_ok: summary.reconciliation_arithmetic_ok ?? null
    },
    proposed_change_metrics: {
      proposed_inserts: manifest?.inserts?.length ?? summary.proposed_inserts ?? 0,
      proposed_updates: manifest?.updates?.length ?? summary.proposed_updates ?? 0,
      cutoff_hides: manifest?.cutoff_hides?.length ?? 0,
      source_absence_hides: manifest?.source_absence_hides?.length ?? 0,
      combined_proposed_changes: writeCap.combined_proposed_changes
    },
    quality_gates: {
      enumeration_gate: enumerationOk ? "PASS" : "FAIL",
      weekly_health_gate: weeklyHealth.weekly_maintenance_healthy === true ? "PASS" : "FAIL",
      write_authorisation: mode === "dry_run" ? "DRY_RUN" : "APPLY_REQUESTED"
    },
    write_cap: writeCap,
    writes_performed: writesPerformed,
    apply_result: applyResult || null,
    post_write_verification: postWriteVerification || null,
    counts_before: countsBefore,
    counts_after: countsAfter,
    summary,
    result_reason: result?.reason || null
  };
}

function resolveWeeklyMaintenanceExitCode(report) {
  if (report.status === "blocked") return 2;
  if (report.status === "failed") return 1;
  return 0;
}

function writeWeeklyMaintenanceReportFile(report, reportDir) {
  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = (report.started_at || new Date().toISOString()).replace(/[:.]/g, "-");
  const suffix = report.mode === "apply" ? "apply" : "maintenance";
  const filePath = path.join(reportDir, `royal-caribbean-weekly-${suffix}-${stamp}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`);
  return { filePath };
}

function formatWeeklyMaintenanceSummary(report) {
  return [
    report.mode === "dry_run"
      ? "Royal Caribbean weekly maintenance — DRY RUN"
      : "Royal Caribbean weekly maintenance — APPLY",
    `Snapshot: ${report.source_snapshot_id || "—"}`,
    `Proposed inserts: ${report.proposed_change_metrics?.proposed_inserts ?? "—"}`,
    `Proposed updates: ${report.proposed_change_metrics?.proposed_updates ?? "—"}`,
    `Cutoff hides: ${report.proposed_change_metrics?.cutoff_hides ?? "—"}`,
    `Source absence hides: ${report.proposed_change_metrics?.source_absence_hides ?? "—"}`,
    `Writes performed: ${report.writes_performed ?? 0}`,
    `Status: ${report.status}`
  ].join("\n");
}

module.exports = {
  WEEKLY_APPLY_CONFIRMATION_TOKEN,
  ROYAL_CARIBBEAN_LINE_SLUG,
  MAX_WEEKLY_WRITES,
  parseWeeklyMaintenanceArgs,
  isRoyalCaribbeanWeeklyFlagEnabled,
  classifyExecutionEnvironment,
  assertWeeklyApplyAllowed,
  resolveEffectiveWeeklyMaxWrites,
  assessWeeklyChangeVolumeCap,
  verifyPostWriteManifestOperations,
  buildWeeklyMaintenanceReport,
  resolveWeeklyMaintenanceExitCode,
  writeWeeklyMaintenanceReportFile,
  formatWeeklyMaintenanceSummary
};
