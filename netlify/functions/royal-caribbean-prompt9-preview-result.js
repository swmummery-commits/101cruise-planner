/**
 * TEMPORARY Prompt 9 proof result reader.
 * Deploy Preview #1 only. Read-only. Remove after runtime proof succeeds.
 */
const { loadRuntimeProofResult } = require("./lib/royal-caribbean-runtime-result-store");

const EXPECTED_HOST = "deploy-preview-1--admirable-tiramisu-d4da8a.netlify.app";
const CONFIRMATION = "RC_PROMPT9_PREVIEW_PROOF_2026";

function hostFromEvent(event) {
  return String(event?.headers?.host || event?.headers?.Host || "").trim().toLowerCase().replace(/:\d+$/, "");
}
function assertPreviewProof(event) {
  if (hostFromEvent(event) !== EXPECTED_HOST) {
    const e = new Error("preview_host_mismatch"); e.statusCode = 403; throw e;
  }
  const qs = event?.queryStringParameters || {};
  if (String(qs.confirmation || "") !== CONFIRMATION) {
    const e = new Error("invalid_confirmation"); e.statusCode = 403; throw e;
  }
  const runId = String(qs.run_id || "").trim();
  if (!runId) {
    const e = new Error("run_id_required"); e.statusCode = 400; throw e;
  }
  return runId;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") return { statusCode: 405, body: JSON.stringify({ ok: false, error: "method_not_allowed" }) };
    const runId = assertPreviewProof(event);
    const stored = await loadRuntimeProofResult(runId, { event });
    if (!stored) {
      return { statusCode: 202, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ ok: true, status: "pending", run_id: runId }) };
    }
    if (stored.status === "running") {
      return { statusCode: 202, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ ok: true, status: "running", run_id: runId }) };
    }
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ ok: true, status: "completed", run_id: runId, result: stored }) };
  } catch (error) {
    return { statusCode: error.statusCode || 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ ok: false, error: error.message || "preview_result_failed" }) };
  }
};
