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
const rooftopKey = edgeSpecialty.find((i) => i.value === "Rooftop Garden").source_key;

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

// Confirmation reconciliation
const approvedSelectedItems = {
  exclusive_areas: [{ source_key: bluKey, name: "Blu" }, { source_key: retreatKey, name: "The Retreat" }],
  specialty_features: [
    { source_key: magicKey, value: "Magic Carpet" },
    { source_key: edenKey, value: "Eden" },
    { source_key: rooftopKey, value: "Rooftop Garden" }
  ]
};
const confirmPlans = ItemCopy.buildCopyPlans({
  sourceFacilities: edge.facilities,
  targets: [apex, beyond],
  selectedItems: approvedSelectedItems,
  conflictResolutions: [{ target_ship_id: "apex", source_key: retreatKey, action: "replace_source" }]
});
const confirmation = ItemCopy.buildConfirmationSummary({
  sourceShipName: edge.name,
  cruiseLineName: fixtures.cruiseLine.name,
  targetScope: ItemCopy.TARGET_SCOPE_SAME_CLASS,
  exclusiveItems: edgeExclusive.filter(function (i) { return [bluKey, retreatKey].includes(i.source_key); }),
  specialtyItems: edgeSpecialty.filter(function (i) { return [magicKey, edenKey, rooftopKey].includes(i.source_key); }),
  plans: confirmPlans
});
assert.equal(confirmation.aggregates.addCount, confirmation.perTarget.reduce(function (s, r) { return s + r.addCount; }, 0));
assert.equal(confirmation.aggregates.replaceCount, confirmation.perTarget.reduce(function (s, r) { return s + r.replaceCount; }, 0));
assert.equal(confirmation.aggregates.skipIdenticalCount, confirmation.perTarget.reduce(function (s, r) { return s + r.skipIdenticalCount; }, 0));
assert.equal(confirmation.aggregates.keepExistingCount, confirmation.perTarget.reduce(function (s, r) { return s + r.keepExistingCount; }, 0));
assert.throws(function () {
  ItemCopy.assertConfirmationTotalsReconcile({
    perTarget: [{ addCount: 1, replaceCount: 0, skipIdenticalCount: 0, keepExistingCount: 0 }],
    aggregates: { addCount: 2, replaceCount: 0, skipIdenticalCount: 0, keepExistingCount: 0 }
  });
}, /CONFIRMATION_TOTALS_MISMATCH/);

assert.equal(ItemCopy.canContinueToReview({ selectedSourceCount: 0, selectedTargetCount: 1, plans: confirmPlans }), false);
assert.equal(ItemCopy.canContinueToReview({ selectedSourceCount: 2, selectedTargetCount: 0, plans: confirmPlans }), false);
assert.equal(ItemCopy.canContinueToReview({ selectedSourceCount: 2, selectedTargetCount: 2, plans: confirmPlans }), true);
const noOpPlans = ItemCopy.buildCopyPlans({
  sourceFacilities: edge.facilities,
  targets: [xcel],
  selectedItems: {
    exclusive_areas: [],
    specialty_features: [
      { source_key: magicKey, value: "Magic Carpet" },
      { source_key: edenKey, value: "Eden" },
      { source_key: edgeSpecialty.find((i) => i.value === "Rooftop Garden").source_key, value: "Rooftop Garden" },
      { source_key: edgeSpecialty.find((i) => i.value === "Grand Plaza").source_key, value: "Grand Plaza" }
    ]
  },
  conflictResolutions: []
});
assert.equal(ItemCopy.canContinueToReview({ selectedSourceCount: 4, selectedTargetCount: 1, plans: noOpPlans }), false);

assert.equal(ItemCopy.planHasConflicts(confirmPlans), true);
assert.equal(ItemCopy.conflictsAreResolved(confirmPlans, [{ target_ship_id: "apex", source_key: retreatKey, action: "keep_target" }]), true);

// Approved fixture aggregate totals
assert.equal(confirmation.aggregates.addCount, 6);
assert.equal(confirmation.aggregates.replaceCount, 1);
assert.equal(confirmation.aggregates.skipIdenticalCount, 3);

