/**
 * Princess weekly maintenance CLI helpers (Phase A: dry-run only).
 */

const fs = require("fs");
const path = require("path");
const { buildPrincessReconciliationSummary } = require("./princess-reconciliation-summary");

const PHASE_A_APPLY_BLOCKED = "weekly_apply_not_enabled_in_phase_a";
const SECRET_KEY_PATTERN =
  /secret|password|token|service_role|api_key|authorization|cookie|set-cookie/i;

function parseWeeklyMaintenanceArgs(argv = process.argv) {
  const apply = argv.slice(2).some((arg) => arg === "--apply" || arg.startsWith("--apply="));
  return { apply, dryRun: !apply };
}

function assertPhaseAApplyBlocked(args) {
  if (args?.apply) {
    const err = new Error(PHASE_A_APPLY_BLOCKED);
    err.code = PHASE_A_APPLY_BLOCKED;
    throw err;
  }
}

function classifyExecutionEnvironment(env = process.env) {
  const isGitHubActions = env.GITHUB_ACTIONS === "true";
  const isCi = Boolean(env.CI);
  const runnerLabels = String(env.RUNNER_LABELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isSelfHosted =
    runnerLabels.includes("self-hosted") || runnerLabels.includes("princess-local-mac");
  const isCloudHosted =
    isGitHubActions &&
    !isSelfHosted &&
    /^(ubuntu|windows|macos)-/i.test(String(env.RUNNER_OS || ""));

  let sourceEnvironment = "local_mac";
  if (isGitHubActions && isSelfHosted) sourceEnvironment = "github_self_hosted_mac";
  else if (isGitHubActions && isCloudHosted) sourceEnvironment = "github_hosted_cloud";
  else if (isCi && !isGitHubActions) sourceEnvironment = "ci_other";

  return {
    platform: process.platform,
    architecture: process.arch,
    node_version: process.version,
    ci: isCi,
    github_actions: isGitHubActions,
    github_run_id: env.GITHUB_RUN_ID || null,
    github_run_attempt: env.GITHUB_RUN_ATTEMPT || null,
    github_ref: env.GITHUB_REF || null,
    runner_os: env.RUNNER_OS || null,
    runner_labels: runnerLabels,
    self_hosted_expected: true,
    self_hosted_detected: isSelfHosted,
    cloud_hosted_detected: isCloudHosted,
    source_environment: sourceEnvironment,
    phase: "A",
    apply_enabled: false
  };
}

function computeEligibleChangeMetrics(currentEligible, previousEligible) {
  if (previousEligible == null || previousEligible === 0 || currentEligible == null) {
    return {
      previous_eligible_total: previousEligible ?? null,
      eligible_delta: null,
      eligible_change_pct: null
    };
  }
  const delta = currentEligible - previousEligible;
  return {
    previous_eligible_total: previousEligible,
    eligible_delta: delta,
    eligible_change_pct: Number(((delta / previousEligible) * 100).toFixed(4))
  };
}

function buildWeeklyMaintenanceReport({
  mode = "dry_run",
  startedAt,
  endedAt,
  environment,
  executeResult,
  maintenanceResult,
  countsBefore,
  countsAfter,
  previousEligibleTotal = null
}) {
  const summary = executeResult?.summary || maintenanceResult?.summary || {};
  const simulation = maintenanceResult?.simulation || {};
  const fetchResult = simulation.fetch_result || {};
  const rates = summary.resolution_rates || {};
  const reconciliationSummary = buildPrincessReconciliationSummary({
    activeProductionTotal: summary.active_production_total ?? countsAfter?.princess ?? 0,
    eligibleTotal: summary.eligible_total ?? 0,
    recognisedExistingEligible: summary.recognised_existing_eligible ?? summary.unchanged ?? 0,
    outstandingEligibleInserts: summary.outstanding_eligible_inserts ?? summary.proposed_inserts ?? 0,
    proposedUpdates: summary.proposed_updates ?? 0,
    sourceAbsentActive: summary.source_absent_active ?? 0,
    writesExecuted: 0
  });
  const reconciliation = {
    active_production_total:
      summary.active_production_total ?? countsAfter?.princess ?? reconciliationSummary.active_production_total,
    eligible_total: summary.eligible_total ?? reconciliationSummary.eligible_total,
    recognised_existing_eligible:
      summary.recognised_existing_eligible ??
      summary.unchanged ??
      reconciliationSummary.recognised_existing_eligible,
    outstanding_eligible_inserts:
      summary.outstanding_eligible_inserts ??
      summary.proposed_inserts ??
      reconciliationSummary.outstanding_eligible_inserts,
    proposed_updates: summary.proposed_updates ?? reconciliationSummary.proposed_updates,
    source_absent_active: summary.source_absent_active ?? reconciliationSummary.source_absent_active,
    reconciliation_arithmetic_ok:
      summary.reconciliation_arithmetic_ok ?? reconciliationSummary.reconciliation_arithmetic_ok,
    all_active_recognised_in_eligible_source:
      summary.all_active_recognised_in_eligible_source ??
      reconciliationSummary.all_active_recognised_in_eligible_source,
    ...computeEligibleChangeMetrics(summary.eligible_total ?? reconciliationSummary.eligible_total, previousEligibleTotal)
  };

  const proposedInserts = reconciliation.outstanding_eligible_inserts ?? 0;
  const proposedUpdates = reconciliation.proposed_updates ?? 0;
  const combinedProposedChanges = proposedInserts + proposedUpdates;

  const sourceAbsent = {
    count: summary.source_absent_active ?? 0,
    sailing_ids: summary.source_absent_sailing_ids || [],
    policy: "source_absent_retained_active"
  };

  const qualityGate = summary.quality_gate || {
    passed: null,
    failures: [],
    blocked: null
  };

  const sourceFetchFailed =
    fetchResult.fetch_failed === true ||
    maintenanceResult?.failed === true ||
    maintenanceResult?.reason === "official_source_unreachable";

  const status = resolveWeeklyMaintenanceStatus({
    executeResult,
    maintenanceResult,
    sourceFetchFailed,
    qualityGate,
    reconciliation,
    countsBefore,
    countsAfter
  });

  return {
    mode,
    phase: "A",
    started_at: startedAt,
    ended_at: endedAt,
    elapsed_ms: endedAt && startedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : null,
    environment,
    run_id: executeResult?.run_id || summary.run_id || null,
    run_record_id: executeResult?.run_record_id || null,
    source: {
      fetch_failed: sourceFetchFailed,
      official_source_total: summary.official_source_total ?? simulation.num_found_official ?? null,
      expanded_sailings: simulation.raw_sailing_count ?? null,
      within_public_cutoff_excluded: summary.within_public_cutoff_excluded ?? null,
      incomplete_skipped: summary.incomplete_skipped ?? null,
      cruisetours_excluded: summary.cruisetours_excluded ?? null,
      error: fetchResult.error || maintenanceResult?.reason || executeResult?.reason || null
    },
    quality_gate: {
      evaluated: qualityGate.passed != null || Array.isArray(qualityGate.failures),
      passed: qualityGate.passed === true,
      failures: qualityGate.failures || [],
      blocked: qualityGate.blocked === true
    },
    resolution: {
      ship_resolution_pct: rates.ship_resolution_pct ?? null,
      departure_port_resolution_pct: rates.departure_port_resolution_pct ?? null,
      destination_resolution_pct: rates.destination_resolution_pct ?? null,
      identity_coverage_pct: rates.identity_coverage_pct ?? null
    },
    reconciliation,
    proposed_change_metrics: {
      proposed_inserts: proposedInserts,
      proposed_updates: proposedUpdates,
      combined_proposed_changes: combinedProposedChanges
    },
    source_absent: sourceAbsent,
    snapshot_id: summary.snapshot_id ?? null,
    counts_before: countsBefore,
    counts_after: countsAfter,
    inventory_unchanged:
      countsBefore?.princess != null &&
      countsAfter?.princess != null &&
      countsBefore.princess === countsAfter.princess,
    writes_performed: 0,
    blocked: executeResult?.blocked === true || maintenanceResult?.blocked === true,
    status,
    error: status === "failed" ? executeResult?.reason || maintenanceResult?.reason || null : null
  };
}

function resolveWeeklyMaintenanceStatus({
  executeResult,
  maintenanceResult,
  sourceFetchFailed,
  qualityGate,
  reconciliation,
  countsBefore,
  countsAfter
}) {
  if (executeResult?.success === false && !executeResult?.blocked) return "failed";
  if (maintenanceResult?.ok === false && !maintenanceResult?.blocked) return "failed";
  if (sourceFetchFailed) return "failed";
  if (qualityGate?.passed === false) return "failed";
  if (reconciliation?.reconciliation_arithmetic_ok === false) return "failed";
  if (
    countsBefore?.princess != null &&
    countsAfter?.princess != null &&
    countsBefore.princess !== countsAfter.princess
  ) {
    return "failed";
  }
  if (executeResult?.blocked || maintenanceResult?.blocked) return "blocked";
  return "completed";
}

function resolveWeeklyMaintenanceExitCode(report) {
  if (!report) return 1;
  if (report.status === "completed") return 0;
  if (report.status === "blocked") return 2;
  return 1;
}

function redactSecrets(value, key = "") {
  if (value == null) return value;
  if (typeof value === "string") {
    if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
    if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value)) return "[REDACTED_JWT]";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, key));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecrets(v, k);
    }
    return out;
  }
  return value;
}

