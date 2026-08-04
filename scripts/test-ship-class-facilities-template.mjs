#!/usr/bin/env node
/**
 * Class facilities templates — replace apply, sync status, server-only access markers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const Replace = require(path.join(root, "js/ci-ship-class-facilities-replace.js"));
const ClassTpl = require(path.join(root, "js/ci-ship-class-facilities-template.js"));
const ApplyLib = require(path.join(root, "netlify/functions/lib/ci-ship-class-facilities-apply.js"));
const fixtures = require(path.join(root, "scripts/fixtures/ship-facilities-item-copy-fixtures.js"));
const fleetFixtures = require(path.join(root, "scripts/fixtures/ship-class-facilities-fleet-fixtures.js"));

const adminJs = read("js/admin.js");
const adminTplJs = read("js/admin-ship-class-facilities-template.js");
const adminHtml = read("admin.html");
const adminCss = read("css/admin.css");
const migration = read("supabase/migrations/20260801_ci_ship_class_facility_templates.sql");

const edge = fixtures.ships.find((s) => s.id === "edge");
const apex = fixtures.ships.find((s) => s.id === "apex");
const beyond = fixtures.ships.find((s) => s.id === "beyond");
const millennium = fixtures.ships.find((s) => s.id === "millennium");
const lineId = fixtures.cruiseLine.id;

const edgeTemplate = ClassTpl.extractTemplateFromShip(edge);

// REPLACE — full EA array
{
  const merged = Replace.applyClassTemplateToFacilities(beyond.facilities, edgeTemplate);
  assert.equal(merged.facilities.exclusive_areas.length, 2);
  assert.ok(merged.changed);
  assert.equal(merged.facilities.restaurants, undefined);
}

// REPLACE — full SF array removes ship-only items
{
  const merged = Replace.applyClassTemplateToFacilities(apex.facilities, edgeTemplate);
  assert.ok(!merged.facilities.specialty_features.includes("Solarium"));
  assert.ok(merged.facilities.specialty_features.includes("Magic Carpet"));
  assert.equal(merged.facilities.specialty_features.length, 4);
}

// REPLACE — scalars preserved
{
  const ship = {
    facilities: {
      restaurants: 4,
      pools: 2,
      exclusive_areas: [{ name: "Legacy", description: "Old" }],
      specialty_features: ["Solarium"]
    }
  };
  const merged = Replace.applyClassTemplateToFacilities(ship.facilities, edgeTemplate);
  assert.equal(merged.facilities.restaurants, 4);
  assert.equal(merged.facilities.pools, 2);
  assert.equal(merged.facilities.exclusive_areas.length, 2);
}

// REPLACE — empty EA clears ship EA
{
  const template = { exclusive_areas: [], specialty_features: ["Eden"] };
  const merged = Replace.applyClassTemplateToFacilities(apex.facilities, template);
  assert.deepEqual(merged.facilities.exclusive_areas, []);
  assert.deepEqual(merged.facilities.specialty_features, ["Eden"]);
  assert.equal(merged.changed, true);
}

// REPLACE — empty SF clears ship SF
{
  const template = { exclusive_areas: [{ name: "Blu" }], specialty_features: [] };
  const merged = Replace.applyClassTemplateToFacilities(apex.facilities, template);
  assert.deepEqual(merged.facilities.specialty_features, []);
  assert.equal(merged.changed, true);
}

// COMPARE / SYNC STATUS
{
  const matching = Replace.compareShipFacilitiesToTemplate(edge.facilities, edgeTemplate);
  assert.equal(matching.matches, true);
  const customised = Replace.compareShipFacilitiesToTemplate(apex.facilities, edgeTemplate);
  assert.equal(customised.matches, false);
  const sync = ClassTpl.buildClassSyncSummary({
    ships: fixtures.ships,
    cruiseLineId: lineId,
    className: "Edge class",
    template: { exclusive_areas: edgeTemplate.exclusive_areas, specialty_features: edgeTemplate.specialty_features }
  });
  assert.match(sync.statusLabel, /individually customised|match template/);
  assert.ok(sync.activeCount >= 4);
}

// APPLY PREVIEW — no-op detection
{
  const edgeOnlyMatching = fixtures.ships.filter((s) => s.id === "edge");
  const preview = Replace.summarizeApplyPreview(edgeOnlyMatching, edgeTemplate);
  assert.equal(preview.aggregate.hasChanges, false);
  assert.equal(preview.aggregate.willChangeCount, 0);
}

// CLASS ROWS — member ships
{
  const templates = [{
    id: "tpl-edge",
    cruise_line_id: lineId,
    class_name: "Edge class",
    class_key: ClassTpl.normalizeClassKey("Edge class"),
    exclusive_areas: edgeTemplate.exclusive_areas,
    specialty_features: edgeTemplate.specialty_features
  }];
  const rows = ClassTpl.buildClassShipRows({ ships: fixtures.ships, cruiseLineId: lineId, templates });
  const edgeRow = rows.find((row) => row.className === "Edge class");
  assert.ok(edgeRow);
  assert.ok(edgeRow.memberShipNames.includes("Celebrity Edge"));
  assert.ok(edgeRow.memberShipNames.includes("Celebrity Apex"));
  assert.equal(edgeRow.hasTemplate, true);
}

// SAVE VALIDATION — empty template allowed
{
  const empty = ClassTpl.buildUpsertRecord({
    cruiseLineId: lineId,
    className: "Edge class",
    exclusiveAreas: [],
    specialtyFeatures: []
  });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.record.exclusive_areas, []);
  assert.equal(empty.record.class_key, ClassTpl.normalizeClassKey("Edge class"));
}

// RE-APPLY replaces individual customisations
{
  const customised = Replace.applyClassTemplateToFacilities(apex.facilities, edgeTemplate);
  const customisedFacilities = customised.facilities;
  customisedFacilities.specialty_features = [...customisedFacilities.specialty_features, "Ship-only feature"];
  const reapplied = Replace.applyClassTemplateToFacilities(customisedFacilities, edgeTemplate);
  assert.ok(!reapplied.facilities.specialty_features.includes("Ship-only feature"));
  assert.equal(reapplied.facilities.specialty_features.length, 4);
}

// INACTIVE / OUT OF SCOPE — listShipsInClass activeOnly
{
  const inactive = {
    id: "inactive-edge",
    name: "Inactive Edge",
    cruise_line_id: lineId,
    ship_class: "Edge class",
    active: false,
    facilities: { exclusive_areas: [], specialty_features: [] }
  };
  const targets = ClassTpl.listShipsInClass([...fixtures.ships, inactive], lineId, "Edge class", { activeOnly: true });
  assert.ok(!targets.some((s) => s.id === "inactive-edge"));
}

// FLEET COUNT INVARIANTS — item-copy Celebrity fleet (8 active, fully classified)
{
  const summary = ClassTpl.buildLineFleetSummary({
    ships: fixtures.ships,
    cruiseLineId: lineId,
    templates: []
  });
  assert.equal(summary.activeShipCount, 8);
  assert.equal(summary.totalShipCount, 8);
  assert.equal(summary.unassignedActiveCount, 0);
  assert.equal(summary.classifiedActiveCount, 8);
  assert.equal(summary.activeFleetReconciles, true);
  const check = ClassTpl.assertLineFleetInvariants(summary);
  assert.equal(check.ok, true, check.errors.join(", "));
}

// FLEET COUNT INVARIANTS — reconciled visual-review fleet (14 active + 2 unassigned)
{
  const vrLineId = fleetFixtures.cruiseLine.id;
  const summary = ClassTpl.buildLineFleetSummary({
    ships: fleetFixtures.ships,
    cruiseLineId: vrLineId,
    templates: fleetFixtures.templates
  });
  assert.equal(summary.totalShipCount, fleetFixtures.expected.totalShipCount);
  assert.equal(summary.activeShipCount, fleetFixtures.expected.activeShipCount);
  assert.equal(summary.inactiveShipCount, fleetFixtures.expected.inactiveShipCount);
  assert.equal(summary.unassignedActiveCount, fleetFixtures.expected.unassignedActiveCount);
  assert.equal(summary.classifiedActiveCount, fleetFixtures.expected.classifiedActiveCount);
  assert.equal(summary.activeFleetReconciles, true);
  assert.equal(summary.hasDuplicateClassMembership, false);
  const check = ClassTpl.assertLineFleetInvariants(summary);
  assert.equal(check.ok, true, check.errors.join(", "));
  summary.classRows.forEach((row) => {
    assert.equal(row.activeMemberShipNames.length, row.activeShipCount);
    if (row.hasTemplate) {
      assert.equal(row.matchingCount + row.customisedCount, row.activeShipCount);
    }
  });
  const edgeRow = summary.classRows.find((row) => row.className === "Edge class");
  assert.equal(edgeRow.activeShipCount, 5);
  assert.equal(edgeRow.matchingCount + edgeRow.customisedCount, 5);
  const inactiveInEdge = ClassTpl.listShipsInClass(fleetFixtures.ships, vrLineId, "Edge class", { activeOnly: true });
  assert.equal(inactiveInEdge.length, 5);
  assert.ok(!inactiveInEdge.some((ship) => ship.id === "inactive-a"));
}

// NETLIFY APPLY LIB
{
  const execution = ApplyLib.executeApplyToShip(beyond, edgeTemplate);
  assert.equal(execution.changed, true);
  assert.ok(Array.isArray(execution.facilities.exclusive_areas));
  const validationMissing = ApplyLib.validateApplyRequest({
    cruiseLineId: lineId,
    className: "Edge class",
    storedTemplate: null
  });
  assert.equal(validationMissing.ok, false);
  const validationOk = ApplyLib.validateApplyRequest({
    cruiseLineId: lineId,
    className: "Edge class",
    storedTemplate: {
      exclusive_areas: edgeTemplate.exclusive_areas,
      specialty_features: edgeTemplate.specialty_features
    }
  });
  assert.equal(validationOk.ok, true);
}

// SECURITY — no browser Supabase template access
assert.ok(!adminJs.includes('.from("ci_ship_class_facility_templates")'));
assert.ok(!adminTplJs.includes("supabaseClient"));
assert.ok(adminTplJs.includes("ci-ship-class-facilities-save"));
assert.ok(adminJs.includes("ci-ship-class-facilities-templates"));
assert.ok(adminTplJs.includes("ci-ship-class-facilities-apply"));
assert.ok(!adminTplJs.includes("template: modalContext.draftPayload"));

// MIGRATION — no browser policies
assert.ok(migration.includes("ENABLE ROW LEVEL SECURITY"));
assert.ok(!migration.includes("CREATE POLICY"));
assert.ok(migration.includes("REVOKE ALL"));
assert.ok(migration.includes("class_key"));

// ADMIN UI MARKERS
assert.ok(adminJs.includes("renderCiLineShipClassesSection"));
assert.ok(adminJs.includes("loadCiShipClassFacilityTemplatesForLine"));
assert.ok(adminJs.includes("Individual changes are allowed, but they will be replaced"));
assert.ok(adminJs.includes("Total ships"));
assert.ok(adminJs.includes("activeMemberShipNames"));
assert.ok(adminTplJs.includes("failedRows.length"));
assert.ok(adminTplJs.includes("ciClassTplApplyAck"));
assert.match(
  adminTplJs,
  /data-action="confirm-apply"\$\{noTargets \|\| noChanges \|\| needsSave \? " disabled aria-disabled=\\"true\\"" : " disabled"\}/
);
assert.ok(adminTplJs.includes("ciClassTplImportClass"));
assert.ok(adminTplJs.includes("import-class-selected"));
assert.ok(adminTplJs.includes("mergeExclusiveAreaRows"));
assert.ok(adminTplJs.includes("ci-class-tpl-feature-cb"));

// CLASS IMPORT MERGE
{
  const mergedEa = ClassTpl.mergeExclusiveAreaRows(
    [{ name: "The Retreat", description: "Suite", showDescription: true }],
    [{ name: "Blu", description: "AquaClass", showDescription: true }, { name: "The Retreat", description: "Dup", showDescription: false }]
  );
  assert.equal(mergedEa.length, 2);
  assert.equal(mergedEa[1].name, "Blu");
  const mergedSf = ClassTpl.mergeSpecialtyRows(
    [{ label: "Magic Carpet" }],
    [{ label: "Eden" }, { label: "magic carpet" }]
  );
  assert.equal(mergedSf.length, 2);
  assert.equal(mergedSf[1].label, "Eden");
}

assert.ok(adminTplJs.includes("will be replaced"));
assert.ok(adminHtml.includes("ci-ship-class-facilities-replace.js"));
assert.ok(!adminHtml.includes("ci-ship-class-facilities-merge.js"));
assert.ok(adminCss.includes(".ci-class-row"));

console.log("test-ship-class-facilities-template: all assertions passed");
