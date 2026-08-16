#!/usr/bin/env node
/**
 * Silversea Expedition Phase E3 — frozen batch preparation tests.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  EXPEDITION_BATCH_SIZE,
  E3_COMPLETE_POOL_FIXTURE,
  E3_FIRST_250_FIXTURE,
  loadFrozenExpeditionIds,
  expeditionCandidateSortKey,
  evaluateExpeditionPreWriteGate
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-controlled-batch"));
const { MAX_CONTROLLED_BATCH } = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const { buildItineraryPorts } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const { EXPEDITION_SEMANTIC } = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));
const { DEFAULT_GLOBAL_LEASE_SECONDS } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-global-write-lock"
));
const { PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    failed += 1;
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || "assert"}: expected ${expected}, got ${actual}`);
}

function assertTrue(value, msg) {
  if (!value) throw new Error(msg || "expected true");
}

const completeFixturePath = path.join(root, E3_COMPLETE_POOL_FIXTURE);
const first250FixturePath = path.join(root, E3_FIRST_250_FIXTURE);

test("E3 complete-pool fixture exists", () => {
  assertTrue(fs.existsSync(completeFixturePath), "missing complete pool fixture");
});

test("E3 first-250 fixture exists", () => {
  assertTrue(fs.existsSync(first250FixturePath), "missing first-250 fixture");
});

test("frozen count exactly 250", () => {
  const fixture = JSON.parse(fs.readFileSync(first250FixturePath, "utf8"));
  assertEqual(fixture.frozen_count, 250, "frozen_count");
  assertEqual(fixture.selection.selected_official_sailing_ids.length, 250, "selected ids");
});

test("frozen unique count exactly 250", () => {
  const fixture = JSON.parse(fs.readFileSync(first250FixturePath, "utf8"));
  assertEqual(fixture.frozen_unique_count, 250, "frozen_unique_count");
  const unique = new Set(fixture.selection.selected_official_sailing_ids.map((id) => String(id).toUpperCase()));
  assertEqual(unique.size, 250, "unique ids");
});

test("complete pool count >= 250", () => {
  const fixture = JSON.parse(fs.readFileSync(completeFixturePath, "utf8"));
  assertTrue(fixture.complete_candidate_count >= 250, "complete pool below 250");
  assertTrue(fixture.official_sailing_ids.length >= 250, "official ids below 250");
});

test("complete pool deterministic ordering", () => {
  const fixture = JSON.parse(fs.readFileSync(completeFixturePath, "utf8"));
  const ids = fixture.official_sailing_ids;
  const candidates = fixture.candidates || [];
  const sorted = [...candidates].sort((a, b) => {
    const ka = `${a.departure_date}|${String(a.official_sailing_id).toUpperCase()}`;
    const kb = `${b.departure_date}|${String(b.official_sailing_id).toUpperCase()}`;
    return ka.localeCompare(kb);
  });
  assertEqual(sorted.map((c) => c.official_sailing_id).join(","), ids.join(","), "ordering mismatch");
});

test("first-250 matches deterministic selection from complete pool", () => {
  const complete = JSON.parse(fs.readFileSync(completeFixturePath, "utf8"));
  const first250 = JSON.parse(fs.readFileSync(first250FixturePath, "utf8"));
  const expected = complete.official_sailing_ids.slice(0, EXPEDITION_BATCH_SIZE);
  assertEqual(
    first250.selection.selected_official_sailing_ids.join(","),
    expected.join(","),
    "first-250 selection policy"
  );
});

test("loadFrozenExpeditionIds reads fixture", () => {
  const fixture = JSON.parse(fs.readFileSync(first250FixturePath, "utf8"));
  const ids = loadFrozenExpeditionIds(fixture);
  assertEqual(ids.length, 250, "loaded ids");
});

test("batch ceiling remains 250", () => {
  assertEqual(MAX_CONTROLLED_BATCH, 250, "MAX_CONTROLLED_BATCH");
  assertEqual(EXPEDITION_BATCH_SIZE, 250, "EXPEDITION_BATCH_SIZE");
});

test("production expedition baseline zero in fixture", () => {
  const fixture = JSON.parse(fs.readFileSync(first250FixturePath, "utf8"));
  assertEqual(fixture.production_expedition_id_baseline, 0, "production baseline");
});

test("no ambiguity or match_required in fixture metadata", () => {
  const fixture = JSON.parse(fs.readFileSync(first250FixturePath, "utf8"));
  for (const c of fixture.candidates || []) {
    if ((c.ambiguous_stop_count || 0) > 0) {
      throw new Error(`ambiguous stops on ${c.official_sailing_id}`);
    }
  }
});

test("global lock lease headroom configured", () => {
  assertTrue(DEFAULT_GLOBAL_LEASE_SECONDS >= 1800, "lease too short");
});

test("expedition candidate sort key is departure then id", () => {
  const a = expeditionCandidateSortKey({
    candidate: { departure_date: "2026-09-01" },
    official_sailing_id: "OR260901001"
  });
  const b = expeditionCandidateSortKey({
    candidate: { departure_date: "2026-09-01" },
    official_sailing_id: "OR260901002"
  });
  assertTrue(a < b, "sort key order");
});

test("pre-write gate rejects substitution on failed revalidation", () => {
  const gate = evaluateExpeditionPreWriteGate({
    completePoolCount: 310,
    selection: { frozen_count: 250, frozen_unique_count: 250, exact_frozen_set_match: false },
    proposedInserts: 250,
    proposedUpdates: 0,
    revalidation: { ok: false, failed: [{ official_sailing_id: "X" }] },
    sourceHealthOk: true,
    expectedCount: 250,
    existingSelectedOfficialIds: 0
  });
  assertTrue(!gate.passed, "gate should fail when frozen set no longer eligible");
});

test("dry-run report confirms insert-only 250 when E3 report present", () => {
  const reportsDir = path.join(root, "reports");
  const reports = fs
    .readdirSync(reportsDir)
    .filter((f) => f.startsWith("silversea-expedition-e3-pre-") && f.endsWith(".json"))
    .sort();
  if (!reports.length) {
    console.log("  (skipped — run silversea:expedition-e3-preparation first)");
    return;
  }
  const report = JSON.parse(fs.readFileSync(path.join(reportsDir, reports[reports.length - 1]), "utf8"));
  assertEqual(report.dry_run?.proposed_inserts, 250, "proposed inserts");
  assertEqual(report.dry_run?.proposed_updates, 0, "proposed updates");
  assertEqual(report.dry_run?.proposed_deletes, 0, "proposed deletes");
  assertEqual(report.dry_run?.dedupe_new, 250, "dedupe new");
});

test("itinerary_ports excludes non-conventional expedition stops", () => {
  const normalised = {
    itinerary: [
      {
        kind: "port",
        expedition_semantic: EXPEDITION_SEMANTIC.LANDING_SITE,
        port_resolution: { status: "resolved", canonicalPortName: "Fake Landing" }
      },
      {
        kind: "port",
        expedition_semantic: EXPEDITION_SEMANTIC.CONVENTIONAL_PORT,
        port_resolution: { status: "resolved", canonicalPortName: "Ushuaia" }
      }
    ]
  };
  const ports = buildItineraryPorts(normalised);
  assertEqual(ports.length, 1, "only conventional port");
  assertEqual(ports[0], "Ushuaia", "conventional port name");
});

console.log(`\nE3 tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
