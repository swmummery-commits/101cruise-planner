/**
 * Destination inference from itinerary ports and source text.
 */

const { normaliseName } = require("./cruise-finder-v2/enrichment/match-entities");
const { loadPortsCatalogue } = require("./discovery-departure-port");

const DESTINATION_RESOLVER_VERSION = "2026-08-02.auto1";

const PORT_TO_DESTINATION = {
  juneau: "alaska",
  ketchikan: "alaska",
  skagway: "alaska",
  sitka: "alaska",
  whittier: "alaska",
  seward: "alaska",
  anchorage: "alaska",
  vancouver: "alaska",
  barcelona: "mediterranean",
  rome: "mediterranean",
  civitavecchia: "mediterranean",
  venice: "mediterranean",
  athens: "mediterranean",
  piraeus: "mediterranean",
  santorini: "mediterranean",
  bergen: "norwegian-fjords",
  geiranger: "norwegian-fjords",
  ushuaia: "antarctica",
  "port stanley": "antarctica",
  "punta arenas": "antarctica"
};

function publishedDestinations(destinations) {
  return (destinations || []).filter((d) => d.status === "published" || !d.status);
}

function slugForDestination(destinations, slugNeedle) {
  const needle = normaliseName(slugNeedle).replace(/\s+/g, "-");
  return publishedDestinations(destinations).find((d) => normaliseName(d.slug) === needle) || null;
}

function matchDestinationByText(text, destinations) {
  const hay = normaliseName(text);
  if (!hay) return null;
  let best = null;
  for (const dest of publishedDestinations(destinations)) {
    const name = normaliseName(dest.name);
    const slug = normaliseName(dest.slug).replace(/-/g, " ");
    let score = 0;
    if (name && hay.includes(name)) score = 90;
    else if (slug && hay.includes(slug)) score = 80;
    else if (dest.primary_region && hay.includes(normaliseName(dest.primary_region))) score = 65;
    if (score > (best?.confidence || 0)) {
      best = { destination: dest, confidence: score, method: "text_match" };
    }
  }
  return best?.confidence >= 70 ? best : null;
}

function inferFromPorts(itineraryText, destinations) {
  const text = normaliseName(itineraryText);
  if (!text) return null;
  const counts = new Map();
  for (const [port, destSlug] of Object.entries(PORT_TO_DESTINATION)) {
    if (text.includes(normaliseName(port))) {
      counts.set(destSlug, (counts.get(destSlug) || 0) + 1);
    }
  }
  if (!counts.size) return null;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topSlug, topCount] = sorted[0];
  if (sorted.length > 1 && sorted[1][1] === topCount) return null;
  const dest = slugForDestination(destinations, topSlug);
  if (!dest) return null;
  return {
    destination: dest,
    confidence: Math.min(95, 70 + topCount * 8),
    method: "itinerary_ports",
    portEvidence: topSlug
  };
}

function resolveDestination({
  title,
  description,
  itinerary,
  destinationAliases = [],
  destinations = [],
  preferredDestination = null
}) {
  if (preferredDestination?.id) {
    return {
      resolved: true,
      destination_id: preferredDestination.id,
      destination_name: preferredDestination.name,
      confidence: 100,
      method: "preferred_scope",
      resolverVersion: DESTINATION_RESOLVER_VERSION
    };
  }

  const blob = [title, description, itinerary].filter(Boolean).join("\n");
  const viaPorts = inferFromPorts(blob, destinations);
  if (viaPorts) {
    return {
      resolved: true,
      destination_id: viaPorts.destination.id,
      destination_name: viaPorts.destination.name,
      confidence: viaPorts.confidence,
      method: viaPorts.method,
      resolverVersion: DESTINATION_RESOLVER_VERSION
    };
  }

  const viaText = matchDestinationByText(blob, destinations);
  if (viaText) {
    return {
      resolved: true,
      destination_id: viaText.destination.id,
      destination_name: viaText.destination.name,
      confidence: viaText.confidence,
      method: viaText.method,
      resolverVersion: DESTINATION_RESOLVER_VERSION
    };
  }

  for (const alias of destinationAliases || []) {
    const needle = normaliseName(alias.normalised_alias || alias.raw_alias);
    if (needle && normaliseName(blob).includes(needle)) {
      const dest = destinations.find((d) => d.id === alias.destination_id);
      if (dest) {
        return {
          resolved: true,
          destination_id: dest.id,
          destination_name: dest.name,
          confidence: 92,
          method: "destination_alias",
          resolverVersion: DESTINATION_RESOLVER_VERSION
        };
      }
    }
  }

  return { resolved: false, reason: "no_dominant_destination", resolverVersion: DESTINATION_RESOLVER_VERSION };
}

module.exports = {
  DESTINATION_RESOLVER_VERSION,
  resolveDestination,
  inferFromPorts,
  matchDestinationByText
};
