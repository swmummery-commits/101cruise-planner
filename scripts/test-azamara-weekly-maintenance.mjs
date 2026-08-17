#!/usr/bin/env node
/**
 * Azamara weekly maintenance unit tests (mocked — no network or production writes).
 * Run: npm run test:azamara-weekly-maintenance
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const weeklyManifest = require(path.join(root, "netlify/functions/lib/azamara-weekly-manifest"));
const mode = require(path.join(root, "netlify/functions/lib/azamara-discovery-mode"));
const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const locks = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const writes = require(path.join(root, "netlify/functions/lib/azamara-discovery-writes"));
const adapter = require(path.join(root, "netlify/functions/lib/azamara-discovery-adapter"));
const weeklyPolicy = require(path.join(root, "netlify/functions/lib/azamara-weekly-update-policy"));
const weeklyAuth = require(path.join(root, "netlify/functions/lib/azamara-weekly-auth"));
const sourceAbsence = require(path.join(root, "netlify/functions/lib/azamara-source-absence"));
const dispatch = require(path.join(root, "netlify/functions/lib/azamara-weekly-maintenance-dispatch"));
const inventory = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

const TODAY = "2026-08-16";
const AZAMARA_LINE_SLUG = "azamara";

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

/* A. source absence without complete snapshot rejected */
const incompleteManifest = {
  source_complete: false,
  source_absence_hides: [
    {
      discovered_cruise_id: "dc-1",
      official_sailing_id: "JR270707-013",
      proposed_action: "hide_source_absent"
    }
  ],
  inserts: [],
  updates: [],
  cutoff_hides: []
};
const incompleteValidation = weeklyManifest.validateAzamaraWeeklyManifest(incompleteManifest);
assert(incompleteValidation.passed === false, "validateAzamaraWeeklyManifest rejects incomplete snapshot source absence");
assert(
  incompleteValidation.failures.includes("source_absence_without_complete_snapshot"),
  "source absence without complete snapshot failure recorded"
);

/* B. source absence allowed when snapshot complete */
const completeManifest = {
  source_complete: true,
  source_absence_hides: incompleteManifest.source_absence_hides,
  inserts: [],
  updates: [],
  cutoff_hides: [],
  write_safety: { ok: true, failures: [] }
};
const completeValidation = weeklyManifest.validateAzamaraWeeklyManifest(completeManifest);
assert(completeValidation.passed === true, "source absence allowed when snapshot is complete");

/* C. weekly write mode requires AZAMARA_DISCOVERY_WRITE_ENABLED */
const prevFlag = process.env.AZAMARA_DISCOVERY_WRITE_ENABLED;
process.env.AZAMARA_DISCOVERY_WRITE_ENABLED = "false";
assert(
  mode.resolveAzamaraDiscoveryMode("weekly_maintenance").writes_allowed === false,
  "weekly_maintenance requires write flag when disabled"
);
process.env.AZAMARA_DISCOVERY_WRITE_ENABLED = "true";
assert(
  mode.resolveAzamaraDiscoveryMode("weekly_maintenance").writes_allowed === true,
  "weekly_maintenance writes allowed when flag enabled"
);
process.env.AZAMARA_DISCOVERY_WRITE_ENABLED = prevFlag;

/* D. schedule registered */
const schedule = maintenance.MAINTENANCE_SCHEDULES.azamara_weekly;
assert(schedule, "MAINTENANCE_SCHEDULES includes azamara_weekly");
assert(schedule.cron_utc === "0 3 * * 1", "azamara_weekly scheduled Monday 03:00 UTC");
assert(schedule.function === "azamara-weekly-maintenance-cron", "azamara weekly cron function wired");
assert(schedule.schedule_registered === true, "azamara weekly schedule registered");

/* E. lock key */
const lockKey = locks.weeklyLockKey(AZAMARA_LINE_SLUG);
assert(lockKey === "azamara:weekly", "weeklyLockKey for azamara");
assert(locks.DEFAULT_LEASE_SECONDS[lockKey] === 900, "azamara weekly lock lease is 900 seconds");

