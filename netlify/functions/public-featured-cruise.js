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

const MediaResolver = require("./lib/media-resolver.js");
const { enrichPublicCruise } = require("./lib/research-public.js");

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

/** Match Admin featuredSlugify. */
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
    const detail =
      (data && (data.message || data.error || data.hint || data.details)) ||
      text ||
      `Supabase HTTP ${response.status}`;
    const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    err.statusCode = response.status;
    err.body = data;
    throw err;
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

function fallbackHeroFromRow(row) {
  const ship = row.ci_cruise_ships || {};
  const candidates = [
    { url: row.hero_image_url, source: "Featured Cruise image URL" },
    { url: ship.hero_image_url, source: "Legacy Cruise Intelligence image" }
  ];
  for (const candidate of candidates) {
    const url = String(candidate.url || "").trim();
    if (!url) continue;
    return {
      url,
      alt_text: row.hero_image_alt || row.headline || "Cruise image",
      title: row.headline || ship.name || "Cruise image",
      width: null,
      height: null,
      source: candidate.source
    };
  }
  return null;
}

function toPublicCruise(row, resolved) {
  const lineName = row.ci_cruise_lines?.name || "";
  const ship = row.ci_cruise_ships || {};
  const hero = toPublicMedia(resolved?.hero) || fallbackHeroFromRow(row);
  const routeMap =
    toPublicMedia(resolved?.routeMap) ||
    (String(row.route_map_image_url || "").trim()
      ? {
          url: String(row.route_map_image_url).trim(),
          alt_text: "Route map",
          title: "Route map",
          width: null,
          height: null,
          source: "Legacy route map URL"
        }
      : null);

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
    public_slug: row.public_slug || ""
    // Room pricing intentionally omitted from the public page payload.
  };
}

async function loadMediaById(id) {
  if (!id) return null;
  const select =
    "id,title,alt_text,public_url,width,height,media_type,ship_id,destination_name,is_default,is_active";
  try {
    const activeRows = await supabaseGet(
      `media_library?id=eq.${encodeURIComponent(id)}&is_active=eq.true&select=${select}&limit=1`
    );
    const active = Array.isArray(activeRows) ? activeRows[0] : null;
    if (active) return active;

    // Still return the row if present but inactive — Featured Cruise explicitly chose it.
    const anyRows = await supabaseGet(
      `media_library?id=eq.${encodeURIComponent(id)}&select=${select}&limit=1`
    );
    return Array.isArray(anyRows) ? anyRows[0] || null : null;
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
  } catch (error) {
    console.warn("public-featured-cruise ship media skipped", error.message || error);
  }
  return rows;
}

/**
 * Proven query shape from Sprint 10B, plus optional media columns.
 *
 * route_map_image_url is optional: some production databases may not yet have
 * that denormalised column. The canonical route-map source is route_map_media_id
 * (Media Library). Selecting a missing route_map_image_url fails the whole
 * query and drops into foundation fallbacks that omit route_map_media_id,
 * which loses the attached map on the public page.
 */
