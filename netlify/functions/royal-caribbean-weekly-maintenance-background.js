/**
 * Royal Caribbean weekly maintenance — Netlify Background Function (dry-run catalogue path).
 */

const {
  assertCronAuth,
  parseJsonBody,
  resolveBackgroundExecution,
  resolveTriggerType,
  runRoyalCaribbeanWeeklyBackgroundMaintenance,
  redactSecrets,
  BACKGROUND_FUNCTION_NAME
} = require("./lib/royal-caribbean-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertCronAuth(event);

    const body = parseJsonBody(event);
    const execution = resolveBackgroundExecution(body, event, process.env);
    const triggerType = resolveTriggerType(event, body);
    const dispatchId = body.dispatch_id || body.dispatchId || null;
    const runId = body.run_id || body.runId || null;

    if (execution.blocked) {
      return {
        statusCode: 403,
        body: JSON.stringify(
          redactSecrets({
            success: false,
            phase: "background_maintenance",
            status: "blocked",
            worker: BACKGROUND_FUNCTION_NAME,
            dispatch_id: dispatchId,
            dry_run: true,
            max_writes: 0,
            trigger_type: triggerType,
            reason: execution.reason,
            elapsed_ms: Date.now() - started
          })
        )
      };
    }

    const result = await runRoyalCaribbeanWeeklyBackgroundMaintenance({
      dryRun: execution.dryRun,
      maxWrites: execution.maxWrites,
      triggerType,
      dispatchId,
      runId
    });

    return {
      statusCode: result.ok === false && result.status === "failed" ? 500 : 200,
      body: JSON.stringify(
        redactSecrets({
          ...result,
          worker: BACKGROUND_FUNCTION_NAME,
          elapsed_ms: Date.now() - started
        })
      )
    };
  } catch (error) {
    console.error("royal-caribbean-weekly-maintenance-background failed", {
      message: error.message,
      code: error.code || null
    });
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify(
        redactSecrets({
          success: false,
          phase: "background_maintenance",
          status: "failed",
          worker: BACKGROUND_FUNCTION_NAME,
          error: error.message || "Royal Caribbean weekly background maintenance failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
