/**
 * Public read-only Featured Cruise by public_slug.
 *
 * GET /.netlify/functions/public-featured-cruise?slug=<public_slug>
 *
 * Security:
 * - Only publication_status = published
 * - Airline prices and category codes are never returned
 * - Uses service role server-side only
 */

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

function toPublicCruise(row, pricingRows) {
  const lineName = row.ci_cruise_lines?.name || "";
  const ship = row.ci_cruise_ships || {};
  const heroUrl =
    row.use_ship_hero_image !== false
      ? ship.hero_image_url || row.hero_image_url || ""
      : row.hero_image_url || "";

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
    hero_image_url: heroUrl || "",
    hero_image_alt: row.hero_image_alt || row.headline || "Cruise image",
    short_editorial: row.short_editorial || "",
    full_description: row.full_description || "",
    itinerary_summary: row.itinerary_summary || "",
    route_map_image_url: row.route_map_image_url || "",
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
      "use_ship_hero_image",
      "route_map_image_url",
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
      "ci_cruise_ships(name,hero_image_url)"
    ].join(",");

    const cruises = await supabaseGet(
      `featured_cruises?select=${encodeURIComponent(select)}&public_slug=eq.${encodeURIComponent(slug)}&publication_status=eq.published&limit=1`
    );
    const cruise = Array.isArray(cruises) ? cruises[0] : null;
    if (!cruise) return jsonResponse(404, { error: "not_found" });

    const pricing = await supabaseGet(
      `featured_cruise_pricing?select=room_label,brochure_price,cruise_101_price,display_order&featured_cruise_id=eq.${encodeURIComponent(cruise.id)}&order=display_order.asc`
    );

    return jsonResponse(200, { cruise: toPublicCruise(cruise, pricing) });
  } catch (error) {
    console.error("public-featured-cruise error", error.message || error);
    return jsonResponse(500, { error: "unavailable" });
  }
};
