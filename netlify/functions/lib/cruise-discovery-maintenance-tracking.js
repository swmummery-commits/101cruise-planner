/**
 * Maintenance run persistence and Admin status loading.
 */

const {
  HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
  PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
  EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE,
  SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
  ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE,
  NORWEGIAN_WEEKLY_MAINTENANCE_RUN_TYPE,
  CARNIVAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  DISNEY_WEEKLY_MAINTENANCE_RUN_TYPE,
  AZAMARA_WEEKLY_MAINTENANCE_RUN_TYPE,
  SILVERSEA_WEEKLY_MAINTENANCE_RUN_TYPE,
  DAILY_EXPIRY_RUN_TYPE,
  MAINTENANCE_SCHEDULES,
  computeFreshnessLabel,
  resolveEnvFlag,
  describeMaintenanceHold,
  isHalWeeklyReconciliationEnabled,
  isCelebrityWeeklyReconciliationEnabled,
  isPrincessWeeklyReconciliationEnabled,
  isExploraWeeklyReconciliationEnabled,
  isSeabournWeeklyReconciliationEnabled,
  isRoyalCaribbeanWeeklyReconciliationEnabled,
  isNorwegianWeeklyReconciliationEnabled,
  isCarnivalWeeklyReconciliationEnabled,
  isDisneyMaintenanceScheduledEnabled,
  isAzamaraWeeklyReconciliationEnabled,
  isSilverseaWeeklyReconciliationEnabled,
  isCruiseDailyExpiryEnabled
} = require("./cruise-discovery-maintenance");
const { loadCelebrityDatabaseInventoryCounts, headCountSupabase } = require("./celebrity-inventory-counts");
const {
  loadMaintenanceLockStatus,
  weeklyLockKey,
  dailyExpiryLockKey
} = require("./cruise-discovery-maintenance-locks");
const { reconcileAbandonedMaintenanceRuns } = require("./weekly-maintenance-stale-runs");

const COMMISSIONED_WEEKLY_LINES = [
  {
    slug: "holland-america-line",
    label: "Holland America",
    runType: HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
    scheduleKey: "hal_weekly",
    enabled: isHalWeeklyReconciliationEnabled,
    envKey: "HAL_WEEKLY_RECONCILIATION_ENABLED",
    dashboardKey: "hal"
  },
  {
    slug: "celebrity-cruises",
    label: "Celebrity",
    runType: CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
    scheduleKey: "celebrity_weekly",
    enabled: isCelebrityWeeklyReconciliationEnabled,
    envKey: "CELEBRITY_WEEKLY_RECONCILIATION_ENABLED",
    dashboardKey: "celebrity"
  },
  {
    slug: "princess-cruises",
    label: "Princess",
    runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    scheduleKey: "princess_weekly",
    enabled: isPrincessWeeklyReconciliationEnabled,
    envKey: "PRINCESS_WEEKLY_RECONCILIATION_ENABLED",
    dashboardKey: "princess"
  },
  {
    slug: "explora-journeys",
    label: "Explora",
    runType: EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE,
    scheduleKey: "explora_weekly",
    enabled: isExploraWeeklyReconciliationEnabled,
    envKey: "EXPLORA_WEEKLY_RECONCILIATION_ENABLED",
    dashboardKey: "explora"
  },
  {
    slug: "seabourn-cruise-line",
    label: "Seabourn",
    runType: SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
    scheduleKey: "seabourn_weekly",
    enabled: isSeabournWeeklyReconciliationEnabled,
    envKey: "SEABOURN_WEEKLY_RECONCILIATION_ENABLED",
    dashboardKey: "seabourn"
  },
  {
    slug: "royal-caribbean-international",
    label: "Royal Caribbean",
    runType: ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE,
    scheduleKey: "royal_caribbean_weekly",
    enabled: isRoyalCaribbeanWeeklyReconciliationEnabled,
    envKey: "ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED",
    dashboardKey: "royal_caribbean"
  },
  {
    slug: "norwegian-cruise-line",
    label: "Norwegian",
    runType: NORWEGIAN_WEEKLY_MAINTENANCE_RUN_TYPE,
    scheduleKey: "norwegian_weekly",
    enabled: isNorwegianWeeklyReconciliationEnabled,
    envKey: "NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED",
    dashboardKey: "norwegian"
  },
  {
    slug: "carnival-cruise-line",
    label: "Carnival",
    runType: CARNIVAL_WEEKLY_MAINTENANCE_RUN_TYPE,
    scheduleKey: "carnival_weekly",
    enabled: isCarnivalWeeklyReconciliationEnabled,
    envKey: "CARNIVAL_WEEKLY_RECONCILIATION_ENABLED",
    dashboardKey: "carnival"
  },
  {
    slug: "disney-cruise-line",
    label: "Disney",
    runType: DISNEY_WEEKLY_MAINTENANCE_RUN_TYPE,
    scheduleKey: "disney_weekly",
    enabled: isDisneyMaintenanceScheduledEnabled,
    envKey: "DISNEY_DISCOVERY_MAINTENANCE_SCHEDULED_ENABLED",
    dashboardKey: "disney"
  },
  {
    slug: "azamara",
    label: "Azamara",
    runType: AZAMARA_WEEKLY_MAINTENANCE_RUN_TYPE,
    scheduleKey: "azamara_weekly",
    enabled: isAzamaraWeeklyReconciliationEnabled,
    envKey: "AZAMARA_WEEKLY_RECONCILIATION_ENABLED",
    dashboardKey: "azamara"
  },
  {
    slug: "silversea-cruises",
    label: "Silversea",
    runType: SILVERSEA_WEEKLY_MAINTENANCE_RUN_TYPE,
    scheduleKey: "silversea_weekly",
    enabled: isSilverseaWeeklyReconciliationEnabled,
    envKey: "SILVERSEA_WEEKLY_RECONCILIATION_ENABLED",
    dashboardKey: "silversea"
  }
];

