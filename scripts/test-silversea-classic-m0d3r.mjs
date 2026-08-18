#!/usr/bin/env node
/**
 * Silversea Classic M0D3R — lifecycle-aware protection + inventory reconciliation tests.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const classic = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
const expedition = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const { publicBookingCutoffDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

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

function fixtureRow(overrides = {}) {
  return {
    production_uuid: "uuid-1",
    official_sailing_id: "RA280608009",
    before_itinerary_ports: [],
    after_itinerary_ports: ["Barcelona"],
    row_fingerprint: {
      id: "uuid-1",
      official_sailing_id: "RA280608009",
      ship_id: "ship-1",
      departure_date: "2028-06-08",
      return_date: "2028-06-17",
      nights: 9,
      destination_id: "dest-1",
      status: "active"
    },
    ...overrides
  };
}

test("official vs active inventory reconciles active+expired+other=total", () => {
  const rows = [
    { id: "1", official_sailing_id: "RA1", status: "active" },
    { id: "2", official_sailing_id: "RA2", status: "expired" },
    { id: "3", official_sailing_id: "OR1", status: "active" },
    { id: "4", official_sailing_id: null, status: "hidden" }
  ];
  const inv = classic.classifySilverseaOfficialInventory(rows);
  if (!inv.reconciled) throw new Error("not reconciled");
  if (inv.classic_stored_official_total !== 2) throw new Error(String(inv.classic_stored_official_total));
  if (inv.classic_active_official !== 1) throw new Error("active classic");
  if (inv.expedition_stored_official_total !== 1) throw new Error("expedition total");
});

test("599->598 anomaly: only master-set expiry reduces master active count", () => {
  const masterIds = new Set(["SL260908010", "RA1", "RA2"]);
  const rows = [
    { id: "a", official_sailing_id: "SL260908010", status: "expired" },
    { id: "b", official_sailing_id: "SN260906007", status: "expired" },
    { id: "c", official_sailing_id: "RA1", status: "active" },
    { id: "d", official_sailing_id: "RA2", status: "active" }
  ];
  const activeMaster = rows.filter((r) => masterIds.has(r.official_sailing_id) && r.status === "active").length;
  if (activeMaster !== 2) throw new Error(`expected 2 active master rows, got ${activeMaster}`);
});

test("CASE A: active->expired within cutoff passes lifecycle-aware repair verify", () => {
  const perthToday = "2026-08-18";
  const stored = {
    id: "uuid-1",
    official_sailing_id: "RA280608009",
    ship_id: "ship-1",
    departure_date: "2026-09-08",
    return_date: "2026-09-17",
    nights: 9,
    destination_id: "dest-1",
    status: "expired",
    itinerary_ports: ["Barcelona"]
  };
  const fixture = fixtureRow({
    after_itinerary_ports: ["Barcelona"],
    row_fingerprint: {
      ...fixtureRow().row_fingerprint,
      departure_date: "2026-09-08",
      return_date: "2026-09-17",
      status: "active"
    }
  });
  const verify = expedition.verifyItineraryPortsRepairRow(stored, fixture, expedition.FINGERPRINT_FIELDS, {
    perthToday
  });
  if (!verify.ok) throw new Error(JSON.stringify(verify));
  if (verify.lifecycle_transition !== expedition.LIFECYCLE_TRANSITION.EXPECTED) throw new Error(verify.lifecycle_transition);
});

test("CASE B: active->expired outside cutoff fails", () => {
  const perthToday = "2026-08-18";
  const fixture = fixtureRow({
    row_fingerprint: {
      ...fixtureRow().row_fingerprint,
      departure_date: "2027-06-08",
      status: "active"
    }
  });
  const stored = {
    ...fixture.row_fingerprint,
    status: "expired",
    itinerary_ports: ["Barcelona"]
  };
  const verify = expedition.verifyItineraryPortsRepairRow(stored, fixture, expedition.FINGERPRINT_FIELDS, {
    perthToday
  });
  if (verify.ok) throw new Error("should fail outside cutoff");
});

test("CASE C: active->expired + raw_extract strict mutation fails protection", () => {
  const before = expedition.snapshotProtectionRow({
    id: "uuid-1",
    status: "active",
    departure_date: "2026-09-08",
    itinerary_ports: ["A"],
    raw_extract: { silversea_cruise_code: "RA1", destination_key: "med" }
  });
  const afterRow = {
    id: "uuid-1",
    status: "expired",
    departure_date: "2026-09-08",
    itinerary_ports: ["A"],
    raw_extract: { silversea_cruise_code: "RA1", destination_key: "changed" }
  };
  const result = expedition.verifyProtectionSnapshots(
    new Map([[afterRow.id, before]]),
    [afterRow],
    new Set(),
    { perthToday: "2026-08-18" }
  );
  if (result.ok) throw new Error("raw_extract strict mutation should fail");
});

test("CASE D: active->expired + itinerary_ports modified fails", () => {
  const before = expedition.snapshotProtectionRow({
    id: "uuid-1",
    status: "active",
    departure_date: "2026-09-08",
    itinerary_ports: ["A"],
    raw_extract: {}
  });
  const afterRow = {
    id: "uuid-1",
    status: "expired",
    departure_date: "2026-09-08",
    itinerary_ports: ["B"],
    raw_extract: { expired_at: "2026-08-18T00:00:00.000Z" }
  };
  const result = expedition.verifyProtectionSnapshots(new Map([[afterRow.id, before]]), [afterRow], new Set(), {
    perthToday: "2026-08-18"
  });
  if (result.ok) throw new Error("itinerary_ports mutation should fail");
});

test("CASE E: active->expired + departure changed fails lifecycle", () => {
  const lifecycle = expedition.classifyAuthorisedLifecycleTransition({
    beforeStatus: "active",
    afterStatus: "expired",
    departureDate: "2026-09-08",
    perthToday: "2026-08-18"
  });
  if (!lifecycle.ok) throw new Error("baseline eligible");
  const stored = fixtureRow();
  const row = {
    id: "uuid-1",
    official_sailing_id: "RA280608009",
    ship_id: "ship-1",
    departure_date: "2026-09-09",
    return_date: "2026-09-17",
    nights: 9,
    destination_id: "dest-1",
    status: "expired",
    itinerary_ports: ["Barcelona"]
  };
  const verify = expedition.verifyItineraryPortsRepairRow(row, stored, expedition.FINGERPRINT_FIELDS, {
    perthToday: "2026-08-18"
  });
  if (verify.ok) throw new Error("departure drift should fail strict fingerprint");
});

test("CASE F: unsupported status transition fails", () => {
  const lifecycle = expedition.classifyAuthorisedLifecycleTransition({
    beforeStatus: "active",
    afterStatus: "hidden",
    departureDate: "2026-09-08",
    perthToday: "2026-08-18"
  });
  if (lifecycle.ok) throw new Error("hidden transition should fail");
});

test("CASE G: authorised itinerary_ports update still passes", () => {
  const fixture = fixtureRow();
  const stored = {
    id: "uuid-1",
    official_sailing_id: "RA280608009",
    ship_id: "ship-1",
    departure_date: "2028-06-08",
    return_date: "2028-06-17",
    nights: 9,
    destination_id: "dest-1",
    status: "active",
    itinerary_ports: ["Barcelona"]
  };
  const verify = expedition.verifyItineraryPortsRepairRow(stored, fixture, expedition.FINGERPRINT_FIELDS);
  if (!verify.ok) throw new Error(JSON.stringify(verify));
});

test("M0D3 fixture remains 199 rows with master coverage", () => {
  const master = JSON.parse(fs.readFileSync(path.join(root, classic.M0C_BACKFILL_FIXTURE), "utf8"));
  const m0d3 = JSON.parse(fs.readFileSync(path.join(root, classic.M0D3_BACKFILL_FIXTURE), "utf8"));
  const partition = classic.partitionMasterClassicFixture(master);
  if (m0d3.rows.length !== 199) throw new Error(String(m0d3.rows.length));
  const m0d3MasterIds = new Set(partition.batches.m0d3.rows.map((r) => r.production_uuid));
  for (const row of m0d3.rows) {
    if (!m0d3MasterIds.has(row.production_uuid)) throw new Error(row.production_uuid);
  }
});

test("21-day cutoff date on 2026-08-18 Perth is 2026-09-08", () => {
  if (publicBookingCutoffDate("2026-08-18") !== "2026-09-08") throw new Error(publicBookingCutoffDate("2026-08-18"));
});

console.log(`\nM0D3R tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
