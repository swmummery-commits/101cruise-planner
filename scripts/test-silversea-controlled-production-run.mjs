#!/usr/bin/env node
/**
 * Hardened controlled production run tests.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  RUN_STATUS,
  buildPreWriteRollbackManifest,
  buildControlledBatchMarker,
  appendInsertedRecord,
  ControlledProductionRunStore,
  simulateCrashRecoveryScenarios,
  atomicWriteJson
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-controlled-production-run"));
const {
  DISCOVERED_CRUISE_EXPEDITION_VERIFY_COLUMNS,
  assertExpeditionVerifyProjectionValid
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-verification"));

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

test("verify projection excludes arrival_port", () => {
  assertExpeditionVerifyProjectionValid();
  if (DISCOVERED_CRUISE_EXPEDITION_VERIFY_COLUMNS.includes("arrival_port")) {
    throw new Error("arrival_port must not be in projection");
  }
});

test("pre-write rollback manifest starts PREPARED with empty inserted IDs", () => {
  const m = buildPreWriteRollbackManifest({
    runId: "run-1",
    fixturePath: "fixture.json",
    officialSailingIds: ["OR123"],
    expectedInserts: 1
  });
  if (m.status !== RUN_STATUS.PREPARED) throw new Error("status");
  if (m.inserted_record_ids.length !== 0) throw new Error("inserted ids");
  if (m.expected_updates !== 0) throw new Error("updates");
});

test("controlled batch marker includes run_id and fixture", () => {
  const m = buildControlledBatchMarker({ phase: "E6", runId: "run-x", fixture: "f.json" });
  if (m.run_id !== "run-x" || m.fixture !== "f.json") throw new Error("marker");
});

test("appendInsertedRecord tracks UUIDs durably", () => {
  let m = buildPreWriteRollbackManifest({ runId: "r", officialSailingIds: ["A"], expectedInserts: 1 });
  m = appendInsertedRecord(m, { discoveredCruiseId: "id-1", officialSailingId: "A" });
  if (m.inserted_record_ids[0] !== "id-1") throw new Error("uuid");
});

test("crash recovery by manifest and run_id match", () => {
  const manifest = {
    run_id: "run-crash",
    inserted_record_ids: ["u1", "u2"],
    inserted_official_sailing_ids: ["OR1", "OR2"]
  };
  const rows = [
    { id: "u1", raw_extract: { controlled_batch: { run_id: "run-crash" } } },
    { id: "u2", raw_extract: { controlled_batch: { run_id: "run-crash" } } }
  ];
  const r = simulateCrashRecoveryScenarios(manifest, rows);
  if (!r.independent_paths_match) throw new Error("recovery mismatch");
  if (r.broad_line_delete_required) throw new Error("broad delete");
});

test("durable manifest written before mutation (store)", () => {
  const tmp = path.join(root, "reports", `_test-controlled-run-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const store = new ControlledProductionRunStore(tmp, "test-run");
  const p = store.persistPreparedRollback(buildPreWriteRollbackManifest({ runId: "test-run", expectedInserts: 0 }));
  if (!fs.existsSync(p)) throw new Error("manifest missing");
  const read = store.readRollback();
  if (read.status !== RUN_STATUS.PREPARED) throw new Error("read status");
});

test("WRITE_SUCCEEDED_VERIFICATION_FAILED is distinct failure state", () => {
  if (RUN_STATUS.WRITE_SUCCEEDED_VERIFICATION_FAILED === RUN_STATUS.COMPLETE) {
    throw new Error("same as complete");
  }
});

console.log(`\ncontrolled-production-run: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
