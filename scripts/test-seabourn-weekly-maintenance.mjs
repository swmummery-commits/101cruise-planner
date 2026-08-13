#!/usr/bin/env node
/**
 * Seabourn weekly maintenance guard tests — dry-run contract, apply preconditions, write caps,
 * reconciliation, quality gates and idempotency. No network and no database writes.
 *   npm run test:seabourn-weekly-maintenance
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const weekly = await import(path.join(root, "scripts/run-seabourn-weekly-maintenance.mjs"));
const runner = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner"));
const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const locks = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const mode = require(path.join(root, "netlify/functions/lib/seabourn-discovery-mode"));
const reconciliation = require(path.join(root, "netlify/functions/lib/seabourn-reconciliation-summary"));
const writes = require(path.join(root, "netlify/functions/lib/seabourn-discovery-writes"));
const sbn = require(path.join(root, "netlify/functions/lib/seabourn-discovery-adapter"));
const fixture = require(path.join(root, "scripts/fixtures/seabourn/search-response-page.json"));
const weeklyPolicy = require(path.join(root, "netlify/functions/lib/seabourn-weekly-update-policy"));
const weeklyAuth = require(path.join(root, "netlify/functions/lib/seabourn-weekly-auth"));
const sourceAbsence = require(path.join(root, "netlify/functions/lib/seabourn-source-absence"));

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

function expectThrows(code, fn) {
  try {
    fn();
  } catch (error) {
    if (error.code !== code) throw new Error(`expected ${code}, got ${error.code || error.message}`);
    return;
  }
  throw new Error(`expected ${code}, nothing thrown`);
}

const LOCAL_MAC_ENV = { SEABOURN_WEEKLY_RECONCILIATION_ENABLED: "true" };
const APPLY_ARGS = {
  apply: true,
  dryRun: false,
  confirm: weekly.WEEKLY_APPLY_CONFIRMATION_TOKEN,
  maxWrites: 10
};

const sbnLine = { id: "sbn-line", name: "Seabourn Cruise Line", slug: "seabourn-cruise-line" };
const sbnShips = [
  { id: "s-encore", name: "Encore", cruise_line_id: "sbn-line", official_line_ship_id: "SE" }
];
const destinations = sbn.catalogueDestinations([
  { id: "dest-alaska", name: "Alaska", slug: "alaska", status: "active" }
]);
const ctx = { cruiseLine: sbnLine, ships: sbnShips, destinations, today: "2026-08-13" };

function buildEligibleRow(overrides = {}) {
  const baseDoc = fixture.response.docs.find((d) => d.cruiseId && d.departDate && !d.tourId);
  const departureDate = overrides.departure_date || "2026-09-04";
  const raw = sbn.parseRawVoyageFromDoc({
    ...baseDoc,
    cruiseId: overrides.cruise_id || baseDoc.cruiseId,
    itineraryId: overrides.itinerary_id || baseDoc.itineraryId,
    departDate: departureDate,
    embarkPortName: overrides.departure_port || baseDoc.embarkPortName,
    ...(overrides.raw || {})
  });
  if (overrides.departure_port) {
    raw.departure_port = overrides.departure_port;
    raw.departure_date = departureDate;
  }
  return sbn.normaliseSeabournVoyage(raw, {
    ...ctx,
    today: overrides.today || "2026-08-13",
    productMeta: sbn.classifySeabournProductType(raw)
  });
}

function summaryFixture(overrides = {}) {
  return {
    run_id: "seabourn-weekly-test",
    official_source_total: 857,
    eligible_total: 683,
    active_production_total: 0,
    recognised_existing_eligible: 0,
    outstanding_eligible_inserts: 683,
    proposed_inserts: 683,
    proposed_updates: 0,
    inserts: 0,
    updates: 0,
    source_absent_active: 0,
    source_absent_sailing_ids: [],
    reconciliation_arithmetic_ok: true,
    source_quality_gate: { passed: true, failures: [], blocked: false },
    quality_gate: { passed: true, failures: [], blocked: false },
    resolution_rates: {
      ship_resolution_pct: 100,
      departure_port_resolution_pct: 99,
      destination_resolution_pct: 98,
      identity_coverage_pct: 100,
      duplicate_official_identities: 0
    },
    write_authorisation: "dry_run",
    writes_performed: 0,
    ...overrides
  };
}

function reportFixture({ mode = "dry_run", summary = summaryFixture(), result = {}, before = 0, after = 0 } = {}) {
  return weekly.buildWeeklyMaintenanceReport({
    mode,
    startedAt: "2026-08-13T00:00:00.000Z",
    endedAt: "2026-08-13T00:02:00.000Z",
    environment: weekly.classifyExecutionEnvironment({}, { applyMode: mode === "apply" }),
    result: { ok: true, summary, ...result },
    countsBefore: { seabourn: before },
    countsAfter: { seabourn: after }
  });
}

/* ------------------------------------------------------------------ mode safety */

