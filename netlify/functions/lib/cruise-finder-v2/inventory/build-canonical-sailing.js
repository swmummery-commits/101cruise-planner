/**
 * Track.cruises provider row → CanonicalSailing (provider-independent inventory).
 */

const { stripProviderPrices, assertNoPrices } = require("./strip-prices");
const { classifyPortsList } = require("./classify-itinerary");
const { applyItineraryDates, toIsoDate } = require("./itinerary-dates");
const { matchCruiseLineEntity, matchShipEntity, companyDisplayName } = require("./match-entities-app");
const { matchProviderPort } = require("./match-provider-port");
const { buildSailingKey } = require("./dedupe-canonical");
const { evaluateRouteObjectEligibility } = require("./route-eligibility");

/**
 * @param {object} rawProviderCruise
 * @param {{ lines: any[], ships: any[], ports: any[], proposedPortAliases?: any[] }} catalogues
 */
function buildCanonicalSailing(rawProviderCruise, catalogues) {
  const { cleaned, removedFields } = stripProviderPrices(rawProviderCruise || {});
  const providerName = "track-cruises";

  const cruiseLine = matchCruiseLineEntity(cleaned.company, catalogues.lines);
  const ship = matchShipEntity(cleaned.ship_name, cruiseLine, catalogues.ships);

  const classified = classifyPortsList(cleaned.ports_list);
  const dated = applyItineraryDates({
    departureDate: cleaned.departure_date,
    nights: cleaned.duration,
    itinerary: classified
  });

  const itinerary = dated.itinerary.map((stop) => {
    if (stop.type === "sea") {
      return {
        dayNumber: stop.dayNumber,
        date: stop.date,
        type: "sea",
        providerPortName: stop.providerPortName,
        portId: null,
        canonicalPortName: null,
        latitude: null,
        longitude: null,
        matchStatus: "NOT_APPLICABLE"
      };
    }

    const match = matchProviderPort(stop.providerPortName, catalogues.ports, {
      proposedAliases: catalogues.proposedPortAliases
    });

    // Scenic may optionally link geography but keeps type
    const matchStatus =
      stop.type === "scenic_cruising"
        ? match.status === "MATCHED" || match.status === "ALIAS_MATCH"
          ? match.status
          : "NOT_FOUND"
        : match.status;

    return {
      dayNumber: stop.dayNumber,
      date: stop.date,
      type: stop.type,
      providerPortName: stop.providerPortName,
      portId: match.id,
      canonicalPortName: match.matchedName,
      latitude: match.latitude,
      longitude: match.longitude,
      matchStatus
    };
  });

  const embark = itinerary.find((s) => s.type === "embarkation");
  const disembark = itinerary.find((s) => s.type === "disembarkation");

  const matchable = itinerary.filter((s) => s.type !== "sea");
  const ordinary = itinerary.filter(
    (s) => s.type === "embarkation" || s.type === "port" || s.type === "disembarkation"
  );
  const matchedPorts = ordinary.filter(
    (s) => s.matchStatus === "MATCHED" || s.matchStatus === "ALIAS_MATCH"
  ).length;
  const aliasMatchedPorts = ordinary.filter((s) => s.matchStatus === "ALIAS_MATCH").length;
  const ambiguousPorts = ordinary.filter((s) => s.matchStatus === "AMBIGUOUS").length;
  const unmatchedPorts = ordinary.filter((s) => s.matchStatus === "NOT_FOUND").length;

  let sourceUrl = cleaned.itinerary_url == null ? "" : String(cleaned.itinerary_url).trim();
  if (!sourceUrl && cleaned.cruise_id != null) {
    sourceUrl = `https://track.cruises/cruise/${encodeURIComponent(String(cleaned.cruise_id))}`;
  }

  const title =
    cleaned.title == null || String(cleaned.title).trim() === ""
      ? `${cruiseLine.providerName || companyDisplayName(cleaned.company)} ${
          ship.providerName || ""
        } ${dated.departureDate}`.trim()
      : String(cleaned.title).trim();

  /** @type {import("./canonical-inventory").CanonicalSailing} */
  const sailing = {
    provider: providerName,
    providerCruiseId: cleaned.cruise_id == null ? "" : String(cleaned.cruise_id),
    providerItineraryId: cleaned.itinerary_id == null ? "" : String(cleaned.itinerary_id),
    sourceUrl,
    cruiseLine: {
      id: cruiseLine.id,
      canonicalName: cruiseLine.canonicalName,
      providerName: cruiseLine.providerName,
      matchStatus: cruiseLine.matchStatus
    },
    ship: {
      id: ship.id,
      canonicalName: ship.canonicalName,
      providerName: ship.providerName,
      matchStatus: ship.matchStatus
    },
    title,
    departureDate: dated.departureDate,
    returnDate: dated.returnDate,
    nights: dated.nights,
    departurePort: {
      portId: embark?.portId || null,
      canonicalName: embark?.canonicalPortName || null
    },
    arrivalPort: {
      portId: disembark?.portId || null,
      canonicalName: disembark?.canonicalPortName || null
    },
    destinations: Array.isArray(cleaned.destinations)
      ? cleaned.destinations.map((d) => String(d))
      : [],
    itinerary,
    matchSummary: {
      cruiseLineMatched: cruiseLine.matchStatus === "MATCHED",
      shipMatched: ship.matchStatus === "MATCHED",
      matchedPorts,
      aliasMatchedPorts,
      ambiguousPorts,
      unmatchedPorts,
      totalMatchablePorts: ordinary.length,
      seaDays: itinerary.filter((s) => s.type === "sea").length,
      scenicCruisingStops: itinerary.filter((s) => s.type === "scenic_cruising").length,
      ordinaryPortStops: ordinary.length
    },
    routeObjectEligible: false,
    routeObjectPreviewNote: null,
    dateConsistency: dated.dateConsistency,
    discoveredAt: new Date().toISOString(),
    providerUpdatedAt: cleaned.updated_at == null ? "" : String(cleaned.updated_at),
    sailingKey: "",
    _locale: cleaned.locale == null ? null : String(cleaned.locale),
    _removedPriceFields: removedFields
  };

  sailing.sailingKey = buildSailingKey(sailing);

  const route = evaluateRouteObjectEligibility(sailing);
  sailing.routeObjectEligible = route.routeObjectEligible;
  sailing.routeObjectPreviewNote = route.routeObjectEligible
    ? "Eligible — preview generated in-memory only."
    : `Not eligible: ${route.reasons.join(", ")}`;
  sailing._routePreview = route.preview;

  const priceCheck = assertNoPrices(sailing);
  if (!priceCheck.ok) {
    throw new Error(`Price fields leaked into canonical sailing: ${priceCheck.violations.join(", ")}`);
  }

  return sailing;
}

module.exports = {
  buildCanonicalSailing,
  toIsoDate
};