function formatWeeklyMaintenanceSummary(report) {
  const r = report.reconciliation || {};
  const qg = report.quality_gate?.passed === true ? "passed" : report.quality_gate?.passed === false ? "failed" : "unknown";
  return [
    "Princess Weekly Maintenance — DRY RUN",
    "",
    `Active: ${r.active_production_total ?? "—"}`,
    `Eligible: ${r.eligible_total ?? "—"}`,
    `Recognised: ${r.recognised_existing_eligible ?? "—"}`,
    `Proposed inserts: ${r.outstanding_eligible_inserts ?? "—"}`,
    `Proposed updates: ${r.proposed_updates ?? "—"}`,
    `Source absent: ${report.source_absent?.count ?? "—"}`,
    `Quality gate: ${qg}`,
    `Snapshot: ${report.snapshot_id ?? "—"}`,
    "Writes: 0",
    `Status: ${report.status}`
  ].join("\n");
}

function writeWeeklyMaintenanceReportFile(report, reportsDir) {
  const stamp = (report.started_at || new Date().toISOString()).replace(/[:.]/g, "-");
  const filename = `princess-weekly-maintenance-${stamp}.json`;
  const filePath = path.join(reportsDir, filename);
  const safe = redactSecrets(report);
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(safe, null, 2)}\n`);
  return { filePath, filename };
}

module.exports = {
  PHASE_A_APPLY_BLOCKED,
  parseWeeklyMaintenanceArgs,
  assertPhaseAApplyBlocked,
  classifyExecutionEnvironment,
  computeEligibleChangeMetrics,
  buildWeeklyMaintenanceReport,
  resolveWeeklyMaintenanceStatus,
  resolveWeeklyMaintenanceExitCode,
  redactSecrets,
  formatWeeklyMaintenanceSummary,
  writeWeeklyMaintenanceReportFile
};
