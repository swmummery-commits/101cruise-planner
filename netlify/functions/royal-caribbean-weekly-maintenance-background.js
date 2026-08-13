/**
 * Royal Caribbean weekly maintenance — Netlify Background Function (read-only catalogue path).
 */

const {
  assertCronAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  runRoyalCaribbeanWeeklyBackgroundMaintenance,
  runRoyalCaribbeanRuntimeProofBackground,
  redactSecrets,
  BACKGROUND_FUNCTION_NAME
} = require("./lib/royal-caribbean-weekly-maintenance-dispatch");
const { BRANCH_RUNTIME_PROOF_MODE } = require("./lib/royal-caribbean-runtime-proof");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertCronAuth(event);

    const body = parseJsonBody(event);
    const dryRun = resolveDryRun(body);
    const maxWrites = resolveMaxWrites(body);
    const triggerType = String(body.trigger_type || body.triggerType || "background").trim();
    const dispatchId = body.dispatch_id || body.dispatchId || null;
    const runId = body.run_id || body.runId || null;

    const result =
      triggerType === "branch_runtime_proof" || body.mode === BRANCH_RUNTIME_PROOF_MODE
        ? await runRoyalCaribbeanRuntimeProofBackground({
            dryRun: true,
            triggerType: "branch_runtime_proof",
            dispatchId,
            runId,
            body
          })
        : await runRoyalCaribbeanWeeklyBackgroundMaintenance({
            dryRun,
            maxWrites,
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
