/**
 * TEMPORARY Prompt 9 phased source worker for Deploy Preview #1.
 * One bounded source pass per invocation. Read-only. Remove after proof.
 */
const { runPhasedEnumerationSourcePhase } = require("./lib/royal-caribbean-phased-enumeration");
const { savePhasedRunState } = require("./lib/royal-caribbean-phased-enumeration-store");

const EXPECTED_HOST = "deploy-preview-1--admirable-tiramisu-d4da8a.netlify.app";
const CONFIRMATION = "RC_PROMPT9_PHASED_PROOF_2026";

function parseBody(event) { try { return JSON.parse(event?.body || "{}"); } catch { return {}; } }
function host(event) { return String(event?.headers?.host || event?.headers?.Host || "").toLowerCase().replace(/:\d+$/, ""); }
function assertReadOnlyPreview(event, body) {
  if (host(event) !== EXPECTED_HOST) throw Object.assign(new Error("preview_host_mismatch"), { statusCode: 403 });
  if (body.confirmation !== CONFIRMATION) throw Object.assign(new Error("invalid_confirmation"), { statusCode: 403 });
  if (!body.run_id || !body.phase_id) throw Object.assign(new Error("run_id_and_phase_id_required"), { statusCode: 400 });
  for (const flag of ["ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED", "ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED"]) {
    if (String(process.env[flag] || "").toLowerCase() === "true") throw Object.assign(new Error(`${flag}_must_be_false`), { statusCode: 409 });
  }
}

exports.handler = async (event) => {
  const body = parseBody(event);
  try {
    assertReadOnlyPreview(event, body);
    await savePhasedRunState(body.run_id, { status: "source_phase_running", current_phase: body.phase_id, actual_writes: 0 });
    await runPhasedEnumerationSourcePhase({
      runId: body.run_id,
      phaseId: body.phase_id,
      today: body.today || null,
      requestDelayMs: Number(body.request_delay_ms ?? 100)
    });
  } catch (error) {
    if (body.run_id) {
      try {
        await savePhasedRunState(body.run_id, {
          status: "failed",
          failed_phase: body.phase_id || null,
          error: String(error?.message || "phase_failed").slice(0, 200),
          actual_writes: 0
        });
      } catch {}
    }
    console.error("royal-caribbean-prompt9-phased-source-background", error?.message || error);
  }
};
