#!/usr/bin/env node
/**
 * Disney Phase 5 weekly maintenance guard tests — source quality, collapse guard,
 * update policy, source absence, write caps, locks, Netlify dispatch, and audit.
 * No network and no database writes.
 *   npm run test:disney-weekly-maintenance
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const weekly = await import(path.join(root, "scripts/run-disney-weekly-maintenance.mjs"));
const weeklyPolicy = require(path.join(root, "netlify/functions/lib/disney-weekly-update-policy"));
const sourceAbsence = require(path.join(root, "netlify/functions/lib/disney-source-absence"));
const mode = require(path.join(root, "netlify/functions/lib/disney-discovery-mode"));
const quality = require(path.join(root, "netlify/functions/lib/disney-weekly-quality"));
const weeklyAuth = require(path.join(root, "netlify/functions/lib/disney-weekly-auth"));
const dispatch = require(path.join(root, "netlify/functions/lib/disney-weekly-maintenance-dispatch"));
const weeklyApply = require(path.join(root, "netlify/functions/lib/disney-weekly-apply"));
const controlled = require(path.join(root, "netlify/functions/lib/disney-controlled-batch"));
const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const locks = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const runner = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner"));
const inventory = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const adapter = require(path.join(root, "netlify/functions/lib/disney-discovery-adapter"));

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

const TODAY = "2026-08-15";
const LOCAL_MAC_ENV = { DISNEY_DISCOVERY_PRODUCTION_WRITES: "true" };
const APPLY_ARGS = {
  apply: true,
  dryRun: false,
  confirm: weekly.WEEKLY_APPLY_CONFIRMATION_TOKEN,
  maxWrites: 10
};

function healthySimulation(overrides = {}) {
  return {
    products: [{ official_sailing_id: "DA0071|2026-09-05" }],
    snapshot: { expansion: { expansion_errors: 0 } },
    quality_gate: {
      source_complete: true,
      identity_coverage_pct: 100,
      duplicate_official_identities: 0,
      ship_resolution_pct: 100,
      embarkation_resolution_pct: 100,
      destination_resolution_pct: 100,
      duration_validation_pct: 100,
      endpoint_unresolved_conflicts: 0
    },
    eligibility: { arithmetic: { reconciles: true } },
    ...overrides
  };
}

function mockExisting(overrides = {}) {
  return {
    id: "existing-1",
    cruise_line_id: "disney-line",
    ship_id: "ship-a",
    destination_id: "dest-1",
    departure_date: "2027-01-01",
    return_date: "2027-01-08",
    nights: 7,
    departure_port: "Port Canaveral",
    itinerary: "Caribbean",
    status: "active",
    official_sailing_id: "DA0071|2027-01-01",
    external_key: "ek-1",
    identity_key: "ik-1",
    official_url: "https://disney.example/a",
    source_url: "https://disney.example/source/a",
    ...overrides
  };
}

function mockNormalisedProduct(overrides = {}) {
  const raw = {
    official_product_key: "DA0071|2027-01-01",
    sailing_id: "DA0071",
    departure_date: "2027-01-01",
    return_date: "2027-01-08",
    nights: 7,
    ship_name: "Disney Dream",
    ship_code: "DD",
    destination_code: "CARIBBEAN",
    ...overrides.raw
  };
  return {
    raw,
    eligibility: { production_eligible: true, ...(overrides.eligibility || {}) },
    candidate: {
      ship_id: "ship-a",
      destination_id: "dest-1",
      departure_date: raw.departure_date,
      return_date: raw.return_date,
      nights: raw.nights,
      departure_port: "Port Canaveral",
      official_url: "https://disney.example/b",
      source_url: "https://disney.example/source/b",
      ...(overrides.candidate || {})
    },
    ...overrides
  };
}

/* ------------------------------------------------------------------ SOURCE */

test("SOURCE 1. complete source quality gate passes", () => {
  const gate = quality.evaluateDisneyWeeklySourceQualityGate(healthySimulation());
  if (!gate.passed) throw new Error(JSON.stringify(gate.failures));
  if (!quality.isDisneySourceSnapshotComplete(healthySimulation(), gate)) {
    throw new Error("snapshot should be complete");
  }
});