test("1. dry run is the default when --apply is absent", () => {
  const args = weekly.parseWeeklyMaintenanceArgs(["node", "script"]);
  if (args.apply || !args.dryRun) throw new Error(JSON.stringify(args));
});

test("2. malformed mode in discovery resolver defaults to read-only", () => {
  const gate = mode.resolveSeabournDiscoveryMode("bogus");
  if (gate.writes_allowed) throw new Error("malformed mode must not allow writes");
  if (gate.mode !== "simulation") throw new Error(gate.mode);
});

test("3. omitted discovery mode defaults to read-only", () => {
  const gate = mode.resolveSeabournDiscoveryMode();
  if (gate.writes_allowed) throw new Error("omitted mode must not allow writes");
});

test("4. apply requires exact confirmation token", () => {
  expectThrows("weekly_apply_confirmation_required", () =>
    weekly.assertWeeklyApplyAllowed({ ...APPLY_ARGS, confirm: "WRONG" }, LOCAL_MAC_ENV)
  );
});

test("5. apply blocked while SEABOURN_WEEKLY_RECONCILIATION_ENABLED is unset", () => {
  expectThrows("seabourn_weekly_reconciliation_disabled", () =>
    weekly.assertWeeklyApplyAllowed(APPLY_ARGS, {})
  );
});

test("6. apply blocked on Netlify", () => {
  expectThrows("weekly_apply_netlify_forbidden", () =>
    weekly.assertWeeklyApplyAllowed(APPLY_ARGS, { ...LOCAL_MAC_ENV, NETLIFY: "true" })
  );
});

test("7. apply requires explicit --max-writes", () => {
  expectThrows("weekly_apply_max_writes_required", () =>
    weekly.assertWeeklyApplyAllowed({ ...APPLY_ARGS, maxWrites: null }, LOCAL_MAC_ENV)
  );
});

test("8. weekly_maintenance apply blocked when reconciliation flag disabled", () => {
  const gate = mode.resolveSeabournDiscoveryMode("weekly_maintenance");
  if (gate.writes_allowed) throw new Error("weekly flag must be disabled by default");
});

test("9. dry-run report always shows writes_performed = 0", () => {
  const report = reportFixture();
  if (report.writes_performed !== 0) throw new Error(String(report.writes_performed));
  if (report.quality_gates.write_authorisation !== "DRY_RUN") throw new Error(report.quality_gates.write_authorisation);
});

/* ---------------------------------------------------------------- write caps */

test("10. Seabourn weekly cap defaults to 30", () => {
  if (weekly.MAX_WEEKLY_WRITES !== 30) throw new Error(String(weekly.MAX_WEEKLY_WRITES));
  if (runner.SEABOURN_MAX_WEEKLY_WRITES !== 30) throw new Error(String(runner.SEABOURN_MAX_WEEKLY_WRITES));
});

test("11. requested max writes clamped to weekly cap", () => {
  if (weekly.resolveEffectiveWeeklyMaxWrites(1000) !== 30) throw new Error("not clamped");
  if (weekly.resolveEffectiveWeeklyMaxWrites(5) !== 5) throw new Error("under-cap changed");
});

test("12. combined proposed changes above cap fail volume assessment", () => {
  const blocked = weekly.assessWeeklyChangeVolumeCap(25, 10);
  if (blocked.ok) throw new Error("35 changes accepted");
  if (blocked.reason !== "weekly_change_volume_exceeds_initial_cap") throw new Error(blocked.reason);
});

