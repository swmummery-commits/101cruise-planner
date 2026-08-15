/**
 * Disney Cruise Line — Phase 2B normalisation adapter (read-only).
 * Converts proven PAVAS sailings into canonical discovery candidates.
 */

const crypto = require("crypto");
const { canonicalUrl } = require("./cruise-discovery-structured");
const { resolveShipForLine } = require("./discovery-ship-resolver");
const { resolveOperationalDestination } = require("./discovery-destination-resolver");
const { resolveRawPortText } = require("./discovery-departure-port");
const { validateCruise } = require("./cruise-discovery");
const { evaluateDiscoveryConfidence } = require("./discovery-confidence");
const { provesIndividualSailing } = require("./discovery-non-sailing-filter");
const { cruiseIdentityKey } = require("./cruise-discovery-ops");
const { resolveDisneyDestinationHints } = require("./disney-destination-mapping");
const source = require("./disney-discovery-source");
const catalogue = require("./disney-discovery-catalogue");
const legacyReconciliation = require("./disney-legacy-reconciliation");
const {
  daysUntilDeparture,
  publicBookingCutoffDate,
  publicBookingMinimumDepartureDate,
  perthCalendarDate,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require("./public-discovered-cruise-inventory");

const ADAPTER_ID = source.ADAPTER_ID;
const ADAPTER_VERSION = `${source.ADAPTER_VERSION}.2c`;
const DISNEY_LINE_ID = "8f7aadcb-7843-4060-b0cb-a60631936b3a";
const DISNEY_SEARCH_URL = "https://disneycruise.disney.go.com/cruises-destinations/list/";
const PHASE2A_BASELINE_IDENTITIES = null;

const PRIMARY_EXCLUSION_ORDER = [
  "source_invalid",
  "past_departure",
  "within_21_day_cutoff",
  "required_ship_unresolved",
  "required_embark_port_unresolved",
  "required_destination_unresolved",
  "duration_validation_failed",
  "identity_conflict",
  "confidence_gate_failure"
];

const SCENIC_PORT_RE =
  /^(glacier viewing|scenic|at sea|sea day|cruising|transit|sailing$|panama canal$)/i;
const PRIVATE_ISLAND_RE = /castaway cay|lookout cay|lighthouse point|disney private island/i;

const DISNEY_EMBARK_PRODUCT_ID_MAP = Object.freeze({
  port_canaveral: "Port Canaveral (Orlando), Florida",
  fort_lauderdale: "Fort Lauderdale (Port Everglades), Florida",
  singapore: "Singapore",
  vancouver: "Vancouver, Canada",
  san_diego: "San Diego, California",
  galveston: "Galveston, Texas",
  southampton: "Southampton, England",
  barcelona: "Barcelona, Spain",
  civitavecchia: "Civitavecchia (Rome), Italy",
  san_juan: "San Juan, Puerto Rico",
  rome: "Civitavecchia (Rome), Italy",
  benoa: "Benoa, Bali"
});

const DISNEY_EMBARK_PORT_ALIASES = Object.freeze({
  "port canaveral": "Port Canaveral (Orlando), Florida",
  "fort lauderdale": "Fort Lauderdale (Port Everglades), Florida",
  "san diego": "San Diego, California",
  "port everglades": "Fort Lauderdale (Port Everglades), Florida"
});

const DISNEY_CITY_FILTER_EMBARK = Object.freeze({
  PCV: "Port Canaveral (Orlando), Florida",
  FLL: "Fort Lauderdale (Port Everglades), Florida",
  SIN: "Singapore",
  VAN: "Vancouver, Canada",
  SAN: "San Diego, California",
  GAL: "Galveston, Texas",
  SOU: "Southampton, England",
  BCN: "Barcelona, Spain",
  CVV: "Civitavecchia (Rome), Italy",
  SJU: "San Juan, Puerto Rico"
});

const THEME_SUFFIX_RE =
  /_(halloween|merrytime|marvel|pixar|mdas|pdas|dd)(?:_|$)/i;

function officialProductKey(raw) {
  return raw?.official_product_key || source.officialProductKey(raw?.sailing_id, raw?.departure_date);
}

function extractThemeMetadata(raw = {}) {
  const themes = new Set();
  const productId = String(raw.product_id || "").toLowerCase();
  const productName = String(raw.product_name || "");
  const m = productId.match(THEME_SUFFIX_RE);
  if (m) themes.add(m[1]);
  if (/halloween on the high seas/i.test(productName)) themes.add("halloween");
  if (/very merrytime/i.test(productName)) themes.add("merrytime");
  if (/marvel/i.test(productName)) themes.add("marvel");
  if (/pixar/i.test(productName)) themes.add("pixar");
  return [...themes];
}

function classifyDisneyItineraryPort(value) {
  const name = String(value || "").trim();
  if (!name) return { kind: "empty", raw: value, name: null };
  if (SCENIC_PORT_RE.test(name)) return { kind: "scenic/non_port", raw: value, name };
  if (PRIVATE_ISLAND_RE.test(name)) return { kind: "private_island_physical_port", raw: value, name };
  if (/^\d/.test(name) && !/,/.test(name)) return { kind: "ambiguous", raw: value, name };
  return { kind: "physical_port", raw: value, name };
}

function extractEmbarkFromProductId(productId) {
  const slug = String(productId || "").toLowerCase();
  for (const [key, port] of Object.entries(DISNEY_EMBARK_PRODUCT_ID_MAP)) {
    if (slug.includes(key)) return { port, method: "product_id_slug", tier: 2, evidence: productId };
  }
  return null;
}

function parseDisneyProductTitleEndpoints(productName) {
  const text = String(productName || "").trim();
  if (!text) return null;

  const themed = text.match(/\bCruise from\s+(.+?)(?:\s+ending in\s+(.+?))?(?:\s+with\b.*)?$/i);
  if (themed) {
    return {
      embark: themed[1].trim(),
      arrival: themed[2] ? themed[2].trim() : null,
      method: "product_name_cruise_from_pattern",
      tier: 3,
      evidence: productName
    };
  }

  const simple = text.match(/^\d+-Night(?:\s+Cruise)?\s+from\s+(.+)$/i);
  if (simple) {
    return {
      embark: simple[1].trim(),
      arrival: null,
      method: "product_name_simple_from",
      tier: 3,
      evidence: productName
    };
  }
  return null;
}

function extractEmbarkFromProductName(productName) {
  const parsed = parseDisneyProductTitleEndpoints(productName);
  if (!parsed) return null;
  const fragment = parsed.embark;
  const aliasKey = fragment.toLowerCase();
  if (DISNEY_EMBARK_PORT_ALIASES[aliasKey]) {
    return {
      port: DISNEY_EMBARK_PORT_ALIASES[aliasKey],
      method: parsed.method,
      tier: parsed.tier,
      evidence: parsed.evidence
    };
  }
  const resolved = resolveRawPortText(fragment, { sourceField: "disney_product_name" });
  if (resolved.status === "resolved") {
    return {
      port: resolved.canonicalPortName,
      method: "product_name_port_catalogue",
      tier: parsed.tier,
      evidence: parsed.evidence
    };
  }
  if (/,/.test(fragment)) {
    return { port: fragment, method: parsed.method, tier: parsed.tier, evidence: parsed.evidence, ambiguous: true };
  }
  return null;
}

function extractArrivalFromProductName(productName) {
  const parsed = parseDisneyProductTitleEndpoints(productName);
  if (!parsed?.arrival) return null;
  return {
    port: parsed.arrival,
    method: "product_name_ending_in",
    tier: 3,
    evidence: parsed.evidence
  };
}

function extractEmbarkFromCityFilters(filters = []) {
  for (const f of filters) {
    const code = String(f).split(";")[0].trim().toUpperCase();
    if (DISNEY_CITY_FILTER_EMBARK[code]) {
      return {
        port: DISNEY_CITY_FILTER_EMBARK[code],
        method: `city_filter_${code}`,
        tier: 2,
        evidence: f
      };
    }
  }
  return null;
}

function resolveDisneyEmbarkation(raw = {}) {
  const attempts = [];
  const fromProductId = extractEmbarkFromProductId(raw.product_id);
  if (fromProductId) attempts.push(fromProductId);
  const fromFilters = extractEmbarkFromCityFilters(raw.discovered_via_filters || []);
  if (fromFilters) attempts.push(fromFilters);
  const fromName = extractEmbarkFromProductName(raw.product_name);
  if (fromName) attempts.push(fromName);

  const best = attempts.sort((a, b) => a.tier - b.tier)[0];
  if (!best) {
    return {
      status: "unresolved",
      canonicalPortName: null,
      confidence: "low",
      reason: "no_embarkation_evidence",
      evidence_tier: 4,
      attempts
    };
  }
  if (best.ambiguous) {
    return {
      status: "ambiguous",
      canonicalPortName: null,
      confidence: "low",
      reason: "ambiguous_product_title",
      evidence_tier: best.tier,
      attempts
    };
  }
  const resolved = resolveRawPortText(best.port, { sourceField: "disney_embark" });
  if (resolved.status === "resolved") {
    return {
      ...resolved,
      evidence_tier: best.tier,
      embark_method: best.method,
      embark_evidence: best.evidence,
      attempts
    };
  }
  return {
    status: "unresolved",
    canonicalPortName: null,
    confidence: "low",
    reason: resolved.reason || "embark_not_in_catalogue",
    evidence_tier: best.tier,
    attempts,
    proposed_port: best.port
  };
}

function resolveDisneyShip(raw, context = {}) {
  const { cruiseLine, ships = [], shipAliases = [] } = context;
  return resolveShipForLine({
    rawShipName: raw.ship_name,
    rawShipCode: raw.ship_code,
    cruiseLineId: cruiseLine?.id || DISNEY_LINE_ID,
    ships,
    aliases: shipAliases
  });
}

function validateDisneyDuration(raw = {}) {
  const dep = raw.departure_date;
  const ret = raw.return_date;
  const nights = Number(raw.nights);
  if (!dep) return { valid: false, reason: "missing_departure_date" };
  if (!nights || nights <= 0) return { valid: false, reason: "missing_or_invalid_nights" };
  if (!ret) return { valid: true, exact_match: null, reason: "missing_return_date" };
  const depMs = Date.parse(`${dep}T12:00:00`);
  const retMs = Date.parse(`${ret}T12:00:00`);
  if (!Number.isFinite(depMs) || !Number.isFinite(retMs)) {
    return { valid: false, reason: "invalid_date_parse" };
  }
  const diffDays = Math.round((retMs - depMs) / 86400000);
  return {
    valid: diffDays === nights,
    exact_match: diffDays === nights,
    expected_nights: nights,
    actual_night_span: diffDays,
    departure_date: dep,
    return_date: ret
  };
}

function evaluateDisneyStructuredSourceTrust(input = {}) {
  const structuredSource = input.structured_source || input.raw?.structured_source || "disney_pavas";
  const sailingId = String(input.sailing_id || input.raw?.sailing_id || "").trim();
  const departureDate = String(input.departure_date || input.raw?.departure_date || "").slice(0, 10);
  const officialIdentity = sailingId && departureDate ? `${sailingId}|${departureDate}` : null;

  const portMeta = input.departure_port_meta || {};
  const destinationResolution = input.destinationResolution || {};
  const destinationResolved =
    destinationResolution.status === "resolved" ||
    Boolean(destinationResolution.destination_id) ||
    Boolean(input.destination_id);

  const criteria = {
    official_source: structuredSource === "disney_pavas",
    sailing_id: Boolean(sailingId),
    official_identity: Boolean(officialIdentity),
    departure_date: Boolean(departureDate),
    duration: Number(input.nights || input.raw?.nights) > 0,
    ship_resolved: input.shipResolution?.resolved === true,
    embark_port_resolved: portMeta.status === "resolved" && Boolean(portMeta.canonicalPortName),
    destination_resolved: destinationResolved
  };
  const missing = Object.entries(criteria)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  const referenceResolutionReady =
    criteria.ship_resolved && criteria.embark_port_resolved && criteria.destination_resolved;
  const trusted =
    criteria.official_source &&
    criteria.sailing_id &&
    criteria.official_identity &&
    criteria.departure_date &&
    criteria.duration;

  return {
    trusted,
    structured_source: structuredSource,
    official_identity: officialIdentity,
    criteria,
    missing,
    reference_resolution_ready: referenceResolutionReady,
    reasons: trusted ? [] : ["structured_source_criteria_incomplete", ...missing.map((m) => `missing_${m}`)]
  };
}

function mergeDisneyStructuralContexts(existing, incoming) {
  const merged = { ...existing };
  merged.structural_contexts = [...(existing.structural_contexts || []), ...(incoming.structural_contexts || [])];
  merged.discovered_via_filters = [
    ...new Set([...(existing.discovered_via_filters || []), ...(incoming.discovered_via_filters || [])])
  ];
  const fields = ["ship_name", "ship_code", "departure_date", "return_date", "nights", "destination_code"];
  merged.material_contradictions = merged.material_contradictions || [];
  for (const field of fields) {
    if (existing[field] && incoming[field] && String(existing[field]) !== String(incoming[field])) {
      merged.material_contradictions.push({ field, existing: existing[field], incoming: incoming[field] });
    }
  }
  if (incoming.ports_of_call?.length && !merged.ports_of_call?.length) {
    merged.ports_of_call_ordered = incoming.ports_of_call_ordered;
    merged.ports_of_call = incoming.ports_of_call;
  }
  return merged;
}

function buildDisneyRawVoyage(parsedSailing, itineraryRecords = [], meta = {}) {
  const itinerary = itineraryRecords[0] || {};
  const portsOrdered = Array.isArray(itinerary.portsOfCall) ? [...itinerary.portsOfCall] : [];
  const portsClassified = portsOrdered.map(classifyDisneyItineraryPort);
  const discoveredViaFilters = [
    ...new Set(
      itineraryRecords.flatMap((it) => it._discoveredViaFilters || meta.discoveredViaFilters || [])
    )
  ];

  return {
    source: "disney_pavas",
    structured_source: "disney_pavas",
    official_product_key: parsedSailing.official_product_key,
    sailing_id: parsedSailing.sailing_id,
    package_id: parsedSailing.package_id,
    package_code: parsedSailing.package_code,
    product_id: parsedSailing.product_id,
    itinerary_id: parsedSailing.itinerary_id,
    structural_expansion_key: meta.expansionKey || null,
    product_name: meta.productName || parsedSailing.product_name,
    ship_name: parsedSailing.ship_name,
    ship_code: parsedSailing.ship_code,
    departure_date: parsedSailing.departure_date,
    return_date: parsedSailing.return_date,
    nights: parsedSailing.nights,
    destination_code: parsedSailing.destination_code,
    geo_area: parsedSailing.geo_area,
    has_availability: parsedSailing.has_availability,
    blocked_from_booking: parsedSailing.blocked_from_booking,
    is_early_booking: parsedSailing.is_early_booking,
    ports_of_call_ordered: portsOrdered,
    ports_of_call: portsClassified,
    one_way_itinerary: Boolean(itinerary.oneWayItinerary),
    theme_metadata: extractThemeMetadata({
      product_id: parsedSailing.product_id,
      product_name: meta.productName || parsedSailing.product_name
    }),
    discovered_via_filters: discoveredViaFilters,
    discovered_via_strategy: itinerary._discoveredViaStrategy || meta.discoveredViaStrategy || null,
    structural_contexts: itineraryRecords.map((it) => ({
      expansionKey: it._expansionKey,
      structuralFingerprint: catalogue.itineraryStructuralFingerprint(it, { productItineraryData: it.productItineraryData }),
      numberOfSailings: it.numberOfSailings,
      oneWayItinerary: it.oneWayItinerary,
      portsOfCall: it.portsOfCall || []
    })),
    material_contradictions: [],
    official_url: DISNEY_SEARCH_URL,
    source_url: DISNEY_SEARCH_URL
  };
}

function enrichSailingsFromCatalogue(sailings = [], losslessCatalogue) {
  const byIdentity = new Map();
  for (const sailing of sailings) {
    const contexts = losslessCatalogue
      ? losslessCatalogue.lookupItineraryContexts(sailing.product_id, sailing.itinerary_id)
      : [];
    const meta = {
      productName:
        contexts.length && losslessCatalogue?.products
          ? losslessCatalogue.products.get(sailing.product_id)?.productName || sailing.product_name
          : sailing.product_name,
      expansionKey: contexts[0]?._expansionKey,
      discoveredViaFilters: contexts[0]?._discoveredViaFilters
    };
    const raw = buildDisneyRawVoyage(sailing, contexts, meta);
    const key = raw.official_product_key;
    if (byIdentity.has(key)) {
      byIdentity.set(key, mergeDisneyStructuralContexts(byIdentity.get(key), raw));
    } else {
      byIdentity.set(key, raw);
    }
  }
  return [...byIdentity.values()];
}

function assessSourceValidity(raw = {}) {
  const missing = [];
  if (!raw.sailing_id) missing.push("missing_sailing_id");
  if (!raw.departure_date) missing.push("missing_departure_date");
  if (!raw.ship_code && !raw.ship_name) missing.push("missing_ship");
  if (!Number(raw.nights) || Number(raw.nights) <= 0) missing.push("missing_nights");
  return { valid: missing.length === 0, missing };
}

function determinePrimaryExclusion(ctx) {
  if (!ctx.sourceValidity.valid) return "source_invalid";
  if (ctx.identityConflict) return "identity_conflict";
  if (ctx.cutoff.past) return "past_departure";
  if (ctx.cutoff.within_21) return "within_21_day_cutoff";
  if (!ctx.shipResolved) return "required_ship_unresolved";
  if (!ctx.embarkResolved) return "required_embark_port_unresolved";
  if (!ctx.destinationResolved) return "required_destination_unresolved";
  if (!ctx.durationValid) return "duration_validation_failed";
  if (!ctx.publicationReady) return "confidence_gate_failure";
  return null;
}

function evaluateVoyageEligibility(row, today = perthCalendarDate()) {
  const raw = row.raw || {};
  const sourceValidity = assessSourceValidity(raw);
  const shipResolved = row.ship_resolution?.resolved === true;
  const embarkResolved = row.candidate?.departure_port_meta?.status === "resolved";
  const destinationResolved = row.destination_resolution?.status === "resolved";
  const durationCheck = row.duration_validation || validateDisneyDuration(raw);
  const durationValid = durationCheck.valid !== false && durationCheck.exact_match !== false;
  const identityConflict = (raw.material_contradictions || []).length > 0;
  const publicationReady =
    row.confidence?.outcome === "auto_publish" || row.confidence?.outcome === "high_confidence";

  const dep = row.candidate?.departure_date;
  const days = dep ? daysUntilDeparture(dep, today) : null;
  const cutoff = {
    past: days != null && days < 0,
    within_21: days != null && days >= 0 && days <= PUBLIC_BOOKING_CUTOFF_DAYS,
    outside_cutoff: days != null && days > PUBLIC_BOOKING_CUTOFF_DAYS
  };

  const primary_exclusion_reason = determinePrimaryExclusion({
    sourceValidity,
    identityConflict,
    cutoff,
    shipResolved,
    embarkResolved,
    destinationResolved,
    durationValid,
    publicationReady
  });

  return {
    source_validity: sourceValidity,
    reference_resolution: { ship: shipResolved, embark_port: embarkResolved, destination: destinationResolved },
    duration_validation: durationCheck,
    identity_conflict: identityConflict,
    cutoff,
    primary_exclusion_reason,
    production_eligible: primary_exclusion_reason === null
  };
}

function buildEligibilityWaterfall(normalised, today = perthCalendarDate()) {
  const evaluated = normalised.map((row) => ({
    row,
    eligibility: evaluateVoyageEligibility(row, today)
  }));
  const counts = Object.fromEntries(PRIMARY_EXCLUSION_ORDER.map((k) => [k, 0]));
  counts.production_eligible = 0;
  for (const { eligibility } of evaluated) {
    if (eligibility.production_eligible) counts.production_eligible += 1;
    else if (eligibility.primary_exclusion_reason) counts[eligibility.primary_exclusion_reason] += 1;
  }
  const uniqueProducts = normalised.length;
  const arithmetic = {
    source_unique_sailings: uniqueProducts,
    production_eligible: counts.production_eligible,
    reconciles:
      counts.production_eligible +
        PRIMARY_EXCLUSION_ORDER.reduce((sum, key) => sum + (counts[key] || 0), 0) ===
      uniqueProducts
  };
  return { as_of_date: today, waterfall: counts, arithmetic, evaluated };
}

function buildItineraryText(raw = {}) {
  const ports = (raw.ports_of_call_ordered || [])
    .filter(Boolean)
    .slice(0, 12);
  if (!ports.length) return raw.product_name || null;
  return ports.join(" • ");
}

function resolveDisneyItineraryPortText(value) {
  const classified = classifyDisneyItineraryPort(value);
  if (classified.kind === "scenic/non_port" || classified.kind === "empty") {
    return { status: "non_port", kind: classified.kind, raw: value };
  }
  const resolved = resolveRawPortText(value, { sourceField: "disney_itinerary" });
  return {
    ...resolved,
    kind: classified.kind,
    raw: value
  };
}

function resolveArrivalPort(raw = {}, embarkPortMeta = {}) {
  const fromTitle = extractArrivalFromProductName(raw.product_name);
  if (fromTitle) {
    const resolved = resolveRawPortText(fromTitle.port, { sourceField: "disney_arrival_title" });
    if (resolved.status === "resolved") {
      return {
        ...resolved,
        round_trip: false,
        method: fromTitle.method,
        evidence_tier: fromTitle.tier,
        embark_evidence: fromTitle.evidence
      };
    }
  }

  if (raw.one_way_itinerary === true) {
    const ports = raw.ports_of_call_ordered || [];
    const lastPhysical = [...ports].reverse().find((p) => {
      const kind = classifyDisneyItineraryPort(p).kind;
      return kind === "physical_port" || kind === "private_island_physical_port";
    });
    if (lastPhysical) {
      const resolved = resolveDisneyItineraryPortText(lastPhysical);
      if (resolved.status === "resolved") return { ...resolved, round_trip: false, method: "itinerary_last_physical" };
    }
    return { status: "unresolved", round_trip: false };
  }
  if (raw.one_way_itinerary === false && embarkPortMeta.status === "resolved") {
    return {
      status: "resolved",
      canonicalPortName: embarkPortMeta.canonicalPortName,
      round_trip: true,
      method: "round_trip_embark_equals_disembark"
    };
  }
  return { status: "unknown", round_trip: null };
}

function normaliseDisneyVoyage(raw, context = {}) {
  const { cruiseLine, ships = [], shipAliases = [], destinations = [], destinationAliases = [], today = perthCalendarDate() } =
    context;

  const shipResolution = resolveDisneyShip(raw, context);
  const portMeta = resolveDisneyEmbarkation(raw);
  const destHints = resolveDisneyDestinationHints(raw);
  const duration_validation = validateDisneyDuration(raw);
  const arrivalMeta = resolveArrivalPort(raw, portMeta);

  let candidate = {
    cruise_line_id: cruiseLine?.id || DISNEY_LINE_ID,
    ship_id: shipResolution.resolved ? shipResolution.ship.id : null,
    departure_date: raw.departure_date,
    return_date: raw.return_date,
    nights: raw.nights,
    departure_port: portMeta.status === "resolved" ? portMeta.canonicalPortName : null,
    departure_port_meta: portMeta,
    arrival_port: arrivalMeta.status === "resolved" ? arrivalMeta.canonicalPortName : null,
    arrival_port_meta: arrivalMeta,
    itinerary: buildItineraryText(raw),
    official_url: raw.official_url || DISNEY_SEARCH_URL,
    source_url: raw.source_url || DISNEY_SEARCH_URL,
    raw_extract: {
      title: raw.product_name,
      disney_sailing_id: raw.sailing_id,
      disney_official_product_key: raw.official_product_key,
      disney_product_id: raw.product_id,
      disney_itinerary_id: raw.itinerary_id,
      disney_package_code: raw.package_code,
      disney_theme_metadata: raw.theme_metadata || [],
      structured_source: raw.structured_source,
      departure_port_raw: portMeta.embark_evidence || null,
      embark_method: portMeta.embark_method || null,
      embark_evidence_tier: portMeta.evidence_tier || null
    }
  };

  const destResult = resolveOperationalDestination({
    title: raw.product_name,
    itinerary: candidate.itinerary,
    structuredDestination: destHints.structuredDestination || raw.destination_code,
    departurePort: candidate.departure_port,
    arrivalPort: candidate.arrival_port,
    nights: raw.nights,
    destinations,
    destinationAliases,
    preferredDestination: destHints.preferredSlug ? { slug: destHints.preferredSlug } : null
  });

  const matchedDest = destinations.find((d) => d.slug === destResult.destinationKey);
  candidate.destination_id = matchedDest?.id || null;
  candidate.destination_key = destResult.destinationKey;
  const simDestinationId =
    candidate.destination_id ||
    (destResult.status === "resolved" && destResult.destinationKey ? `catalogue:${destResult.destinationKey}` : null);

  const structuredSourceTrust = evaluateDisneyStructuredSourceTrust({
    structured_source: raw.structured_source,
    sailing_id: raw.sailing_id,
    departure_date: candidate.departure_date,
    nights: candidate.nights,
    shipResolution,
    departure_port_meta: portMeta,
    destinationResolution: destResult
  });

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
    ships: ships.filter((s) => s.cruise_line_id === (cruiseLine?.id || DISNEY_LINE_ID)),
    ship_name_guess: raw.ship_name
  });

  const confidenceEval = evaluateDiscoveryConfidence({
    ...candidate,
    cruise_id: raw.sailing_id,
    structured_source: raw.structured_source,
    structuredSourceTrust,
    cruiseLine,
    cruise_line_name: cruiseLine?.name || "Disney Cruise Line",
    title: raw.product_name,
    shipResolution: shipResolution.resolved
      ? { ship: shipResolution.ship, method: shipResolution.method, confidence: shipResolution.confidence, resolved: true }
      : { resolved: false },
    destinationResolution: {
      resolved: destResult.status === "resolved",
      destination_id: simDestinationId,
      destination_key: destResult.destinationKey,
      confidence: destResult.confidence === "high" ? 95 : destResult.confidence === "medium" ? 80 : 60
    },
    ship_name: shipResolution.ship?.name || raw.ship_name
  });

  const row = {
    raw,
    candidate,
    official_sailing_id: officialProductKey(raw),
    ship_resolution: shipResolution,
    destination_resolution: destResult,
    duration_validation,
    validation_reasons: validationReasons,
    confidence: confidenceEval,
    structured_source_trust: structuredSourceTrust,
    individual_gate: individual,
    product_type: "ocean"
  };
  row.eligibility = evaluateVoyageEligibility(row, today);
  return row;
}

