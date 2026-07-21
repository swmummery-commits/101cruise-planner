/**
 * Shared Cruise Discovery persistence + one-line runs (Sprint 11D).
 * Used by the admin API and the weekly scheduled wave.
 */

const { discoverForCruiseLine } = require("./cruise-discovery");

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

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Mark past sailings as expired (never hard-delete — keep for reporting).
 * A sailing is expired when departure_date is before today.
 */
async function expireSailedCruises() {
  const today = todayIsoDate();
  const now = new Date().toISOString();
  let expiredCount = 0;

  // PostgREST caps rows per request; loop until none left.
  for (let pass = 0; pass < 50; pass += 1) {
    const rows = await supabase(
      `discovered_cruises?status=in.(active,review_required)&departure_date=lt.${today}&select=id`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          status: "expired",
          last_changed_at: now
        })
      }
    );
    const n = Array.isArray(rows) ? rows.length : 0;
    expiredCount += n;
    if (n === 0) break;
  }

  return {
    expired_count: expiredCount,
    as_of: today
  };
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
  for (let i = 0; i < rows.length; i += 50) {
    await supabase("cruise_discovery_review_items", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 50))
    });
  }
}

function emptyAggregate() {
  return {
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
}

/**
 * Run discovery for a single cruise line and persist results.
 */
async function discoverOneLine({
  cruiseLineId,
  destinationId = null,
  scope = "cruise_line",
  actor = null,
  triggeredBy = "admin"
} = {}) {
  if (!cruiseLineId) {
    throw Object.assign(new Error("cruise_line_id is required"), { statusCode: 400 });
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
      scope: scope === "destination" ? "destination" : scope === "full" ? "full" : "cruise_line",
      cruise_line_id: cruiseLineId,
      destination_id: destinationId || null,
      status: "running",
      started_at: new Date().toISOString(),
      created_by: actor?.id || null,
      stats: { triggered_by: triggeredBy }
    })
  });
  const run = runInsert?.[0];
  if (!run?.id) throw new Error("Could not create discovery run");

  const aggregate = emptyAggregate();

  try {
    const lines = await supabase(
      `ci_cruise_lines?id=eq.${encodeURIComponent(cruiseLineId)}&select=id,name,slug,website_url,cruise_search_url,fleet_page_url,active&limit=1`
    );
    const cruiseLine = lines?.[0];
    if (!cruiseLine) throw Object.assign(new Error("Cruise line not found"), { statusCode: 404 });

    const ships = await supabase(
      `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&active=eq.true&select=id,name,slug,official_ship_url,official_line_ship_id,ship_class,year_built,year_refurbished&order=name.asc`
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

    await insertReviewItems(run.id, reviewItems);
    aggregate.review_items = (aggregate.review_items || 0) + (reviewItems?.length || 0);
    aggregate.triggered_by = triggeredBy;

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
      stats: aggregate
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

async function listActiveSoldCruiseLineIds() {
  const lines = await supabase(
    "ci_cruise_lines?active=eq.true&sold_by_101cruise=eq.true&select=id,name&order=name.asc"
  );
  return (lines || []).map((l) => ({ id: l.id, name: l.name }));
}

module.exports = {
  supabase,
  expireSailedCruises,
  discoverOneLine,
  listActiveSoldCruiseLineIds,
  todayIsoDate
};
