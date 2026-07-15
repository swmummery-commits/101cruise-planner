/**
 * 101cruise Cruise Finder — lightweight demo destinations only.
 * Temporary seed data. Future versions will generate descriptions,
 * seasonal fit, weather, cruise lines and hero imagery with AI.
 *
 * image_search_phrase drives automatic hero photography today.
 * Later: AI supplies a seasonal phrase (or ai_image_search_phrase)
 * and the same lookup endpoint resolves the image.
 */
(function (root) {
  "use strict";

  const DESTINATIONS = [
    {
      id: "alaska",
      name: "Alaska",
      inspirational_description:
        "Ice-blue glaciers, quiet wilderness and wildlife that makes you stop mid-sentence. Alaska is the cruise for travellers who want nature on a grand scale.",
      best_months: [5, 6, 7, 8],
      acceptable_months: [4, 9],
      typical_weather: "Cool, crisp days with long summer light and occasional showers.",
      typical_nights_min: 7,
      typical_nights_max: 14,
      typical_cruise_lines: ["Holland America", "Princess", "Celebrity", "Royal Caribbean"],
      suitable_travellers: ["couple", "family", "friends", "solo", "multi_generational"],
      suitable_styles: ["scenic_cruising", "adventure", "wildlife", "cold_weather", "bucket_list", "relaxation"],
      departure_markets: ["sydney", "brisbane", "melbourne", "perth", "adelaide", "auckland", "anywhere"],
      image_url: null,
      image_search_phrase: "Alaska glacier cruise",
      accent: "#3d5a6c",
      display_order: 1,
      active: true
    },
    {
      id: "japan",
      name: "Japan",
      inspirational_description:
        "A journey of contrast — quiet temples, neon cities, coastal villages and some of the world’s most thoughtful food culture.",
      best_months: [3, 4, 5, 9, 10, 11],
      acceptable_months: [2, 6, 12],
      typical_weather: "Mild springs and autumns; humid summers and cooler winters.",
      typical_nights_min: 8,
      typical_nights_max: 14,
      typical_cruise_lines: ["Princess", "Celebrity", "MSC", "Holland America"],
      suitable_travellers: ["couple", "solo", "friends", "multi_generational"],
      suitable_styles: ["culture", "food_wine", "scenic_cruising", "bucket_list", "luxury", "adventure"],
      departure_markets: ["sydney", "brisbane", "melbourne", "perth", "adelaide", "auckland", "anywhere"],
      image_url: null,
      image_search_phrase: "Japan cruise Mount Fuji",
      accent: "#8b3a3a",
      display_order: 2,
      active: true
    },
    {
      id: "mediterranean",
      name: "Mediterranean",
      inspirational_description:
        "Sunlit harbours, long lunches and layers of history — the Mediterranean remains the classic European cruise for good reason.",
      best_months: [5, 6, 7, 8, 9],
      acceptable_months: [4, 10],
      typical_weather: "Warm to hot summers with long sunny days; milder spring and autumn.",
      typical_nights_min: 7,
      typical_nights_max: 14,
      typical_cruise_lines: ["Celebrity", "Princess", "MSC", "Norwegian", "Explora"],
      suitable_travellers: ["couple", "family", "friends", "solo", "multi_generational"],
      suitable_styles: ["culture", "food_wine", "beaches", "warm_weather", "relaxation", "luxury", "scenic_cruising"],
      departure_markets: ["sydney", "brisbane", "melbourne", "perth", "adelaide", "auckland", "anywhere"],
      image_url: null,
      image_search_phrase: "Mediterranean cruise Santorini",
      accent: "#2f6f8f",
      display_order: 3,
      active: true
    },
    {
      id: "norwegian-fjords",
      name: "Norwegian Fjords",
      inspirational_description:
        "Sheer cliffs, mirror-still water and villages tucked into the folds of the mountains — scenic cruising at its most dramatic.",
      best_months: [5, 6, 7, 8],
      acceptable_months: [4, 9],
      typical_weather: "Cool summers with bright evenings; changeable coastal conditions.",
      typical_nights_min: 7,
      typical_nights_max: 14,
      typical_cruise_lines: ["Holland America", "Princess", "Celebrity", "Viking"],
      suitable_travellers: ["couple", "solo", "friends", "family", "multi_generational"],
      suitable_styles: ["scenic_cruising", "cold_weather", "adventure", "relaxation", "luxury", "bucket_list"],
      departure_markets: ["sydney", "brisbane", "melbourne", "perth", "adelaide", "auckland", "anywhere"],
      image_url: null,
      image_search_phrase: "Norwegian Fjords cruise",
      accent: "#355e5a",
      display_order: 4,
      active: true
    },
    {
      id: "caribbean",
      name: "Caribbean",
      inspirational_description:
        "Warm water, easy island days and a holiday rhythm that asks very little of you — ideal when you simply want to unwind.",
      best_months: [12, 1, 2, 3, 4],
      acceptable_months: [5, 11],
      typical_weather: "Warm to hot tropical days; drier months favoured in winter and early spring.",
      typical_nights_min: 7,
      typical_nights_max: 14,
      typical_cruise_lines: ["Royal Caribbean", "Celebrity", "Princess", "MSC", "Norwegian"],
      suitable_travellers: ["couple", "family", "friends", "solo", "multi_generational"],
      suitable_styles: ["beaches", "warm_weather", "relaxation", "family", "adventure", "luxury"],
      departure_markets: ["sydney", "brisbane", "melbourne", "perth", "adelaide", "auckland", "anywhere"],
      image_url: null,
      image_search_phrase: "Caribbean cruise tropical beach",
      accent: "#1a7a6d",
      display_order: 5,
      active: true
    },
    {
      id: "south-pacific",
      name: "South Pacific",
      inspirational_description:
        "Lagoon blues and island ease within closer reach of Australia and New Zealand — a holiday that feels far away without the longest flight.",
      best_months: [5, 6, 7, 8, 9, 10],
      acceptable_months: [4, 11],
      typical_weather: "Warm tropical conditions; dry season usually more settled.",
      typical_nights_min: 7,
      typical_nights_max: 14,
      typical_cruise_lines: ["P&O Australia", "Princess", "Carnival", "Royal Caribbean"],
      suitable_travellers: ["couple", "family", "friends", "multi_generational"],
      suitable_styles: ["beaches", "warm_weather", "relaxation", "family", "scenic_cruising", "luxury"],
      departure_markets: ["sydney", "brisbane", "melbourne", "perth", "adelaide", "auckland"],
      image_url: null,
      image_search_phrase: "South Pacific Bora Bora cruise",
      accent: "#0d6e6e",
      display_order: 6,
      active: true
    },
    {
      id: "australia-new-zealand",
      name: "Australia & New Zealand",
      inspirational_description:
        "Home waters with surprising variety — coastal cities, island stops and New Zealand scenery without a long-haul journey first.",
      best_months: [11, 12, 1, 2, 3],
      acceptable_months: [4, 10],
      typical_weather: "Warm summers; milder spring and autumn coastal conditions.",
      typical_nights_min: 3,
      typical_nights_max: 14,
      typical_cruise_lines: ["P&O Australia", "Princess", "Celebrity", "Royal Caribbean"],
      suitable_travellers: ["couple", "family", "friends", "solo", "multi_generational"],
      suitable_styles: ["scenic_cruising", "relaxation", "family", "food_wine", "culture", "warm_weather", "beaches"],
      departure_markets: ["sydney", "brisbane", "melbourne", "perth", "adelaide", "auckland"],
      image_url: null,
      image_search_phrase: "Australia New Zealand cruise Sydney Harbour",
      accent: "#2f5d4a",
      display_order: 7,
      active: true
    },
    {
      id: "antarctica",
      name: "Antarctica",
      inspirational_description:
        "A true expedition — ice, silence and wildlife that belongs on a once-in-a-lifetime list.",
      best_months: [11, 12, 1, 2, 3],
      acceptable_months: [],
      typical_weather: "Cold expedition conditions during the Southern summer season only.",
      typical_nights_min: 10,
      typical_nights_max: 21,
      typical_cruise_lines: ["Hurtigruten", "Silversea", "Seabourn", "Ponant"],
      suitable_travellers: ["couple", "solo", "friends"],
      suitable_styles: ["expedition", "adventure", "wildlife", "bucket_list", "cold_weather", "luxury", "scenic_cruising"],
      departure_markets: ["sydney", "brisbane", "melbourne", "perth", "adelaide", "auckland", "anywhere"],
      image_url: null,
      image_search_phrase: "Antarctica expedition cruise",
      accent: "#4a6a8a",
      display_order: 8,
      active: true
    },
    {
      id: "hawaii",
      name: "Hawaii",
      inspirational_description:
        "Volcanic islands, ocean swimming and an easy inter-island cruise that still feels like an escape.",
      best_months: [1, 2, 3, 4, 5, 9, 10, 11, 12],
      acceptable_months: [6, 7, 8],
      typical_weather: "Warm year-round; trade winds and occasional tropical showers.",
      typical_nights_min: 7,
      typical_nights_max: 10,
      typical_cruise_lines: ["Princess", "Norwegian", "Celebrity", "Holland America"],
      suitable_travellers: ["couple", "family", "friends", "solo", "multi_generational"],
      suitable_styles: ["beaches", "warm_weather", "relaxation", "family", "scenic_cruising", "adventure", "luxury"],
      departure_markets: ["sydney", "brisbane", "melbourne", "perth", "adelaide", "auckland", "anywhere"],
      image_url: null,
      image_search_phrase: "Hawaii cruise Waikiki",
      accent: "#c45c26",
      display_order: 9,
      active: true
    },
    {
      id: "greek-islands",
      name: "Greek Islands",
      inspirational_description:
        "Whitewashed villages, Aegean blue and long evenings that stretch into dinner by the water.",
      best_months: [5, 6, 7, 8, 9],
      acceptable_months: [4, 10],
      typical_weather: "Hot, dry summers with excellent swimming weather.",
      typical_nights_min: 7,
      typical_nights_max: 10,
      typical_cruise_lines: ["Celebrity", "MSC", "Norwegian", "Explora"],
      suitable_travellers: ["couple", "friends", "family", "multi_generational"],
      suitable_styles: ["beaches", "warm_weather", "relaxation", "culture", "food_wine", "scenic_cruising", "bucket_list"],
      departure_markets: ["sydney", "brisbane", "melbourne", "perth", "adelaide", "auckland", "anywhere"],
      image_url: null,
      image_search_phrase: "Greek Islands cruise Santorini",
      accent: "#1f6b8a",
      display_order: 10,
      active: true
    }
  ];

  root.CruiseFinderDestinations = DESTINATIONS;
})(typeof window !== "undefined" ? window : globalThis);
