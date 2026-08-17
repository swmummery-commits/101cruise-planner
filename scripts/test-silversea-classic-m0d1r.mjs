#!/usr/bin/env node
/**
 * Silversea Classic M0D1R — protection hardening + M0D2 prep tests.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const classic = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
const expedition = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const { buildAuthoritativeVerificationResult } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-controlled-production-run"
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

function assertMaskingFailsWhenProtectionFails(verificationOk, protectionOk) {
  const result = buildAuthoritativeVerificationResult({
    aggregateOk: verificationOk && protectionOk,
    verification: { ok: verificationOk, verified_count: 200, failed_count: 0 }
  });
  return result.ok === (verificationOk && protectionOk);
}

test("authoritative ok cannot be overwritten by nested verification.ok", () => {
  const result = buildAuthoritativeVerificationResult({
    aggregateOk: false,
    verification: { ok: true, verified_count: 200, failed_count: 0 },
    protection: { expedition_unchanged: false }
  });
  if (result.ok !== false) throw new Error(`expected false got ${result.ok}`);
  if (result.verified_count !== 200) throw new Error("verification body preserved");
});

test("Expedition protection fail forces overall fail", () => {
  if (!assertMaskingFailsWhenProtectionFails(true, false)) throw new Error("expedition fail masked");
});

test("Classic target pass with all protection pass stays ok", () => {
  if (!assertMaskingFailsWhenProtectionFails(true, true)) throw new Error("valid pass blocked");
});

test("target verification pass alone is not sufficient", () => {
  const result = buildAuthoritativeVerificationResult({
    aggregateOk: false,
    verification: { ok: true, verified_count: 200, failed_count: 0 }
  });
  if (result.ok !== false) throw new Error("aggregate must govern");
});

test("semantic raw_extract ignores key order", () => {
  const a = { z: 1, a: { y: 2, b: 3 } };
  const b = { a: { b: 3, y: 2 }, z: 1 };
  if (!expedition.semanticJsonEqual(a, b)) throw new Error("key order should not matter");
  if (expedition.semanticJsonEqual(a, { z: 1, a: { y: 2, b: 4 } })) throw new Error("value change must fail");
});

test("legacy JSON.stringify detects key-order-only as different", () => {
  const a = { z: 1, a: 2 };
  const b = { a: 2, z: 1 };
  if (JSON.stringify(a) === JSON.stringify(b)) throw new Error("legacy may differ on order");
  if (!expedition.compareComparableFieldValues("raw_extract", a, b)) throw new Error("semantic should match");
});

test("real raw_extract mutation is detected", () => {
  const before = {
    silversea_cruise_code: "OR261003007",
    itinerary_stops: [{ kind: "port", port_name: "Puerto Ayora" }]
  };
  const after = {
    silversea_cruise_code: "OR261003007",
    itinerary_stops: [{ kind: "port", port_name: "Puerto Baquerizo Moreno" }]
  };
  if (expedition.compareComparableFieldValues("raw_extract", before, after)) {
    throw new Error("semantic port change must fail");
  }
});

test("controlled_batch metadata change is detected", () => {
  const before = { controlled_batch: { run_id: "a", phase: "e4" }, silversea_cruise_code: "X" };
  const after = { controlled_batch: { run_id: "b", phase: "e4" }, silversea_cruise_code: "X" };
  if (expedition.compareComparableFieldValues("raw_extract", before, after)) {
    throw new Error("run_id change must fail");
  }
});

test("M0D2 partition is exactly rows 201-400", () => {
  const master = JSON.parse(
    fs.readFileSync(path.join(root, classic.M0C_BACKFILL_FIXTURE), "utf8")
  );
  const partition = classic.partitionMasterClassicFixture(master);
  const m0d2 = classic.buildM0d2BatchFixture({ partition, generatedAt: "test", gitSha: "test" });
  const m0d1Ids = new Set(partition.batches.m0d1.rows.map((r) => r.production_uuid));
  const m0d3Ids = new Set(partition.batches.m0d3.rows.map((r) => r.production_uuid));
  if (m0d2.rows.length !== 200) throw new Error(`count ${m0d2.rows.length}`);
  for (const row of m0d2.rows) {
    if (m0d1Ids.has(row.production_uuid) || m0d3Ids.has(row.production_uuid)) {
      throw new Error(`overlap ${row.production_uuid}`);
    }
  }
});

test("M0D2 dry run is update-only when fixture valid", () => {
  const master = JSON.parse(
    fs.readFileSync(path.join(root, classic.M0C_BACKFILL_FIXTURE), "utf8")
  );
  const partition = classic.partitionMasterClassicFixture(master);
  const m0d2 = classic.buildM0d2BatchFixture({ partition, generatedAt: "test", gitSha: "test" });
  const dry = classic.dryRunClassicItineraryPortsBackfill(m0d2);
  if (dry.proposed_itinerary_ports_updates !== 200) throw new Error(String(dry.proposed_itinerary_ports_updates));
  if (dry.proposed_inserts !== 0 || dry.proposed_deletes !== 0 || dry.other_column_updates !== 0) {
    throw new Error("non update-only");
  }
});

test("flagged expedition UUIDs are not in M0D1 master partition", () => {
  const master = JSON.parse(
    fs.readFileSync(path.join(root, classic.M0C_BACKFILL_FIXTURE), "utf8")
  );
  const partition = classic.partitionMasterClassicFixture(master);
  const classicIds = new Set(partition.sorted.map((r) => r.production_uuid));
  for (const uuid of [
    "f4cfb44a-44cf-4bae-8bcd-601721b74466",
    "3362fb6c-a29f-41e4-a251-51b514ef03f0"
  ]) {
    if (classicIds.has(uuid)) throw new Error(`${uuid} in classic master`);
  }
});

console.log(`\nM0D1R tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
