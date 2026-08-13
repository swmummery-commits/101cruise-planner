/**
 * Bounded Royal Caribbean source smoke (Netlify runtime).
 *
 * POST /.netlify/functions/royal-caribbean-discovery-smoke
 * Auth: x-discovery-cron-secret
 *
 * Probe + fleet connectivity only — no authoritative multi-page enumeration.
 */

const {
  probeRoyalCaribbeanSource,
  fetchRoyalCaribbeanFleet,
  USER_AGENT,
  GRAPH_URL
} = require("./lib/royal-caribbean-discovery-source");
const { assertSmokeAuth, parseJsonBody, redactSecrets } = require("./lib/royal-caribbean-weekly-auth");

exports.handler = async (event) => {
  const started = Date.now();
  try {
    const body = parseJsonBody(event);
    assertSmokeAuth(event);

    if (event.httpMethod && event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ ok: false, error: "method_not_allowed" }) };
    }

    if (body.mode && String(body.mode).trim() !== "production_read_only") {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "smoke_read_only_only" }) };
    }

    if (body.authoritative_enumeration === true) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          ok: false,
          error: "authoritative_enumeration_forbidden_in_smoke",
          authoritative_enumeration: false
        })
      };
    }

    if (String(process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED || "").toLowerCase() === "true") {
      return {
        statusCode: 409,
        body: JSON.stringify({
          ok: false,
          error: "ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED_must_be_false",
          writes_performed: false
        })
      };
    }

    const probe = await probeRoyalCaribbeanSource({ maxPages: 1, pageSize: 5, includeFleet: true });
    const fleet = await fetchRoyalCaribbeanFleet();

    const payload = redactSecrets({
      ok: probe.ok === true && fleet.ok === true,
      mode: "production_read_only",
      runtime: "netlify",
      graph_url: GRAPH_URL,
      user_agent: USER_AGENT,
      upstream_http_status: probe.status || null,
      graphql_valid: probe.ok === true,
      sample_group_count: probe.returned_groups || 0,
      official_group_total: probe.total_official_groups || null,
      fleet_count: fleet.ships?.length || 0,
      authoritative_enumeration: false,
      authoritative_enumeration_requested: false,
      writes_performed: false,
      inventory_writes: false,
      maintenance_writes: false,
      deployed_commit_ref: process.env.COMMIT_REF || process.env.DEPLOY_ID || null,
      deploy_url: process.env.URL || process.env.DEPLOY_PRIME_URL || null,
      duration_ms: Date.now() - started
    });

    return {
      statusCode: payload.ok ? 200 : 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(payload)
    };
  } catch (error) {
    console.error("royal-caribbean-discovery-smoke", error.message || error);
    return {
      statusCode: error.statusCode || 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        ok: false,
        error: error.code || "smoke_failed",
        writes_performed: false,
        duration_ms: Date.now() - started
      })
    };
  }
};
