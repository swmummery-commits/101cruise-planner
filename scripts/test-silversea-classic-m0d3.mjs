#!/usr/bin/env node
/**
 * Silversea Classic M0D3 — final apply runner tests.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const classic = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
const { buildAuthoritativeVerificationResult } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-controlled-production-run"
));
const { assertPostWriteVerifierImportsResolved, M0D3_USES_HARDENED_RUNNER, M0D3_RUNNER_PATH } = await import(
  path.join(root, "scripts/run-silversea-classic-m0d3-apply.mjs")
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

const master = JSON.parse(fs.readFileSync(path.join(root, classic.M0C_BACKFILL_FIXTURE), "utf8"));
const partition = classic.partitionMasterClassicFixture(master);
const m0d3 = classic.buildM0d3BatchFixture({ partition });

test("M0D3 runner uses hardened lifecycle", () => {
  if (!M0D3_USES_HARDENED_RUNNER) throw new Error("expected hardened runner");
  if (M0D3_RUNNER_PATH !== "scripts/run-silversea-classic-m0d3-apply.mjs") throw new Error("path");
});

test("post-write verifier imports resolve", () => {
  const smoke = assertPostWriteVerifierImportsResolved();
  if (!smoke.ok) throw new Error("imports");
});

test("M0D3 fixture has 199 Classic rows", () => {
  const v = classic.validateClassicRepairFixture(m0d3);
  if (!v.ok || v.row_count !== 199) throw new Error(JSON.stringify(v));
});

test("M0D3 rows are partition batch 401-599", () => {
  const m0d1Ids = new Set(partition.batches.m0d1.rows.map((r) => r.production_uuid));
  const m0d2Ids = new Set(partition.batches.m0d2.rows.map((r) => r.production_uuid));
  const m0d3MasterIds = new Set(partition.batches.m0d3.rows.map((r) => r.production_uuid));
  for (const row of m0d3.rows) {
    if (!m0d3MasterIds.has(row.production_uuid)) throw new Error(`not in master m0d3: ${row.production_uuid}`);
    if (m0d1Ids.has(row.production_uuid) || m0d2Ids.has(row.production_uuid)) {
      throw new Error(`overlap ${row.production_uuid}`);
    }
  }
});

test("master partition covers all 599 rows with no overlap", () => {
  const pv = classic.validateClassicPartition(partition);
  if (!pv.ok) throw new Error(JSON.stringify(pv));
  if (partition.batches.m0d1.count !== 200) throw new Error("m0d1 count");
  if (partition.batches.m0d2.count !== 200) throw new Error("m0d2 count");
  if (partition.batches.m0d3.count !== 199) throw new Error("m0d3 count");
});

test("M0D3 confirmation token stable", () => {
  if (classic.M0D3_APPLY_CONFIRMATION_TOKEN !== "SILVERSEA-CLASSIC-M0D3-ITINERARY-PORTS-BACKFILL") {
    throw new Error("token");
  }
});

test("M0D1/M0D2 protection fail forces aggregate fail", () => {
  const result = buildAuthoritativeVerificationResult({
    aggregateOk: false,
    verification: { ok: true, verified_count: 199, failed_count: 0 },
    protection: { m0d1_unchanged: false, m0d2_unchanged: true }
  });
  if (result.ok !== false) throw new Error("masking");
});

test("dry run is update-only for M0D3 batch", () => {
  const dry = classic.dryRunClassicItineraryPortsBackfill(m0d3);
  if (dry.proposed_itinerary_ports_updates !== 199) throw new Error(String(dry.proposed_itinerary_ports_updates));
  if (dry.proposed_inserts !== 0 || dry.proposed_deletes !== 0 || dry.other_column_updates !== 0) {
    throw new Error("not update-only");
  }
});

console.log(`\nM0D3 tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
