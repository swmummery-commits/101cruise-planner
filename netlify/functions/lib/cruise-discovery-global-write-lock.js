/**
 * Global cross-line production cruise inventory write lock.
 *
 * Serialises INSERT/UPDATE/DELETE (status expiry) mutations on discovered_cruises
 * across all cruise lines. Read-only discovery, dry runs, and preflight stay unlocked.
 *
 * Lock order (deadlock-safe): line-specific maintenance lock FIRST, then global write lock.
 * Reuses cruise_discovery_maintenance_locks + RPCs — no separate lock table.
 */

const { AsyncLocalStorage } = require("async_hooks");
const {
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock,
  verifyMaintenanceLockOwnership,
  loadMaintenanceLockStatus
} = require("./cruise-discovery-maintenance-locks");

const GLOBAL_CRUISE_WRITE_LOCK_KEY = "controlled_production_import:global";
const GLOBAL_LOCK_DENIED_REASON = "global_production_import_lock_unavailable";

/**
 * Silversea 124-sailing controlled batch completed in ~10 minutes; allow headroom for
 * verification and rollback manifest persistence. No heartbeat renewal in this table.
 */
const DEFAULT_GLOBAL_LEASE_SECONDS = 1800;

const globalWriteLockContext = new AsyncLocalStorage();

function resolveGlobalLockOwnerId(params = {}) {
  return String(params.ownerId || params.runId || "").trim();
}

function buildGlobalLockReportFields(lockState = {}, extras = {}) {
  return {
    global_lock_required: extras.global_lock_required !== false,
    global_lock_key: GLOBAL_CRUISE_WRITE_LOCK_KEY,
    global_lock_acquired: lockState.acquired === true,
    global_lock_owner: lockState.owner_id || lockState.global_lock_owner || null,
    global_lock_run_id: lockState.run_id || lockState.global_lock_run_id || null,
    global_lock_acquired_at: lockState.acquired_at || lockState.global_lock_acquired_at || null,
    global_lock_expires_at: lockState.expires_at || lockState.global_lock_expires_at || null,
    global_lock_released: extras.global_lock_released === true,
    global_lock_denial_reason: lockState.acquired === false ? lockState.reason || GLOBAL_LOCK_DENIED_REASON : null,
    global_lock_current_holder: lockState.current_holder || lockState.owner_id || null,
    global_lock_line_slug: lockState.line_slug || null,
    global_lock_operation: lockState.operation || null,
    ...extras
  };
}

async function acquireGlobalCruiseWriteLock(supabase, params = {}) {
  const ownerId = resolveGlobalLockOwnerId(params);
  const runId = params.runId != null ? String(params.runId).trim() : ownerId;
  if (!ownerId) {
    return {
      acquired: false,
      reason: "invalid_lock_parameters",
      lock_key: GLOBAL_CRUISE_WRITE_LOCK_KEY
    };
  }

  const leaseSeconds =
    Number(params.leaseSeconds) > 0 ? Number(params.leaseSeconds) : DEFAULT_GLOBAL_LEASE_SECONDS;

  const result = await acquireMaintenanceDbLock(supabase, {
    lockKey: GLOBAL_CRUISE_WRITE_LOCK_KEY,
    ownerId,
    runId,
    runRecordId: params.runRecordId || null,
    leaseSeconds
  });

  if (result.acquired) {
    return {
      acquired: true,
      lock_key: GLOBAL_CRUISE_WRITE_LOCK_KEY,
      owner_id: ownerId,
      run_id: runId,
      acquired_at: new Date().toISOString(),
      expires_at: result.expires_at || null,
      line_slug: params.lineSlug || null,
      operation: params.operation || null,
      worker_state: "running"
    };
  }

  const status = await loadMaintenanceLockStatus(supabase, GLOBAL_CRUISE_WRITE_LOCK_KEY).catch(() => ({
    held: false
  }));

  return {
    acquired: false,
    reason: GLOBAL_LOCK_DENIED_REASON,
    denial_reason: result.reason || GLOBAL_LOCK_DENIED_REASON,
    lock_key: GLOBAL_CRUISE_WRITE_LOCK_KEY,
    owner_id: status.owner_id || result.owner_id || null,
    run_id: status.run_id || null,
    acquired_at: status.acquired_at || null,
    expires_at: status.expires_at || result.expires_at || null,
    current_holder: status.owner_id || result.owner_id || null,
    worker_state: "already_running"
  };
}

async function releaseGlobalCruiseWriteLock(supabase, params = {}) {
  const ownerId = String(params.ownerId || "").trim();
  if (!ownerId) return false;
  return releaseMaintenanceDbLock(supabase, {
    lockKey: GLOBAL_CRUISE_WRITE_LOCK_KEY,
    ownerId
  });
}

