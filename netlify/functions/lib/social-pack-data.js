/**
 * Load Featured Cruise data for Social Pack (public-safe pricing only).
 */

const { PUBLIC_PRICING_SELECT, selectPublicOffer } = require("./social-pack-pricing");
const {
  shortenHeadline,
  formatAuDateRange,
  formatDuration,
  cruiseFolderSlug,
  normaliseWhitespace
} = require("./social-pack-copy");
const { buildPortList, buildInclusions } = require("./social-pack-itinerary");
const { buildCaption } = require("./social-pack-caption");
const { fetchImageAsDataUri } = require("./social-pack-render");
const { publicObjectUrl } = require("./route-map-assets");

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
  if (options.body != null) headers["Content-Type"] = "application/json";
  const response = await fetch(`${url}${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }
  return data;
}

async function loadMedia(id) {
  if (!id) return null;
  const rows = await supabase(
    `/rest/v1/media_library?id=eq.${encodeURIComponent(id)}&select=id,title,public_url,alt_text,width,height&limit=1`
  );
  return Array.isArray(rows) ? rows[0] : null;
}

function resolveHeroUrl(cruise, heroMedia) {
  if (heroMedia?.public_url) return heroMedia.public_url;
  const legacy = String(cruise.hero_image_url || "").trim();
  return legacy || null;
}

function resolveRouteMapUrl(cruise, mapMedia) {
  if (mapMedia?.public_url) return mapMedia.public_url;
  const legacy = String(cruise.route_map_image_url || "").trim();
  if (legacy) return legacy;
  if (cruise.route_map_png_path) {
    return publicObjectUrl(cruise.route_map_png_path, { supabaseUrl: config().url });
  }
  return null;
}

function assessReadiness(model) {
  const warnings = [];
  if (!model.heroUrl) {
    return {
      status: "blocked",
      label: "Cannot generate — missing hero image",
      warnings
    };
  }
  const essentials =
    model.destinationStrip &&
    model.departureDate &&
    model.returnDate &&
    model.lineName &&
    model.shipName;
  if (!essentials) {
    return {
      status: "blocked",
      label: "Cannot generate — missing essential cruise information",
      warnings
    };
  }
  if (!model.routeMapUrl) {
    warnings.push("no_route_map");
  }
  if (!model.offer) {
    warnings.push("no_public_price");
  }
  if (!model.publicSlug) warnings.push("no_public_slug");

  if (!model.routeMapUrl && model.offer) {
    return {
      status: "ready_fallback_map",
      label: "Ready — no route map, itinerary layout will be used",
      warnings
    };
  }
  if (model.routeMapUrl && !model.offer) {
    return {
      status: "ready_enquiry",
      label: "Ready — no public price, enquiry version will be used",
      warnings
    };
  }
  if (!model.routeMapUrl && !model.offer) {
    return {
      status: "ready_fallback_both",
      label: "Ready — no route map, itinerary layout will be used",
      warnings
    };
  }
  return { status: "ready", label: "Ready", warnings };
}

async function loadFeaturedCruisePackModel(featuredCruiseId, { index = 1 } = {}) {
  const id = String(featuredCruiseId || "").trim();
  if (!id) throw Object.assign(new Error("featured_cruise_id is required"), { statusCode: 400 });

  const rows = await supabase(
    `/rest/v1/featured_cruises?id=eq.${encodeURIComponent(id)}&select=id,headline,destination_strip,departure_date,return_date,departure_port,arrival_port,nights,short_editorial,itinerary_summary,public_slug,publication_status,newsletter_number,display_order,hero_media_id,hero_image_url,hero_image_alt,route_map_media_id,route_map_image_url,route_map_png_path,route_map_status,cruise_line_id,cruise_ship_id,alcohol_package,wifi,gratuities,all_tours,all_dining,laundry,onboard_credit,other_information,ci_cruise_lines(name),ci_cruise_ships(name)&limit=1`
  );
  const cruise = Array.isArray(rows) ? rows[0] : null;
  if (!cruise) throw Object.assign(new Error("Featured cruise not found."), { statusCode: 404 });

  // Public-safe pricing only — never select airline_price or category.
  const pricingRows = await supabase(
    `/rest/v1/featured_cruise_pricing?featured_cruise_id=eq.${encodeURIComponent(id)}&select=${PUBLIC_PRICING_SELECT}&order=display_order.asc`
  );

  let stops = [];
  try {
    stops = await supabase(
      `/rest/v1/featured_cruise_itinerary_stops?featured_cruise_id=eq.${encodeURIComponent(id)}&select=stop_order,day_number,ports(name)&order=stop_order.asc`
    );
    stops = (stops || []).map((s) => ({
      stop_order: s.stop_order,
      day_number: s.day_number,
      port_label: s.ports?.name || ""
    }));
  } catch {
    stops = [];
  }

  const heroMedia = await loadMedia(cruise.hero_media_id);
  const mapMedia = await loadMedia(cruise.route_map_media_id);
  const heroUrl = resolveHeroUrl(cruise, heroMedia);
  const routeMapUrl = resolveRouteMapUrl(cruise, mapMedia);
  const offer = selectPublicOffer(pricingRows || [], cruise.nights);
  const portInfo = buildPortList({
    stops,
    itinerarySummary: cruise.itinerary_summary,
    departurePort: cruise.departure_port,
    arrivalPort: cruise.arrival_port
  });
  const inclusions = buildInclusions(cruise, { max: 4 });
  const other = normaliseWhitespace(cruise.other_information || "");
  const otherLine =
    other && other.length <= 90 && /include|beer|wine|lunch|dinner|board/i.test(other)
      ? other
      : "";

  const model = {
    id: cruise.id,
    newsletterNumber: cruise.newsletter_number,
    displayOrder: cruise.display_order,
    headline: cruise.headline || "",
    headlineShort: shortenHeadline(cruise.headline || ""),
    destinationStrip: String(cruise.destination_strip || "").toUpperCase(),
    departureDate: cruise.departure_date,
    returnDate: cruise.return_date,
    dateRange: formatAuDateRange(cruise.departure_date, cruise.return_date),
    nights: cruise.nights,
    durationLabel: formatDuration(cruise.nights),
    departurePort: cruise.departure_port || "",
    arrivalPort: cruise.arrival_port || "",
    journeyLine: [cruise.departure_port, cruise.arrival_port].filter(Boolean).join(" → "),
    lineName: cruise.ci_cruise_lines?.name || "",
    shipName: cruise.ci_cruise_ships?.name || "",
    shortEditorial: cruise.short_editorial || "",
    itinerarySummary: cruise.itinerary_summary || "",
    publicSlug: cruise.public_slug || "",
    publicationStatus: cruise.publication_status || "",
    heroUrl,
    heroAlt: heroMedia?.alt_text || cruise.hero_image_alt || "",
    heroWidth: heroMedia?.width || null,
    heroHeight: heroMedia?.height || null,
    routeMapUrl,
    offer,
    ports: portInfo.ports,
    portsTruncated: portInfo.truncated,
    portsOmitted: portInfo.omitted,
    inclusions,
    otherLine,
    folderSlug: cruiseFolderSlug({
      index,
      lineName: cruise.ci_cruise_lines?.name,
      shipName: cruise.ci_cruise_ships?.name,
      destinationStrip: cruise.destination_strip
    })
  };

  model.readiness = assessReadiness(model);
  model.caption = buildCaption(model);
  return model;
}

async function hydrateMedia(model) {
  if (!model.heroUrl) {
    throw Object.assign(new Error("Cannot generate — missing hero image."), {
      statusCode: 400,
      calm: true
    });
  }
  const hero = await fetchImageAsDataUri(model.heroUrl);
  model.heroDataUri = hero.dataUri;
  if (model.routeMapUrl) {
    try {
      const map = await fetchImageAsDataUri(model.routeMapUrl);
      model.routeMapDataUri = map.dataUri;
    } catch {
      model.routeMapDataUri = null;
      model.routeMapUrl = null;
      model.readiness = assessReadiness(model);
    }
  }
  return model;
}

async function listIssueCruiseIds(newsletterNumber) {
  const num = Number(newsletterNumber);
  if (!Number.isFinite(num)) return [];
  const rows = await supabase(
    `/rest/v1/featured_cruises?newsletter_number=eq.${encodeURIComponent(num)}&select=id,display_order,headline&order=display_order.asc`
  );
  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  loadFeaturedCruisePackModel,
  hydrateMedia,
  assessReadiness,
  listIssueCruiseIds,
  PUBLIC_PRICING_SELECT
};
