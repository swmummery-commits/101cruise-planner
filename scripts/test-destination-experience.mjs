/**
 * Destination Experience V1 — focused tests (HOLD DEPLOY prototype).
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
  console
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;

loadScript("public-tools/cruise-finder/destinations.js", sandbox);
loadScript("public-tools/cruise-finder/destination-content.js", sandbox);
loadScript("public-tools/cruise-finder/approved-cruise-lines.js", sandbox);
loadScript("public-tools/cruise-finder/destination-images.js", sandbox);
loadScript("js/destination-experience-data.js", sandbox);
loadScript("js/destination-experience-components.js", sandbox);

const Data = sandbox.DestinationExperienceData;
const Components = sandbox.DestinationExperienceComponents;
assert(Data && Components, "globals exported");

const caribbean = Data.fromCruiseFinder("caribbean", {
  catalogue: sandbox.CruiseFinderDestinations,
  content: sandbox.CruiseFinderDestinationContent,
  images: sandbox.CruiseFinderDestinationImages,
  pickImage: sandbox.CruiseFinderPickDestinationImage,
  filterLines: sandbox.CruiseFinderFilterCruiseLines
});
assert(caribbean, "caribbean model builds");
assert.equal(caribbean.slug, "caribbean");
assert.equal(caribbean.name, "Caribbean");
assert.match(caribbean.tagline, /Turquoise/i);
assert.ok(caribbean.snapshot.length >= 4, "snapshot facts present");
assert.equal(caribbean.reasons.length, 3, "three reasons");
assert.ok(caribbean.months.length === 12, "12 months");
assert.equal(Data.monthState(12, [12, 1, 2, 3, 4], [5, 11]), "best");
assert.equal(Data.monthState(5, [12, 1, 2, 3, 4], [5, 11]), "shoulder");
assert.equal(Data.monthState(8, [12, 1, 2, 3, 4], [5, 11]), "neutral");
assert.ok(caribbean.ports.some((p) => p.name === "St Thomas"));
assert.ok(caribbean.cruiseLines.every((l) => l.name !== "P&O Australia"));
assert.ok(caribbean.hero && /caribbean-hero\.png/.test(caribbean.hero.url), "exact CF hero asset");

const html = Components.renderPage(caribbean);
assert(!/hard-?coded caribbean layout/i.test(html));
assert(/data-dx-slug="caribbean"/.test(html), "slug attribute");
assert(/dx-hero/.test(html) && /dx-snapshot/.test(html), "core sections");
assert(/dx-month-chip/.test(html), "month chips");
assert(/Find current cruises/i.test(html), "CTA label");
assert(/cruise-destination\?destination=caribbean/.test(html), "CTA routes to CF destination search");

// Generic destination (not Caribbean) still renders — no Caribbean layout coupling
const japan = Data.fromCruiseFinder("japan", {
  catalogue: sandbox.CruiseFinderDestinations,
  content: sandbox.CruiseFinderDestinationContent,
  images: sandbox.CruiseFinderDestinationImages,
  pickImage: sandbox.CruiseFinderPickDestinationImage,
  filterLines: sandbox.CruiseFinderFilterCruiseLines
});
assert(japan && japan.slug === "japan", "japan builds");
const japanHtml = Components.renderPage(japan);
assert(/data-dx-slug="japan"/.test(japanHtml));
assert(!/Caribbean/.test(japanHtml), "japan page does not inject Caribbean copy");

// Absent fields hide safely
const sparse = {
  slug: "sparse",
  name: "Sparse",
  eyebrow: "",
  tagline: "",
  hero: null,
  heroStyles: [],
  snapshot: [],
  reasons: [],
  styles: [],
  months: [],
  ports: [],
  cruiseLines: [],
  seasonSummary: {},
  cta: { headline: "Go", primaryHref: "/x", primaryLabel: "Go", secondaryHref: "", secondaryLabel: "" }
};
const sparseHtml = Components.renderPage(sparse);
assert(/dx-hero/.test(sparseHtml), "hero shell remains");
assert(!/dx-snapshot-card/.test(sparseHtml), "empty snapshot omitted");
assert(!/dx-reason-card/.test(sparseHtml), "empty reasons omitted");
assert(!/dx-port-card/.test(sparseHtml), "empty ports omitted");
assert(!/dx-line-card/.test(sparseHtml), "empty lines omitted");

// Production destination page unchanged
const destHtml = read("destination/index.html");
assert(/public-destination\.js/.test(destHtml), "production destination page intact");
assert(!/destination-experience\.js/.test(destHtml), "prototype not wired into production destination");

const cfDest = read("public-tools/cruise-finder/destination.html");
assert(!/destination-experience/.test(cfDest), "CF destination page untouched");

const appSrc = read("js/destination-experience.js");
assert(/prefers-reduced-motion/.test(appSrc), "reduced-motion handled");
assert(/ArrowRight/.test(appSrc), "keyboard month selection");
assert(/data-dx-ports-prev/.test(appSrc) || /ports-prev/.test(appSrc), "port carousel controls");
assert(!/\.insert\(|supabaseClient\.from\(/.test(appSrc), "no production writes in app");
assert(!/\.insert\(|supabaseClient\.from\(/.test(read("js/destination-experience-data.js")), "no writes in data");

const css = read("css/destination-experience.css");
assert(/prefers-reduced-motion/.test(css), "reduced-motion CSS");
assert(/@media \(max-width: 640px\)/.test(css), "mobile layout");
assert(/#8dd9bf/i.test(css), "brand green");

const page = read("destination-experience.html");
assert(/\?slug=/.test(page) || /DestinationExperienceApp\.boot/.test(page), "prototype boots");
assert(/robots" content="noindex/.test(page), "prototype noindex");

const toml = read("netlify.toml");
assert(/destination-experience/.test(toml), "prototype rewrite present");
assert(/\/destination\/\*[\s\S]*destination\/index\.html/.test(toml), "production destination rewrite preserved");

console.log("test-destination-experience: ok");
