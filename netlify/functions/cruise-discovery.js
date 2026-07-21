/**
 * Cruise Discovery Engine API (Sprint 11D).
 *
 * POST /.netlify/functions/cruise-discovery
 * Actions:
 *   dashboard | list_lines | list_destinations | list_runs | get_run |
 *   list_review | list_cruises | start_discovery | expire_sailed |
 *   resolve_review | ignore_review
 *
 * Discovery never invents cruises/prices/itineraries. Unknown matches → review queue.
 */

const { requireAdmin } = require("./admin-auth");
const {
  supabase,
  expireSailedCruises,
  discoverOneLine
} = require("./lib/cruise-discovery-runner");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

async function dashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const [active, lines, runs, review, recentNew] = await Promise.all([
    supabase(
      `discovered_cruises?status=eq.active&or=(departure_date.is.null,departure_date.gte.${today})&select=id&limit=1000`
    ).catch(() => []),
    supabase("ci_cruise_lines?active=eq.true&sold_by_101cruise=eq.true&select=id").catch(() => []),
    supabase(
      "cruise_discovery_runs?select=id,scope,status,stats,started_at,finished_at,created_at,cruise_line_id,destination_id&order=created_at.desc&limit=1"
    ).catch(() => []),
    supabase("cruise_discovery_review_items?status=eq.pending&select=id&limit=1000").catch(() => []),
    supabase(
      `discovered_cruises?discovered_at=gte.${new Date(Date.now() - 7 * 864e5).toISOString()}&select=id,status&limit=1000`
    ).catch(() => [])
  ]);

  const last = runs?.[0];
  const newCount = (recentNew || []).filter((r) => r.status === "active" || r.status === "review_required")
    .length;

  return {
    success: true,
    cards: {
      active_cruises: (active || []).length,
      active_cruise_lines: (lines || []).length,
      last_discovery_run: last?.finished_at || last?.started_at || last?.created_at || null,
      new_cruises: newCount,
      changed_cruises: last?.stats?.changed ?? 0,
      review_required: (review || []).length
    }
  };
}

async function listLines() {
  const rows = await supabase(
    "ci_cruise_lines?active=eq.true&sold_by_101cruise=eq.true&select=id,name,slug,website_url,cruise_search_url,fleet_page_url&order=name.asc"
  );
  return { success: true, cruise_lines: rows || [] };
}

async function listDestinations() {
  const rows = await supabase(
    "destinations?status=eq.published&select=id,name,slug,primary_region&order=display_order.asc,name.asc"
  );
  return { success: true, destinations: rows || [] };
}

async function listRuns(body) {
  const limit = Math.min(Number(body.limit) || 20, 50);
  const rows = await supabase(
    `cruise_discovery_runs?select=id,scope,status,stats,error_message,started_at,finished_at,created_at,cruise_line_id,destination_id&order=created_at.desc&limit=${limit}`
  );
  return { success: true, runs: rows || [] };
}

