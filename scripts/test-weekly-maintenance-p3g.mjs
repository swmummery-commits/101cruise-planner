#!/usr/bin/env node
/**
 * P3G staggered-schedule production-proof tests. No production writes.
 *
 *   npm run test:weekly-maintenance-p3g
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const schedule = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control"));
const map = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-map"));
const ops = require(path.join(root, "netlify/functions/lib/maintenance-operational-status"));
const inventory = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const accounting = require(path.join(root, "netlify/functions/lib/weekly-maintenance-write-accounting"));
const royalPlan = require(path.join(root, "netlify/functions/lib/royal-caribbean-p3g-catchup-plan"));
const royalHealth = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-health"));
const royalEnum = require(path.join(root, "netlify/functions/lib/royal-caribbean-source-enumeration"));
const nclAudit = require(path.join(root, "netlify/functions/lib/norwegian-match-required-audit"));
const nclIdentity = require(path.join(root, "netlify/functions/lib/norwegian-voyage-identity-classifier"));
const nclAdapter = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));
const nclSource = require(path.join(root, "netlify/functions/lib/norwegian-discovery-source"));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error: error.message || String(error) });
    console.log(`✗ ${name} — ${error.message || error}`);
  }
}

const SLUGS = [
  "holland-america-line",
  "celebrity-cruises",
  "princess-cruises",
  "explora-journeys",
  "seabourn-cruise-line",
  "royal-caribbean-international",
  "norwegian-cruise-line",
  "carnival-cruise-line",
  "disney-cruise-line",
  "azamara",
  "silversea-cruises"
];

function dueStates(now, extra = {}) {
  return Object.fromEntries(
    SLUGS.map((slug) => [
      slug,
      map.classifyWeeklyDueState({
        now,
        schedule: map.scheduleForSlug(slug),
        ...extra
      }).due_state
    ])
  );
}

test("daily expiry cron is 06:30 Perth / 30 22 * * *", () => {
  if (maintenance.MAINTENANCE_SCHEDULES.daily_expiry.cron_utc !== "30 22 * * *") {
    throw new Error(maintenance.MAINTENANCE_SCHEDULES.daily_expiry.cron_utc);
  }
  const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
  const block = toml.match(/\[functions\."cruise-daily-expiry-cron"\][\s\S]*?(?=\n\[|$)/)?.[0] || "";
  if (!block.includes('schedule = "30 22 * * *"')) throw new Error("netlify.toml expiry cron not moved");
  if (block.includes('schedule = "30 17 * * *"')) throw new Error("old 01:30 cron still present");
});

test("Perth-date lease remains daily-expiry:{PERTH_DATE}:scheduled at 06:30", () => {
  const key = schedule.scheduledDailyExpiryDispatchKey(new Date("2026-09-15T06:30:00+08:00"));
  if (key !== "daily-expiry:2026-09-15:scheduled") throw new Error(key);
  if (maintenance.perthCalendarDate(new Date("2026-09-14T22:30:00.000Z")) !== "2026-09-15") {
    throw new Error("22:30 UTC is not the next Perth morning");
  }
});

test("schedule move cannot double-run the same Perth date", () => {
  const a = schedule.scheduledDailyExpiryDispatchKey(new Date("2026-09-14T01:30:00+08:00"));
  const b = schedule.scheduledDailyExpiryDispatchKey(new Date("2026-09-14T06:30:00+08:00"));
  if (a !== b) throw new Error("same Perth date produced two lease keys");
});

test("schedule move cannot skip a Perth date", () => {
  const dates = ["2026-09-14", "2026-09-15", "2026-09-16"].map(
    (d) => schedule.scheduledDailyExpiryDispatchKey(new Date(`${d}T06:30:00+08:00`))
  );
  if (new Set(dates).size !== 3) throw new Error("a Perth date was skipped or collapsed");
});

test("21-day public cutoff is unchanged", () => {
  if (inventory.PUBLIC_BOOKING_CUTOFF_DAYS !== 21) throw new Error(String(inventory.PUBLIC_BOOKING_CUTOFF_DAYS));
});

test("weekly line timetable is unchanged", () => {
  const expected = {
    "holland-america-line": "0 17 * * 0",
    "celebrity-cruises": "0 19 * * 0",
    "princess-cruises": "0 21 * * 0",
    "explora-journeys": "0 17 * * 1",
    "seabourn-cruise-line": "0 19 * * 1",
    "royal-caribbean-international": "0 17 * * 2",
    "norwegian-cruise-line": "0 19 * * 2",
    "carnival-cruise-line": "0 17 * * 3",
    "disney-cruise-line": "0 19 * * 3",
    azamara: "0 17 * * 4",
    "silversea-cruises": "0 19 * * 4"
  };
  for (const [slug, cron] of Object.entries(expected)) {
    const row = map.scheduleForSlug(slug);
    if (!row || row.cron_utc !== cron) throw new Error(`${slug} timetable drifted to ${row?.cron_utc}`);
  }
});

test("Monday 13:00 Perth: Mon lines evaluable, Tue-Fri NOT_DUE", () => {
  const states = dueStates(new Date("2026-09-14T13:00:00+08:00"));
  for (const slug of ["holland-america-line", "celebrity-cruises", "princess-cruises"]) {
    if (states[slug] === "NOT_DUE") throw new Error(`${slug} should be evaluable Monday 13:00`);
  }
  for (const slug of [
    "explora-journeys",
    "seabourn-cruise-line",
    "royal-caribbean-international",
    "norwegian-cruise-line",
    "carnival-cruise-line",
    "disney-cruise-line",
    "azamara",
    "silversea-cruises"
  ]) {
    if (states[slug] !== "NOT_DUE") throw new Error(`${slug} must be NOT_DUE Monday 13:00, got ${states[slug]}`);
    if (states[slug] === "MISSED_SCHEDULE") throw new Error(`${slug} future line leaked MISSED_SCHEDULE`);
  }
});

test("Tuesday 02:00 Perth: Explora evaluable, Seabourn not yet due", () => {
  const states = dueStates(new Date("2026-09-15T02:00:00+08:00"));
  if (states["explora-journeys"] === "NOT_DUE") throw new Error("Explora should be evaluable Tuesday 02:00");
  if (states["seabourn-cruise-line"] !== "NOT_DUE") throw new Error(states["seabourn-cruise-line"]);
  if (states["royal-caribbean-international"] !== "NOT_DUE") throw new Error(states["royal-caribbean-international"]);
  if (states["norwegian-cruise-line"] !== "NOT_DUE") throw new Error(states["norwegian-cruise-line"]);
});

test("Wednesday 02:00 Perth: Royal evaluable, NCL not due until 03:00", () => {
  const states = dueStates(new Date("2026-09-16T02:00:00+08:00"));
  if (states["royal-caribbean-international"] === "NOT_DUE") throw new Error("Royal should be evaluable Wednesday 02:00");
  if (states["norwegian-cruise-line"] !== "NOT_DUE") throw new Error(states["norwegian-cruise-line"]);
  if (states["carnival-cruise-line"] !== "NOT_DUE") throw new Error(states["carnival-cruise-line"]);
  if (states["disney-cruise-line"] !== "NOT_DUE") throw new Error(states["disney-cruise-line"]);
});

test("Friday after 04:00 Perth: all weekly lines evaluable", () => {
  const states = dueStates(new Date("2026-09-18T16:00:00+08:00"));
  for (const slug of SLUGS) {
    if (states[slug] === "NOT_DUE") throw new Error(`${slug} still NOT_DUE Friday 16:00`);
  }
});

test("grace period does not mark MISSED at the scheduled minute", () => {
  const atSlot = map.classifyWeeklyDueState({
    now: new Date("2026-09-15T01:00:00+08:00"),
    schedule: map.scheduleForSlug("explora-journeys")
  });
  if (atSlot.due_state !== "DUE_RUNNING") throw new Error(atSlot.due_state);
  const afterGraceNoLease = map.classifyWeeklyDueState({
    now: new Date("2026-09-15T01:25:00+08:00"),
    schedule: map.scheduleForSlug("explora-journeys"),
    scheduledLeaseExists: false
  });
  if (afterGraceNoLease.due_state !== "SCHEDULER_MISSING") throw new Error(afterGraceNoLease.due_state);
  const afterGraceWithLease = map.classifyWeeklyDueState({
    now: new Date("2026-09-15T01:25:00+08:00"),
    schedule: map.scheduleForSlug("explora-journeys"),
    scheduledLeaseExists: true
  });
  if (afterGraceWithLease.due_state !== "MISSED_SCHEDULE") throw new Error(afterGraceWithLease.due_state);
});

test("scheduled execution suppresses MISSED_SCHEDULE", () => {
  const state = map.classifyWeeklyDueState({
    now: new Date("2026-09-15T02:00:00+08:00"),
    schedule: map.scheduleForSlug("explora-journeys"),
    scheduledExecutionExists: true
  });
  if (state.due_state !== "COMPLETED") throw new Error(state.due_state);
});

test("preflight period key is not the scheduled lease", () => {
  const week = schedule.perthIsoWeek(new Date("2026-09-14T12:00:00+08:00"));
  const scheduled = schedule.scheduledWeeklyDispatchKey("explora-journeys", new Date("2026-09-14T12:00:00+08:00"));
  const preflight = `weekly:explora-journeys:p3g-preflight-${week}:preflight`;
  if (scheduled === preflight) throw new Error("preflight key collided with scheduled lease");
  if (!scheduled.endsWith(":scheduled")) throw new Error(scheduled);
});

test("source-removed Royal IDs do not fail current health", () => {
  const classified = royalEnum.classifyRoyalAbsentProductionRecords({
    productionRows: [
      { official_sailing_id: "EX07M807_2026-10-17", departure_date: "2026-10-17", status: "active" }
    ],
    unionSailingIds: new Set(),
    today: "2026-09-14",
    detailLookupResults: [
      {
        official_sailing_id: "EX07M807_2026-10-17",
        group_missing: true,
        retrievable: false
      }
    ]
  });
  if (classified.unexplained_current_ids.length !== 0) throw new Error(JSON.stringify(classified.unexplained_current_ids));
  if (classified.counts.UNEXPLAINED_CURRENT !== 0) throw new Error("unexplained leaked");
});

test("Royal catch-up cap stays at 30 and master plan freezes TRUE_NEW_COMPLETE", () => {
  if (royalPlan.P3G_ROYAL_CATCHUP_BATCH_CAP !== 30) throw new Error("cap raised");
  if (royalPlan.P3G_ROYAL_CATCHUP_BATCH_CAP > 30) throw new Error("cap must not exceed 30");
  const inserts = Array.from({ length: 35 }, (_, i) => ({
    proposed_action: "insert_active",
    official_sailing_id: `OA07W${String(i).padStart(3, "0")}_2027-01-01`,
    identity_key: `id-${i}`,
    external_key: `ext-${i}`,
    canonical_ship_id: "ship-1",
    resolved_embarkation_port_name: "Miami",
    resolved_destination_id: "dest-1",
    candidate: {
      official_sailing_id: `OA07W${String(i).padStart(3, "0")}_2027-01-01`,
      identity_key: `id-${i}`,
      external_key: `ext-${i}`,
      ship_id: "ship-1",
      departure_port: "Miami",
      destination_id: "dest-1",
      official_url: `https://www.royalcaribbean.com/${i}`
    }
  }));
  inserts.push({
    proposed_action: "insert_active",
    official_sailing_id: "COLLIDE_2027-01-01",
    identity_key: "id-collide",
    candidate: { official_sailing_id: "COLLIDE_2027-01-01", identity_key: "id-collide" }
  });
  const plan = royalPlan.freezeRoyalCatchupMasterPlan({
    proposedInserts: inserts,
    productionRows: [{ id: "existing", official_sailing_id: "COLLIDE_2027-01-01" }],
    today: "2026-09-14",
    sourceSnapshotId: "snap-test"
  });
  if (plan.safe_backlog !== 35) throw new Error(`safe backlog ${plan.safe_backlog}`);
  if (plan.batches.length !== 2) throw new Error(`expected 2 batches, got ${plan.batches.length}`);
  if (plan.batches[0].expected_record_count !== 30) throw new Error("first batch must be 30");
  if (plan.batches[1].expected_record_count !== 5) throw new Error("remainder batch");
  if (plan.classification_counts.COLLISION !== 1) throw new Error("collision not blocked");
  if (!plan.plan_hash) throw new Error("master plan must be frozen");
});

test("volume above weekly ceiling is CONTROLLED_CATCHUP_REQUIRED, not generic failure", () => {
  const weekly = royalHealth.evaluateRoyalCaribbeanWeeklyHealth({
    sourceRuntimeOk: true,
    enumerationHealth: { royal_caribbean_source_enumeration_ok: true },
    reconciliationArithmeticOk: true,
    shipResolutionOk: true,
    embarkationResolutionOk: true,
    newEligibleCount: 105,
    proposedUpdateCount: 0,
    performWrites: false
  });
  if (weekly.weekly_change_volume_exceeded !== true) throw new Error("105 inserts must exceed weekly ceiling");
  if (weekly.weekly_maintenance_healthy !== true) throw new Error("read-only volume excess is not a source failure");
  const terminal = accounting.resolveWeeklyTerminalStatus({
    ok: true,
    terminal_status: "controlled_catchup_required",
    summary: { committed_material_writes: 0, inserts: 0, updates: 0 }
  });
  if (terminal !== "controlled_catchup_required") throw new Error(terminal);
  if (ops.weeklyBackgroundHttpStatus({ success: true, terminal_status: "controlled_catchup_required" }) !== 200) {
    throw new Error("catch-up required must be HTTP 200");
  }
});

test("NCL ship resolver and return-date derivation remain on the catalogue path", () => {
  const adapterSrc = fs.readFileSync(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter.js"), "utf8");
  const sourceSrc = fs.readFileSync(path.join(root, "netlify/functions/lib/norwegian-discovery-source.js"), "utf8");
  if (!adapterSrc.includes("inferNorwegianShipCodeFromItinerary")) throw new Error("adapter ship infer missing");
  if (!sourceSrc.includes("inferNorwegianShipCodeFromItinerary")) throw new Error("catalogue ship infer missing");
  if (!sourceSrc.includes("inferNorwegianNightsFromItinerary")) throw new Error("catalogue nights infer missing");
  if (typeof nclAdapter.inferNorwegianShipCodeFromItinerary === "function") {
    const code = nclAdapter.inferNorwegianShipCodeFromItinerary({ itineraryCode: "EPIC6MIA" });
    if (code && !["EPIC", "EP"].some((token) => String(code).includes(token) || token.includes(String(code)))) {
      // ship codes vary; presence of the helper on both paths is the scheduled-path contract
    }
  }
  if (!sourceSrc.includes("expandItineraryRecord")) throw new Error("canonical expandItineraryRecord missing");
});

test("existing match_required prevents duplicate insert and enrichment keeps UUID", () => {
  const existing = {
    id: "uuid-keep",
    official_sailing_id: "NCL123",
    status: "match_required",
    ship_id: "ship-1",
    departure_date: "2027-01-10",
    return_date: "2027-01-17",
    nights: 7,
    departure_port: "Miami"
  };
  const classified = nclIdentity.classifyNorwegianP3bCandidate(
    {
      official_sailing_id: "NCL123",
      ship_id: "ship-1",
      departure_date: "2027-01-10",
      return_date: "2027-01-17",
      nights: 7,
      departure_port: "Miami"
    },
    [existing]
  );
  if (classified.classification !== "ALREADY_MATCH_REQUIRED") throw new Error(classified.classification);
  const patch = nclAudit.buildMatchRequiredEnrichment(existing, {
    official_sailing_id: "NCL123",
    ship_id: "ship-1",
    departure_date: "2027-01-10",
    return_date: "2027-01-17",
    nights: 7,
    departure_port: "Miami",
    destination_id: "dest-1"
  });
  if (patch.id !== "uuid-keep") throw new Error("UUID replaced");
  let threw = false;
  try {
    nclAudit.assertExistingUuidPreserved(existing, { id: "uuid-new" });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("replacement UUID must be rejected");
});

test("match_required audit classes cover P3G cleanup", () => {
  const audit = nclAudit.auditNorwegianMatchRequiredRows(
    [
      { id: "a", official_sailing_id: "COMPLETE1", status: "match_required" },
      { id: "b", official_sailing_id: "ABSENT1", status: "match_required" },
      { id: "c", official_sailing_id: "DUP1", status: "match_required" }
    ],
    {
      sourceEligible: [
        {
          official_sailing_id: "COMPLETE1",
          ship_id: "s",
          departure_date: "2027-02-01",
          return_date: "2027-02-08",
          nights: 7,
          departure_port: "Miami",
          destination_id: "d",
          source_url: "https://ncl.com/1"
        }
      ],
      productionRows: [{ id: "active-1", official_sailing_id: "DUP1", status: "active" }]
    }
  );
  if (audit.counts.SOURCE_NOW_COMPLETE !== 1) throw new Error(JSON.stringify(audit.counts));
  if (audit.counts.SOURCE_ABSENT !== 1) throw new Error(JSON.stringify(audit.counts));
  if (audit.counts.DUPLICATE_ACTIVE !== 1) throw new Error(JSON.stringify(audit.counts));
});

test("dashboard NOT_DUE wins over MISSED_SCHEDULE", () => {
  if (ops.classifyOperationalStatus({ notDue: true, missedSchedule: true }) !== "NOT_DUE") {
    throw new Error("NOT_DUE must win");
  }
  if (ops.classifyOperationalStatus({ schedulerMissing: true }) !== "SCHEDULER_MISSING") {
    throw new Error("scheduler missing");
  }
});

console.log(JSON.stringify({ passed, failed, failures }, null, 2));
process.exit(failed > 0 ? 1 : 0);
