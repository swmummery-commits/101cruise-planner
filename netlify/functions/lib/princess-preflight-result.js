/**
 * Structured Princess session preflight result classification.
 * Distinguishes lock, source, quality-gate and unexpected failures.
 */

const PREFLIGHT_ERROR_CODES = {
  LOCK_UNAVAILABLE: "lock_unavailable",
  LOCK_ERROR: "lock_error",
  SOURCE_FETCH_FAILED: "source_fetch_failed",
  SOURCE_BOOTSTRAP_FAILED: "source_bootstrap_failed",
  SOURCE_CATALOGUE_FAILED: "source_catalogue_failed",
  SOURCE_TIMEOUT: "source_timeout",
  QUALITY_GATE_FAILED: "quality_gate_failed",
  RESOLUTION_BELOW_THRESHOLD: "resolution_below_threshold",
  RECONCILIATION_FAILED: "reconciliation_failed",
  SNAPSHOT_GENERATION_FAILED: "snapshot_generation_failed",
  UNEXPECTED_PREFLIGHT_ERROR: "unexpected_preflight_error"
};

const STOP_REASON_BY_PREFLIGHT_CODE = {
  lock_unavailable: "lock_unavailable",
  lock_error: "lock_unavailable",
  source_fetch_failed: "source_fetch_failed",
  source_bootstrap_failed: "source_fetch_failed",
  source_catalogue_failed: "source_fetch_failed",
  source_timeout: "source_timeout",
  quality_gate_failed: "quality_gate_failed",
  resolution_below_threshold: "resolution_below_threshold",
  reconciliation_failed: "reconciliation_arithmetic_failed",
  snapshot_generation_failed: "snapshot_mismatch",
  unexpected_preflight_error: "unexpected_preflight_error"
};

const TRANSIENT_PREFLIGHT_CODES = new Set([
  PREFLIGHT_ERROR_CODES.LOCK_UNAVAILABLE,
  PREFLIGHT_ERROR_CODES.SOURCE_FETCH_FAILED,
  PREFLIGHT_ERROR_CODES.SOURCE_BOOTSTRAP_FAILED,
  PREFLIGHT_ERROR_CODES.SOURCE_CATALOGUE_FAILED,
  PREFLIGHT_ERROR_CODES.SOURCE_TIMEOUT
]);

const PREFLIGHT_RETRY_WAIT_MS = 2500;

function extractSourceDiagnostics(simulation = {}) {
  const fetchResult = simulation.fetch_result || {};
  const diag =
    simulation.source_diagnostics ||
    fetchResult.source_diagnostics ||
    fetchResult.diagnostics ||
    null;
  const bootstrap = diag?.bootstrap || null;
  const catalogue = diag?.catalogue || null;
  const stage = diag?.stage || bootstrap?.stage || catalogue?.stage || null;
  return {
    source_error_stage: stage,
    bootstrap_http_status: bootstrap?.http_status ?? bootstrap?.status ?? null,
    catalogue_http_status: catalogue?.http_status ?? catalogue?.status ?? null
  };
}

function isResolutionQualityFailure(failures = []) {
  return failures.some((f) => /resolution|identity_coverage|duplicate_official/i.test(String(f)));
}

