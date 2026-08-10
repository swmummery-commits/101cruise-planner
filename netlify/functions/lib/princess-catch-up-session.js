/**
 * Local-only controlled Princess catch-up session orchestration (pure logic — no writes).
 */

const BATCH_MAX_WRITES = 100;
const MAX_BATCHES_PER_SESSION = 3;
const MAX_WRITES_PER_SESSION = MAX_BATCHES_PER_SESSION * BATCH_MAX_WRITES;
const DEFAULT_MAX_BATCHES_PER_SESSION = MAX_BATCHES_PER_SESSION;
const APPLY_CONFIRM_TOKEN = "PRINCESS-CONTROLLED-CATCH-UP";

const COMPLETION_REASONS = {
  REQUESTED_BATCH_LIMIT_REACHED: "requested_batch_limit_reached",
  ZERO_OUTSTANDING_ELIGIBLE: "zero_outstanding_eligible"
};

const STOP_REASONS = {
  QUALITY_GATE_FAILED: "quality_gate_failed",
  ACTIVE_COUNT_MISMATCH: "active_count_mismatch",
  START_ACTIVE_MISMATCH: "start_active_mismatch",
  SNAPSHOT_MISMATCH: "snapshot_mismatch",
  LOCK_UNAVAILABLE: "lock_unavailable",
  LOCK_OWNERSHIP_LOST: "lock_ownership_lost",
  UNRECOVERED_WRITE_FAILURE: "unrecovered_write_failure",
  MANIFEST_MISMATCH: "manifest_mismatch",
  DUPLICATE_IDENTITY: "duplicate_identity",
  NULL_REQUIRED_IDENTITY: "null_required_identity",
  POST_WRITE_VALIDATION_FAILED: "post_write_validation_failed",
  CUTOFF_VIOLATION: "cutoff_violation",
  IDEMPOTENCY_ANOMALY: "idempotency_anomaly",
  CRUISE_FINDER_REGRESSION: "cruise_finder_regression",
  COLLATERAL_INVENTORY_CHANGE: "collateral_inventory_change",
  RESOLUTION_BELOW_THRESHOLD: "resolution_below_threshold",
  UNEXPLAINED_EXPIRY: "unexplained_expiry_change",
  SESSION_WRITE_CEILING: "session_write_ceiling",
  SESSION_BATCH_CEILING: "session_batch_ceiling",
  CLOUD_EXECUTION_FORBIDDEN: "cloud_execution_forbidden",
  APPLY_CONFIRMATION_REQUIRED: "apply_confirmation_required",
  MAX_BATCHES_EXCEEDED: "max_batches_exceeded",
  ZERO_OUTSTANDING_ELIGIBLE: "zero_outstanding_eligible",
  RECONCILIATION_ARITHMETIC_FAILED: "reconciliation_arithmetic_failed",
  SOURCE_FETCH_FAILED: "source_fetch_failed",
  SOURCE_TIMEOUT: "source_timeout",
  UNEXPECTED_PREFLIGHT_ERROR: "unexpected_preflight_error"
};

function isCloudHostedEnvironment(env = process.env) {
  if (String(env.GITHUB_ACTIONS || "").toLowerCase() === "true") return true;
  if (String(env.NETLIFY || "").toLowerCase() === "true") return true;
  if (env.AWS_LAMBDA_FUNCTION_NAME) return true;
  if (env.VERCEL) return true;
  if (env.CF_PAGES) return true;
  if (String(env.CI || "").toLowerCase() === "true" && String(env.CURSOR_AGENT || "").toLowerCase() !== "true") {
    return true;
  }
  const ctx = String(env.CONTEXT || env.NETLIFY_CONTEXT || "").toLowerCase();
  if (ctx && ctx !== "dev" && ctx !== "development") return true;
  return false;
}

function parseSessionArgs(argv = process.argv) {
  const args = {
    apply: false,
    maxBatches: DEFAULT_MAX_BATCHES_PER_SESSION,
    expectedStartActive: null,
    confirm: null
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--max-batches=")) args.maxBatches = Number(arg.split("=")[1]);
    if (arg.startsWith("--expected-start-active=")) {
      args.expectedStartActive = Number(arg.split("=")[1]);
    }
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
  }
  return args;
}

