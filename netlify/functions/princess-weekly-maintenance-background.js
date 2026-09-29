/**
 * Princess weekly inventory maintenance — Netlify Background Function.
 * Invoked only by the thin launcher (or authorised manual dispatch).
 * NOT independently scheduled.
 */

const {
  assertCronAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  runWeeklyBackgroundMaintenance,
  redactSecrets,
  BACKGROUND_FUNCTION_NAME
} = require("./lib/princess-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertCronAuth(event);
    const body = parseJsonBody(event);
    const triggerType = String(body.trigger_type || body.triggerType || "background").trim();
    const scheduled = triggerType === "scheduled";
    const dryRun = scheduled || body.force_apply === true ? resolveDryRun(body) : true;
    const maxWrites = resolveMaxWrites(body);
    const dispatchId = body.dispatch_id || body.dispatchId || null;
    const provenance = body.invocation_provenance || null;

    const result = await runWeeklyBackgroundMaintenance({
      dryRun,
      maxWrites,
      triggerType,
      dispatchId,
      provenance
    });

    return {
      statusCode: result.success || result.review_required || result.terminal_status === "completed_with_review"
        ? 200
        : 500,
      body: JSON.stringify(
        redactSecrets({
          ...result,
          worker: BACKGROUND_FUNCTION_NAME,
          elapsed_ms: Date.now() - started
        })
      )
    };
  } catch (error) {
    console.error("princess-weekly-maintenance-background failed", {
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
          error: error.message || "Princess weekly background maintenance failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
