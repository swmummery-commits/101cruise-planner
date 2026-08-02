/**
 * Public Featured Cruise pages reuse shared Cruise Intelligence ship presentation.
 * Run: node scripts/test-public-ci-ship-presentation.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertMatch(haystack, pattern, msg) {
  assert(pattern.test(String(haystack || "")), msg);
}

function assertNoMatch(haystack, pattern, msg) {
  assert(!pattern.test(String(haystack || "")), msg);
}

function loadModule(rel, sandbox) {
  vm.runInNewContext(read(rel), sandbox, { filename: rel });
}

const millenniumShip = {
  id: "9d1a3655-be39-405c-9e00-96d7bb4925c7",
  name: "Celebrity Millennium",
  cruise_line_name: "Celebrity Cruises",
  cruise_line_logo_url: "https://cdn.example.com/celebrity.png",
  passenger_capacity: 2593,
  crew_count: 1000,
  deck_count: 12,
  stateroom_count: 1079,
  stateroom_breakdown: [
    { count: 212, label: "Inside" },
    { count: 244, label: "Oceanview" },
    { count: 573, label: "Balcony" },
    { count: 50, label: "Suites" }
  ],
  length_meters: 294,
  gross_tonnage: 90940,
  year_built: 2000,
  year_refurbished: 2019,
  hero_image_url: "https://cdn.example.com/millennium.jpg",
  deck_plan_url: "https://example.com/deck-plans",
  facilities: {
    restaurants: 10,
    bars: 10,
    pools: 3,
    hot_tubs: 4,
    specialty_dining: 4,
    spa: true,
    gym: true,
    theatre: true,
    casino: true,
    kids_club: true,
    shopping: true,
    exclusive_areas: [
      { name: "The Retreat", description: "Suite lounge", icon_key: "crown" },
      { name: "Blu", description: "AquaClass restaurant", icon_key: "private-dining" },
      { name: "Persian Garden", description: "Thermal suite", icon_key: "garden" }
    ],
    specialty_features: [
      { name: "The Solarium", description: "Adults-only pool area", icon_key: "lounge" },
      { name: "Fitness Center", description: "Modern gym", icon_key: "fitness" },
      { name: "Le Petit Chef", description: "", icon_key: "restaurants" }
    ]
  }
};

const sandbox = {
  console,
  Intl,
  globalThis: {},
  window: {},
  document: {
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    body: { appendChild() {} }
  },
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, source: "supabase", ship: millenniumShip })
  }),
  performance: { now: () => 0 },
  requestAnimationFrame(fn) {
    fn(0);
  },
  getComputedStyle() {
    return { getPropertyValue: () => "0.3s" };
  },
  matchMedia() {
    return { matches: true };
  },
  IntersectionObserver: function MockIntersectionObserver(cb) {
    this.cb = cb;
    this.observe = function () {
      cb([{ isIntersecting: true }]);
    };
    this.disconnect = function () {};
  }
};

sandbox.globalThis = sandbox;
sandbox.window = sandbox;

loadModule("js/ci-ship-feature-icons.js", sandbox);
loadModule("js/ci-ship-facilities.js", sandbox);
loadModule("js/ci-ship-stateroom-reconciliation.js", sandbox);
loadModule("js/ci-ship-spec-scale.js", sandbox);
loadModule("js/ci-ship-presentation.js", sandbox);
loadModule("js/public-cruise-ship.js", sandbox);

const Presentation = sandbox.CiShipPresentation;
const PublicCruiseShip = sandbox.PublicCruiseShip;

assert(Presentation, "CiShipPresentation exported");
assert(PublicCruiseShip, "PublicCruiseShip exported");

const profile = Presentation.buildProfile(millenniumShip, {
  shipName: "Celebrity Millennium",
  cruiseLine: "Celebrity Cruises"
});

assert(profile.summary.passengers === 2593, "passengers");
assert(profile.exclusiveAreas.length === 3, "exclusive areas");
assert(profile.specialtyFeatures.length === 3, "specialty features");
assertMatch(
  Presentation.renderPresentationHtml(profile, { mode: "public", shipImage: millenniumShip.hero_image_url }),
  /ship-feature-experiences-grid/,
  "experiences grid"
);
assertMatch(Presentation.renderPresentationHtml(profile, { mode: "public" }), /ship-deck-subsection/, "deck plans subsection");

const portalHtml = Presentation.renderPresentationHtml(profile, { mode: "portal" });
const publicHtml = Presentation.renderPresentationHtml(profile, { mode: "public" });
assert(
  portalHtml.match(/ship-summary-stat/g).length === publicHtml.match(/ship-summary-stat/g).length,
  "portal and public render same primary statistics count"
);

const specScale = sandbox.CiShipSpecScale;
const portalSpecs = specScale.buildShipSpecificationRows(millenniumShip);
const portalScale = specScale.buildShipScaleRows(millenniumShip);
assert(portalSpecs.some((row) => /Guest-to-crew ratio/i.test(row.label)), "guest-to-crew ratio");
assert(portalScale.some((row) => row.kind === "space_ratio"), "space ratio");

const html = Presentation.renderPresentationHtml(profile, { mode: "public" });
assertMatch(html, /ship-feature-label/, "feature labels");
assertNoMatch(html, /ship-feature-icon-holder/, "no icon holder boxes");
assertMatch(read("css/ci-ship-presentation.css"), /deckplans divider specialty/, "deck plans grid area css");
assertNoMatch(html, /<h1 class="ship-identity-name"/, "public uses h2 not h1");
assertMatch(html, /<h2 class="ship-identity-name"/, "public ship name heading");
assertNoMatch(html, /airline staff/i, "no airline staff");
assertNoMatch(html, /booking_reference/i, "no booking refs");

assertMatch(read("js/planner.js"), /CiShipPresentation\.renderPresentationHtml/, "planner uses shared module");
assertMatch(read("js/featured-cruise-article-components.js"), /data-fca-ci-ship-mount/, "v2 ship mount");
assertMatch(read("js/public-cruise-ship.js"), /fetchShip\(shipName, cruiseLine\)/, "public resolver uses line+name");
assertMatch(read("js/newsletter-preview.js"), /data-fca-ci-ship-mount/, "legacy ship mount");
assertMatch(read("netlify/functions/get-ship.js"), /logo_url/, "public logo on get-ship");

console.log("test-public-ci-ship-presentation.mjs: all checks passed");
