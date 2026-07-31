#!/usr/bin/env node
/**
 * Bulk ship class assignment — focused offline tests (fixtures only).
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

function loadBulk() {
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read("js/ci-ship-class-bulk.js"), sandbox, { filename: "ci-ship-class-bulk.js" });
  return sandbox.module.exports;
}

const Bulk = loadBulk();
const adminJs = read("js/admin.js");
const adminBulkJs = read("js/admin-ship-class-bulk.js");
const CiFac = (() => {
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read("js/ci-ship-facilities.js"), sandbox, { filename: "ci-ship-facilities.js" });
  return sandbox.module.exports;
})();

const LINE_CELEB = "line-celeb";
const LINE_ROYAL = "line-royal";

const celebrityFleet = [
  { id: "mill", name: "Celebrity Millennium", cruise_line_id: LINE_CELEB, ship_class: "Millennium class", status: "active", active: true },
  { id: "inf", name: "Celebrity Infinity", cruise_line_id: LINE_CELEB, ship_class: "Millennium class", status: "active", active: true },
  { id: "con", name: "Celebrity Constellation", cruise_line_id: LINE_CELEB, ship_class: "Millennium class", status: "active", active: true },
  { id: "sum", name: "Celebrity Summit", cruise_line_id: LINE_CELEB, ship_class: "Millennium class", status: "active", active: true },
  { id: "sol", name: "Celebrity Solstice", cruise_line_id: LINE_CELEB, ship_class: "Solstice class", status: "active", active: true },
  { id: "ecl", name: "Celebrity Eclipse", cruise_line_id: LINE_CELEB, ship_class: "Solstice class", status: "active", active: true },
  { id: "eq", name: "Celebrity Equinox", cruise_line_id: LINE_CELEB, ship_class: "Solstice class", status: "active", active: true },
  { id: "sil", name: "Celebrity Silhouette", cruise_line_id: LINE_CELEB, ship_class: "Solstice class", status: "active", active: true },
  { id: "ref", name: "Celebrity Reflection", cruise_line_id: LINE_CELEB, ship_class: "Solstice class", status: "active", active: true },
  { id: "edge", name: "Celebrity Edge", cruise_line_id: LINE_CELEB, ship_class: "Edge class", status: "active", active: true },
  { id: "apex", name: "Celebrity Apex", cruise_line_id: LINE_CELEB, ship_class: "Edge class", status: "active", active: true },
  { id: "bynd", name: "Celebrity Beyond", cruise_line_id: LINE_CELEB, ship_class: "Edge class", status: "active", active: true },
  { id: "asc", name: "Celebrity Ascent", cruise_line_id: LINE_CELEB, ship_class: "Edge class", status: "active", active: true },
  { id: "xcel", name: "Celebrity Xcel", cruise_line_id: LINE_CELEB, ship_class: "Edge class", status: "active", active: true },
  { id: "unassigned", name: "Celebrity Flora", cruise_line_id: LINE_CELEB, ship_class: null, status: "active", active: true },
  { id: "mixed", name: "Celebrity Xpedition", cruise_line_id: LINE_CELEB, ship_class: "Expedition class", status: "active", active: true },
  { id: "retired", name: "Celebrity Century", cruise_line_id: LINE_CELEB, ship_class: "Millennium class", status: "retired", active: false },
  { id: "drydock", name: "Celebrity Journey", cruise_line_id: LINE_CELEB, ship_class: null, status: "under_construction", active: true },
  { id: "royal", name: "Royal Princess", cruise_line_id: LINE_ROYAL, ship_class: "Royal class", status: "active", active: true }
];

// Fleet scoping
const lineShips = Bulk.listFleetShipsForLine(celebrityFleet, LINE_CELEB);
assert.equal(lineShips.length, 18);
assert.ok(!lineShips.some((ship) => ship.cruise_line_id === LINE_ROYAL));

// Default active filter
const activeVisible = Bulk.filterFleetShips(celebrityFleet, LINE_CELEB, { statusFilter: "active" });
assert.ok(activeVisible.every((ship) => Bulk.shipMatchesStatusFilter(ship, "active")));
assert.ok(!activeVisible.some((ship) => ship.id === "retired"));
assert.ok(!activeVisible.some((ship) => ship.id === "drydock"));

// Retired only when requested
const retiredVisible = Bulk.filterFleetShips(celebrityFleet, LINE_CELEB, { statusFilter: "retired", classFilter: "all" });
assert.ok(retiredVisible.some((ship) => ship.id === "retired"));
assert.equal(retiredVisible.length, 1);

// Dry dock filter
const dryDockVisible = Bulk.filterFleetShips(celebrityFleet, LINE_CELEB, { statusFilter: "dry_dock", classFilter: "all" });
assert.ok(dryDockVisible.some((ship) => ship.id === "drydock"));

// Class comparison + preserved display capitalisation
assert.equal(Bulk.normalizeShipClassInput("  Millennium class  "), "Millennium class");
assert.equal(Bulk.normalizeShipClassInput("   "), null);
assert.equal(Bulk.shipClassesEquivalent("Millennium class", "millennium class"), true);
assert.equal(Bulk.shipClassesEquivalent("Millennium  class", "millennium class"), true);
assert.notEqual(Bulk.normalizeShipClassInput("Millennium class"), "millennium class");

// Assignment classification
assert.equal(Bulk.classifyAssignment({ ship_class: null }, "Millennium class").kind, "new");
assert.equal(Bulk.classifyAssignment({ ship_class: "Millennium class" }, "Millennium class").kind, "unchanged");
assert.equal(Bulk.classifyAssignment({ ship_class: "Millennium class" }, "millennium class").kind, "unchanged");
assert.equal(Bulk.classifyAssignment({ ship_class: "Solstice class" }, "Millennium class").kind, "replace");

// Select unassigned visible
const unassignedVisible = Bulk.filterFleetShips(celebrityFleet, LINE_CELEB, {
  statusFilter: "active",
  classFilter: "unassigned"
});
assert.ok(unassignedVisible.every((ship) => Bulk.isUnassignedClass(ship.ship_class)));
assert.ok(unassignedVisible.some((ship) => ship.id === "unassigned"));

// Replacement safeguards
const replaceValidation = Bulk.validateBulkAssignRequest({
  cruiseLineId: LINE_CELEB,
  shipIds: ["sol"],
  shipClass: "Millennium class",
  ships: celebrityFleet,
  replacementConfirmed: false
});
assert.equal(replaceValidation.ok, false);
assert.equal(replaceValidation.error, "REPLACEMENT_NOT_CONFIRMED");

const replaceOk = Bulk.validateBulkAssignRequest({
  cruiseLineId: LINE_CELEB,
  shipIds: ["sol"],
  shipClass: "Millennium class",
  ships: celebrityFleet,
  replacementConfirmed: true
});
assert.equal(replaceOk.ok, true);

// Empty class rejected
assert.equal(
  Bulk.validateBulkAssignRequest({
    cruiseLineId: LINE_CELEB,
    shipIds: ["mill"],
    shipClass: "  ",
    ships: celebrityFleet,
    replacementConfirmed: true
  }).error,
  "EMPTY_CLASS"
);

// Duplicate IDs rejected
assert.equal(
  Bulk.validateBulkAssignRequest({
    cruiseLineId: LINE_CELEB,
    shipIds: ["mill", "mill"],
    shipClass: "Millennium class",
    ships: celebrityFleet,
    replacementConfirmed: true
  }).error,
  "DUPLICATE_SHIP_ID"
);

// Another-line ship rejected
assert.equal(
  Bulk.validateBulkAssignRequest({
    cruiseLineId: LINE_CELEB,
    shipIds: ["royal"],
    shipClass: "Millennium class",
    ships: celebrityFleet,
    replacementConfirmed: true
  }).error,
  "TARGET_LINE_MISMATCH"
);

// Button labels + disabled states
assert.equal(Bulk.applyClassButtonLabel({ selectedCount: 0, changeCount: 0 }), "Apply class");
assert.equal(Bulk.applyClassButtonLabel({ selectedCount: 4, changeCount: 2 }), "Apply class to 4 ships");
assert.equal(Bulk.applyClassButtonLabel({ selectedCount: 4, changeCount: 0 }), "No changes to apply");
assert.equal(Bulk.canApplyClassAssignment({ selectedCount: 0, shipClass: "Edge class", changeCount: 0, replaceCount: 0, replacementConfirmed: false }), false);
assert.equal(Bulk.canApplyClassAssignment({ selectedCount: 2, shipClass: "Edge class", changeCount: 1, replaceCount: 0, replacementConfirmed: false }), true);
assert.equal(Bulk.canApplyClassAssignment({ selectedCount: 2, shipClass: "Edge class", changeCount: 0, replaceCount: 0, replacementConfirmed: false }), false);
assert.equal(Bulk.canApplyClassAssignment({ selectedCount: 2, shipClass: "Edge class", changeCount: 1, replaceCount: 1, replacementConfirmed: false }), false);
assert.equal(Bulk.canApplyClassAssignment({ selectedCount: 2, shipClass: "", changeCount: 1, replaceCount: 0, replacementConfirmed: false }), false);

const mixedSelection = celebrityFleet.filter((ship) => ["inf", "con", "sum", "sol"].includes(ship.id));
const mixedSummary = Bulk.buildAssignmentSummary(mixedSelection, "Millennium class");
assert.equal(mixedSummary.unchangedCount, 3);
assert.equal(mixedSummary.replaceCount, 1);
assert.equal(mixedSummary.changeCount, 1);
assert.ok(mixedSummary.unchangedShips.includes("Celebrity Infinity"));
assert.ok(mixedSummary.unchangedShips.includes("Celebrity Constellation"));
assert.ok(mixedSummary.unchangedShips.includes("Celebrity Summit"));
assert.equal(mixedSummary.replaceShips.length, 1);
assert.equal(mixedSummary.replaceShips[0].name, "Celebrity Solstice");

const planned = Bulk.planBulkAssignResults(mixedSelection, "Millennium class");
const reconciled = Bulk.reconcileBulkAssignResults(
  ["inf", "con", "sum", "sol"],
  planned.map((row) => ({ ...row, ok: true }))
);
assert.equal(reconciled.updated_count, 1);
assert.equal(reconciled.unchanged_count, 3);
assert.equal(reconciled.submitted_count, 4);
assert.equal(reconciled.updated[0].name, "Celebrity Solstice");
assert.ok(reconciled.unchanged.some((row) => row.name === "Celebrity Infinity"));
assert.ok(reconciled.unchanged.some((row) => row.name === "Celebrity Constellation"));
assert.ok(reconciled.unchanged.some((row) => row.name === "Celebrity Summit"));
assert.match(Bulk.formatAssignResultMessage(reconciled), /Updated: Celebrity Solstice/);
assert.match(Bulk.formatAssignResultMessage(reconciled), /Unchanged: Celebrity Infinity, Celebrity Constellation, Celebrity Summit/);
assert.match(Bulk.formatAssignResultPanelHtml(reconciled), /Assignment complete/);
assert.match(Bulk.formatAssignResultPanelHtml(reconciled), /Updated 1 — Celebrity Solstice/);
assert.match(Bulk.formatAssignResultPanelHtml(reconciled), /Unchanged 3 — Celebrity Infinity, Celebrity Constellation, Celebrity Summit/);

// Server results merge into local fleet by ship ID (updated only)
const mergedFleet = Bulk.applyBulkClassResultsToFleet(celebrityFleet, reconciled.results);
assert.equal(mergedFleet.find((ship) => ship.id === "sol").ship_class, "Millennium class");
assert.equal(mergedFleet.find((ship) => ship.id === "inf").ship_class, "Millennium class");
assert.equal(mergedFleet.find((ship) => ship.id === "con").ship_class, "Millennium class");
assert.equal(mergedFleet.find((ship) => ship.id === "sum").ship_class, "Millennium class");

const failedMerge = Bulk.applyBulkClassResultsToFleet(celebrityFleet, [
  { id: "sol", outcome: "failed", new_class: "Millennium class", name: "Celebrity Solstice" }
]);
assert.equal(failedMerge.find((ship) => ship.id === "sol").ship_class, "Solstice class");

const unchangedOnlyMerge = Bulk.applyBulkClassResultsToFleet(celebrityFleet, [
  { id: "inf", outcome: "unchanged", new_class: "Millennium class", name: "Celebrity Infinity" }
]);
assert.equal(unchangedOnlyMerge.find((ship) => ship.id === "inf").ship_class, "Millennium class");

// Post-success modal classification recalculates from refreshed fleet
const postSuccessSelection = mergedFleet.filter((ship) => ["inf", "con", "sum", "sol"].includes(ship.id));
const postSuccessSummary = Bulk.buildAssignmentSummary(postSuccessSelection, "Millennium class");
assert.equal(postSuccessSummary.selectedCount, 4);
assert.equal(postSuccessSummary.newCount, 0);
assert.equal(postSuccessSummary.replaceCount, 0);
assert.equal(postSuccessSummary.unchangedCount, 4);
assert.equal(postSuccessSummary.changeCount, 0);
assert.equal(
  Bulk.canApplyClassAssignment({
    selectedCount: postSuccessSummary.selectedCount,
    shipClass: "Millennium class",
    changeCount: postSuccessSummary.changeCount,
    replaceCount: postSuccessSummary.replaceCount,
    replacementConfirmed: false
  }),
  false
);
assert.equal(
  Bulk.applyClassButtonLabel({
    selectedCount: postSuccessSummary.selectedCount,
    changeCount: postSuccessSummary.changeCount
  }),
  "No changes to apply"
);
assert.equal(
  Bulk.validateBulkAssignRequest({
    cruiseLineId: LINE_CELEB,
    shipIds: ["inf", "con", "sum", "sol"],
    shipClass: "Millennium class",
    ships: mergedFleet,
    replacementConfirmed: false
  }).error,
  "NO_CHANGES_TO_APPLY"
);

// Same-class copy targets recalculate after class assignment
const solsticeSource = mergedFleet.find((ship) => ship.id === "sol");
const millenniumTargets = CiFac.listSameClassCopyTargets(mergedFleet, solsticeSource, "Millennium class");
assert.ok(millenniumTargets.some((ship) => ship.id === "inf"));
assert.ok(millenniumTargets.some((ship) => ship.id === "con"));
assert.ok(!millenniumTargets.some((ship) => ship.id === "sol"));

const allUnchanged = Bulk.validateBulkAssignRequest({
  cruiseLineId: LINE_CELEB,
  shipIds: ["inf", "con", "sum"],
  shipClass: "Millennium class",
  ships: celebrityFleet,
  replacementConfirmed: false
});
assert.equal(allUnchanged.error, "NO_CHANGES_TO_APPLY");

const soloCurrentShip = Bulk.validateBulkAssignRequest({
  cruiseLineId: LINE_CELEB,
  shipIds: ["mill"],
  shipClass: "Millennium class",
  ships: celebrityFleet,
  replacementConfirmed: false
});
assert.equal(soloCurrentShip.error, "NO_CHANGES_TO_APPLY");

const unassignedOnly = Bulk.buildAssignmentSummary(
  celebrityFleet.filter((ship) => ship.id === "unassigned"),
  "Millennium class"
);
assert.equal(unassignedOnly.replaceCount, 0);
assert.equal(unassignedOnly.changeCount, 1);
assert.equal(
  Bulk.canApplyClassAssignment({
    selectedCount: 1,
    shipClass: "Millennium class",
    changeCount: unassignedOnly.changeCount,
    replaceCount: unassignedOnly.replaceCount,
    replacementConfirmed: false
  }),
  true
);

// Clear class
assert.equal(Bulk.canClearClassAssignment({ selectedCount: 1, shipsWithClassCount: 0 }), false);
assert.equal(Bulk.canClearClassAssignment({ selectedCount: 2, shipsWithClassCount: 1 }), true);
const clearValidation = Bulk.validateBulkClearRequest({
  cruiseLineId: LINE_CELEB,
  shipIds: ["royal"],
  ships: celebrityFleet
});
assert.equal(clearValidation.error, "TARGET_LINE_MISMATCH");

// Confirm messages list exact ships
const summary = Bulk.buildAssignmentSummary(
  celebrityFleet.filter((ship) => ["mill", "sol", "unassigned"].includes(ship.id)),
  "Millennium class"
);
assert.match(Bulk.buildAssignConfirmMessage({ cruiseLineName: "Celebrity Cruises", shipClass: "Millennium class", summary }), /Celebrity Millennium/);
assert.match(Bulk.buildAssignConfirmMessage({ cruiseLineName: "Celebrity Cruises", shipClass: "Millennium class", summary }), /Changing from another class: 1/);

// Same-class copy targets refresh after assignment (simulated local merge)
const edgeSource = celebrityFleet.find((ship) => ship.id === "apex");
let workingFleet = celebrityFleet.map((ship) => ({ ...ship }));
const beforeTargets = CiFac.listSameClassCopyTargets(workingFleet, edgeSource, "Edge class");
assert.ok(beforeTargets.some((ship) => ship.id === "bynd"));

workingFleet = workingFleet.map((ship) =>
  ship.id === "unassigned" ? { ...ship, ship_class: "Edge class" } : ship
);
const afterTargets = CiFac.listSameClassCopyTargets(workingFleet, edgeSource, "Edge class");
assert.equal(afterTargets.length, beforeTargets.length + 1);
assert.ok(afterTargets.some((ship) => ship.id === "unassigned"));

// Admin markers
assert.match(adminJs, /Manage ship classes/);
assert.match(adminJs, /Assign this class to other ships/);
assert.match(adminJs, /openCiBulkShipClassModalFromLine/);
assert.match(adminJs, /openCiBulkShipClassModalFromShip/);
assert.match(adminJs, /applyCiBulkClassAssignmentResults/);
assert.match(adminBulkJs, /Assign ship class/);
assert.match(adminBulkJs, /ci-ship-class-bulk-assign/);
assert.match(adminBulkJs, /Clear class from selected ships/);
assert.match(read("css/admin.css"), /\.ci-bulk-class-modal/);

require(path.join(root, "netlify/functions/ci-ship-class-bulk-assign.js"));
require(path.join(root, "netlify/functions/lib/ci-ship-class-bulk-assign.js"));

assert.match(adminBulkJs, /Assignment cancelled/);
assert.match(adminBulkJs, /Clear class cancelled/);
assert.match(adminBulkJs, /NO_CHANGES_TO_APPLY/);
assert.match(adminBulkJs, /reconcileBulkAssignResults/);
assert.match(adminBulkJs, /formatAssignResultPanelHtml/);
assert.match(adminBulkJs, /lastAssignmentResult/);
assert.match(adminBulkJs, /No changes to apply/);
assert.match(adminBulkJs, /applyBtn\?\.disabled/);
assert.match(adminJs, /outcome !== "updated"/);
assert.match(adminJs, /ciBulkShipClassOverlay/);
assert.match(adminJs, /syncCiCatalogueWindowState/);
assert.match(adminJs, /window\.ciCruiseLines = ciCruiseLines/);
assert.match(read("css/admin.css"), /ci-bulk-class-result-panel/);
assert.match(read("css/admin.css"), /ci-bulk-class-modal-actions \.admin-button:disabled/);
assert.match(read("netlify/functions/ci-ship-class-bulk-assign.js"), /NO_CHANGES_TO_APPLY/);
assert.match(read("netlify/functions/ci-ship-class-bulk-assign.js"), /failed_count/);
assert.match(read("netlify/functions/ci-ship-class-bulk-assign.js"), /ship_class: shipClass/);
assert.doesNotMatch(read("netlify/functions/ci-ship-class-bulk-assign.js"), /facilities/);

console.log("test-ship-class-assignment.mjs: all checks passed");
