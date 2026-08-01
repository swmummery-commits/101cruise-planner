#!/usr/bin/env node
/**
 * Ship feature icons + structured facilities normalisation tests.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function loadModule(rel, extraSandbox) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    ...(extraSandbox || {})
  };
  sandbox.exports = sandbox.module.exports;
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(read(rel), sandbox, { filename: path.basename(rel) });
  return sandbox.module.exports;
}

const Icons = loadModule("js/ci-ship-feature-icons.js");
const CiFac = loadModule("js/ci-ship-facilities.js", { CiShipFeatureIcons: Icons });
const Replace = loadModule("js/ci-ship-class-facilities-replace.js", {
  CiShipFeatureIcons: Icons,
  CiShipFacilities: CiFac
});
const plannerJs = read("js/planner.js");
const adminJs = read("js/admin.js");

// Icon resolution
assert.equal(Icons.resolveShipFeatureIconKey("Main Pool"), "pool");
assert.equal(Icons.resolveShipFeatureIconKey("The Retreat"), "crown");
assert.equal(Icons.resolveShipFeatureIconKey("Fitness Center"), "fitness");
assert.equal(Icons.resolveShipFeatureIconKey("Unknown Widget", "crown"), "crown");
assert.equal(Icons.isKnownIconKey("not-real"), false);
assert.equal(Icons.resolveShipFeatureIconKey("Unknown Widget", "not-real"), Icons.FALLBACK_KEY);
assert.ok(Icons.renderIconSvg("pool").includes("<svg"));
assert.ok(Icons.renderFeatureIconHtml("spa").includes("ship-feature-icon"));

// Legacy string arrays
const legacyEa = CiFac.normalizeExclusiveAreasForDisplay(["Suite Deck", "Premium Lounge"]);
assert.equal(legacyEa.length, 2);
assert.equal(legacyEa[0].name, "Suite Deck");
assert.equal(legacyEa[0].description, "");
assert.equal(legacyEa[0].icon_key, "crown");

const legacySf = CiFac.normalizeSpecialtyFeaturesForDisplay(["Main Pool", "Fitness Center"]);
assert.equal(legacySf[1].icon_key, "fitness");

// Structured objects
const structured = CiFac.normalizeShipFeatureList([
  {
    name: "The Retreat",
    description: "Private suite enclave, with lounge, sundeck, and Luminae.",
    icon_key: "crown"
  }
]);
assert.equal(structured[0].description, "Private suite enclave, with lounge, sundeck, and Luminae.");
assert.match(structured[0].description, /, and Luminae\./);

// Mixed arrays
const mixed = CiFac.normalizeShipFeatureList([
  "Main Pool",
  { name: "Sky Zone", description: "Indoor sports, games, and more.", icon_key: "sports-court" }
]);
assert.equal(mixed.length, 2);
assert.equal(mixed[1].name, "Sky Zone");

// Comma-safe admin serialize/reload
const commaRows = CiFac.loadSpecialtyFeaturesForAdmin([
  { label: "Fitness Center, with classes" }
]);
assert.equal(commaRows[0].name, "Fitness Center, with classes");
const savedComma = CiFac.serializeSpecialtyFeaturesFromAdmin(commaRows);
assert.equal(savedComma[0].name, "Fitness Center, with classes");
assert.ok(!Array.isArray(savedComma[0]));

// Legacy sentence-style string — render-time split only (Admin load unchanged)
const apexSentence =
  "The Retreat, a ship-within-a-ship concept for suite guests featuring a private sundeck, dedicated lounge, and the exclusive restaurant Luminae.";
const apexDisplay = CiFac.normalizeExclusiveAreasForDisplay([apexSentence])[0];
assert.equal(apexDisplay.name, "The Retreat");
assert.match(apexDisplay.description, /^A ship-within-a-ship concept/);
assert.match(apexDisplay.description, /, and the exclusive restaurant Luminae\./);
assert.equal(apexDisplay.icon_key, "crown");

const apexLoaded = CiFac.loadExclusiveAreasForAdmin([apexSentence]);
assert.equal(apexLoaded.length, 1);
assert.equal(apexLoaded[0].name, apexSentence);
assert.equal(apexLoaded[0].description, "");

// Structured object remains authoritative at display
const structuredDisplay = CiFac.normalizeExclusiveAreasForDisplay([
  { name: "The Retreat", description: "Curated copy from Admin.", icon_key: "crown" }
])[0];
assert.equal(structuredDisplay.name, "The Retreat");
assert.equal(structuredDisplay.description, "Curated copy from Admin.");

// Legacy simple name — no split
const simpleName = CiFac.normalizeExclusiveAreasForDisplay(["Suite Deck"])[0];
assert.equal(simpleName.name, "Suite Deck");
assert.equal(simpleName.description, "");

// Comma in name without prose remainder — keep intact
const commaName = CiFac.normalizeExclusiveAreasForDisplay(["Fitness Center, with classes"])[0];
assert.equal(commaName.name, "Fitness Center, with classes");
assert.equal(commaName.description, "");

// Legacy hyphen strings split on Admin load
const hyphenAdmin = CiFac.loadSpecialtyFeaturesForAdmin([
  "The Solarium - Features a pool, hot tubs, and padded loungers."
]);
assert.equal(hyphenAdmin[0].name, "The Solarium");
assert.match(hyphenAdmin[0].description, /hot tubs/);

// Structured multi-comma description unchanged
const multiComma = CiFac.normalizeSpecialtyFeaturesForDisplay([
  {
    name: "Sky Zone",
    description: "Indoor sports, games, fitness, and more.",
    icon_key: "sports-court"
  }
])[0];
assert.equal(multiComma.description, "Indoor sports, games, fitness, and more.");

// Customer icon markup — standalone icons, no boxed holder
const plannerCss = read("css/planner.css");
assert.doesNotMatch(plannerCss, /\.ship-feature-icon-holder/);
assert.match(plannerCss, /\.ship-feature-icon\b/);
assert.doesNotMatch(plannerCss, /ship-feature-icon-holder[\s\S]*background:/);
assert.match(plannerJs, /renderFeatureIconHtml\(iconKey, "ship-feature-icon"\)/);
assert.match(plannerCss, /grid-template-columns:\s*26px minmax\(0, 1fr\)/);

// Empty / null
assert.equal(CiFac.normalizeShipFeatureList(null).length, 0);
assert.equal(CiFac.normalizeShipFeatureList([]).length, 0);
assert.equal(CiFac.normalizeExclusiveAreasForDisplay(undefined).length, 0);

// Canonical comparison includes icon + description
const left = [{ name: "Main Pool", description: "Central pool.", icon_key: "pool" }];
const right = [{ name: "Main Pool", description: "Central pool.", icon_key: "pool" }];
assert.equal(CiFac.shipFeatureListsEqual(left, right), true);
assert.equal(CiFac.shipFeatureListsEqual(left, [{ name: "Main Pool", description: "Other.", icon_key: "pool" }]), false);

// Replace/compare uses structured canonical values
const comparison = Replace.compareShipFacilitiesToTemplate(
  {
    exclusive_areas: ["Suite Deck"],
    specialty_features: [{ name: "Main Pool", icon_key: "pool" }],
    spa: true
  },
  {
    exclusive_areas: [{ name: "Suite Deck", icon_key: "crown" }],
    specialty_features: [{ name: "Main Pool", icon_key: "pool" }]
  }
);
assert.equal(comparison.eaMatches, true);
assert.equal(comparison.sfMatches, true);

const applied = Replace.applyClassTemplateToFacilities(
  { exclusive_areas: ["Old"], specialty_features: ["Old SF"], spa: true },
  { exclusive_areas: [{ name: "New Area", icon_key: "lounge" }], specialty_features: [] }
);
assert.equal(applied.facilities.spa, true);
assert.equal(applied.facilities.exclusive_areas[0].name, "New Area");
assert.equal(applied.facilities.specialty_features.length, 0);

// Customer + admin wiring
assert.match(plannerJs, /renderShipFeatureExperiences/);
assert.match(plannerJs, /renderShipDeckPlansSubsection/);
assert.match(plannerJs, /ship-feature-list/);
assert.match(plannerJs, /ship-feature-column--exclusive/);
assert.match(plannerJs, /ship-deck-subsection/);
assert.equal(
  (plannerJs.match(/function renderShipDeckPlansSubsection/g) || []).length,
  1,
  "single deck plans renderer"
);
assert.doesNotMatch(
  plannerJs,
  /renderShipFeatureExperiences[\s\S]*?<section class="ship-section-card ship-deck-card/,
  "no separate full-width deck plans section"
);
assert.match(plannerCss, /grid-template-areas:[\s\S]*"exclusive divider specialty"/);
assert.match(plannerCss, /"deckplans divider specialty"/);
assert.match(plannerCss, /\.ship-deck-subsection[\s\S]*border-top/);
assert.match(adminJs, /CiShipFeatureAdmin/);
assert.match(adminJs, /Add specialty feature/);

console.log("test-ship-feature-icons: all tests passed");
