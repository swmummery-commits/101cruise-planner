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

const MediaResolver = require("./lib/media-resolver");

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

/** Match Admin featuredSlugify — convert separators to hyphens, do not strip them. */
function cleanSlug(raw) {
  return String(raw || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
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
  try {
    const rows = await supabaseGet(
      `media_library?id=eq.${encodeURIComponent(id)}&is_active=eq.true&select=id,title,alt_text,public_url,width,height,media_type,ship_id,destination_name,is_default,is_active&limit=1`
    );
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    console.warn("public-featured-cruise media by id skipped", error.message || error);
    return null;
  }
}

async function loadFallbackMediaLibrary(cruise) {
  const rows = [];
  try {
    if (cruise.cruise_ship_id) {
      const shipRows = await supabaseGet(
        `media_library?ship_id=eq.${encodeURIComponent(cruise.cruise_ship_id)}&media_type=eq.ship&is_active=eq.true&select=id,title,alt_text,public_url,width,height,media_type,ship_id,destination_name,is_default,is_active`
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
      const wanted = new Set(
        candidates.map((c) => String(c).trim().toLowerCase()).filter(Boolean)
      );
      for (const row of destRows || []) {
        if (wanted.has(String(row.destination_name || "").trim().toLowerCase())) {
          rows.push(row);
        }
      }
    }
  } catch (error) {
    console.warn("public-featured-cruise media library fallback skipped", error.message || error);
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

function buildCruiseQuery(slug, { includeMediaIds }) {
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
    ...(includeMediaIds ? ["hero_media_id", "route_map_media_id"] : []),
    "use_ship_hero_image",
    "route_map_image_url",
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

  const params = new URLSearchParams();
  params.set("select", select);
  params.set("public_slug", `eq.${slug}`);
  params.set("publication_status", "eq.published");
  params.set("limit", "1");
  return `featured_cruises?${params.toString()}`;
}

async function loadPublishedCruise(slug) {
  try {
    const rows = await supabaseGet(buildCruiseQuery(slug, { includeMediaIds: true }));
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    const message = String(error.message || error);
    // Migration not applied yet — retry without media FK columns.
    if (/hero_media_id|route_map_media_id|column/i.test(message)) {
      console.warn("public-featured-cruise retrying without media id columns", message);
      const rows = await supabaseGet(buildCruiseQuery(slug, { includeMediaIds: false }));
      return Array.isArray(rows) ? rows[0] || null : null;
    }
    throw error;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method not allowed" });

  try {
    const slug = cleanSlug(event.queryStringParameters?.slug);
    if (!slug) return jsonResponse(404, { error: "not_found" });

    const cruise = await loadPublishedCruise(slug);
    if (!cruise) return jsonResponse(404, { error: "not_found" });

    let pricing = [];
    try {
      pricing = await supabaseGet(
        `featured_cruise_pricing?select=room_label,brochure_price,cruise_101_price,display_order&featured_cruise_id=eq.${encodeURIComponent(cruise.id)}&order=display_order.asc`
      );
    } catch (error) {
      console.warn("public-featured-cruise pricing skipped", error.message || error);
    }

    const [heroMedia, routeMapMedia, mediaLibrary] = await Promise.all([
      loadMediaById(cruise.hero_media_id),
      loadMediaById(cruise.route_map_media_id),
      loadFallbackMediaLibrary(cruise)
    ]);

    let resolved = { hero: null, routeMap: null };
    try {
      resolved = MediaResolver.resolveCruiseImages(cruise, {
        mediaLibrary,
        ship: cruise.ci_cruise_ships || null,
        heroMedia,
        routeMapMedia
      });
    } catch (error) {
      console.warn("public-featured-cruise resolve skipped", error.message || error);
      const legacyHero = String(
        cruise.hero_image_url || cruise.ci_cruise_ships?.hero_image_url || ""
      ).trim();
      const legacyMap = String(cruise.route_map_image_url || "").trim();
      resolved = {
        hero: legacyHero
          ? {
              url: legacyHero,
              altText: cruise.hero_image_alt || cruise.headline || "Cruise image",
              title: cruise.headline || "",
              source: "Legacy image"
            }
          : null,
        routeMap: legacyMap
          ? { url: legacyMap, altText: "Route map", title: "Route map", source: "Legacy route map URL" }
          : null
      };
    }

    return jsonResponse(200, { cruise: toPublicCruise(cruise, pricing, resolved) });
  } catch (error) {
    console.error("public-featured-cruise error", error.message || error);
    return jsonResponse(500, { error: "unavailable" });
  }
};
