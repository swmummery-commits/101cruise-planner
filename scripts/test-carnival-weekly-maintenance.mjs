#!/usr/bin/env node
/**
 * Carnival weekly maintenance unit tests (mocked — no network or production writes).
 * Run: node scripts/test-carnival-weekly-maintenance.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const weeklyManifest = require(path.join(root, "netlify/functions/lib/carnival-weekly-manifest"));
const mode = require(path.join(root, "netlify/functions/lib/carnival-discovery-mode"));
const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const locks = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const writes = require(path.join(root, "netlify/functions/lib/carnival-discovery-writes"));
const { SOURCE_ID } = require(path.join(root, "netlify/functions/lib/carnival-discovery-source"));
const inventory = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

const TODAY = "2026-08-15";
const CCL_LINE_SLUG = "carnival-cruise-line";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

const incompleteManifest = {
  source_complete: false,
  source_absence_hides: [
    {
      discovered_cruise_id: "dc-1",
      official_sailing_id: "999001",
      proposed_action: "hide_source_absent"
    }
  ],
  inserts: [],
  updates: [],
  cutoff_hides: []
};
const incompleteValidation = weeklyManifest.validateCclWeeklyManifest(incompleteManifest);
assert(incompleteValidation.passed === false, "validateCclWeeklyManifest rejects incomplete snapshot source absence");
assert(
  incompleteValidation.failures.includes("source_absence_without_complete_snapshot"),
  "source absence without complete snapshot failure recorded"
);

const completeManifest = {
  source_complete: true,
  source_absence_hides: incompleteManifest.source_absence_hides,
  inserts: [],
  updates: [],
  cutoff_hides: []
};
const completeValidation = weeklyManifest.validateCclWeeklyManifest(completeManifest);
assert(completeValidation.passed === true, "source absence allowed when snapshot is complete");

const prevFlag = process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED;
process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED = "false";
assert(
  mode.resolveCarnivalDiscoveryMode("weekly_maintenance").writes_allowed === false,
  "weekly_maintenance requires write flag when disabled"
);
process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED = "true";
assert(
  mode.resolveCarnivalDiscoveryMode("weekly_maintenance").writes_allowed === true,
  "weekly_maintenance writes allowed when flag enabled"
);
process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED = prevFlag;

const schedule = maintenance.MAINTENANCE_SCHEDULES.carnival_weekly;
assert(schedule, "MAINTENANCE_SCHEDULES includes carnival_weekly");
assert(schedule.cron_utc === "0 1 * * 1", "carnival_weekly scheduled Monday 01:00 UTC");
assert(schedule.function === "carnival-weekly-maintenance-cron", "carnival weekly cron function wired");
assert(schedule.schedule_registered === true, "carnival weekly schedule registered");

const lockKey = locks.weeklyLockKey(CCL_LINE_SLUG);
assert(lockKey === "carnival-cruise-line:weekly", "weeklyLockKey for carnival-cruise-line");
assert(locks.DEFAULT_LEASE_SECONDS[lockKey] === 900, "carnival weekly lock lease is 900 seconds");

const sourceEligibleIds = new Set(["888001"]);
const legacyGenericRow = {
  id: "legacy-generic-1",
  official_sailing_id: "LEGACY-123",
  status: "active",
  departure_date: "2026-12-01",
  raw_extract: { structured_source: "manual_import" }
};
const officialAbsentRow = {
  id: "official-absent-1",
  official_sailing_id: "777001",
  status: "active",
  departure_date: "2026-12-01",
  raw_extract: { structured_source: SOURCE_ID }
};
const officialPresentRow = {
  id: "official-present-1",
  official_sailing_id: "888001",
  status: "active",
  departure_date: "2026-12-01",
  raw_extract: { structured_source: SOURCE_ID }
};

const sourceAbsentCandidates = [legacyGenericRow, officialAbsentRow, officialPresentRow].filter(
  (row) =>
    writes.isOfficialCclStructuredRecord(row) &&
    row.status === "active" &&
    row.official_sailing_id &&
    !sourceEligibleIds.has(row.official_sailing_id) &&
    !inventory.shouldRemoveFromPublicInventory(row.departure_date, TODAY)
);

assert(writes.isLegacyGenericCclRow(legacyGenericRow), "legacy generic fixture identified");
assert(sourceAbsentCandidates.length === 1, "only one official structured absent row remains");
assert(
  sourceAbsentCandidates[0].official_sailing_id === "777001",
  "legacy generic row excluded from weekly source-absent candidates"
);
assert(
  !sourceAbsentCandidates.some((row) => row.id === "legacy-generic-1"),
  "legacy generic row not present in source-absent candidate list"
);

console.log(`carnival-weekly-maintenance tests passed: ${passed}`);
