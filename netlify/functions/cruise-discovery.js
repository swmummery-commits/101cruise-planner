/**
 * Cruise Discovery Engine API (Sprint 11D).
 *
 * POST /.netlify/functions/cruise-discovery
 * Actions:
 *   dashboard | list_lines | list_destinations | list_runs | get_run |
 *   list_review | list_cruises | start_discovery | resolve_review | ignore_review
 *
 * Discovery never invents cruises/prices/itineraries. Unknown matches → review queue.
 */

const { requireAdmin } = require("./admin-auth");
const { discoverForCruiseLine } = require("./lib/cruise-discovery");

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

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server access is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

async function supabase(path, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const response = await fetch(`${url}/rest/v1/${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const msg = data?.message || data?.error || data?.msg || `HTTP ${response.status}`;
    const err = new Error(msg);
    err.statusCode = response.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function dashboard() {
  const today = new Date().toISOString().slice(0, 10);
  const [active, lines, runs, review, recentNew] = await Promise.all([
    supabase(
      `discovered_cruises?status=eq.active&or=(departure_date.is.null,departure_date.gte.${today})&select=id&limit=1000`
    ).catch(() => []),
    supabase("ci_cruise_lines?active=eq.true&select=id"),
    supabase(
      "cruise_discovery_runs?select=id,scope,status,stats,started_at,finished_at,created_at,cruise_line_id,destination_id&order=created_at.desc&limit=1"
    ),
    supabase("cruise_discovery_review_items?status=eq.pending&select=id&limit=1000"),
    supabase(
      `discovered_cruises?discovered_at=gte.${new Date(Date.now() - 7 * 864e5).toISOString()}&select=id,status&limit=1000`
    )
  ]);

  const lastRun = Array.isArray(runs) && runs[0] ? runs[0] : null;
  const newCount = (recentNew || []).filter((r) => r.status === "active" || r.status === "review_required")
    .length;
  const changed = Number(lastRun?.stats?.changed || 0);

  return {
    success: true,
    cards: {
      active_cruises: Array.isArray(active) ? active.length : 0,
      cruise_lines_scanned: Number(lastRun?.stats?.cruise_lines_scanned || lastRun?.stats?.lines_scanned || 0),
      last_discovery_run: lastRun?.finished_at || lastRun?.started_at || lastRun?.created_at || null,
      new_cruises: newCount,
      changed_cruises: changed,
      review_required: Array.isArray(review) ? review.length : 0,
      active_cruise_lines: Array.isArray(lines) ? lines.length : 0
    },
    last_run: lastRun
  };
}

async function listLines() {
  const rows = await supabase(
    "ci_cruise_lines?active=eq.true&select=id,name,slug,website_url,cruise_search_url,fleet_page_url,sold_by_101cruise&order=name.asc"
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
  const limit = Math.min(50, Math.max(5, Number(body.limit) || 20));
  const rows = await supabase(
    `cruise_discovery_runs?select=id,scope,status,stats,error_message,started_at,finished_at,created_at,cruise_line_id,destination_id&order=created_at.desc&limit=${limit}`
  );
  return { success: true, runs: rows || [] };
}

async function getRun(body) {
  const id = String(body.run_id || "").trim();
  if (!id) throw Object.assign(new Error("run_id is required"), { statusCode: 400 });
  const runs = await supabase(
    `cruise_discovery_runs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );
  const run = runs?.[0];
  if (!run) throw Object.assign(new Error("Run not found"), { statusCode: 404 });
  const review = await supabase(
    `cruise_discovery_review_items?run_id=eq.${encodeURIComponent(id)}&select=*&order=created_at.desc&limit=200`
  );
  return { success: true, run, review_items: review || [] };
}

async function listReview(body) {
  const status = String(body.status || "pending").trim();
  const limit = Math.min(200, Math.max(10, Number(body.limit) || 100));
  const rows = await supabase(
    `cruise_discovery_review_items?status=eq.${encodeURIComponent(status)}&select=*&order=created_at.desc&limit=${limit}`
  );
  return { success: true, items: rows || [] };
}