function isGenuineSuccessfulRefresh(run) {
  if (!run || run.status !== "completed") return false;
  const s = run.stats || {};
  if (s.dry_run === true) return false;
  if (s.blocked_by_lock === true) return false;
  if (s.review_required === true) return false;
  if (s.blocked_by_global_lock === true) return false;
  if (s.already_dispatched === true) return false;
  return true;
}

function countSameSlotDuplicates(runs = []) {
  const buckets = new Map();
  for (const run of runs) {
    const started = run.started_at || run.created_at;
    if (!started) continue;
    const hour = String(started).slice(0, 13);
    buckets.set(hour, (buckets.get(hour) || 0) + 1);
  }
  return [...buckets.values()].some((n) => n > 1);
}

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

/**
 * Genuine unrecovered write failures keep status `failed` even when some inserts committed.
 * Metrics (inserts, failed_writes, recovered_after_fetch_failure) carry partial-batch detail.
 */
function resolveMaintenanceRunStatus({ ok, summary = {} }) {
  const failed = Number(summary.failed_writes) || 0;
  if (failed > 0) return "failed";
  if (ok) return "completed";
  return "failed";
}

function buildMaintenanceRunStats(summary, extra = {}) {
  return {
    run_type: summary.run_type,
    run_id: summary.run_id,
    trigger_type: summary.trigger_type || "scheduled",
    source_snapshot_id: summary.source_snapshot_id || summary.snapshot_id || null,
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
    recovered_after_fetch_failure: summary.recovered_after_fetch_failure ?? 0,
    write_attempts: summary.write_attempts ?? null,
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
  await reconcileAbandonedMaintenanceRuns(supabase, {
    lineSlug,
    runType,
    cruiseLineId
  }).catch(() => null);

  const runs = await loadLineMaintenanceRuns(supabase, cruiseLineId, runType);
  const lastAttempt = runs[0] || null;
  const lastSuccess = runs.find(isGenuineSuccessfulRefresh) || null;
  const lastFailed = runs.find((r) => r.status === "failed") || null;
  const lastReview = runs.find((r) => r.status === "completed" && r.stats?.review_required === true) || null;
  const inventory = await loadLineActiveInventory(supabase, cruiseLineId, lineSlug);
  const spec = COMMISSIONED_WEEKLY_LINES.find((l) => l.slug === lineSlug);
  const enabled = spec ? spec.enabled() === true : false;
  const envKey = spec?.envKey || null;

  const schedule = MAINTENANCE_SCHEDULES[scheduleKey];
  const lockStatus = await loadMaintenanceLockStatus(supabase, weeklyLockKey(lineSlug)).catch(() => ({
    held: false,
    worker_state: "idle"
  }));

  let workerState = "idle";
  if (lockStatus.held) workerState = "already_running";
  else if (lastAttempt?.stats?.blocked_by_lock) workerState = "already_running";
  else if (lastAttempt?.status === "running") workerState = "running";
  else if (lastAttempt?.stats?.abandoned) workerState = "stale_abandoned";

  let freshness = "Stale";
  if (!enabled) freshness = "Disabled";
  else if (lastAttempt?.status === "running" || lockStatus.held) freshness = "Running";
  else if (lastReview && (!lastSuccess || new Date(lastReview.finished_at) > new Date(lastSuccess.finished_at))) {
    freshness = "Review Required";
  } else if (lastFailed && (!lastSuccess || new Date(lastFailed.finished_at) > new Date(lastSuccess.finished_at))) {
    freshness = "Failed";
  } else if (lastSuccess?.finished_at) {
    freshness = computeFreshnessLabel(lastSuccess.finished_at) === "Stale" ? "Stale" : "Healthy";
  }

  const latest = lastAttempt?.stats || {};
  const duplicateScheduled = countSameSlotDuplicates(runs.slice(0, 8));
  const provenance = latest.invocation_provenance || {
    netlify_site_id: latest.netlify_site_id || null,
    deploy_id: latest.deploy_id || null,
    commit_ref: latest.commit_ref || null,
    context: latest.context || null,
    function_name: latest.function_name || null,
    dispatch_id: latest.dispatch_id || null
  };

  const overdue = enabled && !["Healthy", "Running", "Review Required"].includes(freshness);

  return {
    cruise_line_slug: lineSlug,
    label: spec?.label || lineSlug,
    automation_status: enabled ? "enabled" : "disabled",
    automation_flag: resolveEnvFlag(envKey ? process.env[envKey] : undefined),
    refresh_cadence: schedule?.perth_display || null,
    cron_utc: schedule?.cron_utc || null,
    perth_schedule: schedule?.perth_display || null,
    utc_schedule: schedule?.utc_display || null,
    next_scheduled_refresh: schedule?.cron_utc || null,
    last_attempted_refresh: lastAttempt?.started_at || null,
    last_successful_refresh: lastSuccess?.finished_at || null,
    last_failure: lastFailed?.finished_at || lastFailed?.started_at || null,
    last_failure_reason: lastFailed?.error_message || lastAttempt?.stats?.failure_reason || null,
    freshness_status: freshness,
    source_status: lastSuccess ? "ok" : lastFailed ? "failed" : lastReview ? "review_required" : "unknown",
    official_eligible_inventory: latest.eligible_total ?? lastSuccess?.stats?.eligible_total ?? null,
    active_production_inventory: inventory?.active ?? null,
    ocean_active: inventory?.ocean_active ?? null,
    river_active: inventory?.river_active ?? null,
    newly_added_last_run: lastSuccess?.stats?.inserts ?? latest.inserts ?? 0,
    updated_last_run: lastSuccess?.stats?.updates ?? latest.updates ?? 0,
    proposed_inserts_last_run: latest.proposed_inserts ?? 0,
    proposed_updates_last_run: latest.proposed_updates ?? 0,
    review_candidates_last_run:
      latest.proposed_updates_identity_review ?? latest.review_candidates ?? (latest.review_required ? 1 : 0),
    unchanged_last_run: lastSuccess?.stats?.unchanged ?? latest.unchanged ?? 0,
    source_absent_active: latest.source_absent_active ?? lastSuccess?.stats?.source_absent_active ?? null,
    source_absent_sailing_ids: latest.source_absent_sailing_ids || lastSuccess?.stats?.source_absent_sailing_ids || [],
    skipped_cruisetours: lastSuccess?.stats?.cruisetours_skipped ?? 0,
    failed_records: latest.failed_writes ?? lastSuccess?.stats?.failed_writes ?? 0,
    run_duration_ms: lastSuccess?.stats?.duration_ms ?? latest.duration_ms ?? null,
    worker_state: workerState,
    lock_held: lockStatus.held === true,
    lock_expires_at: lockStatus.expires_at || null,
    blocked_by_lock_last_attempt: lastAttempt?.stats?.blocked_by_lock === true,
    review_required_last_attempt: lastAttempt?.stats?.review_required === true,
    dry_run_last_attempt: lastAttempt?.stats?.dry_run === true,
    inventory_changed_on_last_attempt: lastAttempt?.stats?.inventory_changed === true,
    duplicate_scheduled_invocation: duplicateScheduled,
    invocation_provenance: provenance,
    overdue_successful_refresh: overdue,
    warning:
      freshness === "Failed" && lastFailed
        ? `${spec?.label || lineSlug} weekly refresh failed on ${new Date(lastFailed.finished_at || lastFailed.started_at).toLocaleDateString("en-AU", { timeZone: "Australia/Perth" })}. Existing inventory remains unchanged. Review the source error before the next scheduled run.`
        : freshness === "Review Required"
          ? `${spec?.label || lineSlug} requires review — no production writes were performed.`
          : duplicateScheduled
            ? `${spec?.label || lineSlug} has duplicate scheduled invocations in the same slot.`
            : null
  };
}

async function loadDailyExpiryStatus(supabase) {
  const runs = await supabase(
    `cruise_discovery_runs?scope=eq.full&select=id,status,stats,started_at,finished_at,error_message&order=created_at.desc&limit=20`
  );
  const expiryRuns = (runs || []).filter((r) => r.stats?.run_type === DAILY_EXPIRY_RUN_TYPE);
  const lastAttempt = expiryRuns[0] || null;
  const lastSuccess = expiryRuns.find((r) => r.status === "completed" && r.stats?.dry_run !== true && r.stats?.already_dispatched !== true) || null;
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
    last_attempted_run: lastAttempt?.started_at || null,
    cruises_expired_last_run: lastSuccess?.stats?.expired_count ?? 0,
    last_failure_reason: lastFailed?.error_message || null,
    worker_state: workerState,
    lock_held: lockStatus.held === true,
    lock_expires_at: lockStatus.expires_at || null,
    duplicate_scheduled_invocation: countSameSlotDuplicates(expiryRuns.slice(0, 8)),
    warning:
      lastFailed && (!lastSuccess || new Date(lastFailed.finished_at) > new Date(lastSuccess.finished_at))
        ? `Daily expiry failed on ${new Date(lastFailed.finished_at || lastFailed.started_at).toLocaleDateString("en-AU", { timeZone: "Australia/Perth" })}. Existing inventory remains unchanged.`
        : null
  };
}

