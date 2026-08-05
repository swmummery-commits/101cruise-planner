#!/usr/bin/env node
/**
 * Cruise line feature catalogue + class template checkbox assignment tests.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function loadGlobalModule(rel) {
  const sandbox = { globalThis: {}, window: {}, module: { exports: {} } };
  sandbox.window = sandbox.globalThis;
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read(rel), sandbox, { filename: path.basename(rel) });
  return sandbox.globalThis;
}

const svcSandbox = loadGlobalModule("js/cruise-line-features-service.js");
const Service = svcSandbox.CruiseLineFeaturesService;
const t = Service.__test__;

const catalogue = [
  {
    id: "ea-1",
    cruise_line_id: "line-a",
    feature_type: "exclusive_area",
    name: "The Haven",
    normalized_name: "the haven",
    description: "Suite enclave",
    icon_key: "crown",
    display_order: 10,
    is_active: true
  },
  {
    id: "sf-1",
    cruise_line_id: "line-a",
    feature_type: "specialty_feature",
    name: "Cagney's Steakhouse",
    normalized_name: "cagney's steakhouse",
    description: "",
    icon_key: "dining",
    display_order: 10,
    is_active: true
  },
  {
    id: "sf-2",
    cruise_line_id: "line-a",
    feature_type: "specialty_feature",
    name: "Mandara Spa",
    normalized_name: "mandara spa",
    description: "Full-service spa",
    icon_key: "spa",
    display_order: 20,
    is_active: true
  }
];

// Sorting + filtering
assert.equal(t.filterByType(catalogue, "exclusive_area").length, 1);
assert.equal(t.filterByType(catalogue, "specialty_feature").length, 2);

// Template payload from checkbox selection
{
  const payload = t.buildTemplatePayloadFromCatalogue(catalogue, ["ea-1", "sf-2"]);
  assert.equal(payload.exclusive_areas.length, 1);
  assert.equal(payload.exclusive_areas[0].name, "The Haven");
  assert.equal(payload.specialty_features.length, 1);
  assert.equal(payload.specialty_features[0].name, "Mandara Spa");
  assert.equal(payload.specialty_features[0].icon_key, "spa");
}

// Derive selected ids from saved template
{
  const ids = t.deriveSelectedIdsFromTemplate(catalogue, {
    exclusive_areas: [{ name: "The Haven", icon_key: "crown" }],
    specialty_features: [{ name: "Cagney's Steakhouse", icon_key: "dining" }]
  });
  assert.deepEqual(ids.sort(), ["ea-1", "sf-1"].sort());
}

// Orphan detection
{
  const orphans = t.orphanTemplateItems(catalogue, {
    exclusive_areas: [{ name: "Legacy Lounge" }],
    specialty_features: [{ name: "Cagney's Steakhouse" }]
  });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].name, "Legacy Lounge");
}

// Validation
{
  const bad = t.buildCreatePayload({
    name: "",
    feature_type: "exclusive_area",
    cruise_line_id: "line-a",
    existingRows: catalogue
  });
  assert.equal(bad.ok, false);
  const good = t.buildCreatePayload({
    name: "Vibe Beach Club",
    feature_type: "specialty_feature",
    cruise_line_id: "line-a",
    existingRows: catalogue
  });
  assert.equal(good.ok, true);
  assert.equal(good.payload.display_order, 30);
}

// Merge / remove helpers for feature assignment
{
  const merged = t.mergeFeatureIntoTemplatePayload(
    {
      exclusive_areas: [{ name: "The Haven", icon_key: "crown" }],
      specialty_features: []
    },
    "specialty_feature",
    { name: "Mandara Spa", icon_key: "spa", description: "Full-service spa" }
  );
  assert.equal(merged.specialty_features.length, 1);
  assert.equal(merged.specialty_features[0].name, "Mandara Spa");
  assert.equal(merged.exclusive_areas.length, 1);

  const updated = t.mergeFeatureIntoTemplatePayload(merged, "exclusive_area", {
    name: "The Haven",
    icon_key: "crown",
    description: "Suite enclave"
  });
  assert.equal(updated.exclusive_areas.length, 1);
  assert.equal(updated.exclusive_areas[0].description, "Suite enclave");

  const removed = t.removeFeatureFromTemplatePayload(updated, "specialty_feature", "Mandara Spa");
  assert.equal(removed.specialty_features.length, 0);
  assert.equal(removed.exclusive_areas.length, 1);

  const shipFacilities = t.mergeFeatureIntoShipFacilities(
    { pools: 3, exclusive_areas: [{ name: "The Haven", icon_key: "crown" }] },
    "specialty_feature",
    { name: "Cagney's Steakhouse", icon_key: "dining" }
  );
  assert.equal(shipFacilities.pools, 3);
  assert.equal(shipFacilities.specialty_features.length, 1);
  assert.equal(t.shipHasFeature({ facilities: shipFacilities }, "specialty_feature", "Cagney's Steakhouse"), true);

  const without = t.removeFeatureFromShipFacilities(shipFacilities, "specialty_feature", "Cagney's Steakhouse");
  assert.equal(without.specialty_features, undefined);
  assert.equal(t.shipHasFeature({ facilities: without }, "specialty_feature", "Cagney's Steakhouse"), false);
  assert.equal(without.exclusive_areas.length, 1);
}

const adminJs = read("js/admin.js");
const adminTplJs = read("js/admin-ship-class-facilities-template.js");
const adminLineFeaturesJs = read("js/admin-cruise-line-features.js");
const adminHtml = read("admin.html");
const adminCss = read("css/admin.css");
const featureAdminJs = read("js/ci-ship-feature-admin.js");
const iconsJs = read("js/ci-ship-feature-icons.js");
const migration = read("supabase/migrations/20260806_ci_cruise_line_features.sql");
const netlifyFn = read("netlify/functions/cruise-line-features.js");

assert.ok(adminHtml.includes("cruise-line-features-service.js"));
assert.ok(adminHtml.includes("admin-cruise-line-features.js"));
assert.ok(adminLineFeaturesJs.includes("CruiseLineFeaturesAdmin.startCreate"));
assert.ok(adminLineFeaturesJs.includes("CruiseLineFeaturesAdmin.startEdit"));
assert.ok(adminLineFeaturesJs.includes("CruiseLineFeaturesAdmin.deleteFeature"));
assert.ok(adminLineFeaturesJs.includes("startCreate,"));
assert.ok(adminLineFeaturesJs.includes("renderAssignmentSection"));
assert.ok(adminLineFeaturesJs.includes("ci-line-feature-class-cb"));
assert.ok(adminLineFeaturesJs.includes("ci-line-feature-ship-cb"));
assert.ok(adminLineFeaturesJs.includes("saveClassAssignments"));
assert.ok(adminLineFeaturesJs.includes("saveShipAssignments"));
assert.ok(adminLineFeaturesJs.includes("saveMoveFromDom"));
assert.ok(adminLineFeaturesJs.includes("migrateFeatureTypeAssignments"));
assert.ok(adminLineFeaturesJs.includes("findDraggedRow"));
assert.ok(!adminLineFeaturesJs.includes("dragged.parentElement !== list"));
assert.ok(netlifyFn.includes("payload.feature_type = nextType"));
assert.ok(adminJs.includes("window.renderAdmin = renderAdmin"));
assert.ok(adminTplJs.includes("ci-class-tpl-feature-cb"));
assert.ok(adminTplJs.includes("usesCatalogueMode"));
assert.ok(adminTplJs.includes("renderCatalogueSection"));
assert.match(featureAdminJs, /ci-ship-feature-icon-option-label/);
assert.match(iconsJs, /label: "Spa"/);
assert.match(iconsJs, /spa:\s*\{[\s\S]*?M4 15h16/);
assert.match(iconsJs, /zodiac:\s*\{/);
assert.ok(migration.includes("ci_cruise_line_features"));
assert.ok(netlifyFn.includes('action === "reorder"'));
assert.ok(adminCss.includes(".ci-class-tpl-feature-list"));
assert.ok(adminCss.includes(".ci-line-features-panel"));

// Icon picker must be exported — renderFeatureForm calls it when Add/Edit opens.
assert.equal(typeof loadGlobalModule("js/ci-ship-feature-admin.js").CiShipFeatureAdmin.renderIconPicker, "function");

{
  const sandbox = { globalThis: {}, window: {}, module: { exports: {} } };
  sandbox.window = sandbox.globalThis;
  sandbox.exports = sandbox.module.exports;
  for (const rel of [
    "js/ci-ship-feature-icons.js",
    "js/ci-ship-class-facilities-template.js",
    "js/cruise-line-features-service.js",
    "js/ci-ship-feature-admin.js",
    "js/admin-cruise-line-features.js"
  ]) {
    vm.runInNewContext(read(rel), sandbox, { filename: path.basename(rel) });
  }
  const g = sandbox.globalThis;
  g.esc = (v) => String(v ?? "");
  g.ciCruiseShips = [{ id: "s1", cruise_line_id: "line1", name: "Ship A", ship_class: "Solstice" }];
  g.ciShipClassFacilityTemplates = [];
  g.setCiLineTab = function () {};
  g.renderCiAdmin = function () {
    g._sectionHtml = g.CruiseLineFeaturesAdmin.renderSection({ id: "line1", name: "Test Line" });
  };
  g.CruiseLineFeaturesService.listFeaturesForLine = async () => [
    {
      id: "f1",
      cruise_line_id: "line1",
      feature_type: "exclusive_area",
      name: "Blu",
      icon_key: "dining",
      is_active: true
    }
  ];
  await g.CruiseLineFeaturesAdmin.loadForLine("line1", { rerenderOnComplete: false });
  g.CruiseLineFeaturesAdmin.startCreate("exclusive_area");
  assert.ok(String(g._sectionHtml || "").includes("ci-line-feature-form"), "Add should render feature form");
  assert.ok(String(g._sectionHtml || "").includes("Add exclusive area"), "Add form title should render");
  g.CruiseLineFeaturesAdmin.startEdit("f1");
  assert.ok(String(g._sectionHtml || "").includes("Edit feature"), "Edit should render feature form");
}

console.log("test-cruise-line-features: all assertions passed");
