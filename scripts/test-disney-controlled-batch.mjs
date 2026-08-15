#!/usr/bin/env node
/**
 * Disney Phase 3 controlled-batch unit tests.
 * Run: npm run test:disney-controlled-batch
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const controlled = require(path.join(root, "netlify/functions/lib/disney-controlled-batch"));
const writes = require(path.join(root, "netlify/functions/lib/disney-discovery-writes"));
const endpointEvidence = require(path.join(root, "netlify/functions/lib/disney-endpoint-evidence"));
const adapter = require(path.join(root, "netlify/functions/lib/disney-discovery-adapter"));
const { parseArgs, assertApplyAllowed } = await import(
  path.join(root, "scripts/run-disney-first-controlled-batch.mjs")
);
const { cruiseIdentityKey } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
const { PUBLIC_BOOKING_CUTOFF_DAYS } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

test("1. from San Juan to Port Canaveral parsing", () => {
  const parsed = endpointEvidence.parseDisneyProductTitleEndpoints(
    "4-Night Eastern Caribbean Cruise from San Juan to Port Canaveral"
  );
  if (parsed.embark !== "San Juan" || parsed.arrival !== "Port Canaveral") throw new Error("parse mismatch");
});

test("2. title embark = San Juan", () => {
  const parsed = endpointEvidence.parseDisneyProductTitleEndpoints(
    "4-Night Eastern Caribbean Cruise from San Juan to Port Canaveral"
  );
  if (parsed.embark !== "San Juan") throw new Error(parsed.embark);
});

test("3. title arrival = Port Canaveral", () => {
  const parsed = endpointEvidence.parseDisneyProductTitleEndpoints(
    "4-Night Eastern Caribbean Cruise from San Juan to Port Canaveral"
  );
  if (parsed.arrival !== "Port Canaveral") throw new Error(parsed.arrival);
});

test("4. from-X-ending-in-Y still works", () => {
  const parsed = endpointEvidence.parseDisneyProductTitleEndpoints(
    "11-Night Mediterranean Cruise from Barcelona ending in Civitavecchia (Rome)"
  );
  if (!parsed?.embark?.includes("Barcelona") || !parsed?.arrival) throw new Error("ending-in broken");
});

test("5. round-trip from-X still works", () => {
  const parsed = endpointEvidence.parseDisneyProductTitleEndpoints("4-Night Cruise from Singapore");
  if (parsed.embark !== "Singapore" || parsed.arrival != null) throw new Error("round-trip broken");
});

test("6. with-2-stops suffix still works", () => {
  const parsed = endpointEvidence.parseDisneyProductTitleEndpoints(
    "3-Night Bahamian Cruise from Port Canaveral with 2 stops at Castaway Cay"
  );
  if (parsed.embark !== "Port Canaveral") throw new Error(parsed.embark);
});

test("7. title endpoints outrank productId (DD1515 fixture)", () => {
  const dd1515Fx = require(path.join(root, "scripts/fixtures/disney/dd1515-transatlantic-endpoint.json"));
  const raw = adapter.buildDisneyRawVoyage(
    {
      official_product_key: dd1515Fx.official_product_key,
      sailing_id: dd1515Fx.sailing_id,
      product_id: dd1515Fx.product_id,
      departure_date: dd1515Fx.departure_date,
      return_date: dd1515Fx.return_date,
      nights: dd1515Fx.nights,
      ship_name: dd1515Fx.ship_name,
      ship_code: dd1515Fx.ship_code,
      destination_code: "TRANSATLANTIC"
    },
    [
      {
        portsOfCall: dd1515Fx.ports_of_call_ordered,
        oneWayItinerary: dd1515Fx.one_way_itinerary,
        _discoveredViaFilters: dd1515Fx.discovered_via_filters
      }
    ],
    { productName: dd1515Fx.product_name }
  );
  const row = adapter.normaliseDisneyVoyage(raw, {
    cruiseLine: { id: adapter.DISNEY_LINE_ID, name: "Disney Cruise Line" },
    ships: [
      { id: "s2", name: "Disney Dream", cruise_line_id: adapter.DISNEY_LINE_ID, official_line_ship_id: "DD", active: true }
    ],
    destinations: [{ id: "d3", slug: "transatlantic", name: "Transatlantic", status: "active" }],
    today: "2026-08-15"
  });
  if (row.candidate.departure_port !== "Southampton") throw new Error("title lost to productId");
});

test("8. Phase 2D obsolete hash rejected", () => {
  if (!controlled.rejectObsoletePhase2dHash(controlled.PHASE2D_OBSOLETE_HASH)) throw new Error("not rejected");
  try {
    controlled.loadFrozenReport({ frozen_candidate_hash: controlled.PHASE2D_OBSOLETE_HASH, entries: [] });
    throw new Error("should throw");
  } catch (e) {
    if (!String(e.message).includes("phase2d")) throw e;
  }
});

test("9. new candidate hash deterministic", () => {
  const entries = [
    {
      official_product_key: "DA0071|2026-08-20",
      ship_id: "s1",
      departure_date: "2026-08-20",
      return_date: "2026-08-24",
      nights: 4,
      departure_port: "Singapore",
      arrival_port: null,
      destination_id: "d1",
      identity_key: "ik1",
      external_key: "ek1"
    }
  ];
  const h1 = endpointEvidence.hashFrozenBatchCandidates(entries, adapter.ADAPTER_VERSION);
  const h2 = endpointEvidence.hashFrozenBatchCandidates(entries, adapter.ADAPTER_VERSION);
  if (h1 !== h2) throw new Error("hash unstable");
});

test("10. candidate hash mismatch detectable", () => {
  const gate = controlled.evaluatePreWriteGate({ hashMismatch: true, selectedCount: 20 });
  if (gate.passed) throw new Error("hash mismatch should fail gate");
});

test("11. maximum controlled inserts = 20", () => {
  if (controlled.MAX_CONTROLLED_DISNEY_BATCH !== 20) throw new Error("max not 20");
});

test("12. confirmation token required", () => {
  try {
    assertApplyAllowed({ apply: true, confirm: "WRONG" });
    throw new Error("should fail");
  } catch (e) {
    if (e.code !== "disney_apply_confirmation_required") throw e;
  }
});

test("13. DISNEY_DISCOVERY_WRITE_ENABLED required", () => {
  const prev = process.env.DISNEY_DISCOVERY_WRITE_ENABLED;
  delete process.env.DISNEY_DISCOVERY_WRITE_ENABLED;
  try {
    assertApplyAllowed({ apply: true, confirm: controlled.APPLY_CONFIRMATION_TOKEN });
    throw new Error("should fail");
  } catch (e) {
    if (e.code !== "disney_discovery_write_disabled") throw e;
  } finally {
    if (prev) process.env.DISNEY_DISCOVERY_WRITE_ENABLED = prev;
  }
});

test("14. non-insert actions rejected set", () => {
  for (const action of ["update_exact_existing", "review_required", "blocked_unresolved"]) {
    if (!writes.REJECTED_ACTIONS.has(action)) throw new Error(`missing ${action}`);
  }
});

test("15. six legacy rows constant", () => {
  if (controlled.DISNEY_LEGACY_ROW_IDS.length !== 6) throw new Error("legacy count");
});

test("16. no update path — upsert uses prevRecord null", () => {
  const src = require("fs").readFileSync(
    path.join(root, "netlify/functions/lib/disney-discovery-writes.js"),
    "utf8"
  );
  if (!src.includes('prevRecord: null')) throw new Error("missing prevRecord null");
  if (!src.includes('matchPolicy: "official_sailing_id_only"')) throw new Error("missing match policy");
});

test("17. rollback manifest helper available", () => {
  const manifests = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-manifests"));
  if (typeof manifests.buildRollbackManifestFromWriteResult !== "function") throw new Error("missing rollback helper");
});

test("18. count arithmetic helper", () => {
  const result = controlled.verifyCountReconciliation(
    { disney_total: 6, disney_active: 0, global_total: 1000, sentinel_active: [{ slug: "x", active: 1 }] },
    { disney_total: 26, disney_active: 20, global_total: 1020, sentinel_active: [{ slug: "x", active: 1 }] },
    { inserted: 20 }
  );
  if (!result.passed) throw new Error(JSON.stringify(result));
});

test("19. parseArgs rejects --limit", () => {
  try {
    parseArgs(["node", "script", "--limit=5"]);
    throw new Error("should reject");
  } catch (e) {
    if (!String(e.message).includes("rejects")) throw e;
  }
});

test("20. frozen manifest validates batch size", () => {
  const report = {
    mode: controlled.MANIFEST_MODE,
    batch_size: 20,
    strategy: "insert_only",
    adapter_version: adapter.ADAPTER_VERSION,
    frozen_candidate_hash: "deadbeef",
    entries: Array.from({ length: 19 }, (_, i) => ({
      official_sailing_id: `X${i}|2026-09-01`,
      ship_id: "s",
      departure_date: "2026-09-01",
      return_date: "2026-09-04",
      nights: 3,
      departure_port: "Port Canaveral",
      arrival_port: null,
      destination_id: "d",
      identity_key: `ik${i}`,
      external_key: `ek${i}`
    }))
  };
  const v = controlled.validateFrozenManifest(report);
  if (v.ok) throw new Error("should fail with 19 entries");
});

test("21. adapter version bumped from Phase 2D", () => {
  if (!adapter.ADAPTER_VERSION.endsWith(".3")) throw new Error(adapter.ADAPTER_VERSION);
  if (adapter.ADAPTER_VERSION.endsWith(".2d")) throw new Error("still on 2d");
});

test("22. catch-up max = 100", () => {
  if (controlled.MAX_CATCHUP_DISNEY_BATCH !== 100) throw new Error("max catchup");
});

test("23. catch-up confirmation token", () => {
  if (controlled.CATCHUP_CONFIRMATION_TOKEN !== "DISNEY-CONTROLLED-CATCHUP") throw new Error("token");
});

test("24. Phase 3 lock anomaly documents mismatch", () => {
  const a = controlled.analysePhase3LockAnomaly();
  if (!a.exact_error.includes("maintenance_lock_owner_mismatch")) throw new Error("anomaly");
  if (!Array.isArray(a.fix_applied) || !a.fix_applied.length) throw new Error("fixes");
});

test("25. partial write recovery shape", async () => {
  const report = await controlled.buildPartialWriteRecoveryReport({
    supabase: async () => [],
    cruiseLineId: controlled.DISNEY_LINE_ID,
    frozenOfficialIds: ["A|2026-09-01", "B|2026-09-08"],
    existingBeforeIds: new Set(["existing-1"]),
    writeStats: { attempted: 2, inserted: 1, failed: 1 },
    error: new Error("simulated_failure")
  });
  if (!report.partial_write) throw new Error("partial flag");
  if (report.per_identity.length !== 2) throw new Error("per identity");
});

test("26. catchup frozen manifest rejects 101 entries", () => {
  const report = {
    mode: controlled.CATCHUP_MANIFEST_MODE,
    batch_size: 100,
    strategy: "insert_only",
    adapter_version: adapter.ADAPTER_VERSION,
    frozen_candidate_hash: "x",
    entries: Array.from({ length: 101 }, (_, i) => ({
      official_sailing_id: `X${i}|2026-09-01`,
      ship_id: "s",
      departure_date: "2026-09-01",
      return_date: "2026-09-04",
      nights: 3,
      departure_port: "Port Canaveral",
      arrival_port: null,
      destination_id: "d",
      identity_key: `ik${i}`,
      external_key: `ek${i}`
    }))
  };
  const endpointEvidence = require(path.join(root, "netlify/functions/lib/disney-endpoint-evidence"));
  report.frozen_candidate_hash = endpointEvidence.hashFrozenBatchCandidates(
    report.entries.map((e) => ({
      official_product_key: e.official_sailing_id,
      ship_id: e.ship_id,
      departure_date: e.departure_date,
      return_date: e.return_date,
      nights: e.nights,
      departure_port: e.departure_port,
      arrival_port: e.arrival_port,
      destination_id: e.destination_id,
      identity_key: e.identity_key,
      external_key: e.external_key
    })),
    adapter.ADAPTER_VERSION
  );
  const v = controlled.validateCatchupFrozenManifest(report);
  if (v.ok) throw new Error("101 should fail");
});

console.log(`\n${passed} disney-controlled-batch tests passed`);
if (process.exitCode) process.exit(process.exitCode);
