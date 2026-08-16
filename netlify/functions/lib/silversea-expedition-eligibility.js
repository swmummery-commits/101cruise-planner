/**
 * Silversea Expedition eligibility evaluator (Phase E2 — read-only).
 * Classic eligibility is unchanged; use silversea-controlled-batch for Classic.
 */

const { officialProductKey } = require("./silversea-discovery-adapter");
const {
  EXPEDITION_SEMANTIC,
  SEMANTIC_CONFIDENCE,
  isExpeditionStopItineraryComplete
} = require("./silversea-expedition-semantics");
const {
  PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE,
  daysUntilDeparture
} = require("./public-discovered-cruise-inventory");

const EXPEDITION_EXCLUSIVE_BUCKETS = Object.freeze([
  "invalid_identity",
  "within_21_day_cutoff",
  "duration_mismatch",
  "ship_unresolved",
  "embark_unresolved",
  "disembark_unresolved",
  "destination_unresolved",
  "conventional_itinerary_port_unresolved",
  "ambiguous_semantic_itinerary",
  "expedition_e2_complete"
]);

const {
  isExpeditionEndpointResolved,
  resolveExpeditionLogisticsGateway
} = require("./silversea-expedition-endpoint-resolution");
const { resolveRawPortText } = require("./discovery-departure-port");

const HYPOTHETICAL_DESTINATION_SLUGS = Object.freeze({
  "arctic & greenland": "arctic-greenland"
});

function isExpeditionProduct(raw) {
  return String(raw?.cruise_type || "").trim().toLowerCase() === "expedition";
}

function hasDurationExactMatch(raw) {
  return raw?.duration_matches_dates === true;
}

function endpointCanonicallyResolved(portMeta) {
  return isExpeditionEndpointResolved(portMeta);
}

function analyseExpeditionItineraryStops(stops = []) {
  let conventionalResolved = 0;
  let deterministicNonPort = 0;
  let ambiguous = 0;
  let conventionalUnresolved = 0;
  const ambiguousStops = [];

  for (const stop of stops) {
    if (stop.kind !== "port") continue;

    const classification = {
      expedition_semantic: stop.expedition_semantic,
      semantic_confidence: stop.semantic_confidence,
      canonical_port: stop.port_resolution?.canonicalPortName || null
    };

    if (stop.semantic_confidence === SEMANTIC_CONFIDENCE.AMBIGUOUS || !stop.expedition_semantic) {
      ambiguous += 1;
      ambiguousStops.push(stop);
      continue;
    }

    if (stop.expedition_semantic === EXPEDITION_SEMANTIC.CONVENTIONAL_PORT) {
      if (stop.port_resolution?.status === "resolved") {
        conventionalResolved += 1;
      } else {
        conventionalUnresolved += 1;
      }
      continue;
    }

    if (isExpeditionStopItineraryComplete(classification, stop.port_resolution)) {
      deterministicNonPort += 1;
    } else {
      ambiguous += 1;
      ambiguousStops.push(stop);
    }
  }

  return {
    conventionalResolved,
    deterministicNonPort,
    ambiguous,
    conventionalUnresolved,
    ambiguousStops,
    portStopCount: stops.filter((s) => s.kind === "port").length
  };
}

function classifyExpeditionExclusiveBucket(normalised, today = new Date().toISOString().slice(0, 10)) {
  const raw = normalised?.raw || {};
  const officialId = normalised?.official_sailing_id || officialProductKey(raw);
  const dep = normalised?.candidate?.departure_date || raw.departure_date;

  if (!raw.cruise_code_valid || !officialId) return "invalid_identity";

  const days = dep ? daysUntilDeparture(dep, today) : null;
  if (days != null && days < PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE) {
    return "within_21_day_cutoff";
  }

  if (!hasDurationExactMatch(raw)) return "duration_mismatch";
  if (!normalised.ship_resolution?.resolved) return "ship_unresolved";
  if (!endpointCanonicallyResolved(normalised.departure_port_resolution)) return "embark_unresolved";
  if (!endpointCanonicallyResolved(normalised.arrival_port_resolution)) return "disembark_unresolved";
  if (normalised.destination_resolution?.status !== "resolved" || !normalised.candidate?.destination_id) {
    return "destination_unresolved";
  }

  const itinerary = normalised.itinerary || normalised.candidate?.raw_extract?.itinerary_stops || [];
  const analysis = analyseExpeditionItineraryStops(itinerary);
  if (analysis.conventionalUnresolved > 0) return "conventional_itinerary_port_unresolved";
  if (analysis.ambiguous > 0) return "ambiguous_semantic_itinerary";

  if (
    !normalised.complete_high_confidence ||
    (normalised.failure_reasons || []).length > 0 ||
    !raw.detail_enriched
  ) {
    return "ambiguous_semantic_itinerary";
  }

  return "expedition_e2_complete";
}