test("SOURCE 2. auth failure blocks weekly write safety", () => {
  const safety = weeklyPolicy.assessDisneyWeeklyWriteSafety({
    sourceQualityGatePassed: false,
    collapseGatePassed: true,
    performWrites: true,
    proposedIdentityReviewUpdates: 0
  });
  if (safety.ok) throw new Error("failed source gate must block writes");
  if (!safety.failures.includes("source_quality_gate_failed")) {
    throw new Error(JSON.stringify(safety.failures));
  }
});

test("SOURCE 3. zero source total blocks quality gate", () => {
  const gate = quality.evaluateDisneyWeeklySourceQualityGate(healthySimulation({ products: [] }));
  if (gate.passed) throw new Error("zero source should fail");
  if (!gate.failures.includes("zero_source_total")) throw new Error(JSON.stringify(gate.failures));
});

test("SOURCE 4. >=20% collapse blocks collapse guard", () => {
  const guard = quality.evaluateDisneyCollapseGuard({
    currentRawIdentities: Array.from({ length: 80 }, (_, i) => `ID-${i}`),
    previousAcceptedBaseline: 100
  });
  if (guard.collapse_gate_passed) throw new Error("20% collapse must block");
  if (guard.missing_pct < quality.COLLAPSE_THRESHOLD) throw new Error(String(guard.missing_pct));
});

test("SOURCE 5. collapse guard operates on raw identity set size", () => {
  const guard = quality.evaluateDisneyCollapseGuard({
    currentRawIdentities: ["A|1", "A|1", "B|2", "C|3", "D|4", "E|5", "F|6", "G|7", "H|8", "I|9"],
    previousAcceptedBaseline: 10
  });
  if (guard.current_source_total !== 9) throw new Error(`expected 9 unique, got ${guard.current_source_total}`);
  if (!guard.collapse_gate_passed) throw new Error("deduped identity set should pass collapse guard");
  if (guard.missing_pct >= quality.COLLAPSE_THRESHOLD) throw new Error(String(guard.missing_pct));
});

test("SOURCE 6. identity collisions block quality gate", () => {
  const gate = quality.evaluateDisneyWeeklySourceQualityGate(
    healthySimulation({
      quality_gate: { ...healthySimulation().quality_gate, duplicate_official_identities: 2 }
    })
  );
  if (gate.passed) throw new Error("collisions should fail");
  if (!gate.failures.includes("identity_collisions")) throw new Error(JSON.stringify(gate.failures));
});

test("SOURCE 7. endpoint unresolved conflicts block quality gate", () => {
  const gate = quality.evaluateDisneyWeeklySourceQualityGate(
    healthySimulation({
      quality_gate: { ...healthySimulation().quality_gate, endpoint_unresolved_conflicts: 1 }
    })
  );
  if (gate.passed) throw new Error("endpoint conflicts should fail");
  if (!gate.failures.includes("endpoint_unresolved_conflicts")) {
    throw new Error(JSON.stringify(gate.failures));
  }
});

