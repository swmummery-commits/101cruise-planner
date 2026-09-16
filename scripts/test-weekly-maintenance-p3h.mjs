#!/usr/bin/env node
/**
 * P3H tests: RCL candidate-set stability, freeze, batch cap 30, NCL cutoff/idempotency.
 *
 *   npm run test:weekly-maintenance-p3h
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const royalPlan = require(path.join(root, "netlify/functions/lib/royal-caribbean-p3g-catchup-plan"));
const compare = require(path.join(root, "netlify/functions/lib/royal-caribbean-p3h-candidate-compare"));
const inventory = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const nclAudit = require(path.join(root, "netlify/functions/lib/norwegian-p3h-write-audit"));
const nclIdentity = require(path.join(root, "netlify/functions/lib/norwegian-voyage-identity-classifier"));
const nclAdapter = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));
const nclSource = require(path.join(root, "netlify/functions/lib/norwegian-discovery-source"));
const weeklyManifest = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-manifest"));

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

test("candidate-set comparison uses identities not totals", () => {
  const result = compare.compareRoyalCandidateSets(
    ["A_2027-01-01", "B_2027-02-01", "C_2027-03-01"],
    ["B_2027-02-01", "C_2027-03-01", "D_2027-04-01"]
  );
  if (result.wednesday_count !== 3 || result.fresh_count !== 3) throw new Error("counts");
  if (result.intersection.join() !== "B_2027-02-01,C_2027-03-01") throw new Error("intersection");
  if (result.wednesday_only.join() !== "A_2027-01-01") throw new Error("wednesday-only");
  if (result.fresh_only.join() !== "D_2027-04-01") throw new Error("fresh-only");
});

test("candidate delta classification covers required classes", () => {
  const departureById = new Map([
    ["AGED_2026-10-07", "2026-10-07"],
    ["NEW_2027-06-01", "2027-06-01"],
    ["GONE_2027-05-01", "2027-05-01"]
  ]);
  const ctx = {
    departureById,
    freshUnionIds: new Set(["NEW_2027-06-01", "KEEP_2027-01-01"]),
    wednesdayUnionIds: new Set(["GONE_2027-05-01", "KEEP_2027-01-01"]),
    wednesdayAsOf: "2026-09-15",
    freshAsOf: "2026-09-16"
  };
  const aged = compare.classifyRoyalCandidateDelta("AGED_2026-10-07", "wednesday_only", ctx);
  const gone = compare.classifyRoyalCandidateDelta("GONE_2027-05-01", "wednesday_only", ctx);
  const published = compare.classifyRoyalCandidateDelta("NEW_2027-06-01", "fresh_only", ctx);
  const mystery = compare.classifyRoyalCandidateDelta("X_UNKNOWN", "wednesday_only", {
    ...ctx,
    freshUnionIds: new Set(["X_UNKNOWN"])
  });
  if (aged.classification !== "CUT_OFF_DATE_AGING") throw new Error(aged.classification);
  if (gone.classification !== "SOURCE_REMOVED") throw new Error(gone.classification);
  if (published.classification !== "NEW_OFFICIAL_PUBLICATION") throw new Error(published.classification);
  if (mystery.classification !== "UNEXPLAINED") throw new Error(mystery.classification);
});

test("unexplained identity appear/disappear blocks freeze", () => {
  const gate = compare.evaluateRoyalP3hFreezeGate({
    health: {
      weekly_maintenance_healthy: true,
      royal_caribbean_source_enumeration_ok: true,
      reconciliation_arithmetic_ok: true,
      review_count: 0,
      incomplete_inserts: 0
    },
    compare: { comparable: true, wednesday_only: ["X"], fresh_only: [], fresh_count: 105 },
    deltas: { unexplained: [{ official_sailing_id: "X", classification: "UNEXPLAINED" }] },
    classificationCounts: { AMBIGUOUS: 0, REVIEW_REQUIRED: 0, COLLISION: 0 },
    wednesdayIdentitiesPersisted: true,
    wednesdayCandidateCount: 106
  });
  if (gate.freeze_authorised) throw new Error("unexplained delta must stop catch-up");
  if (gate.classification !== "READY_FOR_CONTROLLED_CATCHUP") throw new Error(gate.classification);
});

test("master-plan freeze keeps candidate payload and hash", () => {
  const inserts = Array.from({ length: 32 }, (_, i) => ({
    proposed_action: "insert_active",
    official_sailing_id: `ID_${i}`,
    identity_key: `id-${i}`,
    external_key: `ext-${i}`,
    candidate: {
      official_sailing_id: `ID_${i}`,
      identity_key: `id-${i}`,
      external_key: `ext-${i}`,
      ship_id: "ship-1",
      departure_port: "Miami",
      destination_id: "dest-1",
      official_url: `https://www.royalcaribbean.com/${i}`,
      cruise_line_id: "line-1"
    }
  }));
  const plan = royalPlan.freezeRoyalCatchupMasterPlan({
    proposedInserts: inserts,
    productionRows: [],
    today: "2026-09-16",
    sourceSnapshotId: "snap"
  });
  if (plan.safe_backlog !== 32) throw new Error(String(plan.safe_backlog));
  if (!plan.classified[0].canonical_write_payload) throw new Error("missing write payload");
  const check = royalPlan.verifyFrozenRoyalCatchupPlanHash(plan);
  if (!check.ok) throw new Error("hash drift");
});

test("max 30 material writes per catch-up batch", () => {
  if (royalPlan.P3G_ROYAL_CATCHUP_BATCH_CAP !== 30) throw new Error("cap changed");
  const inserts = Array.from({ length: 106 }, (_, i) => ({
    proposed_action: "insert_active",
    official_sailing_id: `ID_${i}`,
    candidate: {
      official_sailing_id: `ID_${i}`,
      identity_key: `id-${i}`,
      ship_id: "s",
      departure_port: "p",
      destination_id: "d",
      official_url: "https://www.royalcaribbean.com/x"
    }
  }));
  const plan = royalPlan.freezeRoyalCatchupMasterPlan({
    proposedInserts: inserts,
    productionRows: [],
    today: "2026-09-16",
    sourceSnapshotId: "snap"
  });
  if (plan.batches.map((b) => b.expected_record_count).join() !== "30,30,30,16") {
    throw new Error(plan.batches.map((b) => b.expected_record_count).join());
  }
  const manifest = royalPlan.buildRoyalCatchupBatchWeeklyManifest({
    plan,
    batch: plan.batches[0],
    runId: "run",
    computeManifestHash: weeklyManifest.computeManifestHash,
    weeklyManifestMode: weeklyManifest.WEEKLY_MANIFEST_MODE,
    confirmToken: weeklyManifest.WEEKLY_APPLY_CONFIRMATION_TOKEN
  });
  if (manifest.inserts.length !== 30) throw new Error("batch inserts");
  if (manifest.source_absence_hides.length !== 0) throw new Error("absence hides must stay empty");
  if (manifest.cutoff_hides.length !== 0) throw new Error("cutoff hides not part of catch-up");
});

test("under-lock collision check treats existing official ID as collision", () => {
  const classified = royalPlan.classifyRoyalCatchupCandidate(
    {
      proposed_action: "insert_active",
      official_sailing_id: "HIT",
      candidate: {
        official_sailing_id: "HIT",
        identity_key: "id",
        ship_id: "s",
        departure_port: "p",
        destination_id: "d",
        official_url: "https://x"
      }
    },
    royalPlan.indexProductionRows([{ id: "existing", official_sailing_id: "HIT" }])
  );
  if (classified.classification !== "COLLISION") throw new Error(classified.classification);
});

test("partial batch stops all later batches", () => {
  const result = compare.laterRoyalCatchupBatchesMustStop([
    { batch_number: 1, ok: true, failed_writes: 0, inserted: 30, applied: true },
    { batch_number: 2, ok: false, failed_writes: 1, stopped_early: true, applied: true },
    { batch_number: 3, skipped: true, applied: false, batch_number_dup: 3 }
  ]);
  if (!result.stop || result.failed_batch !== 2) throw new Error("must stop after batch 2");
  if (result.later_batches_applied) throw new Error("later batches must not apply");
});

test("source absence stays untouched in catch-up manifests", () => {
  const applySrc = fs.readFileSync(path.join(root, "scripts/run-p3h-royal-catchup-apply.mjs"), "utf8");
  if (!applySrc.includes("p3h_forbids_source_absence_hides")) throw new Error("absence guard missing");
  if (!applySrc.includes("source_absence_hides")) throw new Error("must inspect absence hides");
});

test("NCL new insert vs prior match_required is duplicate protection", () => {
  const inserted = {
    id: "new-1",
    official_sailing_id: "PRIMA3CIVPMIBCN|2027-05-04",
    ship_id: "ship-1",
    departure_date: "2027-05-04",
    return_date: "2027-05-07",
    nights: 3,
    departure_port: "CIV",
    external_key: "ext-1",
    identity_key: "id-1"
  };
  const prior = {
    id: "old-mr",
    status: "match_required",
    official_sailing_id: "PRIMA3CIVPMIBCN|2027-05-04",
    ship_id: "ship-1",
    departure_date: "2027-05-04",
    return_date: "2027-05-07",
    nights: 3,
    departure_port: "CIV"
  };
  const dupe = nclAudit.classifyNorwegianWednesdayInsert(inserted, {
    sourceEligible: [inserted],
    priorActive: [],
    priorMatchRequired: [prior],
    productionRows: [prior, inserted]
  });
  if (dupe.classification !== "SHOULD_HAVE_MATCHED_MATCH_REQUIRED") throw new Error(dupe.classification);
  const fresh = nclAudit.classifyNorwegianWednesdayInsert(inserted, {
    sourceEligible: [inserted],
    priorActive: [],
    priorMatchRequired: [],
    productionRows: [inserted]
  });
  if (fresh.classification !== "VALID_NEW_INSERT") throw new Error(fresh.classification);
});

test("21-day cutoff hide verification does not change the rule", () => {
  if (inventory.PUBLIC_BOOKING_CUTOFF_DAYS !== 21) throw new Error("cutoff changed");
  const days = inventory.daysUntilDeparture("2026-10-07", "2026-09-16");
  if (days !== 21) throw new Error(`expected 21 days, got ${days}`);
  const hide = nclAudit.verifyNorwegianCutoffHide(
    {
      id: "hide-1",
      official_sailing_id: "JADE11|2026-10-07",
      departure_date: "2026-10-07",
      status: "expired",
      raw_extract: {
        previous_status: "active",
        ncl_maintenance_hide_reason: "within_public_booking_cutoff",
        expiration_run_id: "run-x"
      }
    },
    { perthToday: "2026-09-16", expectedRunId: "run-x" }
  );
  if (!hide.within_21_day_cutoff) throw new Error(hide.failures.join(","));
});

test("post-write idempotency: recognised official ID is not TRUE_NEW", () => {
  const existing = {
    id: "uuid-1",
    official_sailing_id: "NCL-NEW-1",
    status: "match_required",
    ship_id: "s",
    departure_date: "2027-05-04",
    return_date: "2027-05-07",
    nights: 3,
    departure_port: "CIV"
  };
  const classified = nclIdentity.classifyNorwegianP3bCandidate(
    {
      official_sailing_id: "NCL-NEW-1",
      ship_id: "s",
      departure_date: "2027-05-04",
      return_date: "2027-05-07",
      nights: 3,
      departure_port: "CIV"
    },
    [existing]
  );
  if (classified.classification === "TRUE_NEW") throw new Error("today's insert must be recognised, not re-proposed");
});

test("parser/resolver repair remains on the NCL catalogue path", () => {
  const adapterSrc = fs.readFileSync(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter.js"), "utf8");
  const sourceSrc = fs.readFileSync(path.join(root, "netlify/functions/lib/norwegian-discovery-source.js"), "utf8");
  if (!adapterSrc.includes("inferNorwegianShipCodeFromItinerary")) throw new Error("adapter ship infer missing");
  if (!sourceSrc.includes("inferNorwegianShipCodeFromItinerary")) throw new Error("catalogue ship infer missing");
  if (typeof nclAdapter.inferNorwegianShipCodeFromItinerary !== "function") throw new Error("adapter export");
  if (typeof nclSource.expandItineraryRecord !== "function" && !sourceSrc.includes("expandItineraryRecord")) {
    throw new Error("catalogue expand missing");
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const row of failures) console.error(`- ${row.name}: ${row.error}`);
  process.exit(1);
}
process.exit(0);
