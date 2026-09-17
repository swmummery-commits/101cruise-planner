#!/usr/bin/env node
/**
 * P3J: recovery manifest + truthful finalise of Disney run 72c1e384.
 * Does not delete the W38 schedule lease. Does not mutate the 30 rows.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const { persistMaintenanceManifest } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-manifests")
);
const { loadMaintenanceLockStatus, weeklyLockKey } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);
const { loadGlobalCruiseWriteLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-global-write-lock")
);
const {
  scheduledWeeklyDispatchKey,
  backgroundDispatchExecutionKey
} = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control"));

const RUN_ID = "72c1e384-9369-4d70-b690-81db79b9055d";
const ORIGINAL_RUN = "disney-cruise-line-weekly-2026-09-16T19-00-34-516Z";
const DISPATCH = "disney-cruise-line-dispatch-2026-09-16T19-00-30-347Z";

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const freeze = JSON.parse(
    fs.readFileSync(path.join(root, "reports/disney-p3j-partial-write-30-freeze-2026-09-17.json"), "utf8")
  );
  if (freeze.row_count !== 30) throw new Error("freeze is not 30 rows");

  const exec = await loadMaintenanceLockStatus(sb, weeklyLockKey("disney-cruise-line"));
  const bg = await loadMaintenanceLockStatus(sb, backgroundDispatchExecutionKey(DISPATCH));
  const period = await loadMaintenanceLockStatus(sb, scheduledWeeklyDispatchKey("disney-cruise-line"));
  const global = await loadGlobalCruiseWriteLockStatus(sb);
  if (exec.held === true && exec.expired !== true) throw new Error("execution lock still held");
  if (bg.held === true && bg.expired !== true) throw new Error("background lock still held");
  if (global.held === true) throw new Error("global lock held");
  if (period.held !== true) throw new Error("W38 schedule lease missing — abort rather than recreate");

  const run = (await sb(`cruise_discovery_runs?id=eq.${RUN_ID}&select=id,status,started_at,finished_at,stats`))[0];
  const finishedAt = new Date().toISOString();
  const manifestRow = await persistMaintenanceManifest(sb, {
    manifestType: "partial_write_recovery",
    manifest: {
      run_id: ORIGINAL_RUN,
      run_record_id: RUN_ID,
      cruise_line_slug: "disney-cruise-line",
      trigger_type: "incident_recovery",
      original_run_record_id: RUN_ID,
      original_run_id: ORIGINAL_RUN,
      actual_inserts: 30,
      freeze_hash_sha256: freeze.freeze_hash_sha256,
      inserted: freeze.rows.map((row) => ({
        discovered_cruise_id: row.uuid,
        official_sailing_id: row.official_sailing_id,
        before_state: "ABSENT",
        after_state: row
      })),
      inserted_record_ids: freeze.rows.map((row) => row.uuid)
    }
  });

  const stats = {
    ...(run.stats || {}),
    trigger_type: run.stats?.trigger_type || "scheduled",
    run_id: run.stats?.run_id || ORIGINAL_RUN,
    dispatch_id: run.stats?.dispatch_id || DISPATCH,
    status_finalised_by: "p3j_incident_recovery",
    terminal_status: "partial_write_failure",
    inventory_changed: true,
    actual_writes: 30,
    committed_material_writes: 30,
    inserts: 30,
    failed_writes: 0,
    failure_reason: "worker_terminated_after_partial_commit",
    recovery_manifest_id: manifestRow?.id || null,
    freeze_hash_sha256: freeze.freeze_hash_sha256,
    disney_w38_schedule_lease_preserved: true
  };

  await sb(`cruise_discovery_runs?id=eq.${RUN_ID}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "failed",
      finished_at: finishedAt,
      stats,
      error_message: "worker_terminated_after_partial_commit"
    })
  });

  const after = (await sb(`cruise_discovery_runs?id=eq.${RUN_ID}&select=id,status,started_at,finished_at,stats`))[0];
  const periodAfter = await loadMaintenanceLockStatus(sb, scheduledWeeklyDispatchKey("disney-cruise-line"));
  const report = {
    generated_at: new Date().toISOString(),
    recovery_manifest_id: manifestRow?.id || null,
    run: {
      id: after.id,
      status: after.status,
      started_at: after.started_at,
      finished_at: after.finished_at,
      trigger_type: after.stats?.trigger_type,
      terminal_status: after.stats?.terminal_status,
      inserts: after.stats?.inserts,
      inventory_changed: after.stats?.inventory_changed,
      failed_writes: after.stats?.failed_writes
    },
    locks: {
      execution_held: exec.held === true && exec.expired !== true,
      background_held: bg.held === true && bg.expired !== true,
      global_held: global.held === true,
      w38_schedule_lease_held: periodAfter.held === true
    }
  };
  const file = path.join(root, "reports", `disney-p3j-recovery-finalise-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report_file: file, ...report }, null, 2));
  if (periodAfter.held !== true) process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
