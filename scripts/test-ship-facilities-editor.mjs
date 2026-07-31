#!/usr/bin/env node
/**
 * Ship facilities editor + same-class copy — focused offline tests.
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

function loadCiShipFacilities() {
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read("js/ci-ship-facilities.js"), sandbox, { filename: "ci-ship-facilities.js" });
  return sandbox.module.exports;
}

const CiFac = loadCiShipFacilities();
const CopyLib = require(path.join(root, "netlify/functions/lib/ci-ship-facilities-copy.js"));
const plannerJs = read("js/planner.js");
const adminJs = read("js/admin.js");

const apexSentence =
  "The Retreat, a ship-within-a-ship concept for suite guests featuring a private sundeck, dedicated lounge, and the exclusive restaurant Luminae.";

const millenniumExclusive = [
  "Suite Deck",
  "Premium Lounge",
  "The Retreat",
  "a ship-within-a-ship concept for suite guests featuring a private sundeck",
  "dedicated lounge",
  "and the exclusive restaurant Luminae."
];

const celebrityShips = [
  { id: "apex", name: "Celebrity Apex", cruise_line_id: "line-celeb", ship_class: "Edge class", active: true },
  { id: "ascent", name: "Celebrity Ascent", cruise_line_id: "line-celeb", ship_class: "Edge class", active: true },
  { id: "beyond", name: "Celebrity Beyond", cruise_line_id: "line-celeb", ship_class: "Edge class", active: true },
  { id: "mill", name: "Celebrity Millennium", cruise_line_id: "line-celeb", ship_class: "Millennium class", active: true },
  { id: "solstice", name: "Celebrity Solstice", cruise_line_id: "line-celeb", ship_class: "Solstice class", active: true }
];

// Legacy Apex presentation suggestion
const apexSuggested = CiFac.suggestLegacyExclusiveString(apexSentence);
assert.equal(apexSuggested.suggested, true);
assert.equal(apexSuggested.name, "The Retreat");
assert.match(apexSuggested.description, /Luminae\./);

const rawApex = [apexSentence];
const apexLoaded = CiFac.loadExclusiveAreasForAdmin(rawApex);
assert.equal(apexLoaded.length, 1);
assert.equal(apexLoaded[0].name, "The Retreat");
assert.equal(apexLoaded[0].showDescription, true);
assert.equal(rawApex[0], apexSentence);
assert.equal(CiFac.serializeExclusiveAreasFromAdmin(apexLoaded).length, 1);

// Suggestion does not write until explicit save
const unsavedRows = [{ name: "The Retreat", description: apexSuggested.description }];
assert.equal(CiFac.serializeExclusiveAreasFromAdmin(unsavedRows).length, 1);

// Fragmented Millennium stays separate
const millLoaded = CiFac.loadExclusiveAreasForAdmin(millenniumExclusive);
assert.equal(millLoaded.length, 6);
assert.equal(CiFac.detectFragmentedLegacyExclusiveAreas(millenniumExclusive), true);

// Default one-area presentation
assert.equal(CiFac.loadExclusiveAreasForAdmin([]).length, 0);

// Empty description collapsed semantics
const collapsed = CiFac.loadExclusiveAreasForAdmin([{ name: "Suite Deck", description: "" }]);
assert.equal(collapsed[0].showDescription, false);
const open = CiFac.loadExclusiveAreasForAdmin([{ name: "The Retreat", description: "Detail" }]);
assert.equal(open[0].showDescription, true);

// Add another area / ordering
const orderedSave = CiFac.serializeExclusiveAreasFromAdmin([
  { name: "Alpha", description: "" },
  { name: "Beta", description: "Second" }
]);
assert.equal(orderedSave[0].name, "Alpha");
assert.equal(orderedSave[1].name, "Beta");

// Specialty features comma-safe
const specialtySaved = CiFac.serializeSpecialtyFeaturesFromAdmin([
  { label: "Fitness Center, with classes" }
]);
assert.equal(specialtySaved[0], "Fitness Center, with classes");

// ship_class
assert.equal(CiFac.normalizeShipClass("  Edge class  "), "Edge class");
assert.equal(CiFac.normalizeShipClass("   "), null);
assert.match(adminJs, /id="ciShipClass"/);
assert.match(adminJs, /ship_class: getCiShipClassDraft\(\)/);

// Same-class targets
const edgeTargets = CiFac.listSameClassCopyTargets(celebrityShips, celebrityShips[0], "Edge class");
assert.equal(edgeTargets.length, 2);
assert.ok(edgeTargets.every((ship) => ship.id !== "apex"));
assert.ok(edgeTargets.some((ship) => ship.name === "Celebrity Ascent"));

const edgeFromApex = CiFac.listSameClassCopyTargets(celebrityShips, celebrityShips[0], "Edge class");
assert.ok(!edgeFromApex.some((ship) => ship.id === "solstice"));
assert.equal(edgeFromApex.length, 2);

const otherLine = CiFac.listSameClassCopyTargets(
  [{ id: "x", name: "Other", cruise_line_id: "other", ship_class: "Edge class", active: true }],
  celebrityShips[0],
  "Edge class"
);
assert.equal(otherLine.length, 0);

// Copy merge preserves unrelated keys
const merged = CiFac.mergeFacilitiesCopy(
  { restaurants: 8, custom_flag: true, exclusive_areas: ["Old"] },
  {
    copy_exclusive_areas: true,
    copy_specialty_features: true,
    exclusive_areas: [{ name: "The Retreat", description: "New" }],
    specialty_features: ["Pool"]
  }
);
assert.equal(merged.restaurants, 8);
assert.equal(merged.custom_flag, true);
assert.equal(merged.exclusive_areas[0].name, "The Retreat");
assert.equal(merged.specialty_features.length, 1);
assert.equal(merged.specialty_features[0], "Pool");

const specsUntouched = CiFac.mergeFacilitiesCopy(
  { restaurants: 3 },
  { copy_exclusive_areas: true, exclusive_areas: [{ name: "Retreat" }] }
);
assert.equal(specsUntouched.restaurants, 3);
assert.equal(Object.prototype.hasOwnProperty.call(specsUntouched, "passenger_capacity"), false);

// Validation
const validation = CiFac.validateSameClassCopyRequest({
  sourceShip: celebrityShips[0],
  targetShips: [celebrityShips[1], celebrityShips[2]],
  draftClass: "Edge class"
});
assert.equal(validation.ok, true);

const badClass = CiFac.validateSameClassCopyRequest({
  sourceShip: celebrityShips[0],
  targetShips: [celebrityShips[4]],
  draftClass: "Edge class"
});
assert.equal(badClass.ok, false);

const sourceInTargets = CiFac.validateSameClassCopyRequest({
  sourceShip: celebrityShips[0],
  targetShips: [celebrityShips[0]],
  draftClass: "Edge class"
});
assert.equal(sourceInTargets.ok, false);

// buildFacilitiesPatch defaults
const patch = CopyLib.buildFacilitiesPatch({
  copy_exclusive_areas: true,
  copy_specialty_features: false,
  exclusive_areas: [{ name: "Retreat" }]
});
assert.equal(patch.ok, true);
assert.equal(patch.patch.copy_specialty_features, false);

const noSections = CopyLib.buildFacilitiesPatch({ copy_exclusive_areas: false, copy_specialty_features: false });
assert.equal(noSections.ok, false);

// Renderer / labels
assert.doesNotMatch(plannerJs, /Passenger decks/);
assert.match(plannerJs, /label: "Total decks"/);
assert.doesNotMatch(plannerJs, /passenger decks/);

const display = CiFac.normalizeExclusiveAreasForDisplay([{ name: "The Retreat", description: "Long prose stays below the chip." }]);
assert.equal(display[0].name, "The Retreat");
assert.match(display[0].description, /Long prose/);
assert.doesNotMatch(JSON.stringify(display), /\[object Object\]/);

// Admin compact UI markers
assert.match(adminJs, /Add another exclusive area/);
assert.match(adminJs, /Add description/);
assert.match(adminJs, /Copy to ships in this class/);
assert.match(adminJs, /ci-ship-facilities-copy/);
assert.match(adminJs, /Copy cancelled/);
assert.match(adminJs, /renderCiExclusiveAreaFieldStack/);
assert.match(adminJs, /ci-exclusive-area-fields/);
assert.match(adminJs, /renderCiExclusiveAreaSourcePreviewHtml/);
assert.doesNotMatch(adminJs, /ci-exclusive-area-card ci-facility-row/);
assert.match(read("css/admin.css"), /\.ci-exclusive-area-fields/);
assert.match(read("css/admin.css"), /width:\s*100%/);

const { resolveCruiseShip } = require(path.join(root, "netlify/functions/lib/resolve-cruise-ship.js"));
const resolved = resolveCruiseShip(
  [
    { id: "m1", name: "Millennium", cruise_line_name: "Celebrity Cruises" },
    { id: "cm1", name: "Celebrity Millennium", cruise_line_name: "Celebrity Cruises" }
  ],
  "Millennium",
  "Celebrity"
);
assert.equal(resolved.status, "matched");

require(path.join(root, "netlify/functions/ci-ship-facilities-copy.js"));
require(path.join(root, "netlify/functions/lib/research-public.js"));

console.log("test-ship-facilities-editor.mjs: all checks passed");