async function assertGlobalCruiseWriteLockHeld(options = {}) {
  if (options.requireGlobalWriteLock === false) return;

  const ctx = globalWriteLockContext.getStore();
  const ownerId = options.globalWriteLockOwnerId || ctx?.ownerId;
  if (!ownerId) {
    const err = new Error(GLOBAL_LOCK_DENIED_REASON);
    err.code = GLOBAL_LOCK_DENIED_REASON;
    throw err;
  }

  const sb = ctx?.supabase;
  if (!sb) {
    const err = new Error(`${GLOBAL_LOCK_DENIED_REASON}: missing_supabase_client`);
    err.code = GLOBAL_LOCK_DENIED_REASON;
    throw err;
  }

  const verify = await verifyMaintenanceLockOwnership(sb, {
    lockKey: GLOBAL_CRUISE_WRITE_LOCK_KEY,
    ownerId
  });
  if (!verify.ok) {
    const err = new Error(`${GLOBAL_LOCK_DENIED_REASON}: ${verify.reason}`);
    err.code = GLOBAL_LOCK_DENIED_REASON;
    err.lock_status = verify.status;
    throw err;
  }
}

async function withGlobalCruiseWriteLock(supabase, params, fn) {
  const lock = await acquireGlobalCruiseWriteLock(supabase, params);
  if (!lock.acquired) {
    return {
      acquired: false,
      ...lock,
      observability: buildGlobalLockReportFields(lock, { global_lock_released: false })
    };
  }

  const observability = buildGlobalLockReportFields(lock, { global_lock_released: false });
  const ownerId = resolveGlobalLockOwnerId(params);
  try {
    const result = await globalWriteLockContext.run({ ownerId, supabase }, async () => {
      return fn({ ...lock, observability });
    });
    return {
      acquired: true,
      result,
      ...lock,
      observability: buildGlobalLockReportFields(lock, { global_lock_released: true })
    };
  } finally {
    await releaseGlobalCruiseWriteLock(supabase, { ownerId: resolveGlobalLockOwnerId(params) });
  }
}

/**
 * Controlled batch / maintenance production apply wrapper.
 * Preflight and discovery must occur OUTSIDE this call.
 */
async function executeControlledProductionApply(supabase, params, writeFn) {
  if (params.dryRun || params.performWrites === false) {
    const writeResult = await writeFn(null);
    return {
      blocked: false,
      writeResult,
      global_lock: buildGlobalLockReportFields({}, { global_lock_required: false, global_lock_acquired: false })
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
        const recheck = await params.underLockRecheck();
        if (!recheck?.ok) {
          return { blocked: true, reason: recheck.reason || "under_lock_recheck_failed", recheck };
        }
      }
      const writeResult = await writeFn(lockMeta);
      return { blocked: false, writeResult };
    }
  );

  if (!wrapped.acquired) {
    return {
      blocked: true,
      reason: wrapped.reason || GLOBAL_LOCK_DENIED_REASON,
      current_holder: wrapped.current_holder || wrapped.owner_id || null,
      global_lock: wrapped.observability || buildGlobalLockReportFields(wrapped, { global_lock_released: false })
    };
  }

  if (wrapped.result?.blocked) {
    return {
      blocked: true,
      reason: wrapped.result.reason,
      recheck: wrapped.result.recheck || null,
      global_lock: wrapped.observability
    };
  }

  return {
    blocked: false,
    writeResult: wrapped.result?.writeResult,
    global_lock: wrapped.observability
  };
}

/**
 * Scheduled maintenance write section (line-specific lock must already be held).
 */
async function runGlobalProtectedMaintenanceWrites(supabase, params) {
  const { runId, runRecordId, lineSlug, operation, underLockRecheck, writeFn } = params;
  const wrapped = await withGlobalCruiseWriteLock(
    supabase,
    {
      ownerId: runId,
      runId,
      runRecordId,
      lineSlug,
      operation: operation || "scheduled_maintenance"
    },
    async (lockMeta) => {
      if (underLockRecheck) {
        const recheck = await underLockRecheck();
        if (!recheck?.ok) {
          return { blocked: true, reason: recheck.reason || "under_lock_recheck_failed", recheck };
        }
      }
      const writeResult = await writeFn(lockMeta);
      return { blocked: false, writeResult };
    }
  );

  if (!wrapped.acquired) {
    return {
      blocked: true,
      ok: false,
      reason: wrapped.reason || GLOBAL_LOCK_DENIED_REASON,
      current_holder: wrapped.current_holder || wrapped.owner_id || null,
      global_lock: wrapped.observability
    };
  }

  if (wrapped.result?.blocked) {
    return {
      blocked: true,
      ok: false,
      reason: wrapped.result.reason,
      recheck: wrapped.result.recheck || null,
      global_lock: wrapped.observability
    };
  }

  return {
    blocked: false,
    ok: true,
    writeResult: wrapped.result?.writeResult,
    global_lock: wrapped.observability
  };
}

/**
 * Acquire global write lock when not already inside a protected mutation context.
 * Used by shared apply*BatchWrites boundaries so standalone scripts inherit protection.
 */
