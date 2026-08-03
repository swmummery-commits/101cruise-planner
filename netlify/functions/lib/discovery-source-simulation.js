/**
 * Shared read-only normalisation simulation for line source probes.
 */

const { resolveShipForLine } = require("./discovery-ship-resolver");
const { resolveOperationalDestination } = require("./discovery-destination-resolver");
const { resolveRawPortText } = require("./discovery-departure-port");
const { evaluateDiscoveryConfidence } = require("./discovery-confidence");
const { provesIndividualSailing } = require("./discovery-non-sailing-filter");
function validateCandidateForSimulation(candidate) {
  const reasons = [];
  if (!candidate.ship_id) reasons.push("Ship not matched to Ships database");
  if (!candidate.destination_id) reasons.push("Destination not matched");
  if (!candidate.departure_date) reasons.push("Departure date missing or invalid");
  if (!candidate.official_url) reasons.push("Official URL missing");
  else {
    try {
      // eslint-disable-next-line no-new
      new URL(candidate.official_url);
    } catch {
      reasons.push("Official URL invalid");
    }
  }
  return { valid: reasons.length === 0, reasons };
}

function simulateProbeProducts({
  products,
  cruiseLine,
  ships = [],
  destinations = [],
  today = new Date().toISOString().slice(0, 10)
} = {}) {
  const stats = {
    total: products.length,
    ship_resolved: 0,
    port_resolved: 0,
    destination_resolved: 0,
    complete_high_confidence: 0,
    incomplete: 0,
    duplicate_keys: 0,
    projected_active: 0,
    projected_steve_reviews: 0,
    skip_reasons: {},
    writes_blocked: true
  };
  const seen = new Set();
  const rows = [];

  for (const product of products || []) {
    const skipReasons = [];
    if (product.product_type && product.product_type !== "cruise") {
      skipReasons.push(`product_type:${product.product_type}`);
    }
    const identity = product.official_product_key || product.group_id;
    if (identity && seen.has(identity)) {
      stats.duplicate_keys += 1;
      skipReasons.push("duplicate_identity");
    }
    if (identity) seen.add(identity);

    const shipResolution = resolveShipForLine({
      rawShipName: product.ship_name,
      cruiseLineId: cruiseLine?.id,
      cruiseLineName: cruiseLine?.name,
      ships
    });
    if (shipResolution.resolved) stats.ship_resolved += 1;
    else skipReasons.push("ship_unresolved");

    const portResolution = resolveRawPortText(product.departure_port, { cruiseLineId: cruiseLine?.id });
    const departurePort = portResolution.resolved ? portResolution.port : product.departure_port;
    if (portResolution.resolved || product.departure_port) stats.port_resolved += 1;
    else skipReasons.push("departure_port_unresolved");

    const destResolution = resolveOperationalDestination({
      destinationNames: [product.destination_name, product.destination_code].filter(Boolean),
      itineraryText: product.itinerary_name || "",
      departurePort,
      destinations
    });
    if (destResolution.status === "resolved") stats.destination_resolved += 1;
    else if (destResolution.status === "ambiguous") skipReasons.push("destination_ambiguous");
    else skipReasons.push("destination_unresolved");

    const candidate = {
      cruise_line_id: cruiseLine?.id,
      ship_id: shipResolution.ship_id || null,
      ship_name: shipResolution.name || product.ship_name,
      departure_date: product.departure_date,
      return_date: product.return_date,
      nights: product.nights,
      departure_port: departurePort,
      destination_id: destResolution.destination_id || null,
      official_url: product.official_url,
      status: "active",
      match_confidence: "high"
    };

    const nonSailing = !provesIndividualSailing({
      officialUrl: product.official_url,
      departureDate: product.departure_date,
      shipName: product.ship_name
    });
    if (nonSailing) skipReasons.push("non_sailing_page");

    const confidence = evaluateDiscoveryConfidence({
      shipResolution,
      destinationResolution: destResolution,
      departurePortResolution: portResolution,
      hasDepartureDate: Boolean(product.departure_date),
      hasNights: Boolean(product.nights || product.return_date),
      hasOfficialUrl: Boolean(product.official_url)
    });

    const validation = validateCandidateForSimulation(candidate);
    const complete =
      skipReasons.length === 0 &&
      confidence.level === "high" &&
      validation.valid &&
      product.departure_date >= today;

    if (complete) {
      stats.complete_high_confidence += 1;
      stats.projected_active += 1;
    } else {
      stats.incomplete += 1;
      for (const r of skipReasons) stats.skip_reasons[r] = (stats.skip_reasons[r] || 0) + 1;
    }
    if (destResolution.status === "ambiguous") stats.projected_steve_reviews += 1;

    rows.push({
      official_product_key: identity,
      complete_high_confidence: complete,
      skip_reasons: skipReasons,
      confidence: confidence.level,
      destination: destResolution.destinationKey || null
    });
  }

  const total = Math.max(stats.total, 1);
  return {
    ...stats,
    ship_match_rate_pct: Math.round((stats.ship_resolved / total) * 1000) / 10,
    departure_port_rate_pct: Math.round((stats.port_resolved / total) * 1000) / 10,
    destination_resolution_rate_pct: Math.round((stats.destination_resolved / total) * 1000) / 10,
    complete_high_confidence_rate_pct: Math.round((stats.complete_high_confidence / total) * 1000) / 10,
    rows
  };
}

module.exports = {
  simulateProbeProducts
};
