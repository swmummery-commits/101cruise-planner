/**
 * Offline coverage for Client Portal experience upgrade (journey/loading/gallery/scroll/countdown/hero).
 * Run: node scripts/test-client-portal-experience.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const planner = readFileSync(path.join(root, "js/planner.js"), "utf8");
const css = readFileSync(path.join(root, "css/planner.css"), "utf8");
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const CruiseDateState = require("../js/cruise-date-state.js");
const { normaliseTextItineraryStops, formatTextItineraryStopLabel } = require(
  "../netlify/functions/lib/text-itinerary-process.js"
);
const { filterShipGalleryMedia } = require("../netlify/functions/lib/ship-gallery-media.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Itinerary display helpers
const stops = normaliseTextItineraryStops([
  { date: "2026-12-13", name: "BRISBANE", entry_type: "embarkation", arrival_time: null, departure_time: "16:00", notes: null, confidence: 1 },
  { date: "2026-12-14", name: "At Sea", entry_type: "sea_day", arrival_time: null, departure_time: null, notes: null, confidence: 1 },
  { date: "2026-12-15", name: "SYDNEY", entry_type: "port", arrival_time: "08:00", departure_time: "18:00", notes: null, confidence: 1 }
]);
assert(stops[0].day === 1 && stops[0].is_embarkation, "day 1 embark");
assert(stops[1].is_sea_day, "at sea");
assert(!stops[0].lat && !stops[0].lng, "no coordinates");
assert(/At sea/.test(formatTextItineraryStopLabel(stops[1])), "sea label");
assert(planner.includes("View full itinerary"), "expand control");
assert(planner.includes("Show less"), "collapse control");
assert(!/leaflet|topojson|resolveDashboardJourney/.test(planner.match(/function renderJourneySummary[\s\S]*?(?=function renderJourneyMap)/)?.[0] || ""), "no map in summary");
assert(planner.includes("dashboard-journey-summary-row"), "summary rows");
assert(/grid-template-columns:\s*minmax\(120px/.test(css), "summary grid spacing");

// Loading
assert(indexHtml.includes("portal-loading.js"), "loads portal loading");
const loading = readFileSync(path.join(root, "js/portal-loading.js"), "utf8");
assert(loading.includes("aria-live"), "a11y live");
assert(loading.includes("delayMs"), "delayed show");
assert(loading.includes("activeCount"), "refcount");
assert(loading.includes("lockScroll"), "scroll lock");
assert(loading.includes("101cruise-parent-viewport") || indexHtml.includes("portal-parent-viewport.js"), "parent viewport bridge");
const loadingCode = loading.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
assert(!/screen\.availHeight/.test(loadingCode), "no screen.availHeight heuristic");
assert(!/computeOverlayBand/.test(loadingCode), "no computeOverlayBand heuristic");
assert(planner.includes("PortalLoading.withLoading"), "wired loading");
assert(indexHtml.includes("portal-height.js"), "portal height script loaded");

// Gallery
const filtered = filterShipGalleryMedia(
  [
    { id: "1", public_url: "https://x/a.jpg", title: "Ship exterior", media_type: "ship", is_active: true },
    { id: "2", public_url: "https://x/hero.jpg", title: "Hero", media_type: "ship", is_active: true },
    { id: "3", public_url: "https://x/logo.png", title: "Line logo", media_type: "ship", is_active: true, tags: ["logo"] }
  ],
  { heroUrl: "https://x/hero.jpg" }
);
assert(filtered.every(i => i.public_url !== "https://x/hero.jpg"), "hero excluded");
assert(filtered.every(i => !/logo/i.test(i.title || "")), "logo excluded");
assert(planner.includes("Explore your ship"), "gallery title");
assert(planner.includes("loading=\"lazy\""), "lazy load");
assert(planner.includes("ShipGallerySection.render"), "uses shared gallery renderer");
assert(!/list\.length\s*<\s*2\s*return\s*""/.test(planner), "single-image gallery no longer hidden");
assert(indexHtml.includes("ship-gallery-section.js"), "gallery helper script loaded");
assert(css.includes("dashboard-ship-gallery--single"), "single-image gallery css");

// Scrolling
assert(/overflow-y:\s*visible !important/.test(css), "nested scroll removed");
assert(/height:\s*auto !important/.test(css), "auto height modules");

// Countdown states
const before = CruiseDateState.getCruiseLifecycleState({
  departing_date: "2026-12-13",
  arriving_date: "2026-12-27",
  now: new Date(2026, 11, 12)
});
assert(before === "before_embarkation", "day before");
assert(
  CruiseDateState.getCruiseLifecycleState({
    departing_date: "2026-12-13",
    arriving_date: "2026-12-27",
    now: new Date(2026, 11, 13)
  }) === "embarkation_day",
  "sail day"
);
assert(
  CruiseDateState.getCruiseLifecycleState({
    departing_date: "2026-12-13",
    arriving_date: "2026-12-27",
    now: new Date(2026, 11, 20)
  }) === "during_cruise",
  "mid cruise"
);
assert(
  CruiseDateState.getCruiseLifecycleState({
    departing_date: "2026-12-13",
    arriving_date: "2026-12-27",
    now: new Date(2026, 11, 27)
  }) === "disembarked",
  "disembark day"
);
const derived = CruiseDateState.deriveReturnDate({
  departing_date: "2026-07-26",
  arriving_date: null,
  cruise_duration: 14
});
assert(derived.returnDate === "2026-08-09" && derived.derived === true, "derived return");
assert(
  CruiseDateState.getCruiseLifecycleState({
    departing_date: "2026-07-26",
    arriving_date: null,
    cruise_duration: 14,
    now: new Date(2026, 6, 27)
  }) === "during_cruise",
  "derived during cruise"
);
assert(
  CruiseDateState.buildCountdownPresentation("disembarked").mode === "hidden",
  "hidden after disembark"
);
assert(!/00 DAYS/.test(planner.match(/function renderDashboardCountdownPanel[\s\S]*?^}/m)?.[0] || ""), "no zero panel hardcode");

// Hero
assert(indexHtml.includes("cruise-date-state.js"), "date state loaded");
assert(/#cruise-planner-app\s*\{[\s\S]*max-width:\s*none/.test(css), "app allows full-bleed hero");
assert(/\.dashboard-hero\s*\{[\s\S]*width:\s*100%/.test(css), "hero full width");
assert(/\.dashboard-content-wrap/.test(css), "content wrap retained");

// Financial untouched wiring
assert(indexHtml.includes("booking-financials.js"), "financials still loaded");
assert(/renderSharedFinancialRows/.test(planner), "shared financial rows");

console.log("test-client-portal-experience: ok");