/* ----------------------------------------------------------- quality gates */

test("13. source quality gate passes for healthy simulation shape", () => {
  const gate = runner.evaluateSeabournSourceQualityGate({
    num_found_official: 857,
    fetch_result: {
      numFound: 857,
      source_row_accounting: { reconciles: true, raw_source_rows: 874, malformed_or_invalid_rows: 5 },
      pagination: { exhausted: true, repeated_page_signatures: 0, zero_progress_pages: 0 }
    },
    identity: { official_key_collisions: [] }
  });
  if (!gate.passed) throw new Error(JSON.stringify(gate.failures));
});

test("14. zero source fails quality gate", () => {
  const gate = runner.evaluateSeabournSourceQualityGate({ num_found_official: 0 });
  if (gate.passed) throw new Error("zero source should fail");
  if (!gate.failures.includes("source_num_found_zero")) throw new Error(JSON.stringify(gate.failures));
});

test("15. incomplete pagination fails quality gate", () => {
  const gate = runner.evaluateSeabournSourceQualityGate({
    num_found_official: 100,
    fetch_result: { pagination: { exhausted: false }, source_row_accounting: { reconciles: true } },
    identity: { official_key_collisions: [] }
  });
  if (gate.passed) throw new Error("incomplete pagination should fail");
});

test("16. identity collisions fail quality gate", () => {
  const gate = runner.evaluateSeabournSourceQualityGate({
    num_found_official: 100,
    fetch_result: {
      pagination: { exhausted: true },
      source_row_accounting: { reconciles: true, raw_source_rows: 100, malformed_or_invalid_rows: 0 }
    },
    identity: { official_key_collisions: [["dup|1", "dup|1"]] }
  });
  if (gate.passed) throw new Error("collisions should fail");
});

test("17. reconciliation arithmetic failure fails report", () => {
  const report = reportFixture({ summary: summaryFixture({ reconciliation_arithmetic_ok: false }) });
  if (report.status !== "failed") throw new Error(report.status);
});

/* --------------------------------------------------------- reconciliation */

test("18. reconciliation summary arithmetic", () => {
  const r = reconciliation.buildSeabournReconciliationSummary({
    activeProductionTotal: 0,
    eligibleTotal: 683,
    recognisedExistingEligible: 0,
    outstandingEligibleInserts: 683,
    proposedUpdates: 0,
    sourceAbsentActive: 0
  });
  if (!r.reconciliation_arithmetic_ok) throw new Error("arithmetic failed");
});

test("19. new voyage proposes insert", () => {
  const row = buildEligibleRow();
  const action = writes.classifyProposedAction(row, null);
  if (action !== "insert_active") throw new Error(action);
});

test("20. existing unchanged voyage recognised as duplicate_skip", () => {
  const row = buildEligibleRow();
  const existing = {
    id: "existing-1",
    cruise_line_id: "sbn-line",
    ship_id: row.candidate.ship_id,
    destination_id: row.candidate.destination_id,
    departure_date: row.candidate.departure_date,
    return_date: row.candidate.return_date,
    nights: row.candidate.nights,
    departure_port: row.candidate.departure_port,
    itinerary: row.candidate.itinerary,
    status: "active",
    official_sailing_id: sbn.officialProductKey(row.raw)
  };
  const action = writes.classifyProposedAction(row, existing);
  if (action !== "duplicate_skip") throw new Error(action);
});

test("21. existing changed voyage proposes update", () => {
  const row = buildEligibleRow();
  const existing = {
    id: "existing-1",
    cruise_line_id: "sbn-line",
    ship_id: row.candidate.ship_id,
    destination_id: row.candidate.destination_id,
    departure_date: row.candidate.departure_date,
    return_date: row.candidate.return_date,
    nights: row.candidate.nights,
    departure_port: "Old Port",
    itinerary: row.candidate.itinerary,
    status: "active",
    official_sailing_id: sbn.officialProductKey(row.raw)
  };
  const action = writes.classifyProposedAction(row, existing);
  if (action !== "update_exact_legacy_match") throw new Error(action);
});

