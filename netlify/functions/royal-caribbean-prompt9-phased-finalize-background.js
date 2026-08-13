/**
 * TEMPORARY Prompt 9 phased final reconciliation for Deploy Preview #1.
 * Consumes frozen phase data. Production reads only. Remove after proof.
 */
const { supabase } = require("./lib/cruise-discovery-ops");
const { runRoyalCaribbeanPhasedWeeklyDryRun } = require("./lib/royal-caribbean-phased-weekly-dry-run");
const { buildCompactRuntimeSummary } = require("./lib/royal-caribbean-runtime-proof");
const { saveRuntimeProofResult } = require("./lib/royal-caribbean-runtime-result-store");
const { savePhasedRunState } = require("./lib/royal-caribbean-phased-enumeration-store");

const EXPECTED_HOST = "deploy-preview-1--admirable-tiramisu-d4da8a.netlify.app";
const CONFIRMATION = "RC_PROMPT9_PHASED_PROOF_2026";
function parseBody(event) { try { return JSON.parse(event?.body || "{}"); } catch { return {}; } }
function host(event) { return String(event?.headers?.host || event?.headers?.Host || "").toLowerCase().replace(/:\d+$/, ""); }
function assertReadOnlyPreview(event, body) {
  if (host(event) !== EXPECTED_HOST) throw Object.assign(new Error("preview_host_mismatch"), { statusCode: 403 });
  if (body.confirmation !== CONFIRMATION) throw Object.assign(new Error("invalid_confirmation"), { statusCode: 403 });
  if (!body.run_id) throw Object.assign(new Error("run_id_required"), { statusCode: 400 });
  for (const flag of ["ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED", "ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED"]) {
    if (String(process.env[flag] || "").toLowerCase() === "true") throw Object.assign(new Error(`${flag}_must_be_false`), { statusCode: 409 });
  }
}

exports.handler = async (event) => {
  const body = parseBody(event);
  const started = Date.now();
  try {
    assertReadOnlyPreview(event, body);
    await savePhasedRunState(body.run_id, { status: "final_reconciliation_running", actual_writes: 0 });
    const result = await runRoyalCaribbeanPhasedWeeklyDryRun({
      sb: supabase,
      runId: body.run_id,
      today: body.today || undefined,
      triggerType: "prompt9_phased_netlify_proof"
    });
    result.summary = result.summary || {};
    result.summary.fleet_ship_count = result.simulation?.fleet?.ships?.length || null;
    const compact = buildCompactRuntimeSummary(result, { run_id: body.run_id });
    compact.phased_runtime = true;
    compact.phase_count = result.summary?.phase_manifests?.length || 0;
    compact.total_duration_ms = Date.now() - started;
    compact.phased_enumeration_health = result.summary?.phased_enumeration_health || null;
    await saveRuntimeProofResult(body.run_id, compact);
    await savePhasedRunState(body.run_id, {
      status: result.ok ? "completed" : "failed",
      final_reconciliation_ok: result.ok === true,
      actual_writes: 0,
      compact
    });
  } catch (error) {
    const safe = String(error?.message || "phased_finalize_failed").slice(0, 240);
    try {
      await saveRuntimeProofResult(body.run_id || "unknown", {
        ok: false,
        status: "failed",
        error: safe,
        actual_writes: 0,
        royal_caribbean_netlify_background_runtime_ok: false
      });
      if (body.run_id) await savePhasedRunState(body.run_id, { status: "failed", error: safe, actual_writes: 0 });
    } catch {}
    console.error("royal-caribbean-prompt9-phased-finalize-background", safe);
  }
};
