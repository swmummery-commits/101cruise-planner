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

/* H3. stale catch-up embark mismatch is not identity-critical when evidence agrees */
const pr261002Existing = {
  official_sailing_id: "PR261002-014",
  departure_port: "Incheon",
  departure_date: "2026-10-02",
  return_date: "2026-10-16",
  nights: 14,
  ship_id: "ship-a",
  itinerary: null,
  status: "active",
  raw_extract: {
    title: "JAPAN INTENSIVE CRUISE: TOKYO, KOBE & NAGASAKI",
    description:
      "Explore this Japan Intensive Cruise: Tokyo, Kobe & Nagasaki sailing from TOKYO to SEOUL (INCHEON) on Oct 2 2026"
  }
};
const pr261002Candidate = {
  departure_port: "Tokyo",
  departure_port_meta: { canonicalPortName: "Tokyo", canonicalPortId: "port-tokyo", status: "resolved", confidence: "exact" },
  departure_date: "2026-10-02",
  return_date: "2026-10-16",
  nights: 14,
  ship_id: "ship-a",
  itinerary: null,
  status: "active",
  raw_extract: pr261002Existing.raw_extract
};
const pr261002Risk = weeklyPolicy.classifyAzamaraUpdateRisk(pr261002Existing, pr261002Candidate);
assert(pr261002Risk.risk !== "identity_critical", "PR261002 stale Incheon field is not identity-critical");
assert(
  weeklyPolicy.refineProposedActionForWeekly("update_official_match", pr261002Existing, pr261002Candidate) ===
    "duplicate_skip",
  "PR261002 stale embark mismatch is recognised unchanged pending field refresh batch"
);

/* H4. package-code date mismatch treated as stale refresh not identity review */
const qsExisting = {
  official_sailing_id: "QS261031-007",
  departure_port: "Piraeus",
  departure_date: "2026-10-30",
  return_date: "2026-11-14",
  nights: 15,
  ship_id: "ship-b",
  itinerary: null,
  status: "active",
  raw_extract: {
    description:
      "Explore this Best Of The Mediterranean Cruise sailing from ATHENS (PIRAEUS) to ROME (CIVITAVECCHIA) on Oct 31 2026"
  }
};
const qsCandidate = {
  departure_port: "Piraeus",
  departure_port_meta: {
    canonicalPortName: "Piraeus",
    canonicalPortId: "port-csv-240",
    status: "resolved",
    confidence: "exact"
  },
  departure_date: "2026-10-31",
  return_date: "2026-11-15",
  nights: 15,
  ship_id: "ship-b",
  itinerary: null,
  status: "active",
  raw_extract: qsExisting.raw_extract
};
const qsRisk = weeklyPolicy.classifyAzamaraUpdateRisk(qsExisting, qsCandidate);
assert(!qsRisk.identity_critical_changes.includes("departure_date"), "QS261031 package date corroboration avoids date review");
assert(
  weeklyPolicy.refineProposedActionForWeekly("update_official_match", qsExisting, qsCandidate) ===
    "duplicate_skip",
  "QS261031 stale date mismatch is recognised unchanged pending field refresh batch"
);

/* H5. genuine live source change still requires review */
const genuineExisting = {
  official_sailing_id: "JR270707-013",
  departure_port: "Portsmouth",
  departure_date: "2027-07-07",
  return_date: "2027-07-20",
  nights: 13,
  ship_id: "ship-c",
  itinerary: "British Isles",
  status: "active",
  raw_extract: {
    description: "Explore this British Isles Cruise sailing from PORTSMOUTH to DUBLIN on Jul 7 2027"
  }
};
const genuineCandidate = {
  departure_port: "Dublin",
  departure_port_meta: { canonicalPortName: "Dublin", canonicalPortId: "port-dub", status: "resolved", confidence: "exact" },
  departure_date: "2027-07-07",
  return_date: "2027-07-20",
  nights: 13,
  ship_id: "ship-c",
  itinerary: "British Isles",
  status: "active",
  raw_extract: {
    description: "Explore this British Isles Cruise sailing from DUBLIN to EDINBURGH on Jul 7 2027"
  }
};
const genuineRisk = weeklyPolicy.classifyAzamaraUpdateRisk(genuineExisting, genuineCandidate);
assert(genuineRisk.risk === "identity_critical", "live source embark change remains identity-critical");
assert(
  weeklyPolicy.refineProposedActionForWeekly("update_official_match", genuineExisting, genuineCandidate) ===
    "update_identity_review_required",
  "genuine embark change stays in review"
);

