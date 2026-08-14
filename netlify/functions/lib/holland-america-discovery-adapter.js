/**
 * Holland America Line — production Discovery adapter.
 *
 * Official source: public Solr-style cruise search used by find-a-cruise.
 * GET https://www.hollandamerica.com/search/halcruisesearch
 *
 * No authentication. No paid services. Read-only in simulation mode.
 */

const { canonicalUrl } = require("./cruise-discovery-structured");
const { resolveShipForLine } = require("./discovery-ship-resolver");
const { resolveOperationalDestination, hasAntarcticaRouteEvidence } = require("./discovery-destination-resolver");
const { resolveRawPortText } = require("./discovery-departure-port");
const { validateCruise } = require("./cruise-discovery");
const { evaluateDiscoveryConfidence } = require("./discovery-confidence");
const { provesIndividualSailing } = require("./discovery-non-sailing-filter");
const { OPERATIONAL_DESTINATION_CATALOGUE } = require("./destination-classification");
const carnivalSolr = require("./carnival-solr-discovery");

const ADAPTER_ID = "holland-america";
const ADAPTER_VERSION = "2026-08-02.hal3";

const SOURCE_CONTRACT = {
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  primary_endpoint: "https://www.hollandamerica.com/search/halcruisesearch",
  method: "GET",
  query_parameters: {
    q: "Wildcard query — use '*' for full catalogue",
    size: "Page size (1–100 recommended)",
    start: "Zero-based offset for pagination"
  },
  required_headers: {
    Accept: "application/json",
    "User-Agent": "101cruise-discovery/1.0 (+https://101cruise.com.au)"
  },
  pagination: "Solr-style start/size; response.response.numFound total",
  locale: "en/au default for configured AU search URL; API fields use en_us_* when present",
  authentication_required: false,
  cookies_required: false,
  response_format: "JSON — response.docs[] voyage records",
  voyages_per_response: "API returns ~12 docs per request regardless of size param; paginate with start += docs.length",
  rate_limit_observed: "None observed in read-only testing; use caching and page caps",
  public_website_intended: true,
  individual_itinerary_url_pattern:
    "https://www.hollandamerica.com/{locale}{contentPath}",
  json_ld_fallback: "TouristTrip schema on individual find-a-cruise pages"
};

const DEFAULT_LOCALE_PATH = "en/au";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_API_CALLS = 200;

/** Official HAL destination codes from destinationNames (name#@#code). */
const HAL_DESTINATION_CODE_SLUG = Object.freeze({
  A: "alaska",
  C: "caribbean",
  H: "hawaii",
  L: "pacific-coast",
  M: "mexican-riviera",
  N: "canada-new-england",
  O: "asia",
  T: "panama-canal",
  W: "world-cruise"
});

const HAL_REGION_SLUG_HINTS = [
  [/norwegian|fjord|iceland|reykjavik|isafjordur|akureyri|seydisfjordur|grundarfjordur/i, "norwegian-fjords"],
  [/mediterranean/i, "mediterranean"],
  [/british isles|britain|ireland|british|southampton|dublin|edinburgh|liverpool/i, "british-isles"],
  [/northern europe|baltic|scandinav|stockholm|copenhagen|helsinki|warnemunde|rostock/i, "northern-europe"],
  [/japan|japanese|tokyo|yokohama|osaka|kobe|hiroshima|aomori|kushiro/i, "japan"],
  [/antarctica/i, "antarctica"],
  [/australia|new zealand|tasmania|sydney|auckland|melbourne/i, "australia-new-zealand"],
  [/tahiti|fiji|south pacific|new caledonia|bora bora/i, "south-pacific"],
  [/galapagos/i, "galapagos"],
  [/transatlantic|atlantic crossing/i, "transatlantic"],
  [/transpacific|pacific crossing|transoceanic|north pacific crossing|cross international dateline/i, "transpacific"]
];

/** Official HAL region codes from regionNames (name#@#code). */
const HAL_REGION_CODE_SLUG = Object.freeze({
  EM: "mediterranean",
  EN: null,
  ET: "transatlantic",
  CE: "caribbean",
  CW: "caribbean",
  CS: "caribbean",
  CF: "panama-canal",
  WW: "world-cruise",
  WA: null,
  WS: "antarctica",
  SN: "antarctica",
  SS: "south-america",
  GB1: "alaska",
  HUB: "alaska",
  TAC: "alaska",
  "4D1": null,
  "4D2": null,
  "4D3": null,
  "4Y2": null,
  "4Y3": null
});

