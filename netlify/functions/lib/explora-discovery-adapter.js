/**
 * Explora Journeys — production Discovery adapter.
 * Official source: explorajourneys.com journey sitemap + schema.org Trip detail pages.
 */

const { resolveShipForLine } = require("./discovery-ship-resolver");
const { resolveOperationalDestination } = require("./discovery-destination-resolver");
const { resolveRawPortText } = require("./discovery-departure-port");
const { validateCruise } = require("./cruise-discovery");
const { evaluateDiscoveryConfidence } = require("./discovery-confidence");
const { provesIndividualSailing } = require("./discovery-non-sailing-filter");
const { catalogueDestinations } = require("./holland-america-discovery-adapter");
const {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  EXPLORA_SHIP_CODE_NAME,
  officialProductKey,
  classifyProductType,
  fetchAllExploraRawJourneys
} = require("./explora-discovery-source");
const { partitionByPublicBookingCutoff } = require("./public-discovered-cruise-inventory");

const EXPLORA_LINE_NAME = "Explora Journeys";

/**
 * Region path code → operational destination slug, used only as a fallback when port/itinerary
 * evidence cannot resolve a destination on its own. Slugs must exist in
 * OPERATIONAL_DESTINATION_CATALOGUE; `ice` has no iceland-greenland entry so it falls back to
 * northern-europe, and soa/api/pac/tra have no single safe catalogue slug.
 */
const EXPLORA_REGION_DESTINATION_SLUG = Object.freeze({
  car: "caribbean",
  med: "mediterranean",
  ala: "alaska",
  ice: "northern-europe",
  can: "canada-new-england",
  fae: "asia",
  wor: "world-cruise",
  // Official "Central & North America Pacific Coast" → approved pacific-coast taxonomy.
  pac: "pacific-coast",
  // Red Sea / South America / Grand Journeys have no single approved taxonomy slug yet —
  // leave null so port/itinerary evidence (or unresolved reporting) owns the decision.
  soa: null,
  api: null,
  tra: null
});

const EXPLORA_REGION_LABEL = Object.freeze({
  car: "Caribbean",
  med: "Mediterranean",
  ala: "Alaska",
  ice: "Iceland, Greenland and Northern Europe",
  can: "Canada and New England",
  fae: "Far East and Asia",
  wor: "World Cruise",
  soa: "South America",
  api: "Red Sea and Arabian Peninsula",
  pac: "Pacific and Mexico",
  tra: "Grand Journey"
});

/** Official Explora embarkation codes → canonical catalogue names (reviewed, not auto-aliases). */
const EXPLORA_PORT_CODE_MAP = Object.freeze({
  NYC: "New York",
  CVV: "Civitavecchia",
  FSA: "Venice",
  PIR: "Piraeus",
  TYO: "Tokyo",
  VAN: "Vancouver",
  QUE: "Quebec City",
  REY: "Reykjavik",
  SOU: "Southampton",
  MIA: "Miami",
  SJU: "San Juan",
  BCN: "Barcelona",
  LIS: "Lisbon",
  DXB: "Dubai",
  IST: "Istanbul",
  SIN: "Singapore",
  HKG: "Hong Kong",
  LAX: "Los Angeles",
  CPH: "Copenhagen",
  BGI: "Bridgetown",
  GOA: "Genoa"
});

/** JSON-LD place names that need a reviewed rewrite before catalogue matching. */
const EXPLORA_PORT_ALIASES = Object.freeze({
  "new york city, united states": "New York",
  "fusina (venice), italy": "Venice",
  "venice (fusina), italy": "Venice",
  "civitavecchia (rome), italy": "Civitavecchia",
  "piraeus (athens), greece": "Piraeus",
  "warnemünde (rostock), germany": "Warnemunde",
  "warnemunde (rostock), germany": "Warnemunde",
  "berlin/warnemünde, germany": "Warnemunde",
  "berlin/warnemunde, germany": "Warnemunde",
  "bangkok/laem chabang, thailand": "Laem Chabang",
  "panama city (amador), panama": "Panama City",
  "valparaíso (santiago), chile": "Valparaiso",
  "valparaiso (santiago), chile": "Valparaiso"
});

function isEligibleExploraCruise(productType) {
  return productType === "ocean_cruise" || productType === "cruise";
}

function isExploraNonCruise(productType) {
  return productType === "non_cruise" || productType === "non_journey";
}

