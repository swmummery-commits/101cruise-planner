/**
 * Celebrity weekly inventory maintenance — Netlify Background Function.
 * Invoked only by the thin scheduled launcher (or authorised manual dispatch).
 * Bundles ports/ship catalogues via netlify.toml included_files.
 */

const {
  assertCronAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  runWeeklyBackgroundMaintenance,
  redactSecrets,
  BACKGROUND_FUNCTION_NAME
} = require("./lib/celebrity-weekly-maintenance-dispatch");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertCronAuth(event);
    const body = parseJsonBody(event);
    const dryRun = resolveDryRun(body);
    const maxWrites = resolveMaxWrites(body);
    const triggerType = String(body.trigger_type || body.triggerType || "background").trim();
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
      statusCode: result.success || result.review_required ? 200 : 500,
      body: JSON.stringify(
        redactSecrets({
          ...result,
          worker: BACKGROUND_FUNCTION_NAME,
          elapsed_ms: Date.now() - started
        })
      )
    };
  } catch (error) {
    console.error("celebrity-weekly-maintenance-background failed", {
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
          error: error.message || "Celebrity weekly background maintenance failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
