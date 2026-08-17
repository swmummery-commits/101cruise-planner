#!/usr/bin/env node
/**
 * Silversea Classic M0D1 — partition + apply runner tests.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const classic = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
const { assertPostWriteVerifierImportsResolved, M0D1_USES_HARDENED_RUNNER, M0D1_RUNNER_PATH } = await import(
  path.join(root, "scripts/run-silversea-classic-m0d1-apply.mjs")
);

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

const masterPath = path.join(root, classic.M0C_BACKFILL_FIXTURE);
const master = JSON.parse(fs.readFileSync(masterPath, "utf8"));

test("M0D1 runner uses hardened lifecycle", () => {
  if (!M0D1_USES_HARDENED_RUNNER) throw new Error("expected hardened runner");
  if (M0D1_RUNNER_PATH !== "scripts/run-silversea-classic-m0d1-apply.mjs") throw new Error("path");
});

test("post-write verifier imports resolve", () => {
  const smoke = assertPostWriteVerifierImportsResolved();
  if (!smoke.ok) throw new Error("imports");
});

test("master fixture has 599 Classic rows", () => {
  const v = classic.validateClassicRepairFixture(master);
  if (!v.ok || v.row_count !== 599) throw new Error(JSON.stringify(v));
});

test("partition is exactly 200/200/199 with no overlap", () => {
  const partition = classic.partitionMasterClassicFixture(master);
  const v = classic.validateClassicPartition(partition);
  if (!partition.ok || !v.ok) throw new Error(JSON.stringify({ partition, v }));
  if (partition.coverage.duplicate_ids !== 0) throw new Error("dup");
  if (partition.coverage.master_count !== 599) throw new Error("coverage");
});

test("M0D1 batch fixture contains only first 200 rows", () => {
  const partition = classic.partitionMasterClassicFixture(master);
  const m0d1 = classic.buildM0d1BatchFixture({ partition, gitSha: "test" });
  const v = classic.validateClassicRepairFixture(m0d1);
  if (!v.ok || m0d1.frozen_count !== 200) throw new Error(JSON.stringify(v));
  if (v.expedition_rows !== 0 || v.legacy_rows !== 0) throw new Error("non-classic");
});

test("M0D2/M0D3 IDs do not appear in M0D1 fixture", () => {
  const partition = classic.partitionMasterClassicFixture(master);
  const m0d1Ids = new Set(
    classic.buildM0d1BatchFixture({ partition }).rows.map((r) => String(r.official_sailing_id).toUpperCase())
  );
  for (const row of partition.batches.m0d2.rows) {
    if (m0d1Ids.has(String(row.official_sailing_id).toUpperCase())) throw new Error("m0d2 overlap");
  }
  for (const row of partition.batches.m0d3.rows) {
    if (m0d1Ids.has(String(row.official_sailing_id).toUpperCase())) throw new Error("m0d3 overlap");
  }
});

test("Classic source cutoff counts reconcile", () => {
  const products = [
    { raw: { cruise_type: "Classic" }, candidate: { departure_date: "2099-01-01" } },
    { raw: { cruise_type: "Classic" }, candidate: { departure_date: "2099-02-01" } },
    { raw: { cruise_type: "Expedition" }, candidate: { departure_date: "2099-03-01" } }
  ];
  const counts = classic.computeClassicSourceCutoffCounts({ products }, "2026-08-17");
  if (counts.classic_source_total !== 2) throw new Error(`total:${counts.classic_source_total}`);
  if (!counts.reconciles) throw new Error("not reconciled");
  if (!counts.m0c_classic_cutoff_count_discrepancy_explained) throw new Error("explanation flag");
});

test("M0D1 confirmation token stable", () => {
  if (classic.M0D1_APPLY_CONFIRMATION_TOKEN !== "SILVERSEA-CLASSIC-M0D1-ITINERARY-PORTS-BACKFILL") {
    throw new Error("token");
  }
});

test("dry run is update-only for M0D1 batch", () => {
  const partition = classic.partitionMasterClassicFixture(master);
  const m0d1 = classic.buildM0d1BatchFixture({ partition });
  const dry = classic.dryRunClassicItineraryPortsBackfill(m0d1);
  if (dry.proposed_itinerary_ports_updates !== 200 || dry.proposed_inserts !== 0) {
    throw new Error(JSON.stringify(dry));
  }
});

console.log(`\nM0D1 tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