function resolveExploraDestinationHints(raw) {
  const region = String(raw?.region_code || "").toLowerCase();
  if (!region) return { fallbackSlug: null, regionLabel: null, method: "explora_region_missing" };
  return {
    fallbackSlug: EXPLORA_REGION_DESTINATION_SLUG[region] || null,
    regionLabel: EXPLORA_REGION_LABEL[region] || null,
    method: `explora_region_${region}`
  };
}

function resolveExploraDeparturePort(raw) {
  const codeName = EXPLORA_PORT_CODE_MAP[String(raw?.embark_code || "").trim().toUpperCase()] || null;
  const candidates = [raw?.departure_port, codeName, raw?.itinerary_ports?.[0]].filter(Boolean);
  for (const value of candidates) {
    const alias = EXPLORA_PORT_ALIASES[String(value).toLowerCase()];
    const meta = resolveRawPortText(alias || value, { sourceField: "explora_journey_jsonld" });
    if (meta.status === "resolved") return meta;
  }
  return resolveRawPortText(raw?.departure_port || codeName, { sourceField: "explora_journey_jsonld" });
}

function resolveExploraArrivalPort(raw) {
  const codeName = EXPLORA_PORT_CODE_MAP[String(raw?.disembark_code || "").trim().toUpperCase()] || null;
  const value = raw?.arrival_port || codeName;
  if (!value) return null;
  return EXPLORA_PORT_ALIASES[String(value).toLowerCase()] || value;
}

/**
 * The shared resolver reports a catalogue slug but drops the database id for hyphenated slugs,
 * so the classification row is looked up again by exact slug before the record is gated.
 */
function destinationRowIdForSlug(destinations, slug) {
  if (!slug) return null;
  const needle = String(slug).trim().toLowerCase();
  const row = (destinations || []).find((d) => String(d?.slug || "").toLowerCase() === needle && d?.id);
  return row ? row.id : null;
}

