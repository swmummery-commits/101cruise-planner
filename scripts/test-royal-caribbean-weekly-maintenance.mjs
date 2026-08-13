#!/usr/bin/env node
/**
 * Royal Caribbean weekly maintenance behaviour tests — fixtures only, no production writes.
 *
 *   npm run test:royal-caribbean-weekly-maintenance
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const weekly = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance"));
const source = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-source"));
const absence = require(path.join(root, "netlify/functions/lib/royal-caribbean-source-absence"));
const updates = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-updates"));
const health = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-health"));
const reconciliation = require(path.join(root, "netlify/functions/lib/royal-caribbean-reconciliation-summary"));
const inventory = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const enumeration = require(path.join(root, "netlify/functions/lib/royal-caribbean-source-enumeration"));

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

test("weekly maintenance exports authoritative union page sizes", () => {
  if (!Array.isArray(weekly.AUTHORITATIVE_UNION_PAGE_SIZES)) throw new Error("missing page sizes");
  if (JSON.stringify(weekly.AUTHORITATIVE_UNION_PAGE_SIZES) !== JSON.stringify([25, 50, 100])) {
    throw new Error("unexpected union page sizes");
  }
});

test("fetchAllRoyalCaribbeanRawSailings accepts authoritativeEnumeration option", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-source.js"), "utf8");
  if (!src.includes("authoritativeEnumeration === true")) throw new Error("authoritative flag missing");
  if (!src.includes("enumerateMultiPageSizeUnion")) throw new Error("union enumeration missing");
});

test("weekly maintenance module wires authoritative enumeration by default", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance.js"), "utf8");
  if (!src.includes("authoritativeEnumeration: context.authoritativeEnumeration !== false")) {
    throw new Error("weekly path must default to authoritative enumeration");
  }
});

test("enumeration unhealthy blocks dry-run health", () => {
  const result = reconciliation.evaluateRoyalCaribbeanDryRunHealth({
    simulation: { ok: true, products: [{ official_sailing_id: "A" }], pagination: {} },
    arithmetic: { reconciliation_arithmetic_ok: true },
    manifest: { products: [] },
    actualWrites: 0,
    enumerationHealth: { royal_caribbean_source_enumeration_ok: false }
  });
  if (result.passed) throw new Error("expected failure when enumeration unhealthy");
  if (!result.failures.includes("source_enumeration_unhealthy")) throw new Error("missing enumeration failure");
});

test("valid new eligible maps to insert_active in classifyProposedAction", () => {
  const writes = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-writes"));
  const row = {
    product_type: "ocean_cruise",
    status_class: "open",
    time_eligibility: "eligible",
    complete_high_confidence: true,
    raw: { official_sailing_id: "OA07W123_2027-01-01" }
  };
  const action = writes.classifyProposedAction(row, null);
  if (action !== "insert_active") throw new Error(`expected insert_active got ${action}`);
});

test("existing official ID is duplicate_skip not insert", () => {
  const writes = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-writes"));
  const row = {
    product_type: "ocean_cruise",
    status_class: "open",
    time_eligibility: "eligible",
    complete_high_confidence: true,
    raw: { official_sailing_id: "OA07W123_2027-01-01" },
    candidate: {
      ship_id: "ship-1",
      destination_id: "dest-1",
      departure_date: "2027-01-01",
      return_date: "2027-01-08",
      nights: 7,
      departure_port: "Miami"
    }
  };
  const existing = {
    cruise_line_id: "line-1",
    official_sailing_id: "OA07W123_2027-01-01",
    ship_id: "ship-1",
    destination_id: "dest-1",
    departure_date: "2027-01-01",
    return_date: "2027-01-08",
    nights: 7,
    departure_port: "Miami",
    status: "active"
  };
  const action = writes.classifyProposedAction(row, existing);
  if (action !== "duplicate_skip") throw new Error(`expected duplicate_skip got ${action}`);
});

test("22 days until departure is publicly eligible", () => {
  const today = "2026-08-13";
  const dep = inventory.addCalendarDays(today, 22);
  const ok = inventory.isCruisePubliclyBookable({ departureDate: dep, status: "active", perthToday: today });
  if (!ok) throw new Error("22 days should remain eligible");
});

test("21 days until departure is hide candidate not delete", () => {
  const today = "2026-08-13";
  const dep21 = inventory.addCalendarDays(today, 21);
  const dep20 = inventory.addCalendarDays(today, 20);
  if (inventory.isCruisePubliclyBookable({ departureDate: dep21, status: "active", perthToday: today })) {
    throw new Error("21 days should not be publicly bookable");
  }
  if (inventory.isCruisePubliclyBookable({ departureDate: dep20, status: "active", perthToday: today })) {
    throw new Error("20 days should not be publicly bookable");
  }
  const hide = inventory.shouldRemoveFromPublicInventory({ departureDate: dep21, status: "active", perthToday: today });
  if (!hide) throw new Error("21-day candidate should be hide candidate");
});

test("first healthy source absence is candidate only", () => {
  const policy = absence.classifyRoyalCaribbeanSourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "OA07W123_2027-02-01", departure_date: "2027-02-01" }],
    previousAbsentSailingIds: [],
    enumerationHealthy: true
  });
  if (policy.source_absent_candidate_count !== 1) throw new Error("expected one candidate");
  if (policy.source_absent_action_eligible_count !== 0) throw new Error("first absence must not be action eligible");
});

test("second consecutive healthy absence becomes action eligible structurally", () => {
  const policy = absence.classifyRoyalCaribbeanSourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "OA07W123_2027-02-01", departure_date: "2027-02-01" }],
    previousAbsentSailingIds: ["OA07W123_2027-02-01"],
    enumerationHealthy: true
  });
  if (policy.source_absent_action_eligible_count !== 1) throw new Error("expected action eligible");
  if (policy.source_absence_actions_allowed !== false) throw new Error("Prompt 8 still forbids automatic hide");
});

test("unhealthy enumeration disables source absence actions", () => {
  const policy = absence.classifyRoyalCaribbeanSourceAbsence({
    currentAbsentRows: [{ official_sailing_id: "OA07W123_2027-02-01" }],
    previousAbsentSailingIds: ["OA07W123_2027-02-01"],
    enumerationHealthy: false
  });
  if (policy.source_absence_actions_allowed !== false) throw new Error("unhealthy enumeration must block actions");
});

test("source reappearance clears absence state", () => {
  const policy = absence.classifyRoyalCaribbeanSourceAbsence({
    currentAbsentRows: [],
    previousAbsentSailingIds: ["OA07W123_2027-02-01"],
    enumerationHealthy: true
  });
  if (policy.source_absence_cleared_count !== 1) throw new Error("expected cleared absence");
});

test("identity mutation is forbidden", () => {
  if (updates.assertNoIdentityMutation("A", "B") !== false) throw new Error("different IDs must not mutate");
  if (updates.assertNoIdentityMutation("A", "A") !== true) throw new Error("same ID allowed");
});

test("allowlisted field difference becomes safe proposed update", () => {
  const analysis = updates.classifyRoyalCaribbeanWeeklyUpdates(
    [
      {
        proposed_action: "update_exact_legacy_match",
        stable_identity_key: "OA07W123_2027-01-01",
        candidate: { official_url: "https://example/new" }
      }
    ],
    new Map([
      [
        "OA07W123_2027-01-01",
        {
          official_sailing_id: "OA07W123_2027-01-01",
          official_url: "https://example/old"
        }
      ]
    ])
  );
  if (analysis.safe_proposed_updates.length !== 1) throw new Error("expected safe update");
});

test("identity-sensitive ship change requires review", () => {
  const analysis = updates.classifyRoyalCaribbeanWeeklyUpdates(
    [
      {
        proposed_action: "update_exact_legacy_match",
        stable_identity_key: "OA07W123_2027-01-01",
        candidate: { ship_id: "ship-2" }
      }
    ],
    new Map([
      [
        "OA07W123_2027-01-01",
        {
          official_sailing_id: "OA07W123_2027-01-01",
          ship_id: "ship-1"
        }
      ]
    ])
  );
  if (analysis.review_required_updates.length !== 1) throw new Error("ship change must require review");
});

test("healthy reconciliation arithmetic passes sample", () => {
  const ar = reconciliation.buildRoyalCaribbeanReconciliationArithmetic({
    uniqueSailings: 10,
    oceanCruises: 8,
    oceanCruisetours: 1,
    unknownProducts: 1,
    otherProductTypes: 0,
    oceanIncomplete: 1,
    oceanEligible: 5,
    oceanWithinCutoff: 1,
    oceanPast: 1,
    oceanUnfamiliarStatus: 0,
    oceanOtherExclusions: 0,
    recognisedExistingEligible: 4,
    outstandingEligibleInserts: 1,
    proposedUpdates: 0
  });
  if (!ar.reconciliation_arithmetic_ok) throw new Error("expected arithmetic ok");
});

test("deliberate lost classification fails arithmetic", () => {
  const ar = reconciliation.buildRoyalCaribbeanReconciliationArithmetic({
    uniqueSailings: 10,
    oceanCruises: 8,
    oceanCruisetours: 1,
    unknownProducts: 0,
    otherProductTypes: 0,
    oceanIncomplete: 1,
    oceanEligible: 5,
    oceanWithinCutoff: 1,
    oceanPast: 1,
    oceanUnfamiliarStatus: 0,
    oceanOtherExclusions: 0,
    recognisedExistingEligible: 4,
    outstandingEligibleInserts: 1,
    proposedUpdates: 0
  });
  if (ar.reconciliation_arithmetic_ok) throw new Error("expected arithmetic failure");
});

test("Netlify smoke path contains no DB mutation capability", () => {
  const src = fs.readFileSync(path.join(root, "netlify/functions/royal-caribbean-discovery-smoke.js"), "utf8");
  if (src.includes("supabase(") || src.includes("applyRoyalCaribbean")) {
    throw new Error("smoke must not include write paths");
  }
  if (!src.includes("writes_performed: false")) throw new Error("smoke must assert zero writes");
});

test("production ID absent from unhealthy global pass but present in union is not auto source-absent action", () => {
  const allowed = enumeration.sourceAbsenceActionAllowed({ royal_caribbean_source_enumeration_ok: false });
  if (allowed !== false) throw new Error("unhealthy enumeration must block source absence actions");
});

test("weekly health summary requires enumeration ok", () => {
  const summary = health.evaluateRoyalCaribbeanWeeklyHealth({
    sourceRuntimeOk: true,
    enumerationHealth: { royal_caribbean_source_enumeration_ok: false },
    reconciliationArithmeticOk: true,
    shipResolutionOk: true,
    embarkationResolutionOk: true
  });
  if (summary.weekly_maintenance_healthy) throw new Error("expected unhealthy weekly summary");
});

console.log(JSON.stringify({ passed, failed, failures }, null, 2));
process.exit(failed > 0 ? 1 : 0);
