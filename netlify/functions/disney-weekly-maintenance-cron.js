/**
 * Disney weekly inventory maintenance — thin Scheduled Function launcher.
 *
 * Target slot: schedule = "0 2 * * 1" (Monday 02:00 UTC / Monday 10:00 Perth).
 * Dispatches long-running work to disney-weekly-maintenance-background.
 */

const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertDisneyWeeklyAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  resolveScheduledLauncherState,
  dispatchDisneyWeeklyBackground,
  redactSecrets,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation
} = require("./lib/disney-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    const scheduleState = resolveScheduledLauncherState(event);
    if (scheduleState.disabled) {
      return {
        statusCode: 200,
        body: JSON.stringify(
          redactSecrets({
            success: true,
            phase: "dispatch",
            status: "disabled",
            launcher: LAUNCHER_FUNCTION_NAME,
            reason: scheduleState.reason,
            scheduled_invocation: isNetlifyPlatformScheduledInvocation(event),
            elapsed_ms: Date.now() - started
          })
        )
      };
    }

    assertDisneyWeeklyAuth(event);

    const body = parseJsonBody(event);
    const dryRun = resolveDryRun(body);
    const maxWrites = resolveMaxWrites(body);
    const triggerType = resolveTriggerType(event, body);
    const dispatchId = `disney-dispatch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const nextRun = body.next_run || null;

    const kick = await dispatchDisneyWeeklyBackground({
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
    console.error("disney-weekly-maintenance-cron dispatch failed", {
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
          error: error.message || "Disney weekly dispatch failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