function normaliseExploraProduct(raw, context = {}) {
  const {
    cruiseLine,
    ships = [],
    shipAliases = [],
    destinations = [],
    destinationAliases = [],
    productMeta = null
  } = context;

  const product = productMeta || { productType: classifyProductType(raw) };
  const isCruiseProduct = isEligibleExploraCruise(product.productType);

  const evidence = {
    ship: null,
    departure_date: raw.departure_date
      ? { value: raw.departure_date, source: "explora_journey_id" }
      : null,
    departure_port: null,
    destination: null
  };

  const shipResolution = resolveShipForLine({
    rawShipName: raw.ship_name || EXPLORA_SHIP_CODE_NAME[raw.ship_code] || null,
    rawShipCode: raw.ship_code,
    cruiseLineId: cruiseLine?.id,
    cruiseLineName: cruiseLine?.name || EXPLORA_LINE_NAME,
    ships,
    aliases: shipAliases
  });

  evidence.ship = shipResolution.resolved
    ? { name: shipResolution.ship.name, method: shipResolution.method, confidence: shipResolution.confidence }
    : {
        name: raw.ship_name,
        method: shipResolution.reason || "unresolved",
        confidence: shipResolution.confidence || 0
      };

  const portMeta = resolveExploraDeparturePort(raw);
  const arrivalPort = resolveExploraArrivalPort(raw);
  const destHints = resolveExploraDestinationHints(raw);
  const itineraryLabel = String(raw.itinerary_name || "").trim() || raw.journey_id;
  const itineraryPortText = (raw.itinerary_ports || []).join(", ");

  const candidate = {
    cruise_line_id: cruiseLine?.id,
    ship_id: shipResolution.resolved ? shipResolution.ship.id : null,
    departure_date: raw.departure_date,
    return_date: raw.return_date,
    nights: raw.nights,
    departure_port: portMeta.status === "resolved" ? portMeta.canonicalPortName : null,
    departure_port_meta: portMeta,
    itinerary: itineraryLabel,
    official_url: raw.official_url,
    source_url: raw.official_url,
    raw_extract: {
      explora_journey_id: raw.journey_id,
      explora_itinerary_name: raw.itinerary_name || null,
      explora_ship_code: raw.ship_code,
      explora_region_code: raw.region_code || null,
      explora_slug: raw.slug || null,
      explora_embark_code: raw.embark_code || null,
      explora_disembark_code: raw.disembark_code || null,
      explora_itinerary_ports: raw.itinerary_ports || [],
      explora_product_type: product.productType,
      structured_source: raw.structured_source,
      departure_port_raw: raw.departure_port || null
    }
  };

  if (candidate.departure_port) {
    evidence.departure_port = { value: candidate.departure_port, meta: candidate.departure_port_meta };
  }

  const destinationInput = {
    title: itineraryLabel,
    description: [raw.description, destHints.regionLabel, itineraryPortText].filter(Boolean).join(" "),
    itinerary: itineraryPortText || candidate.itinerary,
    departurePort: candidate.departure_port || raw.departure_port,
    arrivalPort,
    nights: raw.nights,
    destinations,
    destinationAliases
  };

  let destResult = resolveOperationalDestination(destinationInput);
  let destMethod = "explora_itinerary_evidence";
  if (destResult.status !== "resolved" && destHints.fallbackSlug) {
    const fallback = resolveOperationalDestination({
      ...destinationInput,
      preferredDestination: { slug: destHints.fallbackSlug }
    });
    if (fallback.status === "resolved") {
      destResult = fallback;
      destMethod = destHints.method;
    }
  }

  evidence.destination = {
    key: destResult.destinationKey,
    name: destResult.destinationName,
    confidence: destResult.confidence,
    status: destResult.status,
    method: destMethod,
    evidence: destResult.evidence?.slice(0, 4)
  };

  candidate.destination_id =
    destResult.status === "resolved"
      ? destResult.destinationId || destinationRowIdForSlug(destinations, destResult.destinationKey)
      : null;
  candidate.raw_extract.explora_destination_method = destMethod;

  const validationReasons = validateCruise({
    ...candidate,
    destination_id: candidate.destination_id
  });

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
    cruise_line_name: cruiseLine?.name || EXPLORA_LINE_NAME,
    title: itineraryLabel,
    description: raw.description || null,
    url: candidate.official_url,
    official_url: candidate.official_url,
    official_sailing_id: officialProductKey(raw),
    shipResolution: shipResolution.resolved
      ? { ship: shipResolution.ship, method: shipResolution.method, confidence: shipResolution.confidence }
      : null,
    destinationResolution: {
      resolved: destResult.status === "resolved",
      destination_id: candidate.destination_id,
      destination_key: destResult.destinationKey,
      confidence: destResult.confidence === "high" ? 95 : destResult.confidence === "medium" ? 80 : 60
    },
    ship_name: shipResolution.ship?.name || raw.ship_name,
    ships: ships.filter((s) => s.cruise_line_id === cruiseLine?.id),
    ship_name_guess: raw.ship_name
  });

  const complete =
    isCruiseProduct &&
    shipResolution.resolved &&
    Boolean(candidate.departure_date) &&
    Boolean(candidate.destination_id) &&
    destResult.status === "resolved" &&
    portMeta.status === "resolved" &&
    individual.proven &&
    validationReasons.length === 0 &&
    (confidenceEval.outcome === "auto_publish" || confidenceEval.outcome === "high_confidence");

  const failureReasons = [];
  if (product.productType === "non_cruise") failureReasons.push("non_cruise_excluded");
  if (product.productType === "non_journey") failureReasons.push("non_journey_excluded");
  if (!shipResolution.resolved) failureReasons.push("unknown_ship");
  if (!candidate.departure_date) failureReasons.push("missing_departure_date");
  if (!candidate.departure_port && portMeta.status !== "resolved") failureReasons.push("missing_departure_port");
  if (!raw.detail_enriched) failureReasons.push("detail_page_not_enriched");
  if (destResult.status === "unresolved") failureReasons.push("destination_unresolved");
  if (destResult.status === "ambiguous") failureReasons.push("destination_ambiguous");
  if (destResult.status === "resolved" && !candidate.destination_id) {
    failureReasons.push("destination_missing_catalogue_id");
  }
  if (validationReasons.length) failureReasons.push(...validationReasons.map((r) => `validation:${r}`));
  if (confidenceEval.outcome !== "auto_publish" && confidenceEval.outcome !== "high_confidence") {
    failureReasons.push(`confidence:${confidenceEval.outcome}`);
  }
  if (!officialProductKey(raw)) failureReasons.push("missing_official_identity");

  return {
    raw,
    candidate,
    product_type: product.productType,
    product_meta: product,
    ship_resolution: shipResolution,
    destination_resolution: destResult,
    departure_port_resolution: portMeta,
    validation_reasons: validationReasons,
    confidence: confidenceEval,
    individual_gate: individual,
    complete_high_confidence: complete,
    projected_activation: complete,
    failure_reasons: [...new Set(failureReasons)],
    evidence,
    official_sailing_id: officialProductKey(raw)
  };
}

