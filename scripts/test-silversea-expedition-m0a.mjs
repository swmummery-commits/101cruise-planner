#!/usr/bin/env node
/**
 * Silversea Expedition M0A — itinerary_ports persistence + backfill preparation tests.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const ops = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
const { buildItineraryPorts, buildExpeditionUpsertCandidate } = require(path.join(
  root,
  "netlify/functions/lib/silversea-discovery-writes"
));
const { EXPEDITION_SEMANTIC } = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));
const {
  M0A_BACKFILL_FIXTURE,
  REPAIR_CATEGORY,
  portsArrayEqual,
  normalizeStoredPorts,
  classifyItineraryPortsRepair,
  isDeterministicRepairCategory,
  dryRunItineraryPortsBackfill,
  buildRollbackEntry,
  verifyItineraryPortsRepairRow,
  reconcileE6FrozenMismatchReport,
  UPDATE_WHITELIST
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));

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

const merged = { departure_port: "Miami", departure_port_meta: null, blocked: false, reason: "new" };
const now = new Date().toISOString();

test("insert payload persists itinerary_ports array", () => {
  const candidate = {
    cruise_line_id: "l1",
    ship_id: "s1",
    destination_id: "d1",
    departure_date: "2028-01-01",
    return_date: "2028-01-08",
    nights: 7,
    departure_port: "San Cristobal",
    itinerary: "San Cristobal, Baltra",
    itinerary_ports: ["San Cristobal", "Baltra"],
    official_url: "https://x",
    external_key: "e1",
    official_sailing_id: "OR1",
    raw_extract: {}
  };
  const payload = ops.buildDiscoveredCruiseUpsertPayload(candidate, merged, {
    identity_key: "k1",
    status: "active",
    reasons: [],
    now,
    includeItineraryPorts: true
  });
  if (!Array.isArray(payload.itinerary_ports) || payload.itinerary_ports.length !== 2) {
    throw new Error("ports missing");
  }
});

test("empty itinerary_ports persists as []", () => {
  const payload = ops.buildDiscoveredCruiseUpsertPayload(
    {
      cruise_line_id: "l1",
      ship_id: "s1",
      destination_id: "d1",
      departure_date: "2028-01-01",
      return_date: "2028-01-08",
      nights: 7,
      departure_port: "KGI",
      itinerary: "Antarctica",
      itinerary_ports: [],
      official_url: "https://x",
      external_key: "e2",
      official_sailing_id: "WI1",
      raw_extract: {}
    },
    merged,
    { identity_key: "k2", status: "active", reasons: [], now, includeItineraryPorts: true }
  );
  if (!Array.isArray(payload.itinerary_ports) || payload.itinerary_ports.length !== 0) {
    throw new Error("expected empty array");
  }
});

test("update payload omits itinerary_ports by default", () => {
  const payload = ops.buildDiscoveredCruiseUpsertPayload(
    {
      cruise_line_id: "l1",
      ship_id: "s1",
      destination_id: "d1",
      departure_date: "2028-01-01",
      return_date: "2028-01-08",
      nights: 7,
      departure_port: "X",
      itinerary: "X",
      itinerary_ports: ["A"],
      official_url: "https://x",
      external_key: "e3",
      official_sailing_id: "DA1",
      raw_extract: {}
    },
    merged,
    { identity_key: "k3", status: "active", reasons: [], now, includeItineraryPorts: false }
  );
  if (Object.prototype.hasOwnProperty.call(payload, "itinerary_ports")) {
    throw new Error("update payload must not include itinerary_ports");
  }
});

test("Galápagos buildItineraryPorts excludes landing sites", () => {
  const normalised = {
    itinerary: [
      {
        kind: "port",
        expedition_semantic: EXPEDITION_SEMANTIC.CONVENTIONAL_PORT,
        port_resolution: { status: "resolved", canonicalPortName: "Baltra" }
      },
      {
        kind: "port",
        expedition_semantic: EXPEDITION_SEMANTIC.LANDING_SITE,
        port_resolution: { status: "resolved", canonicalPortName: "Fake Landing" }
      }
    ]
  };
  const ports = buildItineraryPorts(normalised);
  if (ports.includes("Fake Landing") || !ports.includes("Baltra")) {
    throw new Error("semantic leak or missing conventional port");
  }
});

test("repair category STORED_EMPTY_EXPECTED_NONEMPTY is deterministic", () => {
  const cat = classifyItineraryPortsRepair({
    storedPorts: [],
    expectedPorts: ["Baltra"],
    sourceAvailable: true,
    expectedOk: true
  });
  if (cat !== REPAIR_CATEGORY.STORED_EMPTY_EXPECTED_NONEMPTY) throw new Error(cat);
  if (!isDeterministicRepairCategory(cat)) throw new Error("not deterministic");
});

test("26 vs 29 reconciliation explains OR + E4 Galápagos", () => {
  const rows = [
    ...Array.from({ length: 26 }, (_, i) => ({
      official_sailing_id: `OR2811${String(i).padStart(4, "0")}`,
      region: "Galápagos",
      ports_equal: false
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      official_sailing_id: `E428120601${i}`,
      region: "Galápagos",
      ports_equal: false
    })),
    ...Array.from({ length: 31 }, () => ({
      official_sailing_id: "WI281127006",
      region: "Antarctica",
      ports_equal: true
    }))
  ];
  const r = reconcileE6FrozenMismatchReport(rows);
  if (r.e6_mismatch_count !== 29) throw new Error(`count ${r.e6_mismatch_count}`);
  if (r.mismatch_e4_count !== 3) throw new Error(`e4 ${r.mismatch_e4_count}`);
  if (!r.explanation.includes("E4")) throw new Error("missing E4 explanation");
});

test("dry run updates only itinerary_ports", () => {
  const fixture = {
    rows: [
      {
        production_uuid: "uuid-1",
        official_sailing_id: "OR1",
        before_itinerary_ports: [],
        after_itinerary_ports: ["Baltra"]
      }
    ]
  };
  const d = dryRunItineraryPortsBackfill(fixture);
  if (d.proposed_inserts !== 0 || d.proposed_deletes !== 0) throw new Error("wrong counts");
  if (d.other_column_updates !== 0) throw new Error("other columns");
  if (d.proposed_itinerary_ports_updates !== 1) throw new Error("updates");
});

test("rollback entry stores exact before/after", () => {
  const entry = buildRollbackEntry({
    production_uuid: "u1",
    official_sailing_id: "OR1",
    before_itinerary_ports: [],
    after_itinerary_ports: ["A", "B"]
  });
  if (entry.before_itinerary_ports.length !== 0 || entry.after_itinerary_ports.length !== 2) {
    throw new Error("rollback shape");
  }
});

test("update whitelist is itinerary_ports only", () => {
  if (UPDATE_WHITELIST.length !== 1 || UPDATE_WHITELIST[0] !== "itinerary_ports") {
    throw new Error("whitelist");
  }
});

test("backfill fixture unique counts when present", () => {
  const fixturePath = path.join(root, M0A_BACKFILL_FIXTURE);
  if (!fs.existsSync(fixturePath)) {
    console.log("⊘ backfill fixture unique counts when present (run M0A preparation first)");
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const uuids = new Set(fixture.rows.map((r) => r.production_uuid));
  const ids = new Set(fixture.rows.map((r) => r.official_sailing_id));
  if (uuids.size !== fixture.frozen_count || ids.size !== fixture.frozen_count) {
    throw new Error("unique count mismatch");
  }
});

console.log(`\nM0A tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
