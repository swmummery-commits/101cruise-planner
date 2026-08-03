/**
 * Celebrity Cruises — evidence-based operational destination mapping.
 * Maps official RCG destination codes and itinerary evidence to operational destinations.
 * No Alaska fallback. Unresolved products are skipped, not sent to review.
 */

const CELEBRITY_RIVER_SHIP_CODES = Object.freeze(new Set(["RC", "RS", "RB", "RR", "RW"]));

const RIVER_ROUTE_RE =
  /danube|rhine|main river|nuremberg|vienna|budapest|basel|amsterdam|vilshofen|regensburg|brussels|oltenita|bucharest/i;

const EXPLICIT_CROSSING_RE =
  /transatlantic|transpacific|transoceanic|pacific crossing|crossing the pacific|cross international dateline|north america to asia|asia to north america|north pacific crossing/i;

const CELEBRITY_DESTINATION_CODE_SLUG = Object.freeze({
  ALCAN: "alaska",
  ATLCO: "canada-new-england",
  AUSTL: null,
  BAHAM: "caribbean",
  BERMU: "caribbean",
  CARIB: "caribbean",
  EUROP: null,
  "FAR.E": null,
  GALAP: "galapagos",
  HAWAI: "hawaii",
  ISLAN: null,
  PACIF: null,
  SAMER: null,
  "T.ATL": "transatlantic",
  "T.PAN": "panama-canal",
  TPACI: null
});

const ITINERARY_SLUG_HINTS = [
  [/norwegian fjord|geiranger|flam|bergen fjord/i, "norwegian-fjords"],
  [/british isles|britain|ireland|southampton|dublin|edinburgh|liverpool/i, "british-isles"],
  [/mediterranean|italy|spain|portugal|greece|croatia|malta|adriatic|aegean|santorini|barcelona|civitavecchia|ravenna/i, "mediterranean"],
  [/northern europe|baltic|scandinav|stockholm|copenhagen|helsinki|warnemunde|rostock/i, "northern-europe"],
  [/greenland|iceland|reykjavik/i, "norwegian-fjords"],
  [/japan|tokyo|yokohama|osaka|kobe|hiroshima|aomori|kushiro|south korea|seoul|busan/i, "japan"],
  [/antarctica/i, "antarctica"],
  [/australia|new zealand|tasmania|sydney|auckland|melbourne|brisbane/i, "australia-new-zealand"],
  [/tahiti|fiji|south pacific|new caledonia|bora bora|tahitian/i, "south-pacific"],
  [/galapagos|baltra|quito/i, "galapagos"],
  [/panama canal|canal transit/i, "panama-canal"],
  [/mexican riviera|mexico &|cabo|puerto vallarta|mazatlan/i, "mexican-riviera"],
  [/pacific coastal|coastal vancouver|los angeles to vancouver|vancouver to los angeles|seattle to/i, "pacific-coast"],
  [/world cruise|around the world/i, "world-cruise"],
  [/hawaii|honolulu|maui|kauai/i, "hawaii"],
  [/alaska|hubbard|dawes glacier|inside passage|ketchikan|juneau|sitka|skagway/i, "alaska"],
  [/canada|new england|boston|maine|quebec|montreal|halifax|saint john/i, "canada-new-england"],
  [/caribbean|bahamas|bermuda|key west|san juan|aruba|curacao|st\.?\s*thomas|grand turk/i, "caribbean"],
  [/transatlantic|transatl/i, "transatlantic"],
  [/transpacific|fiji transpacific|tahitian treasures/i, "transpacific"]
];

const NORTH_AMERICA_PORT_TOKENS = [
  "vancouver",
  "seattle",
  "san diego",
  "los angeles",
  "san francisco",
  "fort lauderdale",
  "miami",
  "tampa",
  "cape liberty",
  "boston",
  "honolulu"
];

const ASIA_PORT_TOKENS = [
  "tokyo",
  "yokohama",
  "osaka",
  "kobe",
  "singapore",
  "hong kong",
  "benoa",
  "bali",
  "shanghai",
  "beijing"
];

