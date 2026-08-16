#!/usr/bin/env node
/**
 * Silversea Expedition semantics — Phase E1 tests (prototype, not production-wired).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  SEMANTIC,
  classifyExpeditionStopSemantic,
  isExpeditionSemanticEligible
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));
const { resolveRawPortText } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));
const { classifyItineraryStopKind } = require(path.join(
  root,
  "netlify/functions/lib/silversea-discovery-source"
));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    failed += 1;
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || "assert"}: expected ${expected}, got ${actual}`);
}

test("Galápagos ECG landing site classifies as EXPEDITION_LANDING_SITE", () => {
  const result = classifyExpeditionStopSemantic({ port_name: "Isla Bartolome", port_code: "ECG02" });
  assertEqual(result.semantic, SEMANTIC.EXPEDITION_LANDING_SITE);
  assertEqual(isExpeditionSemanticEligible(result), true);
});

test("Kicker Rock ECG classifies as ANCHORAGE_OR_ZODIAC_SITE", () => {
  const result = classifyExpeditionStopSemantic({ port_name: "Kicker Rock", port_code: "ECG34" });
  assertEqual(result.semantic, SEMANTIC.ANCHORAGE_OR_ZODIAC_SITE);
});

test("Santa Cruz Highlands classifies as LAND_EXCURSION_OR_INLAND_SITE", () => {
  const result = classifyExpeditionStopSemantic({ port_name: "Santa Cruz Highlands", port_code: "ECG12" });
  assertEqual(result.semantic, SEMANTIC.LAND_EXCURSION_OR_INLAND_SITE);
});

test("Antarctic Peninsula AQE classifies as SCENIC_OR_GEOGRAPHIC_REGION", () => {
  const result = classifyExpeditionStopSemantic({ port_name: "Antarctic Peninsula", port_code: "AQE43" });
  assertEqual(result.semantic, SEMANTIC.SCENIC_OR_GEOGRAPHIC_REGION);
});

test("South Shetland Islands AQE classifies as SCENIC_OR_GEOGRAPHIC_REGION", () => {
  const result = classifyExpeditionStopSemantic({ port_name: "South Shetland Islands", port_code: "AQE44" });
  assertEqual(result.semantic, SEMANTIC.SCENIC_OR_GEOGRAPHIC_REGION);
});

test("Ushuaia resolves as existing CONVENTIONAL_PORT", () => {
  const result = classifyExpeditionStopSemantic({ port_name: "Ushuaia", port_code: "ARUSH" });
  assertEqual(result.semantic, SEMANTIC.CONVENTIONAL_PORT);
  assertEqual(result.canonical_port, "Ushuaia");
});

test("Puerto Williams CLWPU classifies as EMBARK_DISEMBARK_LOGISTICS", () => {
  const result = classifyExpeditionStopSemantic({ port_name: "Puerto Williams", port_code: "CLWPU" }, { role: "embark" });
  assertEqual(result.semantic, SEMANTIC.EMBARK_DISEMBARK_LOGISTICS);
});

test("King George Island AQKGI classifies as EMBARK_DISEMBARK_LOGISTICS", () => {
  const result = classifyExpeditionStopSemantic({ port_name: "King George Island", port_code: "AQKGI" }, { role: "embark" });
  assertEqual(result.semantic, SEMANTIC.EMBARK_DISEMBARK_LOGISTICS);
});

test("Classic classifyItineraryStopKind unchanged for sea day", () => {
  assertEqual(classifyItineraryStopKind("Day at sea"), "sea");
});

test("Classic classifyItineraryStopKind unchanged for scenic", () => {
  assertEqual(classifyItineraryStopKind("Scenic Cruising Tracy Arm"), "scenic");
});

test("AMBIGUOUS low confidence is not eligible", () => {
  const result = classifyExpeditionStopSemantic({ port_name: "Mystery Stop", port_code: "ZZZZZ" });
  assertEqual(result.semantic, SEMANTIC.AMBIGUOUS);
  assertEqual(isExpeditionSemanticEligible(result), false);
});

test("Galápagos fixture sample loads if present", () => {
  const fixturePath = path.join(root, "scripts/fixtures/silversea/expedition-e1-galapagos-sample.json");
  if (!fs.existsSync(fixturePath)) return;
  const sample = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  if (!sample?.itinerary?.length) throw new Error("empty galapagos fixture");
  const landing = sample.itinerary.find((s) => s.port_code === "ECG02");
  if (!landing) throw new Error("ECG02 missing from fixture");
  const result = classifyExpeditionStopSemantic({ port_name: landing.port_name, port_code: landing.port_code });
  assertEqual(result.semantic, SEMANTIC.EXPEDITION_LANDING_SITE);
});

test("resolveRawPortText still resolves Civitavecchia for Classic regression", () => {
  const r = resolveRawPortText("Civitavecchia");
  assertEqual(r.status, "resolved");
});

console.log(`\ntest:silversea-expedition-semantics: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