async function simulateExploraInventory(context = {}) {
  const today = context.today || new Date().toISOString().slice(0, 10);
  const fetchResult = await fetchAllExploraRawJourneys({
    today,
    futureOnly: true,
    enrich: context.enrich !== false,
    concurrency: context.concurrency,
    maxJourneys: context.maxJourneys,
    transport: context.transport
  });

  const normalised = [];
  const failureCounts = {};
  const destinationCounts = {};
  const unresolvedShips = new Set();
  const unresolvedPorts = new Set();
  const unresolvedDestinations = [];

  for (const raw of fetchResult.products || []) {
    const result = normaliseExploraProduct(raw, context);
    normalised.push(result);
    for (const reason of result.failure_reasons) {
      failureCounts[reason] = (failureCounts[reason] || 0) + 1;
    }
    if (isEligibleExploraCruise(result.product_type) && result.destination_resolution?.destinationKey) {
      const key = result.destination_resolution.destinationKey;
      destinationCounts[key] = (destinationCounts[key] || 0) + 1;
    }
    if (!result.ship_resolution?.resolved && raw.ship_name) unresolvedShips.add(raw.ship_name);
    if (result.departure_port_resolution?.status !== "resolved") {
      unresolvedPorts.add(raw.departure_port || raw.embark_code || "unknown");
    }
    if (result.destination_resolution?.status !== "resolved") {
      unresolvedDestinations.push({
        journey_id: raw.journey_id,
        region_code: raw.region_code,
        itinerary_name: raw.itinerary_name,
        status: result.destination_resolution?.status || "unresolved"
      });
    }
  }

  const cruises = normalised.filter((n) => isEligibleExploraCruise(n.product_type));
  const excluded = normalised.filter((n) => isExploraNonCruise(n.product_type));
  const complete = cruises.filter((n) => n.complete_high_confidence);
  const { publiclyEligible, withinCutoff } = partitionByPublicBookingCutoff(
    normalised,
    (p) => p.candidate?.departure_date,
    today
  );
  const publiclyEligibleComplete = publiclyEligible.filter(
    (n) => n.complete_high_confidence && isEligibleExploraCruise(n.product_type)
  );

  const cruiseTotal = cruises.length || 1;
  const shipOk = cruises.filter((n) => n.ship_resolution.resolved).length;
  const portOk = cruises.filter(
    (n) => n.candidate.departure_port || n.departure_port_resolution?.status === "resolved"
  ).length;
  const destOk = cruises.filter((n) => n.destination_resolution.status === "resolved").length;
  const identityOk = cruises.filter((n) => officialProductKey(n.raw)).length;

  return {
    ok: fetchResult.ok,
    fetch_failed: fetchResult.fetch_failed,
    num_found_official: fetchResult.num_found_official,
    raw_journey_count: fetchResult.raw_journey_count || fetchResult.products?.length || 0,
    products: normalised,
    voyages: normalised,
    publicly_eligible: publiclyEligible,
    within_public_cutoff: withinCutoff,
    complete_high_confidence: complete,
    metrics: {
      source_journeys: fetchResult.num_found_official,
      future_journeys: fetchResult.products?.length || 0,
      ocean_cruises: cruises.length,
      non_cruise_excluded: excluded.length,
      complete_high_confidence: complete.length,
      publicly_eligible_complete: publiclyEligibleComplete.length,
      within_public_cutoff: withinCutoff.length,
      ship_resolution_pct: (shipOk / cruiseTotal) * 100,
      departure_port_resolution_pct: (portOk / cruiseTotal) * 100,
      destination_resolution_pct: (destOk / cruiseTotal) * 100,
      identity_coverage_pct: (identityOk / cruiseTotal) * 100,
      failure_counts: failureCounts,
      destination_counts: destinationCounts,
      unresolved_ships: [...unresolvedShips],
      unresolved_departure_ports: [...unresolvedPorts],
      unresolved_destinations: unresolvedDestinations.slice(0, 50)
    },
    fetch_result: fetchResult,
    source_audit: fetchResult.audit || null,
    source_contract: SOURCE_CONTRACT
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  EXPLORA_LINE_NAME,
  EXPLORA_REGION_DESTINATION_SLUG,
  EXPLORA_REGION_LABEL,
  EXPLORA_PORT_CODE_MAP,
  EXPLORA_PORT_ALIASES,
  isEligibleExploraCruise,
  isExploraNonCruise,
  officialProductKey,
  resolveExploraDestinationHints,
  resolveExploraDeparturePort,
  normaliseExploraProduct,
  simulateExploraInventory,
  catalogueDestinations
};