const footerText = ItemCopy.formatAggregateOperationSummary(confirmation.aggregates, 2, { sourceCount: 5 }).text;
assert.match(footerText, /6 additions/);
assert.match(footerText, /1 replacement/);
assert.match(footerText, /3 identical items skipped/);
assert.match(footerText, /2 ships/);

// Shared pluralisation — zero, one and multiple for every operation type
assert.equal(ItemCopy.formatAdditionLabel(0), "0 additions");
assert.equal(ItemCopy.formatAdditionLabel(1), "1 addition");
assert.equal(ItemCopy.formatAdditionLabel(2), "2 additions");
assert.equal(ItemCopy.formatAdditionLabel("1"), "1 addition");

assert.equal(ItemCopy.formatReplacementLabel(0), "0 replacements");
assert.equal(ItemCopy.formatReplacementLabel(1), "1 replacement");
assert.equal(ItemCopy.formatReplacementLabel(2), "2 replacements");
assert.equal(ItemCopy.formatReplacementLabel("1"), "1 replacement");

assert.equal(ItemCopy.formatIdenticalSkipLabel(0), "0 identical items skipped");
assert.equal(ItemCopy.formatIdenticalSkipLabel(1), "1 identical item skipped");
assert.equal(ItemCopy.formatIdenticalSkipLabel(3), "3 identical items skipped");
assert.equal(ItemCopy.formatIdenticalSkipLabel("1"), "1 identical item skipped");

assert.equal(ItemCopy.formatRetainedVersionLabel(0), "0 target versions retained");
assert.equal(ItemCopy.formatRetainedVersionLabel(1), "1 target version retained");
assert.equal(ItemCopy.formatRetainedVersionLabel(2), "2 target versions retained");
assert.equal(ItemCopy.formatRetainedVersionLabel("1"), "1 target version retained");

assert.equal(ItemCopy.formatAcrossShipsLabel(1), "across 1 ship");
assert.equal(ItemCopy.formatAcrossShipsLabel(2), "across 2 ships");
assert.equal(ItemCopy.formatAcrossShipsLabel("1"), "across 1 ship");

assert.equal(
  ItemCopy.formatReadyToCopySummary({ addCount: 6, replaceCount: 1 }),
  "Ready to copy 6 additions and 1 replacement."
);
assert.equal(
  ItemCopy.formatReadyToCopySummary({ addCount: "6", replaceCount: "1" }),
  "Ready to copy 6 additions and 1 replacement."
);
assert.equal(ItemCopy.formatReadyToCopySummary({ addCount: 1, replaceCount: 0 }), "Ready to copy 1 addition.");
assert.equal(ItemCopy.formatAggregateTotalsLines({ addCount: 1, replaceCount: 1, skipIdenticalCount: 1, keepExistingCount: 1 }).join("|"),
  "1 addition|1 replacement|1 identical item skipped|1 target version retained");

assert.match(adminCopyJs, /formatAggregateTotalsLines/);
assert.match(adminCopyJs, /formatReadyToCopySummary/);

const execApex = CopyLib.executeItemLevelCopy({
  sourceFacilities: edge.facilities,
  target: apex,
  resolvedItems: approvedSelectedItems,
  conflictResolutions: [{ target_ship_id: "apex", source_key: retreatKey, action: "replace_source" }]
});
const execBeyond = CopyLib.executeItemLevelCopy({
  sourceFacilities: edge.facilities,
  target: beyond,
  resolvedItems: approvedSelectedItems,
  conflictResolutions: [{ target_ship_id: "apex", source_key: retreatKey, action: "replace_source" }]
});
assert.ok(execBeyond.resultRow.added.includes("Blu"));
assert.ok(execBeyond.resultRow.added.includes("The Retreat"));
assert.ok(execBeyond.resultRow.added.includes("Magic Carpet"));
assert.ok(execBeyond.resultRow.added.includes("Rooftop Garden"));
assert.ok(execBeyond.resultRow.skipped_identical.includes("Eden"));

const simulatedResults = [
  { id: apex.id, name: apex.name, ok: true, outcomes: execApex.outcomes },
  { id: beyond.id, name: beyond.name, ok: true, outcomes: execBeyond.outcomes }
];
ItemCopy.assertResultOutcomesReconcile({
  plans: confirmPlans,
  results: simulatedResults,
  sourceFacilities: edge.facilities
});

