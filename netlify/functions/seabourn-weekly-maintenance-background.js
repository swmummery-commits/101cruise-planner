/**
 * Seabourn weekly inventory maintenance — Netlify Background Function.
 *
 * Invoked by `seabourn-weekly-maintenance-cron` with header:
 *   x-discovery-cron-secret = DISCOVERY_CRON_SECRET
 *
 * Always requires secret — scheduled launcher dispatches with server-side secret.
 */

const {
  assertCronAuth,
  parseJsonBody,
  redactSecrets
} = require("./lib/seabourn-weekly-auth");
const {
  resolveDryRun,
  resolveMaxWrites,
  runSeabournWeeklyBackgroundMaintenance,
  BACKGROUND_FUNCTION_NAME
} = require("./lib/seabourn-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertCronAuth(event);

    const body = parseJsonBody(event);
    const dryRun = resolveDryRun(body);
    const maxWrites = resolveMaxWrites(body);
    const triggerType = String(body.trigger_type || body.triggerType || "background").trim();
    const dispatchId = body.dispatch_id || body.dispatchId || null;

    const result = await runSeabournWeeklyBackgroundMaintenance({
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
    console.error("seabourn-weekly-maintenance-background failed", {
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
          error: error.message || "Seabourn weekly background maintenance failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
