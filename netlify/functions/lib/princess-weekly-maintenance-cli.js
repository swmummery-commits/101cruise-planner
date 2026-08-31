/**
 * Princess weekly maintenance CLI helpers (Phase A dry-run + Phase C apply).
 */

const fs = require("fs");
const path = require("path");
const { buildPrincessReconciliationSummary } = require("./princess-reconciliation-summary");
const { buildRollbackManifestFromWriteResult } = require("./cruise-discovery-maintenance-manifests");

const PHASE_A_APPLY_BLOCKED = "weekly_apply_not_enabled_in_phase_a";
const WEEKLY_APPLY_CONFIRMATION_TOKEN = "PRINCESS-WEEKLY-MAINTENANCE";
const MAX_WEEKLY_WRITES = 30;
const WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP = "weekly_change_volume_exceeds_initial_cap";
const SECRET_KEY_PATTERN =
  /secret|password|token|service_role|api_key|authorization|cookie|set-cookie/i;

function parseWeeklyMaintenanceArgs(argv = process.argv) {
  const args = argv.slice(2);
  const apply = args.some((arg) => arg === "--apply" || arg.startsWith("--apply="));
  let confirm = null;
  let maxWrites = null;
  for (const arg of args) {
    if (arg.startsWith("--confirm=")) confirm = arg.slice("--confirm=".length);
    else if (arg === "--confirm" || arg.startsWith("--confirm")) {
      const idx = args.indexOf(arg);
      if (args[idx + 1] && !args[idx + 1].startsWith("--")) confirm = args[idx + 1];
    }
    if (arg.startsWith("--max-writes=")) maxWrites = Number(arg.slice("--max-writes=".length));
    else if (arg === "--max-writes") {
      const idx = args.indexOf(arg);
      if (args[idx + 1] && !args[idx + 1].startsWith("--")) maxWrites = Number(args[idx + 1]);
    }
  }
  return { apply, dryRun: !apply, confirm, maxWrites };
}

function makeWeeklyError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function assertPhaseAApplyBlocked(args) {
  if (args?.apply) {
    throw makeWeeklyError(PHASE_A_APPLY_BLOCKED, PHASE_A_APPLY_BLOCKED);
  }
}

function isWeeklyReconciliationFlagEnabled(env = process.env) {
  return String(env.PRINCESS_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() === "true";
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
    runnerLabels.includes("self-hosted") || runnerLabels.includes("princess-local-mac");
  const isCloudHosted =
    isGitHubActions &&
    !isSelfHosted &&
    /^(ubuntu|windows|macos)-/i.test(String(env.RUNNER_OS || ""));

  let sourceEnvironment = "local_mac";
  if (isNetlify) sourceEnvironment = "netlify";
  else if (isGitHubActions && isSelfHosted) sourceEnvironment = "github_self_hosted_mac";
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
    netlify_detected: isNetlify,
    source_environment: sourceEnvironment,
    phase: applyMode ? "C" : "A",
    apply_enabled: applyMode
  };
}

function assertWeeklyApplyEnvironment(env = process.env) {
  const classified = classifyExecutionEnvironment(env, { applyMode: true });
  if (classified.netlify_detected) {
    throw makeWeeklyError("weekly_apply_netlify_forbidden", "weekly_apply_netlify_forbidden");
  }
  if (classified.cloud_hosted_detected) {
    throw makeWeeklyError("weekly_apply_cloud_hosted_forbidden", "weekly_apply_cloud_hosted_forbidden");
  }
  if (classified.source_environment === "ci_other") {
    throw makeWeeklyError("weekly_apply_ci_forbidden", "weekly_apply_ci_forbidden");
  }
  if (
    classified.github_actions &&
    !classified.self_hosted_detected &&
    classified.source_environment !== "local_mac"
  ) {
    throw makeWeeklyError("weekly_apply_cloud_hosted_forbidden", "weekly_apply_cloud_hosted_forbidden");
  }
  const allowed =
    classified.source_environment === "local_mac" ||
    classified.source_environment === "github_self_hosted_mac";
  if (!allowed) {
    throw makeWeeklyError("weekly_apply_environment_forbidden", "weekly_apply_environment_forbidden");
  }
  return classified;
}

