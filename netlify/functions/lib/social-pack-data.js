/**
 * Load Featured Cruise data for Social Pack (public-safe pricing only).
 * Destination-first background resolution with deterministic rotation.
 */

const fs = require("fs");
const path = require("path");
const { PUBLIC_PRICING_SELECT, selectPublicOffer, selectPublicOffers } = require("./social-pack-pricing");
const {
  shortenHeadline,
  formatAuDateRange,
  formatAuDepartingFull,
  formatAuRangeFull,
  formatDuration,
  formatNightsLabel,
  buildRouteHeadline,
  buildAboardLine,
  cruiseFolderSlug,
  normaliseWhitespace
} = require("./social-pack-copy");
const { buildPortList, buildInclusions } = require("./social-pack-itinerary");
const { buildCaption } = require("./social-pack-caption");
const { fetchImageAsDataUri } = require("./social-pack-render");
const { publicObjectUrl } = require("./route-map-assets");
const {
  resolveSocialBackground,
  buildDestinationPickerSections
} = require("./social-pack-destination");

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server access is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

async function supabase(pathSuffix, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body != null) headers["Content-Type"] = "application/json";
  const response = await fetch(`${url}${pathSuffix}`, { ...options, headers });
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
    `/rest/v1/media_library?id=eq.${encodeURIComponent(id)}&select=id,title,public_url,alt_text,width,height,destination_name,media_type,is_default,is_active,created_at&limit=1`
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function loadActiveDestinationMedia() {
  const rows = await supabase(
    `/rest/v1/media_library?media_type=eq.destination&is_active=eq.true&select=id,title,public_url,alt_text,width,height,destination_name,media_type,is_default,is_active,created_at&order=created_at.asc&limit=500`
  );
  return Array.isArray(rows) ? rows : [];
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

function pickPrimaryInclusion(cruise, inclusions) {
  const list = inclusions || [];
  if (list.length) return list[0];
  if (cruise.alcohol_package) return "Beverage package";
  if (cruise.wifi) return "Wi‑Fi";
  if (cruise.gratuities) return "Gratuities";
  if (cruise.all_dining) return "Specialty dining";
  if (cruise.all_tours) return "Shore tours";
  return "";
}

function assessReadiness(model) {
  const warnings = [];
  if (!model.backgroundUrl && !model.heroUrl) {
    return {
      status: "blocked",
      label: "Cannot generate — no safe destination image",
      warnings: model.backgroundWarning ? [model.backgroundWarning] : warnings
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
  if (model.backgroundWarning) warnings.push(model.backgroundWarning);
  if (!model.routeMapUrl) warnings.push("no_route_map");
  if (!model.offers?.length) warnings.push("no_public_price");
  if (!model.publicSlug) warnings.push("no_public_slug");

  if (!model.routeMapUrl && model.offers?.length) {
    return {
      status: "ready_fallback_map",
      label: "Ready — no route map, itinerary layout will be used",
      warnings
    };
  }
  if (model.routeMapUrl && !model.offers?.length) {
    return {
      status: "ready_enquiry",
      label: "Ready — no public price, enquiry version will be used",
      warnings
    };
  }
  if (!model.routeMapUrl && !model.offers?.length) {
    return {
      status: "ready_fallback_both",
      label: "Ready — no route map, itinerary layout will be used",
      warnings
    };
  }
  return { status: "ready", label: "Ready", warnings };
}

function loadBrandLogoDataUri() {
  const candidates = [
    path.join(__dirname, "../../../assets/101cruise-logo.png"),
    path.join(process.cwd(), "assets/101cruise-logo.png")
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const buf = fs.readFileSync(file);
        return {
          dataUri: `data:image/png;base64,${buf.toString("base64")}`,
          path: file
        };
      }
    } catch {
      /* continue */
    }
  }
  return { dataUri: null, path: null };
}

async function loadFeaturedCruisePackModel(featuredCruiseId, options = {}) {
  const id = String(featuredCruiseId || "").trim();
  if (!id) throw Object.assign(new Error("featured_cruise_id is required"), { statusCode: 400 });
  const index = options.index || 1;
  const manualMediaId = options.manualMediaId || options.social_media_id || null;
  const treatment = String(options.treatment || "soft").toLowerCase();

  const rows = await supabase(
    `/rest/v1/featured_cruises?id=eq.${encodeURIComponent(id)}&select=id,headline,destination_strip,departure_date,return_date,departure_port,arrival_port,nights,short_editorial,itinerary_summary,public_slug,publication_status,newsletter_number,display_order,hero_media_id,hero_image_url,hero_image_alt,route_map_media_id,route_map_image_url,route_map_png_path,route_map_status,cruise_line_id,cruise_ship_id,alcohol_package,wifi,gratuities,all_tours,all_dining,laundry,onboard_credit,other_information,ci_cruise_lines(name,logo_url),ci_cruise_ships(name,hero_image_url)&limit=1`
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
  const destinationMedia = await loadActiveDestinationMedia();
  const featuredHeroUrl = heroMedia?.public_url || String(cruise.hero_image_url || "").trim() || null;
  const routeMapUrl = resolveRouteMapUrl(cruise, mapMedia);
  const offers = selectPublicOffers(pricingRows || [], cruise.nights, 3);
  const offer = offers[0] || selectPublicOffer(pricingRows || [], cruise.nights);
  const portInfo = buildPortList({
    stops,
    itinerarySummary: cruise.itinerary_summary,
    departurePort: cruise.departure_port,
    arrivalPort: cruise.arrival_port,
    maxPorts: 16
  });
  const inclusions = buildInclusions(cruise, { max: 4 });
  const primaryInclusion = pickPrimaryInclusion(cruise, inclusions);
  const other = normaliseWhitespace(cruise.other_information || "");
  const otherLine =
    other && other.length <= 90 && /include|beer|wine|lunch|dinner|board/i.test(other)
      ? other
      : "";

  const background = resolveSocialBackground({
    cruise,
    ports: portInfo.ports,
    destinationMedia,
    manualMediaId,
    featuredHeroMedia: heroMedia,
    featuredHeroUrl,
    shipHero: cruise.ci_cruise_ships?.hero_image_url
      ? { url: cruise.ci_cruise_ships.hero_image_url }
      : null
  });

  const brandLogo = loadBrandLogoDataUri();
  const pickerSections = buildDestinationPickerSections({
    cruise,
    ports: portInfo.ports,
    destinationMedia,
    featuredHeroMedia: heroMedia
  });

  const model = {
    id: cruise.id,
    newsletterNumber: cruise.newsletter_number,
    displayOrder: cruise.display_order,
    headline: cruise.headline || "",
    headlineShort: shortenHeadline(cruise.headline || ""),
    destinationStrip: String(cruise.destination_strip || "").toUpperCase(),
    routeHeadline: buildRouteHeadline(cruise.departure_port, cruise.arrival_port),
    aboardLine: buildAboardLine(cruise.ci_cruise_lines?.name, cruise.ci_cruise_ships?.name),
    departureDate: cruise.departure_date,
    returnDate: cruise.return_date,
    dateRange: formatAuDateRange(cruise.departure_date, cruise.return_date),
    dateRangeFull: formatAuRangeFull(cruise.departure_date, cruise.return_date),
    departingLabel: formatAuDepartingFull(cruise.departure_date),
    nights: cruise.nights,
    durationLabel: formatDuration(cruise.nights),
    nightsLabel: formatNightsLabel(cruise.nights),
    departurePort: cruise.departure_port || "",
    arrivalPort: cruise.arrival_port || "",
    journeyLine: [cruise.departure_port, cruise.arrival_port].filter(Boolean).join(" → "),
    journeyArrow: [cruise.departure_port, cruise.arrival_port]
      .filter(Boolean)
      .map((p) => String(p).replace(/,.*$/, "").trim().toUpperCase())
      .join(" → "),
    lineName: cruise.ci_cruise_lines?.name || "",
    cruiseLineLogoUrl: cruise.ci_cruise_lines?.logo_url || null,
    shipName: cruise.ci_cruise_ships?.name || "",
    shortEditorial: cruise.short_editorial || "",
    itinerarySummary: cruise.itinerary_summary || "",
    publicSlug: cruise.public_slug || "",
    publicationStatus: cruise.publication_status || "",
    heroUrl: featuredHeroUrl,
    heroAlt: heroMedia?.alt_text || cruise.hero_image_alt || "",
    heroWidth: heroMedia?.width || null,
    heroHeight: heroMedia?.height || null,
    backgroundUrl: background.media?.public_url || null,
    backgroundMediaId: background.media?.id || null,
    backgroundTitle: background.media?.title || null,
    backgroundWidth: background.media?.width || null,
    backgroundHeight: background.media?.height || null,
    backgroundSource: background.source,
    backgroundMatchRole: background.matchRole,
    backgroundDestinationKey: background.destinationKey,
    backgroundCandidateCount: background.candidateCount,
    backgroundRotationIndex: background.rotationIndex,
    backgroundWarning: background.warning,
    backgroundCandidates: (background.candidates || []).map((m) => ({
      id: m.id,
      title: m.title,
      destination_name: m.destination_name,
      public_url: m.public_url,
      is_default: Boolean(m.is_default)
    })),
    pickerSections: Object.fromEntries(
      Object.entries(pickerSections).map(([k, list]) => [
        k,
        (list || []).map((m) => ({
          id: m.id,
          title: m.title,
          destination_name: m.destination_name,
          public_url: m.public_url,
          is_default: Boolean(m.is_default)
        }))
      ])
    ),
    treatment,
    slideTreatments: {
      main: treatment,
      journey: treatment === "clear" ? "soft" : treatment,
      offer: "strong",
      cta: "strong"
    },
    routeMapUrl,
    offer,
    offers,
    ports: portInfo.ports,
    portsTruncated: portInfo.truncated,
    portsOmitted: portInfo.omitted,
    inclusions,
    primaryInclusion,
    otherLine,
    brandLogoPath: brandLogo.path,
    brandLogoDataUri: brandLogo.dataUri,
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
  const bgUrl = model.backgroundUrl || model.heroUrl;
  if (!bgUrl) {
    throw Object.assign(new Error("Cannot generate — no safe destination image."), {
      statusCode: 400,
      calm: true
    });
  }
  const background = await fetchImageAsDataUri(bgUrl);
  model.backgroundDataUri = background.dataUri;
  model.heroDataUri = background.dataUri;

  if (model.cruiseLineLogoUrl) {
    try {
      const logo = await fetchImageAsDataUri(model.cruiseLineLogoUrl);
      model.cruiseLineLogoDataUri = logo.dataUri;
    } catch {
      model.cruiseLineLogoDataUri = null;
    }
  }

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
  loadActiveDestinationMedia,
  loadBrandLogoDataUri,
  PUBLIC_PRICING_SELECT
};
