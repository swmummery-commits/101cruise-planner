/**
 * Shared helpers for scheduled maintenance cron handlers.
 */

const { supabase } = require("./cruise-discovery-runner");
const {
  createMaintenanceRun,
  finalizeMaintenanceRun,
  buildMaintenanceRunStats
} = require("./cruise-discovery-maintenance-tracking");
const {
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock,
  dailyExpiryLockKey
} = require("./cruise-discovery-maintenance-locks");
const { withGlobalCruiseWriteLock } = require("./cruise-discovery-global-write-lock");
const { persistMaintenanceManifest } = require("./cruise-discovery-maintenance-manifests");

function cronSecret() {
  return String(process.env.DISCOVERY_CRON_SECRET || "").trim();
}

function siteBaseUrl() {
  return String(process.env.URL || process.env.DEPLOY_PRIME_URL || "").trim().replace(/\/$/, "");
}

function assertCronAuth(event) {
  const expected = cronSecret();
  if (!expected) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.statusCode = 503;
    throw err;
  }
  const provided = String(
    event.headers?.["x-discovery-cron-secret"] || event.headers?.["X-Discovery-Cron-Secret"] || ""
  ).trim();
  if (provided !== expected) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

async function executeWeeklyMaintenance({
  lineSlug,
  cruiseLineId,
  runType,
  assertEnabled,
  runMaintenance,
  dryRun = false,
  maxWrites = 100,
  triggerType = "scheduled",
  supabaseClient = null,
  statsEnricher = null
}) {
  const started = Date.now();
  const runId = `${lineSlug}-weekly-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const sb = supabaseClient || supabase;

  if (!dryRun) assertEnabled();

  const dbRun = await createMaintenanceRun(sb, {
    cruiseLineId,
    runId,
    runType,
    triggerType,
    stats: { line_slug: lineSlug }
  });

  try {
    const result = await runMaintenance({
      dryRun,
      performWrites: !dryRun,
      maxWrites,
      runId,
      runRecordId: dbRun?.id || null,
      supabase: sb,
      triggerType
    });

    const summary = result.summary || {};
    summary.duration_ms = Date.now() - started;
    summary.failure_reason = result.reason || null;
    summary.worker_state = result.worker_state || (result.blocked ? "already_running" : "idle");
    summary.dry_run = dryRun === true;

    const baseExtra = {
      run_type: runType,
      run_id: runId,
      trigger_type: triggerType,
      worker_state: summary.worker_state,
      blocked: result.blocked === true,
      rollback_manifest_id: summary.rollback_manifest_id || null
    };
    const stats = buildMaintenanceRunStats(
      summary,
      statsEnricher ? statsEnricher(summary, baseExtra) : baseExtra
    );

    if (result.blocked && result.reason === "maintenance_lock_held") {
      await finalizeMaintenanceRun(sb, dbRun?.id, {
        status: "completed",
        stats: {
          ...stats,
          inventory_changed: false,
          blocked_by_lock: true,
          failure_reason: null
        },
        errorMessage: null
      });
      return {
        success: true,
        blocked: true,
        already_running: true,
        run_id: runId,
        run_record_id: dbRun?.id,
        reason: result.reason,
        summary
      };
    }

    if (!result.ok) {
      await finalizeMaintenanceRun(sb, dbRun?.id, {
        status: "failed",
        stats: { ...stats, inventory_changed: false },
        errorMessage: result.reason || "weekly_maintenance_failed"
      });
      return {
        success: false,
        run_id: runId,
        run_record_id: dbRun?.id,
        reason: result.reason,
        blocked: result.blocked,
        summary
      };
    }

    if (dryRun && summary) {
      await persistMaintenanceManifest(sb, {
        manifestType: "dry_run",
        manifest: {
          run_id: runId,
          run_record_id: dbRun?.id,
          cruise_line_slug: lineSlug,
          trigger_type: triggerType,
          summary
        }
      }).catch(() => null);
    }

    await finalizeMaintenanceRun(sb, dbRun?.id, {
      status: "completed",
      stats,
      errorMessage: null
    });

    return {
      success: true,
      run_id: runId,
      run_record_id: dbRun?.id,
      dry_run: dryRun,
      summary,
      write_result: result.write_result || null,
      rollback_manifest: result.rollback_manifest || null,
      rollback_result: result.rollback_result || null,
      simulation: result.simulation || null,
      zero_change_apply: result.zero_change_apply === true,
      elapsed_ms: Date.now() - started
    };
  } catch (error) {
    await finalizeMaintenanceRun(sb, dbRun?.id, {
      status: "failed",
      stats: { run_type: runType, run_id: runId, trigger_type: triggerType },
      errorMessage: error.message || "weekly_maintenance_error"
    });
    throw error;
  }
}

async function executeDailyExpiry({ dryRun = false, triggerType = "scheduled" }) {
  const started = Date.now();
  const { expireSailedCruises } = require("./cruise-discovery-runner");
  const {
    assertDailyExpiryEnabled,
    perthCalendarDate,
    DAILY_EXPIRY_RUN_TYPE
  } = require("./cruise-discovery-maintenance");

  if (!dryRun) assertDailyExpiryEnabled();

  const runId = `daily-expiry-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const lockKey = dailyExpiryLockKey();
  const lock = await acquireMaintenanceDbLock(supabase, {
    lockKey,
    ownerId: runId,
    runId,
    leaseSeconds: 300
  });

  if (!lock.acquired) {
    return {
      success: true,
      blocked: true,
      already_running: true,
      reason: lock.reason || "maintenance_lock_held",
      worker_state: "already_running"
    };
  }

  const dbRun = await createMaintenanceRun(supabase, {
    cruiseLineId: null,
    runId,
    runType: DAILY_EXPIRY_RUN_TYPE,
    triggerType,
    stats: {}
  });

  try {
    if (dryRun) {
      const today = perthCalendarDate();
      const { publicBookingCutoffDate, PUBLIC_BOOKING_CUTOFF_DAYS } = require("./public-discovered-cruise-inventory");
      const cutoffDate = publicBookingCutoffDate(today);
      const rows = await supabase(
        `discovered_cruises?status=in.(active,review_required,match_required,validation_failed,ready,discovered)&departure_date=lte.${cutoffDate}&select=id,cruise_line_id,departure_date,status&limit=500`
      );
      const stats = {
        run_type: DAILY_EXPIRY_RUN_TYPE,
        run_id: runId,
        trigger_type: triggerType,
        dry_run: true,
        expired_count: (rows || []).length,
        as_of: today,
        cutoff_date: cutoffDate,
        cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
        timezone: "Australia/Perth"
      };
      await finalizeMaintenanceRun(supabase, dbRun?.id, { status: "completed", stats });
      return { success: true, dry_run: true, would_expire: (rows || []).length, rows: rows || [], stats };
    }

    const expireWrap = await withGlobalCruiseWriteLock(supabase, {
      ownerId: runId,
      runId,
      runRecordId: dbRun?.id || null,
      operation: "daily_expiry"
    }, async () => expireSailedCruises({ runId, recordMetadata: true }));

    if (!expireWrap.acquired) {
      await finalizeMaintenanceRun(supabase, dbRun?.id, {
        status: "completed",
        stats: {
          run_type: DAILY_EXPIRY_RUN_TYPE,
          run_id: runId,
          trigger_type: triggerType,
          inventory_changed: false,
          blocked_by_global_lock: true,
          global_lock: expireWrap.observability
        },
        errorMessage: null
      });
      return {
        success: true,
        blocked: true,
        already_running: true,
        reason: expireWrap.reason || "global_production_import_lock_unavailable",
        global_lock: expireWrap.observability
      };
    }

    const expire = expireWrap.result;
    const manifest = {
      run_id: runId,
      run_record_id: dbRun?.id,
      trigger_type: triggerType,
      as_of: expire.as_of,
      timezone: expire.timezone,
      expired_record_ids: expire.expired_ids || [],
      expired_count: expire.expired_count
    };
    await persistMaintenanceManifest(supabase, {
      manifestType: "rollback",
      manifest
    }).catch(() => null);

    const stats = {
      run_type: DAILY_EXPIRY_RUN_TYPE,
      run_id: runId,
      trigger_type: triggerType,
      expired_count: expire.expired_count,
      as_of: expire.as_of,
      timezone: expire.timezone,
      duration_ms: Date.now() - started,
      inventory_changed: expire.expired_count > 0,
      expired_record_ids: expire.expired_ids || []
    };
    await finalizeMaintenanceRun(supabase, dbRun?.id, { status: "completed", stats });
    return { success: true, expire, stats, elapsed_ms: Date.now() - started };
  } catch (error) {
    await finalizeMaintenanceRun(supabase, dbRun?.id, {
      status: "failed",
      stats: { run_type: DAILY_EXPIRY_RUN_TYPE, run_id: runId },
      errorMessage: error.message
    });
    throw error;
  } finally {
    await releaseMaintenanceDbLock(supabase, { lockKey, ownerId: runId });
  }
}

module.exports = {
  assertCronAuth,
  cronSecret,
  siteBaseUrl,
  executeWeeklyMaintenance,
  executeDailyExpiry,
  supabase
};