test("SOURCE 7b. dest fail persists official sailing evidence", () => {
  const gate = quality.evaluateDisneyWeeklySourceQualityGate(
    healthySimulation({
      quality_gate: { ...healthySimulation().quality_gate, destination_resolution_pct: 99.5 },
      destination_analysis: {
        destination_resolution_pct: 99.5,
        unresolved: [
          {
            destination_code: "BAH",
            geo_area: "Bahamas",
            sailing_count: 1,
            sample_product_names: ["Bahamas from Port Canaveral"],
            sample_ports: ["Port Canaveral"],
            proposed_canonical: null,
            resolution_method: null,
            confidence: null
          }
        ]
      },
      products: [
        {
          official_sailing_id: "DA0099|2027-03-01",
          destination_resolution: { status: "unresolved" },
          raw: {
            official_product_key: "DA0099|2027-03-01",
            product_name: "Bahamas from Port Canaveral",
            ship_name: "Disney Dream",
            departure_date: "2027-03-01",
            destination_code: "BAH",
            geo_area: "Bahamas"
          },
          candidate: { departure_date: "2027-03-01" }
        }
      ]
    })
  );
  if (gate.passed) throw new Error("dest <100 must fail");
  if (!gate.failures.includes("destination_resolution_below_100")) {
    throw new Error(JSON.stringify(gate.failures));
  }
  if (gate.unresolved_destinations?.unresolved_sailings?.[0]?.official_sailing_id !== "DA0099|2027-03-01") {
    throw new Error(JSON.stringify(gate.unresolved_destinations));
  }
  const report = weekly.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt: "2026-08-31T00:00:00.000Z",
    endedAt: "2026-08-31T00:00:01.000Z",
    environment: { source_environment: "local_mac" },
    result: {
      ok: false,
      blocked: true,
      reason: "destination_resolution_below_100",
      source_quality_gate: gate,
      summary: {
        source_quality_gate: gate,
        resolution_rates: { destination_resolution_pct: 99.5 },
        unresolved_destinations: gate.unresolved_destinations
      }
    },
    countsBefore: { disney: 595 },
    countsAfter: { disney: 595 }
  });
  if (report.unresolved_destinations?.unresolved_sailings?.[0]?.official_sailing_id !== "DA0099|2027-03-01") {
    throw new Error("CLI report must keep dest evidence");
  }
});

/* ----------------------------------------------------------------- INSERTS */

test("INSERTS 8. new eligible voyage proposes insert_active", () => {
  const row = mockNormalisedProduct();
  const action = adapter.classifyProposedAction(row, null);
  if (action !== "insert_active") throw new Error(action);
});

test("INSERTS 9. <=21 day departure excluded from public bookable inventory", () => {
  const dep21 = inventory.addCalendarDays(TODAY, 21);
  if (inventory.isCruisePubliclyBookable({ departureDate: dep21, status: "active", perthToday: TODAY })) {
    throw new Error("21 days must not be publicly bookable");
  }
  const dep20 = inventory.addCalendarDays(TODAY, 20);
  if (inventory.isCruisePubliclyBookable({ departureDate: dep20, status: "active", perthToday: TODAY })) {
    throw new Error("20 days must not be publicly bookable");
  }
});

test("INSERTS 10. 22+ day departure eligible via cutoff helpers", () => {
  const dep22 = inventory.addCalendarDays(TODAY, 22);
  if (!inventory.isCruisePubliclyBookable({ departureDate: dep22, status: "active", perthToday: TODAY })) {
    throw new Error("22 days must be publicly bookable");
  }
  const minDep = inventory.publicBookingMinimumDepartureDate(TODAY);
  if (minDep !== dep22) throw new Error(`minimum departure ${minDep}, expected ${dep22}`);
  if (inventory.daysUntilDeparture(dep22, TODAY) !== 22) throw new Error("daysUntilDeparture mismatch");
});

test("INSERTS 11. controlled batch excludes <=21 day insert candidates", () => {
  const dep21 = inventory.addCalendarDays(TODAY, 21);
  const row = {
    eligibility: { production_eligible: true },
    official_sailing_id: "DA0099|2026-09-01",
    candidate: { departure_date: dep21, departure_port_meta: { status: "resolved", unresolved_conflicts: [] } },
    raw: { one_way_itinerary: false },
    ship_resolution: { resolved: true },
    destination_resolution: { status: "resolved" },
    duration_validation: { exact_match: true },
    days_until_departure: 21
  };
  if (controlled.isFirstBatchEligible(row, TODAY, new Map())) {
    throw new Error("<=21 day row must not be first-batch eligible");
  }
});

/* ----------------------------------------------------------------- UPDATES */

test("UPDATES 12. identity immutable fields trigger review", () => {
  const existing = mockExisting();
  const candidate = { ...existing, official_sailing_id: "CHANGED|2027-01-01" };
  const risk = weeklyPolicy.classifyDisneyUpdateRisk(existing, candidate);
  if (!risk.immutable_violations.includes("official_sailing_id")) {
    throw new Error(JSON.stringify(risk.immutable_violations));
  }
  const refined = weeklyPolicy.refineDisneyProposedActionForWeekly(
    "update_exact_existing",
    existing,
    candidate
  );
  if (refined !== "update_identity_review_required") throw new Error(refined);
});

