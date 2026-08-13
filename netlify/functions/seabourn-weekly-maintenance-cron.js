/**
 * Seabourn weekly inventory maintenance (Netlify function).
 * Scheduled after Prompt 7 cloud validation; dry-run when reconciliation flag is false.
 */

const {
  assertSeabournWeeklyMaintenanceEnabled,
  SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
  isSeabournWeeklyReconciliationEnabled
} = require("./lib/cruise-discovery-maintenance");
const {
  runSeabournWeeklyMaintenance,
  SEABOURN_MAX_WEEKLY_WRITES
} = require("./lib/cruise-discovery-maintenance-runner");
const { executeWeeklyMaintenance, supabase } = require("./lib/cruise-discovery-maintenance-cron");
const {
  assertSeabournWeeklyAuth,
  isScheduledInvocation,
  redactSecrets
} = require("./lib/seabourn-weekly-auth");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertSeabournWeeklyAuth(event);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    const dryRun =
      body.dry_run === true ||
      body.dryRun === true ||
      !isSeabournWeeklyReconciliationEnabled();
    const maxWrites = Math.min(
      Number(body.max_writes ?? body.maxWrites ?? SEABOURN_MAX_WEEKLY_WRITES) || SEABOURN_MAX_WEEKLY_WRITES,
      SEABOURN_MAX_WEEKLY_WRITES
    );

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
      runMaintenance: (ctx) =>
        runSeabournWeeklyMaintenance({
          ...ctx,
          writeMode: dryRun ? "production_read_only" : "weekly_maintenance"
        }),
      dryRun,
      maxWrites,
      triggerType: body.trigger_type || (isScheduledInvocation(event) ? "scheduled" : "manual")
    });

    const summary = result.summary || {};
    const writesPerformed = dryRun
      ? 0
      : (summary.writes_performed ?? (summary.inserts || 0) + (summary.updates || 0));

    return {
      statusCode: result.success ? 200 : 500,
      body: JSON.stringify(
        redactSecrets({
          ...result,
          writes_performed: writesPerformed,
          dry_run: dryRun,
          scheduled_invocation: isScheduledInvocation(event),
          elapsed_ms: Date.now() - started
        })
      )
    };
  } catch (error) {
    console.error("seabourn-weekly-maintenance-cron failed", error);
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify(
        redactSecrets({
          success: false,
          error: error.message || "Seabourn weekly maintenance failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