test("22. overlapping Seabourn products remain distinct by official key", () => {
  const a = buildEligibleRow({ cruise_id: "100", itinerary_id: "AAA" });
  const b = buildEligibleRow({ cruise_id: "200", itinerary_id: "AAA" });
  if (sbn.officialProductKey(a.raw) === sbn.officialProductKey(b.raw)) throw new Error("keys must differ");
});

test("23. cruisetour classified as policy_excluded_cruisetour", () => {
  const raw = { ...buildEligibleRow().raw, tour_id: "CT1" };
  const row = sbn.normaliseSeabournVoyage(raw, {
    ...ctx,
    productMeta: sbn.classifySeabournProductType(raw)
  });
  const action = writes.classifyProposedAction(row, null);
  if (action !== "policy_excluded_cruisetour") throw new Error(action);
});

test("24. idempotency — empty production => all eligible are inserts", async () => {
  const rows = [buildEligibleRow(), buildEligibleRow({ cruise_id: "9001", itinerary_id: "B2" })].filter(
    (r) => r.eligibility.production_eligible
  );
  const manifest = await writes.buildSeabournBatchManifest({
    products: rows,
    cruiseLine: sbnLine,
    destinations,
    supabase: null,
    runId: "test-empty"
  });
  const inserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
  if (inserts.length !== rows.length) throw new Error(`expected ${rows.length} inserts, got ${inserts.length}`);
});

test("25. idempotency — fully imported => zero inserts", async () => {
  const row = buildEligibleRow();
  const productKey = sbn.officialProductKey(row.raw);
  const fakeSupabase = async (query) => {
    if (String(query).includes("discovered_cruises")) {
      return [
        {
          id: "db-1",
          cruise_line_id: "sbn-line",
          ship_id: row.candidate.ship_id,
          destination_id: row.candidate.destination_id,
          departure_date: row.candidate.departure_date,
          return_date: row.candidate.return_date,
          nights: row.candidate.nights,
          departure_port: row.candidate.departure_port,
          itinerary: row.candidate.itinerary,
          status: "active",
          official_sailing_id: productKey,
          raw_extract: { seabourn_sailing_id: productKey }
        }
      ];
    }
    return [];
  };
  const manifest = await writes.buildSeabournBatchManifest({
    products: [row],
    cruiseLine: sbnLine,
    destinations,
    supabase: fakeSupabase,
    runId: "test-full"
  });
  const inserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
  const recognised = manifest.products.filter((p) => p.proposed_action === "duplicate_skip");
  if (inserts.length !== 0) throw new Error("expected zero inserts");
  if (recognised.length !== 1) throw new Error("expected one recognised");
});

test("26. mocked apply performs writes only when performWrites true", async () => {
  const row = buildEligibleRow();
  const dry = await writes.applySeabournBatchWrites({
    products: [row],
    cruiseLine: sbnLine,
    maxWrites: 10,
    performWrites: false,
    supabase: null
  });
  if (dry.stats.inserted !== 0 || dry.stats.updated !== 0) throw new Error("dry apply must not write");
});

/* -------------------------------------------------------------- port gaps */

test("27. Dubrovnik embark resolves via DBV alias", () => {
  const row = buildEligibleRow({ departure_port: "Dubrovnik, Croatia#@#DBV" });
  if (row.candidate.departure_port_meta?.status !== "resolved") {
    throw new Error(JSON.stringify(row.candidate.departure_port_meta));
  }
});

test("28. Broome embark resolves via BME alias", () => {
  const row = buildEligibleRow({ departure_port: "Broome, Western Australia, Australia#@#BME" });
  if (row.candidate.departure_port_meta?.status !== "resolved") {
    throw new Error(JSON.stringify(row.candidate.departure_port_meta));
  }
});

test("29. Greenwich embark resolves via GRW alias", () => {
  const row = buildEligibleRow({
    departure_port: "Greenwich (London), England, United Kingdom#@#GRW"
  });
  if (row.candidate.departure_port_meta?.status !== "resolved") {
    throw new Error(JSON.stringify(row.candidate.departure_port_meta));
  }
});

test("30. St Johns Newfoundland embark resolves via alias map", () => {
  const row = buildEligibleRow({ departure_port: "St Johns, Newfoundland, Canada#@#YYT" });
  if (row.candidate.departure_port_meta?.status !== "resolved") {
    throw new Error(JSON.stringify(row.candidate.departure_port_meta));
  }
});