const EUROPE_PORT_TOKENS = [
  "barcelona",
  "rome",
  "civitavecchia",
  "venice",
  "athens",
  "piraeus",
  "southampton",
  "amsterdam",
  "copenhagen",
  "stockholm",
  "reykjavik",
  "ravenna"
];

function normaliseToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function itineraryBlob(raw) {
  return [
    raw?.itinerary_name,
    raw?.destination_name,
    raw?.departure_port,
    raw?.arrival_port
  ]
    .filter(Boolean)
    .join(" ");
}

function detectCrossingSlug(raw) {
  const blob = itineraryBlob(raw);
  if (/transatlantic|trans atl/i.test(blob)) return { slug: "transatlantic", method: "celebrity_crossing_name" };
  if (/transpacific|trans pacific|fiji transpacific/i.test(blob)) {
    return { slug: "transpacific", method: "celebrity_crossing_name" };
  }
  if (EXPLICIT_CROSSING_RE.test(blob)) {
    if (/transatl/i.test(blob)) return { slug: "transatlantic", method: "celebrity_crossing_regex" };
    return { slug: "transpacific", method: "celebrity_crossing_regex" };
  }

  const dep = normaliseToken(raw?.departure_port);
  const arr = normaliseToken(raw?.arrival_port || raw?.departure_port);
  const naDep = NORTH_AMERICA_PORT_TOKENS.some((t) => dep.includes(t));
  const euDep = EUROPE_PORT_TOKENS.some((t) => dep.includes(t));
  const asiaDep = ASIA_PORT_TOKENS.some((t) => dep.includes(t));
  const naArr = NORTH_AMERICA_PORT_TOKENS.some((t) => arr.includes(t));
  const euArr = EUROPE_PORT_TOKENS.some((t) => arr.includes(t));
  const asiaArr = ASIA_PORT_TOKENS.some((t) => arr.includes(t));

  if ((naDep && euArr) || (euDep && naArr)) {
    return { slug: "transatlantic", method: "celebrity_port_crossing" };
  }
  if ((naDep && asiaArr) || (asiaDep && naArr)) {
    return { slug: "transpacific", method: "celebrity_port_crossing" };
  }
  if (raw?.destination_code === "ISLAN") {
    const name = normaliseToken(raw?.itinerary_name);
    if (/fort lauderdale|cape liberty|boston to|to ft\.? lauderdale|to fort lauderdale/i.test(name)) {
      return null;
    }
  }
  return null;
}

function resolveAustralasiaSlug(raw) {
  const blob = itineraryBlob(raw);
  if (/south pacific|tahiti|fiji|tahitian|bora bora|new caledonia/i.test(blob)) {
    return { slug: "south-pacific", method: "celebrity_australasia_south_pacific" };
  }
  if (/australia|new zealand|tasmania|sydney|auckland|melbourne/i.test(blob)) {
    return { slug: "australia-new-zealand", method: "celebrity_australasia_route" };
  }
  return null;
}

function resolveFarEastSlug(raw) {
  const blob = itineraryBlob(raw);
  if (/japan|tokyo|yokohama|osaka|kobe|south korea|hiroshima/i.test(blob)) {
    return { slug: "japan", method: "celebrity_far_east_japan" };
  }
  return { slug: "asia", method: "celebrity_far_east_broad" };
}

function resolvePacificSlug(raw) {
  const blob = itineraryBlob(raw);
  if (/mexico|mexican|cabo|puerto vallarta|mazatlan/i.test(blob)) {
    return { slug: "mexican-riviera", method: "celebrity_pacific_mexico" };
  }
  return { slug: "pacific-coast", method: "celebrity_pacific_coastal" };
}

function resolveTranspacificSlug(raw) {
  const blob = itineraryBlob(raw);
  if (/tahiti|fiji|tahitian|south pacific/i.test(blob) && !/transpacific|trans pacific/i.test(blob)) {
    return { slug: "south-pacific", method: "celebrity_tpaci_south_pacific" };
  }
  return { slug: "transpacific", method: "celebrity_destination_code_TPACI" };
}

