/**
 * Canonical port → operational destination hints.
 * A port alone does NOT determine destination; resolver uses itinerary context.
 */

const PORT_DESTINATION_HINTS = {
  // Alaska region
  juneau: { primary: "alaska", secondary: [] },
  ketchikan: { primary: "alaska", secondary: [] },
  skagway: { primary: "alaska", secondary: [] },
  sitka: { primary: "alaska", secondary: [] },
  whittier: { primary: "alaska", secondary: ["transpacific"] },
  seward: { primary: "alaska", secondary: ["transpacific"] },
  anchorage: { primary: "alaska", secondary: ["transpacific"] },
  homer: { primary: "alaska", secondary: [] },
  kodiak: { primary: "alaska", secondary: [] },
  hubbard: { primary: "alaska", secondary: [] },
  // Embark ports — context-dependent
  vancouver: {
    primary: null,
    secondary: ["alaska", "pacific-coast", "canada-new-england", "transpacific", "world-cruise"],
    note: "Use itinerary majority; Vancouver alone is not Alaska"
  },
  seattle: {
    primary: null,
    secondary: ["alaska", "pacific-coast", "transpacific", "hawaii"],
    note: "Seattle alone is not Alaska"
  },
  // Japan / Asia
  tokyo: { primary: null, secondary: ["japan", "asia", "transpacific", "world-cruise"] },
  yokohama: { primary: null, secondary: ["japan", "asia", "transpacific", "world-cruise"] },
  osaka: { primary: "japan", secondary: ["asia"] },
  kobe: { primary: "japan", secondary: ["asia"] },
  // Mediterranean
  barcelona: { primary: "mediterranean", secondary: ["transatlantic"] },
  rome: { primary: "mediterranean", secondary: [] },
  civitavecchia: { primary: "mediterranean", secondary: [] },
  venice: { primary: "mediterranean", secondary: [] },
  athens: { primary: "mediterranean", secondary: [] },
  piraeus: { primary: "mediterranean", secondary: [] },
  santorini: { primary: "mediterranean", secondary: [] },
  // Northern Europe
  bergen: { primary: "norwegian-fjords", secondary: ["northern-europe"] },
  geiranger: { primary: "norwegian-fjords", secondary: [] },
  southampton: {
    primary: null,
    secondary: ["british-isles", "northern-europe", "transatlantic", "world-cruise"]
  },
  // Transatlantic / repositioning
  "new york": { primary: null, secondary: ["transatlantic", "canada-new-england"] },
  "san diego": { primary: null, secondary: ["pacific-coast", "mexican-riviera", "transpacific", "panama-canal"] },
  "los angeles": { primary: null, secondary: ["pacific-coast", "mexican-riviera", "transpacific"] },
  "long beach": { primary: null, secondary: ["pacific-coast", "mexican-riviera"] },
  "san francisco": { primary: null, secondary: ["pacific-coast", "transpacific", "hawaii", "mexican-riviera"] },
  victoria: { primary: null, secondary: ["pacific-coast", "alaska", "canada-new-england"] },
  portland: { primary: null, secondary: ["pacific-coast"] },
  astoria: { primary: null, secondary: ["pacific-coast", "alaska"] },
  // Polar
  ushuaia: { primary: "antarctica", secondary: [] },
  "port stanley": { primary: "antarctica", secondary: [] },
  "punta arenas": { primary: "antarctica", secondary: [] },
  // Caribbean
  miami: { primary: "caribbean", secondary: [] },
  "fort lauderdale": { primary: "caribbean", secondary: [] },
  "san juan": { primary: "caribbean", secondary: [] },
  // Oceania
  sydney: { primary: "australia-new-zealand", secondary: ["transpacific", "south-pacific"] },
  auckland: { primary: "australia-new-zealand", secondary: ["transpacific"] },
  // Hawaii
  honolulu: { primary: "hawaii", secondary: ["transpacific"] }
};

function normalisePortToken(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function portHintsForText(text) {
  const hay = normalisePortToken(text);
  if (!hay) return [];
  const hits = [];
  for (const [port, hint] of Object.entries(PORT_DESTINATION_HINTS)) {
    if (hay.includes(port)) {
      hits.push({ port, ...hint });
    }
  }
  return hits;
}

function scoreDestinationsFromPortHints(hints) {
  const scores = new Map();
  for (const hint of hints) {
    if (hint.primary) {
      scores.set(hint.primary, (scores.get(hint.primary) || 0) + 3);
    }
    for (const sec of hint.secondary || []) {
      scores.set(sec, (scores.get(sec) || 0) + 1);
    }
  }
  return scores;
}

module.exports = {
  PORT_DESTINATION_HINTS,
  portHintsForText,
  scoreDestinationsFromPortHints,
  normalisePortToken
};
