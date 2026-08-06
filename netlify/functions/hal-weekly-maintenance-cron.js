/**
 * Holland America weekly inventory maintenance (Netlify Scheduled Function).
 * Schedule: Sunday 18:00 UTC = Monday 02:00 Australia/Perth
 */

const {
  assertHalWeeklyMaintenanceEnabled,
  HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  isHalWeeklyReconciliationEnabled
} = require("./lib/cruise-discovery-maintenance");
const { runHalWeeklyMaintenance } = require("./lib/cruise-discovery-maintenance-runner");
const { executeWeeklyMaintenance, supabase } = require("./lib/cruise-discovery-maintenance-cron");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    const dryRun = body.dry_run === true || !isHalWeeklyReconciliationEnabled();

    const lines = await supabase(
      "ci_cruise_lines?slug=eq.holland-america-line&select=id,name,slug&limit=1"
    );
    const line = lines?.[0];
    if (!line) {
      return { statusCode: 404, body: JSON.stringify({ success: false, error: "HAL line not found" }) };
    }

    const result = await executeWeeklyMaintenance({
      lineSlug: "holland-america-line",
      cruiseLineId: line.id,
      runType: HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
      assertEnabled: assertHalWeeklyMaintenanceEnabled,
      runMaintenance: runHalWeeklyMaintenance,
      dryRun,
      maxWrites: Number(body.max_writes || 100),
      triggerType: body.trigger_type || "scheduled"
    });

    return {
      statusCode: result.success ? 200 : 500,
      body: JSON.stringify({ ...result, elapsed_ms: Date.now() - started })
    };
  } catch (error) {
    console.error("hal-weekly-maintenance-cron failed", error);
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify({ success: false, error: error.message || "HAL weekly maintenance failed" })
    };
  }
};
