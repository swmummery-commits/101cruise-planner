/**
 * Reconcile abandoned weekly-maintenance runs whose line lock has expired.
 * Control-plane only — never invents successful completion.
 */

const {
  loadMaintenanceLockStatus,
  weeklyLockKey,
  dailyExpiryLockKey,
  LOCK_TABLE
} = require("./cruise-discovery-maintenance-locks");

const STALE_RUNNING_MIN_AGE_MS = 30 * 60 * 1000;
const ABANDON_REASON = "maintenance_worker_terminated_or_lease_expired";

async function loadRunningRuns(supabase, { cruiseLineId = null, scope = "cruise_line", limit = 20 } = {}) {
  const scopeFilter = scope === "full" ? "scope=eq.full" : "scope=eq.cruise_line";
  const lineFilter = cruiseLineId
    ? `&cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}`
    : "";
  return (
    (await supabase(
      `cruise_discovery_runs?${scopeFilter}${lineFilter}&status=eq.running&select=id,status,stats,started_at,finished_at,error_message&order=started_at.asc&limit=${limit}`
    ).catch(() => [])) || []
  );
}

function lockMatchesRun(lockStatus, run) {
  if (!lockStatus?.held) return false;
  const runId = run?.stats?.run_id;
  if (lockStatus.run_id && runId && lockStatus.run_id === runId) return true;
  if (lockStatus.run_record_id && lockStatus.run_record_id === run.id) return true;
  return false;
}

async function abandonRun(supabase, run, extra = {}) {
  const stats = {
    ...(run.stats || {}),
    abandoned: true,
    abandoned_reason: ABANDON_REASON,
    failure_reason: ABANDON_REASON,
    inventory_changed: false,
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

  const running = await loadRunningRuns(supabase, {
    cruiseLineId,
    scope: lineSlug ? "cruise_line" : "full"
  });

  const abandoned = [];
  const skipped = [];

  for (const run of running) {
    if (run.stats?.run_type !== runType) continue;
    const ageMs = now - new Date(run.started_at).getTime();
    const lockExpired = lockStatus.held !== true;
    const thisLockValid = lockMatchesRun(lockStatus, run);

    if (thisLockValid) {
      skipped.push({ id: run.id, reason: "valid_running_lock" });
      continue;
    }
    if (!lockExpired) {
      skipped.push({ id: run.id, reason: "line_lock_still_held_by_other_owner" });
      continue;
    }
    if (!Number.isFinite(ageMs) || ageMs < minAgeMs) {
      skipped.push({ id: run.id, reason: "below_age_threshold", age_ms: ageMs });
      continue;
    }

    abandoned.push(await abandonRun(supabase, run, { stale_age_ms: ageMs, lock_key: lockKey }));
  }

  const lockRemoved = lockStatus.held !== true && lockStatus.expired === true
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

module.exports = {
  STALE_RUNNING_MIN_AGE_MS,
  ABANDON_REASON,
  lockMatchesRun,
  reconcileAbandonedMaintenanceRuns,
  removeExpiredLockRow
};
