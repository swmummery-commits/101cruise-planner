/**
 * Trusted evidence for official Carnival Corp structured Solr catalogue feeds (HAL, Seabourn).
 * Does not bypass reference resolution — only recognises first-party structured authority.
 */

const TRUSTED_STRUCTURED_SOURCES = new Set([
  "sbncruisesearch_api",
  "halcruisesearch_api"
]);

const TRUSTED_SHIP_METHODS = new Set([
  "official_line_ship_id",
  "seabourn_ship_code_map",
  "exact_name",
  "stored_alias"
]);

function evaluateCarnivalStructuredSourceTrust(input = {}) {
  const structuredSource =
    input.structured_source ||
    input.raw_extract?.structured_source ||
    input.raw?.structured_source ||
    null;

  if (!structuredSource || !TRUSTED_STRUCTURED_SOURCES.has(structuredSource)) {
    return {
      trusted: false,
      structured_source: structuredSource,
      reasons: ["not_official_carnival_structured_source"]
    };
  }

  const cruiseId = String(input.cruise_id || input.raw?.cruise_id || input.raw_extract?.seabourn_cruise_id || "").trim();
  const itineraryId = String(
    input.itinerary_id || input.raw?.itinerary_id || input.raw_extract?.seabourn_itinerary_id || ""
  ).trim();
  const officialIdentity = cruiseId && itineraryId ? `${itineraryId}|${cruiseId}` : null;

  const shipResolution = input.shipResolution || {};
  const portMeta = input.departure_port_meta || {};
  const destinationResolution = input.destinationResolution || {};
  const destinationResolved =
    destinationResolution.resolved === true ||
    Boolean(input.destination_id) ||
    Boolean(destinationResolution.destination_id);

  const criteria = {
    official_endpoint: TRUSTED_STRUCTURED_SOURCES.has(structuredSource),
    cruise_id: Boolean(cruiseId),
    itinerary_id: Boolean(itineraryId),
    official_identity: Boolean(officialIdentity),
    ship_resolved: shipResolution.resolved === true,
    ship_trusted_method: TRUSTED_SHIP_METHODS.has(shipResolution.method),
    departure_date: Boolean(input.departure_date || input.raw?.departure_date),
    duration: Number(input.nights || input.raw?.nights) > 0,
    embark_port_resolved: portMeta.status === "resolved" && Boolean(portMeta.canonicalPortName),
    destination_resolved: destinationResolved
  };

  const missing = Object.entries(criteria)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);

  const referenceResolutionReady =
    criteria.ship_resolved && criteria.embark_port_resolved && criteria.destination_resolved;

  const trusted =
    criteria.official_endpoint &&
    criteria.cruise_id &&
    criteria.itinerary_id &&
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
    ship_resolution_method: shipResolution.method || null,
    reasons: trusted ? [] : ["structured_source_criteria_incomplete", ...missing.map((m) => `missing_${m}`)]
  };
}

module.exports = {
  TRUSTED_STRUCTURED_SOURCES,
  TRUSTED_SHIP_METHODS,
  evaluateCarnivalStructuredSourceTrust
};
