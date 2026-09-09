/**
 * Reconcile abandoned weekly-maintenance runs whose line lock has expired.
 * Control-plane only — never invents successful completion.
 *
 * A run is abandoned only when ALL are true:
 *   status = running
 *   age exceeds conservative threshold
 *   line execution lease expired (or held by a different owner)
 *   global write lock does not prove this run is still executing
 *
 * Scheduled dispatch-period leases are NOT evidence that a worker is still running.
 */

const {
  loadMaintenanceLockStatus,
  weeklyLockKey,
  dailyExpiryLockKey,
  LOCK_TABLE
} = require("./cruise-discovery-maintenance-locks");
const {
  loadGlobalCruiseWriteLockStatus,
  GLOBAL_CRUISE_WRITE_LOCK_KEY
} = require("./cruise-discovery-global-write-lock");

const STALE_RUNNING_MIN_AGE_MS = 30 * 60 * 1000;
const ABANDON_REASON = "maintenance_worker_terminated_or_lease_expired";

async function loadRunningRuns(supabase, { cruiseLineId = null, scope = "cruise_line", limit = 50 } = {}) {
  const scopeFilter = scope === "full" ? "scope=eq.full" : "scope=eq.cruise_line";
  const lineFilter = cruiseLineId
    ? `&cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}`
    : "";
  return (
    (await supabase(
      `cruise_discovery_runs?${scopeFilter}${lineFilter}&status=eq.running&select=id,status,stats,started_at,finished_at,error_message,cruise_line_id,scope&order=started_at.asc&limit=${limit}`
    ).catch(() => [])) || []
  );
}

function lockMatchesRun(lockStatus, run) {
  if (!lockStatus?.held) return false;
  const runId = run?.stats?.run_id;
  if (lockStatus.run_id && runId && lockStatus.run_id === runId) return true;
  if (lockStatus.run_record_id && lockStatus.run_record_id === run.id) return true;
  if (lockStatus.owner_id && runId && lockStatus.owner_id === runId) return true;
  return false;
}

function globalLockProvesActiveExecution(globalLock, run) {
  if (!globalLock?.held) return false;
  const runId = run?.stats?.run_id;
  if (globalLock.run_id && runId && globalLock.run_id === runId) return true;
  if (globalLock.run_record_id && globalLock.run_record_id === run.id) return true;
  if (globalLock.owner_id && runId && globalLock.owner_id === runId) return true;
  if (globalLock.owner_id && globalLock.owner_id === run.id) return true;
  return false;
}

async function abandonRun(supabase, run, extra = {}) {
  const stats = {
    ...(run.stats || {}),
    abandoned: true,
    abandoned_reason: ABANDON_REASON,
    failure_reason: ABANDON_REASON,
    terminal_status: "stale_abandoned",
    inventory_changed: extra.inventory_changed === true,
    ...extra
  };
  await supabase(`cruise_discovery_runs?id=eq.${encodeURIComponent(run.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "failed",
      finished_at: new Date().toISOString(),
      stats,
      error_message: ABANDON_REASON
    })
  });
  return { id: run.id, status: "failed", reason: ABANDON_REASON };
}

async function removeExpiredLockRow(supabase, lockKey) {
  if (!lockKey) return false;
  const status = await loadMaintenanceLockStatus(supabase, lockKey).catch(() => ({ held: false }));
  if (status.held) return false;
  if (!status.expired && !status.expires_at) return false;
  await supabase(`${LOCK_TABLE}?lock_key=eq.${encodeURIComponent(lockKey)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" }
  }).catch(() => null);
  return true;
}

async function reconcileAbandonedMaintenanceRuns(supabase, {
  lineSlug,
  runType,
  cruiseLineId = null,
  minAgeMs = STALE_RUNNING_MIN_AGE_MS,
  now = Date.now()
} = {}) {
  if (!supabase || !runType) return { abandoned: [], skipped: [], lock_removed: false };

  const lockKey = lineSlug ? weeklyLockKey(lineSlug) : dailyExpiryLockKey();
  const lockStatus = await loadMaintenanceLockStatus(supabase, lockKey).catch(() => ({
    held: false,
    expired: true
  }));
  const globalLock = await loadGlobalCruiseWriteLockStatus(supabase).catch(() => ({ held: false }));

  const running = await loadRunningRuns(supabase, {
    cruiseLineId,
    scope: lineSlug ? "cruise_line" : "full"
  });

  const abandoned = [];
  const skipped = [];

  for (const run of running) {
    if (run.stats?.run_type !== runType) continue;
    const ageMs = now - new Date(run.started_at).getTime();
    const thisLockValid = lockMatchesRun(lockStatus, run);
    const globalProvesLive = globalLockProvesActiveExecution(globalLock, run);

    if (thisLockValid) {
      skipped.push({ id: run.id, reason: "valid_running_lock" });
      continue;
    }
    if (globalProvesLive) {
      skipped.push({ id: run.id, reason: "global_write_lock_proves_active_execution" });
      continue;
    }
    if (!Number.isFinite(ageMs) || ageMs < minAgeMs) {
      skipped.push({ id: run.id, reason: "below_age_threshold", age_ms: ageMs });
      continue;
    }

    abandoned.push(
      await abandonRun(supabase, run, {
        stale_age_ms: ageMs,
        lock_key: lockKey,
        dispatch_period_lease_ignored: true,
        global_lock_key: GLOBAL_CRUISE_WRITE_LOCK_KEY
      })
    );
  }

  const lockRemoved =
    lockStatus.held !== true && lockStatus.expired === true
      ? await removeExpiredLockRow(supabase, lockKey)
      : false;

  return {
    abandoned,
    skipped,
    lock_removed: lockRemoved === true,
    lock_status: lockStatus,
    reason: ABANDON_REASON
  };
}

async function reconcileAllAbandonedMaintenanceRuns(supabase, { lines = [], minAgeMs = STALE_RUNNING_MIN_AGE_MS } = {}) {
  const results = [];
  for (const line of lines) {
    if (!line?.slug || !line?.runType) continue;
    results.push({
      slug: line.slug,
      ...(await reconcileAbandonedMaintenanceRuns(supabase, {
        lineSlug: line.slug,
        runType: line.runType,
        cruiseLineId: line.cruiseLineId || line.id || null,
        minAgeMs
      }).catch((error) => ({
        abandoned: [],
        skipped: [],
        error: error.message || String(error)
      })))
    });
  }
  results.push({
    slug: "daily-expiry",
    ...(await reconcileAbandonedMaintenanceRuns(supabase, {
      lineSlug: null,
      runType: "daily_expiry_maintenance",
      minAgeMs
    }).catch((error) => ({ abandoned: [], skipped: [], error: error.message || String(error) })))
  });
  return {
    abandoned: results.flatMap((r) => (r.abandoned || []).map((row) => ({ ...row, slug: r.slug }))),
    results
  };
}

module.exports = {
  STALE_RUNNING_MIN_AGE_MS,
  ABANDON_REASON,
  lockMatchesRun,
  globalLockProvesActiveExecution,
  reconcileAbandonedMaintenanceRuns,
  reconcileAllAbandonedMaintenanceRuns,
  removeExpiredLockRow
};
