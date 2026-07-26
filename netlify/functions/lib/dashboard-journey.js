/**
 * Generic dashboard journey builders for Client Portal.
 * Pure helpers — no network. Coordinates must be supplied by the caller.
 */

"use strict";

const {
  projectJourneyMap,
  shortPortLabel,
  buildSmoothPath
} = require("./dashboard-journey-map");

function isSeaDay(stop) {
  const type = String(stop?.type || stop?.entry_type || "").toLowerCase();
  const name = String(stop?.name || "").toLowerCase();
  return type === "sea_day" || name === "at sea" || name.includes("at sea");
}

function hasCoordinates(stop) {
  const lat = Number(stop?.lat ?? stop?.latitude);
  const lng = Number(stop?.lng ?? stop?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

/**
 * Normalise itinerary_data / prototype stops into a dashboard journey.
 */
function buildJourneyFromItinerary(itinerary, options = {}) {
  if (!itinerary || typeof itinerary !== "object") {
    return { journey: null, reason: "missing_itinerary" };
  }

  const rawStops = Array.isArray(itinerary.stops) ? itinerary.stops : [];
  if (!rawStops.length) {
    return { journey: null, reason: "insufficient_stops" };
  }

  const stops = rawStops.map((stop, index) => {
    const type = String(stop.entry_type || stop.type || "port").toLowerCase();
    const lat = Number(stop.lat ?? stop.latitude);
    const lng = Number(stop.lng ?? stop.longitude);
    return {
      date: stop.date || null,
      name: String(stop.name || `Stop ${index + 1}`).trim(),
      type: isSeaDay(stop) ? "sea_day" : type || "port",
      arrival: stop.arrival || stop.arrival_time || "",
      departure: stop.departure || stop.departure_time || "",
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null
    };
  });

  const titled =
    String(itinerary.title || itinerary.voyage_name || "").trim() ||
    buildTitleFromStops(stops);

  const mappedStops = stops.filter((s) => !isSeaDay(s) && hasCoordinates(s));
  const canDrawMap = mappedStops.length >= 2;

  return {
    journey: {
      title: titled,
      stops,
      can_draw_map: canDrawMap,
      source: options.source || "itinerary",
      diagnostic_reason: canDrawMap ? "ok" : "insufficient_coordinates"
    },
    reason: canDrawMap ? "ok" : "insufficient_coordinates"
  };
}

function buildTitleFromStops(stops) {
  const named = (stops || []).filter((s) => s && !isSeaDay(s) && s.name);
  if (named.length === 0) return "Your journey";
  if (named.length === 1) return named[0].name;
  return `${named[0].name} to ${named[named.length - 1].name}`;
}

/** Demo / regression fixture — Celebrity Millennium Tokyo–Seoul (SWM123456). */
const MILLENNIUM_DEMO_ITINERARY = Object.freeze({
  title: "Tokyo to Seoul",
  voyage_name: "Tokyo to Seoul",
  source: "demo_fixture_swm123456",
  stops: [
    { date: "2026-09-11", name: "Tokyo (Yokohama)", type: "embarkation", arrival: "", departure: "5:00 pm", lat: 35.4437, lng: 139.638 },
    { date: "2026-09-12", name: "Mt Fuji (Shimizu)", type: "port", arrival: "7:00 am", departure: "6:00 pm", lat: 35.0159, lng: 138.4897 },
    { date: "2026-09-13", name: "Kyoto (Osaka)", type: "port", arrival: "11:00 am", departure: "", lat: 34.6573, lng: 135.4323 },
    { date: "2026-09-14", name: "Kyoto (Osaka)", type: "port", arrival: "", departure: "6:00 pm", lat: 34.6573, lng: 135.4323 },
    { date: "2026-09-15", name: "Kochi", type: "port", arrival: "8:00 am", departure: "5:00 pm", lat: 33.5008, lng: 133.5589 },
    { date: "2026-09-16", name: "Hiroshima", type: "port", arrival: "9:00 am", departure: "6:00 pm", lat: 34.3523, lng: 132.4553 },
    { date: "2026-09-17", name: "At Sea", type: "sea_day", arrival: "", departure: "" },
    { date: "2026-09-18", name: "Kagoshima", type: "port", arrival: "8:00 am", departure: "5:00 pm", lat: 31.5894, lng: 130.5611 },
    { date: "2026-09-19", name: "Nagasaki", type: "port", arrival: "8:00 am", departure: "5:00 pm", lat: 32.7503, lng: 129.8779 },
    { date: "2026-09-20", name: "Fukuoka", type: "port", arrival: "8:00 am", departure: "5:00 pm", lat: 33.5904, lng: 130.4017 },
    { date: "2026-09-21", name: "Busan", type: "port", arrival: "7:00 am", departure: "6:00 pm", lat: 35.1028, lng: 129.0403 },
    { date: "2026-09-22", name: "At Sea", type: "sea_day", arrival: "", departure: "" },
    { date: "2026-09-23", name: "Seoul (Incheon)", type: "disembarkation", arrival: "5:00 am", departure: "", lat: 37.4563, lng: 126.7052 }
  ]
});

function getDemoJourneyForBookingReference(reference) {
  const ref = String(reference || "").trim().toUpperCase();
  if (ref !== "SWM123456") return { journey: null, reason: "not_demo_reference" };
  return buildJourneyFromItinerary(MILLENNIUM_DEMO_ITINERARY, {
    source: "demo_fixture_swm123456"
  });
}

module.exports = {
  isSeaDay,
  hasCoordinates,
  buildJourneyFromItinerary,
  buildTitleFromStops,
  projectJourneyMap,
  shortPortLabel,
  buildSmoothPath,
  MILLENNIUM_DEMO_ITINERARY,
  getDemoJourneyForBookingReference
};
