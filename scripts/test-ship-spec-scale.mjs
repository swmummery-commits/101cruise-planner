#!/usr/bin/env node
/**
 * Ship Specifications and Ship Scale — focused offline tests.
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

function loadSpecScale() {
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(read("js/ci-ship-spec-scale.js"), sandbox, {
    filename: "ci-ship-spec-scale.js"
  });
  return sandbox.module.exports;
}

const SpecScale = loadSpecScale();
const plannerJs = read("js/planner.js");
const shipPresentationJs = read("js/ci-ship-presentation.js");
const shipCss = read("css/ci-ship-presentation.css");
const adminJs = read("js/admin.js");
const css = read("css/planner.css");

const fullShip = {
  deck_count: 12,
  passenger_capacity: 1432,
  crew_count: 650,
  gross_tonnage: 60906,
  length_meters: 238,
  beam_metres: 32,
  cruising_speed_knots: 21
};

// Ship Specifications order and membership
{
  const rows = SpecScale.buildShipSpecificationRows(fullShip);
  assert.equal(
    JSON.stringify(rows.map((row) => row.label)),
    JSON.stringify(["Total decks", "Passengers", "Crew", "Guest-to-crew ratio"])
  );
  assert.equal(rows[3].value, "2.2 : 1");
  assert.ok(!rows.some((row) => /stateroom/i.test(row.label)));
  assert.ok(!rows.some((row) => /gross tonnage/i.test(row.label)));
  assert.ok(!rows.some((row) => /length/i.test(row.label)));
}

// Ship Scale order and membership
{
  const rows = SpecScale.buildShipScaleRows(fullShip);
  assert.equal(
    JSON.stringify(rows.map((row) => row.label)),
    JSON.stringify(["Gross tonnage", "Length", "Width (beam)", "Cruising speed", "Space ratio"])
  );
  assert.equal(rows[0].value, "60,906 GT");
  assert.equal(rows[1].value, "238 metres");
  assert.equal(rows[2].value, "32 metres");
  assert.equal(rows[3].value, "21 knots");
  assert.equal(rows[4].value, "42.5 GT per guest");
  assert.equal(rows[4].interpretation, "Comfortably spacious");
  assert.ok(!rows.some((row) => /total decks|max guests|^crew$/i.test(row.label)));
  assert.ok(!rows.some((row) => /guest-to-crew/i.test(row.label)));
}

// Guest-to-crew ratio hides on invalid inputs
{
  assert.equal(SpecScale.buildGuestToCrewRatio(null, 650), null);
  assert.equal(SpecScale.buildGuestToCrewRatio(1432, 0), null);
  assert.equal(SpecScale.buildGuestToCrewRatio(1432, -5), null);
}

// Space ratio calculation and boundaries
{
  const ratio = SpecScale.buildSpaceRatio(60906, 1432);
  assert.ok(ratio);
  assert.equal(ratio.value, "42.5 GT per guest");
  assert.equal(SpecScale.classifySpaceRatio(29.9), "Compact and lively");
  assert.equal(SpecScale.classifySpaceRatio(30), "Standard spaciousness");
  assert.equal(SpecScale.classifySpaceRatio(40.9), "Standard spaciousness");
  assert.equal(SpecScale.classifySpaceRatio(41), "Comfortably spacious");
  assert.equal(SpecScale.classifySpaceRatio(50.9), "Comfortably spacious");
  assert.equal(SpecScale.classifySpaceRatio(51), "Very spacious");
  assert.equal(SpecScale.classifySpaceRatio(75), "Very spacious");
  assert.equal(SpecScale.classifySpaceRatio(75.1), "Exceptionally spacious");
  assert.equal(SpecScale.buildSpaceRatio(null, 1432), null);
  assert.equal(SpecScale.buildSpaceRatio(60906, null), null);
  assert.equal(SpecScale.buildSpaceRatio(0, 1432), null);
}

// Missing rows omitted cleanly
{
  const noBeam = SpecScale.buildShipScaleRows({
    gross_tonnage: 60906,
    length_meters: 238,
    passenger_capacity: 1432,
    cruising_speed_knots: 21
  });
  assert.equal(
    JSON.stringify(noBeam.map((row) => row.label)),
    JSON.stringify(["Gross tonnage", "Length", "Cruising speed", "Space ratio"])
  );

  const noSpeed = SpecScale.buildShipScaleRows({
    gross_tonnage: 60906,
    length_meters: 238,
    beam_metres: 32,
    passenger_capacity: 1432
  });
  assert.ok(!noSpeed.some((row) => /cruising speed/i.test(row.label)));

  const noTonnage = SpecScale.buildShipScaleRows({
    length_meters: 238,
    beam_metres: 32,
    passenger_capacity: 1432
  });
  assert.ok(!noTonnage.some((row) => /space ratio/i.test(row.label)));

  const noPassengers = SpecScale.buildShipSpecificationRows({
    deck_count: 12,
    crew_count: 650
  });
  assert.equal(
    JSON.stringify(noPassengers.map((row) => row.label)),
    JSON.stringify(["Total decks", "Crew"])
  );
  assert.ok(!noPassengers.some((row) => /guest-to-crew/i.test(row.label)));
}

// Cruising speed presentation formatting
{
  assert.equal(SpecScale.formatCruisingSpeedKnots(21), "21 knots");
  assert.equal(SpecScale.formatCruisingSpeedKnots(21.0), "21 knots");
  assert.equal(SpecScale.formatCruisingSpeedKnots(20.5), "21 knots");
  assert.equal(SpecScale.formatCruisingSpeedKnots(20.25), "20 knots");
  assert.equal(SpecScale.formatCruisingSpeedKnots(1), "1 knot");
  assert.equal(SpecScale.formatCruisingSpeedKnots(0), null);
  assert.equal(SpecScale.formatCruisingSpeedKnots(-3), null);
  assert.equal(SpecScale.formatCruisingSpeedKnots(null), null);
  assert.ok(!SpecScale.buildShipScaleRows({ gross_tonnage: 1000, length_meters: 200, cruising_speed_knots: 0 }).some((row) => /cruising speed/i.test(row.label)));
}

// Desktop popover positioning
{
  const margin = 12;
  const gap = 8;
  const popoverWidth = 320;
  const popoverHeight = 180;

  const below = SpecScale.computeSpaceRatioPopoverPosition({
    triggerRect: { top: 100, bottom: 120, left: 400, right: 420 },
    anchorRect: { top: 90, bottom: 130, left: 780, right: 980 },
    columnRect: { top: 80, bottom: 420, left: 780, right: 980 },
    avoidRects: [{ top: 80, bottom: 420, left: 400, right: 760 }],
    popoverWidth,
    popoverHeight,
    viewportWidth: 1180,
    viewportHeight: 900,
    margin,
    gap
  });
  assert.equal(below.placement, "below");
  assert.ok(below.top >= margin);
  assert.ok(below.left >= margin);
  assert.ok(below.left + popoverWidth <= 1180 - margin);
  assert.ok(below.left + popoverWidth <= 400 - gap);

  const above = SpecScale.computeSpaceRatioPopoverPosition({
    triggerRect: { top: 820, bottom: 840, left: 900, right: 920 },
    anchorRect: { top: 810, bottom: 850, left: 780, right: 980 },
    columnRect: { top: 700, bottom: 860, left: 780, right: 980 },
    avoidRects: [],
    popoverWidth,
    popoverHeight,
    viewportWidth: 1180,
    viewportHeight: 900,
    margin,
    gap
  });
  assert.equal(above.placement, "above");
  assert.ok(above.top + popoverHeight <= 900 - margin);

  const columnAligned = SpecScale.computeSpaceRatioPopoverPosition({
    triggerRect: { top: 200, bottom: 220, left: 900, right: 920 },
    anchorRect: { top: 190, bottom: 230, left: 780, right: 980 },
    columnRect: { top: 120, bottom: 420, left: 780, right: 980 },
    avoidRects: [{ top: 120, bottom: 420, left: 400, right: 760 }],
    popoverWidth,
    popoverHeight,
    viewportWidth: 1180,
    viewportHeight: 900,
    margin,
    gap
  });
  assert.equal(columnAligned.left, 400 - gap - popoverWidth);
  assert.ok(columnAligned.left + popoverWidth <= 400 - gap);
}

// Planner wiring
assert.match(shipPresentationJs, /CiShipSpecScale/);
assert.match(shipPresentationJs, /renderShipStatRows/);
assert.match(shipPresentationJs, /bindShipSpaceRatioExplainer/);
assert.match(shipPresentationJs, /ship-space-ratio-popover/);
assert.match(shipPresentationJs, /ship-space-ratio-inline-panel/);
assert.match(shipPresentationJs, /portalSpaceRatioPopover/);
assert.match(shipPresentationJs, /restoreSpaceRatioPopover/);
assert.match(shipPresentationJs, /ship-space-ratio-popover--portaled/);
assert.match(shipCss, /\.ship-space-ratio-popover--portaled/);
assert.match(shipCss, /z-index:\s*14000/);
assert.match(shipPresentationJs, /addEventListener\("resize", repositionOpenPopover\)/);
assert.match(plannerJs, /CiShipPresentation\.renderPresentationHtml/);
assert.doesNotMatch(shipPresentationJs, /ship-scale-highlight/);
assert.match(shipCss, /\.ship-stat-list/);
assert.match(shipCss, /\.ship-space-ratio-popover/);
assert.match(shipCss, /\.ship-space-ratio-inline-panel/);
assert.match(shipCss, /@media \(max-width: 760px\)[\s\S]*\.ship-space-ratio-popover[\s\S]*display:\s*none !important/);
assert.match(shipCss, /\.ship-space-ratio-inline-panel:not\(\[hidden\]\)/);

// Admin wiring
assert.match(adminJs, /ciShipBeam/);
assert.match(adminJs, /ciShipCruisingSpeed/);
assert.match(adminJs, /beam_metres/);
assert.match(adminJs, /cruising_speed_knots/);
assert.match(adminJs, /Beam \/ width \(metres\)/);
assert.match(adminJs, /Cruising speed \(knots\)/);
assert.match(adminJs, /20260801_ci_ship_beam_cruising_speed/);
assert.match(adminJs, /noteCiShipSpecSaveMismatch/);
assert.match(adminJs, /refreshCiShipAutosaveStatusDom/);

// Migration documents final field names
const migration = read("supabase/migrations/20260801_ci_ship_beam_cruising_speed.sql");
assert.match(migration, /beam_metres/);
assert.match(migration, /cruising_speed_knots/);
assert.ok(!fs.existsSync(path.join(root, "supabase/migrations/20260802_ci_ship_beam_cruising_speed.sql")));

console.log("test-ship-spec-scale: all tests passed");
