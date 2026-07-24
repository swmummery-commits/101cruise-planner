/**
 * Sprint 16B — Cruise DNA category model (provider-independent).
 * Scores are 0–100. No AI / LLM / randomness.
 */

/** @typedef {keyof typeof DNA_CATEGORY_META} DnaCategoryId */

const DNA_CATEGORY_META = Object.freeze({
  adventure: {
    id: "adventure",
    label: "Adventure",
    description:
      "Active exploration, rugged environments, outdoor activities, and itineraries that emphasise discovery over resort-style downtime."
  },
  relaxation: {
    id: "relaxation",
    label: "Relaxation",
    description:
      "Sea days, spa culture, warm-weather leisure, private islands, and lower-intensity port schedules suited to unwinding."
  },
  luxury: {
    id: "luxury",
    label: "Luxury",
    description:
      "Premium and ultra-premium lines, smaller ships, suite-heavy product, exclusive areas, and refined onboard service cues."
  },
  wildlife: {
    id: "wildlife",
    label: "Wildlife",
    description:
      "Regions and stops associated with wildlife viewing (Alaska, Antarctica, Galápagos, etc.) plus scenic nature corridors."
  },
  culture_history: {
    id: "culture_history",
    label: "Culture & History",
    description:
      "Ports and regions rich in heritage, museums, archaeology, and urban cultural exploration (Med, Europe, Asia gateways)."
  },
  food_wine: {
    id: "food_wine",
    label: "Food & Wine",
    description:
      "Culinary destinations and ships with strong specialty dining / restaurant density signals."
  },
  nightlife: {
    id: "nightlife",
    label: "Nightlife",
    description:
      "Onboard entertainment energy — bars, casino, theater — and destinations known for evening culture."
  },
  family: {
    id: "family",
    label: "Family",
    description:
      "Kids clubs, warm family destinations, shorter or mid-length voyages, and mainstream family-oriented lines/ships."
  },
  romance: {
    id: "romance",
    label: "Romance",
    description:
      "Scenic evenings, spa, suite cues, adults-leaning product, and intimate or premium atmospheres."
  },
  scenic_cruising: {
    id: "scenic_cruising",
    label: "Scenic Cruising",
    description:
      "Glacier, fjord, canal, and scenic-passage days where the voyage itself is the attraction."
  },
  expedition: {
    id: "expedition",
    label: "Expedition",
    description:
      "Remote / polar / expedition-branded product with exploration-forward itineraries and smaller vessels."
  },
  value_for_money: {
    id: "value_for_money",
    label: "Value for Money",
    description:
      "Mainstream lines, larger ships, shorter-to-mid voyages, and mass-market product positioning (not a fare quote)."
  },
  accessibility: {
    id: "accessibility",
    label: "Accessibility",
    description:
      "Proxy for easier travel: round-trip homeports, fewer tender-style stops, mainstream ships, and moderate durations. Not a certified access audit."
  },
  first_time_friendly: {
    id: "first_time_friendly",
    label: "First-Time Cruiser Friendly",
    description:
      "Approachable durations, familiar destinations, mainstream lines, and balanced sea/port mix for first voyages."
  },
  experienced_appeal: {
    id: "experienced_appeal",
    label: "Experienced Cruiser Appeal",
    description:
      "Longer voyages, uncommon regions, expedition/luxury niches, world-cruise segments, and itinerary complexity."
  }
});

const DNA_CATEGORY_IDS = Object.freeze(Object.keys(DNA_CATEGORY_META));

/** Questionnaire style ID → DNA category point contributions (customer profile). */
const STYLE_TO_DNA = Object.freeze({
  beaches: { relaxation: 70, family: 40, romance: 35, value_for_money: 30 },
  relaxation: { relaxation: 95, romance: 40, accessibility: 35, first_time_friendly: 40 },
  adventure: { adventure: 95, expedition: 45, wildlife: 35, experienced_appeal: 30 },
  wildlife: { wildlife: 95, scenic_cruising: 50, expedition: 40, adventure: 35 },
  culture: { culture_history: 95, food_wine: 40, experienced_appeal: 25 },
  luxury: { luxury: 95, romance: 50, food_wine: 35, experienced_appeal: 30 },
  expedition: { expedition: 95, adventure: 60, wildlife: 50, experienced_appeal: 55 },
  food_wine: { food_wine: 95, culture_history: 40, luxury: 25 },
  scenic_cruising: { scenic_cruising: 95, wildlife: 40, romance: 35, relaxation: 30 },
  river_cruising: { culture_history: 70, food_wine: 45, relaxation: 40, accessibility: 30 },
  warm_weather: { relaxation: 60, family: 35, first_time_friendly: 30, romance: 20 },
  cold_weather: { scenic_cruising: 55, wildlife: 45, adventure: 40, expedition: 35 },
  bucket_list: { experienced_appeal: 70, adventure: 45, scenic_cruising: 40, expedition: 35 }
});

function emptyDnaScores() {
  /** @type {Record<string, number>} */
  const scores = {};
  for (const id of DNA_CATEGORY_IDS) scores[id] = 0;
  return scores;
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

module.exports = {
  DNA_CATEGORY_META,
  DNA_CATEGORY_IDS,
  STYLE_TO_DNA,
  emptyDnaScores,
  clampScore
};
