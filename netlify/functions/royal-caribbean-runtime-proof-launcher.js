/**
 * Royal Caribbean branch runtime proof — thin launcher (dispatches background worker).
 */

const {
  RUNTIME_PROOF_LAUNCHER_FUNCTION_NAME,
  BACKGROUND_FUNCTION_NAME,
  dispatchRoyalCaribbeanWeeklyBackground,
  parseJsonBody,
  redactSecrets
} = require("./lib/royal-caribbean-weekly-maintenance-dispatch");
const {
  assertBranchRuntimeProofAccess,
  parseBranchProofBody,
  BRANCH_RUNTIME_PROOF_MODE
} = require("./lib/royal-caribbean-runtime-proof");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    const body = parseBranchProofBody(event);
    assertBranchRuntimeProofAccess(event, body);

    const runId =
      body.run_id ||
      `royal-caribbean-runtime-proof-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const dispatchId = `royal-caribbean-dispatch-${Date.now()}`;

    const kick = await dispatchRoyalCaribbeanWeeklyBackground({
      dryRun: true,
      maxWrites: 0,
      triggerType: "branch_runtime_proof",
      dispatchId,
      runId,
      body: { ...parseJsonBody(event), mode: BRANCH_RUNTIME_PROOF_MODE, confirmation: body.confirmation }
    });

    const elapsed_ms = Date.now() - started;
    if (!kick.accepted) {
      return {
        statusCode: 502,
        body: JSON.stringify(
          redactSecrets({
            ok: false,
            error: "background_dispatch_rejected",
            launcher: RUNTIME_PROOF_LAUNCHER_FUNCTION_NAME,
            background: BACKGROUND_FUNCTION_NAME,
            dispatch_id: dispatchId,
            run_id: runId,
            background_http_status: kick.status,
            elapsed_ms
          })
        )
      };
    }

    return {
      statusCode: 202,
      body: JSON.stringify(
        redactSecrets({
          ok: true,
          status: "dispatched",
          launcher: RUNTIME_PROOF_LAUNCHER_FUNCTION_NAME,
          background: BACKGROUND_FUNCTION_NAME,
          dispatch_id: dispatchId,
          run_id: runId,
          background_http_status: kick.status,
          elapsed_ms
        })
      )
    };
  } catch (error) {
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify(
        redactSecrets({
          ok: false,
          error: error.message || "launcher_failed",
          code: error.code || null,
          launcher: RUNTIME_PROOF_LAUNCHER_FUNCTION_NAME,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
