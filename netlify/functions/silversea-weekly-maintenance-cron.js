/**
 * Silversea weekly maintenance — thin Scheduled Function launcher.
 * Dispatches to silversea-weekly-maintenance-background.
 */

const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertSilverseaWeeklyAuth,
  parseJsonBody,
  resolveDryRun,
  resolveTriggerType,
  dispatchSilverseaWeeklyBackground,
  redactSecrets,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation
} = require("./lib/silversea-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertSilverseaWeeklyAuth(event);
    const body = parseJsonBody(event);
    const dryRun = resolveDryRun(body, process.env);
    const triggerType = resolveTriggerType(event, body);
    const dispatchId = `silversea-dispatch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const nextRun = body.next_run || null;
    const platformScheduled = isNetlifyPlatformScheduledInvocation(event);

    const kick = await dispatchSilverseaWeeklyBackground({
      dryRun: platformScheduled ? false : dryRun,
      triggerType,
      dispatchId,
      nextRun,
      platformScheduled
    });

    return {
      statusCode: kick.accepted ? 202 : 502,
      body: JSON.stringify(
        redactSecrets({
          success: kick.accepted,
          launcher: LAUNCHER_FUNCTION_NAME,
          background: BACKGROUND_FUNCTION_NAME,
          dispatch_id: dispatchId,
          dry_run: platformScheduled ? false : dryRun,
          scheduled_invocation: isScheduledInvocation(event),
          platform_scheduled: platformScheduled,
          elapsed_ms: Date.now() - started,
          detail: kick.body
        })
      )
    };
  } catch (error) {
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify(
        redactSecrets({
          success: false,
          error: error.message,
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