async function getRun(body) {
  const id = String(body.run_id || "").trim();
  if (!id) throw Object.assign(new Error("run_id is required"), { statusCode: 400 });
  const rows = await supabase(
    `cruise_discovery_runs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );
  const run = rows?.[0];
  if (!run) throw Object.assign(new Error("Run not found"), { statusCode: 404 });
  return { success: true, run };
}

async function listReview(body) {
  const limit = Math.min(Number(body.limit) || 50, 100);
  const status = String(body.status || "pending").trim();
  const rows = await supabase(
    `cruise_discovery_review_items?status=eq.${encodeURIComponent(status)}&select=*&order=created_at.desc&limit=${limit}`
  );
  return { success: true, items: rows || [] };
}

async function listCruises(body) {
  const limit = Math.min(Number(body.limit) || 50, 100);
  const status = String(body.status || "").trim();
  const destinationId = String(body.destination_id || "").trim();
  const parts = [`select=id,cruise_line_id,ship_id,destination_id,departure_date,nights,itinerary,brochure_fare_display,currency,official_url,status,match_confidence,review_reason,discovered_at,last_seen_at,last_changed_at&order=departure_date.asc.nullslast&limit=${limit}`];
  if (status) parts.unshift(`status=eq.${encodeURIComponent(status)}`);
  if (destinationId) parts.unshift(`destination_id=eq.${encodeURIComponent(destinationId)}`);
  const rows = await supabase(`discovered_cruises?${parts.join("&")}`);
  return { success: true, cruises: rows || [] };
}

async function startDiscovery(body, actor) {
  const scope = String(body.scope || "cruise_line").trim();
  const cruiseLineId = String(body.cruise_line_id || "").trim();
  const destinationId = String(body.destination_id || "").trim();

  if (scope === "cruise_line" && !cruiseLineId) {
    throw Object.assign(new Error("cruise_line_id is required for cruise_line scope"), {
      statusCode: 400
    });
  }
  if (scope === "destination" && !destinationId) {
    throw Object.assign(new Error("destination_id is required for destination scope"), {
      statusCode: 400
    });
  }
  if (scope === "full") {
    throw Object.assign(
      new Error(
        "Run Full Discovery from the Admin UI (it loops cruise lines), or rely on the weekly scheduled job."
      ),
      { statusCode: 400 }
    );
  }

  let lineIds = [];
  if (scope === "cruise_line") lineIds = [cruiseLineId];
  if (scope === "destination") {
    const lines = await supabase(
      "ci_cruise_lines?active=eq.true&sold_by_101cruise=eq.true&select=id&order=name.asc"
    );
    lineIds = (lines || []).map((l) => l.id);
    if (cruiseLineId) lineIds = [cruiseLineId];
  }

  const lineId = lineIds[0];
  if (!lineId) throw Object.assign(new Error("No cruise lines to scan"), { statusCode: 400 });

  const result = await discoverOneLine({
    cruiseLineId: lineId,
    destinationId: destinationId || null,
    scope,
    actor,
    triggeredBy: "admin"
  });

  return {
    ...result,
    remaining_line_ids: lineIds.slice(1)
  };
}

async function resolveReview(body, actor) {
  const id = String(body.review_id || "").trim();
  if (!id) throw Object.assign(new Error("review_id is required"), { statusCode: 400 });
  const applyShipUrl = body.apply_official_ship_url === true;

  const items = await supabase(
    `cruise_discovery_review_items?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );
  const item = items?.[0];
  if (!item) throw Object.assign(new Error("Review item not found"), { statusCode: 404 });

  if (applyShipUrl && item.item_type === "missing_ship_url") {
    const shipId = item.payload?.ship_id;
    const url = item.payload?.suggested_official_ship_url || item.source_url;
    if (shipId && url) {
      await supabase(`ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          official_ship_url: url,
          last_verified_at: new Date().toISOString()
        })
      });
    }
  }

  await supabase(`cruise_discovery_review_items?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by: actor?.id || null
    })
  });
  return { success: true, message: "Review item resolved." };
}

async function ignoreReview(body, actor) {
  const id = String(body.review_id || "").trim();
  if (!id) throw Object.assign(new Error("review_id is required"), { statusCode: 400 });
  await supabase(`cruise_discovery_review_items?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "ignored",
      resolved_at: new Date().toISOString(),
      resolved_by: actor?.id || null
    })
  });
  return { success: true, message: "Review item ignored." };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const actor = await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").trim();

    if (action === "dashboard") return jsonResponse(200, await dashboard());
    if (action === "list_lines") return jsonResponse(200, await listLines());
    if (action === "list_destinations") return jsonResponse(200, await listDestinations());
    if (action === "list_runs") return jsonResponse(200, await listRuns(body));
    if (action === "get_run") return jsonResponse(200, await getRun(body));
    if (action === "list_review") return jsonResponse(200, await listReview(body));
    if (action === "list_cruises") return jsonResponse(200, await listCruises(body));
    if (action === "start_discovery") return jsonResponse(200, await startDiscovery(body, actor));
    if (action === "expire_sailed") {
      const result = await expireSailedCruises();
      return jsonResponse(200, { success: true, ...result });
    }
    if (action === "resolve_review") return jsonResponse(200, await resolveReview(body, actor));
    if (action === "ignore_review") return jsonResponse(200, await ignoreReview(body, actor));

    return jsonResponse(400, { success: false, error: "Unknown action" });
  } catch (error) {
    console.error("cruise-discovery", error);
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || "Cruise discovery request failed"
    });
  }
};
