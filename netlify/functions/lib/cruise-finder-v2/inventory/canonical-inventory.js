/**
 * Sprint 15B — provider-independent canonical sailing inventory contract.
 * HOLD DEPLOY. No prices. Not wired to customer Finder.
 */

/** @typedef {"MATCHED"|"AMBIGUOUS"|"NOT_FOUND"|"ALIAS_MATCH"|"NOT_APPLICABLE"} MatchStatus */
/** @typedef {"embarkation"|"port"|"scenic_cruising"|"sea"|"disembarkation"} CanonicalStopType */

/**
 * @typedef {object} CanonicalEntityRef
 * @property {string|null} id
 * @property {string|null} canonicalName
 * @property {string} providerName
 * @property {MatchStatus} matchStatus
 */

/**
 * @typedef {object} CanonicalPortRef
 * @property {string|null} portId
 * @property {string|null} canonicalName
 */

/**
 * @typedef {object} CanonicalItineraryStop
 * @property {number|null} dayNumber
 * @property {string|null} date YYYY-MM-DD
 * @property {CanonicalStopType} type
 * @property {string|null} providerPortName
 * @property {string|null} portId
 * @property {string|null} canonicalPortName
 * @property {number|null} latitude
 * @property {number|null} longitude
 * @property {MatchStatus} matchStatus
 */

/**
 * @typedef {object} CanonicalMatchSummary
 * @property {boolean} cruiseLineMatched
 * @property {boolean} shipMatched
 * @property {number} matchedPorts
 * @property {number} aliasMatchedPorts
 * @property {number} ambiguousPorts
 * @property {number} unmatchedPorts
 * @property {number} totalMatchablePorts
 * @property {number} seaDays
 * @property {number} scenicCruisingStops
 * @property {number} ordinaryPortStops
 */

/**
 * @typedef {object} CanonicalSailing
 * @property {string} provider
 * @property {string} providerCruiseId
 * @property {string} providerItineraryId
 * @property {string} sourceUrl
 * @property {CanonicalEntityRef} cruiseLine
 * @property {CanonicalEntityRef} ship
 * @property {string} title
 * @property {string} departureDate
 * @property {string} returnDate
 * @property {number|null} nights
 * @property {CanonicalPortRef} departurePort
 * @property {CanonicalPortRef} arrivalPort
 * @property {string[]} destinations
 * @property {CanonicalItineraryStop[]} itinerary
 * @property {CanonicalMatchSummary} matchSummary
 * @property {boolean} routeObjectEligible
 * @property {string|null} routeObjectPreviewNote
 * @property {object|null} dateConsistency
 * @property {string} discoveredAt
 * @property {string} providerUpdatedAt
 * @property {string} sailingKey
 */

const MATCH_STATUSES = Object.freeze([
  "MATCHED",
  "AMBIGUOUS",
  "NOT_FOUND",
  "ALIAS_MATCH",
  "NOT_APPLICABLE"
]);

const CANONICAL_STOP_TYPES = Object.freeze([
  "embarkation",
  "port",
  "scenic_cruising",
  "sea",
  "disembarkation"
]);

/** Provider price / fare fields that must never enter canonical inventory. */
const FORBIDDEN_PRICE_FIELDS = Object.freeze([
  "price",
  "price_euro",
  "currency",
  "cabin_prices_per_person",
  "price_history",
  "priceHistory",
  "fare",
  "brochureFare",
  "brochure_fare",
  "amount",
  "cabin_prices",
  "lowest_price",
  "price_drop",
  "priceDrop"
]);

module.exports = {
  MATCH_STATUSES,
  CANONICAL_STOP_TYPES,
  FORBIDDEN_PRICE_FIELDS
};
