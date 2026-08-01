#!/usr/bin/env node
/**
 * get-ship facilities data-path tests — Supabase preference over Base44 placeholders.
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
  const Icons = (() => {
    const sandbox = { module: { exports: {} }, exports: {}, require };
    sandbox.exports = sandbox.module.exports;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(read("js/ci-ship-feature-icons.js"), sandbox, { filename: "ci-ship-feature-icons.js" });
    return sandbox.module.exports;
  })();
  const sandbox = { module: { exports: {} }, exports: {}, require, CiShipFeatureIcons: Icons };
  sandbox.exports = sandbox.module.exports;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("js/ci-ship-facilities.js"), sandbox, { filename: "ci-ship-facilities.js" });
  return sandbox.module.exports;
}

const getShip = require(path.join(root, "netlify/functions/get-ship.js"));
const { resolveCruiseShip } = require(path.join(root, "netlify/functions/lib/resolve-cruise-ship.js"));
const CiFac = loadCiShipFacilities();
const adminJs = read("js/admin.js");
const getShipJs = read("netlify/functions/get-ship.js");

const MILLENNIUM_CI_ID = "9d1a3655-be39-405c-9e00-96d7bb4925c7";
const MILLENNIUM_BASE44_ID = "68d79b4402deb88d73799ee5";

const millenniumCi = {
  id: MILLENNIUM_CI_ID,
  name: "Celebrity Millennium",
  cruise_line_name: "Celebrity Cruises",
  legacy_base44_id: MILLENNIUM_BASE44_ID,
  facilities: {
    exclusive_areas: [
      { name: "The Retreat", description: "Suite enclave.", icon_key: "crown" },
      { name: "Blu", description: "AquaClass restaurant.", icon_key: "private-dining" },
      { name: "Persian Garden", description: "Thermal suite copy.", icon_key: "garden" }
    ],
    specialty_features: [
      { name: "The Solarium", description: "Pool and loungers.", icon_key: "lounge" },
      { name: "Fitness Center", description: "Cardio and weights.", icon_key: "fitness" },
      { name: "The Spa", description: "Treatments.", icon_key: "spa" },
      { name: "Movement Studio", description: "Classes.", icon_key: "fitness" },
      { name: "Le Petit Chef", icon_key: "sparkles" },
      { name: "The Martini Bar & Crush", icon_key: "drinks" },
      { name: "Sunset Bar", icon_key: "drinks" }
    ]
  }
};

const base44Placeholder = {
  id: MILLENNIUM_BASE44_ID,
  name: "Celebrity Millennium",
  facilities: {
    exclusive_areas: ["Suite Deck", "Premium Lounge", "The Retreat, legacy sentence."],
    specialty_features: ["Main Pool", "Fitness Center"]
  }
};

// Supabase select must not require missing optional columns
assert.doesNotMatch(getShip.__test.SUPABASE_SHIP_SELECT, /beam_metres/);
assert.doesNotMatch(getShip.__test.SUPABASE_SHIP_SELECT, /cruising_speed_knots/);
assert.match(getShip.__test.SUPABASE_SHIP_SELECT, /legacy_base44_id/);

// Legacy Base44 bridge prefers CI curated facilities
const bridged = getShip.__test.findCiShipByLegacyBase44Id([millenniumCi], MILLENNIUM_BASE44_ID);
assert.equal(bridged.id, MILLENNIUM_CI_ID);
assert.equal(bridged.facilities.exclusive_areas.length, 3);
assert.equal(bridged.facilities.specialty_features.length, 7);
assert.ok(!bridged.facilities.exclusive_areas.includes("Suite Deck"));

// Name resolution for Millennium on Celebrity line
const resolved = resolveCruiseShip([millenniumCi], "Millennium", "Celebrity Cruises", []);
assert.equal(resolved.status, "matched");
assert.equal(resolved.ship.id, MILLENNIUM_CI_ID);

// Curated facilities beat placeholders at customer normalisation boundary
const displayEa = CiFac.normalizeExclusiveAreasForDisplay(millenniumCi.facilities.exclusive_areas);
const displaySf = CiFac.normalizeSpecialtyFeaturesForDisplay(millenniumCi.facilities.specialty_features);
assert.equal(displayEa.length, 3);
assert.equal(displaySf.length, 7);
assert.equal(displayEa[0].name, "The Retreat");
assert.equal(displaySf[6].name, "Sunset Bar");
assert.equal(displaySf[6].description, "");

const legacyEa = CiFac.normalizeExclusiveAreasForDisplay(base44Placeholder.facilities.exclusive_areas);
assert.ok(legacyEa.some((row) => row.name === "Suite Deck"));

// Hyphenated names without space-hyphen-space stay intact
const intact = CiFac.loadSpecialtyFeaturesForAdmin(["State-of-the-art Gym"]);
assert.equal(intact[0].name, "State-of-the-art Gym");

// Legacy hyphen specialty strings split for Admin load only
const hyphenLoaded = CiFac.loadSpecialtyFeaturesForAdmin([
  "Fitness Center - Equipped with modern cardio gear, free weights, and strength machines.",
  "Le Petit Chef"
]);
assert.equal(hyphenLoaded[0].name, "Fitness Center");
assert.match(hyphenLoaded[0].description, /cardio gear/);
assert.match(hyphenLoaded[0].description, /, and strength machines\./);
assert.equal(hyphenLoaded[1].name, "Le Petit Chef");
assert.equal(hyphenLoaded[1].description, "");

// Admin structured editors + icon picker wiring
assert.match(adminJs, /renderCiSpecialtyFeatureRow/);
assert.match(adminJs, /CiShipFeatureAdmin/);
assert.match(read("js/ci-ship-feature-admin.js"), /ci-ship-feature-icon-picker/);
assert.match(adminJs, /rebuildCiSpecialtyFeaturesDom/);
assert.doesNotMatch(adminJs, /ci-specialty-feature-label/);

// get-ship cache header remains no-store
assert.match(getShipJs, /Cache-Control.*no-store/);

console.log("test-get-ship-facilities: all tests passed");
