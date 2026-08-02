/**
 * Synchronous read-only HAL Discovery smoke test (production verification).
 *
 * POST /.netlify/functions/hal-discovery-smoke
 * Header: x-discovery-cron-secret = DISCOVERY_CRON_SECRET
 *
 * Always production_read_only. Never writes. Returns JSON (not 202).
 */

const { runHalDiscoveryBatch } = require("./lib/holland-america-discovery-batch");
const { catalogueDestinations } = require("./lib/holland-america-discovery-adapter");
const { supabase } = require("./lib/cruise-discovery-runner");
const { loadClassificationDestinations } = require("./lib/destination-queries");

const MAX_PAGES = 3;
const MAX_CANDIDATES = 40;

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
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "smoke_read_only_only" })
      };
    }

    const lines = await supabase(
      "ci_cruise_lines?slug=eq.holland-america-line&select=id,name,slug,website_url,cruise_search_url&limit=1"
    );
    const line = lines?.[0];
    if (!line) {
      return {
        statusCode: 404,
        body: JSON.stringify({ ok: false, error: "holland_america_line_not_found" })
      };
    }

    const [ships, destRows] = await Promise.all([
      supabase(
        `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id`
      ),
      loadClassificationDestinations(supabase)
    ]);

    const result = await runHalDiscoveryBatch({
      mode: "production_read_only",
      runId: `hal-smoke-${Date.now()}`,
      cursorStart: 0,
      maxPages: MAX_PAGES,
      maxCandidates: MAX_CANDIDATES,
      cruiseLine: line,
      ships: ships || [],
      destinations: catalogueDestinations(destRows || [])
    });

    const metrics = result.cruise_metrics || {};
    const stats = result.stats || {};
    const products = result.products || [];
    const cruises = products.filter((p) => p.product_type === "cruise");
    const transpacific = products.filter(
      (p) => p.destination_resolution?.destinationKey === "transpacific"
    ).length;
    const fairbanksCruise = products.filter(
      (p) => p.product_type === "cruise" && /fairbanks/i.test(p.raw?.departure_port || "")
    ).length;

    const payload = {
      ok: result.ok && !result.blocked,
      mode: "production_read_only",
      pagesFetched: stats.pages_fetched || 0,
      rawProducts: stats.products_parsed || stats.raw_docs_seen || 0,
      cruiseProducts: stats.product_type_cruise || metrics.genuine_cruise_products || 0,
      cruisetourProducts: stats.product_type_cruisetour || 0,
      completeHighConfidence: metrics.complete_high_confidence || 0,
      shipMatchRatePct: metrics.ship_match_rate_pct || null,
      portMatchRatePct: metrics.departure_port_rate_pct || null,
      destinationResolutionRatePct: metrics.destination_resolution_rate_pct || null,
      transpacificResolved: transpacific,
      fairbanksAsCruise: fairbanksCruise,
      nextCursor: result.cursor?.next_start ?? stats.next_cursor_start ?? null,
      writesPerformed: false,
      durationMs: Date.now() - started,
      blocked: result.blocked || false,
      reason: result.reason || null
    };

    return {
      statusCode: payload.ok ? 200 : result.blocked ? 409 : 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(payload)
    };
  } catch (error) {
    console.error("hal-discovery-smoke", error.message || error);
    return {
      statusCode: error.statusCode || 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        ok: false,
        error: "smoke_failed",
        writesPerformed: false,
        durationMs: Date.now() - started
      })
    };
  }
};
