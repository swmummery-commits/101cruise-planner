#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const controlled = require(path.join(root, "netlify/functions/lib/disney-controlled-batch"));
const { parsePhase4bArgs } = await import("./run-disney-phase4b-catchup.mjs");

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${passed}. ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

const legacyId = controlled.DISNEY_LEGACY_ROW_IDS[0];

function makeOfficial(id, extra = {}) {
  return {
    id: `uuid-${id}`,
    status: "active",
    official_sailing_id: id,
    ship_id: "s1",
    destination_id: "d1",
    departure_date: "2026-09-01",
    return_date: "2026-09-04",
    nights: 3,
    departure_port: "Port Canaveral",
    identity_key: `ik-${id}`,
    external_key: `ek-${id}`,
    official_url: "https://example.com",
    source_url: "https://example.com",
    raw_extract: { disney_sailing_id: id.split("|")[0] },
    ...extra
  };
}

function makeLegacy(id = legacyId) {
  return {
    id,
    status: "active",
    ship_id: "s0",
    destination_id: "d0",
    departure_date: "2020-01-01",
    return_date: "2020-01-08",
    nights: 7,
    departure_port: "Miami",
    official_sailing_id: null,
    identity_key: "legacy",
    external_key: "legacy",
    raw_extract: {}
  };
}

function simWithManifest(manifestSummary, manifestRows = []) {
  return {
    write_manifest: { summary: manifestSummary, manifest: manifestRows },
    quality_gate: { source_complete: true, ship_resolution_pct: 100, destination_resolution_pct: 100, duration_validation_pct: 100 },
    eligibility: { arithmetic: { reconciles: true } },
    snapshot: { expansion: { identity_collisions: 0 } },
    endpoint_audit: { unresolved_conflicts: 0 },
    source_unique_sailings: 651,
    products: []
  };
}

test("1. baseline accepts 120 official + 6 legacy", () => {
  const rows = [...controlled.DISNEY_LEGACY_ROW_IDS.map((id) => makeLegacy(id)), ...Array.from({ length: 120 }, (_, i) => makeOfficial(`X${i}|2026-09-01`))];
  const manifest = rows.filter((r) => r.official_sailing_id).map((r) => ({ official_product_key: r.official_sailing_id, action: "duplicate_skip" }));
  const baseline = controlled.verifyCumulativeProductionBaseline(rows, simWithManifest({}, manifest));
  if (!baseline.ok || baseline.official_count !== 120 || baseline.legacy_count !== 6) throw new Error(JSON.stringify(baseline));
});

test("2. baseline accepts 220 official + 6 legacy", () => {
  const rows = [...controlled.DISNEY_LEGACY_ROW_IDS.map((id) => makeLegacy(id)), ...Array.from({ length: 220 }, (_, i) => makeOfficial(`Y${i}|2026-09-01`))];
  const manifest = rows.filter((r) => r.official_sailing_id).map((r) => ({ official_product_key: r.official_sailing_id, action: "duplicate_skip" }));
  const baseline = controlled.verifyCumulativeProductionBaseline(rows, simWithManifest({}, manifest));
  if (!baseline.ok || baseline.official_count !== 220) throw new Error(JSON.stringify(baseline));
});

test("3. baseline is dynamic not 26/20", () => {
  const rows = [...controlled.DISNEY_LEGACY_ROW_IDS.map((id) => makeLegacy(id)), ...Array.from({ length: 50 }, (_, i) => makeOfficial(`Z${i}|2026-09-01`))];
  const manifest = rows.filter((r) => r.official_sailing_id).map((r) => ({ official_product_key: r.official_sailing_id, action: "duplicate_skip" }));
  const baseline = controlled.verifyCumulativeProductionBaseline(rows, simWithManifest({}, manifest));
  if (!baseline.ok || baseline.disney_total !== 56) throw new Error(JSON.stringify(baseline));
});

test("4. all current official IDs excluded from next freeze selection", () => {
  const existing = new Set(["A|2026-09-01", "B|2026-09-08"]);
  const sim = simWithManifest(
    { insert_active: 2 },
    [
      { official_product_key: "A|2026-09-01", action: "duplicate_skip" },
      { official_product_key: "B|2026-09-08", action: "duplicate_skip" },
      { official_product_key: "C|2026-09-15", action: "insert_active" },
      { official_product_key: "D|2026-09-22", action: "insert_active" }
    ]
  );
  const remaining = controlled.selectRemainingInsertIdentities(sim, existing);
  if (remaining.length !== 2 || remaining.includes("A|2026-09-01")) throw new Error(JSON.stringify(remaining));
});

test("5. batch number 2 naming", () => {
  if (controlled.catchupBatchFreezePath(2) !== "reports/disney-phase4b-catchup-batch-2-freeze.json") throw new Error("freeze path");
  if (controlled.catchupBatchReportPath(2) !== "reports/disney-phase4b-catchup-batch-2.json") throw new Error("report path");
});

test("6. arbitrary batch number naming", () => {
  if (controlled.catchupBatchOperation(7) !== "disney_phase4b_catchup_batch_7") throw new Error("operation");
});

test("7. no hard-coded catchup-1 in phase4b operation", () => {
  if (controlled.catchupBatchOperation(2).includes("catchup_1")) throw new Error("still catchup_1");
});

test("8. cumulative official immutability", () => {
  const before = [makeOfficial("A|2026-09-01")];
  const after = [{ ...before[0] }];
  const result = controlled.verifyExistingOfficialImmutability(before, after);
  if (!result.passed) throw new Error(JSON.stringify(result));
});

