/**
 * Norwegian weekly inventory maintenance — Netlify Background Function.
 */

const {
  assertCronAuth,
  parseJsonBody,
  redactSecrets
} = require("./lib/norwegian-weekly-auth");
const {
  resolveDryRun,
  resolveMaxWrites,
  runNorwegianWeeklyBackgroundMaintenance,
  BACKGROUND_FUNCTION_NAME
} = require("./lib/norwegian-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertCronAuth(event);

    const body = parseJsonBody(event);
    const dryRun = resolveDryRun(body);
    const maxWrites = resolveMaxWrites(body);
    const triggerType = String(body.trigger_type || body.triggerType || "background").trim();
    const dispatchId = body.dispatch_id || body.dispatchId || null;

    const result = await runNorwegianWeeklyBackgroundMaintenance({
      dryRun,
      maxWrites,
      triggerType,
      dispatchId
    });

    return {
      statusCode: result.success ? 200 : 500,
      body: JSON.stringify(
        redactSecrets({
          ...result,
          worker: BACKGROUND_FUNCTION_NAME,
          elapsed_ms: Date.now() - started
        })
      )
    };
  } catch (error) {
    console.error("norwegian-weekly-maintenance-background failed", {
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
          error: error.message || "Norwegian weekly background maintenance failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
