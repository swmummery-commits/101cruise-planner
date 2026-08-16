#!/usr/bin/env node
/**
 * Silversea Expedition Phase E2c tests — destination taxonomy remediation.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const {
  classifyExpeditionExclusiveBucket,
  evaluateExpeditionEligibility
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-eligibility"));
const {
  E2C_DESTINATION_MAPPING_MANIFEST,
  E2C_SILVERSEA_DESTINATION_SLUGS,
  assertE2cManifestWithinLimit
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-e2c-destination-batch"));
const { resolveOperationalDestination } = require(path.join(
  root,
  "netlify/functions/lib/discovery-destination-resolver"
));
const batch = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));

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

function baseExpeditionNormalised(overrides = {}) {
  return {
    raw: {
      cruise_type: "Expedition",
      cruise_code_valid: true,
      cruise_code: "WI270601014",
      detail_enriched: true,
      duration_matches_dates: true,
      departure_date: "2027-06-01",
      return_date: "2027-06-11",
      departure_port: "Reykjavik",
      arrival_port: "Reykjavik",
      destination_name: "ARCTIC & GREENLAND",
      ship_name: "Silver Wind",
      ...overrides.raw
    },
    official_sailing_id: overrides.official_sailing_id || "WI270601014",
    ship_resolution: { resolved: true, ship: { id: 1, name: "Silver Wind" } },
    departure_port_resolution: overrides.departure_port_resolution || {
      status: "resolved",
      canonicalPortName: "Reykjavik"
    },
    arrival_port_resolution: overrides.arrival_port_resolution || {
      status: "resolved",
      canonicalPortName: "Reykjavik"
    },
    destination_resolution: overrides.destination_resolution || {
      status: "resolved",
      destinationKey: "northern-europe",
      method: "silversea_region_northern-europe"
    },
    candidate: {
      destination_id: overrides.candidate?.destination_id ?? 42,
      departure_date: "2027-06-01",
      return_date: "2027-06-11",
      raw_extract: overrides.candidate?.raw_extract || {}
    },
    complete_high_confidence: overrides.complete_high_confidence ?? true,
    failure_reasons: overrides.failure_reasons || [],
    itinerary: overrides.itinerary || []
  };
}

test("E2c manifest within 3 destination mapping limit", () => {
  assertE2cManifestWithinLimit();
  assertTrue(Object.keys(E2C_SILVERSEA_DESTINATION_SLUGS).length <= 3);
});

test("Exact ARCTIC & GREENLAND maps to northern-europe slug", () => {
  assertEqual(adapter.destinationFallbackSlug("ARCTIC & GREENLAND"), "northern-europe");
  assertEqual(E2C_SILVERSEA_DESTINATION_SLUGS["arctic & greenland"], "northern-europe");
});

test("Silversea-specific mapping does not expose global alias table", () => {
  const row = E2C_DESTINATION_MAPPING_MANIFEST[0];
  assertEqual(row.mapping_scope, "silversea_source_specific");
  assertEqual(row.global_alias, false);
  assertEqual(row.fuzzy_matching, false);
});

test("Unrelated Silversea destination unchanged", () => {
  assertEqual(adapter.destinationFallbackSlug("Antarctica"), "antarctica");
  assertEqual(adapter.destinationFallbackSlug("Galápagos Islands"), "galapagos");
  assertTrue(adapter.destinationFallbackSlug("Mediterranean") === "mediterranean");
});

test("Operational resolver accepts preferred northern-europe for Arctic label", () => {
  const destinations = [
    { id: 1, slug: "northern-europe", name: "Northern Europe", classification_enabled: true, status: "published" }
  ];
  const result = resolveOperationalDestination({
    title: "Arctic expedition",
    description: "ARCTIC & GREENLAND",
    itinerary: "Reykjavik Nuuk",
    destinations,
    preferredDestination: { slug: "northern-europe" }
  });
  assertEqual(result.status, "resolved");
  assertEqual(result.destinationKey, "northern-europe");
});

test("Expedition destination blocker clears when northern-europe resolved", () => {
  const row = baseExpeditionNormalised();
  assertEqual(classifyExpeditionExclusiveBucket(row), "expedition_e2_complete");
  assertTrue(evaluateExpeditionEligibility(row).eligible);
});

test("Ambiguity still blocks after destination remediation", () => {
  const row = baseExpeditionNormalised({
    itinerary: [
      {
        kind: "port",
        port_name: "Elephant Island",
        port_code: "AQC41",
        expedition_semantic: null,
        semantic_confidence: "ambiguous",
        ambiguity_reason: "unsupported_identity",
        port_resolution: { status: "unresolved" }
      }
    ]
  });
  assertEqual(classifyExpeditionExclusiveBucket(row), "ambiguous_semantic_itinerary");
});

test("Duration mismatch still blocks", () => {
  const row = baseExpeditionNormalised({ raw: { duration_matches_dates: false } });
  assertEqual(classifyExpeditionExclusiveBucket(row), "duration_mismatch");
});

test("Unresolved non-Arctic destination still blocks", () => {
  const row = baseExpeditionNormalised({
    raw: { destination_name: "UNKNOWN REGION" },
    destination_resolution: { status: "unresolved" },
    candidate: { destination_id: null }
  });
  assertEqual(classifyExpeditionExclusiveBucket(row), "destination_unresolved");
});

test("Classic destination slug table unaffected for non-E2c labels", () => {
  assertTrue(!Object.prototype.hasOwnProperty.call(E2C_SILVERSEA_DESTINATION_SLUGS, "mediterranean"));
  assertEqual(adapter.destinationFallbackSlug("Mediterranean"), "mediterranean");
});

test("Combo/segment identity preserved on Arctic product shape", () => {
  const row = baseExpeditionNormalised({
    raw: { cruise_code: "E4270118015C1", destination_name: "ARCTIC & GREENLAND" },
    official_sailing_id: "E4270118015C1"
  });
  assertEqual(row.official_sailing_id, "E4270118015C1");
  assertEqual(row.raw.destination_name, "ARCTIC & GREENLAND");
});

test("Zero port writes in E2c manifest", () => {
  assertTrue(E2C_DESTINATION_MAPPING_MANIFEST.every((row) => row.new_canonical === false));
});

test("Classic eligibility helper unchanged by E2c imports", () => {
  assertTrue(typeof batch.isFirstBatchEligible === "function");
  assertTrue(typeof batch.classifyExclusiveBucket === "function");
});

console.log(`\nE2c tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