async function listCruises(body) {
  const limit = Math.min(200, Math.max(10, Number(body.limit) || 50));
  const status = String(body.status || "").trim();
  const destinationId = String(body.destination_id || "").trim();
  const parts = [`select=id,cruise_line_id,ship_id,destination_id,departure_date,nights,itinerary,brochure_fare_display,currency,official_url,status,match_confidence,review_reason,discovered_at,last_seen_at,last_changed_at&order=departure_date.asc.nullslast&limit=${limit}`];
  if (status) parts.unshift(`status=eq.${encodeURIComponent(status)}`);
  if (destinationId) parts.unshift(`destination_id=eq.${encodeURIComponent(destinationId)}`);
  const rows = await supabase(`discovered_cruises?${parts.join("&")}`);
  return { success: true, cruises: rows || [] };
}

function cruiseUpsertPayload(candidate) {
  return {
    cruise_line_id: candidate.cruise_line_id,
    ship_id: candidate.ship_id,
    destination_id: candidate.destination_id,
    departure_date: candidate.departure_date,
    return_date: candidate.return_date,
    nights: candidate.nights,
    departure_port: candidate.departure_port,
    itinerary: candidate.itinerary,
    brochure_fare: candidate.brochure_fare,
    currency: candidate.currency,
    brochure_fare_display: candidate.brochure_fare_display,
    official_url: candidate.official_url,
    source_url: candidate.source_url || candidate.official_url,
    external_key: candidate.external_key,
    status: candidate.status,
    match_confidence: candidate.match_confidence,
    review_reason: candidate.review_reason,
    raw_extract: candidate.raw_extract || {},
    last_seen_at: new Date().toISOString(),
    last_verified_at: candidate.status === "active" ? new Date().toISOString() : null
  };
}

