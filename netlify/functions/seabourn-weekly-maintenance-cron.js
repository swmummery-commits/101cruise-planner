/**
 * Seabourn weekly inventory maintenance — thin Scheduled Function launcher.
 *
 * Target slot once enabled: schedule = "0 22 * * 0" (Sunday 22:00 UTC / Monday 06:00 Perth).
 * Dispatches long-running work to seabourn-weekly-maintenance-background.
 */

const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertSeabournWeeklyAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  dispatchSeabournWeeklyBackground,
  redactSecrets,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation
} = require("./lib/seabourn-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertSeabournWeeklyAuth(event);

    const body = parseJsonBody(event);
    const dryRun = resolveDryRun(body);
    const maxWrites = resolveMaxWrites(body);
    const triggerType = resolveTriggerType(event, body);
    const dispatchId = `seabourn-dispatch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const nextRun = body.next_run || null;

    const kick = await dispatchSeabournWeeklyBackground({
      dryRun,
      maxWrites,
      triggerType,
      dispatchId,
      nextRun,
      platformScheduled: isNetlifyPlatformScheduledInvocation(event)
    });

    const elapsed_ms = Date.now() - started;
    if (!kick.accepted) {
      return {
        statusCode: 502,
        body: JSON.stringify(
          redactSecrets({
            success: false,
            phase: "dispatch",
            status: "dispatch_failed",
            launcher: LAUNCHER_FUNCTION_NAME,
            background: BACKGROUND_FUNCTION_NAME,
            dispatch_id: dispatchId,
            dry_run: dryRun,
            scheduled_invocation: isNetlifyPlatformScheduledInvocation(event),
            background_http_status: kick.status,
            error: "background_dispatch_rejected",
            detail: kick.body,
            elapsed_ms
          })
        )
      };
    }

    return {
      statusCode: 202,
      body: JSON.stringify(
        redactSecrets({
          success: true,
          phase: "dispatch",
          status: "dispatched",
          maintenance_status: "pending_background",
          launcher: LAUNCHER_FUNCTION_NAME,
          background: BACKGROUND_FUNCTION_NAME,
          dispatch_id: dispatchId,
          dry_run: dryRun,
          max_writes: maxWrites,
          trigger_type: triggerType,
          scheduled_invocation: isScheduledInvocation(event),
          platform_scheduled: isNetlifyPlatformScheduledInvocation(event),
          background_http_status: kick.status,
          elapsed_ms,
          note: "Background worker owns maintenance lifecycle; poll cruise_discovery_runs for completion."
        })
      )
    };
  } catch (error) {
    console.error("seabourn-weekly-maintenance-cron dispatch failed", {
      message: error.message,
      code: error.code || null
    });
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify(
        redactSecrets({
          success: false,
          phase: "dispatch",
          status: "dispatch_failed",
          error: error.message || "Seabourn weekly dispatch failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