function isCelebrityRiverProduct(raw) {
  const code = String(raw?.ship_code || "").toUpperCase();
  if (CELEBRITY_RIVER_SHIP_CODES.has(code)) return true;
  if (String(raw?.voyage_type || "").toUpperCase() === "RIVER") return true;
  return false;
}

function extractRiverMetadata(raw) {
  const blob = itineraryBlob(raw);
  let river_name = null;
  if (/danube/i.test(blob)) river_name = "Danube";
  else if (/rhine|main river/i.test(blob)) river_name = "Rhine";
  return {
    river_name,
    river_region: river_name ? "Europe" : null,
    embarkation_city: raw?.departure_port || null,
    arrival_city: raw?.arrival_port || null,
    product_category: raw?.destination_name || null
  };
}

function resolveCelebrityRiverDestination(raw) {
  if (!isCelebrityRiverProduct(raw)) return null;
  if (!RIVER_ROUTE_RE.test(itineraryBlob(raw))) return null;
  return {
    slug: "european-river-cruises",
    method: "celebrity_river_evidence",
    ...extractRiverMetadata(raw)
  };
}

function resolveEuropeSlug(raw) {
  const blob = itineraryBlob(raw);
  for (const [pattern, slug] of ITINERARY_SLUG_HINTS) {
    if (pattern.test(blob) && ["norwegian-fjords", "british-isles", "mediterranean", "northern-europe"].includes(slug)) {
      return { slug, method: "celebrity_europe_itinerary" };
    }
  }
  return null;
}

function resolveCelebrityDestinationHints(raw) {
  const river = resolveCelebrityRiverDestination(raw);
  if (river) return river;
  if (isCelebrityRiverProduct(raw)) return null;

  const code = String(raw?.destination_code || "").toUpperCase();
  const crossing = detectCrossingSlug(raw);
  if (crossing?.slug) return crossing;

  const direct = CELEBRITY_DESTINATION_CODE_SLUG[code];
  if (direct) return { slug: direct, method: `celebrity_destination_code_${code}` };

  if (code === "AUSTL") {
    const au = resolveAustralasiaSlug(raw);
    if (au) return au;
  }
  if (code === "FAR.E") {
    return resolveFarEastSlug(raw);
  }
  if (code === "EUROP") {
    const eu = resolveEuropeSlug(raw);
    if (eu) return eu;
    return { structuredDestination: raw?.destination_name || "Europe", method: "celebrity_europe_unresolved" };
  }
  if (code === "PACIF") {
    return resolvePacificSlug(raw);
  }
  if (code === "TPACI") {
    return resolveTranspacificSlug(raw);
  }
  if (code === "ISLAN") {
    const eu = resolveEuropeSlug(raw);
    if (eu) return eu;
    const crossingRetry = detectCrossingSlug(raw);
    if (crossingRetry?.slug) return crossingRetry;
    return null;
  }
  if (code === "SAMER") {
    const blob = itineraryBlob(raw);
    if (/antarctica/i.test(blob)) return { slug: "antarctica", method: "celebrity_samer_antarctica" };
    return null;
  }

  for (const [pattern, slug] of ITINERARY_SLUG_HINTS) {
    if (pattern.test(itineraryBlob(raw))) {
      return { slug, method: "celebrity_itinerary_hint" };
    }
  }

  if (raw?.destination_name) {
    return { structuredDestination: raw.destination_name, method: "celebrity_destination_name" };
  }
  return null;
}

function hasAlaskaFallback() {
  return false;
}

module.exports = {
  CELEBRITY_RIVER_SHIP_CODES,
  CELEBRITY_DESTINATION_CODE_SLUG,
  isCelebrityRiverProduct,
  resolveCelebrityRiverDestination,
  resolveCelebrityDestinationHints,
  detectCrossingSlug,
  hasAlaskaFallback
};
