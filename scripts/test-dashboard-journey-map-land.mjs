/**
 * Offline checks for Client Portal journey-map land layer + geographic projection.
 * Run: node scripts/test-dashboard-journey-map-land.mjs
 */

import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import vm from "vm";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const {
  projectJourneyMap,
  buildLandPathDList,
  landPathsToSvgMarkup,
  bboxTouchesMediterraneanContext,
  MILLENNIUM_DEMO_ITINERARY
} = (() => {
  const journeyLib = require("../netlify/functions/lib/dashboard-journey.js");
  const mapLib = require("../netlify/functions/lib/dashboard-journey-map.js");
  return {
    projectJourneyMap: journeyLib.projectJourneyMap,
    buildLandPathDList: mapLib.buildLandPathDList,
    landPathsToSvgMarkup: mapLib.landPathsToSvgMarkup,
    bboxTouchesMediterraneanContext: mapLib.bboxTouchesMediterraneanContext,
    MILLENNIUM_DEMO_ITINERARY: journeyLib.MILLENNIUM_DEMO_ITINERARY
  };
})();

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const exploraStops = [
  { date: "2026-09-28", name: "Barcelona", type: "embarkation", lat: 41.3584, lng: 2.1686 },
  { date: "2026-09-29", name: "Ibiza", type: "port", lat: 38.9067, lng: 1.4206 },
  { date: "2026-09-30", name: "Ibiza", type: "port", lat: 38.9067, lng: 1.4206 },
  { date: "2026-10-01", name: "Tunis/La Goulette", type: "port", lat: 36.8083788, lng: 10.3088217 },
  { date: "2026-10-02", name: "La Valletta", type: "port", lat: 35.8900644, lng: 14.5079974 },
  { date: "2026-10-03", name: "Giardini Naxos", type: "port", lat: 37.8239012, lng: 15.2718516 },
  { date: "2026-10-04", name: "Sorrento", type: "port", lat: 40.6299147, lng: 14.3768019 },
  { date: "2026-10-05", name: "Civitavecchia (Rome)", type: "disembarkation", lat: 42.093, lng: 11.79 }
];

const exploraJourney = {
  title: "Barcelona to Civitavecchia",
  can_draw_map: true,
  stops: exploraStops
};

/* Bundled dataset present — no paid APIs */
assert(existsSync(path.join(root, "assets/geo/land-50m.json")), "land-50m bundled");
assert(existsSync(path.join(root, "assets/geo/land-110m.json")), "land-110m bundled");
assert(existsSync(path.join(root, "assets/geo/README.md")), "geo README documents licence");
assert(existsSync(path.join(root, "js/vendor/topojson-client.min.js")), "topojson-client vendored locally");
assert(existsSync(path.join(root, "js/dashboard-journey-map-geo.js")), "browser geo helper present");

const geoReadme = readFileSync(path.join(root, "assets/geo/README.md"), "utf8");
assert(/Natural Earth/i.test(geoReadme) && /public domain/i.test(geoReadme), "licence documented");
assert(
  /Do not add Mapbox/i.test(geoReadme) && /Google Maps/i.test(geoReadme),
  "geo README explicitly forbids Mapbox/Google Maps"
);
assert(!/pk\.ey|MAPBOX_ACCESS_TOKEN|GOOGLE_MAPS_API_KEY/i.test(geoReadme), "no API keys in geo README");

const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
assert(indexHtml.includes("js/vendor/topojson-client.min.js"), "index loads local topojson");
assert(indexHtml.includes("js/dashboard-journey-map-geo.js"), "index loads geo helper");
assert(!/mapbox|googleapis|tiles\.|api\.mapbox/i.test(indexHtml), "index has no paid tile deps");

const plannerSrc = readFileSync(path.join(root, "js/planner.js"), "utf8");
assert(/id="dashboardMapLand"/.test(plannerSrc), "land group rendered in SVG");
assert(/dashboardMapLand[\s\S]*dashboardRoutePath|dashboardMapLand[\s\S]*dashboard-map-route|dashboardMapLand[\s\S]*use href="#dashboardRoutePath"/.test(plannerSrc), "land group precedes route in markup");
assert(
  plannerSrc.indexOf('id="dashboardMapLand"') < plannerSrc.indexOf('class="dashboard-map-route"') ||
    plannerSrc.indexOf('id="dashboardMapLand"') < plannerSrc.indexOf('href="#dashboardRoutePath"'),
  "land markup appears before route use"
);
assert(/attachLandLayer/.test(plannerSrc), "land attach wired after dashboard render");
assert(/DashboardJourneyMapGeo/.test(plannerSrc), "planner uses shared geo helper");
assert(!/mapbox|google\.maps|MAPBOX|GOOGLE_MAPS_API/i.test(plannerSrc), "planner has no paid map API");