function disneyExternalKey(cruiseLineId, productKey) {
  return crypto.createHash("sha256").update([ADAPTER_ID, cruiseLineId || "", productKey || ""].join("|")).digest("hex").slice(0, 40);
}

function buildDisneyUpsertCandidate(row, cruiseLine) {
  if (!row?.eligibility?.production_eligible) return null;
  const c = row.candidate || {};
  const productKey = officialProductKey(row.raw);
  if (!productKey || !cruiseLine?.id || !c.destination_id) return null;
  return {
    ...c,
    cruise_line_id: cruiseLine.id,
    status: "active",
    match_confidence: "high",
    external_key: disneyExternalKey(cruiseLine.id, productKey),
    identity_key: cruiseIdentityKey({
      cruiseLineId: cruiseLine.id,
      shipId: c.ship_id,
      departureDate: c.departure_date,
      officialUrl: c.official_url,
      nights: c.nights,
      returnDate: c.return_date,
      officialSailingId: productKey
    }),
    official_sailing_id: productKey,
    raw_extract: {
      ...(c.raw_extract || {}),
      disney_adapter_id: ADAPTER_ID,
      disney_adapter_version: ADAPTER_VERSION
    }
  };
}

function classifyProposedAction(row, existing, legacyMatch = null) {
  if (!row.eligibility?.production_eligible) {
    const reason = row.eligibility?.primary_exclusion_reason || "not_production_eligible";
    if (reason === "within_21_day_cutoff" || reason === "past_departure") return "within_21_day_cutoff_excluded";
    if (reason === "required_embark_port_unresolved") return "blocked_unresolved";
    if (reason === "required_destination_unresolved") return "blocked_unresolved";
    if (reason === "required_ship_unresolved") return "blocked_unresolved";
    if (reason === "duration_validation_failed") return "blocked_unresolved";
    if (reason === "identity_conflict") return "review_required";
    if (reason === "confidence_gate_failure") return "review_required";
    return "blocked_unresolved";
  }
  const productKey = officialProductKey(row.raw);
  if (!existing && legacyMatch?.existing_id) {
    existing = legacyMatch.row;
  }
  if (!existing) return "insert_active";
  const existingKey = existing.official_sailing_id || existing.raw_extract?.disney_official_product_key || null;
  if (existingKey && productKey && existingKey === productKey) {
    const candidate = buildDisneyUpsertCandidate(row, { id: existing.cruise_line_id });
    if (!candidate) return "review_required";
    const changed =
      existing.ship_id !== candidate.ship_id ||
      existing.destination_id !== candidate.destination_id ||
      existing.departure_date !== candidate.departure_date ||
      existing.return_date !== candidate.return_date ||
      existing.nights !== candidate.nights ||
      String(existing.departure_port || "") !== String(candidate.departure_port || "") ||
      existing.status !== "active";
    return changed ? "update_exact_existing" : "duplicate_skip";
  }
  if (legacyMatch?.match_status === "exact_legacy_match" || legacyMatch?.match_status === "exact_official_identity") {
    return "update_exact_legacy_match";
  }
  return "insert_active";
}