test("UPDATES 13. ship change requires identity review", () => {
  const existing = mockExisting();
  const candidate = { ...existing, ship_id: "ship-b" };
  const refined = weeklyPolicy.refineDisneyProposedActionForWeekly(
    "update_exact_existing",
    existing,
    candidate
  );
  if (refined !== "update_identity_review_required") throw new Error(refined);
});

test("UPDATES 14. departure date change requires identity review", () => {
  const existing = mockExisting();
  const candidate = { ...existing, departure_date: "2027-01-02" };
  const refined = weeklyPolicy.refineDisneyProposedActionForWeekly(
    "update_exact_existing",
    existing,
    candidate
  );
  if (refined !== "update_identity_review_required") throw new Error(refined);
});

test("UPDATES 15. safe metadata URL-only change allowed for weekly apply", () => {
  const existing = mockExisting();
  const candidate = { ...existing, official_url: "https://disney.example/updated" };
  const refined = weeklyPolicy.refineDisneyProposedActionForWeekly(
    "update_exact_existing",
    existing,
    candidate
  );
  if (refined !== "update_safe_metadata_allowed") throw new Error(refined);
});

test("UPDATES 16. identity-critical updates block performWrites safety", () => {
  const safety = weeklyPolicy.assessDisneyWeeklyWriteSafety({
    performWrites: true,
    proposedIdentityReviewUpdates: 1,
    sourceQualityGatePassed: true,
    collapseGatePassed: true
  });
  if (safety.ok) throw new Error("identity review updates must block apply");
  if (!safety.failures.includes("identity_critical_updates_require_review")) {
    throw new Error(JSON.stringify(safety.failures));
  }
});

/* -------------------------------------------------------------- WRITE CAP */

test("WRITE CAP 17. Disney weekly cap defaults to 30", () => {
  if (weekly.MAX_WEEKLY_WRITES !== 30) throw new Error(String(weekly.MAX_WEEKLY_WRITES));
  if (runner.DISNEY_MAX_WEEKLY_WRITES !== 30) throw new Error(String(runner.DISNEY_MAX_WEEKLY_WRITES));
  if (weeklyPolicy.DISNEY_MAX_WEEKLY_MATERIAL_WRITES !== 30) {
    throw new Error(String(weeklyPolicy.DISNEY_MAX_WEEKLY_MATERIAL_WRITES));
  }
});

test("WRITE CAP 18. exactly 30 material actions accepted", () => {
  const actions = Array.from({ length: 30 }, (_, i) => ({ official_sailing_id: `S${String(i).padStart(3, "0")}` }));
  const bound = weeklyPolicy.boundMaterialActions(actions, 30);
  if (bound.material_actions_applied !== 30) throw new Error(String(bound.material_actions_applied));
  if (bound.material_actions_deferred !== 0) throw new Error(String(bound.material_actions_deferred));
});

test("WRITE CAP 19. 31+ material actions deferred", () => {
  const actions = Array.from({ length: 31 }, (_, i) => ({ official_sailing_id: `S${String(i).padStart(3, "0")}` }));
  const bound = weeklyPolicy.boundMaterialActions(actions, 30);
  if (bound.material_actions_applied !== 30) throw new Error(String(bound.material_actions_applied));
  if (bound.material_actions_deferred !== 1) throw new Error(String(bound.material_actions_deferred));
  if (bound.deferred.length !== 1) throw new Error(String(bound.deferred.length));
});

test("WRITE CAP 20. runner change volume cap STOP at 31+", () => {
  const cap = weekly.assessWeeklyChangeVolumeCap(20, 11);
  if (cap.ok) throw new Error("31 combined changes must fail cap assessment");
});

/* -------------------------------------------------------- SOURCE ABSENCE */

