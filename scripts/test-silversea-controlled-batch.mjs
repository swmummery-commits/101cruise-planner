#!/usr/bin/env node
/**
 * Silversea controlled first-batch tests (offline).
 *   npm run test:silversea-controlled-batch
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const controlled = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const writes = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const mode = require(path.join(root, "netlify/functions/lib/silversea-discovery-mode"));
const { OPERATIONAL_DESTINATION_CATALOGUE } = require(path.join(
  root,
  "netlify/functions/lib/destination-classification"
));
const { PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message || String(error) });
    console.log(`✗ ${name} — ${error.message || error}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const LINE = { id: "line-silversea", name: "Silversea Cruises", slug: "silversea-cruises" };
const SHIPS = ["Silver Dawn", "Silver Moon"].map((name, i) => ({
  id: `ship-${i}`,
  name,
  cruise_line_id: LINE.id,
  official_line_ship_id: null
}));
const DESTINATIONS = adapter.catalogueDestinations(
  OPERATIONAL_DESTINATION_CATALOGUE.map((entry) => ({
    id: `dest-${entry.slug}`,
    name: entry.name,
    slug: entry.slug,
    status: "published",
    classification_enabled: true
  }))
);

function baseRaw(overrides = {}) {
  return {
    cruise_code: "DA260907012",
    official_sailing_id: "DA260907012",
    cruise_code_valid: true,
    cruise_type: "Classic",
    collection: "cruises",
    ship_name: "Silver Dawn",
    departure_date: "2026-09-07",
    return_date: "2026-09-19",
    source_duration: 12,
    calculated_nights: 12,
    duration_matches_dates: true,
    destination_name: "BRITISH ISLES",
    departure_port: "Copenhagen",
    arrival_port: "Southampton",
    full_path: "/destinations/british-isles-cruise/copenhagen-to-southampton-da260907012.html",
    official_url: "https://www.silversea.com/destinations/british-isles-cruise/copenhagen-to-southampton-da260907012.html",
    detail_enriched: true,
    itinerary: [
      {
        day_number: 1,
        port_name: "Copenhagen",
        kind: "port",
        port_resolution: { status: "resolved", canonicalPortName: "Copenhagen" }
      },
      {
        day_number: 2,
        port_name: "Day at Sea",
        kind: "sea"
      },
      {
        day_number: 3,
        port_name: "Southampton",
        kind: "port",
        port_resolution: { status: "resolved", canonicalPortName: "Southampton" }
      }
    ],
    ...overrides
  };
}

function normalise(raw, existingRows = []) {
  const existingByOfficialId = new Map(
    existingRows.filter((r) => r.official_sailing_id).map((r) => [String(r.official_sailing_id).toUpperCase(), r])
  );
  const result = adapter.normaliseSilverseaProduct(raw, {
    cruiseLine: LINE,
    ships: SHIPS,
    destinations: DESTINATIONS
  });
  result.identity_class = adapter.classifyAgainstExisting(result, existingByOfficialId, existingRows);
  return result;
}

const today = "2026-08-15";

test("exclusive funnel reconciles fixture set", () => {
  const rows = [
    normalise(baseRaw()),
    normalise(baseRaw({ cruise_code: "MO260903015", official_sailing_id: "MO260903015", duration_matches_dates: false, source_duration: 15, calculated_nights: 16 })),
    normalise(baseRaw({ cruise_code: "E4261109015", official_sailing_id: "E4261109015", cruise_type: "Expedition" })),
    normalise(baseRaw({ cruise_code: "DA260819012", official_sailing_id: "DA260819012", departure_date: "2026-08-20", return_date: "2026-09-01", source_duration: 12, calculated_nights: 12, duration_matches_dates: true }))
  ];
  const funnel = controlled.buildExclusiveClassificationFunnel(rows, { today, existingByOfficialId: new Map() });
  assert(funnel.reconciles, `expected reconcile, got sum=${funnel.sum}`);
  assert(funnel.counts.classic_production_eligible >= 1, "expected at least one eligible classic");
  assert(funnel.counts.classic_duration_mismatch === 1, "duration mismatch bucket");
  assert(funnel.counts.expedition_deferred === 1, "expedition bucket");
  assert(funnel.counts.within_21_day_cutoff === 1, "within cutoff bucket");
});

test("duration mismatch excluded from first batch", () => {
  const row = normalise(
    baseRaw({ duration_matches_dates: false, source_duration: 15, calculated_nights: 16 })
  );
  assert(!controlled.isFirstBatchEligible(row, today, new Map()), "duration mismatch must fail");
  assert(
    controlled.classifyExclusiveBucket(row, today, new Map()) === "classic_duration_mismatch",
    "wrong bucket"
  );
});

test("sea days are not unresolved itinerary ports", () => {
  const row = normalise(baseRaw());
  assert(!controlled.hasUnresolvedActualItineraryPort(row), "sea day must not count as unresolved port");
});

test("deterministic ordering uses departure then official id", () => {
  const a = normalise(baseRaw({ cruise_code: "DA261001012", official_sailing_id: "DA261001012", departure_date: "2026-10-01", return_date: "2026-10-13", source_duration: 12, calculated_nights: 12 }));
  const b = normalise(baseRaw());
  const selected = controlled.selectFirstBatchProducts([a, b], { maxWrites: 100, today, existingByOfficialId: new Map() });
  assert(selected.selected[0].official_sailing_id === "DA260907012", "earlier departure first");
});

test("write candidate uses cruiseCode as official_sailing_id", () => {
  const row = normalise(baseRaw());
  const candidate = writes.buildSilverseaUpsertCandidate(row, LINE);
  assert(candidate?.official_sailing_id === "DA260907012", "official id");
  assert(candidate?.itinerary_ports?.includes("Copenhagen"), "itinerary ports mapped");
});

test("legacy hidden rows ignored for dedupe not update", () => {
  const existing = {
    id: "legacy-1",
    status: "hidden",
    official_sailing_id: null,
    official_url: "https://www.silversea.com/blog/foo"
  };
  const row = normalise(baseRaw(), [existing]);
  const action = writes.classifyProposedAction(row, existing, today, new Map());
  assert(action === "insert_active", "legacy row must not block insert");
});

test("production write mode blocked without env flag", () => {
  const prev = process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED;
  delete process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED;
  const gate = mode.resolveSilverseaDiscoveryMode("production_write");
  assert(!gate.writes_allowed, "writes must be blocked");
  if (prev) process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED = prev;
});

test("pre-write gate stops when fewer than 100 eligible", () => {
  const gate = controlled.evaluatePreWriteGate({
    funnel: { reconciles: true },
    selection: { sufficient_for_batch: false, eligible_count: 42 },
    proposedInserts: 42,
    proposedUpdates: 0,
    sourceHealthOk: true,
    sourceRefreshOk: true
  });
  assert(!gate.passed, "must fail when insufficient eligible");
});

test("pre-write gate stops when proposed inserts != authorised count", () => {
  const gate = controlled.evaluatePreWriteGate({
    funnel: { reconciles: true },
    selection: { sufficient_for_batch: true, frozen_selection: true, exact_frozen_set_match: true, frozen_unique_count: 75 },
    proposedInserts: 74,
    proposedUpdates: 0,
    sourceHealthOk: true,
    sourceRefreshOk: true,
    expectedCount: 75
  });
  assert(!gate.passed, "must fail when insert count != authorised");
});

test("frozen selection requires exact 75 still eligible", () => {
  const rows = [
    normalise(baseRaw()),
    normalise(baseRaw({ cruise_code: "MO260903015", official_sailing_id: "MO260903015", duration_matches_dates: false }))
  ];
  const frozen = ["DA260907012", "MO260903015"];
  const result = controlled.selectFrozenBatchProducts(rows, frozen, { today, existingByOfficialId: new Map() });
  assert(result.frozen_still_eligible === 1, "only one still eligible");
  assert(!result.exact_frozen_set_match, "must not exact match");
});

test("load frozen official IDs from report table", () => {
  const ids = controlled.loadFrozenOfficialSailingIds({
    pre_write_report: {
      pre_write_table: [{ official_sailing_id: "DA260907012" }, { official_sailing_id: "SL260918010" }]
    }
  });
  assert(ids.length === 2 && ids[0] === "DA260907012", "loaded ids");
});

test("pre-write gate requires exact 25 for phase 5 frozen batch", () => {
  const gate = controlled.evaluatePreWriteGate({
    funnel: { reconciles: true },
    selection: {
      sufficient_for_batch: true,
      frozen_selection: true,
      exact_frozen_set_match: true,
      frozen_unique_count: 25,
      frozen_still_eligible: 25
    },
    proposedInserts: 25,
    proposedUpdates: 0,
    sourceHealthOk: true,
    sourceRefreshOk: true,
    expectedCount: 25,
    existingSelectedOfficialIds: 0
  });
  assert(gate.passed, `expected pass, failures=${gate.failures?.join(",")}`);
});

test("second batch mode constant exists", () => {
  assert(controlled.SECOND_BATCH_25_MODE === "silversea_controlled_batch_25", "batch mode");
});

test("third batch 124 mode constant exists", () => {
  assert(controlled.THIRD_BATCH_124_MODE === "silversea_controlled_batch_124", "batch mode");
});

test("load frozen official IDs from phase4a fixture shape", () => {
  const fixturePath = path.join(root, "scripts/fixtures/silversea/phase4a-frozen-eligible.json");
  const report = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const ids = controlled.loadFrozenOfficialSailingIds(report);
  assert(ids.length === 124, `expected 124 ids, got ${ids.length}`);
  assert(new Set(ids).size === 124, "expected unique ids");
  assert(report.expected_count === 124, "fixture expected_count");
});

test("pre-write gate requires exact 124 for phase 6 frozen batch", () => {
  const gate = controlled.evaluatePreWriteGate({
    funnel: { reconciles: true },
    selection: {
      sufficient_for_batch: true,
      frozen_selection: true,
      exact_frozen_set_match: true,
      frozen_unique_count: 124,
      frozen_still_eligible: 124
    },
    proposedInserts: 124,
    proposedUpdates: 0,
    sourceHealthOk: true,
    sourceRefreshOk: true,
    expectedCount: 124,
    maxWrites: 124,
    existingSelectedOfficialIds: 0
  });
  assert(gate.passed, `expected pass, failures=${gate.failures?.join(",")}`);
});

console.log(`\ntest:silversea-controlled-batch: ${passed} passed${failures.length ? `, ${failures.length} failed` : ""}`);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