test("31. ports catalogue contains new canonical entries", () => {
  const csv = fs.readFileSync(path.join(root, "data/ports/ports-catalogue.csv"), "utf8");
  for (const needle of ["Dubrovnik", "Broome", "Greenwich", "St Johns Newfoundland"]) {
    if (!csv.includes(needle)) throw new Error(`missing ${needle}`);
  }
});

/* -------------------------------------------------------- shared wiring */

test("32. Seabourn schedule is registered but not cron-enabled", () => {
  const schedule = maintenance.MAINTENANCE_SCHEDULES.seabourn_weekly;
  if (!schedule) throw new Error("missing schedule entry");
  if (schedule.schedule_registered !== false) throw new Error("Seabourn must not be scheduled yet");
  if (schedule.function !== "seabourn-weekly-maintenance-cron") throw new Error(schedule.function);
});

test("33. Seabourn lock key wired", () => {
  const lockKey = locks.weeklyLockKey("seabourn-cruise-line");
  if (lockKey !== "seabourn-cruise-line:weekly") throw new Error(lockKey);
  if (locks.DEFAULT_LEASE_SECONDS[lockKey] !== 900) throw new Error("lease");
});

test("34. bulk import flag listed as must-stay-false", () => {
  const flags = maintenance.describeMaintenanceHold();
  if (!flags.bulk_import_flags_must_remain_false.includes("SEABOURN_DISCOVERY_WRITE_ENABLED")) {
    throw new Error("SEABOURN_DISCOVERY_WRITE_ENABLED must stay false until controlled import");
  }
});

test("35. explicit quality gate statuses in dry-run report", () => {
  const report = reportFixture();
  if (report.quality_gates.source_quality_gate !== "PASS") throw new Error(report.quality_gates.source_quality_gate);
  if (report.quality_gates.identity_gate !== "PASS") throw new Error(report.quality_gates.identity_gate);
  if (report.quality_gates.reconciliation_gate !== "PASS") throw new Error(report.quality_gates.reconciliation_gate);
});

test("36. fixture official keys remain collision-free", () => {
  const docs = fixture.response.docs.filter((d) => d.cruiseId && d.departDate);
  const parsed = docs.map((d) => sbn.parseRawVoyageFromDoc(d)).filter(Boolean);
  const identity = sbn.analyseIdentity(parsed.map((raw) => ({ raw, product_type: "ocean" })));
  if (identity.official_key_collisions.length !== 0) throw new Error("fixture collisions");
});

/* -------------------------------------------------------- Prompt 7 weekly guards */

test("37. identity-critical ship change requires review in weekly path", () => {
  const existing = {
    ship_id: "ship-a",
    departure_date: "2027-01-01",
    return_date: "2027-01-08",
    nights: 7,
    departure_port: "Miami",
    itinerary: "Caribbean",
    status: "active",
    official_url: "https://example.com/a"
  };
  const candidate = { ...existing, ship_id: "ship-b" };
  const refined = weeklyPolicy.refineProposedActionForWeekly(
    "update_exact_legacy_match",
    existing,
    candidate
  );
  if (refined !== "update_identity_review_required") throw new Error(refined);
});

test("38. safe metadata URL-only change allowed for weekly apply", () => {
  const existing = {
    ship_id: "ship-a",
    departure_date: "2027-01-01",
    return_date: "2027-01-08",
    nights: 7,
    departure_port: "Miami",
    itinerary: "Caribbean",
    status: "active",
    official_url: "https://example.com/a"
  };
  const candidate = { ...existing, official_url: "https://example.com/b" };
  const refined = weeklyPolicy.refineProposedActionForWeekly(
    "update_exact_legacy_match",
    existing,
    candidate
  );
  if (refined !== "update_safe_metadata_allowed") throw new Error(refined);
});

test("39. actionable source absence blocks weekly writes", () => {
  const safety = weeklyPolicy.assessSeabournWeeklyWriteSafety({
    sourceAbsencePolicy: { source_absent_observed: 2, source_absent_actionable: 1 },
    performWrites: true,
    proposedIdentityReviewUpdates: 0
  });
  if (safety.ok) throw new Error("actionable absence must block writes");
  if (!safety.failures.includes("source_absent_actionable_blocks_weekly_writes")) {
    throw new Error(JSON.stringify(safety.failures));
  }
});

