#!/usr/bin/env node
/**
 * Carnival full catch-up unit tests (mocked — no network or production writes).
 * Run: node scripts/test-carnival-catchup.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const catchup = require(path.join(root, "netlify/functions/lib/carnival-final-catchup"));
const batch = require(path.join(root, "netlify/functions/lib/carnival-controlled-batch"));
const writes = require(path.join(root, "netlify/functions/lib/carnival-discovery-writes"));
const sourceAbsence = require(path.join(root, "netlify/functions/lib/carnival-source-absence"));
const { SOURCE_ID } = require(path.join(root, "netlify/functions/lib/carnival-discovery-source"));
const { daysUntilDeparture } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

const TODAY = "2026-08-15";
const LINE = { id: batch.CCL_LINE_ID, name: "Carnival Cruise Line", slug: batch.CCL_LINE_SLUG };

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

function buildEligibleProduct(sailingId, departureDate = "2026-12-01") {
  return {
    raw: {
      sailing_id: sailingId,
      itinerary_code: "ABC",
      ship_code: "CQ",
      departure_date: departureDate,
      arrival_date: "2026-12-08",
      nights: 7
    },
    candidate: {
      departure_date: departureDate,
      nights: 7,
      ship_id: "ship-1",
      destination_id: "dest-1",
      departure_port_meta: {
        status: "resolved",
        canonicalPortName: "Miami, FL"
      }
    },
    ship_resolution: { resolved: true, method: "official_line_ship_id" },
    destination_resolution: { resolved: true, destination_id: "dest-1" },
    eligibility: { discovery_ready: true },
    days_until_departure: daysUntilDeparture(departureDate, TODAY)
  };
}

function buildManifestEntry(id, overrides = {}) {
  return {
    official_sailing_id: id,
    identity_key: `identity-${id}`,
    departure_date: "2026-12-01",
    nights: 7,
    proposed_action: "insert_active",
    itinerary_code: "ABC",
    ship_code: "CQ",
    departure_port: "Miami, FL",
    destination_id: "dest-1",
    candidate: {
      cruise_line_id: LINE.id,
      ship_id: "ship-1",
      destination_id: "dest-1",
      departure_date: "2026-12-01",
      return_date: "2026-12-08",
      nights: 7,
      departure_port: "Miami, FL",
      official_sailing_id: id,
      status: "active"
    },
    ...overrides
  };
}

function buildMaster(entryCount, { perthToday = TODAY } = {}) {
  const entries = Array.from({ length: entryCount }, (_, i) =>
    buildManifestEntry(`CCL${String(i).padStart(5, "0")}`)
  );
  return catchup.buildMasterManifest({
    entries,
    cruiseLine: LINE,
    catchupId: "test-catchup",
    sourceSnapshotId: "snap-test",
    sourceFetchedAt: new Date().toISOString(),
    today: perthToday,
    codeSha: "test-sha"
  });
}

assert(catchup.MAX_CCL_CATCHUP_CHUNK === 250, "MAX_CCL_CATCHUP_CHUNK is 250");

const products = [
  buildEligibleProduct("300003", "2026-12-15"),
  buildEligibleProduct("100001", "2026-11-01"),
  buildEligibleProduct("200002", "2026-11-01")
];
const selectedA = catchup.selectCatchupCandidates(products, { today: TODAY });
const selectedB = catchup.selectCatchupCandidates(products, { today: TODAY });
assert(selectedA.selected.length === 3, "all fixture products are catch-up eligible");
assert(
  selectedA.selected.map((row) => row.raw.sailing_id).join(",") ===
    selectedB.selected.map((row) => row.raw.sailing_id).join(","),
  "selectCatchupCandidates ordering is deterministic"
);
assert(
  selectedA.selected[0].raw.sailing_id === "100001" && selectedA.selected[1].raw.sailing_id === "200002",
  "selectCatchupCandidates sorts by departure then sailing id"
);

const excluded = catchup.selectCatchupCandidates(products, {
  today: TODAY,
  excludeSailingIds: new Set(["100001"])
});
assert(excluded.selected.length === 2, "excludeSailingIds removes known official rows");
assert(
  !excluded.selected.some((row) => row.raw.sailing_id === "100001"),
  "excluded sailing id omitted from catch-up selection"
);

const master250 = buildMaster(250);
const split250 = catchup.splitMasterIntoChunks(master250);
assert(split250.chunks.length === 1 && split250.chunks[0].record_count === 250, "250 entries form one chunk");

const master251 = buildMaster(251);
const split251 = catchup.splitMasterIntoChunks(master251);
assert(
  split251.chunks.length === 2 &&
    split251.chunks[0].record_count === 250 &&
    split251.chunks[1].record_count === 1,
  "251 entries split 250 + 1"
);

const master275 = buildMaster(275);
const split275 = catchup.splitMasterIntoChunks(master275);
assert(split275.chunks[1].record_count === 25, "final partial chunk retains remainder records");

const duplicateMaster = buildMaster(3);
duplicateMaster.entries[1].official_sailing_id = duplicateMaster.entries[0].official_sailing_id;
const duplicateValidation = catchup.validateMasterManifest(duplicateMaster);
assert(duplicateValidation.passed === false, "validateMasterManifest rejects duplicate sailing ids");
assert(
  duplicateValidation.failures.includes("duplicate_official_sailing_ids"),
  "duplicate failure reason recorded"
);

const legacyOfficial = {
  id: "legacy-1",
  cruise_line_id: LINE.id,
  official_sailing_id: "LEGACY-999",
  status: "active",
  departure_date: "2026-12-01",
  raw_extract: { structured_source: "manual_import" }
};
const officialRow = {
  id: "official-1",
  cruise_line_id: LINE.id,
  official_sailing_id: "999001",
  status: "active",
  departure_date: "2026-12-01",
  raw_extract: { structured_source: SOURCE_ID }
};
const officialBySailingId = new Map();
const legacyRows = [];
for (const row of [legacyOfficial, officialRow]) {
  if (writes.isOfficialCclStructuredRecord(row) && row.official_sailing_id) {
    officialBySailingId.set(String(row.official_sailing_id), row);
  } else if (writes.isLegacyGenericCclRow(row)) {
    legacyRows.push(row);
  }
}
assert(writes.isLegacyGenericCclRow(legacyOfficial), "fixture row classified as legacy generic");
assert(!officialBySailingId.has("LEGACY-999"), "legacy generic row excluded from official index");
assert(officialBySailingId.has("999001"), "structured official row indexed by sailing id");
assert(legacyRows.length === 1 && legacyRows[0].id === "legacy-1", "legacy row tracked separately");

const validMaster = buildMaster(3);
const { chunks } = catchup.splitMasterIntoChunks(validMaster);
const oversizeChunk = {
  ...chunks[0].manifest,
  entries: Array.from({ length: 251 }, (_, i) => buildManifestEntry(`OVER${i}`))
};
const oversizeValidation = catchup.validateCatchupChunk(oversizeChunk, validMaster);
assert(oversizeValidation.passed === false, "validateCatchupChunk rejects chunks over 250");
assert(
  oversizeValidation.failures.some((f) => f.startsWith("chunk_exceeds_max:")),
  "oversize chunk failure names record count"
);

const completeSnapshot = {
  fetch_result: {
    ok: true,
    pagination: { exhausted: true, zero_progress_pages: 0 }
  },
  quality_gate_metrics: { duplicate_official_identities: 0 }
};
assert(
  sourceAbsence.isSourceSnapshotComplete(completeSnapshot) === true,
  "complete exhausted snapshot passes completeness check"
);

const incompleteSnapshots = [
  { fetch_result: { ok: false, pagination: { exhausted: true } } },
  { fetch_result: { ok: true, error: "timeout", pagination: { exhausted: true } } },
  { fetch_result: { ok: true, pagination: { exhausted: false } } },
  {
    fetch_result: { ok: true, pagination: { exhausted: true, zero_progress_pages: 1 } },
    quality_gate_metrics: { duplicate_official_identities: 0 }
  },
  {
    fetch_result: { ok: true, pagination: { exhausted: true, zero_progress_pages: 0 } },
    quality_gate_metrics: { duplicate_official_identities: 2 }
  }
];
for (const snapshot of incompleteSnapshots) {
  assert(
    sourceAbsence.isSourceSnapshotComplete(snapshot) === false,
    "isSourceSnapshotComplete blocks incomplete fetch snapshot"
  );
}

console.log(`carnival-catchup tests passed: ${passed}`);