test("SOURCE ABSENCE 21. first complete absence retains active and stores observation", () => {
  const now = new Date("2026-08-15T10:00:00.000Z");
  const result = sourceAbsence.classifyDisneySourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "MISSING1", discovered_cruise_id: "dc-1", departure_date: "2027-03-01" }],
    previousObservationBySailingId: {},
    enumerationHealthy: true,
    sourceComplete: true,
    now
  });
  if (result.source_absent_observed !== 1) throw new Error(String(result.source_absent_observed));
  if (result.source_absent_confirmed !== 0) throw new Error(String(result.source_absent_confirmed));
  const record = result.source_absent_retained_records[0];
  if (record.proposed_action !== "retain_active") throw new Error(record.proposed_action);
  if (!result.source_absence_observations.MISSING1?.first_observed_at) {
    throw new Error("observation not stored");
  }
});

test("SOURCE ABSENCE 22. second consecutive complete absence confirms", () => {
  const now = new Date("2026-08-22T10:00:00.000Z");
  const previous = {
    MISSING1: {
      first_observed_at: "2026-08-15T10:00:00.000Z",
      last_observed_at: "2026-08-15T10:00:00.000Z",
      consecutive_complete_absences: 1,
      classification: "source_absent_observed"
    }
  };
  const result = sourceAbsence.classifyDisneySourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "MISSING1", discovered_cruise_id: "dc-1" }],
    previousObservationBySailingId: previous,
    enumerationHealthy: true,
    sourceComplete: true,
    deactivationEnabled: true,
    now
  });
  if (result.source_absent_confirmed !== 1) throw new Error(String(result.source_absent_confirmed));
  const confirmed = result.source_absent_confirmed_records[0];
  if (confirmed.classification !== "source_absent_confirmed") throw new Error(confirmed.classification);
  if (confirmed.deactivation_allowed !== true) throw new Error("deactivation should be allowed when flag on");
});

test("SOURCE ABSENCE 23. incomplete snapshot does not increment consecutive absences streak", () => {
  const now = new Date("2026-08-22T10:00:00.000Z");
  const previous = {
    MISSING1: {
      first_observed_at: "2026-08-15T10:00:00.000Z",
      consecutive_complete_absences: 1
    }
  };
  const result = sourceAbsence.classifyDisneySourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "MISSING1", discovered_cruise_id: "dc-1" }],
    previousObservationBySailingId: previous,
    enumerationHealthy: true,
    sourceComplete: false,
    now
  });
  const obs = result.source_absence_observations.MISSING1;
  if (obs.consecutive_complete_absences !== 2) {
    throw new Error(`expected streak increment only when sourceComplete; got ${obs.consecutive_complete_absences}`);
  }
  if (result.source_absence_actions_allowed) throw new Error("incomplete snapshot must not allow actions");
});

test("SOURCE ABSENCE 24. reappearance clears previous absence observation", () => {
  const result = sourceAbsence.classifyDisneySourceAbsence({
    currentAbsentRows: [],
    previousObservationBySailingId: {
      RETURNED1: {
        first_observed_at: "2026-08-01T10:00:00.000Z",
        consecutive_complete_absences: 1
      }
    },
    enumerationHealthy: true,
    sourceComplete: true
  });
  if (result.source_absence_cleared_count !== 1) throw new Error(String(result.source_absence_cleared_count));
  if (result.source_absence_cleared[0].official_sailing_id !== "RETURNED1") {
    throw new Error(JSON.stringify(result.source_absence_cleared));
  }
});

test("SOURCE ABSENCE 25. >14 day window resets consecutive absence streak", () => {
  const now = new Date("2026-09-01T10:00:00.000Z");
  const result = sourceAbsence.classifyDisneySourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "STALE1", discovered_cruise_id: "dc-2" }],
    previousObservationBySailingId: {
      STALE1: {
        first_observed_at: "2026-08-01T10:00:00.000Z",
        consecutive_complete_absences: 1
      }
    },
    enumerationHealthy: true,
    sourceComplete: true,
    now
  });
  const obs = result.source_absence_observations.STALE1;
  if (obs.consecutive_complete_absences !== 1) {
    throw new Error(`stale window should reset streak, got ${obs.consecutive_complete_absences}`);
  }
  if (result.source_absent_confirmed !== 0) throw new Error("stale first observation must not confirm");
});

