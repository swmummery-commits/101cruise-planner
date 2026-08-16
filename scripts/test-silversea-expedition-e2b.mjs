#!/usr/bin/env node
/**
 * Silversea Expedition Phase E2b tests.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const {
  resolveExpeditionLogisticsGateway,
  resolveExpeditionEndpointPort,
  isExpeditionEndpointResolved
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-endpoint-resolution"));
const { buildItineraryPorts } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const { classifyExpeditionExclusiveBucket } = require(path.join(
  root,
  "netlify/functions/lib/silversea-expedition-eligibility"
));
const { resetPortsCache, resolveRawPortText } = require(path.join(
  root,
  "netlify/functions/lib/discovery-departure-port"
));
const {
  E2B_CANONICAL_PORT_CREATES,
  E2B_LOGISTICS_GATEWAY_MAPPINGS,
  assertE2bManifestWithinLimit
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-e2b-port-batch"));

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

function assertTrue(value, msg) {
  if (!value) throw new Error(msg || "expected true");
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || "assert"}: expected ${expected}, got ${actual}`);
}

test("E2b manifest within 10 canonical port limit", () => {
  assertE2bManifestWithinLimit();
  assertTrue(E2B_CANONICAL_PORT_CREATES.length <= 10);
});

test("King George Island AQKGG resolves as expedition logistics gateway", () => {
  const resolution = resolveExpeditionLogisticsGateway({
    sourceName: "King George Island",
    portCode: "AQKGG"
  });
  assertEqual(resolution.status, "resolved");
  assertTrue(resolution.expedition_logistics_gateway);
  assertEqual(resolution.canonicalPortName, "King George Island");
});

test("King George logistics gateway is not a catalogue conventional port", () => {
  resetPortsCache();
  const catalogue = resolveRawPortText("King George Island");
  assertTrue(catalogue.status !== "resolved" || !catalogue.canonicalPortId);
});

test("Expedition endpoint resolution accepts logistics gateway", () => {
  const resolution = resolveExpeditionEndpointPort("King George Island", "test", {
    cruiseType: "Expedition",
    portCode: "AQKGG"
  });
  assertTrue(isExpeditionEndpointResolved(resolution));
});

test("Classic port resolution bypasses expedition logistics mapping", () => {
  const resolution = adapter.resolveSilverseaPort("King George Island", "test", {
    cruiseType: "Classic"
  });
  assertTrue(resolution.status !== "resolved" || !resolution.expedition_logistics_gateway);
});

test("Logistics gateway stops excluded from itinerary_ports", () => {
  const ports = buildItineraryPorts({
    itinerary: [
      {
        kind: "port",
        port_resolution: {
          status: "resolved",
          canonicalPortName: "King George Island",
          expedition_logistics_gateway: true
        }
      },
      {
        kind: "port",
        port_resolution: { status: "resolved", canonicalPortName: "Ushuaia" }
      }
    ]
  });
  assertEqual(ports.length, 1);
  assertEqual(ports[0], "Ushuaia");
});

test("Puerto Williams expedition resolution uses catalogue when present", () => {
  resetPortsCache();
  const resolution = adapter.resolveSilverseaPort("Puerto Williams", "silversea_e2b_test", {
    cruiseType: "Expedition",
    portCode: "CLWPU"
  });
  if (resolution.status === "resolved") {
    assertEqual(resolution.canonicalPortName, "Puerto Williams");
    assertTrue(!resolution.expedition_logistics_gateway);
  }
});

test("Tromsø alias resolves to Tromso when catalogue alias present", () => {
  resetPortsCache();
  const resolution = adapter.resolveSilverseaPort("Tromsø", "silversea_e2b_test", {
    cruiseType: "Expedition",
    portCode: "NOTOS"
  });
  if (resolution.status === "resolved") {
    assertEqual(resolution.canonicalPortName, "Tromso");
  }
});

test("Endpoint completeness after King George logistics mapping", () => {
  const row = {
    raw: {
      cruise_type: "Expedition",
      cruise_code_valid: true,
      cruise_code: "WI270423015",
      detail_enriched: true,
      duration_matches_dates: true,
      departure_date: "2027-06-01",
      return_date: "2027-06-15",
      departure_port: "King George Island",
      departure_port_code: "AQKGG",
      arrival_port: "Ushuaia",
      arrival_port_code: "ARUSH",
      destination_name: "ANTARCTICA"
    },
    official_sailing_id: "WI270423015",
    ship_resolution: { resolved: true },
    departure_port_resolution: resolveExpeditionEndpointPort("King George Island", "test", {
      cruiseType: "Expedition",
      portCode: "AQKGG"
    }),
    arrival_port_resolution: { status: "resolved", canonicalPortName: "Ushuaia" },
    destination_resolution: { status: "resolved" },
    candidate: { destination_id: 1, departure_date: "2027-06-01", return_date: "2027-06-15" },
    complete_high_confidence: true,
    failure_reasons: [],
    itinerary: [
      {
        kind: "port",
        port_name: "Antarctic Peninsula",
        port_code: "AQE43",
        expedition_semantic: "scenic_region",
        semantic_confidence: "deterministic",
        port_resolution: { status: "unresolved" }
      }
    ]
  };
  assertEqual(classifyExpeditionExclusiveBucket(row), "expedition_e2_complete");
});

test("Logistics gateway mappings manifest covers AQKGG", () => {
  assertTrue(E2B_LOGISTICS_GATEWAY_MAPPINGS.some((row) => row.silversea_port_code === "AQKGG"));
});

test("Zero destination writes in E2b batch module", () => {
  assertTrue(!JSON.stringify(E2B_CANONICAL_PORT_CREATES).includes("ARCTIC & GREENLAND"));
});

console.log(`\ntest:silversea-expedition-e2b: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
