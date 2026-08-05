#!/usr/bin/env node
/**
 * Featured Cruise Article V2 — focused tests (HOLD DEPLOY).
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

function makeSandbox() {
  const sandbox = {
    window: {},
    globalThis: null,
    console,
    URLSearchParams,
    Image: null
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  return sandbox;
}

const sandbox = makeSandbox();
loadScript("js/newsletter-cruise-shared.js", sandbox);
loadScript("js/destination-experience-image-loader.js", sandbox);
loadScript("js/featured-cruise-article-copy.js", sandbox);
loadScript("js/featured-cruise-article-data.js", sandbox);
loadScript("js/featured-cruise-article-components.js", sandbox);
loadScript("js/featured-cruise-article.js", sandbox);

const Copy = sandbox.FeaturedCruiseArticleCopy;
const Data = sandbox.FeaturedCruiseArticleData;
const Components = sandbox.FeaturedCruiseArticleComponents;

const longEditorial =
  "Departing on 5 November 2026, this seven-night voyage aboard Oceania Sirena is a classic Mediterranean to Aegean crossing. " +
  "Overnight stays and iconic ports make this a memorable journey through ancient empires and spectacular coastlines. " +
  "Expect refined dining, elegant public spaces and a relaxed onboard atmosphere throughout.";

const sparseCruise = {
  public_slug: "sail-through-ancient-empires-spectacular-coastlines-and-timeless-mediterranean-t",
  headline: "Rome to Istanbul",
  destination_strip: "ROME, ITALY TO ISTANBUL, TURKEY",
  departure_port: "Rome, Italy",
  arrival_port: "Istanbul, Turkey",
  departure_date: "2026-11-05",
  return_date: "2026-11-12",
  nights: 7,
  cruise_line_name: "Oceania Cruises",
  ship_name: "Sirena",
  short_editorial: longEditorial,
  hero: { url: "https://cdn.example.com/hero.jpg", alt_text: "Hero" },
  route_map: { url: "https://cdn.example.com/map.png", alt_text: "Map" },
  itinerary: {
    port_count: 3,
    stops: [
      { name: "Rome", day_number: 1, is_sea_day: false },
      { name: "Valletta", day_number: 3, is_sea_day: false },
      { name: "Istanbul", day_number: 7, is_sea_day: false }
    ]
  },
  research: { ship_facts: { guests: 670, crew: 400, restaurants: 4 } }
};

const heroIntro = Copy.buildHeroIntro(sparseCruise);

const publicJs = read("js/public-cruise.js");
const cruiseHtml = read("cruise/index.html");
assert.match(publicJs, /renderArticleV2/, "public cruise attempts Article V2");
assert.match(publicJs, /wantsLegacyArticleOverride/, "legacy override helper present");
assert.match(publicJs, /get\("article"\) === "legacy"/, "legacy available via article=legacy");
assert.match(publicJs, /renderLegacyPublicPage/, "legacy renderer retained as fallback");
assert.doesNotMatch(publicJs, /bootFeaturedCruise/, "DX boot not used on public page");
assert.match(cruiseHtml, /featured-cruise-article-v2-3/, "article v2 cache busting present");
assert.match(cruiseHtml, /ci-ship-presentation\.js/, "shared ship presentation on cruise page");
assert.match(cruiseHtml, /public-cruise-ship\.js/, "public cruise ship mount helper loaded");
assert.doesNotMatch(cruiseHtml, /destination-experience-featured-cruise-components.js/, "DX components not on cruise page");
assert.match(cruiseHtml, /featured-cruise-article.js/, "article v2 assets loaded");

assert.match(read("css/featured-cruise-article.css"), /--fca-max:\s*1080px/, "desktop article uses widened container");
assert.match(read("css/featured-cruise-article.css"), /repeat\(3, minmax\(0, 1fr\)\)/, "itinerary desktop uses 3 columns");
assert.match(read("css/featured-cruise-article.css"), /font-weight:\s*500/, "section headings use medium weight");
assert.match(read("css/featured-cruise-article.css"), /repeat\(4, minmax\(0, 1fr\)\)/, "legacy fact grid retains 4 columns");
assert.match(read("css/featured-cruise-article.css"), /repeat\(3, minmax\(0, 1fr\)\)/, "tablet fact grid uses 3 columns");
assert.ok(heroIntro.length <= Copy.HERO_INTRO_MAX + 40, "hero intro capped");
assert.doesNotMatch(heroIntro, /\.\.\./, "hero intro not ellipsized mid-thought");

const sparseModel = Data.fromFeaturedCruise(sparseCruise);
const sparseHtml = Components.renderPage(sparseModel);
assert.doesNotMatch(sparseHtml, /Three reasons this sailing stands out/, "sparse cruise avoids three-reason heading");
assert.match(sparseHtml, /Overview/, "editorial overview present once");
assert.equal((sparseHtml.match(/Departing on 5 November 2026/g) || []).length, 1, "editorial not duplicated in hero and body");

const oneReasonModel = Data.fromFeaturedCruise({
  ...sparseCruise,
  research: {
    destination_full: { why_visit: ["Ancient ports and elegant sea days"], overview: "A concise destination overview for testing." },
    ship_facts: { guests: 670 }
  }
});
assert.equal(oneReasonModel.reasonCount, 1, "one supported reason");
assert.doesNotMatch(Components.renderPage(oneReasonModel), /Three reasons this sailing stands out/, "single reason avoids three-reason heading");

const threeReasonModel = Data.fromFeaturedCruise({
  ...sparseCruise,
  research: {
    destination_full: {
      why_visit: ["Ancient ports", "Coastal scenery", "Refined onboard comfort"],
      overview: "Reason one body copy for testing with enough detail.",
      key_highlights: []
    },
    ship_facts: { guests: 670 }
  }
});
assert.equal(threeReasonModel.reasonCount, 3, "three supported reasons");
assert.match(Components.renderPage(threeReasonModel), /Three reasons this sailing stands out/, "three reasons heading when supported");

const noReasonModel = Data.fromFeaturedCruise({
  ...sparseCruise,
  itinerary: { port_count: 1, stops: [{ name: "Rome", day_number: 1, is_sea_day: false }] },
  research: { ship_facts: { guests: 670 } }
});
assert.equal(noReasonModel.reasonCount, 0, "no reasons hides section");
assert.doesNotMatch(Components.renderPage(noReasonModel), /Why this sailing stands out/, "no empty reasons section");

async function resolveWithMock(model, cruise, brokenUrls) {
  const broken = new Set(brokenUrls || []);
  return sandbox.FeaturedCruiseArticle.resolveArticleMedia(model, cruise, {
    preload: async (url) => ({ ok: !broken.has(url), url })
  });
}

const brokenMapModel = await resolveWithMock(Data.fromFeaturedCruise(sparseCruise), sparseCruise, [
  "https://cdn.example.com/map.png"
]);
assert.equal(brokenMapModel.routeMap, null, "broken route map removed");
assert.doesNotMatch(Components.renderPage(brokenMapModel), /fca-route-map-section/, "broken route map hidden");

const brokenShipModel = await resolveWithMock(
  Data.fromFeaturedCruise({
    ...sparseCruise,
    media: { ship_hero: { url: "https://cdn.example.com/ship.jpg" } },
    research: { ship_full: { overview: "Ship overview" }, ship_facts: { guests: 1000 } }
  }),
  {
    ...sparseCruise,
    media: { ship_hero: { url: "https://cdn.example.com/ship.jpg" } },
    research: { ship_full: { image: { url: "https://cdn.example.com/broken-ship.jpg" } }, ship_facts: { guests: 1000 } }
  },
  ["https://cdn.example.com/broken-ship.jpg"]
);
assert.equal(brokenShipModel.shipName, "Sirena", "ship name retained for CI ship section");

const shipInfoHtml = Components.renderPage(brokenShipModel);
assert.match(shipInfoHtml, /Ship Info/, "ship info heading");
assert.match(shipInfoHtml, /data-fca-ci-ship-mount/, "ship info mount point");
assert.doesNotMatch(shipInfoHtml, /Life on board/, "legacy life-on-board ship section removed");

const sparseShipHtml = Components.renderPage(Data.fromFeaturedCruise({ ...sparseCruise, ship_name: "" }));
assert.doesNotMatch(sparseShipHtml, /data-fca-ci-ship-mount/, "no ship section without ship name");

const brokenPortModel = await resolveWithMock(
  Data.fromFeaturedCruise({
    ...sparseCruise,
    itinerary: {
      port_count: 1,
      stops: [{ name: "Valletta", day_number: 3, is_sea_day: false, image: { url: "https://cdn.example.com/port.jpg" } }]
    }
  }),
  sparseCruise,
  ["https://cdn.example.com/port.jpg"]
);
const brokenPortHtml = Components.renderPage(brokenPortModel);
assert.match(brokenPortHtml, /fca-port-card--fallback/, "failed port uses pale fallback");
assert.doesNotMatch(brokenPortHtml, /fca-port-card--photo/, "failed port avoids photo card");

assert.doesNotMatch(Components.renderPage(sparseModel), /airline staff/i, "no airline staff pricing");
assert.match(read("js/newsletter-mailchimp-export.js"), /101cruise\.com\.au\/cruise\?slug=/, "explore more URL unchanged");

const cfRoute = read("scripts/test-destination-routing.mjs");
assert.match(cfRoute, /destinationPageUrl/, "destination routing test present");

console.log("test-featured-cruise-article-v2.mjs: all checks passed");
