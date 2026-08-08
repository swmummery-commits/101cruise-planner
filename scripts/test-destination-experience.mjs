/**
 * Destination Experience V4 — focused tests (HOLD DEPLOY prototype).
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

loadScript("public-tools/cruise-finder/destinations.js", sandbox);
loadScript("public-tools/cruise-finder/destination-content.js", sandbox);
loadScript("public-tools/cruise-finder/approved-cruise-lines.js", sandbox);
loadScript("public-tools/cruise-finder/destination-images.js", sandbox);
loadScript("js/destination-experience-data.js", sandbox);
loadScript("js/destination-experience-media.js", sandbox);
loadScript("js/destination-experience-image-loader.js", sandbox);
loadScript("js/destination-experience-components.js", sandbox);

const Data = sandbox.DestinationExperienceData;
const Media = sandbox.DestinationExperienceMedia;
const ImageLoader = sandbox.DestinationExperienceImageLoader;
const Components = sandbox.DestinationExperienceComponents;
assert(Data && Components && Media && ImageLoader, "globals exported");

const mediaSnapshot = JSON.parse(read("data/prototype/caribbean-media-snapshot.json"));
const linesSnapshot = JSON.parse(read("data/prototype/caribbean-cruise-lines-snapshot.json"));

const cfOptions = {
  catalogue: sandbox.CruiseFinderDestinations,
  content: sandbox.CruiseFinderDestinationContent,
  images: sandbox.CruiseFinderDestinationImages,
  pickImage: sandbox.CruiseFinderPickDestinationImage,
  filterLines: sandbox.CruiseFinderFilterCruiseLines
};

function buildCaribbean() {
  return Data.fromCruiseFinder("caribbean", cfOptions);
}

function buildCaribbeanWithMedia() {
  const base = buildCaribbean();
  const assigned = Media.assignDestinationImages("caribbean", mediaSnapshot.items, base.hero);
  return Data.applyMediaAssignments(base, assigned);
}

function withTiming(query) {
  const model = buildCaribbeanWithMedia();
  return Data.applyTimingContext(model, Data.parseTimingFromSearch(new URLSearchParams(query)));
}

const caribbeanPool = Media.filterCaribbeanMedia(mediaSnapshot.items);
assert.equal(caribbeanPool.length, 5, "five explicit Caribbean media rows");
assert.ok(
  caribbeanPool.every((row) => row.destination_name === "Caribbean" && row.media_type === "destination"),
  "only explicit Caribbean destination media eligible"
);
assert.ok(
  !Media.isExplicitCaribbeanAssociation({
    destination_name: "Caribbean",
    media_type: "hero",
    is_active: true
  }),
  "non-destination media rejected"
);
assert.ok(
  !Media.isExplicitCaribbeanAssociation({
    destination_name: "Mediterranean",
    media_type: "destination",
    is_active: true
  }),
  "non-Caribbean destination rejected"
);

const assignedA = Media.assignDestinationImages("caribbean", mediaSnapshot.items, buildCaribbean().hero);
const assignedB = Media.assignDestinationImages("caribbean", mediaSnapshot.items, buildCaribbean().hero);
assert.deepEqual(
  Object.keys(assignedA.assignments).map((role) => assignedA.assignments[role].url),
  Object.keys(assignedB.assignments).map((role) => assignedB.assignments[role].url),
  "image assignment is deterministic"
);

const mediaModel = buildCaribbeanWithMedia();
const imageUrls = [
  mediaModel.hero?.url,
  ...mediaModel.reasons.map((r) => r.image?.url),
  mediaModel.adviceImage?.url,
  mediaModel.ctaImage?.url
].filter(Boolean);
const distinct = new Set(imageUrls);
assert.equal(distinct.size, 5, "five distinct Caribbean images across page slots");
assert.ok(
  imageUrls.every((url) => /destinations\/caribbean\//.test(url)),
  "assigned images use Caribbean Media Library paths"
);

const fallbackAssigned = Media.assignDestinationImages("caribbean", [], buildCaribbean().hero);
const fallbackModel = Data.applyMediaAssignments(buildCaribbean(), fallbackAssigned);
assert.ok(/caribbean-hero\.png/.test(fallbackModel.hero.url), "fallback uses Cruise Finder hero when media unavailable");

const caribbean = withTiming("");
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
assert.ok(caribbean.hero && /destinations\/caribbean\//.test(caribbean.hero.url), "hero uses Caribbean media");

const withLogos = Data.applyCruiseLineLogos(buildCaribbeanWithMedia(), linesSnapshot.cruise_lines);
assert.equal(withLogos.cruiseLines.find((l) => l.name === "Royal Caribbean")?.logo?.includes("Royal-Caribbean"), true);
assert.equal(withLogos.cruiseLines.find((l) => l.name === "Celebrity")?.logo?.includes("Celebrity"), true);
assert.equal(withLogos.cruiseLines.find((l) => l.name === "Princess")?.logo?.includes("Princess"), true);
assert.equal(withLogos.cruiseLines.find((l) => l.name === "MSC")?.logo?.includes("MSC"), true);
assert.equal(withLogos.cruiseLines.find((l) => l.name === "Norwegian")?.logo?.includes("NCL"), true);

const logoHtml = Components.renderPage(withLogos);
withLogos.cruiseLines.forEach((line) => {
  const names = logoHtml.match(new RegExp(`<h3 class="dx-line-name">${line.name}</h3>`, "g")) || [];
  assert.equal(names.length, 1, `${line.name} appears once beneath logo card`);
  if (line.logo) {
    assert.match(logoHtml, new RegExp(escRegex(line.logo)), `${line.name} logo renders`);
    assert.match(logoHtml, /dx-line-logo-panel/, `${line.name} logo panel present`);
  }
});

const fallbackLineModel = Data.applyCruiseLineLogos(
  { cruiseLines: [{ name: "Unknown Line", logo: null, note: "" }] },
  linesSnapshot.cruise_lines
);
const fallbackLineHtml = Components.renderPage({
  slug: "x",
  name: "X",
  cruiseLines: fallbackLineModel.cruiseLines,
  cta: { headline: "Go", primaryHref: "/x", primaryLabel: "Go" }
});
assert.match(fallbackLineHtml, /dx-line-fallback/, "logo text fallback renders");

function escRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

assert.equal(caribbean.seasonTimeline.mode, "general");
assert.equal(caribbean.seasonTimeline.allowManualSelection, true);
assert.match(caribbean.seasonTimeline.heading, /When should you cruise the Caribbean/i);

const monthModel = withTiming("timing=month&month=2");
assert.equal(monthModel.seasonTimeline.highlightedMonths.length, 1);
assert.equal(monthModel.seasonTimeline.highlightedMonths[0], 2);
assert.equal(monthModel.seasonTimeline.activeMonth, 2);
assert.equal(monthModel.seasonTimeline.verdict.label, "EXCELLENT TIMING");
assert.equal(monthModel.seasonTimeline.allowManualSelection, false);

const rangeModel = withTiming("timing=range&startMonth=1&endMonth=3");
assert.equal(rangeModel.seasonTimeline.highlightedMonths.join(","), "1,2,3");
assert.equal(rangeModel.seasonTimeline.verdict.label, "EXCELLENT TIMING");

const flexModel = withTiming("timing=flexible");
assert.equal(flexModel.seasonTimeline.mode, "flexible");
assert.equal(flexModel.seasonTimeline.verdict.label, "FLEXIBLE TIMING");
assert.equal(flexModel.seasonTimeline.allowManualSelection, false);

const cruiseModel = withTiming("timing=cruise&start=2026-11-17&end=2026-11-27");
assert.equal(cruiseModel.seasonTimeline.mode, "cruise");
assert.equal(cruiseModel.seasonTimeline.activeMonth, 11);
assert.equal(cruiseModel.seasonTimeline.highlightedMonths.join(","), "11");
assert.equal(cruiseModel.seasonTimeline.verdict.label, "SHOULDER-SEASON OPTION");
assert.match(cruiseModel.seasonTimeline.panel.title, /You're sailing in November/i);
assert.match(cruiseModel.seasonTimeline.panel.datesLine, /17–27 November 2026/);
assert.match(cruiseModel.seasonTimeline.panel.body, /shoulder month/i);

const crossMonth = withTiming("timing=cruise&start=2026-10-28&end=2026-11-10");
assert.equal(crossMonth.seasonTimeline.highlightedMonths.join(","), "10,11");
assert.equal(crossMonth.seasonTimeline.verdict.label, "MORE VARIABLE CONDITIONS");

const html = Components.renderPage(caribbean);
assert(!/hard-?coded caribbean layout/i.test(html));
assert(/data-dx-slug="caribbean"/.test(html), "slug attribute");
assert(/dx-hero/.test(html) && /dx-snapshot/.test(html), "core sections");
assert(/dx-month-chip/.test(html), "month chips");
assert(/Find current cruises/i.test(html), "CTA label");
assert(/cruise-destination\?destination=caribbean/.test(html), "CTA routes to CF destination search");
assert(/dx-timing-verdict/.test(html), "timing verdict rendered");
assert.equal((html.match(/<article class="dx-port-card/g) || []).length, 6, "all six ports rendered");
assert.equal(html.includes("data-dx-ports-prev"), false, "no port carousel prev");
assert.equal(html.includes("data-dx-ports-dots"), false, "no port pagination");
assert.match(html, /data-dx-dest-image="advice"/, "seasonal advice image slot");
assert.match(html, /data-dx-dest-image="cta"/, "cta image slot");
assert.match(html, /data-dx-dest-image="reason-1"/, "reason image slots");

const cruiseHtml = Components.renderPage(cruiseModel);
assert(/SHOULDER-SEASON OPTION/.test(cruiseHtml));
assert(/is-readonly/.test(cruiseHtml));
assert(/17–27 November 2026/.test(cruiseHtml));
assert(/You're sailing in November/.test(cruiseHtml));
assert(!/data-dx-section="cta" data-dx-reveal/.test(cruiseHtml), "CTA stays visible without reveal gate");

const japan = Data.applyTimingContext(
  Data.fromCruiseFinder("japan", cfOptions),
  Data.parseTimingFromSearch("")
);
assert(japan && japan.slug === "japan", "japan builds");
const japanHtml = Components.renderPage(japan);
assert(/data-dx-slug="japan"/.test(japanHtml));
assert(!/Caribbean/.test(japanHtml), "japan page does not inject Caribbean copy");

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

const destHtml = read("destination/index.html");
assert(/public-destination\.js/.test(destHtml), "production destination page intact");
assert(!/destination-experience\.js/.test(destHtml), "prototype not wired into production destination");

const cfDest = read("public-tools/cruise-finder/destination.html");
assert(/destination-experience-data\.js/.test(cfDest), "production CF destination uses shared experience modules");
assert(/destination-experience\.css/.test(cfDest), "production CF destination uses shared experience styles");

const appSrc = read("js/destination-experience.js");
assert(/prefers-reduced-motion/.test(appSrc), "reduced-motion handled");
assert(/ArrowRight/.test(appSrc), "keyboard month selection");
assert(/is-readonly/.test(appSrc), "manual month selection gated");
assert(/applyTimingContext/.test(appSrc), "timing context applied at boot");
assert(/loadDestinationMedia/.test(appSrc), "media loaded at boot");
assert(/resolveDestinationImages/.test(appSrc), "destination images preloaded before render");
assert(/data-dx-media-ready/.test(appSrc), "media ready gate exposed");
assert(/cruise_lines/.test(appSrc), "public cruise lines field handled");
assert(!/bindPortsCarousel|data-dx-ports-prev/.test(appSrc), "port carousel removed from app");
assert(!/\.insert\(|supabaseClient\.from\(/.test(appSrc), "no production writes in app");
assert(!/\.insert\(|supabaseClient\.from\(/.test(read("js/destination-experience-data.js")), "no writes in data");
assert(!/\.insert\(|supabaseClient\.from\(/.test(read("js/destination-experience-media.js")), "no writes in media");
assert(!/\.insert\(|supabaseClient\.from\(/.test(read("js/destination-experience-image-loader.js")), "no writes in loader");

const css = read("css/destination-experience.css");
assert(/prefers-reduced-motion/.test(css), "reduced-motion CSS");
assert(/max-width: 640px/.test(css), "mobile layout");
assert(/max-height:\s*80svh/.test(css), "mobile hero max height");
assert(/clamp\(360px,\s*72svh,\s*620px\)/.test(css), "mobile hero clamp");
assert(/repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(css), "mobile snapshot minmax grid");
assert.match(css, /\.dx-ports-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s, "desktop ports 3 columns");
assert.match(css, /@media \(max-width: 980px\)[\s\S]*\.dx-ports-grid[\s\S]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/, "tablet ports 2 columns");
assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.dx-ports-grid[\s\S]*grid-template-columns:\s*1fr/, "mobile ports 1 column");
assert.match(css, /\.dx-ports-section\s*\{[^}]*background:\s*#8dd9bf/i, "Popular Ports background is #8DD9BF");
assert.match(css, /\.dx-port-card--name-only[\s\S]*background:\s*rgba\(255,\s*255,\s*255,\s*0\.92\)/, "name-only port cards stay pale");
assert.match(css, /\.dx-port-card--photo[\s\S]*background:\s*var\(--dx-navy\)/, "photo port cards stay dark");
assert.match(css, /\.dx-line-logo-panel/, "cruise-line logo contrast panel");
assert(!/grid-auto-columns:\s*minmax\(240px/.test(css), "port carousel track removed");
assert(!/data-dx-section="cta" data-dx-reveal/.test(read("js/destination-experience-components.js")), "CTA not reveal gated");

const page = read("destination-experience.html");
assert(/\?slug=/.test(page) || /DestinationExperienceApp\.boot/.test(page), "prototype boots");
assert(/destination-experience-media\.js/.test(page), "media module wired");
assert(/destination-experience-image-loader\.js/.test(page), "image loader wired");
assert(/robots" content="noindex/.test(page), "prototype noindex");

const componentSrc = read("js/destination-experience-components.js");
assert.match(componentSrc, /data-dx-dest-image/, "destination image slots in markup");
assert.match(componentSrc, /dx-port-card--name-only/, "name-only port cards when no image");
assert.match(componentSrc, /dx-port-card--photo/, "port photo cards when image exists");
assert.doesNotMatch(componentSrc, /dx-port-monogram/, "monogram fallback removed from popular ports");
assert.match(componentSrc, /dx-line-name/, "cruise-line names beneath logos");

const loaderSrc = read("js/destination-experience-image-loader.js");
assert.match(loaderSrc, /resolveDestinationImages/, "shared destination image loader");
assert.match(loaderSrc, /preloadImage/, "image preload helper");
assert.match(loaderSrc, /waitForRenderedImages/, "rendered image readiness wait");

const toml = read("netlify.toml");
assert(/destination-experience/.test(toml), "prototype rewrite present");
assert(/\/destination\/\*[\s\S]*destination\/index\.html/.test(toml), "production destination rewrite preserved");

console.log("test-destination-experience: ok");