function buildProposedWriteManifest(normalised, existingRows = [], cruiseLine = {}, legacyAudit = null) {
  const byOfficial = new Map();
  const byExistingId = new Map();
  for (const row of existingRows) {
    byExistingId.set(row.id, row);
    const key = row.official_sailing_id || row.raw_extract?.disney_official_product_key;
    if (key) byOfficial.set(key, row);
  }

  const legacyByIdentity = legacyAudit?.legacy_match_by_identity || {};
  const legacyByExisting = legacyAudit?.legacy_match_by_existing_id || {};

  const manifest = [];
  const summary = {
    insert_active: 0,
    update_exact_existing: 0,
    update_exact_legacy_match: 0,
    duplicate_skip: 0,
    review_required: 0,
    blocked_unresolved: 0,
    within_21_day_cutoff_excluded: 0
  };
  const usedLegacyExisting = new Set();

  for (const row of normalised) {
    const productKey = officialProductKey(row.raw);
    let existing = byOfficial.get(productKey) || null;
    let legacyMatch = null;

    const legacyExistingId = legacyByIdentity[productKey];
    if (!existing && legacyExistingId) {
      existing = byExistingId.get(legacyExistingId) || null;
      legacyMatch = {
        existing_id: legacyExistingId,
        match_status: legacyByExisting[legacyExistingId]?.match_status || "exact_legacy_match",
        evidence: legacyByExisting[legacyExistingId]?.evidence || null,
        row: existing
      };
      usedLegacyExisting.add(legacyExistingId);
    }

    const action = classifyProposedAction(row, existing, legacyMatch);
    summary[action] = (summary[action] || 0) + 1;
    const entry = {
      official_product_key: productKey,
      sailing_id: row.raw?.sailing_id,
      departure_date: row.raw?.departure_date,
      ship_name: row.raw?.ship_name,
      action,
      existing_id: existing?.id || null
    };
    if (action === "update_exact_legacy_match" && existing) {
      entry.legacy_reconciliation = {
        before_official_sailing_id: existing.official_sailing_id || null,
        after_official_sailing_id: productKey,
        matching_evidence: legacyMatch?.evidence || legacyByExisting[existing.id]?.evidence || null
      };
    }
    manifest.push(entry);
  }

  manifest.sort((a, b) => a.official_product_key.localeCompare(b.official_product_key));
  return {
    manifest,
    summary,
    legacy_existing_matched: usedLegacyExisting.size,
    legacy_existing_unmatched: existingRows.filter(
      (r) => !usedLegacyExisting.has(r.id) && (legacyByExisting[r.id]?.match_status || "no_source_match") !== "exact_official_identity"
    ).length
  };
}

