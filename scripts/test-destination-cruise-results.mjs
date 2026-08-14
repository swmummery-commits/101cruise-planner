/**
 * Destination Experience — Find Current Cruises grid + chronological ordering.
 *
 * Run: node scripts/test-destination-cruise-results.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const { categorizeResultsByDeparture } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-departure-match.js")
);

const css = read("public-tools/cruise-finder/destination.css");
assert.match(css, /\.cf-sail-list[\s\S]*display:\s*grid/, "cruise results use grid");
assert.match(css, /repeat\(2,\s*minmax\(0,\s*1fr\)\)/, "two-column breakpoint");
assert.match(css, /repeat\(3,\s*minmax\(0,\s*1fr\)\)/, "three-column breakpoint");

const searchSrc = read("netlify/functions/search-current-cruises.js");
assert.match(searchSrc, /departureDateIso:\s*row\.departure_date/, "discovery rows expose ISO embark date");

const sailings = [
  { cruiseLine: "Princess", ship: "Sky", departureDate: "12 Nov 2026", departureDateIso: "2026-11-12" },
  { cruiseLine: "Celebrity", ship: "Edge", departureDate: "10 Sep 2026", departureDateIso: "2026-09-10" },
  { cruiseLine: "MSC", ship: "Seascape", departureDate: "4 Oct 2026", departureDateIso: "2026-10-04" },
  { cruiseLine: "Norwegian", ship: "Viva", departureDate: "18 Sep 2026", departureDateIso: "2026-09-18" }
];

const buckets = categorizeResultsByDeparture(sailings, "anywhere");
const ordered = buckets.results.map((row) => row.departureDate);
assert.deepEqual(ordered, ["10 Sep 2026", "18 Sep 2026", "4 Oct 2026", "12 Nov 2026"], "chronological ASC");

const destJs = read("public-tools/cruise-finder/destination.js");
assert.match(destJs, /function portStopsHtml/, "client renders structured port stop list");
assert.match(destJs, /cf-sail-port-list/, "port list markup present");
assert.match(destJs, /data-port-toggle/, "port list expand control present");

const { parseItineraryStops, itineraryDisplayTitle } = require(
  path.join(root, "netlify/functions/search-current-cruises.js")
);
const seabournItinerary =
  "Castro, Isla Chiloe, Chile, The Seabourn Antarctic Experience (Day 1), Puerto Montt, Chile, Days At Sea, Ushuaia, Argentina, Antarctic Experience";
const seabournStops = parseItineraryStops(seabournItinerary, []);
assert(seabournStops.length >= 5, "comma itinerary splits into readable stops");
assert(
  seabournStops.some((stop) => /Ushuaia/i.test(stop.label)),
  "parsed stops include Ushuaia"
);
assert(
  itineraryDisplayTitle(
    {
      raw_extract: { title: "28-Day Chilean Fjords, Antarctica & Falklands" },
      itinerary: seabournItinerary
    },
    "Quest",
    "Antarctica"
  ) === "28-Day Chilean Fjords, Antarctica & Falklands",
  "display title prefers official voyage title"
);

assert.match(destJs, /function sortSailingsChronologically/, "client re-sorts before render");

console.log("First cruises (chronological):");
for (const row of buckets.results.slice(0, 10)) {
  console.log(`- ${row.cruiseLine} | ${row.ship} | ${row.departureDate}`);
}

console.log("test-destination-cruise-results: ok");
