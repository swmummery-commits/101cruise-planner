/**
 * Silversea Cruises — dedicated Gatsby catalogue Discovery adapter.
 * Official source: silversea.com page-data JSON. Does not use RCL/Celebrity GraphQL.
 * This module does not write to production.
 */

const { resolveShipForLine } = require("./discovery-ship-resolver");
const { resolveOperationalDestination } = require("./discovery-destination-resolver");
const { resolveRawPortText } = require("./discovery-departure-port");
const { validateCruise } = require("./cruise-discovery");
const { provesIndividualSailing } = require("./discovery-non-sailing-filter");
const { catalogueDestinations } = require("./holland-america-discovery-adapter");
const {
  partitionByPublicBookingCutoff,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require("./public-discovered-cruise-inventory");
const {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  OBSERVED_SHIP_PREFIXES,
  officialProductKey,
  trimShipName,
  classifyItineraryStopKind,
  fetchAllSilverseaRawVoyages
} = require("./silversea-discovery-source");
const { SILVERSEA_ADAPTER_PORT_ALIASES } = require("./silversea-port-remediation");

const LINE_NAME = "Silversea Cruises";
const LINE_SLUG = "silversea-cruises";
const ACCEPTED_SHIP_METHODS = new Set(["exact_name", "official_line_ship_id", "stored_alias"]);

/** Unambiguous Silversea region labels → existing operational destination slugs. */
const SILVERSEA_DESTINATION_SLUG = Object.freeze({
  mediterranean: "mediterranean",
  alaska: "alaska",
  "galápagos islands": "galapagos",
  "galapagos islands": "galapagos",
  galapagos: "galapagos",
  asia: "asia",
  "canada & new england": "canada-new-england",
  antarctica: "antarctica",
  "africa & indian ocean": "africa",
  "caribbean & central america": "caribbean",
  "australia & new zealand": "australia-new-zealand",
  "south america": "south-america",
  "french polynesia & pacific": "south-pacific",
  kimberley: "australia-new-zealand"
});

/**
 * Reviewed Silversea embark/itinerary labels → existing catalogue names.
 * Used only after the shared resolver fails. Not written to the ports table.
 */
const SILVERSEA_PORT_ALIASES = Object.freeze({
  ...SILVERSEA_ADAPTER_PORT_ALIASES,
  "athens (piraeus)": "Piraeus",
  "civitavecchia (rome)": "Civitavecchia",
  "fusina (venice)": "Venice",
  "ijmuiden (amsterdam)": "IJmuiden",
  "seward (anchorage, alaska)": "Seward",
  "fremantle (perth), western australia": "Fremantle",
  "san cristóbal, galapagos": "San Cristobal",
  "san cristobal, galapagos": "San Cristobal",
  "malaga (costa del sol)": "Malaga",
  "yokohama (tokyo)": "Yokohama",
  "nuuk (godthab)": "Nuuk"
});

function isEligibleSilverseaCruise(productType) {
  return productType === "ocean_cruise" || productType === "expedition_cruise";
}

function classifySilverseaProductType(raw) {
  if (raw?.deferred_special_voyage) return "deferred_special_voyage";
  if (!raw?.cruise_code_valid) return "invalid_identity";
  const type = String(raw.cruise_type || "").trim().toLowerCase();
  if (type === "expedition") return "expedition_cruise";
  if (type === "classic") return "ocean_cruise";
  if (raw.collection === "cruises") return "ocean_cruise";
  return "unknown";
}

function destinationFallbackSlug(destinationName) {
  const key = String(destinationName || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return SILVERSEA_DESTINATION_SLUG[key] || null;
}

function aliasPortName(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return SILVERSEA_PORT_ALIASES[raw.toLowerCase()] || raw;
}

function resolveSilverseaPort(value, sourceField) {
  const aliased = aliasPortName(value);
  if (!aliased) {
    return resolveRawPortText(value, { sourceField });
  }
  const direct = resolveRawPortText(aliased, { sourceField });
  if (direct.status === "resolved") return direct;
  if (aliased !== value) {
    const original = resolveRawPortText(value, { sourceField });
    if (original.status === "resolved") return original;
  }
  return direct;
}

function resolveSilverseaShip(raw, context = {}) {
  const name = trimShipName(raw?.ship_name);
  const resolution = resolveShipForLine({
    rawShipName: name,
    rawShipCode: null,
    cruiseLineId: context.cruiseLine?.id,
    cruiseLineName: context.cruiseLine?.name || LINE_NAME,
    ships: context.ships || [],
    aliases: context.shipAliases || []
  });
  if (!resolution.resolved) return { ...resolution, raw_name: name };
  if (!ACCEPTED_SHIP_METHODS.has(resolution.method)) {
    return {
      resolved: false,
      reason: "non_deterministic_ship_method",
      method: resolution.method,
      confidence: resolution.confidence,
      raw_name: name,
      rejected_ship: resolution.ship?.name || null
    };
  }
  return { ...resolution, raw_name: name };
}

function destinationRowIdForSlug(destinations, slug) {
  if (!slug) return null;
  const needle = String(slug).trim().toLowerCase();
  const row = (destinations || []).find((d) => String(d?.slug || "").toLowerCase() === needle && d?.id);
  return row ? row.id : null;
}

function mapItineraryStops(raw) {
  return (raw.itinerary || []).map((stop) => {
    const kind = stop.kind || classifyItineraryStopKind(stop.port_name);
    let port_resolution = null;
    if (kind === "port") {
      port_resolution = resolveSilverseaPort(stop.port_name, "silversea_gatsby_itinerary");
    }
    return {
      ...stop,
      kind,
      port_resolution
    };
  });
}

function embarkDisembarkReconcile(raw, itinerary) {
  const portStops = itinerary.filter((s) => s.kind === "port");
  const first = portStops[0] || null;
  const last = portStops[portStops.length - 1] || null;
  const issues = [];
  if (raw.detail_enriched && raw.departure_port && first?.port_name) {
    const a = String(raw.departure_port).toLowerCase();
    const b = String(first.port_name).toLowerCase();
    if (a !== b && !a.includes(b) && !b.includes(a)) {
      issues.push({
        field: "embarkation",
        catalogue: raw.departure_port,
        itinerary: first.port_name
      });
    }
  }
  if (raw.detail_enriched && raw.arrival_port && last?.port_name) {
    const a = String(raw.arrival_port).toLowerCase();
    const b = String(last.port_name).toLowerCase();
    if (a !== b && !a.includes(b) && !b.includes(a)) {
      issues.push({
        field: "disembarkation",
        catalogue: raw.arrival_port,
        itinerary: last.port_name
      });
    }
  }
  return { first, last, issues };
}

function normaliseSilverseaProduct(raw, context = {}) {
  const productType = classifySilverseaProductType(raw);
  const officialId = officialProductKey(raw);
  const nights = raw.source_duration;
  const shipResolution = resolveSilverseaShip(raw, context);
  const embarkMeta = resolveSilverseaPort(raw.departure_port, "silversea_gatsby_catalogue");
  const disembarkMeta = resolveSilverseaPort(raw.arrival_port, "silversea_gatsby_catalogue");
  const itinerary = mapItineraryStops(raw);
  const reconcile = embarkDisembarkReconcile(raw, itinerary);

  const itineraryLabel = [raw.departure_port, raw.arrival_port].filter(Boolean).join(" to ") || officialId;
  const itineraryPortText = itinerary
    .filter((s) => s.kind === "port")
    .map((s) => s.port_name)
    .filter(Boolean)
    .join(", ");

  const candidate = {
    cruise_line_id: context.cruiseLine?.id,
    ship_id: shipResolution.resolved ? shipResolution.ship.id : null,
    departure_date: raw.departure_date,
    return_date: raw.return_date,
    nights,
    departure_port: embarkMeta.status === "resolved" ? embarkMeta.canonicalPortName : null,
    departure_port_meta: embarkMeta,
    itinerary: itineraryLabel,
    official_url: raw.official_url,
    source_url: raw.official_url,
    official_sailing_id: officialId,
    raw_extract: {
      silversea_cruise_code: officialId,
      silversea_code_kind: raw.code_kind,
      silversea_ship_prefix: raw.ship_prefix,
      silversea_cruise_type: raw.cruise_type,
      silversea_product_type: productType,
      source_duration: raw.source_duration,
      calculated_nights: raw.calculated_nights,
      duration_matches_dates: raw.duration_matches_dates,
      structured_source: raw.structured_source,
      departure_port_raw: raw.departure_port,
      arrival_port_raw: raw.arrival_port,
      destination_raw: raw.destination_name,
      destination_id_source: raw.destination_id_source || null,
      destination_web_code: raw.destination_web_code || null,
      itinerary_stops: itinerary,
      full_path: raw.full_path
    }
  };

  const destInput = {
    title: itineraryLabel,
    description: [raw.destination_name, itineraryPortText].filter(Boolean).join(" "),
    itinerary: itineraryPortText || itineraryLabel,
    departurePort: candidate.departure_port || raw.departure_port,
    arrivalPort: disembarkMeta.status === "resolved" ? disembarkMeta.canonicalPortName : raw.arrival_port,
    nights,
    destinations: context.destinations || [],
    destinationAliases: context.destinationAliases || []
  };

  let destResult = resolveOperationalDestination(destInput);
  let destMethod = "silversea_itinerary_evidence";
  const fallbackSlug = destinationFallbackSlug(raw.destination_name);
  if (destResult.status !== "resolved" && fallbackSlug) {
    const fallback = resolveOperationalDestination({
      ...destInput,
      preferredDestination: { slug: fallbackSlug }
    });
    if (fallback.status === "resolved") {
      destResult = fallback;
      destMethod = `silversea_region_${fallbackSlug}`;
    }
  }

  candidate.destination_id =
    destResult.status === "resolved"
      ? destResult.destinationId || destinationRowIdForSlug(context.destinations, destResult.destinationKey)
      : null;
  candidate.raw_extract.silversea_destination_method = destMethod;

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
    ships: (context.ships || []).filter((s) => s.cruise_line_id === context.cruiseLine?.id),
    ship_name_guess: raw.ship_name,
    official_sailing_id: officialId
  });

  const itineraryPortStops = itinerary.filter((s) => s.kind === "port");
  const itineraryPortsResolved = itineraryPortStops.filter((s) => s.port_resolution?.status === "resolved");
  const itineraryPortsUnresolved = itineraryPortStops.filter((s) => s.port_resolution?.status !== "resolved");

  const failureReasons = [];
  if (productType === "deferred_special_voyage") failureReasons.push("deferred_special_voyage");
  if (productType === "invalid_identity") failureReasons.push("missing_official_identity");
  if (!officialId) failureReasons.push("missing_official_identity");
  if (!shipResolution.resolved) failureReasons.push("unknown_ship");
  if (!candidate.departure_date) failureReasons.push("missing_departure_date");
  if (embarkMeta.status !== "resolved") failureReasons.push("missing_departure_port");
  if (disembarkMeta.status !== "resolved") failureReasons.push("missing_arrival_port");
  if (!raw.detail_enriched) failureReasons.push("detail_page_not_enriched");
  if (raw.detail_error) failureReasons.push(`detail_fetch:${raw.detail_error}`);
  if (destResult.status === "unresolved") failureReasons.push("destination_unresolved");
  if (destResult.status === "ambiguous") failureReasons.push("destination_ambiguous");
  if (destResult.status === "resolved" && !candidate.destination_id) {
    failureReasons.push("destination_missing_catalogue_id");
  }
  if (validationReasons.length) failureReasons.push(...validationReasons.map((r) => `validation:${r}`));
  if (!individual.proven) failureReasons.push("individual_sailing_unproven");

  const matchRequired =
    !shipResolution.resolved ||
    embarkMeta.status !== "resolved" ||
    destResult.status === "unresolved" ||
    destResult.status === "ambiguous";

  const complete =
    isEligibleSilverseaCruise(productType) &&
    Boolean(officialId) &&
    Boolean(raw.detail_enriched) &&
    shipResolution.resolved &&
    Boolean(candidate.departure_date) &&
    Boolean(candidate.return_date) &&
    nights != null &&
    embarkMeta.status === "resolved" &&
    disembarkMeta.status === "resolved" &&
    destResult.status === "resolved" &&
    Boolean(candidate.destination_id) &&
    individual.proven &&
    validationReasons.length === 0;

  return {
    raw,
    candidate,
    product_type: productType,
    official_sailing_id: officialId,
    ship_resolution: shipResolution,
    destination_resolution: destResult,
    departure_port_resolution: embarkMeta,
    arrival_port_resolution: disembarkMeta,
    itinerary,
    itinerary_reconcile: reconcile,
    itinerary_ports_resolved: itineraryPortsResolved.length,
    itinerary_ports_unresolved: itineraryPortsUnresolved.length,
    validation_reasons: validationReasons,
    individual_gate: individual,
    complete_high_confidence: complete,
    match_required: matchRequired && isEligibleSilverseaCruise(productType),
    failure_reasons: [...new Set(failureReasons)],
    nights_rule: {
      nights_field: "source_duration",
      source_duration: raw.source_duration,
      calculated_nights: raw.calculated_nights,
      duration_matches_dates: raw.duration_matches_dates
    }
  };
}

