#!/usr/bin/env node
/**
 * Royal Caribbean controlled batch write-layer tests (mocked — no production writes).
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const mode = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-mode"));
const writes = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-writes"));
const batch = require(path.join(root, "netlify/functions/lib/royal-caribbean-controlled-batch"));

const RC_LINE = { id: batch.RC_LINE_ID, name: "Royal Caribbean International" };

let passed = 0;
let failed = 0;
const failures = [];
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failed += 1;
      failures.push({ name, error: error.message || String(error) });
    }
  }
  if (failures.length) {
    console.error(`\n${failed} failed, ${passed} passed`);
    for (const f of failures) console.error(`✗ ${f.name}: ${f.error}`);
    process.exit(1);
  }
  console.log(`\n${passed} passed`);
}

function buildEntry(id, overrides = {}) {
  return {
    official_sailing_id: id,
    identity_key: `identity-${id}`,
    external_key: `external-${id}`,
    resolved_ship_db_id: "ship-1",
    resolved_embarkation_port_name: "Miami",
    resolved_destination_id: "dest-1",
    destination_source_code: "CARIB",
    departure_date: "2026-11-01",
    nights: 7,
    proposed_action: "insert_active",
    candidate: {
      cruise_line_id: RC_LINE.id,
      ship_id: "ship-1",
      destination_id: "dest-1",
      departure_date: "2026-11-01",
      return_date: "2026-11-08",
      nights: 7,
      departure_port: "Miami",
      official_url: `https://www.royalcaribbean.com/itinerary/${id}`,
      external_key: `external-${id}`,
      identity_key: `identity-${id}`,
      official_sailing_id: id,
      status: "active"
    },
    ...overrides
  };
}

function buildManifest(entryCount, profile = batch.CONTROLLED_BATCH_PROFILES.batch1, overrides = {}) {
  const entries = Array.from({ length: entryCount }, (_, i) =>
    buildEntry(`VY03X0${String(i).padStart(3, "0")}_2026-11-01`)
  );
  const manifest = {
    mode: profile.manifest_mode,
    expected_record_count: profile.max_batch_size,
    max_batch_size: profile.max_batch_size,
    confirm_token: profile.confirm_token,
    perth_today: "2026-08-13",
    entries,
    ...overrides
  };
  manifest.manifest_hash = batch.computeManifestHash(manifest);
  return manifest;
}

test("default write mode is OFF", () => {
  const gate = mode.resolveRoyalCaribbeanDiscoveryMode();
  if (gate.writes_allowed !== false) throw new Error("writes should be off");
});

test("controlled_batch requires write flag", () => {
  const prev = process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED;
  delete process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED;
  delete require.cache[require.resolve(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-mode"))];
  const freshMode = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-mode"));
  const gate = freshMode.resolveRoyalCaribbeanDiscoveryMode("controlled_batch");
  if (gate.writes_allowed !== false) throw new Error("should require flag");
  if (prev) process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED = prev;
});

test("apply without manifest rejects", async () => {
  process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED = "true";
  delete require.cache[require.resolve(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-mode"))];
  delete require.cache[require.resolve(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-writes"))];
  const freshWrites = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-writes"));
  let threw = false;
  try {
    await freshWrites.applyRoyalCaribbeanBatchWrites({ mode: "controlled_batch", cruiseLine: RC_LINE });
  } catch (error) {
    threw =
      error.code === "royal_caribbean_writes_disabled" ||
      error.code === "royal_caribbean_missing_frozen_manifest";
  }
  delete process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED;
  if (!threw) throw new Error("expected reject");
});

test("batch1: 21-record manifest rejected", () => {
  const manifest = buildManifest(21, batch.CONTROLLED_BATCH_PROFILES.batch1);
  let threw = false;
  try {
    writes.assertControlledBatchManifest(manifest);
  } catch (error) {
    threw =
      error.code === "royal_caribbean_batch_limit_exceeded" ||
      error.code === "royal_caribbean_manifest_validation_failed" ||
      error.code === "royal_caribbean_batch_size_not_allowed";
  }
  if (!threw) throw new Error("21 records should reject for batch1");
});

test("batch2: 100-record manifest validates", () => {
  const manifest = buildManifest(100, batch.CONTROLLED_BATCH_PROFILES.batch2);
  const result = batch.validateFrozenManifest(manifest, { expectedHash: manifest.manifest_hash, today: "2026-08-13" });
  if (!result.passed) throw new Error(JSON.stringify(result.failures));
});

test("batch2: 101-record manifest rejected", () => {
  const manifest = buildManifest(101, batch.CONTROLLED_BATCH_PROFILES.batch2);
  let threw = false;
  try {
    writes.assertControlledBatchManifest(manifest);
  } catch (error) {
    threw =
      error.code === "royal_caribbean_batch_limit_exceeded" ||
      error.code === "royal_caribbean_manifest_validation_failed" ||
      error.code === "royal_caribbean_batch_size_not_allowed";
  }
  if (!threw) throw new Error("101 records should reject for batch2");
});

test("batch2: 20-record batch1 manifest cannot pass as batch2 apply", () => {
  const manifest = buildManifest(20, batch.CONTROLLED_BATCH_PROFILES.batch1);
  let threw = false;
  try {
    writes.assertControlledBatchManifest(manifest, {
      expectedCount: 100,
      confirmToken: batch.CONTROLLED_BATCH_PROFILES.batch2.confirm_token
    });
  } catch (error) {
    threw =
      error.code === "royal_caribbean_manifest_count_mismatch" ||
      error.code === "royal_caribbean_manifest_validation_failed" ||
      error.code === "royal_caribbean_confirm_token_mismatch";
  }
  if (!threw) throw new Error("batch1 manifest must not authorise batch2");
});

test("arbitrary count (50) rejected", () => {
  const manifest = buildManifest(50, batch.CONTROLLED_BATCH_PROFILES.batch1, {
    expected_record_count: 50,
    max_batch_size: 50
  });
  const result = batch.validateFrozenManifest(manifest);
  if (result.passed) throw new Error("50-record manifest should fail");
});

test("empty manifest rejected", () => {
  const manifest = buildManifest(0, batch.CONTROLLED_BATCH_PROFILES.batch1);
  const result = batch.validateFrozenManifest(manifest);
  if (result.passed) throw new Error("empty should fail");
});

test("batch1: 20-record manifest validates", () => {
  const manifest = buildManifest(20, batch.CONTROLLED_BATCH_PROFILES.batch1);
  const result = batch.validateFrozenManifest(manifest, { expectedHash: manifest.manifest_hash, today: "2026-08-13" });
  if (!result.passed) throw new Error(JSON.stringify(result.failures));
});

test("incorrect manifest hash rejects", () => {
  const manifest = buildManifest(20, batch.CONTROLLED_BATCH_PROFILES.batch1);
  let threw = false;
  try {
    writes.assertControlledBatchManifest(manifest, { expectedHash: "deadbeef" });
  } catch (error) {
    threw = error.code === "royal_caribbean_manifest_hash_mismatch";
  }
  if (!threw) throw new Error("hash mismatch should reject");
});

test("duplicate sailing IDs rejected", () => {
  const manifest = buildManifest(20, batch.CONTROLLED_BATCH_PROFILES.batch1);
  manifest.entries[1].official_sailing_id = manifest.entries[0].official_sailing_id;
  manifest.manifest_hash = batch.computeManifestHash(manifest);
  const result = batch.validateFrozenManifest(manifest);
  if (result.passed) throw new Error("duplicate ids should fail");
});

test("batch overlap with batch1 rejected", () => {
  const manifest = buildManifest(100, batch.CONTROLLED_BATCH_PROFILES.batch2);
  manifest.entries[0].official_sailing_id = batch.BATCH1_OFFICIAL_SAILING_IDS[0];
  const result = batch.validateFrozenManifest(manifest, { priorSailingIds: batch.BATCH1_OFFICIAL_SAILING_IDS });
  if (result.passed) throw new Error("batch1 overlap should fail");
});

test("ISLAN candidate rejected", () => {
  const manifest = buildManifest(20, batch.CONTROLLED_BATCH_PROFILES.batch1);
  manifest.entries[0].destination_source_code = "ISLAN";
  const result = batch.validateFrozenManifest(manifest);
  if (result.passed) throw new Error("ISLAN should fail");
});

test("within 45-day buffer rejected", () => {
  const manifest = buildManifest(20, batch.CONTROLLED_BATCH_PROFILES.batch1);
  manifest.entries[0].departure_date = "2026-09-01";
  const result = batch.validateFrozenManifest(manifest, { today: "2026-08-13" });
  if (result.passed) throw new Error("45-day buffer should fail");
});

test("deterministic manifest hash", () => {
  const a = buildManifest(20, batch.CONTROLLED_BATCH_PROFILES.batch1);
  const b = buildManifest(20, batch.CONTROLLED_BATCH_PROFILES.batch1);
  if (a.manifest_hash !== b.manifest_hash) throw new Error("hash should be deterministic");
});

test("batch2 confirm token mismatch rejects apply", () => {
  const manifest = buildManifest(100, batch.CONTROLLED_BATCH_PROFILES.batch2);
  let threw = false;
  try {
    writes.assertControlledBatchManifest(manifest, {
      confirmToken: batch.CONTROLLED_BATCH_PROFILES.batch1.confirm_token
    });
  } catch (error) {
    threw = error.code === "royal_caribbean_confirm_token_mismatch";
  }
  if (!threw) throw new Error("wrong confirm token should reject");
});

test("allowed batch sizes are 20 and 100 only", () => {
  if (!batch.ALLOWED_CONTROLLED_BATCH_SIZES.has(20) || !batch.ALLOWED_CONTROLLED_BATCH_SIZES.has(100)) {
    throw new Error("allowed sizes must include 20 and 100");
  }
  if (batch.ALLOWED_CONTROLLED_BATCH_SIZES.has(101)) throw new Error("101 must not be allowed");
});

test("MAX batch constants", () => {
  if (batch.MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH_1 !== 20) throw new Error("batch1 max must be 20");
  if (batch.MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH_2 !== 100) throw new Error("batch2 max must be 100");
});

await runTests();