/* F. legacy generic excluded from source-absent candidates */
const sourceEligibleIds = new Set(["JR270707-013"]);
const legacyGenericRow = {
  id: "legacy-generic-1",
  official_sailing_id: null,
  status: "active",
  departure_date: null,
  official_url: "https://www.azamara.com/destinations/alaska",
  raw_extract: { structured_source: "manual_import" }
};
const officialAbsentRow = {
  id: "official-absent-1",
  official_sailing_id: "PR270705-014",
  status: "active",
  departure_date: "2026-12-01",
  raw_extract: { azamara_package_code: "PR270705-014", structured_source: "azamara_official_sitemap" }
};
const officialPresentRow = {
  id: "official-present-1",
  official_sailing_id: "JR270707-013",
  status: "active",
  departure_date: "2026-12-01",
  raw_extract: { azamara_package_code: "JR270707-013" }
};

const sourceAbsentCandidates = [legacyGenericRow, officialAbsentRow, officialPresentRow].filter(
  (row) =>
    adapter.isOfficialAzamaraRecord(row) &&
    row.status === "active" &&
    row.official_sailing_id &&
    !sourceEligibleIds.has(String(row.official_sailing_id).toUpperCase()) &&
    !inventory.shouldRemoveFromPublicInventory({ departureDate: row.departure_date, perthToday: TODAY })
);

assert(adapter.isLegacyGenericAzamaraRow(legacyGenericRow), "legacy generic fixture identified");
assert(sourceAbsentCandidates.length === 1, "only one official structured absent row remains");
assert(
  sourceAbsentCandidates[0].official_sailing_id === "PR270705-014",
  "legacy generic row excluded from weekly source-absent candidates"
);

/* G. identity-critical ship change requires review */
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
const candidateShipChange = { ...existing, ship_id: "ship-b" };
const refinedIdentity = weeklyPolicy.refineProposedActionForWeekly(
  "update_official_match",
  existing,
  candidateShipChange
);
assert(refinedIdentity === "update_identity_review_required", "identity-critical ship change blocked weekly");

/* H. safe metadata URL-only change allowed */
const candidateUrlChange = { ...existing, official_url: "https://example.com/b" };
const refinedSafe = weeklyPolicy.refineProposedActionForWeekly(
  "update_official_match",
  existing,
  candidateUrlChange
);
assert(refinedSafe === "update_safe_metadata_allowed", "safe metadata URL change allowed weekly");

/* H2. identity review does not fail dry-run manifest validation */
const identityReviewManifest = {
  source_complete: true,
  inserts: [],
  updates: [],
  identity_review: [{ official_sailing_id: "JR270707-013" }],
  cutoff_hides: [],
  write_safety: {
    ok: false,
    failures: ["identity_critical_updates_require_review"]
  }
};
const identityReviewValidation = weeklyManifest.validateAzamaraWeeklyManifest(identityReviewManifest);
assert(identityReviewValidation.passed === true, "identity review pending does not fail dry-run manifest validation");

/* I. actionable source absence blocks weekly writes (Seabourn policy) */
const blockedSafety = weeklyPolicy.assessAzamaraWeeklyWriteSafety({
  sourceAbsencePolicy: { source_absent_observed: 2, source_absent_actionable: 1 },
  performWrites: true,
  proposedIdentityReviewUpdates: 0
});
assert(!blockedSafety.ok, "actionable absence must block writes");
assert(
  blockedSafety.failures.includes("source_absent_actionable_blocks_weekly_writes"),
  "actionable absence failure recorded"
);

/* J. observed-only source absence permits dry-run safety */
const observedSafety = weeklyPolicy.assessAzamaraWeeklyWriteSafety({
  sourceAbsencePolicy: { source_absent_observed: 3, source_absent_actionable: 0 },
  performWrites: false,
  proposedIdentityReviewUpdates: 0
});
assert(observedSafety.ok, "observed-only absence ok for dry-run");

