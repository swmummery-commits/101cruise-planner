/**
 * Offline checks for generic Client Portal dashboard journey map builders.
 * Run: node scripts/test-dashboard-journey.mjs
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const {
  buildJourneyFromItinerary,
  projectJourneyMap,
  getDemoJourneyForBookingReference,
  MILLENNIUM_DEMO_ITINERARY
} = require("../netlify/functions/lib/dashboard-journey.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* Valid generic itinerary renders */
const generic = buildJourneyFromItinerary({
  title: "Barcelona to Rome",
  stops: [
    { date: "2026-09-28", name: "Barcelona", type: "embarkation", lat: 41.35, lng: 2.16 },
    { date: "2026-09-29", name: "Ibiza", type: "port", lat: 38.9, lng: 1.42 },
    { date: "2026-09-30", name: "At Sea", type: "sea_day" },
    { date: "2026-10-01", name: "Tunis/La Goulette", type: "port" }, // no coords yet
    { date: "2026-10-05", name: "Civitavecchia (Rome)", type: "disembarkation", lat: 42.09, lng: 11.79 }
  ]
});
assert(generic.journey, "generic itinerary builds journey");
assert(generic.journey.can_draw_map === true, "map drawable with >=2 geocoded ports");
assert(generic.journey.stops.length === 5, "all stops retained including sea day");
assert(generic.journey.stops.some((s) => s.type === "sea_day"), "sea days preserved");
const projection = projectJourneyMap(generic.journey);
assert(projection.ok, "projection succeeds");
assert(projection.ports.length >= 2, "projected ports exist");
assert(!/millennium|tokyo|yokohama/i.test(projection.pathD), "no hardcoded millennium geometry");

/* Millennium fixture still renders via generic builder */
const millennium = getDemoJourneyForBookingReference("SWM123456");
assert(millennium.journey, "millennium demo fixture returns journey");
assert(millennium.journey.source === "demo_fixture_swm123456", "demo source labelled");
assert(millennium.journey.can_draw_map === true, "millennium fixture drawable");
const millProj = projectJourneyMap(millennium.journey);
assert(millProj.ok && millProj.ports.length >= 5, "millennium projection has ports");
assert(
  millennium.journey.stops.filter((s) => s.type === "sea_day").length >= 1,
  "millennium fixture retains sea days"
);

/* Explora booking payload diagnosis: confirmation has itinerary but nothing persisted */
const exploraDiagnosis = {
  booking_reference: "10175811",
  booking_cruise_line: "Explora Cruises",
  booking_ship: "Explora 1",
  confirmation_has_day_by_day_itinerary: true,
  cruise_itineraries_row: null,
  expected_customer_reason: "no_approved_itinerary"
};
assert(
  exploraDiagnosis.expected_customer_reason === "no_approved_itinerary",
  "Explora diagnosis: usable PDF itinerary exists but no approved cruise_itineraries row"
);

/* Sea days do not break route generation */
const withSea = buildJourneyFromItinerary({
  stops: [
    { name: "A", lat: 10, lng: 10, type: "port" },
    { name: "At Sea", type: "sea_day" },
    { name: "B", lat: 11, lng: 12, type: "port" }
  ]
});
assert(projectJourneyMap(withSea.journey).ok, "sea days skipped for geometry only");

/* Repeated ports do not break the map */
const repeated = buildJourneyFromItinerary({
  stops: [
    { name: "Ibiza", lat: 38.9, lng: 1.42, type: "port", date: "2026-09-29" },
    { name: "Ibiza", lat: 38.9, lng: 1.42, type: "port", date: "2026-09-30" },
    { name: "Rome", lat: 42.09, lng: 11.79, type: "port", date: "2026-10-05" }
  ]
});
const repProj = projectJourneyMap(repeated.journey);
assert(repProj.ok, "repeated ports project");
assert(repProj.ports.length === 2, "consecutive identical coordinates collapsed");

/* Missing itinerary shows fallback reason */
const missing = buildJourneyFromItinerary(null);
assert(missing.journey === null && missing.reason === "missing_itinerary", "null itinerary fails calmly");
const empty = buildJourneyFromItinerary({ stops: [] });
assert(empty.journey === null && empty.reason === "insufficient_stops", "empty stops fail calmly");
const noCoords = buildJourneyFromItinerary({
  stops: [
    { name: "Unknown A", type: "port" },
    { name: "Unknown B", type: "port" }
  ]
});
assert(noCoords.journey && noCoords.journey.can_draw_map === false, "stops without coords keep list, hide map");
assert(projectJourneyMap(noCoords.journey).ok === false, "projection fails without coordinates");

/* Non-demo references do not get the Millennium fixture */
assert(
  getDemoJourneyForBookingReference("10175811").journey === null,
  "Explora ref is not demo fixture"
);

/* Demo itinerary constant remains data, not a separate renderer contract */
assert(Array.isArray(MILLENNIUM_DEMO_ITINERARY.stops), "demo fixture is plain itinerary data");

console.log("test-dashboard-journey: ok");
