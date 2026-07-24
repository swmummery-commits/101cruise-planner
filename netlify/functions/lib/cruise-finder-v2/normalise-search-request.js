/**
 * Map Finder questionnaire POST body → Engine V2 NormalisedSearchRequest.
 * Does not change questionnaire fields — only adapts what already exists.
 */

const DURATION_RANGES = Object.freeze({
  "3-5": { minimumNights: 3, maximumNights: 5, flexible: false },
  "6-8": { minimumNights: 6, maximumNights: 8, flexible: false },
  "9-12": { minimumNights: 9, maximumNights: 12, flexible: false },
  "13-16": { minimumNights: 13, maximumNights: 16, flexible: false },
  "17-plus": { minimumNights: 17, maximumNights: null, flexible: false },
  flexible: { minimumNights: null, maximumNights: null, flexible: true }
});

function cleanText(value, max = 120) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function asStringArray(value, maxItems = 24) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => cleanText(v, 80))
    .filter(Boolean)
    .slice(0, maxItems);
}

/**
 * @param {object} body Finder POST body from destination.js runSearch
 * @returns {{ ok: true, request: object } | { ok: false, error: { code: string, message: string } }}
 */
function normaliseSearchRequest(body) {
  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: { code: "invalid_body", message: "Search request body is required." }
    };
  }

  const destinationId = cleanText(body.destination, 80).toLowerCase();
  if (!destinationId || !/^[a-z0-9-]{2,80}$/.test(destinationId)) {
    return {
      ok: false,
      error: { code: "invalid_destination", message: "A valid destination slug is required." }
    };
  }

  const destinationName = cleanText(body.destinationName || destinationId, 80);
  const timingMode = cleanText(body.timingMode, 40);
  const month = body.month != null && body.month !== "" ? Number(body.month) : null;
  const year = body.year != null && body.year !== "" ? Number(body.year) : null;
  const startDate = cleanText(body.startDate, 40) || null;
  const endDate = cleanText(body.endDate, 40) || null;
  const durationId = cleanText(body.durationId, 20) || null;
  const departure = cleanText(body.departure, 40).toLowerCase() || null;
  const styles = asStringArray(body.styles, 12);
  const cruiseLines = asStringArray(body.cruiseLines, 24);
  const budgetId = cleanText(body.budgetId, 40) || null;

  if (month != null && (!Number.isFinite(month) || month < 1 || month > 12)) {
    return { ok: false, error: { code: "invalid_month", message: "Month must be between 1 and 12." } };
  }
  if (year != null && (!Number.isFinite(year) || year < 2024 || year > 2035)) {
    return { ok: false, error: { code: "invalid_year", message: "Year is out of supported range." } };
  }

  const durationMeta = DURATION_RANGES[durationId] || {
    minimumNights: null,
    maximumNights: null,
    flexible: !durationId
  };

  const flexibleTiming =
    !timingMode ||
    timingMode === "flexible" ||
    timingMode === "this_season" ||
    timingMode === "school_holidays";

  /** @type {import("./contracts").NormalisedSearchRequest} */
  const request = {
    destinationIds: [destinationId],
    destinationNames: [destinationName],
    travelWindow: {
      startDate,
      endDate,
      month: Number.isFinite(month) ? month : null,
      year: Number.isFinite(year) ? year : null,
      flexible: flexibleTiming,
      timingMode
    },
    duration: {
      minimumNights: durationMeta.minimumNights,
      maximumNights: durationMeta.maximumNights,
      flexible: Boolean(durationMeta.flexible),
      durationId
    },
    departurePreferences: departure && departure !== "anywhere" ? [departure] : [],
    // Questionnaire does not currently collect adult/child counts for live search.
    travellers: { adults: 2, children: 0 },
    holidayStyles: styles,
    budget: {
      amount: null,
      currency: "AUD",
      unspecified: !budgetId || budgetId === "flexible" || budgetId === "unspecified",
      budgetId
    },
    preferredCruiseLines: cruiseLines,
    forceRefresh: Boolean(body.forceRefresh),
    rawQuestionnairePayload: { ...body }
  };

  return { ok: true, request };
}

module.exports = {
  normaliseSearchRequest,
  DURATION_RANGES
};