async function loadMaintenanceDashboard(supabase, lines = []) {
  const dashboard = {};
  const overdue = [];
  for (const spec of COMMISSIONED_WEEKLY_LINES) {
    const line = lines.find((l) => l.slug === spec.slug);
    const status =
      line?.id &&
      (await loadWeeklyMaintenanceStatus(supabase, line.id, spec.slug, spec.runType, spec.scheduleKey));
    dashboard[spec.dashboardKey] = status || null;
    if (status?.overdue_successful_refresh) overdue.push(spec.label);
  }
  const dailyExpiry = await loadDailyExpiryStatus(supabase);
  dashboard.daily_expiry = dailyExpiry;
  dashboard.lines = COMMISSIONED_WEEKLY_LINES.map((spec) => dashboard[spec.dashboardKey]).filter(Boolean);
  dashboard.overdue_lines = overdue;
  dashboard.top_level_warning =
    overdue.length > 0
      ? `Commissioned weekly lines without a successful scheduled production refresh in cadence: ${overdue.join(", ")}.`
      : null;
  dashboard.flag_hold = describeMaintenanceHold();
  return dashboard;
}

module.exports = {
  createMaintenanceRun,
  finalizeMaintenanceRun,
  buildMaintenanceRunStats,
  resolveMaintenanceRunStatus,
  loadWeeklyMaintenanceStatus,
  loadDailyExpiryStatus,
  loadMaintenanceDashboard,
  isGenuineSuccessfulRefresh,
  COMMISSIONED_WEEKLY_LINES,
  HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
  PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
  DAILY_EXPIRY_RUN_TYPE
};
