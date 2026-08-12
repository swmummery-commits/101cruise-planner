/**
 * Explora Journeys weekly maintenance — thin Scheduled Function launcher.
 *
 * NOT SCHEDULED during hardening. Target slot once enabled:
 *   schedule = "0 21 * * 0" (Sunday 21:00 UTC / Monday 05:00 Australia/Perth)
 *
 * This launcher MUST NOT run catalogue maintenance inline. Netlify Scheduled
 * Functions are hard-capped at ~30 seconds; Explora maintenance exceeds that.
 * It only authenticates, builds a safe payload, and dispatches:
 *   explora-weekly-maintenance-background
 *
 * Dispatch success is NOT maintenance success. The background worker owns the
 * maintenance run record (status starts as `running` only after background begins).
 */

const {
  LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  assertLauncherAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  dispatchExploraWeeklyBackground,
  redactSecrets,
  isScheduledInvocation
} = require("./lib/explora-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertLauncherAuth(event);

    const body = parseJsonBody(event);
    const dryRun = resolveDryRun(body);
    const maxWrites = resolveMaxWrites(body);
    const triggerType = resolveTriggerType(event, body);
    const dispatchId = `explora-dispatch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let nextRun = null;
    try {
      nextRun = body.next_run || null;
    } catch {
      nextRun = null;
    }

    const kick = await dispatchExploraWeeklyBackground({
      dryRun,
      maxWrites,
      triggerType,
      dispatchId,
      nextRun
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

    // Launcher success means DISPATCHED only — never claim maintenance completed.
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
          elapsed_ms,
          note: "Background worker owns run-record lifecycle; poll cruise_discovery_runs for completion."
        })
      )
    };
  } catch (error) {
    console.error("explora-weekly-maintenance-cron dispatch failed", {
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
          error: error.message || "Explora weekly dispatch failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