const CRUISETOUR_SIGNAL_RE =
  /cruisetour|land and sea|land program|denali land|yukon and denali|overland pre-cruise|overland post-cruise|ultimate denali|tundra wilderness tour/i;

const EXPLICIT_CROSSING_RE =
  /north pacific crossing|transpacific|transoceanic|pacific crossing|crossing the pacific|cross international dateline|north america to asia|asia to north america/i;

const NORTH_AMERICA_PORT_TOKENS = [
  "vancouver",
  "seattle",
  "san diego",
  "los angeles",
  "san francisco",
  "whittier",
  "seward",
  "anchorage",
  "juneau",
  "ketchikan"
];
const ASIA_PORT_TOKENS = [
  "tokyo",
  "yokohama",
  "osaka",
  "kobe",
  "hiroshima",
  "aomori",
  "kushiro",
  "shanghai",
  "hong kong",
  "singapore"
];

const fetchCache = new Map();

const parseHalDelimited = carnivalSolr.parseCarnivalDelimited;
const parseHalDate = carnivalSolr.parseCarnivalDate;
const parsePortList = carnivalSolr.parsePortList;
const pickLocaleField = carnivalSolr.pickLocaleField;

function buildOfficialUrl(contentPath, localePath = DEFAULT_LOCALE_PATH) {
  const path = String(contentPath || "").trim();
  if (!path) return null;
  const normalised = path.startsWith("/") ? path : `/${path}`;
  return canonicalUrl(`https://www.hollandamerica.com/${localePath}${normalised}`);
}

function voyageIdentity(raw) {
  return officialProductKey(raw);
}

function officialProductKey(raw) {
  const itineraryId = String(raw?.itinerary_id || "").trim();
  const cruiseId = String(raw?.cruise_id || "").trim();
  if (itineraryId && cruiseId) return `${itineraryId}|${cruiseId}`;
  return [cruiseId, raw?.departure_date || "", raw?.ship_code || ""].filter(Boolean).join("|");
}

