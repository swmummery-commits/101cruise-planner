/**
 * Normalise / validate Engine V2 candidate cruises (no prices).
 */

const { CONFIDENCE_LEVELS, ITINERARY_TYPES } = require("./contracts");

function cleanText(value, max = 240) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

/**
 * @param {object} stop
 * @returns {import("./contracts").ItineraryStop|null}
 */
function normaliseItineraryStop(stop) {
  if (!stop || typeof stop !== "object") return null;
  const type = String(stop.type || "port").toLowerCase();
  if (!ITINERARY_TYPES.includes(type)) return null;
  const dayNumber =
    stop.dayNumber == null || stop.dayNumber === ""
      ? null
      : Number(stop.dayNumber);
  const date = cleanText(stop.date, 40) || null;
  if (date && !isIsoDate(date)) return null;
  return {
    dayNumber: Number.isFinite(dayNumber) ? dayNumber : null,
    date,
    type,
    portName: type === "sea" ? null : cleanText(stop.portName, 120) || null
  };
}

/**
 * @param {object} raw
 * @returns {{ ok: true, cruise: import("./contracts").CandidateCruise } | { ok: false, errors: Array<{code:string,message:string}> }}
 */
function normaliseCruiseResult(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: [{ code: "missing_candidate", message: "Candidate cruise is required." }] };
  }

  const provider = cleanText(raw.provider, 40);
  const providerCruiseId = cleanText(raw.providerCruiseId, 120);
  const sourceUrl = cleanText(raw.sourceUrl, 500);
  const cruiseLineName = cleanText(raw.cruiseLineName, 120);
  const shipName = cleanText(raw.shipName, 120);
  const departureDate = cleanText(raw.departureDate, 40);
  const returnDate = cleanText(raw.returnDate, 40) || "";
  const departurePortName = cleanText(raw.departurePortName, 120);
  const arrivalPortName = cleanText(raw.arrivalPortName, 120);
  const title = cleanText(raw.title, 200);
  let confidence = cleanText(raw.confidence || "MEDIUM", 12).toUpperCase();
  if (!CONFIDENCE_LEVELS.includes(confidence)) confidence = "MEDIUM";

  if (!provider) errors.push({ code: "missing_provider", message: "provider is required." });
  if (!providerCruiseId) {
    errors.push({ code: "missing_provider_cruise_id", message: "providerCruiseId is required." });
  }
  if (!sourceUrl) errors.push({ code: "missing_source_url", message: "sourceUrl is required." });
  if (!cruiseLineName) {
    errors.push({ code: "missing_cruise_line", message: "cruiseLineName is required." });
  }
  if (!shipName) errors.push({ code: "missing_ship", message: "shipName is required." });
  if (!departureDate || !isIsoDate(departureDate)) {
    errors.push({ code: "invalid_departure_date", message: "departureDate must be YYYY-MM-DD." });
  }
  if (returnDate && !isIsoDate(returnDate)) {
    errors.push({ code: "invalid_return_date", message: "returnDate must be YYYY-MM-DD when present." });
  }
  if (!departurePortName) {
    errors.push({ code: "missing_departure_port", message: "departurePortName is required." });
  }

  const nights =
    raw.nights == null || raw.nights === ""
      ? null
      : Number(raw.nights);
  if (nights != null && (!Number.isFinite(nights) || nights < 1 || nights > 200)) {
    errors.push({ code: "invalid_nights", message: "nights must be a positive number." });
  }

  // Explicitly reject price-shaped fields if a provider leaks them.
  if (
    raw.price != null ||
    raw.fare != null ||
    raw.brochureFare != null ||
    raw.brochure_fare != null ||
    raw.amount != null
  ) {
    errors.push({ code: "prices_forbidden", message: "Engine V2 candidates must not include prices." });
  }

  const itineraryRaw = Array.isArray(raw.itinerary) ? raw.itinerary : [];
  const itinerary = [];
  for (const stop of itineraryRaw) {
    const normalised = normaliseItineraryStop(stop);
    if (!normalised) {
      errors.push({ code: "invalid_itinerary_stop", message: "Malformed itinerary stop." });
      continue;
    }
    itinerary.push(normalised);
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    cruise: {
      provider,
      providerCruiseId,
      sourceUrl,
      cruiseLineName,
      shipName,
      departureDate,
      returnDate,
      nights: Number.isFinite(nights) ? nights : null,
      departurePortName,
      arrivalPortName: arrivalPortName || "",
      itinerary,
      title: title || `${cruiseLineName} ${shipName} ${departureDate}`,
      confidence,
      discoveredAt: cleanText(raw.discoveredAt, 40) || new Date().toISOString(),
      rawSourceReference: raw.rawSourceReference == null ? null : raw.rawSourceReference
    }
  };
}

/**
 * Validate an already-normalised candidate.
 * @param {object} cruise
 */
function validateCandidateCruise(cruise) {
  return normaliseCruiseResult(cruise);
}

module.exports = {
  normaliseCruiseResult,
  normaliseItineraryStop,
  validateCandidateCruise,
  isIsoDate
};
