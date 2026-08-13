/**
 * Royal Caribbean weekly maintenance — thin launcher (NOT scheduled until activation).
 */

const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertLauncherAuth,
  parseJsonBody,
  resolveWeeklyExecutionPolicy,
  resolveTriggerType,
  dispatchRoyalCaribbeanWeeklyBackground,
  redactSecrets,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation
} = require("./lib/royal-caribbean-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertLauncherAuth(event);

    const body = parseJsonBody(event);
    const policy = resolveWeeklyExecutionPolicy(body, event, process.env);
    const triggerType = resolveTriggerType(event, body);
    const dispatchId = `royal-caribbean-dispatch-${new Date().toISOString().replace(/[:.]/g, "-")}`;

    if (policy.blocked) {
      const elapsed_ms = Date.now() - started;
      console.info(
        "royal-caribbean-weekly-maintenance-cron blocked",
        redactSecrets({
          dispatch_id: dispatchId,
          trigger_type: triggerType,
          scheduled_invocation: policy.scheduled_invocation,
          dry_run: true,
          max_writes: 0,
          blocked: true,
          reason: policy.reason,
          elapsed_ms
        })
      );
      return {
        statusCode: 403,
        body: JSON.stringify(
          redactSecrets({
            success: false,
            phase: "dispatch",
            status: "blocked",
            launcher: LAUNCHER_FUNCTION_NAME,
            dispatch_id: dispatchId,
            dry_run: true,
            max_writes: 0,
            trigger_type: triggerType,
            scheduled_invocation: policy.scheduled_invocation,
            reason: policy.reason,
            elapsed_ms
          })
        )
      };
    }

    const kick = await dispatchRoyalCaribbeanWeeklyBackground({
      dryRun: policy.dryRun,
      maxWrites: policy.maxWrites,
      triggerType,
      dispatchId
    });

    const elapsed_ms = Date.now() - started;
    console.info(
      "royal-caribbean-weekly-maintenance-cron dispatch",
      redactSecrets({
        dispatch_id: dispatchId,
        trigger_type: triggerType,
        scheduled_invocation: policy.scheduled_invocation,
        platform_scheduled: policy.platform_scheduled,
        dry_run: policy.dryRun,
        max_writes: policy.maxWrites,
        background_http_accepted: kick.accepted,
        background_http_status: kick.status,
        elapsed_ms
      })
    );

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
            dry_run: policy.dryRun,
            max_writes: policy.maxWrites,
            trigger_type: triggerType,
            scheduled_invocation: policy.scheduled_invocation,
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
          dry_run: policy.dryRun,
          max_writes: policy.maxWrites,
          trigger_type: triggerType,
          scheduled_invocation: policy.scheduled_invocation,
          platform_scheduled: policy.platform_scheduled,
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
