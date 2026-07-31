#!/usr/bin/env node
/**
 * Item-level ship facilities copy — focused offline tests.
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

function loadModule(rel) {
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read(rel), sandbox, { filename: path.basename(rel) });
  return sandbox.module.exports;
}

const CiFac = loadModule("js/ci-ship-facilities.js");
const ItemCopy = loadModule("js/ci-ship-facilities-item-copy.js");
const CopyLib = require(path.join(root, "netlify/functions/lib/ci-ship-facilities-copy.js"));
const fixtures = require(path.join(root, "scripts/fixtures/ship-facilities-item-copy-fixtures.js"));

const adminJs = read("js/admin.js");
const adminCopyJs = read("js/admin-ship-facilities-item-copy.js");
const adminCss = read("css/admin.css");

const edge = fixtures.ships.find((s) => s.id === "edge");
const apex = fixtures.ships.find((s) => s.id === "apex");
const beyond = fixtures.ships.find((s) => s.id === "beyond");
const xcel = fixtures.ships.find((s) => s.id === "xcel");
const millennium = fixtures.ships.find((s) => s.id === "millennium");

const edgeExclusive = ItemCopy.listSourceExclusiveAreas(edge.facilities.exclusive_areas);
const edgeSpecialty = ItemCopy.listSourceSpecialtyFeatures(edge.facilities.specialty_features);
const bluKey = edgeExclusive.find((i) => i.name === "Blu").source_key;
const retreatKey = edgeExclusive.find((i) => i.name === "The Retreat").source_key;
const magicKey = edgeSpecialty.find((i) => i.value === "Magic Carpet").source_key;
const edenKey = edgeSpecialty.find((i) => i.value === "Eden").source_key;

// SOURCE SELECTION helpers
assert.equal(edgeExclusive.length, 2);
assert.equal(edgeSpecialty.length, 4);
assert.ok(!adminCopyJs.includes('checked>') || adminCopyJs.includes('ci-item-copy-source-ea" value='));

// TARGETING
const sameClassTargets = ItemCopy.listSameClassCopyTargets(fixtures.ships, edge, "Edge class");
assert.equal(sameClassTargets.length, 4);
assert.ok(sameClassTargets.every((s) => s.id !== "edge"));
assert.ok(sameClassTargets.every((s) => s.cruise_line_id === edge.cruise_line_id));
assert.ok(!sameClassTargets.some((s) => s.id === "millennium"));

const fleetTargets = ItemCopy.listFleetCopyTargets(fixtures.ships, edge);
assert.ok(fleetTargets.some((s) => s.id === "millennium"));
assert.ok(!fleetTargets.some((s) => s.id === "edge"));
assert.equal(
  ItemCopy.listFleetCopyTargets([{ id: "x", cruise_line_id: "other", active: true }], edge).length,
  0
);

const filtered = ItemCopy.filterFleetTargets(fleetTargets, edge.cruise_line_id, {
  search: "millennium",
  classFilter: "all"
});
assert.equal(filtered.length, 1);

// MATCHING
const bluOnBeyond = ItemCopy.compareExclusiveAreaOnTarget(
  edgeExclusive.find((i) => i.name === "Blu"),
  beyond.facilities
);
assert.equal(bluOnBeyond.status, "missing");

const bluOnApex = ItemCopy.compareExclusiveAreaOnTarget(
  edgeExclusive.find((i) => i.name === "Blu"),
  apex.facilities
);
assert.equal(bluOnApex.status, "identical");

const retreatOnApex = ItemCopy.compareExclusiveAreaOnTarget(
  edgeExclusive.find((i) => i.name === "The Retreat"),
  apex.facilities
);
assert.equal(retreatOnApex.status, "different");

const edenOnBeyond = ItemCopy.compareSpecialtyFeatureOnTarget(
  edgeSpecialty.find((i) => i.value === "Eden"),
  beyond.facilities
);
assert.equal(edenOnBeyond.status, "identical");

const magicOnBeyond = ItemCopy.compareSpecialtyFeatureOnTarget(
  edgeSpecialty.find((i) => i.value === "Magic Carpet"),
  beyond.facilities
);
assert.equal(magicOnBeyond.status, "missing");

const legacyXcel = ItemCopy.listSourceExclusiveAreas(xcel.facilities.exclusive_areas)[0];
assert.equal(legacyXcel.legacy, true);
const legacyCompare = ItemCopy.compareExclusiveAreaOnTarget(legacyXcel, { exclusive_areas: [] });
assert.equal(legacyCompare.status, "missing");

// No fuzzy specialty matching
const nearMiss = ItemCopy.compareSpecialtyFeatureOnTarget(
  { value: "Magic Carpet", source_key: magicKey },
  { specialty_features: ["Magic  Carpet"] }
);
assert.equal(nearMiss.status, "identical");
const fuzzyMiss = ItemCopy.compareSpecialtyFeatureOnTarget(
  { value: "Magic Carpet", source_key: magicKey },
  { specialty_features: ["Magic Carpets"] }
);
assert.equal(fuzzyMiss.status, "missing");

// MERGE SAFETY
const selectedItems = {
  exclusive_areas: [{ source_key: bluKey, name: "Blu" }, { source_key: retreatKey, name: "The Retreat" }],
  specialty_features: [{ source_key: magicKey, value: "Magic Carpet" }, { source_key: edenKey, value: "Eden" }]
};
const plans = ItemCopy.buildCopyPlans({
  sourceFacilities: edge.facilities,
  targets: [beyond, apex],
  selectedItems,
  conflictResolutions: [{ target_ship_id: "apex", source_key: retreatKey, action: "replace_source" }]
});
const beyondPlan = plans.find((p) => p.targetShipId === "beyond");
assert.ok(beyondPlan.summary.addCount >= 2);

const beyondMerge = ItemCopy.applyItemLevelCopyToFacilities(beyond.facilities, beyondPlan.items);
assert.ok(beyondMerge.facilities.exclusive_areas.some((e) => e.name === "Blu"));
assert.ok(beyondMerge.facilities.specialty_features.includes("Magic Carpet"));
assert.equal(beyondMerge.facilities.specialty_features.filter((v) => v === "Eden").length, 1);
assert.equal(beyond.facilities.specialty_features.length, 1);

const apexPlan = plans.find((p) => p.targetShipId === "apex");
const apexMerge = ItemCopy.applyItemLevelCopyToFacilities(apex.facilities, apexPlan.items);
const apexRetreat = apexMerge.facilities.exclusive_areas.find((e) => e.name === "The Retreat");
assert.match(apexRetreat.description, /Luminae|ship-within-a-ship/);
assert.ok(apexMerge.facilities.specialty_features.includes("Solarium"));

const withUnknown = ItemCopy.applyItemLevelCopyToFacilities(
  { restaurants: 8, custom_flag: true, exclusive_areas: [], specialty_features: [] },
  beyondPlan.items
);
assert.equal(withUnknown.facilities.restaurants, 8);
assert.equal(withUnknown.facilities.custom_flag, true);

// Order stable + append in source order
const orderTarget = { exclusive_areas: [{ name: "Alpha", description: "One" }], specialty_features: ["Zulu"] };
const orderPlan = ItemCopy.buildCopyPlans({
  sourceFacilities: edge.facilities,
  targets: [{ id: "t1", name: "T1", facilities: orderTarget }],
  selectedItems: {
    exclusive_areas: [{ source_key: bluKey, name: "Blu" }],
    specialty_features: [{ source_key: magicKey, value: "Magic Carpet" }]
  },
  conflictResolutions: []
})[0];
const orderMerged = ItemCopy.applyItemLevelCopyToFacilities(orderTarget, orderPlan.items);
assert.equal(orderMerged.facilities.exclusive_areas[0].name, "Alpha");
assert.equal(orderMerged.facilities.exclusive_areas[1].name, "Blu");
assert.equal(orderMerged.facilities.specialty_features[0], "Zulu");
assert.equal(orderMerged.facilities.specialty_features[1], "Magic Carpet");

// Keep existing
const keepPlan = ItemCopy.buildCopyPlans({
  sourceFacilities: edge.facilities,
  targets: [{ id: "apex", name: "Celebrity Apex", facilities: apex.facilities }],
  selectedItems: { exclusive_areas: [{ source_key: retreatKey, name: "The Retreat" }], specialty_features: [] },
  conflictResolutions: [{ target_ship_id: "apex", source_key: retreatKey, action: "keep_target" }]
})[0];
const keepMerged = ItemCopy.applyItemLevelCopyToFacilities(apex.facilities, keepPlan.items);
assert.match(
  keepMerged.facilities.exclusive_areas.find((e) => e.name === "The Retreat").description,
  /Different Retreat/
);

// SERVER VALIDATION
const valid = ItemCopy.validateItemLevelCopyRequest({
  sourceShip: edge,
  targetShips: [apex, beyond],
  targetScope: ItemCopy.TARGET_SCOPE_SAME_CLASS,
  selectedItems,
  conflictResolutions: [{ target_ship_id: "apex", source_key: retreatKey, action: "replace_source" }],
  sourceFacilities: edge.facilities
});
assert.equal(valid.ok, true);

const noItems = ItemCopy.validateItemLevelCopyRequest({
  sourceShip: edge,
  targetShips: [apex],
  targetScope: ItemCopy.TARGET_SCOPE_SAME_CLASS,
  selectedItems: { exclusive_areas: [], specialty_features: [] },
  conflictResolutions: [],
  sourceFacilities: edge.facilities
});
assert.equal(noItems.ok, false);
assert.equal(noItems.error, "NO_ITEMS_SELECTED");

const noOp = ItemCopy.validateItemLevelCopyRequest({
  sourceShip: edge,
  targetShips: [xcel],
  targetScope: ItemCopy.TARGET_SCOPE_SAME_CLASS,
  selectedItems: {
    exclusive_areas: [],
    specialty_features: [
      { source_key: magicKey, value: "Magic Carpet" },
      { source_key: edgeSpecialty.find((i) => i.value === "Rooftop Garden").source_key, value: "Rooftop Garden" },
      { source_key: edgeSpecialty.find((i) => i.value === "Grand Plaza").source_key, value: "Grand Plaza" },
      { source_key: edenKey, value: "Eden" }
    ]
  },
  conflictResolutions: [],
  sourceFacilities: edge.facilities
});
assert.equal(noOp.ok, false);
assert.equal(noOp.error, "NO_CHANGES");

const classMismatch = ItemCopy.validateItemLevelCopyRequest({
  sourceShip: edge,
  targetShips: [millennium],
  targetScope: ItemCopy.TARGET_SCOPE_SAME_CLASS,
  selectedItems: { exclusive_areas: [{ source_key: bluKey, name: "Blu" }], specialty_features: [] },
  conflictResolutions: [],
  sourceFacilities: edge.facilities
});
assert.equal(classMismatch.ok, false);
assert.equal(classMismatch.error, "TARGET_CLASS_MISMATCH");

const invalidItem = ItemCopy.validateItemLevelCopyRequest({
  sourceShip: edge,
  targetShips: [apex],
  targetScope: ItemCopy.TARGET_SCOPE_SAME_CLASS,
  selectedItems: { exclusive_areas: [{ source_key: "ea:name:missing", name: "Missing" }], specialty_features: [] },
  conflictResolutions: [],
  sourceFacilities: edge.facilities
});
assert.equal(invalidItem.ok, false);
assert.equal(invalidItem.error, "INVALID_SELECTED_ITEMS");

const invalidConflict = ItemCopy.validateItemLevelCopyRequest({
  sourceShip: edge,
  targetShips: [apex],
  targetScope: ItemCopy.TARGET_SCOPE_SAME_CLASS,
  selectedItems: { exclusive_areas: [{ source_key: retreatKey, name: "The Retreat" }], specialty_features: [] },
  conflictResolutions: [{ target_ship_id: "apex", source_key: bluKey, action: "replace_source" }],
  sourceFacilities: edge.facilities
});
assert.equal(invalidConflict.ok, false);
assert.equal(invalidConflict.error, "INVALID_CONFLICT_RESOLUTION");

// executeItemLevelCopy lib
const exec = CopyLib.executeItemLevelCopy({
  sourceFacilities: edge.facilities,
  target: beyond,
  resolvedItems: {
    exclusive_areas: [{ source_key: bluKey, name: "Blu" }],
    specialty_features: [{ source_key: magicKey, value: "Magic Carpet" }]
  },
  conflictResolutions: []
});
assert.equal(exec.ok, true);
assert.ok(exec.resultRow.added.includes("Blu"));

// Legacy category patch still works
const legacyPatch = CopyLib.buildFacilitiesPatch({
  copy_exclusive_areas: true,
  copy_specialty_features: false,
  exclusive_areas: [{ name: "Retreat" }]
});
assert.equal(legacyPatch.ok, true);

// RESULTS reconciliation
const resultRow = ItemCopy.buildResultRow("Celebrity Beyond", exec.outcomes, {
  [bluKey]: { name: "Blu" },
  [magicKey]: { value: "Magic Carpet" }
});
assert.ok(resultRow.added.includes("Blu"));
assert.ok(resultRow.added.includes("Magic Carpet"));

// UI / responsive markers
assert.match(adminJs, /Copy facilities to other ships/);
assert.match(adminJs, /CiShipFacilitiesItemCopyAdmin/);
assert.match(adminCopyJs, /Entire cruise-line fleet/);
assert.match(adminCopyJs, /Select all items/);
assert.match(adminCss, /\.ci-item-copy-modal/);
assert.match(adminCss, /max-width: 390px/);
assert.match(adminCopyJs, /itemCopySubmitLabel/);
assert.equal(
  ItemCopy.itemCopySubmitLabel({ selectedTargetCount: 2, totals: { noChanges: true } }),
  "No changes to copy"
);

require(path.join(root, "netlify/functions/ci-ship-facilities-copy.js"));

console.log("test-ship-facilities-item-copy.mjs: all checks passed");
