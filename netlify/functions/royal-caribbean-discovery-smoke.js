/**
 * Read-only Royal Caribbean International source smoke (Netlify runtime).
 *
 * POST /.netlify/functions/royal-caribbean-discovery-smoke
 * Header: x-discovery-cron-secret = DISCOVERY_CRON_SECRET
 */

const {
  probeRoyalCaribbeanSource,
  fetchRoyalCaribbeanFleet,
  USER_AGENT,
  GRAPH_URL
} = require("./lib/royal-caribbean-discovery-source");
const {
  enumerateMultiPageSizeUnion,
  AUTHORITATIVE_PAGE_SIZES
} = require("./lib/royal-caribbean-source-enumeration");

function cronSecret() {
  return String(process.env.DISCOVERY_CRON_SECRET || "").trim();
}

function assertCronAuth(event) {
  const expected = cronSecret();
  if (!expected) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.statusCode = 503;
    throw err;
  }
  const provided = String(
    event.headers?.["x-discovery-cron-secret"] ||
      event.headers?.["X-Discovery-Cron-Secret"] ||
      ""
  ).trim();
  if (provided !== expected) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

exports.handler = async (event) => {
  const started = Date.now();
  try {
    assertCronAuth(event);
    if (event.httpMethod && event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ ok: false, error: "method_not_allowed" }) };
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }
    if (body.mode && String(body.mode).trim() !== "production_read_only") {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "smoke_read_only_only" }) };
    }

    for (const flag of [
      "ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED",
      "ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED"
    ]) {
      if (String(process.env[flag] || "").toLowerCase() === "true") {
        return {
          statusCode: 409,
          body: JSON.stringify({ ok: false, error: `${flag}_must_be_false`, writesPerformed: false })
        };
      }
    }

    const authoritative = body.authoritative_enumeration === true;
    const probe = await probeRoyalCaribbeanSource({ maxPages: 1, pageSize: 5, includeFleet: true });
    const fleet = await fetchRoyalCaribbeanFleet();
    const union = await enumerateMultiPageSizeUnion({
      pageSizes: authoritative ? body.union_page_sizes || AUTHORITATIVE_PAGE_SIZES : [50],
      requestDelayMs: 0,
      stopAtTotal: !authoritative,
      untilEmpty: authoritative
    });

    const payload = {
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
      authoritative_enumeration_requested: authoritative,
      authoritative_union_page_sizes: union.page_sizes,
      authoritative_requests: union.passes?.reduce((n, pass) => n + (pass.pages_requested || 0), 0) || 0,
      authoritative_groups_union: union.unique_group_ids || 0,
      authoritative_sailing_ids_union: union.unique_sailing_ids || 0,
      writes_performed: false,
      inventory_writes: false,
      maintenance_writes: false,
      deployed_commit_ref: process.env.COMMIT_REF || process.env.DEPLOY_ID || null,
      deploy_url: process.env.URL || process.env.DEPLOY_PRIME_URL || null,
      duration_ms: Date.now() - started
    };

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
        error: "smoke_failed",
        writes_performed: false,
        duration_ms: Date.now() - started
      })
    };
  }
};
