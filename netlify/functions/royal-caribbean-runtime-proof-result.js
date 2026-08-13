/**
 * Royal Caribbean branch runtime proof — poll compact background result by run_id.
 */

const { loadRuntimeProofResult } = require("./lib/royal-caribbean-runtime-result-store");
const {
  assertBranchRuntimeProofAccess,
  parseBranchProofBody,
  redactSecrets
} = require("./lib/royal-caribbean-runtime-proof");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    const body = parseBranchProofBody(event);
    assertBranchRuntimeProofAccess(event, body);

    const runId = body.run_id;
    if (!runId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "run_id_required" })
      };
    }

    const stored = await loadRuntimeProofResult(runId, { event });
    if (!stored) {
      return {
        statusCode: 202,
        body: JSON.stringify(
          redactSecrets({
            ok: true,
            status: "pending",
            run_id: runId,
            elapsed_ms: Date.now() - started
          })
        )
      };
    }

    if (stored.status === "running") {
      return {
        statusCode: 202,
        body: JSON.stringify(
          redactSecrets({
            ok: true,
            status: "running",
            run_id: runId,
            elapsed_ms: Date.now() - started
          })
        )
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(
        redactSecrets({
          ok: true,
          status: "completed",
          run_id: runId,
          result: stored,
          elapsed_ms: Date.now() - started
        })
      )
    };
  } catch (error) {
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify(
        redactSecrets({
          ok: false,
          error: error.message || "result_lookup_failed",
          code: error.code || null,
          elapsed_ms: Date.now() - started
        })
      )
    };
  }
};