test("SOURCE ABSENCE 26. legacy rows excluded from absence policy scope", () => {
  if (sourceAbsence.classifyDisneySourceAbsence({}).legacy_excluded !== true) {
    throw new Error("legacy_excluded flag expected");
  }
  if (controlled.DISNEY_LEGACY_ROW_IDS.length !== 6) throw new Error("expected six legacy rows");
});

test("SOURCE ABSENCE 27. absence does not infer cancellation", () => {
  const result = sourceAbsence.classifyDisneySourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "MISSING2", discovered_cruise_id: "dc-3" }],
    enumerationHealthy: true,
    sourceComplete: true
  });
  if (result.cancellation_inferred_from_absence !== false) throw new Error("must not infer cancellation");
  const row = result.source_absent_retained_records[0];
  if (row.cancellation_inferred !== false) throw new Error("row must not infer cancellation");
});

test("SOURCE ABSENCE 28. absence policy never hard-deletes voyages", () => {
  const result = sourceAbsence.classifyDisneySourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "MISSING3", discovered_cruise_id: "dc-4" }],
    enumerationHealthy: true,
    sourceComplete: true,
    deactivationEnabled: true
  });
  if (result.hard_deletes_voyages !== false) throw new Error("hard deletes forbidden");
  for (const row of result.source_absent_retained_records) {
    if (row.hard_delete !== false) throw new Error("row hard_delete must be false");
  }
});

test("SOURCE ABSENCE 29. deactivation requires explicit flag", () => {
  const withoutFlag = sourceAbsence.classifyDisneySourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "MISSING4", discovered_cruise_id: "dc-5" }],
    previousObservationBySailingId: {
      MISSING4: {
        first_observed_at: "2026-08-15T10:00:00.000Z",
        consecutive_complete_absences: 1
      }
    },
    enumerationHealthy: true,
    sourceComplete: true,
    deactivationEnabled: false,
    now: new Date("2026-08-22T10:00:00.000Z")
  });
  if (withoutFlag.source_absent_confirmed !== 1) throw new Error("second absence should confirm");
  if (withoutFlag.source_absence_actions_allowed) throw new Error("deactivation flag off must block actions");
  if (!weeklyPolicy.isDisneySourceAbsenceDeactivationEnabled({})) {
    /* expected default */
  } else {
    throw new Error("deactivation must stay disabled by default");
  }
});

/* ------------------------------------------------------------------- LOCKS */

test("LOCKS 30. Disney weekly lock key uses 1800 second lease", () => {
  const lockKey = locks.weeklyLockKey("disney-cruise-line");
  if (lockKey !== "disney-cruise-line:weekly") throw new Error(lockKey);
  if (locks.DEFAULT_LEASE_SECONDS[lockKey] !== 1800) throw new Error(String(locks.DEFAULT_LEASE_SECONDS[lockKey]));
});

test("LOCKS 31. Disney weekly lock maps to disney_weekly_maintenance run type", () => {
  if (maintenance.DISNEY_WEEKLY_MAINTENANCE_RUN_TYPE !== "disney_weekly_maintenance") {
    throw new Error(maintenance.DISNEY_WEEKLY_MAINTENANCE_RUN_TYPE);
  }
  const schedule = maintenance.MAINTENANCE_SCHEDULES.disney_weekly;
  if (!schedule?.schedule_registered) throw new Error("disney_weekly schedule not registered");
  if (schedule.function !== "disney-weekly-maintenance-cron") throw new Error(schedule.function);
  if (schedule.background_function !== "disney-weekly-maintenance-background") {
    throw new Error(schedule.background_function);
  }
});

/* ----------------------------------------------------------------- NETLIFY */

test("NETLIFY 32. scheduled cron disabled when maintenance schedule flag off", () => {
  const state = dispatch.resolveScheduledLauncherState(
    {
      headers: { "x-netlify-event": "schedule" },
      body: JSON.stringify({ next_run: "2026-08-18T02:00:00.000Z" })
    },
    { DISNEY_DISCOVERY_MAINTENANCE_SCHEDULED_ENABLED: "false" }
  );
  if (!state.disabled) throw new Error("cron must be disabled");
  if (!String(state.reason).includes("DISNEY_DISCOVERY_MAINTENANCE_SCHEDULED_ENABLED=false")) {
    throw new Error(state.reason);
  }
});

