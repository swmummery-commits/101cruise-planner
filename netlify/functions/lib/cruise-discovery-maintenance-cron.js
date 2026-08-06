/**
 * Shared helpers for scheduled maintenance cron handlers.
 */

const { supabase } = require("./cruise-discovery-runner");
const {
  createMaintenanceRun,
  finalizeMaintenanceRun,
  buildMaintenanceRunStats
} = require("./cruise-discovery-maintenance-tracking");

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
  supabaseClient = null
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
      supabase: sb,
      triggerType
    });

    const summary = result.summary || {};
    summary.duration_ms = Date.now() - started;
    summary.failure_reason = result.reason || null;

    const stats = buildMaintenanceRunStats(summary, {
      run_type: runType,
      run_id: runId,
      trigger_type: triggerType
    });

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
      const rows = await supabase(
        `discovered_cruises?status=in.(active,review_required,match_required,validation_failed,ready,discovered)&departure_date=lt.${today}&select=id,cruise_line_id,departure_date,status&limit=500`
      );
      const stats = {
        run_type: DAILY_EXPIRY_RUN_TYPE,
        run_id: runId,
        trigger_type: triggerType,
        dry_run: true,
        expired_count: (rows || []).length,
        as_of: today,
        timezone: "Australia/Perth"
      };
      await finalizeMaintenanceRun(supabase, dbRun?.id, { status: "completed", stats });
      return { success: true, dry_run: true, would_expire: (rows || []).length, rows: rows || [], stats };
    }

    const expire = await expireSailedCruises({ runId, recordMetadata: true });
    const stats = {
      run_type: DAILY_EXPIRY_RUN_TYPE,
      run_id: runId,
      trigger_type: triggerType,
      expired_count: expire.expired_count,
      as_of: expire.as_of,
      timezone: expire.timezone,
      duration_ms: Date.now() - started,
      inventory_changed: expire.expired_count > 0
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
