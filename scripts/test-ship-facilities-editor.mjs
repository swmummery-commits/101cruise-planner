#!/usr/bin/env node
/**
 * Ship facilities editor + Total Decks label — focused offline tests.
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
const plannerJs = read("js/planner.js");
const adminJs = read("js/admin.js");
const researchPublicJs = read("netlify/functions/lib/research-public.js");

const millenniumExclusive = [
  "Suite Deck",
  "Premium Lounge",
  "The Retreat",
  "a ship-within-a-ship concept for suite guests featuring a private sundeck",
  "dedicated lounge",
  "and the exclusive restaurant Luminae."
];

const apexExclusive = [
  "Suite Deck",
  "Premium Lounge",
  "The Retreat, a ship-within-a-ship concept for suite guests featuring a private sundeck, dedicated lounge, and the exclusive restaurant Luminae."
];

const placeholderExclusive = ["Suite Deck", "Premium Lounge"];

const exploraSpecialty = [
  "Suites: All suites feature private terraces",
  "floor-to-ceiling windows",
  "and walk-in wardrobes. Dining & Bars: Six restaurants including Anthology (fine dining)",
  "Sakura (Pan-Asian)"
];

// --- CiShipFacilities round trips ---

const commaDesc = "Private sundeck, lounge, and Luminae.";
const savedExclusive = CiFac.serializeExclusiveAreasFromAdmin([
  { name: "The Retreat", description: commaDesc }
]);
assert.equal(savedExclusive.length, 1);
assert.equal(savedExclusive[0].name, "The Retreat");
assert.equal(savedExclusive[0].description, commaDesc);
const reloadedExclusive = CiFac.loadExclusiveAreasForAdmin(savedExclusive);
assert.equal(reloadedExclusive[0].description, commaDesc);

const legacyLoaded = CiFac.loadExclusiveAreasForAdmin(apexExclusive);
assert.equal(legacyLoaded.length, 3);
assert.match(legacyLoaded[2].name, /Luminae\./);
assert.equal(CiFac.serializeExclusiveAreasFromAdmin(legacyLoaded).length, 3);

const fragmentedLoaded = CiFac.loadExclusiveAreasForAdmin(millenniumExclusive);
assert.equal(fragmentedLoaded.length, 6);
assert.equal(fragmentedLoaded[3].name, "a ship-within-a-ship concept for suite guests featuring a private sundeck");

const ordered = CiFac.serializeExclusiveAreasFromAdmin([
  { name: "Alpha", description: "" },
  { name: "Beta", description: "Second" },
  { name: "", description: "ignored" }
]);
assert.equal(ordered.length, 2);
assert.equal(ordered[0].name, "Alpha");
assert.equal(ordered[1].name, "Beta");
assert.equal(ordered[1].description, "Second");

const specialtySaved = CiFac.serializeSpecialtyFeaturesFromAdmin([
  { label: "Main Pool" },
  { label: "Fitness Center, with classes" }
]);
assert.equal(specialtySaved.length, 2);
assert.equal(specialtySaved[0], "Main Pool");
assert.equal(specialtySaved[1], "Fitness Center, with classes");
const specialtyLoaded = CiFac.loadSpecialtyFeaturesForAdmin(exploraSpecialty);
assert.equal(specialtyLoaded.length, 4);

const existingFacilities = {
  restaurants: 12,
  custom_vendor_note: "keep-me",
  legacy_unknown: { nested: true }
};
const merged = {
  ...existingFacilities,
  ...(function () {
    const facilities = { ...existingFacilities };
    const exclusive = CiFac.serializeExclusiveAreasFromAdmin([{ name: "The Retreat", description: commaDesc }]);
    const specialty = CiFac.serializeSpecialtyFeaturesFromAdmin([{ label: "Main Pool" }]);
    facilities.exclusive_areas = exclusive;
    facilities.specialty_features = specialty;
    facilities.spa = true;
    return facilities;
  })()
};
assert.equal(merged.custom_vendor_note, "keep-me");
assert.deepEqual(merged.legacy_unknown, { nested: true });

// --- Customer display ---

const structuredDisplay = CiFac.normalizeExclusiveAreasForDisplay([
  { name: "The Retreat", description: "A ship-within-a-ship experience, with commas." }
]);
assert.equal(structuredDisplay[0].name, "The Retreat");
assert.match(structuredDisplay[0].description, /commas/);
assert.doesNotMatch(JSON.stringify(structuredDisplay), /\[object Object\]/);

const legacyDisplay = CiFac.normalizeExclusiveAreasForDisplay(apexExclusive);
assert.equal(legacyDisplay.length, 3);
assert.match(legacyDisplay[2].name, /Luminae\./);

const labels = CiFac.exclusiveAreasAsLabels([{ name: "Retreat", description: "Hidden detail" }]);
assert.equal(labels.length, 1);
assert.equal(labels[0], "Retreat");

const specialtyDisplay = CiFac.normalizeSpecialtyFeaturesForDisplay(exploraSpecialty);
assert.equal(specialtyDisplay.length, 4);
assert.doesNotMatch(specialtyDisplay.join("|"), /\[object Object\]/);

// --- Planner deck labels ---

assert.doesNotMatch(plannerJs, /Passenger decks/);
assert.match(plannerJs, /label: "Total decks"/);
assert.match(plannerJs, /label: "Decks", value: formatShipNumber\(decks\)/);
assert.doesNotMatch(plannerJs, /passenger decks/);

// --- Admin editor ---

assert.doesNotMatch(adminJs, /comma separated/i);
assert.match(adminJs, /ciExclusiveAreasList/);
assert.match(adminJs, /ciSpecialtyFeaturesList/);
assert.doesNotMatch(adminJs, /ciChipList\("ciFacExclusive"\)/);

// --- research-public mapping ---

assert.match(researchPublicJs, /exclusiveAreasAsLabels/);

const { exclusiveAreasAsLabels } = require(path.join(root, "js/ci-ship-facilities.js"));
assert.equal(exclusiveAreasAsLabels([{ name: "The Retreat", description: "Comma, inside." }]).join("|"), "The Retreat");

// --- Resolver regression (offline) ---

const { resolveCruiseShip } = require(path.join(root, "netlify/functions/lib/resolve-cruise-ship.js"));
const ships = [
  { id: "m1", name: "Millennium", cruise_line_name: "Celebrity Cruises" },
  { id: "cm1", name: "Celebrity Millennium", cruise_line_name: "Celebrity Cruises" }
];
const resolved = resolveCruiseShip(ships, "Millennium", "Celebrity");
assert.equal(resolved.status, "matched");
assert.equal(resolved.ship.id, "m1");

console.log("test-ship-facilities-editor.mjs: all checks passed");
