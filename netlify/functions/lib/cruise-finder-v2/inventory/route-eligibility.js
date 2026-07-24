/**
 * Route Object eligibility + temporary in-memory preview (no production renderer).
 */

/**
 * @param {import("./canonical-inventory").CanonicalSailing} sailing
 */
function evaluateRouteObjectEligibility(sailing) {
  const reasons = [];
  const lineOk = sailing.cruiseLine?.matchStatus === "MATCHED";
  const shipOk = sailing.ship?.matchStatus === "MATCHED";
  if (!lineOk) reasons.push("cruise_line_not_matched");
  if (!shipOk) reasons.push("ship_not_matched");

  const embark = (sailing.itinerary || []).find((s) => s.type === "embarkation");
  const disembark = (sailing.itinerary || []).find((s) => s.type === "disembarkation");
  const embarkOk =
    embark &&
    (embark.matchStatus === "MATCHED" || embark.matchStatus === "ALIAS_MATCH") &&
    embark.latitude != null &&
    embark.longitude != null;
  const disembarkOk =
    disembark &&
    (disembark.matchStatus === "MATCHED" || disembark.matchStatus === "ALIAS_MATCH") &&
    disembark.latitude != null &&
    disembark.longitude != null;
  if (!embarkOk) reasons.push("embarkation_not_matched_with_coords");
  if (!disembarkOk) reasons.push("disembarkation_not_matched_with_coords");

  const ordinary = (sailing.itinerary || []).filter(
    (s) => s.type === "embarkation" || s.type === "port" || s.type === "disembarkation"
  );
  const unmatchedOrdinary = ordinary.filter(
    (s) => s.matchStatus !== "MATCHED" && s.matchStatus !== "ALIAS_MATCH"
  );
  if (unmatchedOrdinary.length) {
    reasons.push("ordinary_ports_unmatched");
  }

  const geoPoints = ordinary
    .filter(
      (s) =>
        (s.matchStatus === "MATCHED" || s.matchStatus === "ALIAS_MATCH") &&
        s.latitude != null &&
        s.longitude != null
    )
    .map((s) => `${Number(s.latitude).toFixed(4)},${Number(s.longitude).toFixed(4)}`);
  const distinct = new Set(geoPoints);
  if (distinct.size < 2) reasons.push("fewer_than_two_distinct_geo_points");

  const eligible = reasons.length === 0;

  /** Temporary preview — not the production Route Object / renderer. */
  let preview = null;
  if (eligible || distinct.size >= 2) {
    const stops = ordinary
      .filter(
        (s) =>
          (s.matchStatus === "MATCHED" || s.matchStatus === "ALIAS_MATCH") &&
          s.latitude != null &&
          s.longitude != null
      )
      .map((s, index) => ({
        sequence: index + 1,
        port_id: s.portId,
        name: s.canonicalPortName || s.providerPortName,
        latitude: s.latitude,
        longitude: s.longitude,
        stop_type: s.type,
        day_number: s.dayNumber
      }));
    preview = {
      version: "poc-preview-1",
      eligible,
      stop_count: stops.length,
      distinct_geo_points: distinct.size,
      stops,
      note: "In-memory preview only. Production marine-route / renderer not invoked."
    };
  }

  return {
    routeObjectEligible: eligible,
    reasons,
    preview
  };
}

module.exports = {
  evaluateRouteObjectEligibility
};