function analysePortResolution(normalised = []) {
  const embarkValues = new Map();
  const itineraryValues = new Map();
  let roundTrip = 0;
  let oneWay = 0;
  let arrivalResolved = 0;
  let arrivalUnresolved = 0;

  for (const row of normalised) {
    const raw = row.raw || {};
    if (raw.one_way_itinerary === true) oneWay += 1;
    else if (raw.one_way_itinerary === false) roundTrip += 1;
    if (row.candidate?.arrival_port_meta?.status === "resolved") arrivalResolved += 1;
    else if (raw.one_way_itinerary != null) arrivalUnresolved += 1;

    const embarkKey = raw.product_id || raw.product_name || "unknown";
    if (!embarkValues.has(embarkKey)) {
      embarkValues.set(embarkKey, {
        source_value: embarkKey,
        resolved: row.candidate?.departure_port_meta?.status === "resolved",
        method: row.candidate?.departure_port_meta?.embark_method || null,
        tier: row.candidate?.departure_port_meta?.evidence_tier || null,
        sailing_count: 0
      });
    }
    embarkValues.get(embarkKey).sailing_count += 1;

    for (const port of raw.ports_of_call || []) {
      const key = port.name || port.raw;
      if (!key) continue;
      if (!itineraryValues.has(key)) {
        itineraryValues.set(key, { raw: key, kind: port.kind, sailing_count: 0, resolved: null });
      }
      itineraryValues.get(key).sailing_count += 1;
      if (port.kind === "physical_port" || port.kind === "private_island_physical_port") {
        const r = resolveDisneyItineraryPortText(key);
        itineraryValues.get(key).resolved = r.status === "resolved";
        itineraryValues.get(key).classification = r.kind;
      } else if (port.kind === "scenic/non_port") {
        itineraryValues.get(key).resolved = true;
        itineraryValues.get(key).classification = "scenic/non_port";
      }
    }
  }

  const embarkList = [...embarkValues.values()];
  const resolvedEmbarkSailings = normalised.filter((r) => r.candidate?.departure_port_meta?.status === "resolved").length;
  const itineraryList = [...itineraryValues.values()].sort((a, b) => b.sailing_count - a.sailing_count);
  const physicalPorts = itineraryList.filter((p) => p.kind === "physical_port" || p.kind === "private_island_physical_port");
  const physicalResolved = physicalPorts.filter((p) => p.resolved).length;

  return {
    embarkation: {
      unique_source_values: embarkList.length,
      resolved_values: embarkList.filter((e) => e.resolved).length,
      unresolved_values: embarkList.filter((e) => !e.resolved).length,
      unresolved: embarkList.filter((e) => !e.resolved),
      sailing_resolution_pct: normalised.length ? Math.round((resolvedEmbarkSailings / normalised.length) * 10000) / 100 : 0,
      methods: [...new Set(embarkList.map((e) => e.method).filter(Boolean))],
      evidence_tiers: [1, 2, 3, 4]
    },
    arrival: {
      round_trip_count: roundTrip,
      one_way_count: oneWay,
      arrival_resolved_count: arrivalResolved,
      arrival_unresolved_count: arrivalUnresolved
    },
    itinerary_ports: {
      unique_values: itineraryList.length,
      physical_port_resolution_pct: physicalPorts.length
        ? Math.round((physicalResolved / physicalPorts.length) * 10000) / 100
        : 100,
      unresolved_high_impact: itineraryList
        .filter((p) => (p.kind === "physical_port" || p.kind === "private_island_physical_port") && !p.resolved)
        .slice(0, 20)
    },
    private_islands: itineraryList.filter((p) => p.kind === "private_island_physical_port")
  };
}

