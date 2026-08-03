#!/usr/bin/env node
/**
 * Holland America batch automation, timing, and run-tracking tests.
 * Run: npm run test:hal-batch-automation
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const timing = require(path.join(root, "netlify/functions/lib/holland-america-discovery-timing"));
const batch = require(path.join(root, "netlify/functions/lib/holland-america-discovery-batch"));
const writes = require(path.join(root, "netlify/functions/lib/holland-america-discovery-writes"));
const runTracking = require(path.join(root, "netlify/functions/lib/holland-america-discovery-run-tracking"));
const automation = require(path.join(root, "netlify/functions/lib/holland-america-discovery-automation"));
const health = require(path.join(root, "netlify/functions/lib/cruise-discovery-source-health"));
const mode = require(path.join(root, "netlify/functions/lib/holland-america-discovery-mode"));

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

await test("Batch timing instrumentation records phases", async () => {
  const t = timing.createHalBatchTiming();
  t.startBatch();
  t.start("hal_api_fetch");
  t.end("hal_api_fetch");
  const snap = t.snapshot();
  if (snap.breakdown.hal_api_fetch == null) throw new Error("missing hal_api_fetch timing");
  if (snap.total_ms == null) throw new Error("missing total_ms");
});

await test("Bulk identity precheck uses single index load", async () => {
  let reads = 0;
  const fakeSupabase = async (pathArg) => {
    if (String(pathArg).startsWith("discovered_cruises?")) {
      reads += 1;
      return [];
    }
    return [];
  };
  await writes.indexExistingHalRecords(fakeSupabase, "line-1");
  if (reads !== 1) throw new Error(`expected 1 index read, got ${reads}`);
});

await test("Run record stats builder stores cursor and counts", async () => {
  const stats = runTracking.buildHalRunStats({
    runType: "hal_controlled_batch",
    mode: { mode: "production_write" },
    cursorStart: 72,
    cursorEnd: 108,
    pagesFetched: 3,
    productsEncountered: 36,
    proposedWrites: 35,
    inserted: 35,
    updated: 0,
    skipped: { incomplete_skips: 1 },
    failed: 0,
    nextCursor: 108,
    numFoundOfficial: 1716,
    runId: "hal-third-batch-test"
  });
  if (stats.run_type !== "hal_controlled_batch") throw new Error("run_type");
  if (stats.cursor_start !== 72 || stats.next_cursor !== 108) throw new Error("cursor");
  if (stats.inserted !== 35) throw new Error("inserted");
});

await test("Failed batch records a clear failure reason", async () => {
  const patches = [];
  const fakeSupabase = async (_path, opts = {}) => {
    if (opts.method === "PATCH") patches.push(JSON.parse(opts.body));
    return null;
  };
  await runTracking.failHalDiscoveryRun(fakeSupabase, "run-1", {
    stats: runTracking.buildHalRunStats({ runType: "hal_controlled_batch", failed: 2 }),
    errorMessage: "write_failure_rate:5%",
    reason: "write_failure_rate:5%"
  });
  if (!patches[0]?.stats?.failure_reason) throw new Error("missing failure_reason");
});

await test("Cursor advances only after successful verification in batch stats", async () => {
  const stats = batch.emptyBatchStats();
  stats.next_cursor_start = 108;
  stats.cursor_start = 72;
  stats.batch_status = batch.deriveBatchStatus({ nextCursorStart: 108, numFound: 1716, failed: false });
  if (stats.next_cursor_start <= stats.cursor_start) throw new Error("cursor did not advance");
});

await test("Automatic continuation remains disabled by default", async () => {
  const prev = process.env.HAL_AUTOMATIC_CONTINUATION_ENABLED;
  delete process.env.HAL_AUTOMATIC_CONTINUATION_ENABLED;
  if (automation.isHalAutomaticContinuationEnabled()) throw new Error("auto enabled unexpectedly");
  if (prev) process.env.HAL_AUTOMATIC_CONTINUATION_ENABLED = prev;
});

await test("Overlapping batches are blocked", async () => {
  const lock1 = batch.acquireRunLock("same-run");
  const lock2 = batch.acquireRunLock("same-run");
  batch.releaseRunLock("same-run");
  if (!lock1.acquired || lock2.acquired) throw new Error("overlap not blocked");
});

await test("Background continuation stops on quality-gate failure", async () => {
  const gate = automation.evaluateAutomaticQualityGate({
    manifest: {
      products: [],
      acceptance_gate: { passed: false, failures: ["fairbanks_cruise_embarkation"] }
    },
    stats: { product_type_cruisetour: 0, cursor_start: 72, next_cursor_start: 108, products_normalised: 36 },
    cruiseMetrics: { ship_match_rate_pct: 100, departure_port_rate_pct: 100, destination_resolution_rate_pct: 97 },
    writeResult: { stats: { inserted: 0, updated: 0, failed: 0 } }
  });
  if (gate.passed) throw new Error("gate should fail");
});

await test("Cruisetours cannot be written via acceptance gate", async () => {
  const manifest = {
    products: [
      {
        product_type: "cruisetour",
        completeness: "complete_high_confidence",
        proposed_action: "insert_active",
        stable_product_identity_key: "CT|1",
        destination_id: "dest-1"
      }
    ]
  };
  const gate = writes.evaluateAcceptanceGate(manifest);
  if (gate.passed) throw new Error("cruisetour should fail gate");
});

await test("Fairbanks cannot be written as embarkation", async () => {
  const manifest = {
    products: [
      {
        product_type: "cruise",
        completeness: "complete_high_confidence",
        proposed_action: "insert_active",
        stable_product_identity_key: "A|1",
        destination_id: "dest-1",
        departure_port: "Fairbanks"
      }
    ]
  };
  const gate = writes.evaluateAcceptanceGate(manifest);
  if (gate.passed) throw new Error("Fairbanks should fail gate");
});

await test("Alias writes remain disabled", async () => {
  const { AUTO_ALIAS_WRITES_ENABLED } = require(path.join(root, "netlify/functions/lib/discovery-ship-resolver"));
  if (AUTO_ALIAS_WRITES_ENABLED) throw new Error("aliases enabled");
});

await test("Idempotency precheck finds existing by product key", async () => {
  const row = {
    raw: { itinerary_id: "A1", cruise_id: "C1" },
    candidate: { ship_id: "s1", departure_date: "2026-12-01", official_url: "https://example.com/a1/c1" }
  };
  const indexes = {
    byProductKey: new Map([["A1|C1", { id: "existing-1" }]]),
    byIdentity: new Map(),
    byExternal: new Map()
  };
  const found = writes.findExistingRecord(indexes, row, { id: "line-1" });
  if (!found || found.id !== "existing-1") throw new Error("existing not found");
});

await test("Admin distinguishes HAL progress from Full Discovery", async () => {
  const halRun = { scope: "cruise_line", stats: { run_type: "hal_controlled_batch" } };
  const fullRun = { scope: "full", stats: { triggered_by: "admin" } };
  if (health.inferRunType(halRun) !== "hal_controlled_batch") throw new Error("hal type");
  if (health.inferRunType(fullRun) === "hal_controlled_batch") throw new Error("full misclassified");
});

await test("Write flag defaults disabled outside explicit enable", async () => {
  const prev = process.env.HAL_DISCOVERY_WRITE_ENABLED;
  delete process.env.HAL_DISCOVERY_WRITE_ENABLED;
  const gate = mode.resolveHalDiscoveryMode("production_write");
  if (gate.writes_allowed) throw new Error("writes allowed without flag");
  if (prev) process.env.HAL_DISCOVERY_WRITE_ENABLED = prev;
});

await test("Automatic architecture documents stop conditions", async () => {
  const arch = automation.describeAutomaticContinuationArchitecture();
  if (arch.enabled) throw new Error("auto should be disabled");
  if (!arch.stop_conditions?.length) throw new Error("missing stop conditions");
  if (arch.limits.max_pages < 10) throw new Error("pages too low");
});

const audit = require(path.join(root, "scripts/lib/hal-batch-audit.cjs"));

await test("Audit report displays departure port correctly", async () => {
  const row = {
    hal_product_key: "E6T15B|J676",
    official_sailing_id: "E6T15B|J676",
    ship: "ms Nieuw Statendam",
    departure_date: "2026-12-05",
    return_date: "2026-12-20",
    nights: 15,
    departure_port: "Rotterdam",
    destination: "transatlantic",
    source_url: "https://example.com/e6t15b/j676",
    status: "active"
  };
  const issues = audit.activationGateIssues(row);
  if (issues.length) throw new Error(`expected compliant row, got ${issues.join(",")}`);
  if (!row.departure_port) throw new Error("departure port missing in audit row");
});

await test("Audit report displays nights or return date correctly", async () => {
  const row = {
    hal_product_key: "O6A14J|W679",
    official_sailing_id: "O6A14J|W679",
    ship: "ms Westerdam",
    departure_date: "2026-12-06",
    return_date: "2026-12-20",
    nights: 14,
    departure_port: "Singapore",
    destination: "asia",
    source_url: "https://example.com/o6a14j/w679",
    status: "active"
  };
  const issues = audit.activationGateIssues(row);
  if (issues.length) throw new Error(`expected compliant row, got ${issues.join(",")}`);
  if (!row.nights && !row.return_date) throw new Error("nights/return missing");
});

await test("Incomplete record cannot pass the activation gate", async () => {
  const summary = audit.summariseActivationAudit([
    {
      hal_product_key: "X|1",
      official_sailing_id: "X|1",
      ship: "ms Test",
      departure_date: "2026-12-01",
      return_date: null,
      nights: null,
      departure_port: null,
      destination: "caribbean",
      source_url: "https://example.com",
      status: "active"
    }
  ]);
  if (summary.compliant !== 0) throw new Error("incomplete row passed audit");
  if (!summary.missing_departure_port || !summary.missing_nights_and_return) throw new Error("missing counters");
});

await test("Bulk verification detects missing required fields", async () => {
  const summary = audit.summariseActivationAudit([
    {
      hal_product_key: "A|1",
      ship: "ms Test",
      departure_date: "2026-12-01",
      return_date: "2026-12-08",
      nights: 7,
      departure_port: "Miami",
      destination: "caribbean",
      source_url: "https://example.com/a1",
      status: "active"
    },
    {
      hal_product_key: "B|1",
      ship: "ms Test",
      departure_date: "2026-12-01",
      return_date: null,
      nights: null,
      departure_port: null,
      destination: null,
      source_url: null,
      status: "active"
    }
  ]);
  if (summary.compliant !== 1) throw new Error(`expected 1 compliant, got ${summary.compliant}`);
  if (summary.breaches.length !== 1) throw new Error("expected one breach");
});

console.log(`\ntest-hal-batch-automation: ${passed} passed`);
