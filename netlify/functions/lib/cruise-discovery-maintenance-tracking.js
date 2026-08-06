/**
 * Maintenance run persistence and Admin status loading.
 */

const {
  HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
  DAILY_EXPIRY_RUN_TYPE,
  MAINTENANCE_SCHEDULES,
  computeFreshnessLabel,
  resolveEnvFlag,
  describeMaintenanceHold,
  isHalWeeklyReconciliationEnabled,
  isCelebrityWeeklyReconciliationEnabled,
  isCruiseDailyExpiryEnabled
} = require("./cruise-discovery-maintenance");
const { loadCelebrityDatabaseInventoryCounts, headCountSupabase } = require("./celebrity-inventory-counts");
const {
  loadMaintenanceLockStatus,
  weeklyLockKey,
  dailyExpiryLockKey
} = require("./cruise-discovery-maintenance-locks");

async function createMaintenanceRun(supabase, { cruiseLineId, runId, runType, triggerType = "scheduled", stats = {} }) {
  const insert = await supabase("cruise_discovery_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      scope: cruiseLineId ? "cruise_line" : "full",
      cruise_line_id: cruiseLineId || null,
      destination_id: null,
      status: "running",
      started_at: new Date().toISOString(),
      stats: {
        run_type: runType,
        run_id: runId,
        trigger_type: triggerType,
        ...stats
      }
    })
  });
  return insert?.[0] || null;
}

async function finalizeMaintenanceRun(supabase, runRecordId, { status, stats, errorMessage = null }) {
  if (!runRecordId) return null;
  await supabase(`cruise_discovery_runs?id=eq.${encodeURIComponent(runRecordId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status,
      finished_at: new Date().toISOString(),
      stats,
      error_message: errorMessage || null
    })
  });
  return { id: runRecordId, status, stats };
}

function buildMaintenanceRunStats(summary, extra = {}) {
  return {
    run_type: summary.run_type,
    run_id: summary.run_id,
    trigger_type: summary.trigger_type || "scheduled",
    source_snapshot_id: summary.snapshot_id || null,
    official_source_total: summary.official_source_total ?? null,
    eligible_total: summary.eligible_total ?? null,
    active_production_total: summary.active_production_total ?? null,
    inserts: summary.inserts ?? 0,
    updates: summary.updates ?? 0,
    unchanged: summary.unchanged ?? 0,
    duplicate_skips: summary.duplicate_skips ?? 0,
    source_absent_active: summary.source_absent_active ?? 0,
    source_absent_sailing_ids: summary.source_absent_sailing_ids || [],
    cruisetours_skipped: summary.cruisetours_excluded ?? 0,
    incomplete_skipped: summary.incomplete_skipped ?? 0,
    failed_writes: summary.failed_writes ?? 0,
    proposed_inserts: summary.proposed_inserts ?? 0,
    proposed_updates: summary.proposed_updates ?? 0,
    quality_gate: summary.quality_gate || null,
    dry_run: summary.dry_run === true,
    inventory_changed: summary.inventory_changed === true,
    resolution_rates: summary.resolution_rates || null,
    ...extra
  };
}

async function loadLineActiveInventory(supabase, cruiseLineId, lineSlug) {
  if (lineSlug === "celebrity-cruises") {
    return loadCelebrityDatabaseInventoryCounts(supabase, cruiseLineId);
  }
  const enc = encodeURIComponent(cruiseLineId);
  const active = await headCountSupabase(supabase, "discovered_cruises", `cruise_line_id=eq.${enc}&status=eq.active`);
  return { active, ocean_active: null, river_active: null };
}

async function loadLineMaintenanceRuns(supabase, cruiseLineId, runType, limit = 10) {
  const runs = await supabase(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&scope=eq.cruise_line&select=id,status,stats,started_at,finished_at,error_message&order=created_at.desc&limit=${limit}`
  );
  return (runs || []).filter((r) => r.stats?.run_type === runType);
}

