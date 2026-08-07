/**
 * Princess Cruises — production Discovery adapter.
 * Official source: Princess resdb products API (Polar Bear SPA backend).
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
  officialProductKey,
  officialGroupKey,
  classifyProductType,
  fetchAllPrincessRawSailings
} = require("./princess-discovery-source");
const { partitionByPublicBookingCutoff } = require("./public-discovered-cruise-inventory");

const PRINCESS_TRADE_CODE_SLUG = Object.freeze({
  A: "alaska",
  C: "caribbean",
  E: "mediterranean",
  F: "transatlantic",
  H: "hawaii",
  J: "japan",
  M: "mexican-riviera",
  N: "canada-new-england",
  O: "asia",
  P: "australia-new-zealand",
  S: "south-pacific",
  T: "panama-canal",
  W: "world-cruise",
  Z: "australia-new-zealand"
});

/** Official Princess resdb port codes → canonical catalogue names (reviewed, not auto-aliases). */
const PRINCESS_PORT_CODE_MAP = Object.freeze({
  FLL: "Fort Lauderdale (Port Everglades), Florida",
  BGI: "Bridgetown, Barbados",
  NYC: "New York, New York",
  SA3: "Valparaíso (Santiago), Chile"
});

const PRINCESS_PORT_ALIASES = Object.freeze({
  "cape liberty": "Bayonne, New Jersey",
  benoa: "Benoa, Bali",
  barbados: "Bridgetown, Barbados",
  "ft. lauderdale, florida": "Fort Lauderdale (Port Everglades), Florida",
  "new york city (manhattan or brooklyn), new york": "New York, New York",
  "san antonio (for santiago), chile": "Valparaíso (Santiago), Chile"
});

function isEligiblePrincessCruise(productType) {
  return productType === "cruise";
}

function isPrincessCruisetour(productType) {
  return productType === "cruisetour";
}

function resolvePrincessDestinationHints(raw) {
  const tradeIds = (raw.trade_ids || []).map((id) => String(id).toUpperCase());
  for (const code of tradeIds) {
    const slug = PRINCESS_TRADE_CODE_SLUG[code];
    if (slug) return { preferredSlug: slug, method: `princess_trade_code_${code}` };
  }
  if (tradeIds.includes("E")) {
    return { structuredDestination: "Europe", method: "princess_trade_code_E", europe_broad: true };
  }
  if (tradeIds.includes("O")) {
    return { structuredDestination: "Asia", method: "princess_trade_code_O" };
  }
  return {};
}

function resolvePrincessDeparturePort(raw) {
  const code = String(raw.departure_port_code || "").trim().toUpperCase();
  const mappedName = code ? PRINCESS_PORT_CODE_MAP[code] : null;
  const candidates = [mappedName, raw.departure_port, raw.departure_port_code].filter(Boolean);
  for (const value of candidates) {
    const alias = PRINCESS_PORT_ALIASES[String(value).toLowerCase()];
    const meta = resolveRawPortText(alias || value, { sourceField: "princess_resdb" });
    if (meta.status === "resolved") return meta;
  }
  return resolveRawPortText(raw.departure_port || raw.departure_port_code, { sourceField: "princess_resdb" });
}

