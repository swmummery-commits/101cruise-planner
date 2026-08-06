/**
 * Celebrity weekly inventory maintenance (Netlify Scheduled Function).
 * Schedule: Sunday 19:00 UTC = Monday 03:00 Australia/Perth
 */

const {
  assertCelebrityWeeklyMaintenanceEnabled,
  CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
  isCelebrityWeeklyReconciliationEnabled
} = require("./lib/cruise-discovery-maintenance");
const { runCelebrityWeeklyMaintenance } = require("./lib/cruise-discovery-maintenance-runner");
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

    const dryRun = body.dry_run === true || !isCelebrityWeeklyReconciliationEnabled();

    const lines = await supabase(
      "ci_cruise_lines?slug=eq.celebrity-cruises&select=id,name,slug&limit=1"
    );
    const line = lines?.[0];
    if (!line) {
      return { statusCode: 404, body: JSON.stringify({ success: false, error: "Celebrity line not found" }) };
    }

    const result = await executeWeeklyMaintenance({
      lineSlug: "celebrity-cruises",
      cruiseLineId: line.id,
      runType: CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
      assertEnabled: assertCelebrityWeeklyMaintenanceEnabled,
      runMaintenance: runCelebrityWeeklyMaintenance,
      dryRun,
      maxWrites: Number(body.max_writes || 100),
      triggerType: body.trigger_type || "scheduled"
    });

    return {
      statusCode: result.success ? 200 : 500,
      body: JSON.stringify({ ...result, elapsed_ms: Date.now() - started })
    };
  } catch (error) {
    console.error("celebrity-weekly-maintenance-cron failed", error);
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify({ success: false, error: error.message || "Celebrity weekly maintenance failed" })
    };
  }
};