async function ensureGlobalCruiseWriteLockForMutation(supabase, params, fn) {
  const ctx = globalWriteLockContext.getStore();
  const ownerId = resolveGlobalLockOwnerId(params);
  if (ctx?.ownerId) {
    await assertGlobalCruiseWriteLockHeld({ globalWriteLockOwnerId: ctx.ownerId });
    return fn();
  }

  const wrapped = await withGlobalCruiseWriteLock(supabase, { ...params, ownerId, runId: params.runId || ownerId }, fn);
  if (!wrapped.acquired) {
    const err = new Error(wrapped.reason || GLOBAL_LOCK_DENIED_REASON);
    err.code = GLOBAL_LOCK_DENIED_REASON;
    err.lock_status = wrapped;
    throw err;
  }
  return wrapped.result;
}

/**
 * Lock-only lifecycle smoke (zero discovered_cruises mutations).
 */
async function runGlobalLockSmokeTest(supabase, params = {}) {
  const ownerId = resolveGlobalLockOwnerId(params);
  const runId = params.runId || ownerId;
  if (!ownerId) {
    return { passed: false, reason: "invalid_smoke_owner", steps: [] };
  }

  const steps = [];
  const before = await loadMaintenanceLockStatus(supabase, GLOBAL_CRUISE_WRITE_LOCK_KEY).catch(() => ({
    held: false
  }));
  steps.push({ step: "available_before", held: before.held, owner_id: before.owner_id || null });

  if (before.held && !before.expired && before.owner_id !== ownerId) {
    return {
      passed: false,
      reason: "lock_held_by_other_owner",
      expected_owner: ownerId,
      actual_owner: before.owner_id,
      steps
    };
  }

  const acquired = await acquireGlobalCruiseWriteLock(supabase, {
    ownerId,
    runId,
    operation: params.operation || "global_lock_smoke",
    leaseSeconds: params.leaseSeconds || 120
  });
  steps.push({
    step: "acquired",
    acquired: acquired.acquired === true,
    owner_id: acquired.owner_id || null,
    expires_at: acquired.expires_at || null
  });
  if (!acquired.acquired) {
    return { passed: false, reason: acquired.reason || "acquire_failed", steps };
  }

  const assert1 = await verifyMaintenanceLockOwnership(supabase, {
    lockKey: GLOBAL_CRUISE_WRITE_LOCK_KEY,
    ownerId
  });
  steps.push({
    step: "assertion_1",
    ok: assert1.ok === true,
    reason: assert1.reason || null,
    expected_owner: ownerId,
    actual_owner: assert1.status?.owner_id || null
  });
  if (!assert1.ok) {
    await releaseGlobalCruiseWriteLock(supabase, { ownerId });
    return { passed: false, reason: assert1.reason, steps };
  }

  const assert2 = await verifyMaintenanceLockOwnership(supabase, {
    lockKey: GLOBAL_CRUISE_WRITE_LOCK_KEY,
    ownerId
  });
  steps.push({
    step: "assertion_2",
    ok: assert2.ok === true,
    reason: assert2.reason || null,
    expected_owner: ownerId,
    actual_owner: assert2.status?.owner_id || null
  });
  if (!assert2.ok) {
    await releaseGlobalCruiseWriteLock(supabase, { ownerId });
    return { passed: false, reason: assert2.reason, steps };
  }

  const released = await releaseGlobalCruiseWriteLock(supabase, { ownerId });
  steps.push({ step: "released", released: released === true });

  const after = await loadMaintenanceLockStatus(supabase, GLOBAL_CRUISE_WRITE_LOCK_KEY).catch(() => ({
    held: false
  }));
  steps.push({
    step: "absent_after_release",
    held: after.held === true,
    owner_id: after.owner_id || null,
    expired: after.expired === true
  });

  const passed =
    assert1.ok &&
    assert2.ok &&
    released === true &&
    (!after.held || after.expired || after.owner_id !== ownerId);

  return {
    passed,
    owner_id: ownerId,
    run_id: runId,
    lock_key: GLOBAL_CRUISE_WRITE_LOCK_KEY,
    steps,
    reason: passed ? null : "post_release_lock_still_held"
  };
}

module.exports = {
  GLOBAL_CRUISE_WRITE_LOCK_KEY,
  GLOBAL_LOCK_DENIED_REASON,
  DEFAULT_GLOBAL_LEASE_SECONDS,
  globalWriteLockContext,
  buildGlobalLockReportFields,
  acquireGlobalCruiseWriteLock,
  releaseGlobalCruiseWriteLock,
  assertGlobalCruiseWriteLockHeld,
  withGlobalCruiseWriteLock,
  executeControlledProductionApply,
  runGlobalProtectedMaintenanceWrites,
  ensureGlobalCruiseWriteLockForMutation,
  resolveGlobalLockOwnerId,
  runGlobalLockSmokeTest,
  loadGlobalCruiseWriteLockStatus: (supabase) =>
    loadMaintenanceLockStatus(supabase, GLOBAL_CRUISE_WRITE_LOCK_KEY)
};