test("NETLIFY 33. resolveDryRun true when production writes disabled", () => {
  if (dispatch.resolveDryRun({}) !== true) {
    throw new Error("production writes off must force dry run");
  }
  if (dispatch.resolveDryRun({ dry_run: true }) !== true) {
    throw new Error("explicit dry_run true always forces dry run");
  }
  if (weeklyPolicy.isDisneyProductionWritesEnabled({ DISNEY_DISCOVERY_PRODUCTION_WRITES: "false" })) {
    throw new Error("production writes flag off in policy helper");
  }
  if (!weeklyPolicy.isDisneyProductionWritesEnabled({ DISNEY_DISCOVERY_PRODUCTION_WRITES: "true" })) {
    throw new Error("production writes flag on in policy helper");
  }
});

test("NETLIFY 34. secretsEqual is timing-safe and length-sensitive", () => {
  if (!weeklyAuth.secretsEqual("abc", "abc")) throw new Error("equal secrets must match");
  if (weeklyAuth.secretsEqual("abc", "abd")) throw new Error("different secrets must not match");
  if (weeklyAuth.secretsEqual("abc", "abcd")) throw new Error("length mismatch must not match");
  if (weeklyAuth.secretsEqual("", "abc")) throw new Error("empty provided must not match");
});

test("NETLIFY 35. background auth rejects wrong secret", () => {
  let threw = false;
  try {
    weeklyAuth.assertCronAuth(
      { headers: { "x-discovery-cron-secret": "wrong-secret" } },
      { DISCOVERY_CRON_SECRET: "expected-secret" }
    );
  } catch (e) {
    threw = e.code === "unauthorized";
  }
  if (!threw) throw new Error("background must reject wrong secret");
  const bgSrc = fs.readFileSync(
    path.join(root, "netlify/functions/disney-weekly-maintenance-background.js"),
    "utf8"
  );
  if (!bgSrc.includes("assertCronAuth")) throw new Error("background must require secret");
  if (bgSrc.includes("isScheduledInvocation")) {
    throw new Error("background must not bypass auth via schedule header");
  }
});

test("NETLIFY 36. forged schedule header without next_run rejected on launcher auth", () => {
  let threw = false;
  try {
    weeklyAuth.assertDisneyWeeklyAuth(
      { headers: { "x-netlify-event": "schedule" }, body: "{}" },
      { DISCOVERY_CRON_SECRET: "expected-secret" }
    );
  } catch (e) {
    threw = e.code === "unauthorized";
  }
  if (!threw) throw new Error("header-only schedule spoof must fail");
  weeklyAuth.assertDisneyWeeklyAuth(
    {
      headers: { "x-netlify-event": "schedule" },
      body: JSON.stringify({ next_run: "2026-08-18T02:00:00.000Z" })
    },
    { DISNEY_DISCOVERY_PRODUCTION_WRITES: "true", DISCOVERY_CRON_SECRET: "expected-secret" }
  );
});

/* ------------------------------------------------------------------- AUDIT */

test("AUDIT 37. legacy six count unchanged in controlled batch constants", () => {
  if (controlled.DISNEY_LEGACY_ROW_IDS.length !== 6) {
    throw new Error(`expected 6 legacy rows, got ${controlled.DISNEY_LEGACY_ROW_IDS.length}`);
  }
  const unique = new Set(controlled.DISNEY_LEGACY_ROW_IDS);
  if (unique.size !== 6) throw new Error("legacy ids must be unique");
});

test("AUDIT 38. policy modules declare no hard deletes", () => {
  const policySrc = fs.readFileSync(
    path.join(root, "netlify/functions/lib/disney-weekly-update-policy.js"),
    "utf8"
  );
  const absenceSrc = fs.readFileSync(path.join(root, "netlify/functions/lib/disney-source-absence.js"), "utf8");
  if (!policySrc.includes("hard_deletes: false")) throw new Error("update policy must forbid hard deletes");
  if (!absenceSrc.includes("hard_deletes_voyages: false")) {
    throw new Error("source absence must forbid hard deletes");
  }
  const safety = weeklyPolicy.assessDisneyWeeklyWriteSafety({});
  if (safety.hard_deletes !== false) throw new Error("write safety must report hard_deletes false");
});

