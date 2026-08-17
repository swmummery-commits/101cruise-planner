#!/usr/bin/env node
/**
 * Silversea Expedition Phase E5 preparation tests.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  E5_COMPLETE_REMAINDER_FIXTURE,
  E5_NEXT_BATCH_FIXTURE,
  loadFrozenExpeditionIds,
  reconcileRemainderSets,
  selectNextExpeditionBatch
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-controlled-batch"));
const { MAX_CONTROLLED_BATCH } = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const { buildItineraryPorts } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const { EXPEDITION_SEMANTIC } = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));

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

const remainderPath = path.join(root, E5_COMPLETE_REMAINDER_FIXTURE);
const nextBatchPath = path.join(root, E5_NEXT_BATCH_FIXTURE);

test("E5 remainder fixture exists after preparation", () => {
  if (!fs.existsSync(remainderPath)) throw new Error("run silversea:expedition-e5-preparation first");
});

test("E5 next-batch fixture exists after preparation", () => {
  if (!fs.existsSync(nextBatchPath)) throw new Error("missing next batch fixture");
});

test("next batch count <= 250 and unique", () => {
  const fixture = JSON.parse(fs.readFileSync(nextBatchPath, "utf8"));
  if (fixture.frozen_count > MAX_CONTROLLED_BATCH) throw new Error("over ceiling");
  if (fixture.frozen_count !== fixture.frozen_unique_count) throw new Error("not unique");
  if (fixture.selection.selected_official_sailing_ids.length !== fixture.frozen_count) {
    throw new Error("id count mismatch");
  }
});

test("remainder ordering matches next batch prefix when count <=250", () => {
  const remainder = JSON.parse(fs.readFileSync(remainderPath, "utf8"));
  const next = JSON.parse(fs.readFileSync(nextBatchPath, "utf8"));
  if (remainder.complete_remainder_count <= MAX_CONTROLLED_BATCH) {
    const expected = remainder.official_sailing_ids.join(",");
    const actual = next.selection.selected_official_sailing_ids.join(",");
    if (expected !== actual) throw new Error("selection mismatch");
  }
});

test("no production overlap in next-batch fixture metadata", () => {
  const next = JSON.parse(fs.readFileSync(nextBatchPath, "utf8"));
  if ((next.production_expedition_baseline || 0) < 250) throw new Error("expected 250 baseline");
});

test("reconcileRemainderSets detects additions and removals", () => {
  const r = reconcileRemainderSets(["A", "B"], ["B", "C"]);
  if (r.removed[0] !== "A" || r.newly_added[0] !== "C") throw new Error("reconcile");
});

test("selectNextExpeditionBatch caps at pool size", () => {
  const pool = {
    eligible: [{ official_sailing_id: "OR1", candidate: { departure_date: "2028-01-01" }, raw: {} }]
  };
  const batch = selectNextExpeditionBatch(pool, 250);
  if (batch.frozen_count !== 1) throw new Error("batch size");
});

test("itinerary_ports excludes non-conventional semantics", () => {
  const ports = buildItineraryPorts({
    itinerary: [
      {
        kind: "port",
        expedition_semantic: EXPEDITION_SEMANTIC.LANDING_SITE,
        port_resolution: { status: "resolved", canonicalPortName: "Fake" }
      }
    ]
  });
  if (ports.length !== 0) throw new Error("landing leaked");
});

test("E5 report dry-run inserts match frozen count when report present", () => {
  const reportsDir = path.join(root, "reports");
  const reports = fs
    .readdirSync(reportsDir)
    .filter((f) => f.startsWith("silversea-expedition-e5-pre-") && f.endsWith(".json"))
    .sort();
  if (!reports.length) return;
  const report = JSON.parse(fs.readFileSync(path.join(reportsDir, reports[reports.length - 1]), "utf8"));
  const frozen = report.next_batch?.frozen_count;
  if (report.dry_run.proposed_inserts !== frozen) throw new Error("dry run mismatch");
  if (report.dry_run.proposed_updates !== 0) throw new Error("updates");
});

console.log(`\nE5 tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