async function upsertCandidate(candidate, stats) {
  const existing = await supabase(
    `discovered_cruises?external_key=eq.${encodeURIComponent(candidate.external_key)}&select=id,brochure_fare,brochure_fare_display,itinerary,status,departure_date,nights&limit=1`
  );
  const prev = existing?.[0];
  const payload = cruiseUpsertPayload(candidate);

  if (!prev) {
    payload.discovered_at = new Date().toISOString();
    payload.last_changed_at = new Date().toISOString();
    const created = await supabase("discovered_cruises", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload)
    });
    stats.new += 1;
    if (candidate.status === "active") stats.upserted_active += 1;
    else stats.upserted_review += 1;
    return created?.[0] || null;
  }

  const changed =
    String(prev.brochure_fare_display || "") !== String(payload.brochure_fare_display || "") ||
    String(prev.itinerary || "") !== String(payload.itinerary || "") ||
    String(prev.departure_date || "") !== String(payload.departure_date || "") ||
    Number(prev.nights || 0) !== Number(payload.nights || 0) ||
    prev.status !== payload.status;

  if (!changed) {
    await supabase(`discovered_cruises?id=eq.${encodeURIComponent(prev.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        last_seen_at: payload.last_seen_at,
        last_verified_at: payload.last_verified_at || undefined
      })
    });
    stats.unchanged += 1;
    return prev;
  }

  payload.last_changed_at = new Date().toISOString();
  await supabase(`discovered_cruises?id=eq.${encodeURIComponent(prev.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(payload)
  });
  stats.changed += 1;
  if (candidate.status === "active") stats.upserted_active += 1;
  else stats.upserted_review += 1;

  if (
    prev.brochure_fare_display &&
    payload.brochure_fare_display &&
    prev.brochure_fare_display !== payload.brochure_fare_display
  ) {
    return { id: prev.id, price_changed: true };
  }
  return { id: prev.id };
}

async function insertReviewItems(runId, items) {
  if (!items?.length) return;
  const rows = items.map((item) => ({
    run_id: runId,
    cruise_line_id: item.cruise_line_id || null,
    destination_id: item.destination_id || null,
    cruise_id: item.cruise_id || null,
    item_type: item.item_type,
    status: "pending",
    title: item.title || null,
    detail: item.detail || null,
    source_url: item.source_url || null,
    payload: item.payload || {}
  }));
  // Chunk inserts
  for (let i = 0; i < rows.length; i += 50) {
    await supabase("cruise_discovery_review_items", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 50))
    });
  }
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
        "Run Full Discovery from the Admin UI (it loops cruise lines). Or pass scope=cruise_line."
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

  const destinations = await supabase(
    "destinations?status=eq.published&select=id,name,slug,primary_region&order=name.asc"
  );
  const destScope = destinationId
    ? (destinations || []).find((d) => d.id === destinationId) || null
    : null;
  if (destinationId && !destScope) {
    throw Object.assign(new Error("Destination not found or not published"), { statusCode: 404 });
  }

  const runInsert = await supabase("cruise_discovery_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      scope: scope === "destination" ? "destination" : "cruise_line",
      cruise_line_id: cruiseLineId || null,
      destination_id: destinationId || null,
      status: "running",
      started_at: new Date().toISOString(),
      created_by: actor?.id || null,
      stats: {}
    })
  });
  const run = runInsert?.[0];
  if (!run?.id) throw new Error("Could not create discovery run");

  const aggregate = {
    lines_scanned: 0,
    cruise_lines_scanned: 0,
    search_hits: 0,
    candidates: 0,
    new: 0,
    changed: 0,
    unchanged: 0,
    upserted_active: 0,
    upserted_review: 0,
    review_items: 0
  };

  try {
    // Destination scope may include multiple lines — process at most one line per request
    // to stay within Netlify time limits. Admin full/destination loops client-side.
    const lineId = lineIds[0];
    if (!lineId) throw Object.assign(new Error("No cruise lines to scan"), { statusCode: 400 });

    const lines = await supabase(
      `ci_cruise_lines?id=eq.${encodeURIComponent(lineId)}&select=id,name,slug,website_url,cruise_search_url,fleet_page_url,active&limit=1`
    );
    const cruiseLine = lines?.[0];
    if (!cruiseLine) throw Object.assign(new Error("Cruise line not found"), { statusCode: 404 });

    const ships = await supabase(
      `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(lineId)}&active=eq.true&select=id,name,slug,official_ship_url,official_line_ship_id,ship_class,year_built,year_refurbished&order=name.asc`
    );

    const { candidates, reviewItems, stats } = await discoverForCruiseLine({
      cruiseLine,
      ships: ships || [],
      destinations: destinations || [],
      destination: destScope,
      fetchPages: true,
      maxResults: destScope ? 8 : 6
    });

    aggregate.lines_scanned = 1;
    aggregate.cruise_lines_scanned = 1;
    for (const key of Object.keys(stats || {})) {
      if (typeof stats[key] === "number") {
        aggregate[key] = (aggregate[key] || 0) + stats[key];
      }
    }

    for (const candidate of candidates) {
      const result = await upsertCandidate(candidate, aggregate);
      if (result?.price_changed) {
        reviewItems.push({
          item_type: "changed_price",
          title: `Price changed: ${candidate.ship_name || "cruise"} ${candidate.departure_date || ""}`,
          detail: `Brochure fare updated to ${candidate.brochure_fare_display}`,
          cruise_line_id: cruiseLine.id,
          destination_id: candidate.destination_id,
          cruise_id: result.id,
          source_url: candidate.official_url,
          payload: { external_key: candidate.external_key }
        });
      }
    }

    // Optionally apply suggested ship URLs only into review — never guess-write official_ship_url
    await insertReviewItems(run.id, reviewItems);
    aggregate.review_items = (aggregate.review_items || 0) + (reviewItems?.length || 0);

    await supabase(`cruise_discovery_runs?id=eq.${encodeURIComponent(run.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "completed",
        finished_at: new Date().toISOString(),
        stats: aggregate
      })
    });

    return {
      success: true,
      run_id: run.id,
      cruise_line_id: cruiseLine.id,
      cruise_line_name: cruiseLine.name,
      stats: aggregate,
      remaining_line_ids: lineIds.slice(1)
    };
  } catch (error) {
    await supabase(`cruise_discovery_runs?id=eq.${encodeURIComponent(run.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_message: error.message || "Discovery failed",
        stats: aggregate
      })
    }).catch(() => null);
    throw error;
  }
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
