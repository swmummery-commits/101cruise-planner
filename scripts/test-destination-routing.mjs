/**
 * Destination routing — Cruise Finder uses Destination Experience;
 * Alaska whitelist uses Living Destination; both stacks coexist.
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

assert.match(finderJs, /LIVING_DESTINATION_SLUGS/, "alaska whitelist present");
assert.match(finderJs, /function cruiseFinderDestinationUrl/, "cruise-destination URL builder present");
assert.match(finderJs, /\/cruise-destination\?/, "finder routes most destinations to cruise-destination");
assert.match(finderJs, /\/destination\/\$\{encodeURIComponent\(slug\)\}/, "alaska routes to living destination path");
assert.match(destHtml, /location\.replace\("\/cruise-destination\?"/, "non-alaska living slugs redirect to cruise-destination");
assert.match(destHtml, /living\[slug\]/, "alaska whitelist in living destination shell");
assert.match(
  toml,
  /from = "\/cruise-destination"[\s\S]*?to = "\/public-tools\/cruise-finder\/destination\.html"[\s\S]*?status = 200/,
  "cruise-destination serves destination experience shell"
);
assert.match(
  toml,
  /from = "\/destination-experience"[\s\S]*?to = "\/destination-experience\.html"[\s\S]*?status = 200/,
  "destination-experience prototype route restored"
);
assert.ok(fs.existsSync(path.join(root, "public-tools/cruise-finder/destination.html")), "cruise-finder destination shell restored");
assert.ok(fs.existsSync(path.join(root, "destination-experience.html")), "prototype page restored");
assert.ok(fs.existsSync(path.join(root, "js/destination-experience.js")), "destination experience restored");
assert.ok(fs.existsSync(path.join(root, "js/destination-experience-image-loader.js")), "shared image loader kept for featured cruises");
assert.match(publicJs, /function renderPage\(/, "living destination renderer remains");
assert.match(finderJs, /function destinationPageUrl/, "destinationPageUrl helper present");

console.log("test-destination-routing: all assertions passed");
