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

const { loadMaintenanceLockStatus, weeklyLockKey, dailyExpiryLockKey, LOCK_TABLE } = require("./cruise-discovery-maintenance-locks");
const {
  loadGlobalCruiseWriteLockStatus,
  GLOBAL_CRUISE_WRITE_LOCK_KEY
} = require("./cruise-discovery-global-write-lock");
const { backgroundDispatchExecutionKey } = require("./weekly-maintenance-schedule-control");

const STALE_RUNNING_MIN_AGE_MS = 30 * 60 * 1000;
const ABANDON_REASON = "maintenance_worker_terminated_or_lease_expired";
const PARTIAL_WRITE_FAILURE = "partial_write_failure";
const STALE_WITH_UNACCOUNTED_WRITES = "STALE_WITH_UNACCOUNTED_WRITES";

const STALE_SWEEP_LINES = Object.freeze([
  { slug: "holland-america-line", runType: "hal_weekly_maintenance" },
  { slug: "celebrity-cruises", runType: "celebrity_weekly_maintenance" },
  { slug: "princess-cruises", runType: "princess_weekly_maintenance" },
  { slug: "explora-journeys", runType: "explora_weekly_maintenance" },
  { slug: "seabourn-cruise-line", runType: "seabourn_weekly_maintenance" },
  { slug: "royal-caribbean-international", runType: "royal_caribbean_weekly_maintenance" },
  { slug: "norwegian-cruise-line", runType: "norwegian_weekly_maintenance" },
  { slug: "carnival-cruise-line", runType: "carnival_weekly_maintenance" },
  { slug: "disney-cruise-line", runType: "disney_weekly_maintenance" },
  { slug: "azamara", runType: "azamara_weekly_maintenance" },
  { slug: "silversea-cruises", runType: "silversea_weekly_maintenance" }
]);

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

async function detectUnaccountedMaterialWrites(supabase, run) {
  const started = run?.started_at;
  const lineId = run?.cruise_line_id;
  if (!supabase || !started || !lineId) {
    return {
      classification: null,
      material_inserts: 0,
      material_updates: 0,
      accounted_in_stats: Number(run?.stats?.inserts || 0) + Number(run?.stats?.committed_material_writes || 0) > 0,
      manifest_count: 0,
      insert_ids: []
    };
  }
  const created =
    (await supabase(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(lineId)}&created_at=gte.${encodeURIComponent(started)}&select=id,official_sailing_id,created_at,last_changed_at,status`
    ).catch(() => [])) || [];
  const lastChanged =
    (await supabase(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(lineId)}&last_changed_at=gte.${encodeURIComponent(started)}&select=id,official_sailing_id,created_at,last_changed_at,status`
    ).catch(() => [])) || [];
  const manifests =
    (await supabase(
      `cruise_discovery_maintenance_manifests?run_record_id=eq.${encodeURIComponent(run.id)}&select=id`
    ).catch(() => [])) || [];
  const insertIds = created.map((row) => row.id);
  const materialUpdates = lastChanged.filter((row) => !insertIds.includes(row.id));
  const accounted =
    Number(run?.stats?.inserts || 0) > 0 ||
    Number(run?.stats?.committed_material_writes || 0) > 0 ||
    (manifests || []).length > 0;
  const unaccountedInserts = accounted ? 0 : insertIds.length;
  return {
    classification: unaccountedInserts > 0 ? STALE_WITH_UNACCOUNTED_WRITES : null,
    material_inserts: insertIds.length,
    material_updates: materialUpdates.length,
    accounted_in_stats: accounted,
    manifest_count: (manifests || []).length,
    insert_ids: insertIds
  };
}