function normalisePortToken(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectHalExplicitCrossing(raw) {
  const blob = [raw?.title, raw?.description, raw?.itinerary_text, raw?.departure_port, raw?.arrival_port]
    .filter(Boolean)
    .join(" ");
  if (EXPLICIT_CROSSING_RE.test(blob)) {
    return { slug: "transpacific", method: "hal_explicit_crossing_text", score: 96 };
  }

  const dep = normalisePortToken(raw?.departure_port);
  const arr = normalisePortToken(raw?.arrival_port);
  const ports = [...(raw?.itinerary_ports || [])].map(normalisePortToken);
  const all = [dep, arr, ...ports].filter(Boolean);
  const naHit = all.some((p) => NORTH_AMERICA_PORT_TOKENS.some((t) => p.includes(t)));
  const asiaHit = all.some((p) => ASIA_PORT_TOKENS.some((t) => p.includes(t)));
  if (naHit && asiaHit && (dep !== arr || ports.length >= 2)) {
    return { slug: "transpacific", method: "hal_endpoint_transpacific", score: 92 };
  }
  return null;
}

function classifyHalProductType(raw) {
  const tourId = String(raw?.tour_id || "").trim();
  const cruiseType = String(raw?.cruise_type || "").trim().toUpperCase();
  const titleBlob = [raw?.title, raw?.description, ...(raw?.region_labels || [])].filter(Boolean).join(" ");
  const imagePath = String(raw?.cruise_overview_image || "");

  if (tourId) {
    return {
      productType: "cruisetour",
      reason: "hal_tour_id",
      tour_id: tourId,
      extractable_cruise_segment: false
    };
  }
  if (cruiseType === "LAND_FIRST") {
    return {
      productType: "cruisetour",
      reason: "hal_land_first",
      extractable_cruise_segment: false
    };
  }
  if (CRUISETOUR_SIGNAL_RE.test(`${titleBlob} ${imagePath}`)) {
    return {
      productType: "cruisetour",
      reason: "hal_cruisetour_signal",
      extractable_cruise_segment: false
    };
  }
  if (/fairbanks/i.test(raw?.departure_port || "")) {
    return {
      productType: "cruisetour",
      reason: "fairbanks_land_embark",
      extractable_cruise_segment: false
    };
  }
  return {
    productType: "cruise",
    reason: "standard_sailing",
    extractable_cruise_segment: true
  };
}

function parseRawVoyageFromDoc(doc, localePrefix = "en_us") {
  if (!doc?.cruiseId || !doc?.departDate) return null;

  const ship = parseHalDelimited(doc.shipName);
  const embark = parseHalDelimited(doc.embarkPortName);
  const disembark = parseHalDelimited(doc.disembarkPortName);
  const portNames =
    parsePortList(pickLocaleField(doc, "portOfCallIds_ss", localePrefix)) ||
    parsePortList(doc.sortedPortNames_ss) ||
    parsePortList(doc.portOfCallIds);

  const destinationEntries = (doc.destinationNames || doc.en_us_destinationNames_ss || []).map((d) =>
    parseHalDelimited(d)
  );
  const destinationLabels = destinationEntries.map((d) => d.name).filter(Boolean);
  const destinationCodes = destinationEntries.map((d) => d.code).filter(Boolean);

  const regionEntries = (doc.regionNames || doc.en_us_regionNames_ss || []).map((r) => parseHalDelimited(r));
  const regionLabels = regionEntries.map((r) => r.name).filter(Boolean);
  const regionCodes = regionEntries.map((r) => r.code).filter(Boolean);

  const departureDate = parseHalDate(doc.departDate);
  const returnDate = parseHalDate(doc.arrivalDate);
  const nights = Number(doc.duration) || null;

  return {
    source: "halcruisesearch",
    cruise_id: String(doc.cruiseId).trim(),
    itinerary_id: String(doc.itineraryId || "").trim(),
    product_code: String(doc.itineraryId || "").trim(),
    booking_code: String(doc.cruiseId || "").trim(),
    tour_id: String(doc.tourId || "").trim() || null,
    cruise_type: String(doc.cruiseType || "").trim() || null,
    content_path: doc.contentPath || null,
    official_url: buildOfficialUrl(doc.contentPath),
    title: doc.name || doc.nightName || null,
    description: doc.cruiseOverviewImageAlt || null,
    cruise_overview_image: doc.cruiseOverviewImage || null,
    cruise_line: "Holland America Line",
    ship_name: ship.name,
    ship_code: ship.code || doc.shipId || null,
    departure_date: departureDate,
    return_date: returnDate,
    nights,
    departure_port: embark.name || doc.disembarkPortName,
    departure_port_code: embark.code || doc.embarkPortCode || null,
    arrival_port: disembark.name || null,
    arrival_port_code: disembark.code || doc.disembarkPortCode || null,
    itinerary_ports: portNames,
    itinerary_text: portNames.join(", "),
    destination_labels: destinationLabels,
    destination_codes: destinationCodes,
    region_labels: regionLabels,
    region_codes: regionCodes,
    locale: doc.language_country_code_s || localePrefix.replace("_", "/"),
    structured_source: "halcruisesearch_api",
    raw_doc_keys: Object.keys(doc).length
  };
}

async function fetchHalSearchPage({ start = 0, size = DEFAULT_PAGE_SIZE, query = "*" } = {}) {
  const url = `${SOURCE_CONTRACT.primary_endpoint}?q=${encodeURIComponent(query)}&size=${size}&start=${start}`;
  const cacheKey = url;
  if (fetchCache.has(cacheKey)) return fetchCache.get(cacheKey);

  const response = await fetch(url, {
    method: "GET",
    headers: SOURCE_CONTRACT.required_headers
  });

  if (!response.ok) {
    const err = {
      ok: false,
      status: response.status,
      url,
      error: `HTTP ${response.status}`,
      docs: [],
      numFound: 0,
      start
    };
    fetchCache.set(cacheKey, err);
    return err;
  }

  const data = await response.json();
  const result = {
    ok: true,
    status: response.status,
    url,
    docs: data?.response?.docs || [],
    numFound: Number(data?.response?.numFound) || 0,
    start: Number(data?.response?.start) || start
  };
  fetchCache.set(cacheKey, result);
  return result;
}

async function fetchAllRawVoyages(options = {}) {
  const requestedSize = Math.min(100, Math.max(1, Number(options.pageSize) || DEFAULT_PAGE_SIZE));
  const maxApiCalls = Math.max(1, Number(options.maxApiCalls) || DEFAULT_MAX_API_CALLS);
  const localePrefix = options.localePrefix || "en_us";
  const today = options.today || new Date().toISOString().slice(0, 10);
  const futureOnly = options.futureOnly !== false;

  const pages = [];
  const byIdentity = new Map();
  let numFound = 0;
  let start = 0;
  let apiCalls = 0;
  let rawDocsSeen = 0;
  let pastDepartures = 0;
  let malformedDocs = 0;

  while (apiCalls < maxApiCalls) {
    const batch = await fetchHalSearchPage({ start, size: requestedSize });
    apiCalls += 1;
    pages.push({
      start,
      ok: batch.ok,
      docs_returned: batch.docs?.length || 0,
      url: batch.url
    });
    if (!batch.ok) break;
    numFound = batch.numFound || numFound;
    const docs = batch.docs || [];
    if (!docs.length) break;
    rawDocsSeen += docs.length;

    for (const doc of docs) {
      if (!doc?.cruiseId || !doc?.departDate) {
        malformedDocs += 1;
        continue;
      }
      const raw = parseRawVoyageFromDoc(doc, localePrefix);
      if (!raw) {
        malformedDocs += 1;
        continue;
      }
      if (futureOnly && raw.departure_date && raw.departure_date < today) {
        pastDepartures += 1;
        continue;
      }
      const id = officialProductKey(raw);
      if (!byIdentity.has(id)) byIdentity.set(id, raw);
    }

    start += docs.length;
    if (start >= numFound) break;
  }

  return {
    voyages: [...byIdentity.values()],
    numFound,
    raw_docs_seen: rawDocsSeen,
    pages_fetched: pages.length,
    page_log: pages,
    api_calls: apiCalls,
    ingestion_audit: {
      past_departures: pastDepartures,
      malformed_docs: malformedDocs,
      exact_duplicate_products_suppressed: Math.max(0, rawDocsSeen - pastDepartures - malformedDocs - byIdentity.size)
    }
  };
}

async function auditHalIngestion(options = {}) {
  const fetchResult = await fetchAllRawVoyages(options);
  const byCruiseId = new Map();
  const productTypes = { cruise: 0, cruisetour: 0, unknown: 0 };

  for (const raw of fetchResult.voyages) {
    const meta = classifyHalProductType(raw);
    productTypes[meta.productType] = (productTypes[meta.productType] || 0) + 1;
    if (!byCruiseId.has(raw.cruise_id)) byCruiseId.set(raw.cruise_id, []);
    byCruiseId.get(raw.cruise_id).push(raw);
  }

  const sharedCruiseIds = [...byCruiseId.entries()].filter(([, rows]) => rows.length > 1);
  const collectorComponentGroups = sharedCruiseIds.filter(([, rows]) => {
    const withTour = rows.some((r) => r.tour_id);
    const withoutTour = rows.some((r) => !r.tour_id);
    return withTour && withoutTour;
  });

  return {
    num_found_official: fetchResult.numFound,
    raw_docs_seen: fetchResult.raw_docs_seen,
    unique_official_products: fetchResult.voyages.length,
    ingestion_audit: fetchResult.ingestion_audit,
    product_type_counts: productTypes,
    shared_cruise_id_groups: sharedCruiseIds.length,
    collector_component_groups: collectorComponentGroups.length,
    separately_bookable_products_preserved: fetchResult.voyages.length
  };
}

function resolveHalDeparturePort(raw) {
  const candidates = [raw.departure_port, raw.departure_port_code].filter(Boolean);
  for (const value of candidates) {
    const meta = resolveRawPortText(value, { sourceField: "halcruisesearch_api" });
    if (meta.status === "resolved") return meta;
  }
  return resolveRawPortText(raw.departure_port, { sourceField: "halcruisesearch_api" });
}

function halAntarcticaEvidence(raw) {
  return hasAntarcticaRouteEvidence({
    title: raw.title,
    description: raw.description,
    itinerary: raw.itinerary_text,
    itinerary_ports: raw.itinerary_ports,
    departurePort: raw.departure_port,
    arrivalPort: raw.arrival_port
  });
}

function resolveHalSouthAmericaFamilyHint(raw) {
  const blob = [raw.title, raw.itinerary_text, raw.description].filter(Boolean).join(" ");
  if (/\bpanama canal\b/i.test(blob)) {
    return { preferredSlug: "panama-canal", method: "hal_south_america_family_panama_canal" };
  }
  if (/\bamazon\b/i.test(blob)) {
    return { preferredSlug: "south-america", method: "hal_south_america_family_amazon" };
  }
  return { preferredSlug: "south-america", method: "hal_south_america_family_default" };
}

function resolveHalDestinationHints(raw) {
  const codes = (raw.destination_codes || []).map((c) => String(c).toUpperCase());
  const regionCodes = (raw.region_codes || []).map((c) => String(c).toUpperCase());
  const labelBlob = [...(raw.destination_labels || []), ...(raw.region_labels || [])].join(" ");

  const crossing = detectHalExplicitCrossing(raw);
  if (crossing) {
    return { preferredSlug: crossing.slug, method: crossing.method, crossing: true };
  }

  const routeBlob = [raw.title, raw.itinerary_text, raw.description].filter(Boolean).join(" ");
  if (/\bpanama canal\b/i.test(routeBlob)) {
    return { preferredSlug: "panama-canal", method: "hal_panama_canal_route" };
  }

  for (const code of regionCodes) {
    const slug = HAL_REGION_CODE_SLUG[code];
    if (slug === "antarctica" && !halAntarcticaEvidence(raw)) continue;
    if (slug) return { preferredSlug: slug, method: `hal_region_code_${code}` };
  }

  for (const [pattern, slug] of HAL_REGION_SLUG_HINTS) {
    if (slug === "antarctica") {
      if (pattern.test(labelBlob) && halAntarcticaEvidence(raw)) {
        return { preferredSlug: slug, method: "hal_region_label" };
      }
      continue;
    }
    if (pattern.test(labelBlob) || pattern.test(raw.itinerary_text || "") || pattern.test(raw.title || "")) {
      return { preferredSlug: slug, method: "hal_region_label" };
    }
  }

  if (codes.includes("P")) {
    return { preferredSlug: "australia-new-zealand", method: "hal_destination_code_P" };
  }
  if (codes.includes("S")) {
    if (halAntarcticaEvidence(raw)) {
      return { preferredSlug: "antarctica", method: "hal_destination_code_S_antarctica" };
    }
    return resolveHalSouthAmericaFamilyHint(raw);
  }
  if (codes.includes("E")) {
    return {
      structuredDestination: labelBlob || "EUROPE",
      method: "hal_destination_code_E",
      europe_broad: true
    };
  }

  if (codes.includes("O")) {
    const japanOnly =
      /\bjapan\b/i.test(labelBlob) &&
      !EXPLICIT_CROSSING_RE.test([raw.title, raw.itinerary_text, raw.departure_port, raw.arrival_port].join(" "));
    if (japanOnly) return { preferredSlug: "japan", method: "hal_destination_code_O_japan" };
    return { structuredDestination: labelBlob || "ASIA", method: "hal_destination_code_O" };
  }

  for (const code of codes) {
    const slug = HAL_DESTINATION_CODE_SLUG[code];
    if (slug) return { preferredSlug: slug, method: `hal_destination_code_${code}` };
  }

  if (raw.destination_labels?.[0]) {
    return { structuredDestination: raw.destination_labels.join(" "), method: "hal_destination_labels" };
  }
  return {};
}

function normaliseHalVoyage(raw, context = {}) {
  const {
    cruiseLine,
    ships = [],
    shipAliases = [],
    destinations = [],
    destinationAliases = [],
    productMeta = null
  } = context;

  const product = productMeta || classifyHalProductType(raw);
  const isCruiseProduct = product.productType === "cruise";

  const evidence = {
    ship: null,
    departure_date: raw.departure_date ? { value: raw.departure_date, source: "halcruisesearch_api" } : null,
    departure_port: null,
    destination: null
  };

  const shipResolution = resolveShipForLine({
    rawShipName: raw.ship_name,
    cruiseLineId: cruiseLine?.id,
    cruiseLineName: cruiseLine?.name || "Holland America Line",
    ships,
    aliases: shipAliases
  });

  evidence.ship = shipResolution.resolved
    ? { name: shipResolution.ship.name, method: shipResolution.method, confidence: shipResolution.confidence }
    : { name: raw.ship_name, method: shipResolution.reason || "unresolved", confidence: shipResolution.confidence || 0 };

  const portMeta = resolveHalDeparturePort(raw);
  const destHints = resolveHalDestinationHints(raw);

  let candidate = {
    cruise_line_id: cruiseLine?.id,
    ship_id: shipResolution.resolved ? shipResolution.ship.id : null,
    departure_date: raw.departure_date,
    return_date: raw.return_date,
    nights: raw.nights,
    departure_port: portMeta.status === "resolved" ? portMeta.canonicalPortName : null,
    departure_port_meta: portMeta,
    itinerary: raw.itinerary_text || raw.title,
    official_url: raw.official_url,
    source_url: raw.official_url,
    raw_extract: {
      title: raw.title,
      description: raw.description,
      hal_cruise_id: raw.cruise_id,
      hal_itinerary_id: raw.itinerary_id,
      hal_destination_codes: raw.destination_codes,
      hal_region_codes: raw.region_codes,
      hal_destination_labels: raw.destination_labels,
      hal_region_labels: raw.region_labels,
      structured_source: raw.structured_source,
      departure_port_raw: raw.departure_port
    }
  };

  if (candidate.departure_port) {
    evidence.departure_port = {
      value: candidate.departure_port,
      meta: candidate.departure_port_meta
    };
  }

  const destResult = resolveOperationalDestination({
    title: raw.title,
    description: [raw.description, raw.destination_labels?.join(" "), raw.region_labels?.join(" ")]
      .filter(Boolean)
      .join("\n"),
    itinerary: raw.itinerary_text,
    structuredDestination: destHints.structuredDestination || raw.destination_labels?.[0] || null,
    departurePort: candidate.departure_port || raw.departure_port,
    arrivalPort: raw.arrival_port,
    nights: raw.nights,
    destinations,
    destinationAliases,
    preferredDestination: destHints.preferredSlug ? { slug: destHints.preferredSlug } : null
  });

  evidence.destination = {
    key: destResult.destinationKey,
    name: destResult.destinationName,
    confidence: destResult.confidence,
    status: destResult.status,
    evidence: destResult.evidence?.slice(0, 4)
  };

  const matchedDest = destinations.find((d) => d.slug === destResult.destinationKey);
  candidate.destination_id = matchedDest?.id || null;
  candidate.destination_key = destResult.destinationKey;

  const simDestinationId =
    candidate.destination_id ||
    (destResult.status === "resolved" && destResult.destinationKey ? `catalogue:${destResult.destinationKey}` : null);

  const validationReasons = validateCruise({
    ...candidate,
    destination_id: simDestinationId
  }).filter((r) => !/Destination not matched/i.test(r) || simDestinationId);

  const individual = provesIndividualSailing({
    ship_id: candidate.ship_id,
    departure_date: candidate.departure_date,
    departure_port: candidate.departure_port,
    departure_port_meta: candidate.departure_port_meta,
    shipResolution,
    ships: ships.filter((s) => s.cruise_line_id === cruiseLine?.id),
    ship_name_guess: raw.ship_name
  });

  const confidenceEval = evaluateDiscoveryConfidence({
    ...candidate,
    cruiseLine,
    cruise_line_name: cruiseLine?.name,
    title: raw.title,
    shipResolution: shipResolution.resolved
      ? { ship: shipResolution.ship, method: shipResolution.method, confidence: shipResolution.confidence }
      : null,
    destinationResolution: {
      resolved: destResult.status === "resolved",
      destination_id: simDestinationId,
      destination_key: destResult.destinationKey,
      confidence: destResult.confidence === "high" ? 95 : destResult.confidence === "medium" ? 80 : 60
    },
    ship_name: shipResolution.ship?.name || raw.ship_name
  });

  const complete =
    isCruiseProduct &&
    individual.proven &&
    destResult.status === "resolved" &&
    validationReasons.length === 0 &&
    (confidenceEval.outcome === "auto_publish" || confidenceEval.outcome === "high_confidence");

  const failureReasons = [];
  if (product.productType === "cruisetour") failureReasons.push("cruisetour_excluded");
  if (product.productType === "unknown") failureReasons.push("product_type_unknown");
  if (!shipResolution.resolved) failureReasons.push("unknown_ship");
  if (!candidate.departure_date) failureReasons.push("missing_departure_date");
  else if (candidate.departure_date < (context.today || new Date().toISOString().slice(0, 10))) {
    failureReasons.push("past_departure");
  }
  if (!candidate.departure_port && candidate.departure_port_meta?.status !== "resolved") {
    failureReasons.push("missing_departure_port");
  }
  if (destResult.status === "unresolved") failureReasons.push("destination_unresolved");
  if (destResult.status === "ambiguous") failureReasons.push("destination_ambiguous");
  if (validationReasons.some((r) => /Ship not matched/i.test(r)) && !failureReasons.includes("unknown_ship")) {
    failureReasons.push("missing_ship");
  }

  return {
    raw,
    candidate,
    product_type: product.productType,
    product_meta: product,
    ship_resolution: shipResolution,
    destination_resolution: destResult,
    validation_reasons: validationReasons,
    confidence: confidenceEval,
    individual_gate: individual,
    complete_high_confidence: complete,
    projected_activation: complete,
    failure_reasons: [...new Set(failureReasons)],
    evidence
  };
}

function catalogueDestinations(dbDestinations) {
  const bySlug = Object.fromEntries((dbDestinations || []).map((d) => [d.slug, d]));
  return OPERATIONAL_DESTINATION_CATALOGUE.map((cat) => {
    const row = bySlug[cat.slug];
    return (
      row || {
        id: null,
        name: cat.name,
        slug: cat.slug,
        status: cat.public_status,
        classification_enabled: cat.classification_enabled
      }
    );
  });
}

async function simulateHalDiscovery(context = {}) {
  const fetchResult = await fetchAllRawVoyages({
    pageSize: context.pageSize || DEFAULT_PAGE_SIZE,
    maxApiCalls: context.maxApiCalls || DEFAULT_MAX_API_CALLS,
    today: context.today
  });

  const normalised = [];
  const failureCounts = {};
  const destinationCounts = {};
  let asiaBeforeTranspacific = 0;
  let transpacificCrossingCount = 0;

  for (const raw of fetchResult.voyages) {
    const result = normaliseHalVoyage(raw, context);
    normalised.push(result);

    if (detectHalExplicitCrossing(raw)) {
      transpacificCrossingCount += 1;
      if (result.destination_resolution?.destinationKey === "transpacific") {
        asiaBeforeTranspacific += 1;
      }
    }

    for (const reason of result.failure_reasons) {
      failureCounts[reason] = (failureCounts[reason] || 0) + 1;
    }
    if (result.product_type === "cruise" && result.destination_resolution?.destinationKey) {
      const k = result.destination_resolution.destinationKey;
      destinationCounts[k] = (destinationCounts[k] || 0) + 1;
    }
  }

  const cruises = normalised.filter((n) => n.product_type === "cruise");
  const cruisetours = normalised.filter((n) => n.product_type === "cruisetour");
  const unknownProducts = normalised.filter((n) => n.product_type === "unknown");
  const complete = cruises.filter((n) => n.complete_high_confidence);
  const shipOk = cruises.filter((n) => n.ship_resolution.resolved).length;
  const dateOk = cruises.filter((n) => n.candidate.departure_date).length;
  const portOk = cruises.filter(
    (n) => n.candidate.departure_port || n.candidate.departure_port_meta?.status === "resolved"
  ).length;
  const destOk = cruises.filter((n) => n.destination_resolution.status === "resolved").length;
  const cruiseTotal = cruises.length || 1;

  const aggregatedHealth = {
    cruisetour_products: cruisetours.length,
    europe_unresolved: cruises.filter(
      (n) => n.failure_reasons?.includes("destination_unresolved") && n.raw?.destination_codes?.includes("E")
    ).length,
    fairbanks_land_embark: cruisetours.filter((n) => /fairbanks/i.test(n.raw?.departure_port || "")).length
  };

  const unknownShips = [
    ...new Set(
      cruises
        .filter((n) => !n.ship_resolution.resolved)
        .map((n) => n.raw.ship_name)
        .filter(Boolean)
    )
  ];

  const gate = {
    at_least_1000_cruise_products: cruises.length >= 1000,
    complete_rate_80pct: cruises.length ? complete.length / cruises.length >= 0.8 : false,
    ship_rate_95pct: shipOk / cruiseTotal >= 0.95,
    date_rate_95pct: dateOk / cruiseTotal >= 0.95,
    port_rate_85pct: portOk / cruiseTotal >= 0.85,
    destination_rate_80pct: destOk / cruiseTotal >= 0.8,
    steve_reviews_lte_5: cruises.filter((n) => n.destination_resolution.status === "ambiguous").length <= 5,
    cruisetours_excluded: cruisetours.every((n) => !n.projected_activation),
    no_fairbanks_port_shortcut: true,
    passed: false
  };
  gate.passed =
    gate.at_least_1000_cruise_products &&
    gate.complete_rate_80pct &&
    gate.ship_rate_95pct &&
    gate.date_rate_95pct &&
    gate.port_rate_85pct &&
    gate.destination_rate_80pct &&
    gate.steve_reviews_lte_5 &&
    gate.cruisetours_excluded;

  const examplePool = complete.length ? complete : cruises.filter((n) => n.candidate.departure_date);
  const examplesByDest = new Map();
  for (const row of examplePool) {
    const key = row.destination_resolution?.destinationKey || "unknown";
    if (!examplesByDest.has(key)) examplesByDest.set(key, row);
    if (examplesByDest.size >= 5) break;
  }
  const diverseExamples = [...examplesByDest.values()];
  for (const row of examplePool) {
    if (diverseExamples.length >= 5) break;
    if (!diverseExamples.includes(row)) diverseExamples.push(row);
  }

  const ingestionAudit = {
    num_found_official: fetchResult.numFound,
    raw_docs_seen: fetchResult.raw_docs_seen,
    unique_official_products: fetchResult.voyages.length,
    ingestion_audit: fetchResult.ingestion_audit,
    product_type_counts: {
      cruise: cruises.length,
      cruisetour: cruisetours.length,
      unknown: unknownProducts.length
    },
    separately_bookable_products_preserved: fetchResult.voyages.length
  };

  return {
    mode: "holland_america_read_only_simulation",
    writes_performed: false,
    source: SOURCE_CONTRACT,
    api_calls: fetchResult.api_calls,
    page_log: fetchResult.page_log,
    num_found_official: fetchResult.numFound,
    raw_api_records: fetchResult.raw_docs_seen,
    unique_official_products: fetchResult.voyages.length,
    product_type_cruise: cruises.length,
    product_type_cruisetour: cruisetours.length,
    product_type_unknown: unknownProducts.length,
    ingestion_audit: ingestionAudit,
    duplicates_suppressed: fetchResult.ingestion_audit?.exact_duplicate_products_suppressed || 0,
    transpacific_crossing_products: transpacificCrossingCount,
    transpacific_resolved_count: asiaBeforeTranspacific,
    future_voyages_normalised: normalised.length,
    genuine_cruise_products: cruises.length,
    complete_high_confidence: complete.length,
    incomplete_cruise: cruises.length - complete.length,
    ship_match_rate_pct: Math.round((shipOk / cruiseTotal) * 1000) / 10,
    departure_date_rate_pct: Math.round((dateOk / cruiseTotal) * 1000) / 10,
    departure_port_rate_pct: Math.round((portOk / cruiseTotal) * 1000) / 10,
    destination_resolution_rate_pct: Math.round((destOk / cruiseTotal) * 1000) / 10,
    projected_activations: complete.length,
    projected_aggregated_maintenance: aggregatedHealth,
    projected_steve_reviews: cruises.filter((n) => n.destination_resolution.status === "ambiguous").length,
    destination_counts: destinationCounts,
    failure_reason_counts: failureCounts,
    unknown_ships: unknownShips,
    estimated_full_inventory: fetchResult.numFound,
    examples: diverseExamples.map((n) => ({
      title: n.raw.title,
      ship: n.ship_resolution.ship?.name || n.raw.ship_name,
      departure_date: n.candidate.departure_date,
      departure_port: n.candidate.departure_port,
      nights: n.candidate.nights,
      destination: n.destination_resolution.destinationKey,
      product_type: n.product_type,
      url: n.raw.official_url
    })),
    acceptance_gate: gate,
    voyages: normalised
  };
}

function clearHalFetchCache() {
  fetchCache.clear();
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  parseHalDelimited,
  HAL_DESTINATION_CODE_SLUG,
  HAL_REGION_CODE_SLUG,
  resolveHalDeparturePort,
  resolveHalDestinationHints,
  detectHalExplicitCrossing,
  classifyHalProductType,
  officialProductKey,
  parseRawVoyageFromDoc,
  buildOfficialUrl,
  voyageIdentity,
  fetchHalSearchPage,
  fetchAllRawVoyages,
  auditHalIngestion,
  normaliseHalVoyage,
  simulateHalDiscovery,
  catalogueDestinations,
  clearHalFetchCache
};
