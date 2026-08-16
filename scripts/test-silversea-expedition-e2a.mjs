#!/usr/bin/env node
/**
 * Silversea Expedition Phase E2a — ambiguity semantic rule tests.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  EXPEDITION_SEMANTIC,
  SEMANTIC_CONFIDENCE,
  SEMANTIC_SOURCE,
  classifyExpeditionStop,
  enrichExpeditionItineraryStop
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));
const {
  classifyExpeditionExclusiveBucket
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-eligibility"));
const { buildItineraryPorts } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const {
  E2A_IMPLEMENTED_RULES,
  assertE2aManifestWithinLimit
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-e2a-rules-batch"));
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

function assertTrue(value, msg) {
  if (!value) throw new Error(msg || "expected true");
}

test("E2a manifest within 30 rule limit", () => {
  assertE2aManifestWithinLimit();
  assertTrue(E2A_IMPLEMENTED_RULES.length <= 30);
});

test("Elephant Island AQC41 is deterministic landing site", () => {
  const result = classifyExpeditionStop(
    { port_name: "Elephant Island", port_code: "AQC41" },
    { destination: "ANTARCTICA" }
  );
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.LANDING_SITE);
  assertEqual(result.semantic_confidence, SEMANTIC_CONFIDENCE.DETERMINISTIC);
  assertEqual(result.semantic_rule_id, "aqc41_elephant_island");
});

test("AQC41 code/name conflict fails closed", () => {
  const result = classifyExpeditionStop({ port_name: "Wrong Place", port_code: "AQC41" }, { destination: "ANTARCTICA" });
  assertEqual(result.semantic_confidence, SEMANTIC_CONFIDENCE.AMBIGUOUS);
  assertEqual(result.ambiguity_reason, "conflicting_code_name");
});

test("Unknown AQC code fails closed (not broad AQC family)", () => {
  const result = classifyExpeditionStop({ port_name: "Mystery Site", port_code: "AQC99" }, { destination: "ANTARCTICA" });
  assertEqual(result.semantic_confidence, SEMANTIC_CONFIDENCE.AMBIGUOUS);
});

test("Unknown future code fails ambiguous", () => {
  const result = classifyExpeditionStop({ port_name: "Future Stop", port_code: "ZZZ99" }, { destination: "ANTARCTICA" });
  assertEqual(result.semantic_confidence, SEMANTIC_CONFIDENCE.AMBIGUOUS);
});

test("Greenland GLKSS Scoresby Sund is scenic region", () => {
  const result = classifyExpeditionStop(
    { port_name: "Scoresby Sund", port_code: "GLKSS" },
    { destination: "ARCTIC & GREENLAND" }
  );
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.SCENIC_REGION);
  assertEqual(result.semantic_confidence, SEMANTIC_CONFIDENCE.DETERMINISTIC);
});

test("Greenland GLITQ settlement is landing site", () => {
  const result = classifyExpeditionStop(
    { port_name: "Ittoqqortoormiit", port_code: "GLITQ" },
    { destination: "ARCTIC & GREENLAND" }
  );
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.LANDING_SITE);
});

test("Conventional Greenland ports remain conventional not landing", () => {
  const sis = classifyExpeditionStop({ port_name: "Sisimiut", port_code: "GLJHS" }, { destination: "ARCTIC & GREENLAND" });
  assertEqual(sis.expedition_semantic, EXPEDITION_SEMANTIC.CONVENTIONAL_PORT);
});

test("Kimberley AUJAR scenic bay only when destination is Kimberley", () => {
  const kim = classifyExpeditionStop(
    { port_name: "Vansittart Bay (Jar Island)", port_code: "AUJAR" },
    { destination: "KIMBERLEY" }
  );
  assertEqual(kim.expedition_semantic, EXPEDITION_SEMANTIC.SCENIC_REGION);
  assertEqual(kim.semantic_rule_id, "kimberley_au_region_scenic");

  const other = classifyExpeditionStop(
    { port_name: "Vansittart Bay (Jar Island)", port_code: "AUJAR" },
    { destination: "AUSTRALIA & NEW ZEALAND" }
  );
  assertEqual(other.semantic_confidence, SEMANTIC_CONFIDENCE.AMBIGUOUS);
});

test("Kimberley Wyndham AUWYD landing when region scoped", () => {
  const result = classifyExpeditionStop({ port_name: "Wyndham", port_code: "AUWYD" }, { destination: "KIMBERLEY" });
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.LANDING_SITE);
});

test("Galápagos ECG family unchanged", () => {
  const result = classifyExpeditionStop({ port_name: "Isla Bartolome", port_code: "ECG02" }, { destination: "GALÁPAGOS ISLANDS" });
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.LANDING_SITE);
});

test("Logistics gateway precedence unchanged", () => {
  const result = classifyExpeditionStop({ port_name: "King George Island", port_code: "AQKGG" }, { destination: "ANTARCTICA" });
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.EMBARK_DISEMBARK_LOGISTICS);
});

test("Ambiguous stop still blocks eligibility", () => {
  const row = {
    raw: {
      cruise_type: "Expedition",
      cruise_code_valid: true,
      cruise_code: "E4999999999",
      detail_enriched: true,
      duration_matches_dates: true,
      departure_date: "2027-01-01",
      destination_name: "ANTARCTICA"
    },
    official_sailing_id: "E4999999999",
    ship_resolution: { resolved: true },
    departure_port_resolution: {
      status: "resolved",
      canonicalPortName: "Ushuaia",
      expedition_logistics_gateway: false
    },
    arrival_port_resolution: {
      status: "resolved",
      canonicalPortName: "Ushuaia",
      expedition_logistics_gateway: false
    },
    destination_resolution: { status: "resolved" },
    candidate: { destination_id: 1 },
    complete_high_confidence: true,
    failure_reasons: [],
    itinerary: [
      {
        kind: "port",
        port_name: "Unknown",
        port_code: "ZZZ01",
        expedition_semantic: null,
        semantic_confidence: SEMANTIC_CONFIDENCE.AMBIGUOUS,
        port_resolution: { status: "unresolved" }
      }
    ]
  };
  assertEqual(classifyExpeditionExclusiveBucket(row), "ambiguous_semantic_itinerary");
});

test("itinerary_ports excludes landing and scenic stops", () => {
  const ports = buildItineraryPorts({
    itinerary: [
      {
        kind: "port",
        port_resolution: { status: "resolved", canonicalPortName: "Ushuaia" },
        expedition_semantic: EXPEDITION_SEMANTIC.CONVENTIONAL_PORT
      },
      {
        kind: "port",
        port_resolution: { status: "unresolved" },
        expedition_semantic: EXPEDITION_SEMANTIC.LANDING_SITE,
        expedition_logistics_gateway: false
      }
    ]
  });
  assertEqual(ports.length, 1);
});

test("raw_extract enrichment preserves source fields on landing stop", () => {
  const enriched = enrichExpeditionItineraryStop(
    { kind: "port", port_name: "Elephant Island", port_code: "AQC41", day_number: 3 },
    { destination: "ANTARCTICA" }
  );
  assertEqual(enriched.port_name, "Elephant Island");
  assertEqual(enriched.port_code, "AQC41");
  assertEqual(enriched.expedition_semantic, EXPEDITION_SEMANTIC.LANDING_SITE);
});

test("Classic stop kind classifier unchanged for sea day", () => {
  assertEqual(classifyItineraryStopKind("Day at sea"), "sea");
});

test("Single-identity Elephant Island voyage would be eligible shape", () => {
  const row = {
    raw: {
      cruise_type: "Expedition",
      cruise_code_valid: true,
      cruise_code: "E4270118015",
      detail_enriched: true,
      duration_matches_dates: true,
      departure_date: "2027-01-18",
      destination_name: "ANTARCTICA"
    },
    official_sailing_id: "E4270118015",
    ship_resolution: { resolved: true },
    departure_port_resolution: {
      status: "resolved",
      canonicalPortName: "Ushuaia",
      expedition_logistics_gateway: false
    },
    arrival_port_resolution: {
      status: "resolved",
      canonicalPortName: "Ushuaia",
      expedition_logistics_gateway: false
    },
    destination_resolution: { status: "resolved" },
    candidate: { destination_id: 1 },
    complete_high_confidence: true,
    failure_reasons: [],
    itinerary: [
      {
        kind: "port",
        port_name: "Elephant Island",
        port_code: "AQC41",
        expedition_semantic: EXPEDITION_SEMANTIC.LANDING_SITE,
        semantic_confidence: SEMANTIC_CONFIDENCE.DETERMINISTIC,
        semantic_source: SEMANTIC_SOURCE.EXACT_IDENTITY_RULE,
        semantic_rule_id: "aqc41_elephant_island",
        port_resolution: { status: "unresolved" }
      }
    ]
  };
  assertEqual(classifyExpeditionExclusiveBucket(row), "expedition_e2_complete");
});

console.log(`\nE2a tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
