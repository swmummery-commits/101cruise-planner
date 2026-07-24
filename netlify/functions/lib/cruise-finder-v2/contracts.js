/**
 * Sprint 14A — Cruise Finder Engine V2 contracts (provider-independent).
 * HOLD DEPLOY. No prices. No production UI wiring.
 */

/** @typedef {"HIGH"|"MEDIUM"|"LOW"} Confidence */

/**
 * @typedef {object} NormalisedTravelWindow
 * @property {string|null} startDate YYYY-MM-DD
 * @property {string|null} endDate YYYY-MM-DD
 * @property {number|null} month 1–12
 * @property {number|null} year
 * @property {boolean} flexible
 * @property {string} timingMode exact|month|school_holidays|this_season|flexible|""
 */

/**
 * @typedef {object} NormalisedDuration
 * @property {number|null} minimumNights
 * @property {number|null} maximumNights
 * @property {boolean} flexible
 * @property {string|null} durationId original Finder duration token
 */

/**
 * @typedef {object} NormalisedSearchRequest
 * @property {string[]} destinationIds
 * @property {string[]} destinationNames
 * @property {NormalisedTravelWindow} travelWindow
 * @property {NormalisedDuration} duration
 * @property {string[]} departurePreferences
 * @property {{ adults: number, children: number }} travellers
 * @property {string[]} holidayStyles
 * @property {{ amount: number|null, currency: string, unspecified: boolean, budgetId: string|null }} budget
 * @property {string[]} preferredCruiseLines soft preference from approved lines
 * @property {boolean} forceRefresh
 * @property {object} rawQuestionnairePayload original Finder POST body (audit trail)
 */

/**
 * @typedef {object} ItineraryStop
 * @property {number|null} dayNumber
 * @property {string|null} date
 * @property {"port"|"sea"|"embarkation"|"disembarkation"} type
 * @property {string|null} portName
 */

/**
 * @typedef {object} CandidateCruise
 * @property {string} provider
 * @property {string} providerCruiseId
 * @property {string} sourceUrl
 * @property {string} cruiseLineName
 * @property {string} shipName
 * @property {string} departureDate
 * @property {string} returnDate
 * @property {number|null} nights
 * @property {string} departurePortName
 * @property {string} arrivalPortName
 * @property {ItineraryStop[]} itinerary
 * @property {string} title
 * @property {Confidence} confidence
 * @property {string} discoveredAt ISO timestamp
 * @property {any} rawSourceReference
 */

const CONFIDENCE_LEVELS = Object.freeze(["HIGH", "MEDIUM", "LOW"]);
const ITINERARY_TYPES = Object.freeze(["port", "sea", "embarkation", "disembarkation"]);

module.exports = {
  CONFIDENCE_LEVELS,
  ITINERARY_TYPES
};
