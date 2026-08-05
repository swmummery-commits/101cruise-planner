#!/usr/bin/env node
/**
 * Stateroom total reconciliation — focused offline tests.
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

function loadReconciliation() {
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read("js/ci-ship-stateroom-reconciliation.js"), sandbox, {
    filename: "ci-ship-stateroom-reconciliation.js"
  });
  return sandbox.module.exports;
}

const Reconcile = loadReconciliation();
const plannerJs = read("js/planner.js");
const shipPresentationJs = read("js/ci-ship-presentation.js");
const shipCss = read("css/ci-ship-presentation.css");
const adminJs = read("js/admin.js");

const millenniumBreakdown = [
  { label: "Inside", count: 212 },
  { label: "Oceanview", count: 244 },
  { label: "Balcony", count: 573 },
  { label: "Suites", count: 50 },
  { label: "Owners Suites", count: 25 }
];

function cloneBreakdown(rows) {
  return rows.map((row) => ({ ...row }));
}

// A. Celebrity Millennium
{
  const source = { stateroomCount: 1079, stateroomBreakdown: cloneBreakdown(millenniumBreakdown) };
  const before = JSON.stringify(source.stateroomBreakdown);
  const result = Reconcile.reconcileStateroomDisplay(source);
  assert.equal(result.status, "mismatch");
  assert.equal(result.authoritativeTotal, 1079);
  assert.equal(result.rawBreakdownSum, 1104);
  assert.equal(result.totalsMatch, false);
  assert.equal(result.centreMode, "blank");
  assert.equal(result.canRenderDonut, true);
  assert.equal(result.renderedCategories.length, 5);
  assert.equal(
    JSON.stringify(result.renderedCategories.map((row) => ({ label: row.label, count: row.count }))),
    JSON.stringify(cloneBreakdown(millenniumBreakdown))
  );
  assert.ok(result.renderedCategories.some((row) => row.label === "Owners Suites" && row.count === 25));
  assert.equal(JSON.stringify(source.stateroomBreakdown), before, "source breakdown must not mutate");
}

// B. Exact match
{
  const result = Reconcile.reconcileStateroomDisplay({
    stateroomCount: 1691,
    stateroomBreakdown: [
      { label: "Inside", count: 400 },
      { label: "Balcony", count: 1291 }
    ]
  });
  assert.equal(result.status, "exact");
  assert.equal(result.canRenderDonut, true);
  assert.equal(result.centreMode, "total");
  assert.equal(result.totalsMatch, true);
  assert.equal(result.authoritativeTotal, 1691);
}

// C. Breakdown below total
{
  const source = {
    stateroomCount: 1000,
    stateroomBreakdown: [{ label: "Balcony", count: 940 }]
  };
  const before = JSON.stringify(source);
  const result = Reconcile.reconcileStateroomDisplay(source);
  assert.equal(result.status, "mismatch");
  assert.equal(result.canRenderDonut, true);
  assert.equal(result.centreMode, "blank");
  assert.equal(result.renderedCategories.length, 1);
  assert.ok(!result.renderedCategories.some((row) => /other/i.test(row.label)));
  assert.equal(JSON.stringify(source), before);
}

// D. Breakdown above total
{
  const result = Reconcile.reconcileStateroomDisplay({
    stateroomCount: 875,
    stateroomBreakdown: [
      { label: "Inside", count: 150 },
      { label: "Balcony", count: 887 },
      { label: "Oceanview", count: 199 },
      { label: "Suites", count: 21 }
    ]
  });
  assert.equal(result.status, "mismatch");
  assert.equal(result.canRenderDonut, true);
  assert.equal(result.centreMode, "blank");
  assert.equal(result.renderedCategories.length, 4);
}

// E. Breakdown without published total
{
  const result = Reconcile.reconcileStateroomDisplay({
    stateroomCount: null,
    stateroomBreakdown: [{ label: "Balcony", count: 500 }]
  });
  assert.equal(result.status, "mismatch");
  assert.equal(result.canRenderDonut, true);
  assert.equal(result.centreMode, "blank");
  assert.equal(result.authoritativeTotal, null);
}

// F. No valid breakdown
{
  const result = Reconcile.reconcileStateroomDisplay({
    stateroomCount: 1079,
    stateroomBreakdown: []
  });
  assert.equal(result.status, "no_breakdown");
  assert.equal(result.canRenderDonut, false);
}

// Invalid and duplicate categories
{
  const invalid = Reconcile.reconcileStateroomDisplay({
    stateroomCount: 100,
    stateroomBreakdown: [{ label: "Balcony", count: -5 }]
  });
  assert.equal(invalid.canRenderDonut, false);

  const validation = Reconcile.validateStateroomSave({
    stateroomCount: 100,
    stateroomBreakdown: [
      { label: "Balcony", count: 50 },
      { label: "balcony", count: 50 }
    ]
  });
  assert.ok(validation.errors.some((msg) => /duplicate/i.test(msg)));
}

// Planner wiring
assert.match(shipPresentationJs, /reconciliation\.centreMode === "total"/);
assert.match(shipPresentationJs, /ship-donut-centre.*is-blank/);
assert.match(shipPresentationJs, /renderShipAccommodationChart\(profile\.stateroomReconciliation, profile\.accommodation\)/);
assert.match(plannerJs, /CiShipPresentation\.renderPresentationHtml/);

// Admin messaging
{
  const exact = Reconcile.reconcileStateroomDisplay({ stateroomCount: 100, stateroomBreakdown: [{ label: "Balcony", count: 100 }] });
  assert.match(exact.publicDisplayStatus, /centre will show the published stateroom total/i);

  const mismatch = Reconcile.reconcileStateroomDisplay({ stateroomCount: 1079, stateroomBreakdown: cloneBreakdown(millenniumBreakdown) });
  assert.match(mismatch.publicDisplayStatus, /retain all room-type categories/i);
  assert.doesNotMatch(mismatch.publicDisplayStatus, /omit/i);
  assert.doesNotMatch(mismatch.publicDisplayStatus, /Other/i);
  assert.doesNotMatch(mismatch.publicDisplayStatus, /hidden/i);
}

assert.match(adminJs, /renderCiStateroomReconcilePanel/);
assert.match(adminJs, /validateStateroomSave/);
assert.match(adminJs, /ci-stateroom-sqm/);

// Optional sqm is preserved through reconciliation
{
  const result = Reconcile.reconcileStateroomDisplay({
    stateroomCount: 100,
    stateroomBreakdown: [
      { label: "Balcony", count: 60, sqm: 18.5 },
      { label: "Suite", count: 40 }
    ]
  });
  assert.equal(result.status, "exact");
  assert.equal(result.renderedCategories[0].sqm, 18.5);
  assert.equal(result.renderedCategories[1].sqm, undefined);
}

for (const pattern of ["@media \\(max-width: 980px\\)", "@media \\(max-width: 900px\\)", "@media \\(max-width: 760px\\)"]) {
  assert.match(shipCss, new RegExp(pattern), `${pattern} styles present`);
}
assert.match(shipCss, /\.ship-donut-centre\.is-blank/, "blank centre styles present");

console.log("test-ship-stateroom-reconciliation: all tests passed");