/* H6. safe metadata patch includes allowlisted fields only */
const { buildAzamaraSafeUpdatePatch } = require(path.join(root, "netlify/functions/lib/azamara-discovery-writes"));
const safePatch = buildAzamaraSafeUpdatePatch(
  { official_url: "https://old", raw_extract: { title: "Old" }, departure_port: "Tokyo" },
  { official_url: "https://new", raw_extract: { title: "New", description: "Updated" }, departure_port: "Osaka" }
);
assert(safePatch.official_url === "https://new", "safe patch updates official_url");
assert(safePatch.raw_extract.title === "New", "safe patch updates raw_extract");
assert(safePatch.raw_extract.azamara_weekly_safe_update === true, "safe patch marks weekly metadata update");
assert(!("departure_port" in safePatch), "safe patch must not include identity fields");

/* H7–H16. deterministic safe-metadata idempotency */
const safeMeta = require(path.join(root, "netlify/functions/lib/azamara-weekly-safe-metadata"));
const stableBase = {
  title: "Japan Intensive",
  description: "Explore this cruise sailing from TOKYO to SEOUL",
  azamara_package_code: "PR261002-014",
  azamara_product_type: "ocean",
  structured_source: "azamara_official_sitemap",
  departure_port_meta: {
    rawValue: "TOKYO",
    canonicalPortId: "port-csv-199",
    canonicalPortName: "Tokyo",
    confidence: "exact",
    status: "resolved",
    sourceField: "description.route_pair"
  }
};
assert(
  safeMeta.azamaraStableRawExtractEquivalent(stableBase, { ...stableBase }),
  "exact same stable metadata is equivalent"
);
assert(
  safeMeta.azamaraStableRawExtractEquivalent(stableBase, {
    ...stableBase,
    azamara_weekly_run_id: "run-a",
    azamara_last_verified_at: "2026-08-17T01:00:00.000Z"
  }),
  "run id / verification timestamp volatility ignored"
);
assert(
  safeMeta.azamaraStableRawExtractEquivalent(stableBase, {
    ...stableBase,
    fetched_at: "2026-08-17T02:00:00.000Z",
    excerpt_chars: 999
  }),
  "fetch diagnostics ignored"
);
assert(
  safeMeta.azamaraStableRawExtractEquivalent(
    { b: 2, a: 1, title: "X" },
    { a: 1, b: 2, title: "X" }
  ),
  "JSON key ordering ignored"
);
assert(
  !safeMeta.azamaraStableRawExtractEquivalent(stableBase, {
    ...stableBase,
    description: "Different route text"
  }),
  "semantic description change detected"
);
const mergedRaw = safeMeta.mergeAzamaraStableRawExtract(
  { title: "Old", azamara_catchup_batch: "batch-1" },
  stableBase
);
const postApplyRisk = weeklyPolicy.classifyAzamaraUpdateRisk(
  { official_url: "https://example", raw_extract: mergedRaw, departure_port: "Tokyo" },
  { official_url: "https://example", raw_extract: { ...stableBase, azamara_weekly_run_id: "fresh-run" }, departure_port: "Tokyo" }
);
assert(
  postApplyRisk.safe_metadata_changes.length === 0,
  "successful safe metadata merge followed by identical source proposes no update"
);

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