function normalisePrincessProduct(raw, context = {}) {
  const {
    cruiseLine,
    ships = [],
    shipAliases = [],
    destinations = [],
    destinationAliases = [],
    productMeta = null
  } = context;

  const product = productMeta || { productType: classifyProductType(raw) };
  const isCruiseProduct = product.productType === "cruise";

  const evidence = {
    ship: null,
    departure_date: raw.departure_date ? { value: raw.departure_date, source: "princess_resdb" } : null,
    departure_port: null,
    destination: null
  };

  const shipResolution = resolveShipForLine({
    rawShipName: raw.ship_name,
    rawShipCode: raw.ship_code,
    cruiseLineId: cruiseLine?.id,
    cruiseLineName: cruiseLine?.name || "Princess Cruises",
    ships,
    aliases: shipAliases
  });

  evidence.ship = shipResolution.resolved
    ? { name: shipResolution.ship.name, method: shipResolution.method, confidence: shipResolution.confidence }
    : { name: raw.ship_name, method: shipResolution.reason || "unresolved", confidence: shipResolution.confidence || 0 };

  const portMeta = resolvePrincessDeparturePort(raw);
  const destHints = resolvePrincessDestinationHints(raw);
  const itineraryLabel = String(raw.itinerary_name || "").trim() || raw.itinerary_id;

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
      princess_itinerary_id: raw.itinerary_id,
      princess_itinerary_name: raw.itinerary_name || null,
      princess_ship_code: raw.ship_code,
      princess_trade_ids: raw.trade_ids || [],
      princess_product_type: product.productType,
      structured_source: raw.structured_source,
      departure_port_raw: raw.departure_port
    }
  };

  if (candidate.departure_port) {
    evidence.departure_port = { value: candidate.departure_port, meta: candidate.departure_port_meta };
  }

  const destResult = resolveOperationalDestination({
    title: itineraryLabel,
    description: [raw.itinerary_name, (raw.trade_ids || []).join(" ")].filter(Boolean).join(" "),
    itinerary: candidate.itinerary,
    structuredDestination: destHints.structuredDestination || null,
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

  candidate.destination_id = destResult.status === "resolved" ? destResult.destinationId : null;

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
    cruise_line_name: cruiseLine?.name,
    title: itineraryLabel,
    url: candidate.official_url,
    official_url: candidate.official_url,
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
    candidate.departure_date &&
    candidate.destination_id &&
    destResult.status === "resolved" &&
    portMeta.status === "resolved" &&
    individual.proven &&
    validationReasons.length === 0 &&
    (confidenceEval.outcome === "auto_publish" || confidenceEval.outcome === "high_confidence");

  const failureReasons = [];
  if (product.productType === "cruisetour") failureReasons.push("cruisetour_excluded");
  if (!shipResolution.resolved) failureReasons.push("unknown_ship");
  if (!candidate.departure_date) failureReasons.push("missing_departure_date");
  if (!candidate.departure_port && portMeta.status !== "resolved") failureReasons.push("missing_departure_port");
  if (destResult.status === "unresolved") failureReasons.push("destination_unresolved");
  if (destResult.status === "ambiguous") failureReasons.push("destination_ambiguous");
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

async function simulatePrincessInventory(context = {}) {
  const today = context.today || new Date().toISOString().slice(0, 10);
  const fetchResult = await fetchAllPrincessRawSailings({ today, futureOnly: true });

  const normalised = [];
  const failureCounts = {};
  const destinationCounts = {};

  for (const raw of fetchResult.products || []) {
    const result = normalisePrincessProduct(raw, context);
    normalised.push(result);
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
  const complete = cruises.filter((n) => n.complete_high_confidence);
  const { publiclyEligible, withinCutoff } = partitionByPublicBookingCutoff(
    normalised,
    (p) => p.candidate?.departure_date,
    today
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
    raw_group_count: fetchResult.raw_group_count,
    raw_sailing_count: fetchResult.products?.length || 0,
    products: normalised,
    voyages: normalised,
    publicly_eligible: publiclyEligible,
    within_public_cutoff: withinCutoff,
    complete_high_confidence: complete,
    metrics: {
      source_groups: fetchResult.raw_group_count,
      expanded_dated_sailings: fetchResult.products?.length || 0,
      genuine_cruises: cruises.length,
      cruisetours_excluded: cruisetours.length,
      complete_high_confidence: complete.length,
      within_public_cutoff: withinCutoff.length,
      ship_resolution_pct: (shipOk / cruiseTotal) * 100,
      departure_port_resolution_pct: (portOk / cruiseTotal) * 100,
      destination_resolution_pct: (destOk / cruiseTotal) * 100,
      identity_coverage_pct: (identityOk / cruiseTotal) * 100,
      failure_counts: failureCounts,
      destination_counts: destinationCounts
    },
    fetch_result: fetchResult,
    source_contract: SOURCE_CONTRACT
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  PRINCESS_TRADE_CODE_SLUG,
  isEligiblePrincessCruise,
  isPrincessCruisetour,
  officialProductKey,
  officialGroupKey,
  normalisePrincessProduct,
  simulatePrincessInventory,
  catalogueDestinations
};
