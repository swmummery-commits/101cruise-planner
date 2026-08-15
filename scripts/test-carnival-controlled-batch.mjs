#!/usr/bin/env node
/**
 * Carnival controlled-batch production integration tests.
 * Run: node scripts/test-carnival-controlled-batch.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const adapter = require(path.join(root, "netlify/functions/lib/carnival-discovery-adapter"));
const writes = require(path.join(root, "netlify/functions/lib/carnival-discovery-writes"));
const batch = require(path.join(root, "netlify/functions/lib/carnival-controlled-batch"));
const mode = require(path.join(root, "netlify/functions/lib/carnival-discovery-mode"));
const trust = require(path.join(root, "netlify/functions/lib/carnival-structured-source-trust"));
const { PUBLIC_BOOKING_CUTOFF_DAYS, daysUntilDeparture } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const runScript = require(path.join(root, "scripts/run-carnival-first-controlled-batch.mjs"));

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

const line = { id: "ccl-line", name: "Carnival Cruise Line", slug: "carnival-cruise-line" };
const ship = { id: "ship-1", name: "Conquest", cruise_line_id: "ccl-line", official_line_ship_id: "CQ" };
const destinations = adapter.catalogueDestinations([
  { id: "dest-carib", slug: "caribbean", name: "Caribbean", status: "published", classification_enabled: true }
]);

const raw = {
  sailing_id: "999001",
  itinerary_code: "ABC",
  ship_code: "CQ",
  ship_name: "Carnival Conquest",
  departure_date: "2026-12-01",
  arrival_date: "2026-12-08",
  nights: 7,
  departure_port_name: "Miami, FL",
  region_code: "BH",
  region_name: "Caribbean",
  official_url: "https://www.carnival.com.au/cruise/abc"
};

const ctx = {
  cruiseLine: line,
  ships: [ship],
  shipAliases: [{ ship_id: "ship-1", raw_alias: "Carnival Conquest", normalised_alias: "carnival conquest" }],
  destinations,
  today: "2026-08-15"
};

const normalised = adapter.normaliseCclSailing(raw, ctx);
const eligibility = adapter.evaluateSailingEligibility(normalised, ctx.today);
normalised.eligibility = eligibility;

assert(normalised.official_sailing_id === "999001", "official sailing id mapped from sailing_id");
assert(eligibility.discovery_ready === true, "fixture is discovery ready");

const candidate = writes.buildCclUpsertCandidate(normalised, line);
assert(candidate.official_sailing_id === "999001", "upsert candidate carries official sailing id");
assert(candidate.raw_extract.structured_source === "ccl_cruisesearch_api", "structured source persisted");
assert(candidate.raw_extract.ccl_itinerary_code === "ABC", "itinerary code persisted");
assert(candidate.identity_key, "identity key generated");

assert(
  writes.classifyProposedAction(normalised, null, null) === "insert_active",
  "new official sailing proposes insert"
);
assert(
  writes.classifyProposedAction(normalised, { id: "existing", cruise_line_id: line.id, official_sailing_id: "999001", ship_id: ship.id, destination_id: "dest-carib", departure_date: "2026-12-01", return_date: "2026-12-08", nights: 7, departure_port: normalised.candidate.departure_port, itinerary: normalised.candidate.itinerary }, null) ===
    "duplicate_skip",
  "existing official match duplicates"
);
assert(
  writes.classifyProposedAction(normalised, null, { id: "legacy-1", ship_id: ship.id, departure_date: "2026-12-01" }) ===
    "legacy_collision_review",
  "legacy ship/date collision flagged"
);

const cutoffRow = adapter.normaliseCclSailing(
  { ...raw, sailing_id: "999002", departure_date: "2026-09-05", arrival_date: "2026-09-12" },
  ctx
);
cutoffRow.eligibility = adapter.evaluateSailingEligibility(cutoffRow, ctx.today);
assert(cutoffRow.eligibility.discovery_ready === false, "21-day cutoff excluded from discovery ready");
assert(
  !batch.isControlledBatchEligible(cutoffRow, ctx.today),
  "21-day candidate blocked from controlled batch"
);

const eligibleRow = { ...normalised, days_until_departure: daysUntilDeparture("2026-12-01", ctx.today) };
assert(batch.isControlledBatchEligible(eligibleRow, ctx.today), "22+ day trusted candidate eligible");

const selected = batch.selectControlledBatchProducts([eligibleRow, cutoffRow], {
  maxWrites: 20,
  today: ctx.today
});
assert(selected.selected.length === 1, "deterministic selection picks eligible only");
assert(selected.selected[0].official_sailing_id === "999001", "sort order preserves eligible sailing");

const manifestEntry = writes.buildManifestEntry(normalised, line, null, null, 1);
const frozen = batch.buildFrozenManifest({
  selected: [normalised],
  cruiseLine: line,
  entries: [manifestEntry],
  runId: "test",
  codeSha: "abc",
  today: ctx.today
});
const validation = batch.validateFrozenManifest(frozen, { expectedCount: 1 });
assert(validation.ok === false, "first batch manifest requires exactly 20 unless overridden in test");

const plan = writes.evaluatePreflightWritePlan([manifestEntry], { maxWrites: 20 });
assert(plan.inserts === 1, "preflight counts one insert");

const prevFlag = process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED;
process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED = "false";
assert(mode.resolveCarnivalDiscoveryMode("controlled_batch").writes_allowed === false, "write flag required");
process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED = "true";
assert(mode.resolveCarnivalDiscoveryMode("controlled_batch").writes_allowed === true, "write flag enables controlled batch");
process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED = prevFlag;

assert(
  trust.evaluateCarnivalStructuredSourceTrust({ structured_source: "ccl_cruisesearch_api_v2" }).trusted === false,
  "near-match source remains untrusted in batch tests"
);

assert(batch.MAX_CONTROLLED_CCL_BATCH === 20, "batch cap is 20");
assert(batch.APPLY_CONFIRMATION === "CARNIVAL-FIRST-CONTROLLED-BATCH", "confirmation token exported");

const gate = batch.evaluatePreApplyQualityGate({
  quality_gate_metrics: {
    ship_resolution_pct: 100,
    departure_port_resolution_pct: 100,
    destination_resolution_pct: 100,
    identity_coverage_pct: 100,
    duplicate_official_identities: 0
  }
});
assert(gate.ok === true, "quality gate helper passes at 100%");

const badGate = batch.evaluatePreApplyQualityGate({
  quality_gate_metrics: { ship_resolution_pct: 50, departure_port_resolution_pct: 100, destination_resolution_pct: 100, identity_coverage_pct: 100, duplicate_official_identities: 0 }
});
assert(badGate.ok === false, "quality gate helper fails when ship gate fails");

console.log(`carnival-controlled-batch tests passed: ${passed}`);
