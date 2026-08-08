/**
 * Featured Cruise Destination Experience — focused tests (HOLD DEPLOY).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function loadScript(rel, sandbox) {
  vm.runInNewContext(read(rel), sandbox, { filename: rel });
}

const sandbox = {
  window: {},
  globalThis: null,
  console,
  URLSearchParams
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;

loadScript("js/newsletter-cruise-shared.js", sandbox);
loadScript("js/destination-experience-data.js", sandbox);
loadScript("js/destination-experience-image-loader.js", sandbox);
loadScript("js/destination-experience-featured-cruise-data.js", sandbox);
loadScript("js/destination-experience-components.js", sandbox);
loadScript("js/destination-experience-featured-cruise-components.js", sandbox);

const Data = sandbox.DestinationExperienceData;
const FCData = sandbox.DestinationExperienceFeaturedCruiseData;
const Components = sandbox.DestinationExperienceComponents;
const FCComponents = sandbox.DestinationExperienceFeaturedCruiseComponents;
const Loader = sandbox.DestinationExperienceImageLoader;

assert(Data && FCData && Components && FCComponents && Loader, "globals exported");

async function withPreloadMock(failUrls, fn) {
  const failSet = new Set(failUrls || []);
  Loader.clearCache();
  const mockPreload = async (url) => {
    const key = String(url || "");
    if (!key) return { ok: false, url: "", error: "empty_url" };
    if (failSet.has(key)) return { ok: false, url: key, error: "load_failed" };
    return { ok: true, url: key, width: 800, height: 600 };
  };
  return fn(mockPreload);
}

async function resolveFeaturedModel(cruise, failUrls) {
  return withPreloadMock(failUrls, async (mockPreload) => {
    const model = FCData.fromFeaturedCruise(cruise);
    await Loader.resolveFeaturedCruiseMedia(model, cruise, { preload: mockPreload });
    return model;
  });
}

const publishedShipRow = {
  content_status: "published",
  entity_name: "Sirena",
  content_json: {
    overview: "An intimate luxury ship.",
    personality: "Refined and relaxed.",
    best_for: ["Couples", "Destination collectors"],
    not_ideal_for: ["Large-scale entertainment seekers"],
    dining_summary: "Several specialty venues.",
    entertainment_summary: "Live music and enrichment.",
    wellness_summary: "Spa and fitness centre.",
    family_summary: "Limited kids facilities.",
    accommodation_summary: "Suites and verandas.",
    key_highlights: ["All-inclusive dining"]
  },
  pauls_tip: "Book early for veranda suites.",
  summary_text: "Luxury small ship."
};

const draftShipRow = {
  content_status: "draft",
  entity_name: "Draft Ship",
  content_json: { overview: "Should not appear" },
  pauls_tip: "Draft tip"
};

const { toPublicShipResearchFull } = await import(
  "../netlify/functions/lib/research-public.js"
);

assert.equal(toPublicShipResearchFull(draftShipRow), null, "unpublished ship research excluded");
const shipPublic = toPublicShipResearchFull(publishedShipRow);
assert.ok(shipPublic.overview.includes("intimate"), "published ship overview included");
assert.equal(shipPublic.pauls_tip, "Book early for veranda suites.", "published paul tip included");

const baseCruise = {
  public_slug: "barcelona-istanbul",
  headline: "Barcelona to Istanbul",
  destination_strip: "BARCELONA TO ISTANBUL",
  departure_port: "Barcelona",
  arrival_port: "Istanbul",
  departure_date: "2026-10-05",
  return_date: "2026-10-19",
  nights: 14,
  cruise_line_name: "Oceania Cruises",
  ship_name: "Sirena",
  short_editorial: "A classic Mediterranean to Aegean crossing.",
  hero: { url: "https://cdn.example.com/hero.jpg", alt_text: "Sirena" },
  route_map: { url: "https://cdn.example.com/map.png", alt_text: "Route map" },
  destination_region: "Mediterranean",
  itinerary: {
    port_count: 8,
    sea_day_count: 2,
    stops: [
      { order: 1, day_number: 1, name: "Barcelona", is_sea_day: false, stop_type: "embarkation", image: null },
      { order: 2, day_number: 2, name: "Palma de Mallorca", is_sea_day: false, stop_type: "port_call", image: null },
      { order: 3, day_number: 3, name: "At sea", is_sea_day: true, stop_type: "at_sea", image: null },
      { order: 4, day_number: 4, name: "Valletta", is_sea_day: false, stop_type: "port_call", image: { url: "https://cdn.example.com/valletta.jpg" } },
      { order: 5, day_number: 5, name: "Istanbul", is_sea_day: false, stop_type: "disembarkation", image: null }
    ]
  },
  media: {
    destination_images: [{ url: "https://cdn.example.com/med.jpg", alt_text: "Mediterranean" }],
    ship_gallery: [],
    ship_hero: null
  },
  research: {
    destination_full: {
      overview: "Historic ports and warm autumn light.",
      ideal_for: ["Culture", "Food & wine"],
      why_visit: ["Iconic cities", "Coastal scenery", "Regional cuisine"],
      best_time_to_visit: "April to June and September to October are ideal.",
      climate_summary: "Mediterranean warmth with manageable crowds in shoulder months."
    },
    destination_season: {
      best_months: [4, 5, 6, 9, 10],
      best_time_to_visit: "April to June and September to October are ideal.",
      climate_summary: "Mediterranean warmth with manageable crowds in shoulder months."
    },
    ship_full: shipPublic,
    ship_facts: {
      guests: 684,
      crew: 400,
      decks: 11,
      restaurants: 6,
      spa: true
    }
  }
};

const sparseCruise = {
  public_slug: "sparse-cruise",
  headline: "Sparse Cruise",
  destination_strip: "SYDNEY TO AUCKLAND",
  departure_port: "Sydney",
  arrival_port: "Auckland",
  departure_date: "2026-03-01",
  return_date: "2026-03-08",
  nights: 7,
  cruise_line_name: "Example Line",
  ship_name: "Example Ship",
  short_editorial: "A repositioning cruise.",
  hero: null,
  route_map: null,
  itinerary: { stops: [], port_count: 0, sea_day_count: 0 },
  media: { destination_images: [], ship_gallery: [], ship_hero: null },
  research: { ship_full: null, ship_facts: null, destination_full: null, destination_season: null }
};

const model = FCData.fromFeaturedCruise(baseCruise);
assert.equal(model.mode, "featuredCruise", "featured cruise mode set");
assert.equal(model.name, "BARCELONA TO ISTANBUL", "route heading used");
assert.equal(model.seasonTimeline.mode, "cruise", "exact sailing dates drive seasonal mode");
assert.equal(model.seasonTimeline.allowManualSelection, false, "no manual month selection");
assert.ok(model.seasonTimeline.dateLabel.includes("2026"), "exact cruise dates shown");
assert.equal(model.ports.length, 5, "actual itinerary ports used");
assert.ok(model.ports.some((port) => port.name === "At sea"), "sea day included");
assert.ok(!model.ports.some((port) => port.name === "Caribbean"), "generic destination ports excluded");

const resolvedModel = await resolveFeaturedModel(baseCruise);
const html = FCComponents.renderFeaturedCruisePage(resolvedModel);
assert.match(html, /data-dx-mode="featuredCruise"/, "featured cruise page marker");
assert.match(html, /Valletta/, "itinerary port rendered");
assert.match(html, /dx-port-card--photo/, "verified port photo card rendered");
assert.match(html, /Route map/, "route map section rendered");
assert.match(html, /About Sirena/, "ship section rendered");
assert.match(html, /May not suit travellers who/, "not ideal section rendered");
assert.match(html, /Paul's tip/, "paul tip rendered");
assert.match(html, /Enquire with Paul/, "enquiry CTA rendered");
assert.doesNotMatch(html, /airline/i, "no airline staff pricing");
assert.doesNotMatch(html, /undefined/, "no undefined strings");

const sparseModel = FCData.fromFeaturedCruise(sparseCruise);
const sparseHtml = FCComponents.renderFeaturedCruisePage(sparseModel);
assert.doesNotMatch(sparseHtml, /About Example Ship/, "missing ship research hides ship section");
assert.match(sparseHtml, /Enquire with Paul/, "basic enquiry remains");

const cfCaribbean = Data.fromCruiseFinder("caribbean", {
  catalogue: [{ id: "caribbean", name: "Caribbean", best_months: [12, 1, 2, 3, 4], acceptable_months: [], suitable_styles: ["beaches"], typical_cruise_lines: [], typical_nights_min: 7, typical_nights_max: 14, hero_tagline: "Test", inspirational_description: "Test", accent: "#000" }],
  content: { caribbean: { key_reasons: ["One", "Two", "Three"], seasonal_advice: {} } },
  images: null,
  pickImage: () => null,
  filterLines: (names) => names
});
const cfHtml = Components.renderPage(cfCaribbean);
assert.match(cfHtml, /Why cruise here/, "cruise finder destination unchanged");
assert.doesNotMatch(cfHtml, /featuredCruise/, "cruise finder not featured cruise mode");

assert.match(read("js/public-cruise.js"), /FeaturedCruiseArticle/, "public cruise uses Article V2");
assert.match(read("js/public-cruise.js"), /renderPublicCruisePage/, "legacy renderer retained for fallback");
assert.doesNotMatch(read("cruise/index.html"), /destination-experience-featured-cruise-data.js/, "cruise page does not load featured DX assets");
assert.match(html, /dx-fc-itinerary-grid/, "itinerary ports use responsive grid not carousel");
assert.doesNotMatch(html, /swiper|carousel|dx-port-track/i, "no horizontal port carousel");

const exploreUrl = "https://www.101cruise.com.au/cruise?slug=barcelona-istanbul";
assert.match(exploreUrl, /slug=barcelona-istanbul/, "explore more URL contract preserved");

const shipCandidates = Loader.collectShipHeroCandidates({
  ship_name: "Sirena",
  research: { ship_full: { image: { url: "https://cdn.example.com/published-ship.jpg" } } },
  media: {
    ship_hero: { url: "https://cdn.example.com/ci-ship.jpg" },
    ship_gallery: [{ url: "https://cdn.example.com/gallery-1.jpg" }]
  }
});
assert.equal(shipCandidates.length, 3, "ship hero candidate count");
assert.equal(shipCandidates[0].url, "https://cdn.example.com/published-ship.jpg", "published ship hero first");
assert.equal(shipCandidates[1].url, "https://cdn.example.com/ci-ship.jpg", "CI ship hero second");
assert.equal(shipCandidates[2].url, "https://cdn.example.com/gallery-1.jpg", "gallery image third");

const brokenMapModel = await resolveFeaturedModel(baseCruise, ["https://cdn.example.com/map.png"]);
assert.equal(brokenMapModel.routeMap, null, "broken route map removed from model");
const brokenMapHtml = FCComponents.renderFeaturedCruisePage(brokenMapModel);
assert.doesNotMatch(brokenMapHtml, /dx-fc-route-map-section/, "broken route map hides entire section");
assert.doesNotMatch(brokenMapHtml, /route-map\.png|cdn\.example\.com\/map\.png/i, "no broken route map URL in markup");

const validMapModel = await resolveFeaturedModel(baseCruise);
assert.ok(validMapModel.routeMap && validMapModel.routeMap.loadState === "loaded", "valid route map kept");
assert.match(FCComponents.renderFeaturedCruisePage(validMapModel), /dx-fc-route-map-section/, "valid route map section renders");

const shipFallbackCruise = JSON.parse(JSON.stringify(baseCruise));
shipFallbackCruise.research.ship_full.image = {
  url: "https://cdn.example.com/broken-published-ship.jpg",
  alt_text: "Broken published"
};
shipFallbackCruise.media.ship_hero = { url: "https://cdn.example.com/ci-ship-hero.jpg", alt_text: "CI ship" };
const shipFallbackModel = await resolveFeaturedModel(shipFallbackCruise, [
  "https://cdn.example.com/broken-published-ship.jpg"
]);
assert.equal(
  shipFallbackModel.ship.hero.url,
  "https://cdn.example.com/ci-ship-hero.jpg",
  "broken primary ship falls through to CI hero"
);

const allShipBrokenModel = await resolveFeaturedModel(shipFallbackCruise, [
  "https://cdn.example.com/broken-published-ship.jpg",
  "https://cdn.example.com/ci-ship-hero.jpg"
]);
assert.equal(allShipBrokenModel.ship.hero, null, "all failed ship images clear hero");
const allShipBrokenHtml = FCComponents.renderFeaturedCruisePage(allShipBrokenModel);
assert.doesNotMatch(allShipBrokenHtml, /dx-fc-ship-hero[^-]/, "failed ship images remove hero frame");
assert.match(allShipBrokenHtml, /dx-fc-ship-intro--no-image/, "ship copy expands when image removed");

const brokenPortModel = await resolveFeaturedModel(baseCruise, ["https://cdn.example.com/valletta.jpg"]);
const vallettaPort = brokenPortModel.ports.find((port) => port.name === "Valletta");
assert.equal(vallettaPort.image, null, "failed port photograph removed from model");
const brokenPortHtml = FCComponents.renderFeaturedCruisePage(brokenPortModel);
assert.match(brokenPortHtml, /dx-port-card--fallback/, "failed port uses pale monogram fallback");
assert.doesNotMatch(
  brokenPortHtml,
  /Valletta[\s\S]{0,220}dx-port-card--photo/,
  "failed port is not rendered as photo card"
);
assert.doesNotMatch(brokenPortHtml, /dx-port-photo-veil/, "no dark photo overlay on failed port");

const validPortModel = await resolveFeaturedModel(baseCruise);
assert.ok(
  validPortModel.ports.some((port) => port.name === "Valletta" && port.image && port.image.loadState === "loaded"),
  "valid port photo retained after preload"
);

assert.match(read("js/destination-experience.js"), /resolveFeaturedCruiseMedia/, "featured boot resolves FC media");
assert.match(read("js/destination-experience-image-loader.js"), /collectShipHeroCandidates/, "ship hero chain helper present");

console.log("test-featured-cruise-destination-experience.mjs: all checks passed");