function classifyPrincessMaintenanceResult(result = {}, { elapsedMs = null } = {}) {
  const summary = result.summary || {};
  const simulation = result.simulation || {};
  const qualityGate = summary.quality_gate ?? null;
  const qualityGateEvaluated = qualityGate != null;
  const sourceDiag = extractSourceDiagnostics(simulation);

  const base = {
    ok: false,
    preflight_stage: "maintenance_dry_run",
    preflight_error_code: null,
    preflight_error_message: null,
    quality_gate_evaluated: qualityGateEvaluated,
    quality_gate_passed: qualityGate?.passed ?? null,
    snapshot_id: summary.snapshot_id ?? null,
    lock_status: result.lock_status || null,
    elapsed_ms: elapsedMs,
    source_error_stage: sourceDiag.source_error_stage,
    bootstrap_http_status: sourceDiag.bootstrap_http_status,
    catalogue_http_status: sourceDiag.catalogue_http_status,
    maintenance_reason: result.reason || null
  };

  if (result.ok === true && qualityGate?.passed === true) {
    return {
      ...base,
      ok: true,
      preflight_stage: "completed",
      quality_gate_evaluated: true,
      quality_gate_passed: true
    };
  }

  const lockReason = String(result.reason || "");
  const lockBlocked =
    result.blocked === true &&
    !qualityGateEvaluated &&
    !simulation.fetch_failed &&
    /lock|already_running|maintenance_lock/i.test(lockReason);

  if (lockBlocked) {
    return {
      ...base,
      preflight_stage: "lock_acquisition",
      preflight_error_code:
        lockReason === "invalid_lock_parameters"
          ? PREFLIGHT_ERROR_CODES.LOCK_ERROR
          : PREFLIGHT_ERROR_CODES.LOCK_UNAVAILABLE,
      preflight_error_message: lockReason || "maintenance_lock_held",
      lock_status: result.lock_status || {
        held: true,
        owner_id: result.owner_id || null,
        worker_state: result.worker_state || null
      },
      quality_gate_evaluated: false,
      quality_gate_passed: null
    };
  }

  const sourceFailed =
    simulation.fetch_failed === true ||
    result.reason === "official_source_unreachable" ||
    result.failed === true;

  if (sourceFailed && !qualityGateEvaluated) {
    const error =
      simulation.error ||
      simulation.fetch_result?.error ||
      result.reason ||
      "official_source_unreachable";
    const errorText = String(error);
    let code = PREFLIGHT_ERROR_CODES.SOURCE_FETCH_FAILED;
    if (sourceDiag.source_error_stage === "bootstrap") {
      code = PREFLIGHT_ERROR_CODES.SOURCE_BOOTSTRAP_FAILED;
    } else if (sourceDiag.source_error_stage === "catalogue") {
      code = PREFLIGHT_ERROR_CODES.SOURCE_CATALOGUE_FAILED;
    }
    if (/timeout/i.test(errorText)) {
      code = PREFLIGHT_ERROR_CODES.SOURCE_TIMEOUT;
    }
    return {
      ...base,
      preflight_stage: sourceDiag.source_error_stage || "source_fetch",
      preflight_error_code: code,
      preflight_error_message: errorText,
      quality_gate_evaluated: false,
      quality_gate_passed: null
    };
  }

  if (qualityGateEvaluated && qualityGate.passed === false) {
    const failures = qualityGate.failures || [];
    const resolutionOnly =
      failures.length > 0 && failures.every((f) => /resolution|identity|duplicate/i.test(String(f)));
    return {
      ...base,
      preflight_stage: "quality_gate",
      preflight_error_code:
        resolutionOnly && isResolutionQualityFailure(failures)
          ? PREFLIGHT_ERROR_CODES.RESOLUTION_BELOW_THRESHOLD
          : PREFLIGHT_ERROR_CODES.QUALITY_GATE_FAILED,
      preflight_error_message: failures.join("; ") || result.reason || "quality_gate_failed",
      quality_gate_evaluated: true,
      quality_gate_passed: false
    };
  }

  if (summary.reconciliation_arithmetic_ok === false) {
    return {
      ...base,
      preflight_stage: "reconciliation",
      preflight_error_code: PREFLIGHT_ERROR_CODES.RECONCILIATION_FAILED,
      preflight_error_message: "reconciliation_arithmetic_failed",
      quality_gate_evaluated: qualityGateEvaluated,
      quality_gate_passed: qualityGate?.passed ?? null
    };
  }

  if (qualityGateEvaluated && qualityGate.passed === true && result.ok === false) {
    return {
      ...base,
      preflight_stage: "post_gate",
      preflight_error_code: PREFLIGHT_ERROR_CODES.UNEXPECTED_PREFLIGHT_ERROR,
      preflight_error_message: result.reason || "preflight_failed_after_quality_gate",
      quality_gate_evaluated: true,
      quality_gate_passed: true
    };
  }

  if (!summary.snapshot_id && qualityGateEvaluated && qualityGate.passed === true) {
    return {
      ...base,
      preflight_stage: "snapshot",
      preflight_error_code: PREFLIGHT_ERROR_CODES.SNAPSHOT_GENERATION_FAILED,
      preflight_error_message: "snapshot_id_missing_after_preflight",
      quality_gate_evaluated: true,
      quality_gate_passed: true
    };
  }

  return {
    ...base,
    preflight_stage: "unexpected",
    preflight_error_code: PREFLIGHT_ERROR_CODES.UNEXPECTED_PREFLIGHT_ERROR,
    preflight_error_message: result.reason || "preflight_failed_without_quality_gate",
    quality_gate_evaluated: qualityGateEvaluated,
    quality_gate_passed: qualityGate?.passed ?? null
  };
}

function mapPreflightToStopReason(preflight = {}) {
  const code = preflight.preflight_error_code;
  return STOP_REASON_BY_PREFLIGHT_CODE[code] || "unexpected_preflight_error";
}

function isTransientPreflightFailure(preflight = {}) {
  return TRANSIENT_PREFLIGHT_CODES.has(preflight.preflight_error_code);
}

function buildPreflightAttemptRecord({ attemptNum, preflight, runId, elapsedMs }) {
  return {
    attempt: attemptNum,
    run_id: runId,
    elapsed_ms: elapsedMs,
    ok: preflight.ok,
    preflight_stage: preflight.preflight_stage,
    preflight_error_code: preflight.preflight_error_code,
    preflight_error_message: preflight.preflight_error_message,
    quality_gate_evaluated: preflight.quality_gate_evaluated,
    quality_gate_passed: preflight.quality_gate_passed,
    lock_status: preflight.lock_status,
    source_error_stage: preflight.source_error_stage,
    bootstrap_http_status: preflight.bootstrap_http_status,
    catalogue_http_status: preflight.catalogue_http_status
  };
}

module.exports = {
  PREFLIGHT_ERROR_CODES,
  STOP_REASON_BY_PREFLIGHT_CODE,
  TRANSIENT_PREFLIGHT_CODES,
  PREFLIGHT_RETRY_WAIT_MS,
  extractSourceDiagnostics,
  classifyPrincessMaintenanceResult,
  mapPreflightToStopReason,
  isTransientPreflightFailure,
  buildPreflightAttemptRecord
};
