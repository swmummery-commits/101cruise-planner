#!/usr/bin/env node
/**
 * P3I tests: RCL normal apply, cutoff accounting, NCL staging UUID preservation.
 *
 *   npm run test:weekly-maintenance-p3i
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sim = require(path.join(root, "netlify/functions/lib/royal-caribbean-p3i-apply-sim"));
const health = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-health"));
const dispatch = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance-dispatch"));
const absence = require(path.join(root, "netlify/functions/lib/royal-caribbean-source-absence"));
const inventory = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const staging = require(path.join(root, "netlify/functions/lib/norwegian-p3i-staging"));
const nclIdentity = require(path.join(root, "netlify/functions/lib/norwegian-voyage-identity-classifier"));
const nclAudit = require(path.join(root, "netlify/functions/lib/norwegian-match-required-audit"));
const nclAdapter = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));

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

test("normal small insert APPLY", () => {
  const result = sim.simulateRoyalNormalApplyCase("inserts", {
    health: { newEligibleCount: 2, performWrites: true },
    insertIds: ["NEW1", "NEW2"]
  });
  if (result.writes.inserts !== 2) throw new Error(JSON.stringify(result.writes));
  if (result.terminal !== "completed") throw new Error(result.terminal);
});

test("normal safe update APPLY", () => {
  const result = sim.simulateRoyalNormalApplyCase("updates", {
    health: { proposedUpdateCount: 3, performWrites: true },
    safeUpdates: ["U1", "U2", "U3"]
  });
  if (result.writes.updates !== 3) throw new Error(JSON.stringify(result.writes));
});

test("157 DAILY_EXPIRY_MANAGED cutoff + 2 inserts does not trip 150 ceiling", () => {
  const result = sim.simulateRoyalNormalApplyCase("cutoff-plus-inserts", {
    health: { newEligibleCount: 2, cutoffCandidateCount: 157, performWrites: true },
    insertIds: ["NEW1", "NEW2"],
    cutoffCandidateCount: 157
  });
  if (result.volume_exceeded) throw new Error("cutoff must not count as RCL material writes");
  if (result.cutoff_hides_in_manifest !== 0) throw new Error("weekly RCL must not duplicate daily expiry hides");
  if (result.daily_expiry_managed !== 157) throw new Error(String(result.daily_expiry_managed));
  if (result.writes.inserts !== 2) throw new Error("only the two inserts should write");
  if (result.ceilings_ok !== true) throw new Error(result.ceiling_failures.join(","));
  if (result.cutoff_candidates_are_rcl_material_writes !== false) throw new Error("cutoff must stay diagnostic");
});

test("source-health blocking writes zero", () => {
  const result = sim.simulateRoyalNormalApplyCase("unhealthy", {
    health: {
      sourceRuntimeOk: false,
      enumerationHealth: { royal_caribbean_source_enumeration_ok: false },
      newEligibleCount: 2,
      performWrites: true
    },
    insertIds: ["NEW1", "NEW2"]
  });
  if (result.writes.inserts !== 0) throw new Error("unhealthy source must write nothing");
  if (result.terminal !== "source_repair_required") throw new Error(result.terminal);
});

test("ambiguous identity review writes nothing unsafe", () => {
  const result = sim.simulateRoyalNormalApplyCase("review", {
    health: { newEligibleCount: 0, performWrites: true },
    reviewUpdates: ["AMB1"],
    reviewRequired: true
  });
  if (result.writes.inserts !== 0 || result.writes.updates !== 0) throw new Error("review must not write");
  if (result.terminal !== "review_required") throw new Error(result.terminal);
});

test("huge insert backlog remains controlled_catchup_required without raising caps", () => {
  if (health.ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING.max_proposed_inserts !== 100) {
    throw new Error("insert cap raised");
  }
  if (health.ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING.max_total_proposed_changes !== 150) {
    throw new Error("total cap raised");
  }
  const result = sim.simulateRoyalNormalApplyCase("backlog", {
    health: { newEligibleCount: 106, performWrites: true },
    insertIds: Array.from({ length: 106 }, (_, i) => `ID_${i}`)
  });
  if (result.terminal !== "controlled_catchup_required") throw new Error(result.terminal);
  if (result.writes.inserts !== 0) throw new Error("backlog must not auto-apply");
});

test("source absence stays conservative and does not count unapproved hides", () => {
  const policy = absence.classifyRoyalCaribbeanSourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "A" }, { official_sailing_id: "B" }],
    previousAbsentSailingIds: ["A"],
    enumerationHealthy: true
  });
  if (policy.source_absence_actions_allowed !== false) throw new Error("hides must not auto-enable");
  if (policy.required_consecutive_healthy_absences !== 2) throw new Error("confirmation policy changed");
  const weekly = health.evaluateRoyalCaribbeanWeeklyHealth({
    sourceRuntimeOk: true,
    enumerationHealth: { royal_caribbean_source_enumeration_ok: true },
    reconciliationArithmeticOk: true,
    shipResolutionOk: true,
    embarkationResolutionOk: true,
    newEligibleCount: 2,
    sourceAbsencePolicy: policy,
    cutoffCandidateCount: 157,
    performWrites: true
  });
  if (weekly.planned_rcl_material_writes !== 2) throw new Error(String(weekly.planned_rcl_material_writes));
  if (weekly.weekly_change_volume_exceeded) throw new Error("eligible absence must not inflate the ceiling");
});

test("scheduled apply commissions when weekly flag is on even if CONTEXT is unset", () => {
  const event = dispatch.scheduledEvent({
    headers: { "x-netlify-event": "schedule" },
    body: JSON.stringify({ next_run: "2026-09-22T17:00:00.000Z" })
  });
  const env = { ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED: "true" };
  if (dispatch.resolveDryRun({}, event, env) !== false) {
    throw new Error("commissioned scheduled apply must not stay dry-run merely because CONTEXT is unset");
  }
  if (dispatch.resolveDryRun({}, event, { CONTEXT: "deploy-preview", ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED: "true" }) !== true) {
    throw new Error("preview must remain dry-run");
  }
});

test("21-day cutoff and timetable unchanged", () => {
  if (inventory.PUBLIC_BOOKING_CUTOFF_DAYS !== 21) throw new Error("cutoff changed");
  if (maintenance.MAINTENANCE_SCHEDULES.daily_expiry.cron_utc !== "30 22 * * *") {
    throw new Error(maintenance.MAINTENANCE_SCHEDULES.daily_expiry.cron_utc);
  }
  const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
  if (!toml.includes('schedule = "0 17 * * 2"')) throw new Error("Royal Wednesday cron moved");
  if (!toml.includes('schedule = "0 19 * * 2"')) throw new Error("NCL Wednesday cron moved");
});

test("NCL staged row keeps existing UUID on promotion classification", () => {
  const row = {
    id: "keep-uuid",
    official_sailing_id: "PRIMA3CIVPMIBCN|2027-05-04",
    status: "match_required",
    ship_id: "ship-1",
    departure_date: "2027-05-04",
    return_date: "2027-05-07",
    nights: 3,
    departure_port: "Civitavecchia",
    destination_id: "dest-1",
    itinerary_ports: ["Civitavecchia", "Palma", "Barcelona"],
    raw_extract: { ncl_enrichment_status: "enrichment_ready" }
  };
  const classified = staging.classifyNorwegianP3iStagingRow(row, {
    today: "2026-09-17",
    sourceEligible: [row],
    productionRows: [row]
  });
  if (classified.existing_uuid !== "keep-uuid") throw new Error("UUID replaced");
  if (classified.classification !== "READY_TO_PROMOTE") throw new Error(classified.classification);
});

test("NCL match_required dedupe and legacy IDs stay unmatched", () => {
  const existing = {
    id: "old-mr",
    official_sailing_id: "NCL-OLD",
    status: "match_required",
    ship_id: "s",
    departure_date: "2027-01-10",
    return_date: "2027-01-17",
    nights: 7,
    departure_port: "Miami"
  };
  const active = { ...existing, id: "active-1", status: "active" };
  const dupe = staging.classifyNorwegianP3iStagingRow(existing, {
    today: "2026-09-17",
    sourceEligible: [existing],
    productionRows: [existing, active]
  });
  if (dupe.classification !== "DUPLICATE_ACTIVE") throw new Error(dupe.classification);
  const legacy = staging.classifyNorwegianP3iStagingRow(
    { id: "legacy-1", status: "match_required", raw_extract: { source: "legacy" } },
    { today: "2026-09-17", sourceEligible: [], productionRows: [] }
  );
  if (legacy.classification !== "LEGACY_NO_OFFICIAL_ID") throw new Error(legacy.classification);
  const p3b = nclIdentity.classifyNorwegianP3bCandidate(
    { official_sailing_id: "NCL-OLD", ship_id: "s", departure_date: "2027-01-10", return_date: "2027-01-17", nights: 7, departure_port: "Miami" },
    [existing]
  );
  if (p3b.classification === "TRUE_NEW") throw new Error("must not reinsert match_required");
});

test("parser/resolver repairs remain on the catalogue path", () => {
  const adapterSrc = fs.readFileSync(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter.js"), "utf8");
  const sourceSrc = fs.readFileSync(path.join(root, "netlify/functions/lib/norwegian-discovery-source.js"), "utf8");
  if (!adapterSrc.includes("inferNorwegianShipCodeFromItinerary")) throw new Error("adapter ship infer missing");
  if (!sourceSrc.includes("inferNorwegianShipCodeFromItinerary")) throw new Error("catalogue ship infer missing");
  if (typeof nclAdapter.inferNorwegianShipCodeFromItinerary !== "function") throw new Error("export");
});

test("central ledger trigger_type manual_catchup is not scheduled", () => {
  const tracking = fs.readFileSync(
    path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking.js"),
    "utf8"
  );
  if (!tracking.includes("trigger_type: triggerType")) throw new Error("trigger type not persisted");
  const enrichment = nclAudit.assertExistingUuidPreserved({ id: "abc" }, { id: "abc" });
  if (enrichment !== true) throw new Error("uuid preserve helper");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const row of failures) console.error(`- ${row.name}: ${row.error}`);
  process.exit(1);
}
process.exit(0);