async function abandonRun(supabase, run, extra = {}) {
  const writes = extra.unaccounted_writes || {};
  const partial = writes.classification === STALE_WITH_UNACCOUNTED_WRITES || extra.inventory_changed === true;
  const terminal = partial ? PARTIAL_WRITE_FAILURE : "stale_abandoned";
  const inserts = Number(writes.material_inserts || extra.inserts || 0);
  const stats = {
    ...(run.stats || {}),
    abandoned: true,
    abandoned_reason: ABANDON_REASON,
    failure_reason: extra.failure_reason || (partial ? "worker_terminated_after_partial_commit" : ABANDON_REASON),
    terminal_status: terminal,
    inventory_changed: partial,
    actual_writes: extra.actual_writes != null ? extra.actual_writes : inserts,
    committed_material_writes: extra.committed_material_writes != null ? extra.committed_material_writes : inserts,
    inserts: extra.inserts != null ? extra.inserts : inserts,
    failed_writes: extra.failed_writes != null ? extra.failed_writes : 0,
    unaccounted_write_classification: writes.classification || null,
    dispatch_period_lease_ignored: extra.dispatch_period_lease_ignored === true,
    ...extra
  };
  delete stats.unaccounted_writes;
  await supabase(`cruise_discovery_runs?id=eq.${encodeURIComponent(run.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "failed",
      finished_at: extra.finished_at || new Date().toISOString(),
      stats,
      error_message: stats.failure_reason
    })
  });
  return { id: run.id, status: "failed", reason: stats.failure_reason, terminal_status: terminal };
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
    const dispatchId = run.stats?.dispatch_id;
    if (dispatchId) {
      const backgroundLock = await loadMaintenanceLockStatus(
        supabase,
        backgroundDispatchExecutionKey(dispatchId)
      ).catch(() => ({ held: false }));
      if (backgroundLock.held === true && backgroundLock.expired !== true && lockMatchesRun(backgroundLock, run)) {
        skipped.push({ id: run.id, reason: "valid_background_dispatch_lock" });
        continue;
      }
    }
    if (!Number.isFinite(ageMs) || ageMs < minAgeMs) {
      skipped.push({ id: run.id, reason: "below_age_threshold", age_ms: ageMs });
      continue;
    }

    const unaccounted = await detectUnaccountedMaterialWrites(supabase, run);
    abandoned.push(
      await abandonRun(supabase, run, {
        stale_age_ms: ageMs,
        lock_key: lockKey,
        dispatch_period_lease_ignored: true,
        global_lock_key: GLOBAL_CRUISE_WRITE_LOCK_KEY,
        unaccounted_writes: unaccounted,
        inventory_changed: unaccounted.classification === STALE_WITH_UNACCOUNTED_WRITES,
        inserts: unaccounted.material_inserts,
        actual_writes: unaccounted.material_inserts,
        committed_material_writes: unaccounted.material_inserts
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

async function reconcileAllStaleCruiseMaintenanceRuns(supabase, { minAgeMs = STALE_RUNNING_MIN_AGE_MS } = {}) {
  const lineRows =
    (await supabase("ci_cruise_lines?select=id,slug").catch(() => [])) || [];
  const bySlug = Object.fromEntries(lineRows.map((row) => [row.slug, row.id]));
  return reconcileAllAbandonedMaintenanceRuns(supabase, {
    minAgeMs,
    lines: STALE_SWEEP_LINES.map((line) => ({
      ...line,
      cruiseLineId: bySlug[line.slug] || null
    }))
  });
}

module.exports = {
  STALE_RUNNING_MIN_AGE_MS,
  ABANDON_REASON,
  PARTIAL_WRITE_FAILURE,
  STALE_WITH_UNACCOUNTED_WRITES,
  STALE_SWEEP_LINES,
  lockMatchesRun,
  globalLockProvesActiveExecution,
  detectUnaccountedMaterialWrites,
  reconcileAbandonedMaintenanceRuns,
  reconcileAllAbandonedMaintenanceRuns,
  reconcileAllStaleCruiseMaintenanceRuns,
  removeExpiredLockRow
};
