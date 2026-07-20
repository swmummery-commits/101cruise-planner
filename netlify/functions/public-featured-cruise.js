/**
 * Public read-only Featured Cruise by public_slug.
 *
 * GET /.netlify/functions/public-featured-cruise?slug=<public_slug>
 *
 * Security:
 * - Only publication_status = published
 * - Airline prices and category codes are never returned
 * - Uses service role server-side only
 * - Returns resolved public-safe media only
 */

const MediaResolver = require("../../js/media-resolver.js");

function jsonResponse(statusCode, body) {
  const empty = body === "" || body == null;
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": empty ? "text/plain" : "application/json",
      "Cache-Control": "public, max-age=60"
    },
    body: empty ? "" : JSON.stringify(body)
  };
}

function cleanSlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 80);
}

async function supabaseGet(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server access is not configured");

  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_error) {
    data = null;
  }
  if (!response.ok) {
    throw new Error((data && data.message) || `Supabase HTTP ${response.status}`);
  }
  return data || [];
}

function buildDestinationStrip(departurePort, arrivalPort, existing) {
  if (existing) return String(existing).trim().toUpperCase();
  const dep = String(departurePort || "").trim().toUpperCase();
  const arr = String(arrivalPort || "").trim().toUpperCase();
  if (dep && arr) return `${dep} TO ${arr}`;
  return dep || arr || "";
}

function sanitizePricing(rows) {
  return [...(rows || [])]
    .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0))
    .map((row) => ({
      room_label: row.room_label || "",
      brochure_price: row.brochure_price == null ? null : Number(row.brochure_price),
      cruise_101_price: row.cruise_101_price == null ? null : Number(row.cruise_101_price),
      display_order: Number(row.display_order) || 0
      // airline_price and category intentionally omitted
    }));
}

function toPublicMedia(resolved) {
  if (!resolved || !resolved.url) return null;
  return {
    url: resolved.url,
    alt_text: resolved.altText || "",
    title: resolved.title || "",
    width: resolved.width == null ? null : resolved.width,
    height: resolved.height == null ? null : resolved.height,
    source: resolved.source || ""
  };
}

async function loadMediaById(id) {
  if (!id) return null;
  const rows = await supabaseGet(
    `media_library?id=eq.${encodeURIComponent(id)}&is_active=eq.true&select=id,title,alt_text,public_url,width,height,media_type,ship_id,destination_name,is_default,is_active&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function loadFallbackMediaLibrary(cruise) {
  const rows = [];
  if (cruise.cruise_ship_id) {
    const shipRows = await supabaseGet(
      `media_library?ship_id=eq.${encodeURIComponent(cruise.cruise_ship_id)}&media_type=eq.ship&is_active=eq.true&select=id,title,alt_text,public_url,width,height,media_type,ship_id,destination_name,is_default,is_active,ci_cruise_ships(name)`
    );
    rows.push(...(shipRows || []));
  }

  const candidates = MediaResolver.destinationCandidatesFromCruise({
    departure_port: cruise.departure_port,
    arrival_port: cruise.arrival_port,
    itinerary_summary: cruise.itinerary_summary,
    destination_name: cruise.destination_strip
  });
  if (candidates.length) {
    const destRows = await supabaseGet(
      `media_library?media_type=eq.destination&is_active=eq.true&select=id,title,alt_text,public_url,width,height,media_type,ship_id,destination_name,is_default,is_active&limit=200`
    );
    const wanted = new Set(candidates.map((c) => String(c).trim().toLowerCase()).filter(Boolean));
    for (const row of destRows || []) {
      if (wanted.has(String(row.destination_name || "").trim().toLowerCase())) {
        rows.push(row);
      }
    }
  }
  return rows;
}

function toPublicCruise(row, pricingRows, resolved) {
  const lineName = row.ci_cruise_lines?.name || "";
  const ship = row.ci_cruise_ships || {};
  const hero = toPublicMedia(resolved.hero);
  const routeMap = toPublicMedia(resolved.routeMap);

  return {
    headline: row.headline || "",
    destination_strip: buildDestinationStrip(row.departure_port, row.arrival_port, row.destination_strip),
    departure_port: row.departure_port || "",
    arrival_port: row.arrival_port || "",
    departure_date: row.departure_date || "",
    return_date: row.return_date || "",
    nights: row.nights == null ? null : Number(row.nights),
    cruise_line_name: lineName,
    ship_name: ship.name || "",
    hero,
    hero_image_url: hero?.url || "",
    hero_image_alt: hero?.alt_text || row.hero_image_alt || row.headline || "Cruise image",
    short_editorial: row.short_editorial || "",
    full_description: row.full_description || "",
    itinerary_summary: row.itinerary_summary || "",
    route_map: routeMap,
    route_map_image_url: routeMap?.url || "",
    alcohol_package: Boolean(row.alcohol_package),
    wifi: Boolean(row.wifi),
    gratuities: Boolean(row.gratuities),
    all_tours: Boolean(row.all_tours),
    all_dining: Boolean(row.all_dining),
    laundry: Boolean(row.laundry),
    onboard_credit: row.onboard_credit == null ? null : Number(row.onboard_credit),
    other_information: row.other_information || "",
    public_slug: row.public_slug || "",
    pricing: sanitizePricing(pricingRows)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method not allowed" });

  try {
    const slug = cleanSlug(event.queryStringParameters?.slug);
    if (!slug) return jsonResponse(404, { error: "not_found" });

    const select = [
      "id",
      "headline",
      "destination_strip",
      "departure_port",
      "arrival_port",
      "departure_date",
      "return_date",
      "nights",
      "short_editorial",
      "full_description",
      "itinerary_summary",
      "hero_image_url",
      "hero_image_alt",
      "hero_media_id",
      "use_ship_hero_image",
      "route_map_image_url",
      "route_map_media_id",
      "cruise_ship_id",
      "alcohol_package",
      "wifi",
      "gratuities",
      "all_tours",
      "all_dining",
      "laundry",
      "onboard_credit",
      "other_information",
      "public_slug",
      "publication_status",
      "ci_cruise_lines(name)",
      "ci_cruise_ships(id,name,hero_image_url)"
    ].join(",");

    const cruises = await supabaseGet(
      `featured_cruises?select=${encodeURIComponent(select)}&public_slug=eq.${encodeURIComponent(slug)}&publication_status=eq.published&limit=1`
    );
    const cruise = Array.isArray(cruises) ? cruises[0] : null;
    if (!cruise) return jsonResponse(404, { error: "not_found" });

    const [pricing, heroMedia, routeMapMedia, mediaLibrary] = await Promise.all([
      supabaseGet(
        `featured_cruise_pricing?select=room_label,brochure_price,cruise_101_price,display_order&featured_cruise_id=eq.${encodeURIComponent(cruise.id)}&order=display_order.asc`
      ),
      loadMediaById(cruise.hero_media_id),
      loadMediaById(cruise.route_map_media_id),
      loadFallbackMediaLibrary(cruise)
    ]);

    const resolved = MediaResolver.resolveCruiseImages(cruise, {
      mediaLibrary,
      ship: cruise.ci_cruise_ships || null,
      heroMedia,
      routeMapMedia
    });

    return jsonResponse(200, { cruise: toPublicCruise(cruise, pricing, resolved) });
  } catch (error) {
    console.error("public-featured-cruise error", error.message || error);
    return jsonResponse(500, { error: "unavailable" });
  }
};