function assertWeeklyApplyAllowed(args, env = process.env) {
  if (!args?.apply) return;
  if (args.confirm !== WEEKLY_APPLY_CONFIRMATION_TOKEN) {
    throw makeWeeklyError("weekly_apply_confirmation_required", "weekly_apply_confirmation_required");
  }
  if (!isWeeklyReconciliationFlagEnabled(env)) {
    throw makeWeeklyError(
      "princess_weekly_reconciliation_disabled",
      "Princess weekly maintenance is disabled (PRINCESS_WEEKLY_RECONCILIATION_ENABLED=false)"
    );
  }
  assertWeeklyApplyEnvironment(env);
  if (args.maxWrites == null || Number.isNaN(Number(args.maxWrites))) {
    throw makeWeeklyError("weekly_apply_max_writes_required", "weekly_apply_max_writes_required");
  }
  const effective = resolveEffectiveWeeklyMaxWrites(args.maxWrites);
  if (effective == null) {
    throw makeWeeklyError("weekly_apply_max_writes_invalid", "weekly_apply_max_writes_invalid");
  }
}

function resolveEffectiveWeeklyMaxWrites(requestedMax) {
  const n = Number(requestedMax);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.floor(n), MAX_WEEKLY_WRITES);
}

function assessWeeklyChangeVolumeCap(proposedInserts, proposedUpdates) {
  const inserts = Number(proposedInserts) || 0;
  const updates = Number(proposedUpdates) || 0;
  const combined = inserts + updates;
  if (combined > MAX_WEEKLY_WRITES) {
    return {
      ok: false,
      reason: WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP,
      proposed_inserts: inserts,
      proposed_updates: updates,
      combined_proposed_changes: combined,
      cap: MAX_WEEKLY_WRITES
    };
  }
  return {
    ok: true,
    proposed_inserts: inserts,
    proposed_updates: updates,
    combined_proposed_changes: combined,
    cap: MAX_WEEKLY_WRITES
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

function extractWriteAccounting(summary = {}, writeResult = {}) {
  const stats = writeResult?.stats || writeResult || {};
  const committed = (summary.inserts || stats.inserted || 0) + (summary.updates || stats.updated || 0);
  const genuinelyFailed = summary.failed_writes ?? stats.failed ?? 0;
  const recovered =
    summary.recovered_after_fetch_failure ?? stats.recovered_after_fetch_failure ?? 0;
  const attempted = summary.write_attempts ?? committed + genuinelyFailed;
  const unchanged = summary.duplicate_skips ?? summary.unchanged ?? 0;
  const accountingOk = attempted === committed + genuinelyFailed;
  return {
    accounting_ok: accountingOk,
    attempted,
    committed,
    recovered_after_fetch_failure: recovered,
    genuinely_failed: genuinelyFailed,
    unchanged,
    source_absent_active: summary.source_absent_active ?? 0
  };
}

function validateRollbackManifestIntegrity({ rollbackResult, summary, writeResult, runMeta = {} }) {
  const committed = (summary?.inserts || 0) + (summary?.updates || 0);
  if (committed === 0) {
    const skipped =
      rollbackResult?.skipped === true ||
      rollbackResult?.reason === "no_writes" ||
      summary?.rollback_manifest_id == null;
    if (skipped) {
      return { ok: true, zero_writes: true, manifest_record_count: 0 };
    }
    return { ok: false, reason: "zero_writes_unexpected_manifest" };
  }

  const manifest =
    rollbackResult?.manifest ||
    buildRollbackManifestFromWriteResult({
      runId: runMeta.runId || summary.run_id,
      runRecordId: runMeta.runRecordId || null,
      cruiseLineId: runMeta.cruiseLineId || null,
      lineSlug: "princess-cruises",
      triggerType: runMeta.triggerType || summary.trigger_type,
      writeResult: writeResult || { stats: summary, write_details: writeResult?.write_details }
    });

  const inserted = manifest.inserted || [];
  const updated = manifest.updated || [];
  const manifestRecordCount = inserted.length + updated.length;
  const allIds = [
    ...(manifest.inserted_record_ids || []),
    ...(manifest.updated_record_ids || [])
  ].filter(Boolean);
  if (new Set(allIds).size !== allIds.length) {
    return { ok: false, reason: "duplicate_manifest_entries" };
  }
  if (manifestRecordCount !== committed) {
    return {
      ok: false,
      reason: "manifest_count_mismatch",
      expected: committed,
      actual: manifestRecordCount
    };
  }
  for (const entry of [...inserted, ...updated]) {
    if (!entry.discovered_cruise_id) {
      return { ok: false, reason: "manifest_missing_record_id" };
    }
    if (!entry.official_sailing_id) {
      return { ok: false, reason: "manifest_missing_official_sailing_id" };
    }
  }
  return { ok: true, manifest_record_count: manifestRecordCount, manifest_id: summary?.rollback_manifest_id ?? null };
}

function validatePostWriteReconciliation(postWriteSummary) {
  if (!postWriteSummary) {
    return { ok: false, reason: "missing_post_write_reconciliation" };
  }
  if (postWriteSummary.reconciliation_arithmetic_ok !== true) {
    return { ok: false, reason: "post_write_reconciliation_arithmetic_failed" };
  }
  if (postWriteSummary.all_active_recognised_in_eligible_source !== true) {
    return { ok: false, reason: "post_write_active_not_recognised" };
  }
  const idempotencyWrites =
    (postWriteSummary.outstanding_eligible_inserts ?? postWriteSummary.proposed_inserts ?? 0) +
    (postWriteSummary.proposed_updates ?? 0);
  if (idempotencyWrites !== 0) {
    return { ok: false, reason: "post_write_idempotency_anomaly", idempotency_writes: idempotencyWrites };
  }
  return { ok: true, idempotency_writes: 0 };
}

function buildWeeklyMaintenanceReport({
  mode = "dry_run",
  triggerType = null,
  startedAt,
  endedAt,
  environment,
  executeResult,
  maintenanceResult,
  countsBefore,
  countsAfter,
  previousEligibleTotal = null,
  writeCapAssessment = null,
  writeAccounting = null,
  manifestValidation = null,
  postWriteReconciliation = null,
  postWriteVerification = null
}) {
  const summary = executeResult?.summary || maintenanceResult?.summary || {};
  const simulation = maintenanceResult?.simulation || executeResult?.simulation || {};
  const fetchResult = simulation.fetch_result || {};
  const rates = summary.resolution_rates || {};
  const reconciliationSummary = buildPrincessReconciliationSummary({
    activeProductionTotal: summary.active_production_total ?? countsAfter?.princess ?? 0,
    eligibleTotal: summary.eligible_total ?? 0,
    recognisedExistingEligible: summary.recognised_existing_eligible ?? summary.unchanged ?? 0,
    outstandingEligibleInserts: summary.outstanding_eligible_inserts ?? summary.proposed_inserts ?? 0,
    proposedUpdates: summary.proposed_updates ?? 0,
    proposedIdentityReviewUpdates:
      summary.proposed_updates_identity_review ?? summary.proposed_identity_review_updates ?? 0,
    sourceAbsentActive: summary.source_absent_active ?? 0,
    writesExecuted: writeAccounting?.committed ?? (summary.inserts || 0) + (summary.updates || 0)
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
    proposed_identity_review_updates:
      summary.proposed_updates_identity_review ??
      summary.proposed_identity_review_updates ??
      reconciliationSummary.proposed_identity_review_updates,
    identity_review_sailing_ids: summary.identity_review_sailing_ids || [],
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

  const capAssessment =
    writeCapAssessment ||
    assessWeeklyChangeVolumeCap(
      summary.proposed_inserts ?? proposedInserts,
      summary.proposed_updates ?? proposedUpdates
    );

  const accounting =
    mode === "apply"
      ? writeAccounting || extractWriteAccounting(summary, maintenanceResult?.write_result || executeResult?.write_result)
      : null;

  const writesPerformed =
    mode === "apply" ? accounting?.committed ?? (summary.inserts || 0) + (summary.updates || 0) : 0;

  const status = resolveWeeklyMaintenanceStatus({
    mode,
    executeResult,
    maintenanceResult,
    sourceFetchFailed,
    qualityGate,
    reconciliation,
    countsBefore,
    countsAfter,
    writeCapAssessment: capAssessment,
    writeAccounting: accounting,
    manifestValidation,
    postWriteReconciliation,
    postWriteVerification,
    writesPerformed
  });

  const report = {
    mode,
    phase: mode === "apply" ? "C" : "A",
    trigger_type: triggerType,
    execution_mode: mode === "apply" ? "apply" : "dry_run",
    started_at: startedAt,
    ended_at: endedAt,
    elapsed_ms: endedAt && startedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : null,
    environment,
    run_id: executeResult?.run_id || summary.run_id || null,
    run_record_id: executeResult?.run_record_id || null,
    source: {
      fetch_failed: sourceFetchFailed,
      official_source_total: summary.official_source_total ?? simulation.num_found_official ?? null,
      expanded_sailings:
        summary.source_accounting?.expanded_dated_sailings ?? simulation.raw_sailing_count ?? null,
      source_accounting: summary.source_accounting ?? null,
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
    write_cap: capAssessment,
    source_absent: sourceAbsent,
    snapshot_id: summary.snapshot_id ?? null,
    counts_before: countsBefore,
    counts_after: countsAfter,
    inventory_unchanged:
      countsBefore?.princess != null &&
      countsAfter?.princess != null &&
      countsBefore.princess === countsAfter.princess,
    writes_performed: writesPerformed,
    blocked: executeResult?.blocked === true || maintenanceResult?.blocked === true,
    status,
    error:
      status === "failed"
        ? executeResult?.reason || maintenanceResult?.reason || capAssessment?.reason || null
        : null
  };

  if (mode === "apply") {
    report.writes = {
      cap: MAX_WEEKLY_WRITES,
      effective_max_writes: summary.effective_max_writes ?? null,
      proposed_inserts: capAssessment.proposed_inserts ?? proposedInserts,
      proposed_updates: capAssessment.proposed_updates ?? proposedUpdates,
      combined_proposed_changes: capAssessment.combined_proposed_changes ?? combinedProposedChanges,
      ...accounting,
      rollback_manifest_id: summary.rollback_manifest_id ?? null,
      zero_change_apply: summary.zero_change_apply === true || writesPerformed === 0
    };
    report.manifest_validation = manifestValidation || null;
    report.post_write_reconciliation = postWriteReconciliation || null;
    report.post_write_verification = postWriteVerification || null;
  }

  return report;
}

function resolveWeeklyMaintenanceStatus({
  mode = "dry_run",
  executeResult,
  maintenanceResult,
  sourceFetchFailed,
  qualityGate,
  reconciliation,
  countsBefore,
  countsAfter,
  writeCapAssessment,
  writeAccounting,
  manifestValidation,
  postWriteReconciliation,
  postWriteVerification,
  writesPerformed = 0
}) {
  if (executeResult?.review_required === true) return "review_required";
  if (maintenanceResult?.review_required === true) return "review_required";

  if (executeResult?.success === false && !executeResult?.blocked && !executeResult?.review_required) {
    return "failed";
  }
  if (maintenanceResult?.ok === false && !maintenanceResult?.blocked && !maintenanceResult?.review_required) {
    return "failed";
  }
  if (sourceFetchFailed) return "failed";
  if (qualityGate?.passed === false) {
    if (
      mode === "apply" &&
      writesPerformed === 0 &&
      executeResult?.review_required !== false &&
      (executeResult?.reason === WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP ||
        executeResult?.reason === "identity_critical_updates_require_review" ||
        String(executeResult?.reason || "").includes("identity_critical_updates_require_review") ||
        qualityGate?.review_required === true ||
        qualityGate?.failures?.includes("identity_critical_updates_require_review") ||
        (qualityGate?.expansion_anomaly?.failures?.length &&
          !qualityGate.failures?.some((f) => !String(f).includes("princess_eligible") && !String(f).includes("princess_outstanding") && !String(f).includes("identity_critical"))))
    ) {
      return "review_required";
    }
    return "failed";
  }
  if (reconciliation?.reconciliation_arithmetic_ok === false) return "failed";
  if (mode === "apply" && writeCapAssessment && writeCapAssessment.ok === false) {
    if (writesPerformed === 0 && writeCapAssessment.reason === WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP) {
      return "review_required";
    }
    return "failed";
  }
  if (mode === "apply" && writeAccounting && writeAccounting.accounting_ok === false) return "failed";
  if (mode === "apply" && manifestValidation && manifestValidation.ok === false) return "failed";
  if (mode === "apply" && postWriteReconciliation && postWriteReconciliation.ok === false) return "failed";
  if (mode === "apply" && postWriteVerification && postWriteVerification.ok === false) return "failed";
  if (mode === "apply" && writesPerformed > 0) {
    if (maintenanceResult?.ok === false || executeResult?.success === false) return "failed";
  }
  if (
    mode === "dry_run" &&
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
  if (report.status === "completed" || report.status === "review_required") return 0;
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
  const triggerLabel =
    report.trigger_type === "scheduled"
      ? "Scheduled"
      : report.trigger_type === "manual"
        ? "Manual"
        : report.mode === "apply"
          ? "Manual"
          : "Dry run";
  const title =
    report.mode === "apply" ? "Princess Weekly Maintenance" : "Princess Weekly Maintenance — DRY RUN";
  const lines = [
    title,
    `Trigger: ${triggerLabel}`,
    `Execution mode: ${report.execution_mode || report.mode}`,
    "",
    `Active: ${r.active_production_total ?? "—"}`,
    `Eligible: ${r.eligible_total ?? "—"}`,
    `Recognised: ${r.recognised_existing_eligible ?? "—"}`,
    `Proposed inserts: ${r.outstanding_eligible_inserts ?? "—"}`,
    `Proposed updates: ${r.proposed_updates ?? "—"}`,
    `Source absent: ${report.source_absent?.count ?? "—"}`,
    `Quality gate: ${qg}`,
    `Snapshot: ${report.snapshot_id ?? "—"}`
  ];
  if (report.mode === "apply") {
    lines.push(`Write cap: ${report.write_cap?.cap ?? MAX_WEEKLY_WRITES}`);
    lines.push(`Committed: ${report.writes?.committed ?? 0}`);
    lines.push(`Attempted: ${report.writes?.attempted ?? 0}`);
    lines.push(`Writes performed: ${report.writes_performed ?? 0}`);
    if (report.writes?.zero_change_apply === true) {
      lines.push("Zero-change apply: yes");
    }
    const reconOk = report.post_write_reconciliation?.ok;
    if (reconOk === true) lines.push("Reconciliation: PASS");
    else if (reconOk === false) lines.push("Reconciliation: FAIL");
  } else {
    lines.push("Writes: 0");
  }
  lines.push(`Status: ${report.status}`);
  return lines.join("\n");
}

function writeWeeklyMaintenanceReportFile(report, reportsDir) {
  const stamp = (report.started_at || new Date().toISOString()).replace(/[:.]/g, "-");
  const suffix = report.mode === "apply" ? "apply" : "maintenance";
  const filename = `princess-weekly-${suffix}-${stamp}.json`;
  const filePath = path.join(reportsDir, filename);
  const safe = redactSecrets(report);
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(safe, null, 2)}\n`);
  return { filePath, filename };
}

function verifyWorkflowConfirmationInput(provided, expected = WEEKLY_APPLY_CONFIRMATION_TOKEN) {
  return String(provided || "").trim() === expected;
}

function resolveWorkflowTriggerType(eventName) {
  if (eventName === "schedule") return "scheduled";
  if (eventName === "workflow_dispatch") return "manual";
  return null;
}

function resolveWorkflowApplyContext({ eventName, confirmationInput, maxWritesInput } = {}) {
  const trigger_type = resolveWorkflowTriggerType(eventName);
  if (!trigger_type) {
    return { ok: false, reason: "unsupported_workflow_event", event_name: eventName || null };
  }
  if (trigger_type === "manual" && !verifyWorkflowConfirmationInput(confirmationInput)) {
    return { ok: false, reason: "weekly_apply_confirmation_required", trigger_type };
  }
  const max_writes = resolveEffectiveWeeklyMaxWrites(maxWritesInput ?? MAX_WEEKLY_WRITES);
  if (max_writes == null) {
    return { ok: false, reason: "weekly_apply_max_writes_invalid", trigger_type };
  }
  return {
    ok: true,
    trigger_type,
    confirmation_token: WEEKLY_APPLY_CONFIRMATION_TOKEN,
    max_writes
  };
}

function resolveMaintenanceRunnerTriggerType(workflowTriggerType) {
  return workflowTriggerType === "scheduled" ? "weekly_scheduled_apply" : "weekly_manual_apply";
}

function buildGitHubJobSummary(report) {
  const r = report.reconciliation || {};
  const triggerLabel =
    report.trigger_type === "scheduled"
      ? "Scheduled"
      : report.trigger_type === "manual"
        ? "Manual"
        : "Unknown";
  const reconStatus =
    report.post_write_reconciliation?.ok === true
      ? "PASS"
      : report.post_write_reconciliation?.ok === false
        ? "FAIL"
        : report.reconciliation?.reconciliation_arithmetic_ok === true
          ? "PASS"
          : report.reconciliation?.reconciliation_arithmetic_ok === false
            ? "FAIL"
            : "—";
  const statusLabel =
    report.status === "completed"
      ? "SUCCESS"
      : report.status === "review_required"
        ? "REVIEW REQUIRED — NO WRITES"
        : report.status === "blocked"
          ? "BLOCKED"
          : "FAILED";
  const title =
    report.status === "review_required"
      ? "## Princess Weekly Maintenance — REVIEW REQUIRED"
      : "## Princess Weekly Maintenance";
  return [
    title,
    "",
    report.status === "review_required" ? "**Scheduled review condition — zero production writes performed.**" : null,
    `**Trigger:** ${triggerLabel}`,
    `**Execution mode:** ${report.execution_mode || report.mode}`,
    "",
    `**Eligible source cruises:** ${r.eligible_total ?? "—"}`,
    `**Active production:** ${r.active_production_total ?? "—"}`,
    `**Proposed inserts:** ${report.proposed_change_metrics?.proposed_inserts ?? r.outstanding_eligible_inserts ?? "—"}`,
    `**Proposed updates:** ${report.proposed_change_metrics?.proposed_updates ?? r.proposed_updates ?? "—"}`,
    `**Committed:** ${report.writes?.committed ?? 0}`,
    `**Source absent retained:** ${report.source_absent?.count ?? "—"}`,
    `**Writes performed:** ${report.writes_performed ?? 0}`,
    `**Reconciliation:** ${reconStatus}`,
    `**Status:** ${statusLabel}`
  ]
    .filter(Boolean)
    .join("\n");
}

function countPrincessWeeklyCronSchedules(workflowSources = []) {
  let count = 0;
  for (const src of workflowSources) {
    if (/^\s*schedule:/m.test(src) && /0 20 \* \* 0/.test(src) && /princess/i.test(src)) {
      count += 1;
    }
  }
  return count;
}

module.exports = {
  PHASE_A_APPLY_BLOCKED,
  WEEKLY_APPLY_CONFIRMATION_TOKEN,
  MAX_WEEKLY_WRITES,
  WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP,
  parseWeeklyMaintenanceArgs,
  assertPhaseAApplyBlocked,
  assertWeeklyApplyAllowed,
  assertWeeklyApplyEnvironment,
  isWeeklyReconciliationFlagEnabled,
  classifyExecutionEnvironment,
  resolveEffectiveWeeklyMaxWrites,
  assessWeeklyChangeVolumeCap,
  computeEligibleChangeMetrics,
  extractWriteAccounting,
  validateRollbackManifestIntegrity,
  validatePostWriteReconciliation,
  buildWeeklyMaintenanceReport,
  resolveWeeklyMaintenanceStatus,
  resolveWeeklyMaintenanceExitCode,
  redactSecrets,
  formatWeeklyMaintenanceSummary,
  writeWeeklyMaintenanceReportFile,
  verifyWorkflowConfirmationInput,
  resolveWorkflowTriggerType,
  resolveWorkflowApplyContext,
  resolveMaintenanceRunnerTriggerType,
  buildGitHubJobSummary,
  countPrincessWeeklyCronSchedules
};
