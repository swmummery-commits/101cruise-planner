/**
 * Explora Journeys weekly inventory maintenance (Netlify function).
 *
 * NOT SCHEDULED. This handler is deliberately absent from netlify.toml [[scheduled.functions]]
 * while Explora is onboarding. Documented target slot is Sunday 21:00 UTC = Monday 05:00
 * Australia/Perth (MAINTENANCE_SCHEDULES.explora_weekly). Invoking it without
 * EXPLORA_WEEKLY_RECONCILIATION_ENABLED=true always falls back to a dry run.
 */

const {
  assertExploraWeeklyMaintenanceEnabled,
  EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE,
  isExploraWeeklyReconciliationEnabled
} = require("./lib/cruise-discovery-maintenance");
const { runExploraWeeklyMaintenance } = require("./lib/cruise-discovery-maintenance-runner");
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

    const dryRun = body.dry_run === true || !isExploraWeeklyReconciliationEnabled();

    const lines = await supabase("ci_cruise_lines?slug=eq.explora-journeys&select=id,name,slug&limit=1");
    const line = lines?.[0];
    if (!line) {
      return { statusCode: 404, body: JSON.stringify({ success: false, error: "Explora line not found" }) };
    }

    const result = await executeWeeklyMaintenance({
      lineSlug: "explora-journeys",
      cruiseLineId: line.id,
      runType: EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE,
      assertEnabled: assertExploraWeeklyMaintenanceEnabled,
      runMaintenance: runExploraWeeklyMaintenance,
      dryRun,
      maxWrites: Number(body.max_writes || 25),
      triggerType: body.trigger_type || "manual"
    });

    return {
      statusCode: result.success ? 200 : 500,
      body: JSON.stringify({ ...result, elapsed_ms: Date.now() - started })
    };
  } catch (error) {
    console.error("explora-weekly-maintenance-cron failed", error);
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify({ success: false, error: error.message || "Explora weekly maintenance failed" })
    };
  }
};
