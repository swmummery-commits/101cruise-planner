#!/usr/bin/env node
/**
 * Silversea Classic M0C — itinerary_ports audit + backfill preparation tests.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const classic = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
const expedition = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const ops = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`✗ ${name}`);
    console.error(`  ${e.message}`);
    failed += 1;
  }
}

test("empty expected empty classification", () => {
  const cat = classic.classifyClassicItineraryPortsAudit({
    storedPorts: [],
    expectedPorts: [],
    expectedOk: true,
    sourceReconcileStatus: classic.SOURCE_RECONCILE_STATUS.CURRENT_SOURCE_MATCH,
    rawExtractReconstructable: null
  });
  if (cat !== expedition.REPAIR_CATEGORY.STORED_EMPTY_EXPECTED_EMPTY) throw new Error(cat);
});

test("empty expected nonempty classification", () => {
  const cat = classic.classifyClassicItineraryPortsAudit({
    storedPorts: [],
    expectedPorts: ["Barcelona"],
    expectedOk: true,
    sourceReconcileStatus: classic.SOURCE_RECONCILE_STATUS.CURRENT_SOURCE_MATCH,
    rawExtractReconstructable: null
  });
  if (cat !== expedition.REPAIR_CATEGORY.STORED_EMPTY_EXPECTED_NONEMPTY) throw new Error(cat);
});

test("nonempty difference classification", () => {
  const cat = classic.classifyClassicItineraryPortsAudit({
    storedPorts: ["A"],
    expectedPorts: ["B"],
    expectedOk: true,
    sourceReconcileStatus: classic.SOURCE_RECONCILE_STATUS.CURRENT_SOURCE_MATCH,
    rawExtractReconstructable: null
  });
  if (cat !== expedition.REPAIR_CATEGORY.STORED_NONEMPTY_EXPECTED_DIFFERENT) throw new Error(cat);
});

test("source absence defers when raw_extract insufficient", () => {
  const cat = classic.classifyClassicItineraryPortsAudit({
    storedPorts: [],
    expectedPorts: [],
    expectedOk: false,
    sourceReconcileStatus: classic.SOURCE_RECONCILE_STATUS.SOURCE_ABSENT,
    rawExtractReconstructable: { ok: false, reason: "no_itinerary_stops" }
  });
  if (cat !== classic.CLASSIC_AUDIT_CATEGORY.SOURCE_ABSENT_NOT_SAFE_TO_REPAIR) throw new Error(cat);
});

test("source-absent raw_extract reconstructable", () => {
  const cat = classic.classifyClassicItineraryPortsAudit({
    storedPorts: [],
    expectedPorts: ["Barcelona"],
    expectedOk: true,
    sourceReconcileStatus: classic.SOURCE_RECONCILE_STATUS.SOURCE_ABSENT,
    rawExtractReconstructable: { ok: true, ports: ["Barcelona"] }
  });
  if (cat !== classic.CLASSIC_AUDIT_CATEGORY.SOURCE_ABSENT_RECONSTRUCTABLE) throw new Error(cat);
});

test("unsafe source-absent deferral is not repair category", () => {
  if (classic.isClassicDeterministicRepairCategory(classic.CLASSIC_AUDIT_CATEGORY.SOURCE_ABSENT_NOT_SAFE_TO_REPAIR)) {
    throw new Error("unsafe should defer");
  }
});

test("raw_extract reconstruction requires resolved ports", () => {
  const result = classic.buildExpectedPortsFromRawExtract({
    itinerary_stops: [{ kind: "port", port_resolution: { status: "unresolved" } }]
  });
  if (result.ok) throw new Error("expected unresolved failure");
});

test("raw_extract reconstruction extracts conventional ports", () => {
  const result = classic.buildExpectedPortsFromRawExtract({
    itinerary_stops: [
      { kind: "port", port_resolution: { status: "resolved", canonicalPortName: "Barcelona" } },
      { kind: "sea", port_resolution: null }
    ]
  });
  if (!result.ok || result.ports.join(",") !== "Barcelona") throw new Error(JSON.stringify(result));
});

test("fixture uniqueness validation shape", () => {
  const fixture = {
    frozen_count: 1,
    rows: [
      {
        production_uuid: "u1",
        official_sailing_id: "SL1",
        before_itinerary_ports: [],
        after_itinerary_ports: ["Barcelona"],
        row_fingerprint: { id: "u1" }
      }
    ]
  };
  const v = classic.validateClassicRepairFixture(fixture);
  if (!v.ok || v.expedition_rows !== 0) throw new Error(JSON.stringify(v));
});

test("Classic-only fixture rejects expedition IDs", () => {
  const fixture = {
    frozen_count: 1,
    rows: [{ production_uuid: "u1", official_sailing_id: "OR1", before_itinerary_ports: [], after_itinerary_ports: [] }]
  };
  const v = classic.validateClassicRepairFixture(fixture);
  if (v.ok) throw new Error("expected expedition rejection");
});

test("legacy rows excluded from fixture validation pass", () => {
  const fixture = {
    frozen_count: 1,
    rows: [{ production_uuid: "u1", official_sailing_id: null, before_itinerary_ports: [], after_itinerary_ports: [] }]
  };
  const v = classic.validateClassicRepairFixture(fixture);
  if (v.ok) throw new Error("expected legacy rejection");
});

test("whitelist is itinerary_ports only", () => {
  if (JSON.stringify(classic.UPDATE_WHITELIST) !== JSON.stringify(["itinerary_ports"])) {
    throw new Error("whitelist");
  }
});

test("dry run proposes update-only Classic mutations", () => {
  const dry = classic.dryRunClassicItineraryPortsBackfill({
    rows: [{ production_uuid: "u1" }, { production_uuid: "u2" }]
  });
  if (dry.proposed_itinerary_ports_updates !== 2 || dry.proposed_inserts !== 0) throw new Error(JSON.stringify(dry));
  if (dry.expedition_rows !== 0 || dry.classic_rows !== 2) throw new Error("row type counts");
});

test("frozen-before precondition helper", () => {
  const fixtureRow = {
    production_uuid: "u1",
    official_sailing_id: "SL1",
    before_itinerary_ports: [],
    row_fingerprint: {
      id: "u1",
      official_sailing_id: "SL1",
      ship_id: "s1",
      departure_date: "2028-01-01",
      return_date: "2028-01-08",
      nights: 7,
      destination_id: "d1",
      status: "active"
    }
  };
  const prod = {
    id: "u1",
    official_sailing_id: "SL1",
    itinerary_ports: [],
    ship_id: "s1",
    departure_date: "2028-01-01",
    return_date: "2028-01-08",
    nights: 7,
    destination_id: "d1",
    status: "active"
  };
  const check = classic.verifyClassicFrozenBeforeMatch(prod, fixtureRow);
  if (!check.ok) throw new Error(check.issues.join(","));
});

test("exact rollback entry stores before and after", () => {
  const entry = expedition.buildRollbackEntry({
    production_uuid: "u1",
    official_sailing_id: "SL1",
    before_itinerary_ports: [],
    after_itinerary_ports: ["Barcelona"]
  });
  if (entry.before_itinerary_ports.length !== 0 || entry.after_itinerary_ports[0] !== "Barcelona") {
    throw new Error(JSON.stringify(entry));
  }
});

test("verifier detects wrong after value", () => {
  const verify = classic.verifyItineraryPortsRepairRow(
    { id: "u1", official_sailing_id: "SL1", itinerary_ports: [] },
    { production_uuid: "u1", official_sailing_id: "SL1", before_itinerary_ports: [], after_itinerary_ports: ["Barcelona"], row_fingerprint: { id: "u1", official_sailing_id: "SL1" } }
  );
  if (verify.ok) throw new Error("expected mismatch");
});

test("future Classic insert persists itinerary_ports", () => {
  const payload = classic.assertClassicInsertPayloadIncludesItineraryPorts(
    {
      cruise_line_id: "l1",
      ship_id: "s1",
      destination_id: "d1",
      departure_date: "2028-06-01",
      return_date: "2028-06-08",
      nights: 7,
      departure_port: "Barcelona",
      itinerary: "Barcelona",
      itinerary_ports: ["Barcelona", "Marseille"],
      official_url: "https://x",
      external_key: "e1",
      official_sailing_id: "SL1",
      raw_extract: {}
    },
    { departure_port: "Barcelona", departure_port_meta: null, blocked: false, reason: "new" },
    "k1",
    "active",
    [],
    new Date().toISOString()
  );
  if (!Array.isArray(payload.itinerary_ports) || payload.itinerary_ports.length !== 2) {
    throw new Error("ports missing");
  }
});

test("legitimate empty Classic array persists on insert", () => {
  const payload = classic.assertClassicInsertPayloadIncludesItineraryPorts(
    {
      cruise_line_id: "l1",
      ship_id: "s1",
      destination_id: "d1",
      departure_date: "2028-06-01",
      return_date: "2028-06-08",
      nights: 7,
      departure_port: "At Sea",
      itinerary: "At Sea",
      itinerary_ports: [],
      official_url: "https://x",
      external_key: "e2",
      official_sailing_id: "SL2",
      raw_extract: {}
    },
    { departure_port: "At Sea", departure_port_meta: null, blocked: false, reason: "new" },
    "k2",
    "active",
    [],
    new Date().toISOString()
  );
  if (!Array.isArray(payload.itinerary_ports) || payload.itinerary_ports.length !== 0) {
    throw new Error("expected empty");
  }
});

test("Classic eligibility rules unchanged flag", () => {
  if (classic.CLASSIC_ITINERARY_PORTS_CONTRACT.eligibility_rules_changed !== false) {
    throw new Error("eligibility changed flag");
  }
});

test("update payload omits itinerary_ports by default", () => {
  const payload = ops.buildDiscoveredCruiseUpsertPayload(
    {
      cruise_line_id: "l1",
      ship_id: "s1",
      destination_id: "d1",
      departure_date: "2028-06-01",
      return_date: "2028-06-08",
      nights: 7,
      departure_port: "Barcelona",
      itinerary: "Barcelona",
      itinerary_ports: ["Barcelona"],
      official_url: "https://x",
      external_key: "e1",
      official_sailing_id: "SL1",
      raw_extract: {}
    },
    { departure_port: "Barcelona", departure_port_meta: null, blocked: false, reason: "new" },
    { identity_key: "k1", status: "active", reasons: [], now: new Date().toISOString(), includeItineraryPorts: false }
  );
  if (Object.prototype.hasOwnProperty.call(payload, "itinerary_ports")) throw new Error("update included ports");
});

test("M0C fixture validates when present", () => {
  const fixturePath = path.join(root, classic.M0C_BACKFILL_FIXTURE);
  if (!fs.existsSync(fixturePath)) return;
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const v = classic.validateClassicRepairFixture(fixture);
  if (!v.ok) throw new Error(v.issues.join(","));
  if (v.row_count !== fixture.frozen_count) throw new Error("count mismatch");
});

console.log(`\nM0C tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