function evaluateExpeditionEligibility(normalised, today = new Date().toISOString().slice(0, 10)) {
  const raw = normalised?.raw || {};
  const itinerary = normalised.itinerary || normalised.candidate?.raw_extract?.itinerary_stops || [];
  const analysis = analyseExpeditionItineraryStops(itinerary);
  const exclusiveBucket = classifyExpeditionExclusiveBucket(normalised, today);

  const blockerReasons = [];
  if (!raw.cruise_code_valid) blockerReasons.push("invalid_identity");
  if (!hasDurationExactMatch(raw)) blockerReasons.push("duration_mismatch");
  if (!normalised.ship_resolution?.resolved) blockerReasons.push("ship_unresolved");
  if (!endpointCanonicallyResolved(normalised.departure_port_resolution)) blockerReasons.push("embark_unresolved");
  if (!endpointCanonicallyResolved(normalised.arrival_port_resolution)) blockerReasons.push("disembark_unresolved");
  if (normalised.destination_resolution?.status !== "resolved" || !normalised.candidate?.destination_id) {
    blockerReasons.push("destination_unresolved");
  }
  if (analysis.conventionalUnresolved > 0) blockerReasons.push("conventional_itinerary_port_unresolved");
  if (analysis.ambiguous > 0) blockerReasons.push("ambiguous_semantic_itinerary");

  return {
    cruise_code: officialProductKey(raw),
    ship: raw.ship_name || null,
    departure: raw.departure_date || null,
    destination: raw.destination_name || null,
    endpoint_status: {
      embark: normalised.departure_port_resolution?.status || "missing",
      disembark: normalised.arrival_port_resolution?.status || "missing"
    },
    duration_status: hasDurationExactMatch(raw) ? "match" : "mismatch",
    itinerary_stop_count: itinerary.length,
    resolved_conventional_port_count: analysis.conventionalResolved,
    deterministic_semantic_non_port_count: analysis.deterministicNonPort,
    ambiguous_stop_count: analysis.ambiguous,
    exclusive_bucket: exclusiveBucket,
    eligible: exclusiveBucket === "expedition_e2_complete",
    blocker_reasons: blockerReasons,
    ambiguous_stops: analysis.ambiguousStops.map((s) => ({
      port_name: s.port_name,
      port_code: s.port_code,
      ambiguity_reason: s.ambiguity_reason,
      expedition_semantic: s.expedition_semantic
    }))
  };
}

function applyHypotheticalEndpointResolution(portMeta, rawName, portCode) {
  if (endpointCanonicallyResolved(portMeta)) return portMeta;
  const gateway = resolveExpeditionLogisticsGateway({ sourceName: rawName, portCode });
  if (gateway) return gateway;
  const catalogue = resolveRawPortText(rawName);
  if (catalogue.status === "resolved") return catalogue;
  return portMeta;
}

function applyHypotheticalDestinationResolution(normalised) {
  const rawDest = String(normalised?.raw?.destination_name || "").trim().toLowerCase();
  const slug = HYPOTHETICAL_DESTINATION_SLUGS[rawDest];
  if (!slug) return normalised.destination_resolution;
  if (normalised.destination_resolution?.status === "resolved") return normalised.destination_resolution;
  return {
    status: "resolved",
    destinationKey: slug,
    method: "hypothetical_e2c_arctic_greenland"
  };
}

