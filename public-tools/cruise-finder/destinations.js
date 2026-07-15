/**
 * 101cruise Cruise Finder — local destination seed (Phase 7A).
 * Rule-based recommendations only. No paid APIs.
 */
(function (root) {
  "use strict";

  const DESTINATIONS = [
    {
      id: "alaska",
      name: "Alaska",
      short_description:
        "Glaciers, wildlife and dramatic wilderness on one of the world’s great scenic cruises.",
      best_months: [5, 6, 7, 8],
      acceptable_months: [4, 9],
      preferred_climate: "cool",
      typical_nights_min: 7,
      typical_nights_max: 14,
      suitable_travellers: ["couple", "family", "friends", "group", "solo"],
      suitable_styles: ["scenic", "adventure", "cool_climate", "family", "relaxing"],
      departure_markets: ["sydney", "melbourne", "brisbane", "auckland", "perth", "adelaide", "other"],
      recommendation_explanation:
        "Alaska shines in the Northern Hemisphere summer, when days are long and wildlife is active.",
      image_url: null,
      accent: "#3d5a6c",
      display_order: 1,
      active: true
    },
    {
      id: "japan",
      name: "Japan",
      short_description:
        "Temples, cities and coastal scenery with a uniquely rich culture at every port.",
      best_months: [3, 4, 5, 9, 10, 11],
      acceptable_months: [2, 6, 12],
      preferred_climate: "mild",
      typical_nights_min: 8,
      typical_nights_max: 14,
      suitable_travellers: ["couple", "solo", "friends", "group"],
      suitable_styles: ["culture", "food_wine", "scenic", "adventure", "luxury"],
      departure_markets: ["sydney", "melbourne", "brisbane", "auckland", "perth", "adelaide", "other"],
      recommendation_explanation:
        "Spring and autumn are ideal for comfortable weather and seasonal highlights.",
      image_url: null,
      accent: "#8b3a3a",
      display_order: 2,
      active: true
    },
    {
      id: "mediterranean",
      name: "Mediterranean",
      short_description:
        "Classic European cruising — coastal cities, history and relaxed seaside living.",
      best_months: [5, 6, 7, 8, 9],
      acceptable_months: [4, 10],
      preferred_climate: "warm",
      typical_nights_min: 7,
      typical_nights_max: 14,
      suitable_travellers: ["couple", "family", "friends", "group", "solo"],
      suitable_styles: ["culture", "food_wine", "warm_weather", "relaxing", "luxury", "family"],
      departure_markets: ["sydney", "melbourne", "brisbane", "auckland", "perth", "adelaide", "other"],
      recommendation_explanation:
        "Late spring through early autumn offers the most reliable Mediterranean weather.",
      image_url: null,
      accent: "#2f6f8f",
      display_order: 3,
      active: true
    },
    {
      id: "greek-islands",
      name: "Greek Islands",
      short_description:
        "Whitewashed villages, island hopping and clear Aegean waters.",
      best_months: [5, 6, 7, 8, 9],
      acceptable_months: [4, 10],
      preferred_climate: "warm",
      typical_nights_min: 7,
      typical_nights_max: 10,
      suitable_travellers: ["couple", "friends", "family", "group"],
      suitable_styles: ["warm_weather", "relaxing", "culture", "food_wine", "scenic"],
      departure_markets: ["sydney", "melbourne", "brisbane", "auckland", "perth", "adelaide", "other"],
      recommendation_explanation:
        "Summer is peak season for swimming, island cafés and long daylight evenings.",
      image_url: null,
      accent: "#1f6b8a",
      display_order: 4,
      active: true
    },
    {
      id: "norwegian-fjords",
      name: "Norwegian Fjords",
      short_description:
        "Steep fjords, waterfalls and Nordic coastal towns in extraordinary scenery.",
      best_months: [5, 6, 7, 8],
      acceptable_months: [4, 9],
      preferred_climate: "cool",
      typical_nights_min: 7,
      typical_nights_max: 14,
      suitable_travellers: ["couple", "solo", "friends", "group", "family"],
      suitable_styles: ["scenic", "cool_climate", "adventure", "relaxing", "luxury"],
      departure_markets: ["sydney", "melbourne", "brisbane", "auckland", "perth", "adelaide", "other"],
      recommendation_explanation:
        "May to August brings the best fjord visibility and the mildest coastal conditions.",
      image_url: null,
      accent: "#355e5a",
      display_order: 5,
      active: true
    },
    {
      id: "british-isles",
      name: "British Isles",
      short_description:
        "Ireland, Scotland and England’s coasts — heritage, countryside and maritime charm.",
      best_months: [5, 6, 7, 8, 9],
      acceptable_months: [4, 10],
      preferred_climate: "cool",
      typical_nights_min: 7,
      typical_nights_max: 14,
      suitable_travellers: ["couple", "solo", "friends", "group"],
      suitable_styles: ["culture", "scenic", "cool_climate", "food_wine", "relaxing"],
      departure_markets: ["sydney", "melbourne", "brisbane", "auckland", "perth", "adelaide", "other"],
      recommendation_explanation:
        "Late spring to early autumn is the most comfortable window for touring the isles.",
      image_url: null,
      accent: "#4a5d4e",
      display_order: 6,
      active: true
    },
    {
      id: "caribbean",
      name: "Caribbean",
      short_description:
        "Warm seas, island beaches and an easy-going tropical cruise rhythm.",
      best_months: [12, 1, 2, 3, 4],
      acceptable_months: [5, 11],
      preferred_climate: "warm",
      typical_nights_min: 7,
      typical_nights_max: 14,
      suitable_travellers: ["couple", "family", "friends", "group", "solo"],
      suitable_styles: ["warm_weather", "relaxing", "family", "adventure", "luxury"],
      departure_markets: ["sydney", "melbourne", "brisbane", "auckland", "perth", "adelaide", "other"],
      recommendation_explanation:
        "Winter and early spring are favoured for warmer, drier island weather.",
      image_url: null,
      accent: "#1a7a6d",
      display_order: 7,
      active: true
    },
    {
      id: "south-pacific",
      name: "South Pacific",
      short_description:
        "Island lagoons and relaxed island cultures within easier reach of Australia and New Zealand.",
      best_months: [5, 6, 7, 8, 9, 10],
      acceptable_months: [4, 11],
      preferred_climate: "warm",
      typical_nights_min: 7,
      typical_nights_max: 14,
      suitable_travellers: ["couple", "family", "friends", "group"],
      suitable_styles: ["warm_weather", "relaxing", "family", "scenic", "luxury"],
      departure_markets: ["sydney", "melbourne", "brisbane", "auckland", "perth", "adelaide"],
      recommendation_explanation:
        "The dry season generally brings the most settled island weather from Australia and NZ.",
      image_url: null,
      accent: "#0d6e6e",
      display_order: 8,
      active: true
    },
    {
      id: "australia-new-zealand",
      name: "Australia and New Zealand",
      short_description:
        "Home waters — coastal cities, islands and scenic NZ fjords without a long-haul flight.",
      best_months: [11, 12, 1, 2, 3],
      acceptable_months: [4, 10],
      preferred_climate: "mild",
      typical_nights_min: 3,
      typical_nights_max: 14,
      suitable_travellers: ["couple", "family", "friends", "group", "solo"],
      suitable_styles: ["scenic", "relaxing", "family", "food_wine", "culture", "warm_weather"],
      departure_markets: ["perth", "sydney", "melbourne", "brisbane", "adelaide", "auckland"],
      recommendation_explanation:
        "Summer is peak season for Australian coastal and New Zealand scenic itineraries.",
      image_url: null,
      accent: "#2f5d4a",
      display_order: 9,
      active: true
    },
    {
      id: "antarctica",
      name: "Antarctica",
      short_description:
        "An expedition to the White Continent — ice, wildlife and a once-in-a-lifetime voyage.",
      best_months: [11, 12, 1, 2, 3],
      acceptable_months: [],
      preferred_climate: "cool",
      typical_nights_min: 10,
      typical_nights_max: 21,
      suitable_travellers: ["couple", "solo", "friends", "group"],
      suitable_styles: ["expedition", "adventure", "scenic", "luxury", "cool_climate"],
      departure_markets: ["sydney", "melbourne", "brisbane", "auckland", "perth", "adelaide", "other"],
      recommendation_explanation:
        "The Antarctic season runs through the Southern Hemisphere summer only.",
      image_url: null,
      accent: "#4a6a8a",
      display_order: 10,
      active: true
    },
    {
      id: "canada-new-england",
      name: "Canada and New England",
      short_description:
        "Fall colours, historic ports and a refined North Atlantic coastal cruise.",
      best_months: [9, 10],
      acceptable_months: [8, 11],
      preferred_climate: "cool",
      typical_nights_min: 7,
      typical_nights_max: 14,
      suitable_travellers: ["couple", "solo", "friends", "group"],
      suitable_styles: ["scenic", "culture", "cool_climate", "food_wine", "relaxing", "luxury"],
      departure_markets: ["sydney", "melbourne", "brisbane", "auckland", "perth", "adelaide", "other"],
      recommendation_explanation:
        "September and October are prized for autumn colour along the Canada–New England coast.",
      image_url: null,
      accent: "#6b4a3a",
      display_order: 11,
      active: true
    },
    {
      id: "hawaii",
      name: "Hawaii",
      short_description:
        "Volcanic islands, beaches and an easy inter-island cruise in warm Pacific weather.",
      best_months: [1, 2, 3, 4, 5, 9, 10, 11, 12],
      acceptable_months: [6, 7, 8],
      preferred_climate: "warm",
      typical_nights_min: 7,
      typical_nights_max: 10,
      suitable_travellers: ["couple", "family", "friends", "group", "solo"],
      suitable_styles: ["warm_weather", "relaxing", "family", "scenic", "adventure", "luxury"],
      departure_markets: ["sydney", "melbourne", "brisbane", "auckland", "perth", "adelaide", "other"],
      recommendation_explanation:
        "Hawaii is enjoyable most of the year; shoulder seasons often feel more comfortable.",
      image_url: null,
      accent: "#c45c26",
      display_order: 12,
      active: true
    }
  ];

  root.CruiseFinderDestinations = DESTINATIONS;
})(typeof window !== "undefined" ? window : globalThis);
