/**
 * Conservative completeness checks for day-by-day text itineraries.
 * Rejects embarkation/disembarkation-only extractions for multi-night cruises.
 */

"use strict";

function parseIsoDate(value) {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayDiff(a, b) {
  const da = parseIsoDate(a);
  const db = parseIsoDate(b);
  if (!da || !db) return null;
  return Math.round((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

function parseNightsValue(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  const match = String(value).match(/(\d+)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve cruise nights from booking fields or embark/disembark dates.
 * @param {object} booking
 * @returns {number|null}
 */
function resolveCruiseNights(booking = {}) {
  const direct =
    parseNightsValue(booking.cruise_duration) ??
    parseNightsValue(booking.nights) ??
    parseNightsValue(booking.duration_nights) ??
    parseNightsValue(booking.number_of_nights);
  if (direct != null) return direct;

  const span = dayDiff(booking.departing_date, booking.arriving_date);
  return span != null && span > 0 ? span : null;
}

function isIntermediateStop(stop) {
  if (!stop || typeof stop !== "object") return false;
  if (stop.is_sea_day) return true;
  if (stop.is_embarkation || stop.is_disembarkation) return false;
  const entryType = String(stop.entry_type || "").toLowerCase();
  if (entryType === "embarkation" || entryType === "disembarkation") return false;
  if (entryType === "sea_day" || entryType === "port" || entryType === "scenic_cruising") {
    return true;
  }
  const name = String(stop.port_name || stop.name || "").trim();
  if (!name) return false;
  if (/^at\s+sea$/i.test(name)) return true;
  return true;
}

function uniqueSortedDates(stops) {
  const dates = (Array.isArray(stops) ? stops : [])
    .map((stop) => String(stop?.date || "").trim())
    .filter(Boolean)
    .sort();
  return [...new Set(dates)];
}

/**
 * Calm internal error — never surface technical details to customers.
 */
const INCOMPLETE_EXTRACTION_ERROR =
  "Itinerary extraction did not return complete day-by-day coverage for this cruise.";

/**
 * Conservative completeness rule for a ready text itinerary.
 *
 * Requires:
 * - meaningful day-by-day coverage (not embark + disembark only)
 * - intermediate port or At sea rows for multi-night cruises
 * - stop count / dated span consistent with cruise duration when known
 *
 * @param {object[]} stops
 * @param {object} [booking]
 * @returns {{ complete: boolean, reason: string|null }}
 */
function assessTextItineraryCompleteness(stops, booking = {}) {
  const list = Array.isArray(stops) ? stops : [];
  if (!list.length) {
    return { complete: false, reason: "empty_itinerary" };
  }

  const nights = resolveCruiseNights(booking);
  const intermediateCount = list.filter(isIntermediateStop).length;
  const dates = uniqueSortedDates(list);
  const dateSpan = dates.length >= 2 ? dayDiff(dates[0], dates[dates.length - 1]) : null;

  // Always require more than embarkation + disembarkation.
  if (list.length < 3) {
    return { complete: false, reason: "incomplete_day_by_day_coverage" };
  }

  if (intermediateCount < 1) {
    return { complete: false, reason: "missing_intermediate_days" };
  }

  if (nights != null && nights >= 2) {
    // For a six-night cruise, two rows must fail; require at least `nights` dated/ordered rows.
    if (list.length < nights) {
      return { complete: false, reason: "incomplete_for_cruise_duration" };
    }

    if (dateSpan != null && dateSpan < Math.max(1, nights - 1)) {
      return { complete: false, reason: "insufficient_date_coverage" };
    }
  }

  // Source-order coverage: days should be sequential / non-decreasing when present.
  let previousDay = null;
  for (const stop of list) {
    const day = stop?.day == null || stop.day === "" ? null : Number(stop.day);
    if (day == null || !Number.isFinite(day)) continue;
    if (previousDay != null && day < previousDay) {
      return { complete: false, reason: "source_order_invalid" };
    }
    previousDay = day;
  }

  return { complete: true, reason: null };
}

function isCompleteTextItinerary(stops, booking = {}) {
  return assessTextItineraryCompleteness(stops, booking).complete;
}

module.exports = {
  resolveCruiseNights,
  assessTextItineraryCompleteness,
  isCompleteTextItinerary,
  isIntermediateStop,
  INCOMPLETE_EXTRACTION_ERROR
};
