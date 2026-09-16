#!/usr/bin/env node
/**
 * P3H forensic audit of NCL Wednesday 15 material writes + post-write read-only.
 * Does not write discovered_cruises.
 *
 *   node scripts/run-p3h-ncl-write-audit.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig, fetchAllPaginated } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const { runNorwegianWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/norwegian-weekly-maintenance")
);
const { perthIsoWeek, scheduledWeeklyDispatchKey } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const { PUBLIC_BOOKING_CUTOFF_DAYS } = require(
  path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory")
);
const { auditNorwegianMatchRequiredRows } = require(
  path.join(root, "netlify/functions/lib/norwegian-match-required-audit")
);
const {
  classifyNorwegianWednesdayInsert,
  verifyNorwegianCutoffHide
} = require(path.join(root, "netlify/functions/lib/norwegian-p3h-write-audit"));

const NCL_RUN_ID = "9e15fbc1-8865-42b4-b196-18e1a785f403";
const NCL_ROLLBACK_ID = "af30212c-baa7-4fb5-8052-ebff8b7c27e1";
const NCL_STARTED = "2026-09-15T19:00:40Z";
const P3G_MATCH_REQUIRED = 37;
const KNOWN_INSERT_IDS = [
  "5c93d5ab-b659-44d9-bc60-4be7200fe0fa",
  "853b168d-211c-455a-96c1-cb97df1d8d89",
  "f7b45eca-0d3e-4b9e-b506-8552da9ed3a0",
  "e4c5d9f9-c8af-423b-b0f5-24512fecd7bb",
  "8a80cf9d-747c-4d8f-8d62-5e07dc7b3346",
  "b78d9945-f08b-48f0-8e88-9256b929fb16",
  "8895202a-ea1d-4436-89f6-5e866cca05ef",
  "3be7ec0c-b6d9-4642-9014-0ffe7005da03",
  "55b4442c-521c-4345-8cf5-0ac675428813",
  "db16abd9-b316-4e2d-8dc8-3bac26869bd1",
  "0a82a3b3-1245-484f-a04e-2390c07edd99"
];
const EXPIRATION_RUN_ID = "norwegian-cruise-line-weekly-2026-09-15T19-00-37-605Z";

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const periodKey = scheduledWeeklyDispatchKey("norwegian-cruise-line");
  const before = await loadMaintenanceLockStatus(sb, periodKey);
  const line = (await sb("ci_cruise_lines?slug=eq.norwegian-cruise-line&select=id&limit=1"))[0];
  const run = (
    await sb(
      `cruise_discovery_runs?id=eq.${encodeURIComponent(NCL_RUN_ID)}&select=id,status,started_at,finished_at,stats`
    )
  )?.[0];
  const rollbackRows = await sb(
    `cruise_discovery_maintenance_manifests?id=eq.${encodeURIComponent(NCL_ROLLBACK_ID)}&select=id,manifest_type,manifest,created_at`
  );
  const rollback = rollbackRows?.[0] || null;
  const insertIds = rollback?.manifest?.inserted_record_ids?.length
    ? rollback.manifest.inserted_record_ids
    : KNOWN_INSERT_IDS;

  const productionRows = await fetchAllPaginated(
    root,
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,official_sailing_id,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port,status,official_url,created_at,raw_extract,itinerary`
  );
  const inserts = productionRows.filter((row) => insertIds.includes(row.id));
  const matchRequired = productionRows.filter((row) => row.status === "match_required");
  const priorMatchRequired = matchRequired.filter(
    (row) => !insertIds.includes(row.id) && String(row.created_at || "") < NCL_STARTED
  );
  const priorActive = productionRows.filter(
    (row) => row.status === "active" && String(row.created_at || "") < NCL_STARTED
  );

  process.env.NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED = "true";
  const result = await runNorwegianWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    maxWrites: 0,
    runId: `norwegian-p3h-postwrite-readonly-${perthIsoWeek()}-${Date.now()}`,
    triggerType: "preflight"
  });
  const after = await loadMaintenanceLockStatus(sb, periodKey);
  const sourceEligible = result.simulation?.products || result.manifest?.eligible_products || [];
  const insertAudit = inserts.map((row) => {
    const ship = null;
    const classified = classifyNorwegianWednesdayInsert(row, {
      sourceEligible,
      priorActive,
      priorMatchRequired,
      productionRows
    });
    return {
      uuid: row.id,
      official_sailing_id: row.official_sailing_id,
      ship_id: row.ship_id,
      ship,
      departure: row.departure_date,
      return: row.return_date,
      nights: row.nights,
      departure_port: row.departure_port,
      destination_id: row.destination_id,
      source_evidence: row.official_url || row.raw_extract?.official_url || row.raw_extract?.source_url || null,
      status: row.status,
      created_at: row.created_at,
      ...classified
    };
  });

  const hideRows = productionRows.filter(
    (row) => row.raw_extract?.expiration_run_id === EXPIRATION_RUN_ID
  );
  const perthToday = perthCalendarDate();
  const hideAudit = hideRows.map((row) =>
    verifyNorwegianCutoffHide(row, { perthToday, expectedRunId: EXPIRATION_RUN_ID })
  );

  const reviewItems = result.summary?.review_items || result.manifest?.review_items || [];
  const oldIncomplete = reviewItems.filter(
    (item) => item.ambiguity_reason === "SOURCE_FIELD_INCOMPLETE" || item.reason === "incomplete_voyage_equivalence"
  );
  const insertedOfficials = new Set(inserts.map((row) => row.official_sailing_id).filter(Boolean));
  const proposedInsertIds = (result.manifest?.inserts || []).map(
    (row) => row.official_sailing_id || row.candidate?.official_sailing_id
  );
  const duplicateProposals = proposedInsertIds.filter((id) => insertedOfficials.has(id));
  const matchRequiredAudit = auditNorwegianMatchRequiredRows(matchRequired, {
    sourceEligible,
    productionRows
  });
  const recognisedInserted = inserts.filter((row) => {
    const sourceHit = sourceEligible.find((item) => item.official_sailing_id === row.official_sailing_id);
    return Boolean(sourceHit);
  });

  const invalid = insertAudit.filter((row) => row.classification !== "VALID_NEW_INSERT");
  const allHidesValid = hideAudit.length === 4 && hideAudit.every((row) => row.within_21_day_cutoff === true);
  const classification =
    invalid.length === 0 &&
    allHidesValid &&
    oldIncomplete.length === 0 &&
    duplicateProposals.length === 0 &&
    (result.summary?.failed_writes || 0) === 0
      ? "NCL_WEDNESDAY_WRITES_CLEAN"
      : "NCL_WEDNESDAY_WRITES_REVIEW";

  const report = {
    generated_at: new Date().toISOString(),
    scheduled_run_id: NCL_RUN_ID,
    rollback_manifest_id: NCL_ROLLBACK_ID,
    run_stats: run?.stats || null,
    public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    scheduled_lease_created: before.held !== true && after.held === true,
    inserts: insertAudit,
    insert_class_counts: {
      VALID_NEW_INSERT: insertAudit.filter((row) => row.classification === "VALID_NEW_INSERT").length,
      SHOULD_HAVE_MATCHED_EXISTING: insertAudit.filter((row) => row.classification === "SHOULD_HAVE_MATCHED_EXISTING")
        .length,
      SHOULD_HAVE_MATCHED_MATCH_REQUIRED: insertAudit.filter(
        (row) => row.classification === "SHOULD_HAVE_MATCHED_MATCH_REQUIRED"
      ).length,
      AMBIGUOUS: insertAudit.filter((row) => row.classification === "AMBIGUOUS").length
    },
    invalid_or_ambiguous_inserts: invalid,
    cutoff_hides: hideAudit,
    all_4_within_21_day_cutoff: allHidesValid,
    match_required: {
      before_p3g: P3G_MATCH_REQUIRED,
      after: matchRequired.length,
      prior_excluding_new_inserts: priorMatchRequired.length,
      new_inserts_now_match_required: inserts.filter((row) => row.status === "match_required").length,
      null_official_id: matchRequired.filter((row) => !row.official_sailing_id).length,
      audit: matchRequiredAudit.counts,
      duplicates_with_new_inserts: invalid.filter((row) => row.classification === "SHOULD_HAVE_MATCHED_MATCH_REQUIRED")
        .length
    },
    post_write: {
      proposed_inserts: result.summary?.proposed_inserts ?? (result.manifest?.inserts || []).length,
      proposed_insert_ids: proposedInsertIds,
      duplicate_proposals_for_todays_11: duplicateProposals,
      old_34_incomplete_reviews: oldIncomplete.length,
      recognised_inserted: recognisedInserted.length,
      failed_writes: result.summary?.failed_writes || 0,
      terminal_status: result.summary?.terminal_status || result.terminal_status,
      rollback_complete: Boolean(rollback?.manifest?.inserted_record_ids?.length === 11)
    },
    classification
  };

  const file = path.join(root, "reports", `norwegian-p3h-write-audit-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report_file: file,
        inserts: insertAudit.length,
        valid_new: report.insert_class_counts.VALID_NEW_INSERT,
        invalid: invalid.length,
        cutoff_hides: hideAudit.length,
        all_4_within_21: allHidesValid,
        match_required_after: matchRequired.length,
        old_34: oldIncomplete.length,
        proposed_inserts: report.post_write.proposed_inserts,
        classification
      },
      null,
      2
    )
  );
  if (report.scheduled_lease_created) process.exit(2);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
