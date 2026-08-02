/**
 * Discovery confidence model — classifies source pages and sailing candidates.
 * Resolver version tracked for audit.
 */

const { classifyNonSailingSource, evaluateSailingEvidence } = require("./discovery-non-sailing-filter");
const { isExcludedCruiseLine } = require("./cruise-finder-departure-match");
const { validateDepartureForCandidate } = require("./discovery-departure-port");

const CONFIDENCE_RESOLVER_VERSION = "2026-08-02.auto1";

function tierFromScore(score) {
  if (score >= 8) return "high";
  if (score >= 5) return "medium";
  return "low";
}

function emptyEvidence() {
  return {
    cruiseLine: { matched: false, id: null, name: null },
    ship: { matched: false, id: null, name: null, method: null, confidence: null },
    departureDate: { value: null, method: null, confidence: null },
    departurePort: { value: null, canonical: null, method: null, confidence: null },
    duration: { nights: null, returnDate: null },
    itinerary: { text: null, destinationIds: [] },
    sourceType: { classification: null, url: null, title: null }
  };
}

/**
 * @returns {{ classification, confidence, evidence, outcome, reasons, score }}
 */
function evaluateDiscoveryConfidence(input = {}) {
  const reasons = [];
  const evidence = emptyEvidence();
  let score = 0;

  const cruiseLine = input.cruiseLine || {};
  const lineName = cruiseLine.name || input.cruise_line_name || "";
  if (isExcludedCruiseLine(lineName)) {
    return {
      classification: "non_sailing",
      confidence: "high",
      evidence,
      outcome: "auto_reject",
      reasons: ["excluded_cruise_line"],
      score: 0,
      resolverVersion: CONFIDENCE_RESOLVER_VERSION
    };
  }

  if (cruiseLine.id || lineName) {
    evidence.cruiseLine = { matched: true, id: cruiseLine.id || null, name: lineName };
    score += 1;
  } else {
    reasons.push("cruise_line_unconfirmed");
  }

  const url = input.url || input.source_url || input.official_url || "";
  const title = input.title || input.payload?.extract?.title || "";
  const description = input.description || input.payload?.extract?.description || "";
  const excerpt = input.excerpt || "";

  const nonSailing = classifyNonSailingSource({
    url,
    title,
    description,
    excerpt,
    ship_id: input.ship_id,
    ship_name_guesses: input.ship_name_guesses || input.payload?.diagnostics?.ship_name_guesses,
    departure_date: input.departure_date,
    ships: input.ships
  });

  evidence.sourceType = { classification: nonSailing.rejected ? "non_sailing" : "page", url, title };

  if (nonSailing.rejected) {
    return {
      classification: "non_sailing",
      confidence: "high",
      evidence,
      outcome: "auto_reject",
      reasons: [nonSailing.reason],
      score: 0,
      resolverVersion: CONFIDENCE_RESOLVER_VERSION
    };
  }

  const sailingEvidence = evaluateSailingEvidence({
    url,
    title,
    description,
    excerpt,
    ship_id: input.ship_id,
    ship_name_guess: input.ship_name_guess,
    ship_name_guesses: input.ship_name_guesses,
    departure_date: input.departure_date,
    departure_port: input.departure_port,
    nights: input.nights,
    itinerary: input.itinerary,
    knownShipNamesList: (input.ships || []).map((s) => s.name)
  });

  if (input.shipResolution?.ship) {
    evidence.ship = {
      matched: true,
      id: input.shipResolution.ship.id,
      name: input.shipResolution.ship.name,
      method: input.shipResolution.method,
      confidence: input.shipResolution.confidence
    };
    score += input.shipResolution.confidence >= 90 ? 3 : input.shipResolution.confidence >= 75 ? 2 : 1;
  } else if (input.ship_id) {
    evidence.ship = {
      matched: true,
      id: input.ship_id,
      name: input.ship_name || null,
      method: "existing",
      confidence: 100
    };
    score += 3;
  } else {
    reasons.push("ship_unresolved");
  }

  if (input.departure_date) {
    const future = new Date(String(input.departure_date).slice(0, 10)) >= new Date(new Date().toISOString().slice(0, 10));
    evidence.departureDate = {
      value: input.departure_date,
      method: input.departure_date_method || "extracted",
      confidence: future ? 90 : 20
    };
    if (future) score += 2;
    else reasons.push("departure_date_past_or_invalid");
  } else {
    reasons.push("departure_date_missing");
  }

  if (input.departure_port) {
    evidence.departurePort = {
      value: input.departure_port,
      canonical: input.departure_port_meta?.canonicalPortName || input.departure_port,
      method: input.departure_port_method || "extracted",
      confidence: input.departure_port_meta?.status === "resolved" ? 90 : 60
    };
    score += evidence.departurePort.confidence >= 80 ? 2 : 1;
  } else {
    reasons.push("departure_port_missing");
  }

  evidence.duration = { nights: input.nights || null, returnDate: input.return_date || null };
  if (input.nights) score += 1;

  evidence.itinerary = {
    text: input.itinerary || null,
    destinationIds: input.destination_ids || (input.destination_id ? [input.destination_id] : [])
  };
  if (input.destination_id) score += 1;
  else if (!input.destination_id && input.destinationResolution?.destination_id) {
    evidence.itinerary.destinationIds = [input.destinationResolution.destination_id];
    score += 1;
  } else {
    reasons.push("destination_missing");
  }

  if (!sailingEvidence.sufficient && !input.ship_id && !input.departure_date) {
    return {
      classification: "non_sailing",
      confidence: "high",
      evidence,
      outcome: "auto_reject",
      reasons: [...reasons, "insufficient_sailing_evidence"],
      score,
      resolverVersion: CONFIDENCE_RESOLVER_VERSION
    };
  }

  const candidate = {
    ship_id: evidence.ship.id,
    destination_id: evidence.itinerary.destinationIds[0] || input.destination_id,
    departure_date: input.departure_date,
    official_url: url,
    departure_port: evidence.departurePort.canonical || input.departure_port,
    departure_port_meta: input.departure_port_meta
  };
  const departureCheck = validateDepartureForCandidate(candidate);
  if (departureCheck.reasons.length) {
    reasons.push(...departureCheck.reasons);
  }

  const hasConflict = input.fieldConflicts?.length > 0;
  if (hasConflict) reasons.push("field_conflict");

  let classification = "uncertain";
  if (sailingEvidence.sufficient || (evidence.ship.matched && input.departure_date)) {
    classification = "sailing";
  }

  const confidence = tierFromScore(score);
  let outcome = "review";

  const canAutoPublish =
    classification === "sailing" &&
    confidence === "high" &&
    evidence.ship.matched &&
    evidence.ship.confidence >= 85 &&
    evidence.departureDate.value &&
    evidence.departurePort.canonical &&
    evidence.itinerary.destinationIds.length > 0 &&
    !hasConflict &&
    !reasons.some((r) => /missing|invalid|unmatched|unresolved/i.test(r));

  if (canAutoPublish) outcome = "auto_publish";
  else if (classification === "non_sailing" || (!sailingEvidence.sufficient && score <= 2)) {
    outcome = "auto_reject";
  } else if (confidence === "low" && !evidence.ship.matched && !input.departure_date) {
    outcome = "auto_reject";
  }

  return {
    classification,
    confidence,
    evidence,
    outcome,
    reasons: [...new Set(reasons)],
    score,
    resolverVersion: CONFIDENCE_RESOLVER_VERSION
  };
}

module.exports = {
  CONFIDENCE_RESOLVER_VERSION,
  evaluateDiscoveryConfidence,
  tierFromScore
};