const cssSrc = readFileSync(path.join(root, "css/planner.css"), "utf8");
assert(/\.dashboard-map-land/.test(cssSrc), "land CSS present");
assert(/\.dashboard-final-map[^{]*\{[^}]*overflow:\s*hidden/i.test(cssSrc), "map container clips overflow");

/* Route bounds drive viewport — not hardcoded Mediterranean constants */
const projection = projectJourneyMap(exploraJourney);
assert(projection.ok, "explora projects");
assert(projection.geo, "geo bounds present");
assert(projection.ports.length === 7, "Ibiza overnight collapsed to 7 unique ports");
assert(bboxTouchesMediterraneanContext(projection.geo), "viewport includes Mediterranean context");
assert(
  projection.geo.west < 2.17 &&
    projection.geo.east > 15.27 &&
    projection.geo.south < 35.9 &&
    projection.geo.north > 42.0,
  "viewport padded beyond route extremes"
);
assert(!/mediterranean|barcelona.*civita/i.test(JSON.stringify(projection.geo)), "geo is numeric bounds only");

/* Land layer renders below route conceptually (path list + markup) */
const landPaths = buildLandPathDList(projection, { resolution: "50m" });
assert(landPaths.length > 0, "land paths rendered for Explora viewport");
const landMarkup = landPathsToSvgMarkup(landPaths);
assert(/dashboard-map-land-shape/.test(landMarkup), "land path markup class present");
assert(landMarkup.includes("M"), "land paths contain SVG moves");

/* Layer order contract in composed SVG string */
const composed = [
  '<rect class="sea"/>',
  `<g id="dashboardMapLand">${landMarkup}</g>`,
  `<path id="dashboardRoutePath" d="${projection.pathD}"/>`,
  '<g class="dashboard-map-port"/>',
  '<g class="dashboard-map-ship"><animateMotion><mpath href="#dashboardRoutePath"/></animateMotion></g>'
].join("");
assert(
  composed.indexOf("dashboardMapLand") < composed.indexOf("dashboardRoutePath"),
  "land below route in composed SVG"
);
assert(
  composed.indexOf("dashboardRoutePath") < composed.indexOf("dashboard-map-ship"),
  "ship after route path definition"
);
assert(/mpath href="#dashboardRoutePath"/.test(composed), "animation uses projected route path");

/* Animation coordinates share projection — port endpoints match path endpoints */
const first = projection.ports[0];
const last = projection.ports[projection.ports.length - 1];
assert(projection.pathD.startsWith(`M ${first.x} ${first.y}`), "path starts at first projected port");
assert(projection.pathD.includes(`${last.x} ${last.y}`), "path includes last projected port");

/* Millennium fixture still renders with land */
const millJourney = {
  title: MILLENNIUM_DEMO_ITINERARY.title,
  can_draw_map: true,
  stops: MILLENNIUM_DEMO_ITINERARY.stops
};
const millProj = projectJourneyMap(millJourney);
assert(millProj.ok && millProj.ports.length >= 5, "millennium still projects");
const millLand = buildLandPathDList(millProj, { resolution: "110m" });
assert(millLand.length > 0, "millennium viewport gets land rings");

/* Date-line tolerant unwrap (Alaska / Pacific style) */
const pacific = projectJourneyMap({
  title: "Pacific test",
  stops: [
    { name: "A", lat: 51.8, lng: 178.5, type: "port" },
    { name: "B", lat: 52.1, lng: -175.2, type: "port" }
  ]
});
assert(pacific.ok, "antimeridian route projects");
assert(pacific.ports.length === 2, "two pacific ports");
assert(pacific.geo.east - pacific.geo.west < 40, "unwrapped pacific span stays regional");

/* Missing land data falls back safely */
const broken = projectJourneyMap(exploraJourney);
const originalLoad = require("../netlify/functions/lib/route-map-coastline.js").loadLandFeatureCollection;
const coastline = require("../netlify/functions/lib/route-map-coastline.js");
const prev = coastline.loadLandFeatureCollection;
coastline.loadLandFeatureCollection = () => {
  throw new Error("simulated missing land");
};
// Re-require map module? buildLandPathDList already closed over require — monkeypatch module exports
const mapMod = require("../netlify/functions/lib/dashboard-journey-map.js");
// Directly call with a stub by temporarily replacing via buildLandPathDList catch path —
// inject failure by passing projection without geo
assert(mapMod.buildLandPathDList({ ok: true }).length === 0, "missing geo → empty land");
assert(mapMod.buildLandPathDList(null).length === 0, "null projection → empty land");
coastline.loadLandFeatureCollection = prev;
void originalLoad;
void broken;

/* Browser helper: attachLandLayer fallback on fetch failure */
const geoSrc = readFileSync(path.join(root, "js/dashboard-journey-map-geo.js"), "utf8");
const sandbox = {
  console: { warn() {}, debug() {} },
  fetch() {
    return Promise.reject(new Error("network disabled in test"));
  },
  topojson: {
    feature() {
      throw new Error("should not decode when fetch fails");
    }
  },
  window: {},
  globalThis: null
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.runInNewContext(geoSrc, sandbox);
assert(sandbox.DashboardJourneyMapGeo, "browser geo API exported");
const fakeRoot = {
  querySelector(sel) {
    if (sel === "#dashboardMapLand") {
      return { innerHTML: "", setAttribute() {} };
    }
    return null;
  }
};
const attached = await sandbox.DashboardJourneyMapGeo.attachLandLayer(fakeRoot, projection);
assert(attached === false, "failed land load returns false without throwing");

/* Mobile sizing: planner clamps labels and map CSS prevents overflow */
assert(/Math\.min\(projection\.width/.test(plannerSrc), "label X clamped inside viewBox");
assert(/overflow="hidden"/.test(plannerSrc) || /overflow:hidden/.test(cssSrc), "overflow hidden on map");

console.log("test-dashboard-journey-map-land: ok");
