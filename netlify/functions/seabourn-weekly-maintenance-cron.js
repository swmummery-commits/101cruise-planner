/**
 * Seabourn weekly inventory maintenance (Netlify function — NOT scheduled until post-import).
 * Default: dry-run when SEABOURN_WEEKLY_RECONCILIATION_ENABLED is false.
 */

const {
  assertSeabournWeeklyMaintenanceEnabled,
  SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
  isSeabournWeeklyReconciliationEnabled
} = require("./lib/cruise-discovery-maintenance");
const { runSeabournWeeklyMaintenance } = require("./lib/cruise-discovery-maintenance-runner");
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

    const dryRun = body.dry_run === true || !isSeabournWeeklyReconciliationEnabled();

    const lines = await supabase(
      "ci_cruise_lines?slug=eq.seabourn-cruise-line&select=id,name,slug&limit=1"
    );
    const line = lines?.[0];
    if (!line) {
      return { statusCode: 404, body: JSON.stringify({ success: false, error: "Seabourn line not found" }) };
    }

    const result = await executeWeeklyMaintenance({
      lineSlug: "seabourn-cruise-line",
      cruiseLineId: line.id,
      runType: SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
      assertEnabled: assertSeabournWeeklyMaintenanceEnabled,
      runMaintenance: runSeabournWeeklyMaintenance,
      dryRun,
      maxWrites: Number(body.max_writes || 100),
      triggerType: body.trigger_type || "scheduled"
    });

    return {
      statusCode: result.success ? 200 : 500,
      body: JSON.stringify({ ...result, elapsed_ms: Date.now() - started })
    };
  } catch (error) {
    console.error("seabourn-weekly-maintenance-cron failed", error);
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify({ success: false, error: error.message || "Seabourn weekly maintenance failed" })
    };
  }
};