function classifyAgainstExisting(result, existingByOfficialId, legacyRows) {
  const id = result.official_sailing_id;
  if (id && existingByOfficialId.has(id)) {
    return { class: "recognised_existing_official_id", existing_id: existingByOfficialId.get(id).id };
  }
  if (!id) return { class: "unresolved_identity" };

  const pathCodeMatches = (legacyRows || []).filter((row) => {
    const fromUrl = String(row.official_url || row.source_url || "");
    return fromUrl.toLowerCase().includes(String(id).toLowerCase());
  });
  if (pathCodeMatches.length === 1) {
    return { class: "possible_legacy_hidden_match", existing_id: pathCodeMatches[0].id };
  }
  if (pathCodeMatches.length > 1) {
    return { class: "unresolved_identity", reason: "ambiguous_legacy_url_match" };
  }
  return { class: "new" };
}

function collectUnresolvedPorts(normalised) {
  const byKey = new Map();
  function add(sourceName, sourceCode, destination, sailingId, role) {
    if (!sourceName && !sourceCode) return;
    const key = `${String(sourceName || "").toLowerCase()}|${String(sourceCode || "").toLowerCase()}|${role}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        source_name: sourceName || null,
        source_code: sourceCode || null,
        destination: destination || null,
        role,
        affected_sailings: 0,
        sample_sailing_ids: []
      });
    }
    const row = byKey.get(key);
    row.affected_sailings += 1;
    if (row.sample_sailing_ids.length < 5 && sailingId) row.sample_sailing_ids.push(sailingId);
  }

  for (const n of normalised) {
    if (!isEligibleSilverseaCruise(n.product_type)) continue;
    if (n.departure_port_resolution?.status !== "resolved") {
      add(n.raw.departure_port, n.raw.departure_port_code, n.raw.destination_name, n.official_sailing_id, "embark");
    }
    if (n.arrival_port_resolution?.status !== "resolved") {
      add(n.raw.arrival_port, n.raw.arrival_port_code, n.raw.destination_name, n.official_sailing_id, "disembark");
    }
    for (const stop of n.itinerary || []) {
      if (stop.kind !== "port") continue;
      if (stop.port_resolution?.status !== "resolved") {
        add(stop.port_name, stop.port_code, n.raw.destination_name, n.official_sailing_id, "itinerary");
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.affected_sailings - a.affected_sailings);
}

async function simulateSilverseaInventory(context = {}) {
  const today = context.today || new Date().toISOString().slice(0, 10);
  const fetchResult = await fetchAllSilverseaRawVoyages({
    today,
    enrich: context.enrich !== false,
    concurrency: context.concurrency,
    requestDelayMs: context.requestDelayMs,
    maxVoyages: context.maxVoyages,
    transport: context.transport,
    catalogueUrl: context.catalogueUrl,
    allowUnhealthy: context.allowUnhealthy
  });

  const existingRows = context.existingRows || [];
  const existingByOfficialId = new Map(
    existingRows
      .filter((row) => row.official_sailing_id)
      .map((row) => [String(row.official_sailing_id).toUpperCase(), row])
  );

  const normalised = [];
  const failureCounts = {};
  for (const raw of fetchResult.products || []) {
    const result = normaliseSilverseaProduct(raw, context);
    result.identity_class = classifyAgainstExisting(result, existingByOfficialId, existingRows);
    normalised.push(result);
    for (const reason of result.failure_reasons) {
      failureCounts[reason] = (failureCounts[reason] || 0) + 1;
    }
  }

  const specialNormalised = (fetchResult.special_voyages || []).map((raw) => {
    const result = normaliseSilverseaProduct(raw, context);
    result.identity_class = { class: "deferred_special_voyage" };
    return result;
  });

  const cruises = normalised.filter((n) => isEligibleSilverseaCruise(n.product_type));
  const { publiclyEligible, withinCutoff } = partitionByPublicBookingCutoff(
    cruises,
    (p) => p.candidate?.departure_date,
    today
  );
  const departed = cruises.filter((n) => n.candidate?.departure_date && n.candidate.departure_date < today);
  const complete = cruises.filter((n) => n.complete_high_confidence);
  const matchRequired = cruises.filter((n) => n.match_required);
  const eligibleComplete = publiclyEligible.filter((n) => n.complete_high_confidence);

  const codes = cruises.map((n) => n.official_sailing_id).filter(Boolean);
  const uniqueIds = new Set(codes);

  const itineraryPortTotal = cruises.reduce(
    (n, row) => n + (row.itinerary || []).filter((s) => s.kind === "port").length,
    0
  );
  const itineraryPortResolved = cruises.reduce((n, row) => n + (row.itinerary_ports_resolved || 0), 0);

  return {
    ok: fetchResult.ok,
    fetch_failed: fetchResult.fetch_failed,
    writes: false,
    today,
    public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    source_contract: SOURCE_CONTRACT,
    observed_ship_prefixes: OBSERVED_SHIP_PREFIXES,
    products: normalised,
    special_voyages: specialNormalised,
    publicly_eligible: publiclyEligible,
    within_public_cutoff: withinCutoff,
    complete_high_confidence: complete,
    fetch_result: fetchResult,
    nights_rule: {
      nights_field: "source_duration",
      rationale:
        "Silversea publishes an official days duration on the sailing. Use that for discovered_cruises.nights. calculated_nights is retained for audit only."
    },
    summary: {
      catalogue_nodes: fetchResult.num_found_official,
      unique_cruise_codes: uniqueIds.size,
      duplicate_official_sailing_ids: codes.length - uniqueIds.size,
      classic: cruises.filter((n) => String(n.raw.cruise_type || "").toLowerCase() === "classic").length,
      expedition: cruises.filter((n) => String(n.raw.cruise_type || "").toLowerCase() === "expedition").length,
      numeric_codes: cruises.filter((n) => n.raw.code_kind === "numeric").length,
      combination_codes: cruises.filter((n) => n.raw.code_kind === "combination").length,
      segment_codes: cruises.filter((n) => n.raw.code_kind === "segment").length,
      deferred_special_voyages: specialNormalised.length,
      departed: departed.length,
      within_21_day_cutoff: withinCutoff.length,
      eligible_beyond_cutoff: publiclyEligible.length,
      ships_resolved: cruises.filter((n) => n.ship_resolution.resolved).length,
      ships_unresolved: cruises.filter((n) => !n.ship_resolution.resolved).length,
      embark_resolved: cruises.filter((n) => n.departure_port_resolution.status === "resolved").length,
      embark_unresolved: cruises.filter((n) => n.departure_port_resolution.status !== "resolved").length,
      disembark_resolved: cruises.filter((n) => n.arrival_port_resolution.status === "resolved").length,
      disembark_unresolved: cruises.filter((n) => n.arrival_port_resolution.status !== "resolved").length,
      itinerary_ports_total: itineraryPortTotal,
      itinerary_ports_resolved: itineraryPortResolved,
      itinerary_ports_unresolved: itineraryPortTotal - itineraryPortResolved,
      destinations_resolved: cruises.filter((n) => n.destination_resolution.status === "resolved").length,
      destinations_unresolved: cruises.filter((n) => n.destination_resolution.status !== "resolved").length,
      complete_high_confidence: complete.length,
      match_required: matchRequired.length,
      incomplete_or_rejected: cruises.length - complete.length,
      identity_new: normalised.filter((n) => n.identity_class?.class === "new").length,
      identity_recognised_existing: normalised.filter((n) => n.identity_class?.class === "recognised_existing_official_id")
        .length,
      identity_possible_legacy: normalised.filter((n) => n.identity_class?.class === "possible_legacy_hidden_match")
        .length,
      eligible_complete_beyond_cutoff: eligibleComplete.length,
      duration_mismatches: fetchResult.audit?.duration_mismatches?.length || 0,
      failure_counts: failureCounts
    },
    unresolved_ships: [
      ...new Set(cruises.filter((n) => !n.ship_resolution.resolved).map((n) => n.raw.ship_name).filter(Boolean))
    ],
    unresolved_ports: collectUnresolvedPorts(cruises),
    unresolved_destinations: cruises
      .filter((n) => n.destination_resolution.status !== "resolved")
      .map((n) => ({
        cruise_code: n.official_sailing_id,
        destination_name: n.raw.destination_name,
        status: n.destination_resolution.status
      })),
    duration_mismatches: fetchResult.audit?.duration_mismatches || [],
    catalogue_detail_discrepancies: cruises.flatMap((n) =>
      (n.itinerary_reconcile?.issues || []).map((issue) => ({
        cruise_code: n.official_sailing_id,
        ...issue
      }))
    ),
    health: fetchResult.health || null
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  LINE_NAME,
  LINE_SLUG,
  SILVERSEA_DESTINATION_SLUG,
  SILVERSEA_PORT_ALIASES,
  isEligibleSilverseaCruise,
  classifySilverseaProductType,
  destinationFallbackSlug,
  resolveSilverseaShip,
  resolveSilverseaPort,
  normaliseSilverseaProduct,
  classifyAgainstExisting,
  simulateSilverseaInventory,
  catalogueDestinations,
  officialProductKey
};
