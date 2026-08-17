#!/usr/bin/env node
/**
 * Silversea Expedition M0B — frozen fixture + repair helper tests.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  M0A_BACKFILL_FIXTURE,
  M0B_OPERATION,
  M0B_APPLY_CONFIRMATION_TOKEN,
  UPDATE_WHITELIST,
  validateRepairFixture,
  verifyFrozenBeforeMatch,
  buildM0bRollbackManifest,
  dryRunItineraryPortsBackfill,
  compareNonWhitelistSnapshots,
  snapshotComparableFields,
  isExpeditionOfficialId
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const { M0B_RUNNER_PATH, M0B_USES_HARDENED_RUNNER } = await import(
  path.join(root, "scripts/run-silversea-expedition-m0b-apply.mjs")
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

const fixturePath = path.join(root, M0A_BACKFILL_FIXTURE);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

test("M0B runner uses hardened lifecycle", () => {
  if (!M0B_USES_HARDENED_RUNNER) throw new Error("expected hardened runner");
  if (M0B_RUNNER_PATH !== "scripts/run-silversea-expedition-m0b-apply.mjs") {
    throw new Error("runner path mismatch");
  }
});

test("M0B confirmation token is stable", () => {
  if (M0B_APPLY_CONFIRMATION_TOKEN !== "SILVERSEA-EXPEDITION-M0B-ITINERARY-PORTS-BACKFILL") {
    throw new Error("token mismatch");
  }
});

test("frozen fixture validates 200 expedition repairs", () => {
  const v = validateRepairFixture(fixture);
  if (!v.ok) throw new Error(v.issues.join(","));
  if (v.row_count !== 200) throw new Error(`rows:${v.row_count}`);
  if (fixture.phase !== "M0A") throw new Error("phase must remain M0A");
});

test("all fixture rows are expedition official IDs", () => {
  for (const row of fixture.rows) {
    if (!isExpeditionOfficialId(row.official_sailing_id)) {
      throw new Error(`non_expedition:${row.official_sailing_id}`);
    }
  }
});

test("dry run proposes update-only mutations", () => {
  const dry = dryRunItineraryPortsBackfill(fixture);
  if (dry.proposed_itinerary_ports_updates !== 200) throw new Error("updates");
  if (dry.proposed_inserts !== 0 || dry.proposed_deletes !== 0) throw new Error("insert/delete");
  if (dry.other_column_updates !== 0) throw new Error("other columns");
  if (JSON.stringify(dry.update_whitelist) !== JSON.stringify(UPDATE_WHITELIST)) {
    throw new Error("whitelist");
  }
});

test("rollback manifest contains 200 exact entries", () => {
  const manifest = buildM0bRollbackManifest({
    runId: "test-run",
    rows: fixture.rows,
    expectedUpdates: 200
  });
  if (manifest.operation !== M0B_OPERATION) throw new Error("operation");
  if (manifest.rollback_entries.length !== 200) throw new Error("entries");
  if (manifest.expected_inserts !== 0 || manifest.expected_deletes !== 0) {
    throw new Error("insert/delete in manifest");
  }
});

test("verifyFrozenBeforeMatch accepts matching before state", () => {
  const row = fixture.rows[0];
  const prod = {
    id: row.production_uuid,
    official_sailing_id: row.official_sailing_id,
    itinerary_ports: row.before_itinerary_ports,
    ship_id: row.row_fingerprint.ship_id,
    departure_date: row.row_fingerprint.departure_date,
    return_date: row.row_fingerprint.return_date,
    nights: row.row_fingerprint.nights,
    destination_id: row.row_fingerprint.destination_id,
    status: row.row_fingerprint.status
  };
  const check = verifyFrozenBeforeMatch(prod, row);
  if (!check.ok) throw new Error(check.issues.join(","));
});

test("non-whitelist compare ignores itinerary_ports-only patch", () => {
  const before = {
    id: "u1",
    cruise_line_id: "l1",
    ship_id: "s1",
    destination_id: "d1",
    departure_date: "2028-01-01",
    return_date: "2028-01-08",
    nights: 7,
    departure_port: "A",
    itinerary: "A",
    status: "active",
    official_url: "https://x",
    source_url: null,
    official_sailing_id: "OR1",
    external_key: "e1",
    identity_key: "k1",
    match_confidence: 1,
    review_reason: null,
    raw_extract: { a: 1 }
  };
  const after = { ...before, itinerary_ports: ["Baltra"] };
  const cmp = compareNonWhitelistSnapshots(snapshotComparableFields(before), snapshotComparableFields(after));
  if (!cmp.ok) throw new Error(cmp.changed_fields.join(","));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