assert.throws(function () {
  ItemCopy.assertResultOutcomesReconcile({
    plans: confirmPlans,
    results: [
      { id: apex.id, name: apex.name, ok: true, outcomes: execApex.outcomes },
      { id: beyond.id, name: beyond.name, ok: true, outcomes: execBeyond.outcomes.slice(0, 2) }
    ],
    sourceFacilities: edge.facilities
  });
}, /RESULT_OUTCOME_MISSING/);

assert.throws(function () {
  ItemCopy.assertResultOutcomesReconcile({
    plans: confirmPlans,
    results: [{
      id: apex.id,
      name: apex.name,
      ok: true,
      outcomes: [
        ...execApex.outcomes,
        { source_key: bluKey, outcome: "added" }
      ]
    }],
    sourceFacilities: edge.facilities
  });
}, /RESULT_OUTCOME_DUPLICATE/);

const zeroTargetFooter = ItemCopy.formatAggregateOperationSummary(
  ItemCopy.summarizeAllPlans([]),
  0,
  { sourceCount: 1 }
);
assert.equal(zeroTargetFooter.canContinue, false);

// Post-success: merged facilities make a second identical copy a no-op
const mergedBeyond = CopyLib.executeItemLevelCopy({
  sourceFacilities: edge.facilities,
  target: beyond,
  resolvedItems: approvedSelectedItems,
  conflictResolutions: [{ target_ship_id: "apex", source_key: retreatKey, action: "replace_source" }]
});
const beyondAfterCopy = { ...beyond, facilities: mergedBeyond.facilities };
const secondBeyondPlans = ItemCopy.buildCopyPlans({
  sourceFacilities: edge.facilities,
  targets: [beyondAfterCopy],
  selectedItems: approvedSelectedItems,
  conflictResolutions: [{ target_ship_id: "apex", source_key: retreatKey, action: "replace_source" }]
});
assert.equal(ItemCopy.summarizeAllPlans(secondBeyondPlans).noChanges, true);

// UI / workflow markers
assert.match(adminJs, /Copy facilities to other ships/);
assert.match(adminJs, /CiShipFacilitiesItemCopyAdmin/);
assert.match(adminCopyJs, /Entire cruise-line fleet/);
assert.match(adminCopyJs, /Select all items/);
assert.match(adminCopyJs, /Continue to review/);
assert.match(adminCopyJs, /Confirm copy/);
assert.match(adminCopyJs, /data-footer-step="select"/);
assert.match(adminCopyJs, /data-footer-step="conflicts"/);
assert.match(adminCopyJs, /data-footer-step="confirm"/);
assert.match(adminCopyJs, /data-footer-step="result"/);
assert.match(adminCopyJs, /data-action="close-result"/);
assert.match(adminCopyJs, /buildConfirmationSummary/);
assert.match(adminCopyJs, /No changes to copy/);
assert.match(adminCopyJs, /aria-disabled/);
assert.match(adminCopyJs, /Unrelated target facilities will be preserved/);
assert.match(adminCopyJs, /selectedEa: \[\]/);
assert.match(adminCopyJs, /selectedTargets: \[\]/);
assert.match(adminCss, /\.ci-item-copy-modal\.ci-bulk-class-modal/);
assert.match(adminCss, /ci-bulk-class-modal-footer/);
assert.match(adminCss, /@media \(max-width: 390px\)/);
assert.match(adminCopyJs, /formatAggregateOperationSummary/);
assert.match(adminCopyJs, /assertResultOutcomesReconcile/);
assert.match(adminCopyJs, /renderModalFailure/);
assert.match(adminCopyJs, /resolveOpenSourceShip/);
assert.match(adminJs, /readCiFacilitiesFromDom\(existing\.facilities\)/);
assert.doesNotMatch(adminCopyJs, /window\.confirm/);

assert.equal(
  ItemCopy.itemCopySubmitLabel({ selectedTargetCount: 2, totals: { noChanges: true } }),
  "No changes to copy"
);

require(path.join(root, "netlify/functions/ci-ship-facilities-copy.js"));

console.log("test-ship-facilities-item-copy.mjs: all checks passed");
