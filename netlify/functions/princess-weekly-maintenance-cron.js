/**
 * Princess Cruises weekly inventory maintenance (Netlify Scheduled Function).
 * Schedule: Sunday 20:00 UTC = Monday 04:00 Australia/Perth
 */

const {
  assertPrincessWeeklyMaintenanceEnabled,
  PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
  isPrincessWeeklyReconciliationEnabled
} = require("./lib/cruise-discovery-maintenance");
const { runPrincessWeeklyMaintenance } = require("./lib/cruise-discovery-maintenance-runner");
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

    const dryRun = body.dry_run === true || !isPrincessWeeklyReconciliationEnabled();

    const lines = await supabase(
      "ci_cruise_lines?slug=eq.princess-cruises&select=id,name,slug&limit=1"
    );
    const line = lines?.[0];
    if (!line) {
      return { statusCode: 404, body: JSON.stringify({ success: false, error: "Princess line not found" }) };
    }

    const result = await executeWeeklyMaintenance({
      lineSlug: "princess-cruises",
      cruiseLineId: line.id,
      runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
      assertEnabled: assertPrincessWeeklyMaintenanceEnabled,
      runMaintenance: runPrincessWeeklyMaintenance,
      dryRun,
      maxWrites: Number(body.max_writes || 100),
      triggerType: body.trigger_type || "scheduled"
    });

    return {
      statusCode: result.success ? 200 : 500,
      body: JSON.stringify({ ...result, elapsed_ms: Date.now() - started })
    };
  } catch (error) {
    console.error("princess-weekly-maintenance-cron failed", error);
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify({ success: false, error: error.message || "Princess weekly maintenance failed" })
    };
  }
};