function analyseDestinationResolution(normalised = []) {
  const byCombo = new Map();
  for (const row of normalised) {
    const raw = row.raw || {};
    const key = `${raw.destination_code || ""}|${raw.geo_area || ""}`;
    if (!byCombo.has(key)) {
      byCombo.set(key, {
        destination_code: raw.destination_code,
        geo_area: raw.geo_area,
        sample_product_names: [],
        sample_ports: [],
        sailing_count: 0,
        proposed_canonical: row.destination_resolution?.destinationKey || null,
        resolution_method: row.destination_resolution?.method || null,
        confidence: row.destination_resolution?.confidence || null,
        resolved: row.destination_resolution?.status === "resolved"
      });
    }
    const entry = byCombo.get(key);
    entry.sailing_count += 1;
    if (entry.sample_product_names.length < 3 && raw.product_name) entry.sample_product_names.push(raw.product_name);
    if (entry.sample_ports.length < 5 && raw.ports_of_call_ordered?.[0]) {
      entry.sample_ports.push(raw.ports_of_call_ordered[0]);
    }
  }
  const combos = [...byCombo.values()];
  const resolvedSailings = normalised.filter((r) => r.destination_resolution?.status === "resolved").length;
  return {
    distinct_combinations: combos,
    destination_resolution_pct: normalised.length ? Math.round((resolvedSailings / normalised.length) * 10000) / 100 : 0,
    unresolved: combos.filter((c) => !c.resolved)
  };
}

