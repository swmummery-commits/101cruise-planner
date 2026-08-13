/**
 * TEMPORARY Prompt 9 proof harness.
 * Deploy Preview #1 only. Read-only. Remove after runtime proof succeeds.
 */
const {
  probeRoyalCaribbeanSource,
  fetchRoyalCaribbeanFleet,
  USER_AGENT,
  GRAPH_URL
} = require("./lib/royal-caribbean-discovery-source");

const EXPECTED_HOST = "deploy-preview-1--admirable-tiramisu-d4da8a.netlify.app";
const CONFIRMATION = "RC_PROMPT9_PREVIEW_PROOF_2026";

function parseBody(event) {
  try { return JSON.parse(event?.body || "{}"); } catch { return {}; }
}
function hostFromEvent(event) {
  return String(event?.headers?.host || event?.headers?.Host || "").trim().toLowerCase().replace(/:\d+$/, "");
}
function assertPreviewProof(event) {
  if (hostFromEvent(event) !== EXPECTED_HOST) {
    const e = new Error("preview_host_mismatch"); e.statusCode = 403; throw e;
  }
  const body = parseBody(event);
  if (body.confirmation !== CONFIRMATION) {
    const e = new Error("invalid_confirmation"); e.statusCode = 403; throw e;
  }
  for (const flag of ["ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED", "ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED"]) {
    if (String(process.env[flag] || "").toLowerCase() === "true") {
      const e = new Error(`${flag}_must_be_false`); e.statusCode = 409; throw e;
    }
  }
}

exports.handler = async (event) => {
  const started = Date.now();
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ ok: false, error: "method_not_allowed" }) };
    assertPreviewProof(event);
    const probe = await probeRoyalCaribbeanSource({ maxPages: 1, pageSize: 5, includeFleet: true });
    const fleet = await fetchRoyalCaribbeanFleet();
    const payload = {
      ok: probe.ok === true && fleet.ok === true,
      runtime: "netlify_deploy_preview",
      graph_url: GRAPH_URL,
      user_agent: USER_AGENT,
      upstream_http_status: probe.status || null,
      graphql_valid: probe.ok === true,
      sample_group_count: probe.returned_groups || 0,
      official_group_total: probe.total_official_groups || null,
      fleet_count: fleet.ships?.length || 0,
      writes_performed: false,
      duration_ms: Date.now() - started
    };
    return { statusCode: payload.ok ? 200 : 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(payload) };
  } catch (error) {
    return { statusCode: error.statusCode || 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ ok: false, error: error.message || "preview_smoke_failed", writes_performed: false, duration_ms: Date.now() - started }) };
  }
};