function evaluateHypotheticalExpeditionEligibility(normalised, today = new Date().toISOString().slice(0, 10)) {
  const hypotheticalDest = applyHypotheticalDestinationResolution(normalised);
  const hypotheticalEmbark = applyHypotheticalEndpointResolution(
    normalised.departure_port_resolution,
    normalised.raw?.departure_port,
    normalised.raw?.departure_port_code
  );
  const hypotheticalDisembark = applyHypotheticalEndpointResolution(
    normalised.arrival_port_resolution,
    normalised.raw?.arrival_port,
    normalised.raw?.arrival_port_code
  );
  const hypothetical = {
    ...normalised,
    departure_port_resolution: hypotheticalEmbark,
    arrival_port_resolution: hypotheticalDisembark,
    destination_resolution:
      normalised.destination_resolution?.status === "resolved" ? normalised.destination_resolution : hypotheticalDest,
    candidate: {
      ...(normalised.candidate || {}),
      destination_id:
        normalised.candidate?.destination_id ||
        (hypotheticalDest.status === "resolved" ? "hypothetical-dest-id" : null),
      departure_port:
        hypotheticalEmbark.status === "resolved"
          ? hypotheticalEmbark.canonicalPortName
          : normalised.candidate?.departure_port
    },
    failure_reasons: (normalised.failure_reasons || []).filter(
      (r) =>
        ![
          "missing_departure_port",
          "missing_arrival_port",
          "destination_unresolved",
          "destination_ambiguous",
          "destination_missing_catalogue_id"
        ].includes(r) && !String(r).startsWith("validation:")
    ),
    complete_high_confidence: true,
    match_required: false
  };
  return evaluateExpeditionEligibility(hypothetical, today);
}

function isArcticGreenlandDestination(raw) {
  return String(raw?.destination_name || "")
    .trim()
    .toUpperCase() === "ARCTIC & GREENLAND";
}

function isArcticGreenlandAnalyticalGroup(raw) {
  const dest = String(raw?.destination_name || "").toUpperCase();
  const itinerary = (raw?.itinerary || [])
    .map((s) => `${s.port_name || ""} ${s.port_code || ""}`)
    .join(" ")
    .toUpperCase();
  return (
    dest.includes("ARCTIC") ||
    dest.includes("GREENLAND") ||
    /\bNOE\d+\b/.test(itinerary) ||
    /\bGL[EGJ]\w+\b/.test(itinerary) ||
    /\bSVALBARD\b/i.test(itinerary)
  );
}

function isGalapagosGroup(raw) {
  return String(raw?.destination_name || "")
    .toLowerCase()
    .includes("galápagos") ||
    String(raw?.destination_name || "")
      .toLowerCase()
      .includes("galapagos");
}

function isAntarcticaGroup(raw) {
  return String(raw?.destination_name || "")
    .trim()
    .toLowerCase() === "antarctica";
}

function isKimberleyGroup(raw) {
  return String(raw?.destination_name || "")
    .trim()
    .toLowerCase() === "kimberley";
}

function isPacificGroup(raw) {
  return String(raw?.destination_name || "")
    .trim()
    .toLowerCase() === "french polynesia & pacific";
}

function isComboSegmentProduct(raw) {
  const id = String(raw?.cruise_code || raw?.official_id || raw?.official_sailing_id || "").toUpperCase();
  return /[CS]\d/.test(id);
}

module.exports = {
  EXPEDITION_EXCLUSIVE_BUCKETS,
  isExpeditionProduct,
  endpointCanonicallyResolved,
  analyseExpeditionItineraryStops,
  classifyExpeditionExclusiveBucket,
  evaluateExpeditionEligibility,
  evaluateHypotheticalExpeditionEligibility,
  isArcticGreenlandDestination,
  isArcticGreenlandAnalyticalGroup,
  isGalapagosGroup,
  isAntarcticaGroup,
  isKimberleyGroup,
  isPacificGroup,
  isComboSegmentProduct
};