async function fetchDisneyCompleteSnapshot(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const requestDelayMs = options.requestDelayMs ?? 100;
  const maxApiCalls = options.maxApiCalls ?? source.PHASE2_MAX_API_CALLS;

  const auth = await source.authenticateDisneySession({ fetchImpl, requestDelayMs });
  const filters = await source.fetchDisneyFilterOptions({
    fetchImpl,
    cookieJar: auth.cookieJar,
    requestDelayMs
  });

  const harvest = await source.harvestDisneyProductCatalogue({
    fetchImpl,
    cookieJar: filters.cookieJar,
    requestDelayMs,
    filterOptions: filters,
    maxApiCalls,
    phase2: true,
    useLosslessCatalogue: true
  });

  const expansion = await source.expandDisneySailingCatalogueLossless(harvest.products, {
    fetchImpl,
    cookieJar: harvest.cookieJar,
    requestDelayMs,
    maxApiCalls: maxApiCalls - harvest.api_calls,
    losslessCatalogue: harvest.lossless_catalogue,
    preserveFilterContext: false
  });

  return { harvest, expansion, filters, api_calls: harvest.api_calls + expansion.api_calls };
}

async function simulateDisneyDiscovery(context = {}) {
  const {
    cruiseLine,
    ships = [],
    destinations = [],
    destinationAliases = [],
    shipAliases = [],
    today = perthCalendarDate(),
    fetchImpl = globalThis.fetch,
    requestDelayMs = 100,
    maxApiCalls = source.PHASE2_MAX_API_CALLS,
    phase2aBaselineIdentities = [],
    existingRows = [],
    supabaseQuery = null
  } = context;

  const snapshot = await fetchDisneyCompleteSnapshot({ fetchImpl, requestDelayMs, maxApiCalls });
  const rawVoyages = enrichSailingsFromCatalogue(snapshot.expansion.unique_sailings, snapshot.harvest.lossless_catalogue);

  const identitySet = new Set(rawVoyages.map((r) => r.official_product_key));
  const baselineIdentities = (phase2aBaselineIdentities || []).filter((k) => typeof k === "string" && k.includes("|"));
  const baselineSet = new Set(baselineIdentities);
  const addedSince = baselineSet.size ? [...identitySet].filter((k) => !baselineSet.has(k)) : [];
  const removedSince = baselineSet.size ? [...baselineSet].filter((k) => !identitySet.has(k)) : [];
  const commonWith = baselineSet.size ? [...identitySet].filter((k) => baselineSet.has(k)).length : null;

  const normalised = rawVoyages.map((raw) =>
    normaliseDisneyVoyage(raw, { cruiseLine, ships, shipAliases, destinations, destinationAliases, today })
  );

  const waterfall = buildEligibilityWaterfall(normalised, today);
  const portAnalysis = analysePortResolution(normalised);
  const destAnalysis = analyseDestinationResolution(normalised);

  let dbRows = existingRows;
  if (!dbRows.length && supabaseQuery && cruiseLine?.id) {
    dbRows = await supabaseQuery(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(cruiseLine.id)}&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,status,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract,created_at,updated_at`
    );
  }

  const legacyAudit = legacyReconciliation.auditLegacyDisneyRows(dbRows || [], normalised, { ships });
  const writeManifest = buildProposedWriteManifest(normalised, dbRows || [], cruiseLine, legacyAudit);
  const duplicateSafety = legacyReconciliation.analyseDuplicateSafety(normalised, dbRows || [], writeManifest.manifest, legacyAudit, {
    disneyExternalKey,
    cruiseIdentityKey
  });
  const firstControlledBatch = legacyReconciliation.buildFirstControlledBatch(normalised, writeManifest.manifest);

  const shipResolved = normalised.filter((r) => r.ship_resolution?.resolved).length;
  const identityCollisions = source.countIdentityCollisions(
    normalised.map((r) => ({ official_product_key: r.official_sailing_id }))
  );
  const durationEligible = normalised.filter(
    (r) => r.eligibility.production_eligible || r.duration_validation?.valid !== false
  );
  const durationExact = normalised.filter((r) => r.duration_validation?.exact_match === true).length;
  const autoPublish = normalised.filter((r) => r.confidence?.outcome === "auto_publish").length;

  const qualityGate = {
    identity_coverage_pct: normalised.length
      ? Math.round((normalised.filter((r) => r.official_sailing_id).length / normalised.length) * 10000) / 100
      : 0,
    duplicate_official_identities: identityCollisions,
    ship_resolution_pct: normalised.length ? Math.round((shipResolved / normalised.length) * 10000) / 100 : 0,
    embarkation_resolution_pct: portAnalysis.embarkation.sailing_resolution_pct,
    destination_resolution_pct: destAnalysis.destination_resolution_pct,
    duration_validation_pct: normalised.length ? Math.round((durationExact / normalised.length) * 10000) / 100 : 0,
    eligibility_arithmetic_pass: waterfall.arithmetic.reconciles,
    source_complete: snapshot.expansion.expansion_errors === 0,
    passed:
      identityCollisions === 0 &&
      (normalised.length ? Math.round((shipResolved / normalised.length) * 10000) / 100 : 0) === 100 &&
      portAnalysis.embarkation.sailing_resolution_pct >= 95 &&
      destAnalysis.destination_resolution_pct >= 90 &&
      waterfall.arithmetic.reconciles,
    ready_for_first_controlled_import: false
  };
  qualityGate.ready_for_first_controlled_import =
    qualityGate.passed &&
    duplicateSafety.passed &&
    legacyAudit.safe &&
    writeManifest.summary.insert_active + writeManifest.summary.update_exact_existing + writeManifest.summary.update_exact_legacy_match > 0;

  return {
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    source_contract: source.SOURCE_CONTRACT,
    snapshot,
    raw_voyages: rawVoyages,
    products: normalised,
    source_unique_sailings: normalised.length,
    phase2a_baseline: baselineSet.size || phase2aBaselineIdentities.length || null,
    added_since_phase2a: addedSince,
    removed_since_phase2a: removedSince,
    common_with_phase2a: commonWith,
    eligibility: waterfall,
    port_analysis: portAnalysis,
    destination_analysis: destAnalysis,
    write_manifest: writeManifest,
    legacy_audit: legacyAudit,
    duplicate_safety: duplicateSafety,
    first_controlled_batch: firstControlledBatch,
    existing_rows: dbRows?.length || 0,
    quality_gate: qualityGate,
    metrics: {
      confidence_auto_publish_pct: normalised.length ? Math.round((autoPublish / normalised.length) * 10000) / 100 : 0,
      production_eligible_total: waterfall.waterfall.production_eligible,
      within_21_day_cutoff: waterfall.waterfall.within_21_day_cutoff,
      blocked_total:
        (waterfall.waterfall.blocked_unresolved || 0) +
        waterfall.waterfall.required_ship_unresolved +
        waterfall.waterfall.required_embark_port_unresolved +
        waterfall.waterfall.required_destination_unresolved +
        waterfall.waterfall.duration_validation_failed +
        waterfall.waterfall.confidence_gate_failure
    },
    url_strategy: {
      individual_url_available: false,
      generic_search_url: DISNEY_SEARCH_URL,
      verification: "Disney PAVAS does not expose stable per-sailing customer URLs; generic Find a Cruise URL used"
    },
    product_policy: {
      theme_metadata_retained_not_duplicated: true,
      cruisetours_in_source: 0,
      blocked_from_booking_excluded_from_auto_publish_only: false,
      has_availability_not_auto_excluded: true
    },
    api_calls: snapshot.api_calls
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  DISNEY_LINE_ID,
  DISNEY_SEARCH_URL,
  PRIMARY_EXCLUSION_ORDER,
  officialProductKey,
  classifyDisneyItineraryPort,
  extractEmbarkFromProductId,
  extractEmbarkFromProductName,
  parseDisneyProductTitleEndpoints,
  extractArrivalFromProductName,
  resolveDisneyItineraryPortText,
  resolveDisneyEmbarkation,
  disneyExternalKey,
  resolveDisneyShip,
  validateDisneyDuration,
  mergeDisneyStructuralContexts,
  buildDisneyRawVoyage,
  enrichSailingsFromCatalogue,
  assessSourceValidity,
  evaluateVoyageEligibility,
  buildEligibilityWaterfall,
  normaliseDisneyVoyage,
  buildDisneyUpsertCandidate,
  classifyProposedAction,
  buildProposedWriteManifest,
  analysePortResolution,
  analyseDestinationResolution,
  fetchDisneyCompleteSnapshot,
  simulateDisneyDiscovery
};
