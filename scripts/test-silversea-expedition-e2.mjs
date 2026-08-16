#!/usr/bin/env node
/**
 * Silversea Expedition semantics — Phase E2 integration tests.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  EXPEDITION_SEMANTIC,
  SEMANTIC,
  SEMANTIC_CONFIDENCE,
  SEMANTIC_SOURCE,
  classifyExpeditionStop,
  enrichExpeditionItineraryStop
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));
const {
  classifyExpeditionExclusiveBucket,
  evaluateExpeditionEligibility,
  isExpeditionProduct
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-eligibility"));
const { resolveRawPortText } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));
const { classifyItineraryStopKind } = require(path.join(
  root,
  "netlify/functions/lib/silversea-discovery-source"
));
const { normaliseSilverseaProduct } = require(path.join(
  root,
  "netlify/functions/lib/silversea-discovery-adapter"
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

function baseExpeditionNormalised(overrides = {}) {
  return {
    raw: {
      cruise_type: "Expedition",
      cruise_code_valid: true,
      cruise_code: "OR250101",
      detail_enriched: true,
      duration_matches_dates: true,
      departure_date: "2027-01-01",
      return_date: "2027-01-08",
      departure_port: "Baltra",
      arrival_port: "Baltra",
      destination_name: "Galápagos Islands",
      ship_name: "Silver Origin",
      ...overrides.raw
    },
    official_sailing_id: overrides.official_sailing_id || "OR250101",
    ship_resolution: { resolved: true, ship: { id: 1, name: "Silver Origin" } },
    departure_port_resolution: overrides.departure_port_resolution || {
      status: "resolved",
      canonicalPortName: "Baltra"
    },
    arrival_port_resolution: overrides.arrival_port_resolution || {
      status: "resolved",
      canonicalPortName: "Baltra"
    },
    destination_resolution: overrides.destination_resolution || { status: "resolved", destinationKey: "galapagos" },
    candidate: {
      destination_id: overrides.candidate?.destination_id ?? 99,
      departure_date: "2027-01-01",
      return_date: "2027-01-08",
      raw_extract: overrides.candidate?.raw_extract || {}
    },
    complete_high_confidence: overrides.complete_high_confidence ?? true,
    failure_reasons: overrides.failure_reasons || [],
    itinerary: overrides.itinerary || []
  };
}

test("Classic voyage raw_extract stops omit expedition semantic fields", () => {
  const raw = {
    cruise_type: "Classic",
    itinerary: [{ port_name: "Civitavecchia", port_code: "ITCVV" }]
  };
  const mapped = normaliseSilverseaProduct(
    {
      ...raw,
      cruise_code_valid: true,
      cruise_code: "MO123",
      detail_enriched: true,
      duration_matches_dates: true,
      departure_date: "2027-03-01",
      return_date: "2027-03-08",
      departure_port: "Civitavecchia",
      arrival_port: "Civitavecchia",
      destination_name: "Mediterranean",
      ship_name: "Silver Moon"
    },
    { cruiseLine: { id: 1, name: "Silversea Cruises" }, ships: [], destinations: [] }
  );
  const stop = mapped.candidate.raw_extract.itinerary_stops[0];
  assertEqual(stop.expedition_semantic, undefined);
});

test("Exact semantic rule wins over broad ECG family default", () => {
  const result = classifyExpeditionStop({ port_name: "Santa Cruz Highlands", port_code: "ECG12" });
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.INLAND_VISIT);
  assertEqual(result.semantic_source, SEMANTIC_SOURCE.EXACT_IDENTITY_RULE);
});

test("Code/name conflict fails closed to ambiguous", () => {
  const result = classifyExpeditionStop({ port_name: "Wrong Name", port_code: "AQE43" });
  assertEqual(result.semantic_confidence, SEMANTIC_CONFIDENCE.AMBIGUOUS);
  assertEqual(result.ambiguity_reason, "conflicting_code_name");
});

test("Unknown code fails ambiguous", () => {
  const result = classifyExpeditionStop({ port_name: "Mystery Stop", port_code: "ZZZZZ" });
  assertEqual(result.semantic_confidence, SEMANTIC_CONFIDENCE.AMBIGUOUS);
  assertEqual(result.ambiguity_reason, "unsupported_identity");
});

test("Landing site accepted as deterministic non-port", () => {
  const result = classifyExpeditionStop({ port_name: "Isla Bartolome", port_code: "ECG02" });
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.LANDING_SITE);
  assertEqual(result.semantic_confidence, SEMANTIC_CONFIDENCE.DETERMINISTIC);
});

test("Anchorage accepted as deterministic non-port", () => {
  const result = classifyExpeditionStop({ port_name: "Kicker Rock", port_code: "ECG34" });
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.ANCHORAGE);
});

test("Scenic region accepted as deterministic non-port", () => {
  const result = classifyExpeditionStop({ port_name: "Antarctic Peninsula", port_code: "AQE43" });
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.SCENIC_REGION);
});

test("Inland visit accepted as deterministic non-port", () => {
  const result = classifyExpeditionStop({ port_name: "Santa Cruz Highlands", port_code: "ECG12" });
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.INLAND_VISIT);
});

test("Conventional port still requires canonical resolution for eligibility", () => {
  const row = baseExpeditionNormalised({
    itinerary: [
      {
        kind: "port",
        port_name: "Sisimiut",
        port_code: "GLJHS",
        expedition_semantic: EXPEDITION_SEMANTIC.CONVENTIONAL_PORT,
        semantic_confidence: SEMANTIC_CONFIDENCE.DETERMINISTIC,
        port_resolution: { status: "unresolved" }
      }
    ]
  });
  assertEqual(classifyExpeditionExclusiveBucket(row), "conventional_itinerary_port_unresolved");
});

test("Logistics gateway itinerary stop accepted as deterministic non-port", () => {
  const row = baseExpeditionNormalised({
    itinerary: [
      {
        kind: "port",
        port_name: "Puerto Williams",
        port_code: "CLWPU",
        expedition_semantic: EXPEDITION_SEMANTIC.EMBARK_DISEMBARK_LOGISTICS,
        semantic_confidence: SEMANTIC_CONFIDENCE.DETERMINISTIC,
        port_resolution: { status: "unresolved" }
      },
      {
        kind: "port",
        port_name: "Antarctic Peninsula",
        port_code: "AQE43",
        expedition_semantic: EXPEDITION_SEMANTIC.SCENIC_REGION,
        semantic_confidence: SEMANTIC_CONFIDENCE.DETERMINISTIC,
        port_resolution: { status: "unresolved" }
      }
    ]
  });
  assertEqual(classifyExpeditionExclusiveBucket(row), "expedition_e2_complete");
});

test("Logistics endpoint still requires endpoint resolution", () => {
  const row = baseExpeditionNormalised({
    raw: { departure_port: "Puerto Williams", arrival_port: "Ushuaia", destination_name: "Antarctica" },
    departure_port_resolution: { status: "unresolved" },
    arrival_port_resolution: { status: "resolved", canonicalPortName: "Ushuaia" },
    itinerary: [
      {
        kind: "port",
        port_name: "Antarctic Peninsula",
        port_code: "AQE43",
        expedition_semantic: EXPEDITION_SEMANTIC.SCENIC_REGION,
        semantic_confidence: SEMANTIC_CONFIDENCE.DETERMINISTIC,
        port_resolution: { status: "unresolved" }
      }
    ]
  });
  assertEqual(classifyExpeditionExclusiveBucket(row), "embark_unresolved");
});

test("Destination blocker still blocks", () => {
  const row = baseExpeditionNormalised({
    destination_resolution: { status: "unresolved" },
    candidate: { destination_id: null }
  });
  assertEqual(classifyExpeditionExclusiveBucket(row), "destination_unresolved");
});

test("Duration mismatch still blocks", () => {
  const row = baseExpeditionNormalised({ raw: { duration_matches_dates: false } });
  assertEqual(classifyExpeditionExclusiveBucket(row), "duration_mismatch");
});

test("Ambiguous itinerary stop blocks eligibility", () => {
  const row = baseExpeditionNormalised({
    itinerary: [
      {
        kind: "port",
        port_name: "Mystery",
        port_code: "ZZZZZ",
        expedition_semantic: null,
        semantic_confidence: SEMANTIC_CONFIDENCE.AMBIGUOUS,
        ambiguity_reason: "unsupported_identity",
        port_resolution: { status: "unresolved" }
      }
    ]
  });
  assertEqual(classifyExpeditionExclusiveBucket(row), "ambiguous_semantic_itinerary");
});

test("raw_extract enrichment preserves source fields", () => {
  const enriched = enrichExpeditionItineraryStop(
    {
      kind: "port",
      port_name: "Isla Bartolome",
      port_code: "ECG02",
      day_number: 2,
      arrival_time: "08:00",
      departure_time: "12:00",
      port_resolution: { status: "unresolved" }
    },
    { destination: "Galápagos Islands" }
  );
  assertEqual(enriched.port_name, "Isla Bartolome");
  assertEqual(enriched.day_number, 2);
  assertEqual(enriched.expedition_semantic, EXPEDITION_SEMANTIC.LANDING_SITE);
});

test("itinerary_ports excludes non-port expedition stops", () => {
  const { buildItineraryPorts } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
  const normalised = {
    itinerary: [
      {
        kind: "port",
        port_name: "Isla Bartolome",
        port_code: "ECG02",
        expedition_semantic: EXPEDITION_SEMANTIC.LANDING_SITE,
        port_resolution: { status: "unresolved" }
      },
      {
        kind: "port",
        port_name: "Baltra",
        port_code: "ECBAL",
        expedition_semantic: EXPEDITION_SEMANTIC.CONVENTIONAL_PORT,
        port_resolution: { status: "resolved", canonicalPortName: "Baltra" }
      }
    ]
  };
  const ports = buildItineraryPorts(normalised);
  assertEqual(ports.length, 1);
  assertEqual(ports[0], "Baltra");
});

test("Galápagos representative voyage enriches landing semantics", () => {
  const fixturePath = path.join(root, "scripts/fixtures/silversea/expedition-e1-galapagos-sample.json");
  if (fs.existsSync(fixturePath)) {
    const sample = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const landing = sample.itinerary.find((s) => s.port_code === "ECG02");
    if (landing) {
      const result = classifyExpeditionStop({ port_name: landing.port_name, port_code: landing.port_code });
      assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.LANDING_SITE);
    }
  }
});

test("Antarctica representative scenic region", () => {
  const result = classifyExpeditionStop({ port_name: "South Shetland Islands", port_code: "AQE44" });
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.SCENIC_REGION);
});

test("Arctic NOE scenic region family", () => {
  const result = classifyExpeditionStop({ port_name: "Svalbard South Region", port_code: "NOE99" });
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.SCENIC_REGION);
});

test("Kimberley AUK region code", () => {
  const result = classifyExpeditionStop({ port_name: "Buccaneer Archipelago Region", port_code: "AUK03" });
  assertEqual(result.expedition_semantic, EXPEDITION_SEMANTIC.SCENIC_REGION);
});

test("Combo/segment identity suffix detected", () => {
  assertTrue(isExpeditionProduct({ cruise_type: "Expedition" }));
  const { isComboSegmentProduct } = require(path.join(
    root,
    "netlify/functions/lib/silversea-expedition-eligibility"
  ));
  assertTrue(isComboSegmentProduct({ cruise_code: "OR260829C14" }));
});

test("No Classic behavioural regression on stop kind classifier", () => {
  assertEqual(classifyItineraryStopKind("Day at sea"), "sea");
  assertEqual(classifyItineraryStopKind("Scenic Cruising Tracy Arm"), "scenic");
  const r = resolveRawPortText("Civitavecchia");
  assertEqual(r.status, "resolved");
});

test("Complete expedition with resolved endpoints and deterministic stops", () => {
  const row = baseExpeditionNormalised({
    itinerary: [
      {
        kind: "port",
        port_name: "Isla Bartolome",
        port_code: "ECG02",
        expedition_semantic: EXPEDITION_SEMANTIC.LANDING_SITE,
        semantic_confidence: SEMANTIC_CONFIDENCE.DETERMINISTIC,
        port_resolution: { status: "unresolved" }
      },
      {
        kind: "port",
        port_name: "Baltra",
        port_code: "ECBAL",
        expedition_semantic: EXPEDITION_SEMANTIC.CONVENTIONAL_PORT,
        semantic_confidence: SEMANTIC_CONFIDENCE.DETERMINISTIC,
        port_resolution: { status: "resolved", canonicalPortName: "Baltra" }
      }
    ]
  });
  const evalResult = evaluateExpeditionEligibility(row);
  assertTrue(evalResult.eligible);
  assertEqual(evalResult.exclusive_bucket, "expedition_e2_complete");
});

console.log(`\ntest:silversea-expedition-e2: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
