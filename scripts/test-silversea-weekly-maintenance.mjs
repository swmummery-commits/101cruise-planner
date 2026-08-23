#!/usr/bin/env node
/**
 * Silversea M1 weekly maintenance proposal tests — offline, no production writes.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const policy = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-policy"));
const proposal = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-proposal"));
const weeklyRunner = await import(path.join(root, "scripts/run-silversea-weekly-maintenance.mjs"));

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

const TODAY = "2026-08-22";
const LINE = { id: "line-silversea", name: "Silversea", slug: "silversea-cruises" };

function baseNormalised(overrides = {}) {
  return {
    official_sailing_id: "SL270927009",
    product_type: "ocean_cruise",
    complete_high_confidence: true,
    match_required: false,
    failure_reasons: [],
    raw: {
      cruise_code: "SL270927009",
      cruise_code_valid: true,
      cruise_type: "classic",
      departure_date: "2027-09-27",
      return_date: "2027-10-06",
      source_duration: 9,
      duration_matches_dates: true,
      detail_enriched: true,
      departure_port: "Venice",
      arrival_port: "Venice",
      official_url: "https://www.silversea.com/example",
      code_kind: "numeric"
    },
    candidate: {
      ship_id: "ship-1",
      destination_id: "dest-1",
      departure_date: "2027-09-27",
      return_date: "2027-10-06",
      nights: 9,
      departure_port: "Venice",
      official_url: "https://www.silversea.com/example"
    },
    ship_resolution: { resolved: true },
    departure_port_resolution: { status: "resolved", canonicalPortName: "Venice" },
    arrival_port_resolution: { status: "resolved", canonicalPortName: "Venice" },
    destination_resolution: { status: "resolved", destinationKey: "mediterranean" },
    itinerary: [
      { kind: "port", port_resolution: { status: "resolved", canonicalPortName: "Venice" }, expedition_semantic: "CONVENTIONAL_PORT" },
      { kind: "port", port_resolution: { status: "resolved", canonicalPortName: "Kotor" }, expedition_semantic: "CONVENTIONAL_PORT" },
      { kind: "port", port_resolution: { status: "resolved", canonicalPortName: "Dubrovnik" }, expedition_semantic: "CONVENTIONAL_PORT" }
    ],
    ...overrides
  };
}

function healthySimulation(products) {
  return {
    ok: true,
    health: { ok: true, failures: [] },
    products,
    summary: {
      catalogue_nodes: 1123,
      unique_cruise_codes: 1123,
      classic: 721,
      expedition: 402
    },
    fetch_result: { fetched_at: "2026-08-22T00:00:00.000Z", catalogue_url: "https://www.silversea.com/page-data/cruise-catalog.html/page-data.json" }
  };
}

test("M1 mutation mode blocked", () => {
  const r = weeklyRunner.assertM1MutationBlocked({ apply: true, confirm: "SILVERSEA-WEEKLY-MAINTENANCE" });
  if (!r.blocked) throw new Error("apply must be blocked");
});

test("healthy source permits insert proposals in engine", () => {
  const normalised = baseNormalised({ official_sailing_id: "RA280101009" });
  const prodIndex = { byOfficialId: new Map(), rows: [] };
  const p = proposal.buildSilverseaWeeklyMaintenanceProposal({
    simulation: healthySimulation([normalised]),
    productionIndex: prodIndex,
    cruiseLine: LINE,
    today: TODAY
  });
  if (p.source_healthy !== true) throw new Error("source");
  if ((p.counts.INSERT_ELIGIBLE || 0) < 0) throw new Error("counts");
});

test("unhealthy source blocks write-authorised counts", () => {
  const p = proposal.buildSilverseaWeeklyMaintenanceProposal({
    simulation: { ok: false, health: { ok: false, failures: ["bad"] }, products: [], summary: {} },
    productionIndex: { byOfficialId: new Map(), rows: [] },
    cruiseLine: LINE,
    today: TODAY
  });
  if (p.write_authorised_if_executed.inserts !== 0 || p.write_authorised_if_executed.updates !== 0) {
    throw new Error("must fail closed");
  }
});

test("official identity preserved — no URL/ship-date matching", () => {
  const id = "MO271210C26";
  const n = baseNormalised({ official_sailing_id: id, raw: { ...baseNormalised().raw, cruise_code: id } });
  const prod = {
    id: "uuid-1",
    official_sailing_id: id,
    cruise_line_id: LINE.id,
    ship_id: "ship-1",
    destination_id: "dest-1",
    departure_date: "2027-09-27",
    return_date: "2027-10-06",
    nights: 9,
    departure_port: "Venice",
    itinerary: "Venice",
    itinerary_ports: ["Venice", "Kotor", "Dubrovnik"],
    status: "active",
    raw_extract: {}
  };
  const r = proposal.classifyExistingPair({
    normalised: n,
    productionRow: prod,
    cruiseLine: LINE,
    today: TODAY,
    sourceHealthy: true
  });
  if (r.official_sailing_id !== id) throw new Error("id changed");
});

test("deferred special product — no insert proposal", () => {
  const n = baseNormalised({
    official_sailing_id: "SL261107C28",
    product_type: "deferred_special_voyage",
    raw: { ...baseNormalised().raw, cruise_code: "SL261107C28", code_kind: "combination", deferred_special_voyage: true }
  });
  const p = proposal.buildSilverseaWeeklyMaintenanceProposal({
    simulation: healthySimulation([n]),
    productionIndex: { byOfficialId: new Map(), rows: [] },
    cruiseLine: LINE,
    today: TODAY
  });
  const insert = p.tables.insert_eligible.filter((r) => r.official_sailing_id === "SL261107C28");
  if (insert.length) throw new Error("special must not insert");
  if (p.counts.DEFERRED_SPECIAL_PRODUCT !== 1) throw new Error("deferred count");
});

test("itinerary shrink guard blocks unsafe truncation", () => {
  const shrink = policy.evaluateItineraryShrinkGuard({
    storedPorts: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"],
    expectedPorts: ["A", "B", "C", "D", "E"],
    raw: { detail_enriched: true },
    candidate: { nights: 11 },
    productionRow: { nights: 11, departure_port: "A" }
  });
  if (shrink.pass) throw new Error("large shrink must fail");
});

test("itinerary reorder guard allows multiset reorder", () => {
  const reorder = policy.evaluateItineraryReorderGuard({
    storedPorts: ["Venice", "Piran", "Dubrovnik", "Kotor"],
    expectedPorts: ["Venice", "Piran", "Kotor", "Dubrovnik"]
  });
  if (!reorder.pass || !reorder.reorder_only) throw new Error("reorder");
});

test("source absence — one miss observation only", () => {
  const row = proposal.classifyProductionOnly({
    productionRow: {
      id: "uuid-sn",
      official_sailing_id: "SN280222C25",
      departure_date: "2028-02-22",
      status: "active",
      nights: 25,
      raw_extract: { silversea_code_kind: "numeric" }
    },
    today: TODAY,
    sourceHealthy: true,
    previousObservations: {}
  });
  if (row.classification !== policy.MAINTENANCE_CLASSIFICATION.SOURCE_ABSENT_OBSERVATION) throw new Error("class");
  if (row.proposed_action !== policy.SOURCE_ABSENCE_POLICY.single_miss_action) throw new Error("action");
  if (row.physical_delete_proposed !== false) throw new Error("delete");
});

test("cutoff is not source absence", () => {
  const row = proposal.classifyProductionOnly({
    productionRow: {
      id: "uuid-exp",
      official_sailing_id: "RA260901009",
      departure_date: TODAY,
      status: "expired",
      raw_extract: {}
    },
    today: TODAY,
    sourceHealthy: true
  });
  if (row.classification !== policy.MAINTENANCE_CLASSIFICATION.WITHIN_21_DAY_CUTOFF) throw new Error(String(row.classification));
});

test("dry-run idempotency identical checksum", () => {
  const n = baseNormalised({ official_sailing_id: "RA280101009" });
  const ctx = {
    simulation: healthySimulation([n]),
    productionIndex: { byOfficialId: new Map(), rows: [] },
    cruiseLine: LINE,
    today: TODAY
  };
  const a = proposal.buildSilverseaWeeklyMaintenanceProposal(ctx);
  const b = proposal.buildSilverseaWeeklyMaintenanceProposal(ctx);
  if (!proposal.verifyProposalIdempotency(a, b)) throw new Error("checksum mismatch");
});

test("delete proposals always zero", () => {
  const p = proposal.buildSilverseaWeeklyMaintenanceProposal({
    simulation: healthySimulation([]),
    productionIndex: {
      byOfficialId: new Map([
        [
          "SN280222C25",
          {
            id: "uuid-sn",
            official_sailing_id: "SN280222C25",
            departure_date: "2028-02-22",
            status: "active",
            raw_extract: {}
          }
        ]
      ]),
      rows: [{ id: "uuid-sn", official_sailing_id: "SN280222C25", departure_date: "2028-02-22", status: "active", raw_extract: {} }]
    },
    cruiseLine: LINE,
    today: TODAY
  });
  if (p.write_authorised_if_executed.deletes !== 0) throw new Error("delete");
});

test("future global lock contract defined", () => {
  if (!policy.FUTURE_MAINTENANCE_LOCK_CONTRACT.steps?.length) throw new Error("lock");
});

test("source-only partition sums reconcile", () => {
  const products = [
    baseNormalised({ official_sailing_id: "RA280101009" }),
    baseNormalised({
      official_sailing_id: "SL261107C28",
      product_type: "deferred_special_voyage",
      raw: { ...baseNormalised().raw, cruise_code: "SL261107C28", code_kind: "combination", deferred_special_voyage: true }
    })
  ];
  const p = proposal.buildSilverseaWeeklyMaintenanceProposal({
    simulation: healthySimulation(products),
    productionIndex: { byOfficialId: new Map(), rows: [] },
    cruiseLine: LINE,
    today: TODAY
  });
  if (!p.source_only_partition_reconciles) throw new Error("partition");
});

test("SN280222C25 source absence not masked by C25 suffix", () => {
  const row = proposal.classifyProductionOnly({
    productionRow: {
      id: "uuid-sn",
      official_sailing_id: "SN280222C25",
      departure_date: "2028-02-22",
      status: "active",
      nights: 25,
      raw_extract: { silversea_code_kind: "numeric" }
    },
    today: TODAY,
    sourceHealthy: true,
    previousObservations: {}
  });
  if (row.classification !== policy.MAINTENANCE_CLASSIFICATION.SOURCE_ABSENT_OBSERVATION) {
    throw new Error(String(row.classification));
  }
});

test("raw_extract adapter metadata ignored for unchanged rows", () => {
  const prod = {
    id: "u1",
    official_sailing_id: "MO271210C26",
    cruise_line_id: LINE.id,
    ship_id: "ship-1",
    destination_id: "dest-1",
    departure_date: "2027-12-10",
    return_date: "2028-01-05",
    nights: 26,
    departure_port: "Monte Carlo",
    itinerary: "Monte Carlo",
    itinerary_ports: ["Monte Carlo"],
    status: "active",
    raw_extract: { silversea_cruise_code: "MO271210C26", silversea_adapter_version: "old" }
  };
  const expected = {
    ship_id: "ship-1",
    destination_id: "dest-1",
    departure_date: "2027-12-10",
    return_date: "2028-01-05",
    nights: 26,
    departure_port: "Monte Carlo",
    itinerary: "Monte Carlo",
    itinerary_ports: ["Monte Carlo"],
    official_url: "https://example.com",
    source_url: "https://example.com",
    raw_extract: { silversea_cruise_code: "MO271210C26", silversea_adapter_version: "new" }
  };
  const diff = proposal.diffMaintainableFields(prod, expected);
  if (diff.changed_fields.includes("raw_extract")) throw new Error(JSON.stringify(diff.changed_fields));
});

test("WH drift case classified UPDATE_UNSAFE when truncated", () => {
  const stored = ["Papeete", "Fakarava", "Nuku Hiva", "Tahuata", "Rangiroa", "Raiatea", "Raiatea", "Raiatea", "Bora Bora", "Moorea", "Papeete", "Papeete"];
  const expectedPorts = ["Papeete", "Fakarava", "Nuku Hiva", "Tahuata", "Rangiroa"];
  const n = baseNormalised({ official_sailing_id: "WH271121011" });
  const prod = {
    id: "uuid-wh",
    official_sailing_id: "WH271121011",
    cruise_line_id: LINE.id,
    ship_id: "ship-1",
    destination_id: "dest-1",
    departure_date: "2027-11-21",
    return_date: "2027-12-02",
    nights: 11,
    departure_port: "Papeete",
    itinerary: "Papeete",
    itinerary_ports: stored,
    status: "active",
    raw_extract: {}
  };
  const safety = policy.evaluateItineraryPortsUpdateSafety({
    storedPorts: stored,
    expectedPorts: expectedPorts,
    raw: n.raw,
    candidate: n.candidate,
    productionRow: prod
  });
  if (safety.eligible) throw new Error("truncation must be unsafe");
});

console.log(`\nM1 tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
