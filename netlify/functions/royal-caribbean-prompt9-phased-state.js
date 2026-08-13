/** TEMPORARY Prompt 9 phased proof state reader. */
const { loadPhasedRunState, loadEnumerationPhase } = require("./lib/royal-caribbean-phased-enumeration-store");
const { PHASE_SPECS } = require("./lib/royal-caribbean-phased-enumeration");
const EXPECTED_HOST = "deploy-preview-1--admirable-tiramisu-d4da8a.netlify.app";
const CONFIRMATION = "RC_PROMPT9_PHASED_PROOF_2026";
function host(event) { return String(event?.headers?.host || event?.headers?.Host || "").toLowerCase().replace(/:\d+$/, ""); }
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") return { statusCode: 405, body: JSON.stringify({ ok: false, error: "method_not_allowed" }) };
    const qs = event.queryStringParameters || {};
    if (host(event) !== EXPECTED_HOST) return { statusCode: 403, body: JSON.stringify({ ok: false, error: "preview_host_mismatch" }) };
    if (String(qs.confirmation || "") !== CONFIRMATION) return { statusCode: 403, body: JSON.stringify({ ok: false, error: "invalid_confirmation" }) };
    const runId = String(qs.run_id || "").trim();
    if (!runId) return { statusCode: 400, body: JSON.stringify({ ok: false, error: "run_id_required" }) };
    const state = await loadPhasedRunState(runId);
    const phaseSummaries = [];
    for (const spec of PHASE_SPECS) {
      const phase = await loadEnumerationPhase(runId, spec.id);
      if (phase) phaseSummaries.push({
        phase_id: spec.id,
        page_size: phase.page_size,
        pages_requested: phase.pages_requested,
        unique_sailing_ids: phase.unique_sailing_ids,
        product_count: phase.product_count,
        duration_ms: phase.duration_ms,
        shard_count: phase.shard_count
      });
    }
    return {
      statusCode: state?.status === "failed" ? 500 : state ? 200 : 202,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: state?.status !== "failed", status: state?.status || "pending", run_id: runId, state, phases: phaseSummaries, actual_writes: 0 })
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(error?.message || "state_failed").slice(0, 200), actual_writes: 0 }) };
  }
};
