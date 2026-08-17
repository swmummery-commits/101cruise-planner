/**
 * Hardened controlled production run lifecycle — durable rollback/report state
 * and verification-under-global-lock architecture.
 */

const fs = require("fs");
const path = require("path");
const { GLOBAL_CRUISE_WRITE_LOCK_KEY, withGlobalCruiseWriteLock } = require("./cruise-discovery-global-write-lock");

const RUN_STATUS = Object.freeze({
  PREPARED: "PREPARED",
  LOCK_ACQUIRED: "LOCK_ACQUIRED",
  MUTATING: "MUTATING",
  WRITE_COMPLETE: "WRITE_COMPLETE",
  VERIFYING: "VERIFYING",
  VERIFIED: "VERIFIED",
  COMPLETE: "COMPLETE",
  WRITE_SUCCEEDED_VERIFICATION_FAILED: "WRITE_SUCCEEDED_VERIFICATION_FAILED",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED"
});

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function buildPreWriteRollbackManifest(params) {
  return {
    run_id: params.runId,
    fixture_path: params.fixturePath || null,
    lock_key: GLOBAL_CRUISE_WRITE_LOCK_KEY,
    operation: params.operation || null,
    line_slug: params.lineSlug || null,
    cruise_line_id: params.cruiseLineId || null,
    authorised_official_sailing_ids: (params.officialSailingIds || []).slice(),
    expected_inserts: params.expectedInserts ?? 0,
    expected_updates: 0,
    expected_deletes: 0,
    write_ceiling: params.writeCeiling ?? null,
    production_before: params.productionBefore || null,
    source_snapshot: params.sourceSnapshot || null,
    created_at: params.createdAt || new Date().toISOString(),
    status: RUN_STATUS.PREPARED,
    inserted_record_ids: [],
    inserted_official_sailing_ids: [],
    verification_status: null,
    completion_status: null,
    controlled_batch: params.controlledBatch || null
  };
}

function buildControlledBatchMarker({ line = "silversea", productType = "expedition", phase, runId, fixture }) {
  return {
    line,
    product_type: productType,
    phase: phase || null,
    run_id: runId || null,
    fixture: fixture || null
  };
}

function appendInsertedRecord(manifest, { discoveredCruiseId, officialSailingId }) {
  if (!manifest) return manifest;
  if (discoveredCruiseId && !manifest.inserted_record_ids.includes(discoveredCruiseId)) {
    manifest.inserted_record_ids.push(discoveredCruiseId);
  }
  if (officialSailingId && !manifest.inserted_official_sailing_ids.includes(officialSailingId)) {
    manifest.inserted_official_sailing_ids.push(officialSailingId);
  }
  manifest.inserted_count = manifest.inserted_record_ids.length;
  return manifest;
}

function buildApplyReportLifecycle(base) {
  return {
    run_id: base.runId,
    status: RUN_STATUS.PREPARED,
    created_at: base.createdAt || new Date().toISOString(),
    updated_at: base.createdAt || new Date().toISOString(),
    fixture_path: base.fixturePath || null,
    operation: base.operation || null,
    line_slug: base.lineSlug || null,
    expected_inserts: base.expectedInserts ?? null,
    production_before: base.productionBefore || null,
    global_lock: null,
    write_result: null,
    verification: null,
    verification_error: null,
    rollback_manifest_path: null,
    apply_report_path: null
  };
}

function updateReportLifecycle(report, patch) {
  return {
    ...report,
    ...patch,
    updated_at: new Date().toISOString()
  };
}

class ControlledProductionRunStore {
  constructor(reportDir, runId) {
    this.reportDir = reportDir;
    this.runId = runId;
    this.rollbackPath = path.join(reportDir, `controlled-production-rollback-${runId}.json`);
    this.applyReportPath = path.join(reportDir, `controlled-production-apply-${runId}.json`);
  }

  persistPreparedRollback(manifest) {
    atomicWriteJson(this.rollbackPath, manifest);
    return this.rollbackPath;
  }

  updateRollback(manifest) {
    atomicWriteJson(this.rollbackPath, manifest);
    return this.rollbackPath;
  }

  persistPreparedReport(report) {
    atomicWriteJson(this.applyReportPath, report);
    return this.applyReportPath;
  }

  updateReport(report) {
    atomicWriteJson(this.applyReportPath, report);
    return this.applyReportPath;
  }

  readRollback() {
    if (!fs.existsSync(this.rollbackPath)) return null;
    return JSON.parse(fs.readFileSync(this.rollbackPath, "utf8"));
  }
}

/**
 * Execute mutation + full verification while global lock is held.
 * Preflight and durable PREPARED manifest must occur before calling this.
 */
