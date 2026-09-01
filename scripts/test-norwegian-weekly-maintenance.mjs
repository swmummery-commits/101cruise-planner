#!/usr/bin/env node
/**
 * Norwegian weekly maintenance + Phase 13 publication unit tests.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  assessPublicationEligibility,
  buildPublicationStagePlan,
  daysUntilDeparture,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require(path.join(root, "netlify/functions/lib/norwegian-maintenance-shared"));
const { buildPublicationManifest, evaluatePublicationDryRunGate } = require(
  path.join(root, "netlify/functions/lib/norwegian-publication-manifest")
);
const { buildNorwegianWeeklyManifest, validateNorwegianWeeklyManifest } = require(
  path.join(root, "netlify/functions/lib/norwegian-weekly-manifest")
);
const { classifyNorwegianSourceAbsence } = require(path.join(root, "netlify/functions/lib/norwegian-source-absence"));
const { isCruisePubliclyBookable } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

const today = "2026-08-14";
assert(isCruisePubliclyBookable({ departureDate: "2026-09-05", status: "active", perthToday: today }) === true, "22+ days eligible");
assert(isCruisePubliclyBookable({ departureDate: "2026-09-04", status: "active", perthToday: today }) === false, "21 days hidden");
assert(isCruisePubliclyBookable({ departureDate: "2026-09-03", status: "active", perthToday: today }) === false, "20 days hidden");
assert(isCruisePubliclyBookable({ departureDate: "2026-08-01", status: "active", perthToday: today }) === false, "departed hidden");
assert(isCruisePubliclyBookable({ departureDate: "2026-12-01", status: "match_required", perthToday: today }) === false, "match_required not public");

const eligibleRow = {
  id: "r1",
  status: "match_required",
  official_sailing_id: "GETAWAY2MIANPIMIA|2026-12-01",
  destination_id: "dest-1",
  departure_date: "2026-12-01",
  raw_extract: { ncl_enrichment_status: "enrichment_ready" },
  itinerary_ports: [{ port: "Miami" }]
};
const assessment = assessPublicationEligibility(eligibleRow, {
  today,
  sourceEligibleOfficialIds: new Set(["GETAWAY2MIANPIMIA|2026-12-01"])
});
assert(assessment.eligible === true, "eligible publication row");

const cutoffRow = { ...eligibleRow, departure_date: "2026-09-03" };
const cutoffAssessment = assessPublicationEligibility(cutoffRow, {
  today,
  sourceEligibleOfficialIds: new Set([cutoffRow.official_sailing_id])
});
assert(cutoffAssessment.eligible === false, "within cutoff excluded");
assert(cutoffAssessment.exclusions.includes("within_cutoff"), "cutoff reason");

const manifest = buildPublicationManifest({
  productionRows: [eligibleRow, cutoffRow],
  sourceEligibleOfficialIds: new Set([eligibleRow.official_sailing_id, cutoffRow.official_sailing_id]),
  today
});
assert(manifest.publication_target === 1, "publication target excludes cutoff");
const gate = evaluatePublicationDryRunGate(manifest);
assert(gate.passed === true, "publication dry-run gate passes");

const stages = buildPublicationStagePlan(100);
assert(stages[0].newWrites === 1, "stage1 single canary");
assert(stages[stages.length - 1].cumulative === 100, "stage plan reaches target");

const weeklyManifest = {
  promotions: [{ official_sailing_id: "A", days_until_departure: 30 }],
  inserts: [{ proposed_action: "insert_match_required", proposed_status: "match_required", official_sailing_id: "B" }],
  cutoff_hides: [],
  source_absence_hides: []
};
assert(validateNorwegianWeeklyManifest(weeklyManifest).passed === true, "weekly manifest valid");
assert(
  validateNorwegianWeeklyManifest({
    promotions: [{ official_sailing_id: "A", days_until_departure: 10 }],
    inserts: []
  }).passed === false,
  "weekly promotion cutoff rejected"
);

const absence = classifyNorwegianSourceAbsence({
  currentAbsentRows: [{ official_sailing_id: "MISSING1", discovered_cruise_id: "x" }],
  previousAbsentSailingIds: [],
  enumerationHealthy: true
});
assert(absence.hard_deletes_voyages === false, "source absence no hard delete");
assert(absence.source_absent_observed === 1, "first absence observed only");

const fs = require("fs");
const accounting = require(path.join(root, "netlify/functions/lib/weekly-maintenance-write-accounting"));
const tracking = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));

const nested = accounting.mergeFlattenedWriteStats({
  line_slug: "norwegian-cruise-line",
  proposed_inserts: 40,
  writes_performed: { inserted: 40, enriched: 0, promoted_active: 0, failed: 1, cutoff_hidden: 0, source_absence_hidden: 0 },
  staged_match_required_inserts: 40
});
assert(nested.inserts === 40, "nested apply inserts flatten onto summary.inserts");
assert(nested.inventory_changed === true, "committed inserts mark inventory_changed");
const failedStats = tracking.buildMaintenanceRunStats(nested, { inventory_changed: false });
assert(failedStats.inserts === 40, "later failure extra must not erase committed inserts");
assert(failedStats.inventory_changed === true, "committed writes keep inventory_changed");
assert(
  accounting.resolveWeeklyTerminalStatus({ ok: false, summary: nested }) === "partial_write_failure",
  "partial NCL run is partial_write_failure not zero-write"
);

assert(
  isCruisePubliclyBookable({ departureDate: "2028-07-16", status: "match_required", perthToday: "2026-09-01" }) === false,
  "staged NCL match_required remains non-public"
);
assert(
  assessPublicationEligibility(
    { ...eligibleRow, raw_extract: {} },
    { today, sourceEligibleOfficialIds: new Set([eligibleRow.official_sailing_id]) }
  ).eligible === false,
  "promotion requires enrichment_ready"
);

const applySrc = fs.readFileSync(path.join(root, "netlify/functions/lib/norwegian-weekly-apply.js"), "utf8");
assert(
  applySrc.includes("new Map(newRows.map((r) => [r.official_sailing_id, r]))"),
  "weekly enrichment looks up DB rows by official_sailing_id"
);
assert(!applySrc.includes("[r.id, r]"), "weekly enrichment must not key enrichment map by UUID");
const sharedSrc = fs.readFileSync(path.join(root, "netlify/functions/lib/norwegian-maintenance-shared.js"), "utf8");
assert(!/assertGlobalCruiseWriteLockHeld\(options\)/.test(sharedSrc), "promote/hide must not reference undefined options");

console.log(`Norwegian weekly maintenance tests: ${passed}/${passed} PASS`);