async function loadWeeklyMaintenanceStatus(supabase, cruiseLineId, lineSlug, runType, scheduleKey) {
  const runs = await loadLineMaintenanceRuns(supabase, cruiseLineId, runType);
  const lastAttempt = runs[0] || null;
  const lastSuccess = runs.find((r) => r.status === "completed" && !r.stats?.dry_run) || null;
  const lastFailed = runs.find((r) => r.status === "failed") || null;
  const inventory = await loadLineActiveInventory(supabase, cruiseLineId, lineSlug);

  const enabled =
    lineSlug === "holland-america-line"
      ? isHalWeeklyReconciliationEnabled()
      : isCelebrityWeeklyReconciliationEnabled();

  let freshness = "Stale";
  if (lastFailed && (!lastSuccess || new Date(lastFailed.finished_at) > new Date(lastSuccess.finished_at))) {
    freshness = "Failed";
  } else if (lastSuccess?.finished_at) {
    freshness = computeFreshnessLabel(lastSuccess.finished_at);
  }

  const schedule = MAINTENANCE_SCHEDULES[scheduleKey];
  const lockStatus = await loadMaintenanceLockStatus(supabase, weeklyLockKey(lineSlug)).catch(() => ({
    held: false,
    worker_state: "idle"
  }));

  let workerState = "idle";
  if (lockStatus.held) workerState = "already_running";
  else if (lastAttempt?.stats?.blocked_by_lock) workerState = "already_running";
  else if (lastAttempt?.status === "running") workerState = "running";

  return {
    cruise_line_slug: lineSlug,
    automation_status: enabled ? "enabled" : "disabled",
    automation_flag: resolveEnvFlag(
      lineSlug === "holland-america-line"
        ? process.env.HAL_WEEKLY_RECONCILIATION_ENABLED
        : process.env.CELEBRITY_WEEKLY_RECONCILIATION_ENABLED
    ),
    refresh_cadence: schedule?.perth_display || null,
    cron_utc: schedule?.cron_utc || null,
    perth_schedule: schedule?.perth_display || null,
    utc_schedule: schedule?.utc_display || null,
    next_scheduled_refresh: schedule?.cron_utc || null,
    last_attempted_refresh: lastAttempt?.started_at || null,
    last_successful_refresh: lastSuccess?.finished_at || null,
    last_failure_reason: lastFailed?.error_message || lastAttempt?.stats?.failure_reason || null,
    freshness_status: freshness,
    source_status: lastSuccess ? "ok" : lastFailed ? "failed" : "unknown",
    official_eligible_inventory: lastSuccess?.stats?.eligible_total ?? lastAttempt?.stats?.eligible_total ?? null,
    active_production_inventory: inventory?.active ?? null,
    ocean_active: inventory?.ocean_active ?? null,
    river_active: inventory?.river_active ?? null,
    newly_added_last_run: lastSuccess?.stats?.inserts ?? 0,
    updated_last_run: lastSuccess?.stats?.updates ?? 0,
    unchanged_last_run: lastSuccess?.stats?.unchanged ?? 0,
    source_absent_active: lastSuccess?.stats?.source_absent_active ?? lastAttempt?.stats?.source_absent_active ?? null,
    source_absent_sailing_ids: lastSuccess?.stats?.source_absent_sailing_ids || [],
    skipped_cruisetours: lastSuccess?.stats?.cruisetours_skipped ?? 0,
    failed_records: lastSuccess?.stats?.failed_writes ?? 0,
    run_duration_ms: lastSuccess?.stats?.duration_ms ?? null,
    worker_state: workerState,
    lock_held: lockStatus.held === true,
    lock_expires_at: lockStatus.expires_at || null,
    blocked_by_lock_last_attempt: lastAttempt?.stats?.blocked_by_lock === true,
    inventory_changed_on_last_attempt: lastAttempt?.stats?.inventory_changed === true,
    warning:
      freshness === "Failed" && lastFailed
        ? `${lineSlug === "celebrity-cruises" ? "Celebrity" : "Holland America"} weekly refresh failed on ${new Date(lastFailed.finished_at || lastFailed.started_at).toLocaleDateString("en-AU", { timeZone: "Australia/Perth" })}. Existing inventory remains unchanged. Review the source error before the next scheduled run.`
        : null
  };
}

async function loadDailyExpiryStatus(supabase) {
  const runs = await supabase(
    `cruise_discovery_runs?scope=eq.full&select=id,status,stats,started_at,finished_at,error_message&order=created_at.desc&limit=20`
  );
  const expiryRuns = (runs || []).filter((r) => r.stats?.run_type === DAILY_EXPIRY_RUN_TYPE);
  const lastAttempt = expiryRuns[0] || null;
  const lastSuccess = expiryRuns.find((r) => r.status === "completed") || null;
  const lastFailed = expiryRuns.find((r) => r.status === "failed") || null;
  const schedule = MAINTENANCE_SCHEDULES.daily_expiry;
  const lockStatus = await loadMaintenanceLockStatus(supabase, dailyExpiryLockKey()).catch(() => ({
    held: false,
    worker_state: "idle"
  }));

  let workerState = "idle";
  if (lockStatus.held) workerState = "already_running";
  else if (lastAttempt?.status === "running") workerState = "running";

  return {
    automation_status: isCruiseDailyExpiryEnabled() ? "enabled" : "disabled",
    automation_flag: resolveEnvFlag(process.env.CRUISE_DAILY_EXPIRY_ENABLED),
    perth_schedule: schedule.perth_display,
    utc_schedule: schedule.utc_display,
    cron_utc: schedule.cron_utc,
    last_successful_run: lastSuccess?.finished_at || null,
    cruises_expired_last_run: lastSuccess?.stats?.expired_count ?? 0,
    last_failure_reason: lastFailed?.error_message || null,
    worker_state: workerState,
    lock_held: lockStatus.held === true,
    lock_expires_at: lockStatus.expires_at || null,
    warning:
      lastFailed && (!lastSuccess || new Date(lastFailed.finished_at) > new Date(lastSuccess.finished_at))
        ? `Daily expiry failed on ${new Date(lastFailed.finished_at || lastFailed.started_at).toLocaleDateString("en-AU", { timeZone: "Australia/Perth" })}. Existing inventory remains unchanged.`
        : null
  };
}

async function loadMaintenanceDashboard(supabase, lines = []) {
  const halLine = lines.find((l) => l.slug === "holland-america-line");
  const celebrityLine = lines.find((l) => l.slug === "celebrity-cruises");
  const hal =
    halLine?.id &&
    (await loadWeeklyMaintenanceStatus(
      supabase,
      halLine.id,
      "holland-america-line",
      HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
      "hal_weekly"
    ));
  const celebrity =
    celebrityLine?.id &&
    (await loadWeeklyMaintenanceStatus(
      supabase,
      celebrityLine.id,
      "celebrity-cruises",
      CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
      "celebrity_weekly"
    ));
  const dailyExpiry = await loadDailyExpiryStatus(supabase);
  return {
    hal,
    celebrity,
    daily_expiry: dailyExpiry,
    flag_hold: describeMaintenanceHold()
  };
}

module.exports = {
  createMaintenanceRun,
  finalizeMaintenanceRun,
  buildMaintenanceRunStats,
  loadWeeklyMaintenanceStatus,
  loadDailyExpiryStatus,
  loadMaintenanceDashboard,
  HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
  DAILY_EXPIRY_RUN_TYPE
};
