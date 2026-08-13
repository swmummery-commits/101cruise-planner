/**
 * TEMPORARY Prompt 9 proof background worker.
 * Deploy Preview #1 only. Read-only. Remove after runtime proof succeeds.
 */
const { runRoyalCaribbeanRuntimeProofBackground } = require("./lib/royal-caribbean-weekly-maintenance-dispatch");

const EXPECTED_HOST = "deploy-preview-1--admirable-tiramisu-d4da8a.netlify.app";
const CONFIRMATION = "RC_PROMPT9_PREVIEW_PROOF_2026";

function parseBody(event) {
  try { return JSON.parse(event?.body || "{}"); } catch { return {}; }
}

function hostFromEvent(event) {
  return String(event?.headers?.host || event?.headers?.Host || "").trim().toLowerCase().replace(/:\d+$/, "");
}

function assertPreviewProof(event, body) {
  let deployHost = "";
  try { deployHost = new URL(process.env.DEPLOY_PRIME_URL || "").hostname.toLowerCase(); } catch {}
  if (deployHost !== EXPECTED_HOST || hostFromEvent(event) !== EXPECTED_HOST) {
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

exports.handler = async (event) => {
  const body = parseBody(event);
  try {
    assertPreviewProof(event, body);
    const result = await runRoyalCaribbeanRuntimeProofBackground({
      runId: String(body.run_id),
      triggerType: "prompt9_deploy_preview_proof"
    });
    return {
      statusCode: result.ok ? 200 : 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        ok: result.ok === true,
        run_id: body.run_id,
        actual_writes: result.actual_writes || 0,
        writes_performed: false
      })
    };
  } catch (error) {
    console.error("royal-caribbean-prompt9-preview-proof-background", error.message || error);
    return {
      statusCode: error.statusCode || 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: false, error: error.message || "preview_background_failed", run_id: body.run_id || null, writes_performed: false })
    };
  }
};