function validateSessionArgs(args) {
  const errors = [];
  if (args.maxBatches == null || Number.isNaN(args.maxBatches)) {
    errors.push("max_batches_required");
  } else if (args.maxBatches < 1 || args.maxBatches > MAX_BATCHES_PER_SESSION) {
    errors.push(`max_batches_must_be_1_to_${MAX_BATCHES_PER_SESSION}`);
  }

  if (args.apply) {
    if (args.confirm !== APPLY_CONFIRM_TOKEN) {
      errors.push("apply_requires_confirm_token");
    }
    if (args.expectedStartActive == null || Number.isNaN(args.expectedStartActive)) {
      errors.push("apply_requires_expected_start_active");
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateApplyEnvironment(env = process.env) {
  if (!isCloudHostedEnvironment(env)) {
    return { ok: true, local_only: true };
  }
  return { ok: false, reason: STOP_REASONS.CLOUD_EXECUTION_FORBIDDEN };
}

function computeBatchWriteBudget({ outstandingEligibleInserts, sessionAttemptedWrites, sessionCommittedWrites, maxBatchesRemaining }) {
  const remainingSessionWrites = Math.max(0, MAX_WRITES_PER_SESSION - sessionAttemptedWrites);
  const perBatchCap = BATCH_MAX_WRITES;
  const eligibleRemaining = Math.max(0, outstandingEligibleInserts || 0);
  const batchWrites = Math.min(perBatchCap, remainingSessionWrites, eligibleRemaining);
  return {
    batch_max_writes: batchWrites,
    session_remaining_writes: remainingSessionWrites,
    eligible_remaining: eligibleRemaining,
    can_attempt_batch: batchWrites > 0 && maxBatchesRemaining > 0
  };
}

function computeSessionPreview({ activeProductionTotal, reconciliation, maxBatches = DEFAULT_MAX_BATCHES_PER_SESSION }) {
  const outstanding =
    reconciliation?.outstanding_eligible_inserts ?? reconciliation?.proposed_inserts ?? 0;
  const theoreticalMaxWrites = Math.min(
    maxBatches * BATCH_MAX_WRITES,
    MAX_WRITES_PER_SESSION,
    outstanding
  );
  const theoreticalMaxBatches = Math.min(
    maxBatches,
    MAX_BATCHES_PER_SESSION,
    Math.ceil(outstanding / BATCH_MAX_WRITES) || 0
  );
  return {
    active_production_total: activeProductionTotal,
    outstanding_eligible_inserts: outstanding,
    theoretical_max_batches: theoreticalMaxBatches,
    theoretical_max_writes: theoreticalMaxWrites,
    hard_max_batches: MAX_BATCHES_PER_SESSION,
    hard_max_writes_per_session: MAX_WRITES_PER_SESSION,
    hard_max_writes_per_batch: BATCH_MAX_WRITES,
    writes_performed: 0
  };
}

function reconcileManifestWithCommitted({ manifestWriteDetails = [], committedIds = [], recoveredCount = 0 } = {}) {
  const manifestIds = (manifestWriteDetails || [])
    .map((d) => d.discovered_cruise_id)
    .filter(Boolean);
  const manifestSet = new Set(manifestIds);
  const committedSet = new Set(committedIds || []);
  const missingFromManifest = [...committedSet].filter((id) => !manifestSet.has(id));
  const extraInManifest = manifestIds.filter((id) => !committedSet.has(id));
  const duplicateManifestIds = manifestIds.length - manifestSet.size;
  const ok =
    manifestIds.length === committedIds.length &&
    missingFromManifest.length === 0 &&
    extraInManifest.length === 0 &&
    duplicateManifestIds === 0;
  return {
    ok,
    manifest_count: manifestIds.length,
    committed_count: committedIds.length,
    unique_manifest_count: manifestSet.size,
    missing_from_manifest: missingFromManifest,
    extra_in_manifest: extraInManifest,
    duplicate_manifest_ids: duplicateManifestIds,
    recovered_count: recoveredCount
  };
}

function evaluateBatchPostWriteChecks({
  batchReport,
  manifestReconciliation,
  idempotencyCheck,
  cruiseFinderOk = true,
  collateralOk = true
} = {}) {
  const wr = batchReport?.write_result || {};
  const failed = wr.failed || batchReport?.summary?.failed_writes || 0;
  if (failed > 0) {
    return { ok: false, reason: STOP_REASONS.UNRECOVERED_WRITE_FAILURE, failed };
  }
  if (batchReport?.inserted_verification?.ok === false) {
    return { ok: false, reason: STOP_REASONS.POST_WRITE_VALIDATION_FAILED };
  }
  if (!manifestReconciliation?.ok) {
    return { ok: false, reason: STOP_REASONS.MANIFEST_MISMATCH, manifestReconciliation };
  }
  if (!idempotencyCheck?.ok) {
    return { ok: false, reason: idempotencyCheck.reason || STOP_REASONS.IDEMPOTENCY_ANOMALY, idempotencyCheck };
  }
  if (!cruiseFinderOk) {
    return { ok: false, reason: STOP_REASONS.CRUISE_FINDER_REGRESSION };
  }
  if (!collateralOk) {
    return { ok: false, reason: STOP_REASONS.COLLATERAL_INVENTORY_CHANGE };
  }
  if (batchReport?.reconciliation_summary?.reconciliation_arithmetic_ok === false) {
    return { ok: false, reason: STOP_REASONS.RECONCILIATION_ARITHMETIC_FAILED };
  }
  return { ok: true };
}

function evaluateCollateralInventoryChange({
  halBefore,
  halAfter,
  celebrityBefore,
  celebrityAfter,
  princessDeltaFromSession = 0,
  independentMaintenanceRun = null
} = {}) {
  const halDelta = halAfter - halBefore;
  const celebrityDelta = celebrityAfter - celebrityBefore;
  if (halDelta === 0 && celebrityDelta === 0) {
    return { ok: true, attributable: false, halDelta, celebrityDelta };
  }
  if (independentMaintenanceRun) {
    return {
      ok: true,
      attributable: true,
      independent_run_id: independentMaintenanceRun.stats?.run_id || independentMaintenanceRun.id,
      halDelta,
      celebrityDelta,
      princess_delta_from_session: princessDeltaFromSession
    };
  }
  return {
    ok: false,
    reason: STOP_REASONS.COLLATERAL_INVENTORY_CHANGE,
    halDelta,
    celebrityDelta,
    princess_delta_from_session: princessDeltaFromSession
  };
}

function evaluateSessionContinuation({
  batchIndex,
  batchesCompleted,
  totalAttemptedWrites = 0,
  totalCommittedWrites = 0,
  requestedMaxBatches = MAX_BATCHES_PER_SESSION,
  maxBatchesPerSession = null,
  hardMaxBatchesPerSession = MAX_BATCHES_PER_SESSION,
  hardMaxWritesPerSession = MAX_WRITES_PER_SESSION,
  maxWritesPerSession = null,
  lastBatchOk = true,
  stopReason = null,
  outstandingEligibleInserts = null
} = {}) {
  const operatorBatchLimit = requestedMaxBatches ?? maxBatchesPerSession ?? MAX_BATCHES_PER_SESSION;
  const operatorWriteLimit = hardMaxWritesPerSession ?? maxWritesPerSession ?? MAX_WRITES_PER_SESSION;

  if (stopReason) {
    return {
      continue: false,
      completed: false,
      reason: stopReason,
      batchIndex,
      batchesCompleted,
      totalAttemptedWrites,
      totalCommittedWrites
    };
  }
  if (!lastBatchOk) {
    return {
      continue: false,
      completed: false,
      reason: STOP_REASONS.UNRECOVERED_WRITE_FAILURE,
      batchIndex,
      batchesCompleted,
      totalAttemptedWrites,
      totalCommittedWrites
    };
  }
  if (outstandingEligibleInserts === 0) {
    return {
      continue: false,
      completed: true,
      completion_reason: COMPLETION_REASONS.ZERO_OUTSTANDING_ELIGIBLE,
      reason: null,
      batchIndex,
      batchesCompleted,
      totalAttemptedWrites,
      totalCommittedWrites
    };
  }
  if (batchesCompleted >= operatorBatchLimit) {
    return {
      continue: false,
      completed: true,
      completion_reason: COMPLETION_REASONS.REQUESTED_BATCH_LIMIT_REACHED,
      reason: null,
      batchIndex,
      batchesCompleted,
      totalAttemptedWrites,
      totalCommittedWrites
    };
  }
  if (totalAttemptedWrites >= operatorWriteLimit) {
    return {
      continue: false,
      completed: false,
      reason: STOP_REASONS.SESSION_WRITE_CEILING,
      batchIndex,
      batchesCompleted,
      totalAttemptedWrites,
      totalCommittedWrites
    };
  }
  if (batchesCompleted >= hardMaxBatchesPerSession) {
    return {
      continue: false,
      completed: false,
      reason: STOP_REASONS.SESSION_BATCH_CEILING,
      batchIndex,
      batchesCompleted,
      totalAttemptedWrites,
      totalCommittedWrites
    };
  }
  return {
    continue: true,
    completed: false,
    reason: null,
    batchIndex: batchIndex + 1,
    batchesCompleted,
    totalAttemptedWrites,
    totalCommittedWrites
  };
}

function resolveSessionExitCode(sessionReport) {
  if (sessionReport?.session_status === "stopped") return 1;
  if (sessionReport?.session_status === "preview_complete") return 0;
  if (sessionReport?.session_status === "completed") return 0;
  return sessionReport?.session_status === "running" ? 1 : 0;
}

function extractFinalReconciliation(sessionReport) {
  const batches = sessionReport?.batches || [];
  for (let i = batches.length - 1; i >= 0; i -= 1) {
    const summary = batches[i]?.idempotency_reconciliation;
    if (summary) {
      return {
        active_production_total: summary.active_production_total ?? null,
        eligible_total: summary.eligible_total ?? null,
        recognised_existing_eligible: summary.recognised_existing_eligible ?? null,
        outstanding_eligible_inserts: summary.outstanding_eligible_inserts ?? null,
        proposed_updates: summary.proposed_updates ?? null,
        source_absent_active: summary.source_absent_active ?? null,
        reconciliation_arithmetic_ok: summary.reconciliation_arithmetic_ok ?? null
      };
    }
  }

  const preview = sessionReport?.preview;
  if (preview) {
    return {
      active_production_total: preview.active_production_total ?? null,
      eligible_total: preview.eligible_total ?? null,
      recognised_existing_eligible: preview.recognised_existing_eligible ?? null,
      outstanding_eligible_inserts: preview.outstanding_eligible_inserts ?? null,
      proposed_updates: null,
      source_absent_active: null,
      reconciliation_arithmetic_ok: preview.reconciliation_arithmetic_ok ?? null
    };
  }

  return null;
}

function buildSessionFinalBlock({ sessionReport, countsEnd, env = process.env } = {}) {
  const reconciliation = extractFinalReconciliation(sessionReport);
  return {
    princess_active: countsEnd?.princess_active ?? null,
    hal_active: countsEnd?.hal_active ?? null,
    celebrity_active: countsEnd?.celebrity_active ?? null,
    ...reconciliation,
    automation_flags: {
      PRINCESS_WEEKLY_RECONCILIATION_ENABLED: env.PRINCESS_WEEKLY_RECONCILIATION_ENABLED ?? "(unset)",
      PRINCESS_DISCOVERY_WRITE_ENABLED: env.PRINCESS_DISCOVERY_WRITE_ENABLED ?? "(unset)",
      CRUISE_DISCOVERY_AUTOMATION_ENABLED: env.CRUISE_DISCOVERY_AUTOMATION_ENABLED ?? "(unset)"
    }
  };
}

function evaluateExpiryBetweenBatches({
  princessActiveBefore,
  princessActiveAfter,
  halActiveBefore,
  halActiveAfter,
  celebrityActiveBefore,
  celebrityActiveAfter,
  expiryRun = null,
  princessLineId = null,
  expiredPrincessRows = []
} = {}) {
  const princessDelta = princessActiveAfter - princessActiveBefore;
  const halDelta = halActiveAfter - halActiveBefore;
  const celebrityDelta = celebrityActiveAfter - celebrityActiveBefore;
  const totalDelta = princessDelta + halDelta + celebrityDelta;

  if (totalDelta === 0) {
    return { ok: true, attributable: false, princessDelta, halDelta, celebrityDelta };
  }

  if (!expiryRun?.stats?.expired_count) {
    return {
      ok: false,
      attributable: false,
      reason: STOP_REASONS.UNEXPLAINED_EXPIRY,
      princessDelta,
      halDelta,
      celebrityDelta
    };
  }

  if (totalDelta > 0) {
    return {
      ok: false,
      attributable: false,
      reason: STOP_REASONS.UNEXPLAINED_EXPIRY,
      princessDelta,
      halDelta,
      celebrityDelta
    };
  }

  if (princessDelta < 0 && princessLineId && expiredPrincessRows.length) {
    const princessExpired = expiredPrincessRows.filter((r) => r.cruise_line_id === princessLineId);
    if (princessExpired.length !== Math.abs(princessDelta)) {
      return {
        ok: false,
        attributable: false,
        reason: STOP_REASONS.UNEXPLAINED_EXPIRY,
        princessDelta,
        expected_princess_expired: Math.abs(princessDelta),
        actual_princess_expired_rows: princessExpired.length
      };
    }
  }

  return {
    ok: true,
    attributable: true,
    expiryRunId: expiryRun.stats?.run_id || expiryRun.id,
    expiredCount: expiryRun.stats?.expired_count,
    princessDelta,
    halDelta,
    celebrityDelta,
    freshCheckpointRecommended: princessActiveAfter
  };
}

function evaluateIdempotencyAnomaly(reconciliation = {}) {
  const {
    active_production_total: active = 0,
    recognised_existing_eligible: recognised = reconciliation.unchanged ?? 0,
    outstanding_eligible_inserts: outstanding = reconciliation.proposed_inserts ?? 0,
    proposed_updates: updates = 0,
    eligible_total: eligible = 0,
    source_absent_active: sourceAbsent = 0,
    writes_executed: writes = 0,
    duplicate_official_identities: dupes = reconciliation.resolution_rates?.duplicate_official_identities ?? 0,
    reconciliation_arithmetic_ok: arithmeticOk = null
  } = reconciliation;

  if (writes > 0) {
    return { ok: false, reason: STOP_REASONS.IDEMPOTENCY_ANOMALY, detail: "writes_executed_must_be_zero" };
  }
  if (dupes > 0) {
    return { ok: false, reason: STOP_REASONS.DUPLICATE_IDENTITY, detail: "duplicate_identities" };
  }
  if (arithmeticOk === false || (eligible && eligible !== recognised + outstanding + updates)) {
    return {
      ok: false,
      reason: STOP_REASONS.IDEMPOTENCY_ANOMALY,
      detail: "eligible_arithmetic_mismatch"
    };
  }
  if (sourceAbsent === 0 && active !== recognised) {
    return {
      ok: false,
      reason: STOP_REASONS.IDEMPOTENCY_ANOMALY,
      detail: "active_not_equal_recognised_when_no_source_absent"
    };
  }
  return { ok: true, active, recognised, outstanding, updates, eligible };
}

function buildSessionReportSkeleton({ sessionId, mode, args, localGuard, countsStart }) {
  return {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    ended_at: null,
    mode,
    local_execution_guard: localGuard,
    expected_start_active: args.expectedStartActive,
    actual_start_active: countsStart?.princess_active ?? null,
    requested_max_batches: args.maxBatches,
    hard_max_batches: MAX_BATCHES_PER_SESSION,
    hard_max_writes_per_batch: BATCH_MAX_WRITES,
    hard_max_writes_per_session: MAX_WRITES_PER_SESSION,
    session_status: "running",
    stop_reason: null,
    completion_reason: null,
    total_attempted: 0,
    total_committed: 0,
    total_recovered: 0,
    total_failed: 0,
    batches: [],
    counts_start: countsStart,
    counts_end: null,
    preview: null,
    writes_performed: 0
  };
}

module.exports = {
  APPLY_CONFIRM_TOKEN,
  BATCH_MAX_WRITES,
  MAX_BATCHES_PER_SESSION,
  MAX_WRITES_PER_SESSION,
  DEFAULT_MAX_BATCHES_PER_SESSION,
  COMPLETION_REASONS,
  STOP_REASONS,
  isCloudHostedEnvironment,
  parseSessionArgs,
  validateSessionArgs,
  validateApplyEnvironment,
  computeBatchWriteBudget,
  computeSessionPreview,
  reconcileManifestWithCommitted,
  evaluateBatchPostWriteChecks,
  evaluateCollateralInventoryChange,
  evaluateSessionContinuation,
  evaluateExpiryBetweenBatches,
  evaluateIdempotencyAnomaly,
  buildSessionReportSkeleton,
  resolveSessionExitCode,
  extractFinalReconciliation,
  buildSessionFinalBlock
};
