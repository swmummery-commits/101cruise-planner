/**
 * Royal Caribbean weekly maintenance — thin launcher (NOT scheduled until activation).
 */

const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertLauncherAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  dispatchRoyalCaribbeanWeeklyBackground,
  redactSecrets,
  isScheduledInvocation
} = require("./lib/royal-caribbean-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertLauncherAuth(event);

    const body = parseJsonBody(event);
    const dryRun = resolveDryRun(body);
    const maxWrites = resolveMaxWrites(body);
    const triggerType = resolveTriggerType(event, body);
    const dispatchId = `royal-caribbean-dispatch-${new Date().toISOString().replace(/[:.]/g, "-")}`;

    const kick = await dispatchRoyalCaribbeanWeeklyBackground({
      dryRun,
      maxWrites,
      triggerType,
      dispatchId,
      body
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
            scheduled_invocation: isScheduledInvocation(event),
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
          background_http_status: kick.status,
          elapsed_ms
        })
      )
    };
  } catch (error) {
    console.error("royal-caribbean-weekly-maintenance-cron dispatch failed", {
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
          error: error.message || "Royal Caribbean weekly dispatch failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
