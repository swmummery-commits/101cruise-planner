#!/usr/bin/env node
/**
 * Royal Caribbean final catch-up tests (mocked — no production writes).
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const catchup = require(path.join(root, "netlify/functions/lib/royal-caribbean-final-catchup"));
const writes = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-writes"));
const batch = require(path.join(root, "netlify/functions/lib/royal-caribbean-controlled-batch"));

const RC_LINE = { id: catchup.RC_LINE_ID, name: "Royal Caribbean International" };
let passed = 0;
let failed = 0;
const failures = [];
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
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
      nights: 7,
      departure_port: "Miami",
      official_url: `https://example.com/${id}`,
      external_key: `external-${id}`,
      identity_key: `identity-${id}`,
      official_sailing_id: id,
      status: "active"
    },
    ...overrides
  };
}

function buildMaster(entryCount) {
  const entries = Array.from({ length: entryCount }, (_, i) =>
    buildEntry(`VY03C${String(i).padStart(4, "0")}_2026-11-01`)
  );
  const manifest = {
    mode: catchup.CATCHUP_MASTER_MODE,
    catchup_id: "test-catchup",
    perth_today: "2026-08-13",
    source_snapshot_id: "snap1",
    source_fetched_at: new Date().toISOString(),
    expected_record_count: entryCount,
    entries
  };
  manifest.manifest_hash = batch.computeManifestHash(manifest);
  return manifest;
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

test("master manifest duplicate sailing ID rejected", () => {
  const m = buildMaster(3);
  m.entries[1].official_sailing_id = m.entries[0].official_sailing_id;
  const result = catchup.validateMasterManifest(m);
  if (result.passed) throw new Error("duplicate should fail");
});

test("master manifest ≤21-day rejected", () => {
  const m = buildMaster(2);
  m.entries[0].departure_date = "2026-08-20";
  const result = catchup.validateMasterManifest(m, { today: "2026-08-13" });
  if (result.passed) throw new Error("21-day should fail");
});

test("master manifest ISLAN rejected", () => {
  const m = buildMaster(2);
  m.entries[0].destination_source_code = "ISLAN";
  const result = catchup.validateMasterManifest(m);
  if (result.passed) throw new Error("ISLAN should fail");
});

test("invalid master hash rejected", () => {
  const m = buildMaster(2);
  let threw = false;
  try {
    catchup.validateMasterManifest(m, { expectedHash: "deadbeef" });
  } catch {
    threw = true;
  }
  const result = catchup.validateMasterManifest(m, { expectedHash: "deadbeef" });
  if (result.passed) throw new Error("bad hash should fail");
});

test("chunk 0 rejected", () => {
  const master = buildMaster(0);
  const { chunks } = catchup.splitMasterIntoChunks(master);
  if (chunks.length !== 0) throw new Error("empty master should produce 0 chunks");
});

test("chunk 1 accepted", () => {
  const master = buildMaster(1);
  const { chunks } = catchup.splitMasterIntoChunks(master);
  if (chunks.length !== 1 || chunks[0].record_count !== 1) throw new Error("1 record chunk");
});

test("chunk 249 accepted", () => {
  const master = buildMaster(249);
  const { chunks } = catchup.splitMasterIntoChunks(master);
  if (chunks.length !== 1 || chunks[0].record_count !== 249) throw new Error("249 chunk");
});

test("chunk 250 accepted", () => {
  const master = buildMaster(250);
  const { chunks } = catchup.splitMasterIntoChunks(master);
  if (chunks.length !== 1 || chunks[0].record_count !== 250) throw new Error("250 chunk");
});

test("chunk 251 splits into 2", () => {
  const master = buildMaster(251);
  const { chunks } = catchup.splitMasterIntoChunks(master);
  if (chunks.length !== 2 || chunks[0].record_count !== 250 || chunks[1].record_count !== 1) {
    throw new Error("251 should split 250+1");
  }
});

test("deterministic chunk boundaries", () => {
  const a = catchup.splitMasterIntoChunks(buildMaster(300));
  const b = catchup.splitMasterIntoChunks(buildMaster(300));
  if (a.chunks[0].manifest_hash !== b.chunks[0].manifest_hash) throw new Error("deterministic");
});

test("final partial chunk accepted", () => {
  const master = buildMaster(275);
  const { chunks } = catchup.splitMasterIntoChunks(master);
  if (chunks[1].record_count !== 25) throw new Error("partial final chunk");
});

test("chunk must belong to master manifest", () => {
  const master = buildMaster(5);
  const { chunks } = catchup.splitMasterIntoChunks(master);
  chunks[0].manifest.entries[0].official_sailing_id = "FAKE_2026-11-01";
  const result = catchup.validateCatchupChunk(chunks[0].manifest, master);
  if (result.passed) throw new Error("foreign entry should fail");
});

test("modified chunk invalidates hash", () => {
  const master = buildMaster(3);
  const { chunks } = catchup.splitMasterIntoChunks(master);
  const originalHash = chunks[0].manifest.manifest_hash;
  chunks[0].manifest.entries[0].official_sailing_id = "TAMPERED_2026-11-01";
  chunks[0].manifest.manifest_hash = batch.computeManifestHash(chunks[0].manifest);
  let threw = false;
  try {
    writes.assertCatchupChunkManifest(chunks[0].manifest, master, { expectedHash: originalHash });
  } catch (error) {
    threw = error.code === "royal_caribbean_manifest_hash_mismatch" || error.code === "royal_caribbean_manifest_validation_failed";
  }
  if (!threw) throw new Error("hash mismatch should reject");
});

test("251-record single chunk rejected by apply assert", () => {
  const master = buildMaster(251);
  const fakeChunk = {
    mode: catchup.CATCHUP_CHUNK_MODE,
    master_manifest_hash: master.manifest_hash,
    perth_today: "2026-08-13",
    entries: master.entries,
    manifest_hash: batch.computeManifestHash({ entries: master.entries })
  };
  let threw = false;
  try {
    writes.assertCatchupChunkManifest(fakeChunk, master);
  } catch (error) {
    threw = error.code === "royal_caribbean_catchup_chunk_size_invalid";
  }
  if (!threw) throw new Error("251 single chunk should reject");
});

test("catchup confirm token enforced", () => {
  const master = buildMaster(2);
  const { chunks } = catchup.splitMasterIntoChunks(master);
  let threw = false;
  try {
    writes.assertCatchupChunkManifest(chunks[0].manifest, master, { confirmToken: "WRONG-TOKEN" });
  } catch (error) {
    threw = error.code === "royal_caribbean_confirm_token_mismatch";
  }
  if (!threw) throw new Error("wrong token should reject");
});

test("MAX chunk constant is 250", () => {
  if (catchup.MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK !== 250) throw new Error("max must be 250");
});

test("catchup uses >21-day rule not 45-day", () => {
  const product = {
    product_type: "ocean_cruise",
    complete_high_confidence: true,
    status_class: "open",
    time_eligibility: "eligible",
    ship_resolution: { resolved: true },
    destination_resolution: { status: "resolved" },
    raw: {
      departure_date: "2026-09-05",
      ship_code: "OA",
      package_code: "X",
      sailing_status: "OPEN",
      official_sailing_id: "OA7TEST_2026-09-05"
    },
    candidate: { departure_date: "2026-09-05" },
    failure_reasons: []
  };
  if (!catchup.isCatchupEligible(product, "2026-08-13")) throw new Error("22-44 day should be eligible for catchup");
});

await runTests();
