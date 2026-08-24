/**
 * Silversea weekly maintenance — Netlify Background Function.
 */

const {
  assertCronAuth,
  parseJsonBody,
  redactSecrets
} = require("./lib/silversea-weekly-auth");
const {
  runSilverseaWeeklyBackgroundMaintenance,
  BACKGROUND_FUNCTION_NAME,
  resolveDryRun
} = require("./lib/silversea-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertCronAuth(event);
    const body = parseJsonBody(event);
    const dryRun = resolveDryRun(body, process.env);
    const triggerType = String(body.trigger_type || body.triggerType || "background").trim();
    const dispatchId = body.dispatch_id || body.dispatchId || null;
    const performWrites = body.authorised_scheduled_maintenance === true || dryRun === false;

    const result = await runSilverseaWeeklyBackgroundMaintenance({
      dryRun: !performWrites,
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
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify(
        redactSecrets({
          success: false,
          worker: BACKGROUND_FUNCTION_NAME,
          error: error.message,
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
