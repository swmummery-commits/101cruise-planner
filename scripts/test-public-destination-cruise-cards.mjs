/**
 * Public destination page — cruise card formatting and presentation rules.
 *
 * Run: node scripts/test-public-destination-cruise-cards.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const require = createRequire(import.meta.url);

const { formatPublicSailing, isDisplayableBrochureFare } = require("../netlify/functions/lib/cruise-discovery.js");
const { buildCruiseCatalog } = require("../netlify/functions/lib/destination-page.js");

const withDates = formatPublicSailing(
  {
    id: 1,
    departure_date: "2026-08-26",
    return_date: "2026-09-02",
    nights: 7,
    itinerary: "Juneau, Alaska",
    brochure_fare_display: "From USD $4,999 pp"
  },
  "Regent Seven Seas Cruises",
  "Seven Seas Explorer"
);

assert.match(withDates.scheduleLabel, /26 Aug 2026 – 2 Sep(?:t)? 2026 · 7 nights/);
assert.equal(withDates.hasDate, true);
assert.equal(withDates.brochureFare, "From USD $4,999 pp");
assert.equal(withDates.hasBrochureFare, true);

const noFare = formatPublicSailing(
  {
    id: 2,
    departure_date: "2026-08-26",
    nights: 7,
    itinerary: "Anchorage",
    brochure_fare_display: "See official brochure fare"
  },
  "Line",
  "Ship"
);

assert.equal(noFare.brochureFare, null);
assert.equal(noFare.hasBrochureFare, false);
assert.equal(noFare.scheduleLabel, "Departs 26 Aug 2026 · 7 nights");
assert.ok(!String(noFare.brochureFare || "").includes("See official"), "no brochure placeholder");
assert.equal(isDisplayableBrochureFare("See official brochure fare"), false);
assert.equal(isDisplayableBrochureFare("From USD $4,999 pp"), true);
assert.equal(isDisplayableBrochureFare("Price on request"), false);

const noDate = formatPublicSailing({ id: 3, nights: 7, itinerary: "Unknown" }, "Line", "Ship");
assert.equal(noDate.hasDate, false);
assert.equal(noDate.scheduleLabel, "7 nights");

const catalog = buildCruiseCatalog([
  { id: 1, departure_date: "2026-09-01", nights: 7, cruise_line_id: 1, ship_id: 1 },
  { id: 2, departure_date: "2026-08-26", nights: 5, cruise_line_id: 1, ship_id: 2 },
  { id: 3, nights: 5, cruise_line_id: 1, ship_id: 3 }
]);
assert.equal(catalog.totalCount, 2, "sailings without departure dates are excluded");
assert.deepEqual(
  catalog.sailings.map((s) => s.departureDateIso),
  ["2026-08-26", "2026-09-01"],
  "sailings sorted by departure date ascending"
);

const publicJs = read("js/public-destination.js");
const publicCss = read("css/public-destination.css");

assert.ok(!publicJs.includes("See official brochure fare"), "placeholder removed from renderer");
assert.ok(!publicJs.includes("Official Brochure Fare"), "brochure label removed when no price");
assert.ok(publicJs.includes("dest-cruise-date"), "prominent date line in cards");
assert.ok(!publicJs.includes("dest-cruise-section-cta"), "no duplicate cruises section contact button");
assert.match(publicCss, /\.dest-cruise-itin-value[\s\S]*?font-weight:\s*400/, "itinerary text not medium weight");
assert.match(publicCss, /\.dest-snap-value[\s\S]*?font-weight:\s*400/, "snapshot values stay regular weight");
assert.ok(publicJs.includes("dest-gtk-list"), "good to know uses fact list");
assert.ok(!publicJs.includes("dest-gtk-strip"), "old gtk strip removed");
assert.ok(!publicCss.includes(".dest-gtk-cell"), "old gtk cells removed");
assert.match(publicCss, /\.dest-cruise-list[\s\S]*?grid-template-columns:\s*repeat\(3/, "three cruise columns on desktop");
assert.match(publicCss, /@media \(max-width: 1080px\)[\s\S]*?repeat\(2/, "two columns on medium screens");
assert.match(publicCss, /@media \(max-width: 640px\)[\s\S]*?grid-template-columns:\s*1fr/, "single column on mobile");
assert.match(
  publicJs,
  /renderPorts\(dest\)[\s\S]*renderLines\(dest\)[\s\S]*renderGoodToKnow\(dest\)[\s\S]*renderFaqs\(dest\)[\s\S]*renderCruises\(dest/,
  "cruises section comes after destination info"
);

console.log("test-public-destination-cruise-cards: all assertions passed");
