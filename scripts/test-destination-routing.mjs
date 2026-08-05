/**
 * Destination routing — all Cruise Finder recommendations use the living destination page.
 *
 * Run: node scripts/test-destination-routing.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const finderJs = read("public-tools/cruise-finder/finder.js");
const destHtml = read("destination/index.html");
const toml = read("netlify.toml");
const publicJs = read("js/public-destination.js");

assert.ok(!finderJs.includes("LIVING_DESTINATION_SLUGS"), "no alaska-only routing whitelist");
assert.ok(!finderJs.includes("cruiseFinderDestinationUrl"), "legacy cruise-destination URL builder removed");
assert.match(finderJs, /\/destination\/\$\{encodeURIComponent\(slug\)\}/, "finder routes to living destination path");
assert.ok(!destHtml.includes("/cruise-destination"), "destination shell no longer redirects to old URL");
assert.match(destHtml, /location\.replace\([\s\S]*\/destination\/"/, "legacy query URLs canonicalise to /destination/{slug}");
assert.match(toml, /from = "\/cruise-destination"[\s\S]*?to = "\/destination\/index\.html"[\s\S]*?status = 301/, "301 from legacy cruise-destination");
assert.match(toml, /from = "\/destination-experience"[\s\S]*?to = "\/destination\/index\.html"[\s\S]*?status = 301/, "301 from prototype destination-experience");
assert.ok(!fs.existsSync(path.join(root, "public-tools/cruise-finder/destination.html")), "old destination shell deleted");
assert.ok(!fs.existsSync(path.join(root, "destination-experience.html")), "prototype page deleted");
assert.ok(!fs.existsSync(path.join(root, "js/destination-experience.js")), "old destination experience deleted");
assert.ok(fs.existsSync(path.join(root, "js/destination-experience-image-loader.js")), "shared image loader kept for featured cruises");
assert.match(publicJs, /function renderPage\(/, "living destination renderer remains");
assert.match(finderJs, /function destinationPageUrl/, "destinationPageUrl helper present");

console.log("test-destination-routing: all assertions passed");
