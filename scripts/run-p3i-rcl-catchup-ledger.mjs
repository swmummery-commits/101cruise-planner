#!/usr/bin/env node
/**
 * Create a factual manual_catchup ledger record for the P3H RCL 107-insert catch-up
 * and link the four existing rollback manifests. Does not rewrite the Wednesday scheduled run.
 *
 *   node scripts/run-p3i-rcl-catchup-ledger.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { createMaintenanceRun, finalizeMaintenanceRun } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking")
);

const WEDNESDAY_SCHEDULED_RUN = "f086ae94-3d5e-4f6c-bb6d-38937bb6ec7d";
const MASTER_PLAN_HASH = "215e97d926fdc3abe7c814f3a1f7a61a0809868b80f49062fef0d9307f1d1f4d";
const MANIFEST_IDS = [
  "23db0640-383b-4c3a-8767-0976312f9c9d",
  "1676f548-18ed-4ff4-9438-7ffd0333417a",
  "405d5356-86a3-4f76-b261-03b4a87cab79",
  "6cbd189f-2da3-4dd1-b32f-9677b8317f29"
];
const BATCH_SIZES = [30, 30, 30, 17];

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const line = (await sb("ci_cruise_lines?slug=eq.royal-caribbean-international&select=id,slug&limit=1"))[0];
  const wednesday = (
    await sb(`cruise_discovery_runs?id=eq.${WEDNESDAY_SCHEDULED_RUN}&select=id,status,stats,started_at,finished_at`)
  )?.[0];
  const manifests = [];
  for (const id of MANIFEST_IDS) {
    const rows = await sb(
      `cruise_discovery_maintenance_manifests?id=eq.${id}&select=id,run_id,run_record_id,created_at,manifest`
    );
    manifests.push(rows?.[0] || { id });
  }
  if (manifests.some((row) => !row?.created_at)) {
    throw new Error("one or more P3H rollback manifests are missing");
  }
  const startedAt = manifests[0].created_at;
  const finishedAt = manifests[manifests.length - 1].created_at;
  const inserted = manifests.reduce((sum, row) => sum + (row.manifest?.inserted_record_ids || []).length, 0);
  const runId = `royal-p3h-controlled-catchup-${startedAt.slice(0, 10)}`;
  const existing = await sb(
    `cruise_discovery_runs?cruise_line_id=eq.${line.id}&scope=eq.cruise_line&select=id,stats,started_at&order=started_at.desc&limit=30`
  );
  const already = (existing || []).find(
    (row) => row.stats?.run_id === runId || row.stats?.master_plan_hash === MASTER_PLAN_HASH
  );
  let record = already || null;
  if (!record) {
    record = await createMaintenanceRun(sb, {
      cruiseLineId: line.id,
      runId,
      runType: "royal_caribbean_weekly_maintenance",
      triggerType: "manual_catchup",
      stats: {
        authorised_by_scheduled_run_id: WEDNESDAY_SCHEDULED_RUN,
        master_plan_hash: MASTER_PLAN_HASH
      }
    });
  }
  const stats = {
    run_type: "royal_caribbean_weekly_maintenance",
    run_id: runId,
    trigger_type: "manual_catchup",
    authorised_by_scheduled_run_id: WEDNESDAY_SCHEDULED_RUN,
    master_plan_hash: MASTER_PLAN_HASH,
    planned: 107,
    proposed_inserts: 107,
    inserts: inserted,
    updates: 0,
    failed_writes: 0,
    actual_writes: inserted,
    committed_material_writes: inserted,
    inventory_changed: true,
    dry_run: false,
    batch_sizes: BATCH_SIZES,
    rollback_manifest_ids: MANIFEST_IDS,
    manifest_created_at: manifests.map((row) => row.created_at),
    terminal_status: "completed",
    wednesday_scheduled_run_left_unchanged: true,
    wednesday_scheduled_trigger_type: wednesday?.stats?.trigger_type || null
  };
  await finalizeMaintenanceRun(sb, record.id, { status: "completed", stats, errorMessage: null });
  await sb(`cruise_discovery_runs?id=eq.${encodeURIComponent(record.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ started_at: startedAt, finished_at: finishedAt })
  });
  const linked = [];
  for (const row of manifests) {
    await sb(`cruise_discovery_maintenance_manifests?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ run_record_id: record.id })
    });
    linked.push({ id: row.id, previous_run_record_id: row.run_record_id, run_record_id: record.id });
  }
  const wednesdayAfter = (
    await sb(`cruise_discovery_runs?id=eq.${WEDNESDAY_SCHEDULED_RUN}&select=id,stats`)
  )?.[0];
  const report = {
    generated_at: new Date().toISOString(),
    catchup_run_record_id: record.id,
    catchup_run_id: runId,
    trigger_type: "manual_catchup",
    inserts_represented: inserted,
    manifests_linked: linked,
    wednesday_scheduled_run_id: WEDNESDAY_SCHEDULED_RUN,
    wednesday_trigger_type_after: wednesdayAfter?.stats?.trigger_type,
    wednesday_unchanged: wednesdayAfter?.stats?.trigger_type === "scheduled"
  };
  const file = path.join(root, "reports", `royal-p3i-catchup-ledger-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report_file: file, ...report }, null, 2));
  if (inserted !== 107) process.exit(2);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