test("9. Phase 4A rows included in immutability snapshot", () => {
  const rows = [makeOfficial("WW0509|2026-09-07"), makeOfficial("DW2200|2026-09-07")];
  const snap = controlled.snapshotExistingOfficialRows(rows);
  if (snap.length !== 2) throw new Error(String(snap.length));
});

test("10. update proposal blocks baseline", () => {
  const rows = [...controlled.DISNEY_LEGACY_ROW_IDS.map((id) => makeLegacy(id)), makeOfficial("A|2026-09-01")];
  const manifest = [{ official_product_key: "A|2026-09-01", action: "update_exact_existing" }];
  const baseline = controlled.verifyCumulativeProductionBaseline(rows, simWithManifest({}, manifest));
  if (baseline.ok) throw new Error("should fail");
});

test("11. master plan deterministic partition", () => {
  const ids = Array.from({ length: 503 }, (_, i) => `I${String(i).padStart(3, "0")}|2026-09-${String((i % 28) + 1).padStart(2, "0")}`);
  const sorted = controlled.sortPlannedIdentityKeys(ids);
  const h1 = controlled.hashMasterPlanIdentities(sorted);
  const h2 = controlled.hashMasterPlanIdentities(sorted);
  if (h1 !== h2) throw new Error("hash unstable");
});

test("12. master plan cannot expand after creation", () => {
  const master = {
    mode: controlled.CATCHUP_MASTER_PLAN_MODE,
    overall_planned_identity_hash: "abc",
    ordered_planned_identities: ["A|2026-09-01"]
  };
  const freeze = {
    mode: controlled.CATCHUP_MANIFEST_MODE,
    master_plan_hash: "abc",
    frozen_identities: ["A|2026-09-01", "B|2026-09-08"],
    entries: [{ official_sailing_id: "A|2026-09-01" }, { official_sailing_id: "B|2026-09-08" }]
  };
  const check = controlled.verifyMasterPlanIdentityMembership(master, freeze);
  if (check.ok) throw new Error("extra identity should fail");
});

test("13. 503 partitions 100/100/100/100/100/3", () => {
  const ids = Array.from({ length: 503 }, (_, i) => `P${i}|2026-10-01`);
  const batches = controlled.partitionMasterPlanIdentities(ids);
  if (batches.length !== 6) throw new Error(`batch count ${batches.length}`);
  if (batches.map((b) => b.batch_size).join(",") !== "100,100,100,100,100,3") throw new Error(batches.map((b) => b.batch_size).join(","));
  if (batches[0].batch_number !== 2) throw new Error("starts at 2");
});

test("14. final batch of 3 validates", () => {
  const report = {
    mode: controlled.CATCHUP_MANIFEST_MODE,
    batch_size: 3,
    strategy: "insert_only",
    adapter_version: require(path.join(root, "netlify/functions/lib/disney-discovery-adapter")).ADAPTER_VERSION,
    entries: Array.from({ length: 3 }, (_, i) => ({
      official_sailing_id: `F${i}|2026-09-01`,
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
    report.adapter_version
  );
  const v = controlled.validateCatchupFrozenManifest(report, { expectedCount: 3 });
  if (!v.ok) throw new Error(v.failures.join(","));
});

test("15. 101 still rejected", () => {
  const report = {
    mode: controlled.CATCHUP_MANIFEST_MODE,
    batch_size: 101,
    strategy: "insert_only",
    adapter_version: "x",
    frozen_candidate_hash: "x",
    entries: Array.from({ length: 101 }, () => ({ official_sailing_id: "x" }))
  };
  const v = controlled.validateCatchupFrozenManifest(report, { expectedCount: 101 });
  if (v.ok) throw new Error("101 should fail");
});

test("16. zero-row apply rejected", () => {
  const gate = controlled.evaluateCatchupPreWriteGate({ expectedCount: 0, selectedCount: 0, sourceComplete: true, cumulativeBaselineOk: true, legacyBaselineOk: true, eligibilityArithmeticPass: true, oneWayNativeParsePass: true, lockSmokePassed: true });
  if (gate.passed) throw new Error("zero should fail");
});

test("17. apply requires batch-number >= 2", () => {
  try {
    parsePhase4bArgs(["node", "script", "--apply", "--batch-number=1", "--confirm=DISNEY-CONTROLLED-CATCHUP"]);
    throw new Error("should fail");
  } catch (e) {
    if (!String(e.message).includes("batch number")) throw e;
  }
});

test("18. duplicate audit clean inventory", () => {
  const rows = [makeOfficial("A|2026-09-01"), makeOfficial("B|2026-09-08")];
  const audit = controlled.auditOfficialDuplicateKeys(rows);
  if (!audit.passed) throw new Error(JSON.stringify(audit));
});

test("19. new post-plan source identity detected", () => {
  const master = { ordered_planned_identities: ["A|2026-09-01"] };
  const sim = simWithManifest({}, [
    { official_product_key: "A|2026-09-01", action: "duplicate_skip" },
    { official_product_key: "NEW|2026-12-01", action: "insert_active" }
  ]);
  const extra = controlled.computeNewSourceInsertsSinceMasterPlan(sim, master);
  if (extra.length !== 1 || extra[0] !== "NEW|2026-12-01") throw new Error(JSON.stringify(extra));
});

test("20. remaining master plan identities shrink", () => {
  const master = { ordered_planned_identities: ["A|2026-09-01", "B|2026-09-08", "C|2026-09-15"] };
  const remaining = controlled.remainingMasterPlanIdentities(master, new Set(["A|2026-09-01"]));
  if (remaining.length !== 2) throw new Error(JSON.stringify(remaining));
});

console.log(`\n${passed} disney-phase4b-cumulative tests passed`);
if (process.exitCode) process.exit(process.exitCode);