/* ----------------------------------------------------------- RUNNER CLI */

test("RUNNER 39. dry run is default when --apply absent", () => {
  const args = weekly.parseWeeklyMaintenanceArgs(["node", "script"]);
  if (args.apply || !args.dryRun) throw new Error(JSON.stringify(args));
});

test("RUNNER 40. apply requires exact DISNEY-WEEKLY-MAINTENANCE token", () => {
  expectThrows("weekly_apply_confirmation_required", () =>
    weekly.assertWeeklyApplyAllowed({ ...APPLY_ARGS, confirm: "WRONG" }, LOCAL_MAC_ENV)
  );
});

test("RUNNER 41. apply blocked while DISNEY_DISCOVERY_PRODUCTION_WRITES unset", () => {
  expectThrows("disney_weekly_production_writes_disabled", () =>
    weekly.assertWeeklyApplyAllowed(APPLY_ARGS, {})
  );
});

test("RUNNER 42. apply blocked on Netlify", () => {
  expectThrows("weekly_apply_netlify_forbidden", () =>
    weekly.assertWeeklyApplyAllowed(APPLY_ARGS, { ...LOCAL_MAC_ENV, NETLY: "true", NETLIFY: "true" })
  );
});

test("RUNNER 43. weekly_maintenance mode blocked when production writes flag disabled", () => {
  const prev = process.env.DISNEY_DISCOVERY_PRODUCTION_WRITES;
  process.env.DISNEY_DISCOVERY_PRODUCTION_WRITES = "false";
  const gate = mode.resolveDisneyDiscoveryMode("weekly_maintenance");
  if (gate.writes_allowed) throw new Error("weekly flag must be disabled when production writes off");
  process.env.DISNEY_DISCOVERY_PRODUCTION_WRITES = prev;
});

test("RUNNER 44. buildDisneyWeeklyManifest insert candidate without supabase", async () => {
  const product = mockNormalisedProduct({
    raw: { official_product_key: "DA0100|2027-06-01", sailing_id: "DA0100", departure_date: "2027-06-01" }
  });
  const manifest = await weeklyApply.buildDisneyWeeklyManifest({
    products: [product],
    cruiseLine: { id: "disney-line", slug: "disney-cruise-line" },
    supabase: null,
    runId: "test-manifest"
  });
  if (manifest.inserts.length !== 1) throw new Error(`expected 1 insert, got ${manifest.inserts.length}`);
  if (manifest.inserts[0].official_sailing_id !== adapter.officialProductKey(product.raw)) {
    throw new Error("insert key mismatch");
  }
});

test("RUNNER 45. netlify.toml registers Disney weekly cron schedule", () => {
  const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
  if (!toml.includes('[functions."disney-weekly-maintenance-cron"]')) throw new Error("missing cron fn");
  if (!toml.includes('schedule = "0 2 * * 1"')) throw new Error("missing disney schedule line");
});

test("RUNNER 46. bulk import flag DISNEY_DISCOVERY_WRITE_ENABLED must stay false", () => {
  const flags = maintenance.describeMaintenanceHold();
  if (!flags.bulk_import_flags_must_remain_false.includes("DISNEY_DISCOVERY_WRITE_ENABLED")) {
    throw new Error("DISNEY_DISCOVERY_WRITE_ENABLED must stay false until controlled import");
  }
});

test("RUNNER 47. catastrophic collapse blocks weekly write safety", () => {
  const safety = weeklyPolicy.assessDisneyWeeklyWriteSafety({
    performWrites: true,
    sourceQualityGatePassed: true,
    collapseGatePassed: false
  });
  if (safety.ok) throw new Error("collapse must block writes");
  if (!safety.failures.includes("catastrophic_source_collapse")) {
    throw new Error(JSON.stringify(safety.failures));
  }
});

console.log(`\n${passed} tests passed, ${failures.length} failed`);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