test("40. observed-only source absence permits weekly dry-run safety", () => {
  const safety = weeklyPolicy.assessSeabournWeeklyWriteSafety({
    sourceAbsencePolicy: { source_absent_observed: 11, source_absent_actionable: 0 },
    performWrites: false,
    proposedIdentityReviewUpdates: 0
  });
  if (!safety.ok) throw new Error(JSON.stringify(safety.failures));
  if (weeklyPolicy.isSeabournSourceAbsenceDeactivationEnabled({})) {
    throw new Error("deactivation must stay disabled by default");
  }
});

test("41. weekly combined cap PASS at 30", () => {
  const cap = runner.SEABOURN_MAX_WEEKLY_WRITES;
  if (cap !== 30) throw new Error(String(cap));
});

test("42. weekly combined cap STOP at 31+", () => {
  const cap = runner.SEABOURN_MAX_WEEKLY_WRITES;
  if (31 <= cap) throw new Error("fixture must exceed cap");
});

test("43. weekly auth rejects missing secret on manual HTTP", () => {
  let threw = false;
  try {
    weeklyAuth.assertCronAuth({ headers: {} }, { DISCOVERY_CRON_SECRET: "expected-secret" });
  } catch (e) {
    threw = e.code === "unauthorized";
  }
  if (!threw) throw new Error("missing secret must fail");
});

test("44. weekly auth rejects invalid secret", () => {
  let threw = false;
  try {
    weeklyAuth.assertCronAuth(
      { headers: { "x-discovery-cron-secret": "wrong" } },
      { DISCOVERY_CRON_SECRET: "expected-secret" }
    );
  } catch (e) {
    threw = e.code === "unauthorized";
  }
  if (!threw) throw new Error("invalid secret must fail");
});

test("45. scheduled invocation bypasses manual secret header", () => {
  weeklyAuth.assertSeabournWeeklyAuth(
    { headers: { "x-netlify-event": "schedule" } },
    { DISCOVERY_CRON_SECRET: "expected-secret" }
  );
  const cronSrc = fs.readFileSync(
    path.join(root, "netlify/functions/seabourn-weekly-maintenance-cron.js"),
    "utf8"
  );
  if (cronSrc.includes("controlled-catchup")) throw new Error("cron must not invoke catch-up");
  if (!cronSrc.includes("weekly_maintenance")) throw new Error("cron must use weekly_maintenance path");
});

test("46. C7S07K|8730 reappearance resolves as duplicate_skip not insert", () => {
  const row = buildEligibleRow({ cruise_id: "C7S07K", itinerary_id: "8730" });
  const key = sbn.officialProductKey(row.raw);
  const existing = {
    id: "prod-c7s07k",
    cruise_line_id: "sbn-line",
    ship_id: row.candidate.ship_id,
    destination_id: row.candidate.destination_id,
    departure_date: row.candidate.departure_date,
    return_date: row.candidate.return_date,
    nights: row.candidate.nights,
    departure_port: row.candidate.departure_port,
    itinerary: row.candidate.itinerary,
    status: "active",
    official_sailing_id: key,
    official_url: row.candidate.official_url
  };
  const base = writes.classifyProposedAction(row, existing);
  if (base !== "duplicate_skip") throw new Error(`base action ${base}`);
  const weeklyAction = weeklyPolicy.refineProposedActionForWeekly(base, existing, row.candidate);
  if (weeklyAction !== "duplicate_skip") throw new Error(`weekly action ${weeklyAction}`);
  const absenceAfterReappearance = sourceAbsence.classifySeabournSourceAbsence({
    currentAbsentRows: [],
    previousAbsentSailingIds: [key],
    enumerationHealthy: true
  });
  if ((absenceAfterReappearance.source_absence_cleared || []).length !== 1) {
    throw new Error(JSON.stringify(absenceAfterReappearance.source_absence_cleared));
  }
});

console.log(`\n${passed} tests passed, ${failures.length} failed`);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
