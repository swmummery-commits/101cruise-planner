/**
 * TEMPORARY Prompt 9 proof background worker.
 * Deploy Preview #1 only. Read-only. Remove after runtime proof succeeds.
 */
const { runRoyalCaribbeanRuntimeProofBackground } = require("./lib/royal-caribbean-weekly-maintenance-dispatch");
const { saveRuntimeProofResult } = require("./lib/royal-caribbean-runtime-result-store");

const EXPECTED_HOST = "deploy-preview-1--admirable-tiramisu-d4da8a.netlify.app";
const CONFIRMATION = "RC_PROMPT9_PREVIEW_PROOF_2026";

function parseBody(event) {
  try { return JSON.parse(event?.body || "{}"); } catch { return {}; }
}
function hostFromEvent(event) {
  return String(event?.headers?.host || event?.headers?.Host || "").trim().toLowerCase().replace(/:\d+$/, "");
}
function assertPreviewProof(event, body) {
  if (hostFromEvent(event) !== EXPECTED_HOST) {
    const e = new Error("preview_host_mismatch"); e.statusCode = 403; throw e;
  }
  if (body.confirmation !== CONFIRMATION) {
    const e = new Error("invalid_confirmation"); e.statusCode = 403; throw e;
  }
  if (!body.run_id) {
    const e = new Error("run_id_required"); e.statusCode = 400; throw e;
  }
  for (const flag of ["ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED", "ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED"]) {
    if (String(process.env[flag] || "").toLowerCase() === "true") {
      const e = new Error(`${flag}_must_be_false`); e.statusCode = 409; throw e;
    }
  }
}
function safeError(error) {
  const raw = String(error?.message || error?.code || error?.name || "preview_background_failed");
  return raw
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9_\-]{40,}/g, "[redacted]")
    .slice(0, 300);
}

exports.handler = async (event) => {
  const body = parseBody(event);
  const runId = String(body.run_id || "").trim();
  try {
    assertPreviewProof(event, body);
    await saveRuntimeProofResult(runId, {
      ok: false,
      status: "running",
      run_id: runId,
      actual_writes: 0,
      writes_performed: false
    });
    const result = await runRoyalCaribbeanRuntimeProofBackground({
      runId,
      triggerType: "prompt9_deploy_preview_proof"
    });
    return {
      statusCode: result.ok ? 200 : 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: result.ok === true, run_id: body.run_id, actual_writes: result.actual_writes || 0, writes_performed: false })
    };
  } catch (error) {
    console.error("royal-caribbean-prompt9-preview-proof-background", error.message || error);
    if (body.run_id) {
      try {
        await saveRuntimeProofResult(String(body.run_id), {
          ok: false,
          status: "failed",
          error_code: String(error?.code || error?.name || "background_failed").slice(0, 80),
          safe_error: safeError(error),
          actual_writes: 0,
          writes_performed: false,
          royal_caribbean_netlify_background_runtime_ok: false
        });
      } catch (persistError) {
        console.error("royal-caribbean-prompt9-preview-proof-background-result-save", persistError?.message || persistError);
      }
    }
    return {
      statusCode: error.statusCode || 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, error: safeError(error), run_id: body.run_id || null, writes_performed: false })
    };
  }
};