function cruiseSelect({
  includeMediaIds = false,
  includeRouteMapImageUrl = false,
  includeGeneratedRouteMap = false
} = {}) {
  return [
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
    ...(includeRouteMapImageUrl ? ["route_map_image_url"] : []),
    ...(includeGeneratedRouteMap
      ? [
          "route_map_svg_path",
          "route_map_png_path",
          "route_map_generated_at",
          "route_map_width",
          "route_map_height"
        ]
      : []),
    "cruise_ship_id",
    "cruise_line_id",
    ...(includeMediaIds ? ["hero_media_id", "route_map_media_id"] : []),
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
}

async function loadPublishedCruise(slug) {
  const attempts = [
    // Prefer media ids + generated Storage paths + denormalised URL
    cruiseSelect({
      includeMediaIds: true,
      includeRouteMapImageUrl: true,
      includeGeneratedRouteMap: true
    }),
    // Generated maps without legacy image URL column
    cruiseSelect({
      includeMediaIds: true,
      includeRouteMapImageUrl: false,
      includeGeneratedRouteMap: true
    }),
    // Prefer media ids + denormalised URL when both columns exist
    cruiseSelect({ includeMediaIds: true, includeRouteMapImageUrl: true }),
    // Production today: route_map_media_id exists, route_map_image_url may not
    cruiseSelect({ includeMediaIds: true, includeRouteMapImageUrl: false }),
    cruiseSelect({ includeMediaIds: false, includeRouteMapImageUrl: true }),
    cruiseSelect({ includeMediaIds: false, includeRouteMapImageUrl: false }),
    // Foundation columns with embeds (Sprint 10B shape) + media ids if present
    [
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
      "hero_image_url",
      "hero_image_alt",
      "use_ship_hero_image",
      "hero_media_id",
      "route_map_media_id",
      "public_slug",
      "publication_status",
      "ci_cruise_lines(name)",
      "ci_cruise_ships(name,hero_image_url)"
    ].join(","),
    // Foundation without media ids (Sprint 10B shape)
    [
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
      "hero_image_url",
      "hero_image_alt",
      "use_ship_hero_image",
      "public_slug",
      "publication_status",
      "ci_cruise_lines(name)",
      "ci_cruise_ships(name,hero_image_url)"
    ].join(","),
    // No embeds — survives broken FK relationship cache
    [
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
      "hero_image_url",
      "hero_image_alt",
      "use_ship_hero_image",
      "route_map_media_id",
      "public_slug",
      "publication_status",
      "cruise_line_id",
      "cruise_ship_id"
    ].join(","),
    // Minimal — proves table + slug filter work
    "id,headline,public_slug,publication_status,hero_image_url,hero_image_alt"
  ];

  let lastError = null;
  for (const select of attempts) {
    try {
      const path =
        `featured_cruises?select=${encodeURIComponent(select)}` +
        `&public_slug=eq.${encodeURIComponent(slug)}` +
        `&publication_status=eq.published` +
        `&limit=1`;
      const rows = await supabaseGet(path);
      return Array.isArray(rows) ? rows[0] || null : null;
    } catch (error) {
      lastError = error;
      console.warn("public-featured-cruise select attempt failed", error.message || error);
    }
  }
  throw lastError || new Error("Could not load featured cruise");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method not allowed" });

  try {
    const slug = cleanSlug(event.queryStringParameters?.slug);
    if (!slug) return jsonResponse(404, { error: "not_found" });

    const cruise = await loadPublishedCruise(slug);
    if (!cruise) return jsonResponse(404, { error: "not_found" });

    let resolved = { hero: null, routeMap: null };
    try {
      const [heroMedia, routeMapMedia, mediaLibrary] = await Promise.all([
        loadMediaById(cruise.hero_media_id),
        loadMediaById(cruise.route_map_media_id),
        loadFallbackMediaLibrary(cruise)
      ]);
      resolved = MediaResolver.resolveCruiseImages(cruise, {
        mediaLibrary,
        ship: cruise.ci_cruise_ships || null,
        heroMedia,
        routeMapMedia
      });
    } catch (error) {
      console.warn("public-featured-cruise media resolve skipped", error.message || error);
    }

    // Last-resort: if library media loaded but resolver returned nothing, use its URL directly.
    if (!resolved.hero && cruise.hero_media_id) {
      const direct = await loadMediaById(cruise.hero_media_id);
      if (direct?.public_url) {
        resolved.hero = {
          url: direct.public_url,
          altText: direct.alt_text || cruise.hero_image_alt || cruise.headline || "Cruise image",
          title: direct.title || cruise.headline || "",
          width: direct.width,
          height: direct.height,
          source: "Featured Cruise Media Library selection"
        };
      }
    }
    if (!resolved.routeMap && cruise.route_map_media_id) {
      const direct = await loadMediaById(cruise.route_map_media_id);
      if (direct?.public_url) {
        resolved.routeMap = {
          url: direct.public_url,
          altText: direct.alt_text || "Route map",
          title: direct.title || "Route map",
          width: direct.width,
          height: direct.height,
          source: "Featured Cruise Media Library selection"
        };
      }
    }

    // Generated Storage maps (Admin "Generate Route Map") when no Media Library/legacy URL.
    if (!resolved.routeMap) {
      const generated = MediaResolver.resolveRouteMapImage(cruise);
      if (generated?.url) resolved.routeMap = generated;
    }

    return jsonResponse(200, {
      cruise: await enrichPublicCruise(supabaseGet, cruise, toPublicCruise(cruise, resolved))
    });
  } catch (error) {
    const message = String(error.message || error);
    console.error("public-featured-cruise error", message);
    // Temporary diagnostic field so Admin can see the real failure without Netlify logs.
    return jsonResponse(500, {
      error: "unavailable",
      detail: message.slice(0, 240)
    });
  }
};
