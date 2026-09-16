#!/usr/bin/env node
/**
 * P3H Royal Caribbean production-equivalent READ-ONLY snapshot.
 * Unique preflight dispatch ID. Does not claim :scheduled.
 *
 *   node scripts/run-p3h-royal-snapshot.mjs
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
const { scheduledWeeklyDispatchKey, perthIsoWeek } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const { runRoyalCaribbeanWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner")
);
const {
  buildRoyalCaribbeanWeeklyManifestFromDryRun
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-manifest"));
const { freezeRoyalCatchupMasterPlan } = require(
  path.join(root, "netlify/functions/lib/royal-caribbean-p3g-catchup-plan")
);
const {
  compareRoyalCandidateSets,
  classifyRoyalCandidateDeltas,
  reconstructCutoffAgingIds,
  evaluateRoyalP3hFreezeGate,
  WEDNESDAY_AS_OF
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-p3h-candidate-compare"));

const WEDNESDAY_RUN_ID = "f086ae94-3d5e-4f6c-bb6d-38937bb6ec7d";
const WEDNESDAY_UNION = 3206;
const WEDNESDAY_CANDIDATES = 106;

async function loadWednesdayLedger(sb) {
  const rows = await sb(
    `cruise_discovery_runs?id=eq.${encodeURIComponent(WEDNESDAY_RUN_ID)}&select=id,status,started_at,finished_at,stats`
  );
  return rows?.[0] || null;
}

function insertEntriesFromResult(result = {}) {
  const weekly = result.weekly_manifest;
  if (Array.isArray(weekly?.inserts) && weekly.inserts.length) return weekly.inserts;
  const products = result.manifest?.products || [];
  return products.filter((row) => row.proposed_action === "insert_active");
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const periodKey = scheduledWeeklyDispatchKey("royal-caribbean-international");
  const before = await loadMaintenanceLockStatus(sb, periodKey);
  const wednesday = await loadWednesdayLedger(sb);
  const wednesdayIds = Array.isArray(wednesday?.stats?.proposed_insert_ids)
    ? wednesday.stats.proposed_insert_ids
    : Array.isArray(wednesday?.stats?.proposed_insert_sample)
      ? wednesday.stats.proposed_insert_sample
      : [];
  const dispatchId = `royal-caribbean-international:p3h-preflight-${perthIsoWeek()}-${Date.now()}`;
  const result = await runRoyalCaribbeanWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    maxWrites: 0,
    triggerType: "preflight",
    runId: dispatchId
  });
  const after = await loadMaintenanceLockStatus(sb, periodKey);
  const summary = result.summary || {};
  const weeklyManifest =
    result.weekly_manifest ||
    buildRoyalCaribbeanWeeklyManifestFromDryRun({
      dryRunResult: { summary, manifest: result.manifest },
      today: summary.perth_today || perthCalendarDate(),
      firstActivationCycle: false
    });
  const insertEntries = insertEntriesFromResult({ ...result, weekly_manifest: weeklyManifest });
  const freshIds = (summary.proposed_insert_ids || insertEntries.map((row) => row.official_sailing_id || row.stable_identity_key)).filter(
    Boolean
  );
  const line = (await sb("ci_cruise_lines?slug=eq.royal-caribbean-international&select=id&limit=1"))[0];
  const productionRows = await fetchAllPaginated(
    root,
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,official_sailing_id,external_key,identity_key,ship_id,destination_id,departure_date,return_date,nights,departure_port,status,official_url`
  );
  const plan = freezeRoyalCatchupMasterPlan({
    proposedInserts: insertEntries,
    proposedUpdates: [],
    productionRows,
    today: summary.perth_today || perthCalendarDate(),
    sourceSnapshotId: summary.source_snapshot_id,
    unionCount: summary.union_sailing_identities
  });
  const compare = compareRoyalCandidateSets(wednesdayIds, freshIds);
  const departureById = new Map(
    insertEntries.map((row) => [
      row.official_sailing_id || row.stable_identity_key,
      row.departure_date || row.candidate?.departure_date || null
    ])
  );
  const products = result.manifest?.products || result.products || [];
  for (const product of products) {
    const id = product.stable_identity_key || product.official_sailing_id;
    if (id && !departureById.has(id)) {
      departureById.set(id, product.departure_date || product.candidate?.departure_date || null);
    }
  }
  const freshUnionIds = new Set(
    products.map((row) => row.stable_identity_key || row.official_sailing_id).filter(Boolean)
  );
  const agingIds = reconstructCutoffAgingIds(products, WEDNESDAY_AS_OF, summary.perth_today || perthCalendarDate());
  const deltas = classifyRoyalCandidateDeltas(compare, {
    departureById,
    freshUnionIds,
    wednesdayUnionIds: [],
    wednesdayAsOf: WEDNESDAY_AS_OF,
    freshAsOf: summary.perth_today || perthCalendarDate()
  });
  const reviewCount = (summary.review_items || summary.review_sailing_ids || []).length;
  const gate = evaluateRoyalP3hFreezeGate({
    health: {
      weekly_maintenance_healthy: summary.weekly_maintenance_healthy === true,
      royal_caribbean_source_enumeration_ok: summary.royal_caribbean_source_enumeration_ok === true,
      reconciliation_arithmetic_ok: summary.reconciliation_arithmetic_ok === true,
      review_count: reviewCount,
      incomplete_inserts: plan.classification_counts.REVIEW_REQUIRED || 0
    },
    compare,
    deltas,
    classificationCounts: plan.classification_counts,
    wednesdayIdentitiesPersisted: wednesdayIds.length > 0,
    reconstructedAgingIds: agingIds,
    wednesdayCandidateCount: wednesday?.stats?.proposed_inserts ?? WEDNESDAY_CANDIDATES
  });

  const report = {
    generated_at: new Date().toISOString(),
    trigger_type: "preflight",
    dispatch_id: dispatchId,
    scheduled_period_key: periodKey,
    scheduled_lease_before: before,
    scheduled_lease_after: after,
    scheduled_lease_created_by_preflight: before.held !== true && after.held === true,
    wednesday: {
      run_record_id: WEDNESDAY_RUN_ID,
      union_sailing_identities: wednesday?.stats?.union_sailing_identities ?? WEDNESDAY_UNION,
      proposed_inserts: wednesday?.stats?.proposed_inserts ?? WEDNESDAY_CANDIDATES,
      proposed_insert_ids: wednesdayIds,
      identities_persisted: wednesdayIds.length > 0,
      source_snapshot_id: wednesday?.stats?.source_snapshot_id || null
    },
    fresh: {
      union_sailing_identities: summary.union_sailing_identities,
      official_source_total: summary.official_source_total,
      recognised_existing_eligible: summary.recognised_existing_eligible_sailings,
      proposed_inserts: summary.proposed_inserts,
      proposed_insert_ids: freshIds,
      proposed_updates: summary.proposed_updates,
      review_items: reviewCount,
      incomplete_skipped: summary.incomplete_skipped,
      source_absent_active: summary.source_absent_active,
      source_absent_action_eligible_count: summary.source_absence_policy?.source_absent_action_eligible_count ?? 0,
      cutoff_candidates: (summary.production_cutoff_candidates || []).length,
      source_snapshot_id: summary.source_snapshot_id,
      weekly_maintenance_healthy: summary.weekly_maintenance_healthy === true,
      royal_caribbean_source_enumeration_ok: summary.royal_caribbean_source_enumeration_ok === true,
      reconciliation_arithmetic_ok: summary.reconciliation_arithmetic_ok === true,
      terminal_status: summary.terminal_status || result.terminal_status,
      perth_today: summary.perth_today || perthCalendarDate()
    },
    compare,
    reconstructed_cutoff_aging_ids: agingIds,
    deltas,
    freeze_gate: gate,
    master_plan: plan,
    weekly_manifest_inserts: insertEntries,
    writes: 0
  };

  const file = path.join(root, "reports", `royal-p3h-readonly-snapshot-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report_file: file,
        dispatch_id: dispatchId,
        scheduled_lease_created: report.scheduled_lease_created_by_preflight,
        union: report.fresh.union_sailing_identities,
        proposed_inserts: report.fresh.proposed_inserts,
        reviews: reviewCount,
        healthy: report.fresh.weekly_maintenance_healthy,
        enumeration_ok: report.fresh.royal_caribbean_source_enumeration_ok,
        arithmetic_ok: report.fresh.reconciliation_arithmetic_ok,
        wednesday_ids_persisted: report.wednesday.identities_persisted,
        intersection: compare.intersection_count,
        wednesday_only: compare.wednesday_only.length,
        fresh_only: compare.fresh_only.length,
        freeze_authorised: gate.freeze_authorised,
        freeze_failures: gate.failures,
        master_plan_size: plan.safe_backlog,
        master_plan_hash: plan.plan_hash,
        batches: plan.batches.map((b) => b.expected_record_count)
      },
      null,
      2
    )
  );
  if (report.scheduled_lease_created_by_preflight) process.exit(2);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