/* K. consecutive absence classification */
const firstAbsence = sourceAbsence.classifyAzamaraSourceAbsence({
  currentAbsentRows: [{ id: "dc-1", official_sailing_id: "PR270705-014", departure_date: "2027-02-01" }],
  previousAbsentSailingIds: [],
  enumerationHealthy: true,
  sourceComplete: true
});
assert(firstAbsence.source_absent_observed === 1, "first absence observed only");
assert(firstAbsence.source_absent_actionable === 0, "first absence not actionable");

const secondAbsence = sourceAbsence.classifyAzamaraSourceAbsence({
  currentAbsentRows: [{ id: "dc-1", official_sailing_id: "PR270705-014", departure_date: "2027-02-01" }],
  previousAbsentSailingIds: ["PR270705-014"],
  enumerationHealthy: true,
  sourceComplete: true
});
assert(secondAbsence.source_absent_actionable === 1, "second consecutive absence actionable");

/* L. weekly caps */
assert(weeklyManifest.AZAMARA_MAX_WEEKLY_WRITES === 50, "max weekly writes is 50");
assert(weeklyManifest.AZAMARA_MAX_WEEKLY_UPDATES === 10, "max weekly updates is 10");
const overCapManifest = {
  source_complete: true,
  inserts: Array.from({ length: 41 }, (_, i) => ({ official_sailing_id: `INS${i}` })),
  updates: Array.from({ length: 10 }, (_, i) => ({ official_sailing_id: `UPD${i}` })),
  cutoff_hides: [],
  write_safety: { ok: true, failures: [] }
};
const overCapValidation = weeklyManifest.validateAzamaraWeeklyManifest(overCapManifest);
assert(!overCapValidation.passed, "51 combined writes rejected");
assert(overCapValidation.failures.includes("weekly_write_cap_exceeded"), "weekly_write_cap_exceeded recorded");

/* M. dry-run default when reconciliation disabled */
assert(dispatch.resolveDryRun({}) === true, "dispatch defaults to dry-run when flag disabled");

/* N. cron auth rejects missing secret */
let authFailed = false;
try {
  weeklyAuth.assertCronAuth({ headers: {} }, { DISCOVERY_CRON_SECRET: "expected-secret" });
} catch (e) {
  authFailed = e.code === "unauthorized";
}
assert(authFailed, "missing cron secret rejected");

/* O. forged schedule without next_run rejected */
let scheduleForged = false;
try {
  weeklyAuth.assertAzamaraWeeklyAuth(
    { headers: { "x-netlify-event": "schedule" }, body: "{}" },
    { DISCOVERY_CRON_SECRET: "expected-secret" }
  );
} catch (e) {
  scheduleForged = e.code === "unauthorized";
}
assert(scheduleForged, "header-only schedule spoof rejected");

/* P. netlify.toml wiring */
const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
assert(toml.includes('[functions."azamara-weekly-maintenance-cron"]'), "netlify.toml cron function present");
assert(toml.includes('schedule = "0 3 * * 1"'), "netlify.toml azamara schedule present");
assert(toml.includes('[functions."azamara-weekly-maintenance-background"]'), "netlify.toml background function present");

/* Q. cron dispatches background worker */
const cronSrc = fs.readFileSync(path.join(root, "netlify/functions/azamara-weekly-maintenance-cron.js"), "utf8");
assert(cronSrc.includes("dispatchAzamaraWeeklyBackground"), "cron dispatches background worker");
assert(!cronSrc.includes("catchup"), "cron must not invoke catch-up");

/* R. background requires secret always */
const bgSrc = fs.readFileSync(path.join(root, "netlify/functions/azamara-weekly-maintenance-background.js"), "utf8");
assert(bgSrc.includes("assertCronAuth"), "background requires cron secret");
assert(!bgSrc.includes("isScheduledInvocation"), "background must not bypass auth via schedule header");

/* S. bulk import flag listed as must-stay-false until controlled import */
const flags = maintenance.describeMaintenanceHold();
assert(
  flags.bulk_import_flags_must_remain_false.includes("AZAMARA_DISCOVERY_WRITE_ENABLED"),
  "AZAMARA_DISCOVERY_WRITE_ENABLED listed in bulk import hold"
);

console.log(`azamara-weekly-maintenance tests passed: ${passed}`);