async function executeHardenedControlledProductionApply(supabase, params, phases) {
  if (params.dryRun || params.performWrites === false) {
    const writeResult = await phases.mutate(null);
    return {
      blocked: false,
      dry_run: true,
      writeResult,
      run_status: RUN_STATUS.PREPARED
    };
  }

  const wrapped = await withGlobalCruiseWriteLock(
    supabase,
    {
      ownerId: params.runId,
      runId: params.runId,
      runRecordId: params.runRecordId || null,
      lineSlug: params.lineSlug || null,
      operation: params.operation || "controlled_batch",
      leaseSeconds: params.leaseSeconds
    },
    async (lockMeta) => {
      if (params.underLockRecheck) {
        const recheck = await params.underLockRecheck(lockMeta);
        if (!recheck?.ok) {
          return { blocked: true, reason: recheck.reason || "under_lock_recheck_failed", recheck, lockMeta };
        }
      }

      await phases.onLockAcquired?.(lockMeta);

      let writeResult = null;
      let writeError = null;
      try {
        writeResult = await phases.mutate(lockMeta);
      } catch (err) {
        writeError = err;
        return { blocked: false, writeError, lockMeta, run_status: RUN_STATUS.FAILED };
      }

      await phases.onWriteComplete?.({ lockMeta, writeResult });

      let verificationResult = null;
      let verificationError = null;
      try {
        await phases.onVerificationStart?.({ lockMeta, writeResult });
        verificationResult = await phases.verifyUnderLock({ lockMeta, writeResult });
      } catch (err) {
        verificationError = {
          message: err.message || String(err),
          code: err.code || null
        };
      }

      let finalizeResult = null;
      let finalizeError = null;
      try {
        finalizeResult = await phases.finalizeUnderLock?.({
          lockMeta,
          writeResult,
          verificationResult,
          verificationError
        });
      } catch (err) {
        finalizeError = { message: err.message || String(err) };
      }

      const runStatus = verificationError
        ? RUN_STATUS.WRITE_SUCCEEDED_VERIFICATION_FAILED
        : verificationResult?.ok === false
          ? RUN_STATUS.WRITE_SUCCEEDED_VERIFICATION_FAILED
          : RUN_STATUS.VERIFIED;

      return {
        blocked: false,
        writeResult,
        verificationResult,
        verificationError,
        finalizeResult,
        finalizeError,
        lockMeta,
        lock_held_through_verification: true,
        run_status: runStatus
      };
    }
  );

  if (!wrapped.acquired) {
    return {
      blocked: true,
      reason: wrapped.reason || "global_lock_denied",
      current_holder: wrapped.current_holder || wrapped.owner_id || null,
      global_lock: wrapped.observability,
      run_status: RUN_STATUS.BLOCKED
    };
  }

  if (wrapped.result?.blocked) {
    return {
      blocked: true,
      reason: wrapped.result.reason,
      recheck: wrapped.result.recheck || null,
      global_lock: wrapped.observability,
      run_status: RUN_STATUS.BLOCKED
    };
  }

  return {
    blocked: false,
    writeResult: wrapped.result?.writeResult,
    verificationResult: wrapped.result?.verificationResult,
    verificationError: wrapped.result?.verificationError,
    finalizeResult: wrapped.result?.finalizeResult,
    finalizeError: wrapped.result?.finalizeError,
    global_lock: wrapped.observability,
    lock_held_through_verification: wrapped.result?.lock_held_through_verification === true,
    run_status: wrapped.result?.run_status || RUN_STATUS.FAILED,
    writeError: wrapped.result?.writeError || null
  };
}

function recoverInsertedRowsByRunId(rows, runId) {
  return (rows || []).filter((row) => {
    const marker = row?.raw_extract?.controlled_batch;
    return marker?.run_id === runId;
  });
}

function recoverInsertedRowsFromManifest(manifest, rowsById) {
  const ids = manifest?.inserted_record_ids || [];
  return ids.map((id) => rowsById.get(id)).filter(Boolean);
}

function simulateCrashRecoveryScenarios(manifest, rows) {
  const rowsById = new Map((rows || []).map((r) => [r.id, r]));
  const byRunId = recoverInsertedRowsByRunId(rows, manifest.run_id);
  const byManifest = recoverInsertedRowsFromManifest(manifest, rowsById);
  const manifestIds = new Set(manifest?.inserted_record_ids || []);
  const runIdIds = new Set(byRunId.map((r) => r.id));
  const sameIds =
    manifestIds.size === runIdIds.size && [...manifestIds].every((id) => runIdIds.has(id));
  return {
    manifest_recovery_ids: [...manifestIds],
    run_id_recovery_ids: [...runIdIds],
    independent_paths_match: sameIds,
    broad_line_delete_required: false
  };
}

/**
 * Aggregate verification result where `ok` must reflect all protection gates.
 * Spreads nested verifier payloads first, then sets authoritative `ok` last.
 */
function buildAuthoritativeVerificationResult({ aggregateOk, verification = {}, ...rest }) {
  const { ok: _ignoredVerifierOk, ...verificationBody } = verification || {};
  return {
    ...verificationBody,
    ...rest,
    ok: aggregateOk === true
  };
}

module.exports = {
  RUN_STATUS,
  atomicWriteJson,
  buildPreWriteRollbackManifest,
  buildControlledBatchMarker,
  appendInsertedRecord,
  buildApplyReportLifecycle,
  updateReportLifecycle,
  ControlledProductionRunStore,
  executeHardenedControlledProductionApply,
  buildAuthoritativeVerificationResult,
  recoverInsertedRowsByRunId,
  recoverInsertedRowsFromManifest,
  simulateCrashRecoveryScenarios
};
