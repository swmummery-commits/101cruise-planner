#!/usr/bin/env node
/**
 * P3 Disney stale-run forensic — read-only unless --finalize is passed
 * after proving zero unrecorded writes.
 *
 *   node scripts/p3-disney-stale-run-forensic.mjs
 *   node scripts/p3-disney-stale-run-forensic.mjs --finalize
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const stale = require(path.join(root, "netlify/functions/lib/weekly-maintenance-stale-runs"));
const locks = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const { loadGlobalCruiseWriteLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-global-write-lock")
);

const RUN_ID = "8cdd7966-dd64-4250-b3dd-fab83d91108c";
const DISNEY_LINE_ID = process.env.DISNEY_LINE_ID || "";

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const finalize = process.argv.includes("--finalize");

  const runs = await sb(
    `cruise_discovery_runs?id=eq.${encodeURIComponent(RUN_ID)}&select=id,status,stats,started_at,finished_at,error_message,cruise_line_id,scope`
  );
  const run = runs?.[0] || null;
  if (!run) {
    console.log(JSON.stringify({ ok: false, error: "stale_run_not_found", run_id: RUN_ID }, null, 2));
    process.exit(1);
  }

  const lineId = run.cruise_line_id || DISNEY_LINE_ID;
  const started = run.started_at;
  const windowEnd = run.finished_at || new Date().toISOString();
  const weeklyKey = locks.weeklyLockKey("disney-cruise-line");
  const weeklyLock = await locks.loadMaintenanceLockStatus(sb, weeklyKey);
  const globalLock = await loadGlobalCruiseWriteLockStatus(sb);

  const changed =
    lineId &&
    (await sb(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(lineId)}&or=(created_at.gte.${started},updated_at.gte.${started})&select=id,status,official_sailing_id,created_at,updated_at&limit=200`
    ).catch(() => []));

  const createdInWindow = (changed || []).filter((row) => row.created_at >= started && row.created_at <= windowEnd);
  const updatedInWindow = (changed || []).filter((row) => row.updated_at >= started && row.updated_at <= windowEnd);
  const writes = createdInWindow.length + updatedInWindow.filter((row) => !createdInWindow.some((c) => c.id === row.id)).length;

  const report = {
    run_id: RUN_ID,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    stats: {
      inserts: run.stats?.inserts ?? null,
      updates: run.stats?.updates ?? null,
      inventory_changed: run.stats?.inventory_changed ?? null,
      dry_run: run.stats?.dry_run ?? null,
      run_type: run.stats?.run_type ?? null,
      run_id: run.stats?.run_id ?? null
    },
    weekly_lock: weeklyLock,
    global_lock: {
      held: globalLock?.held === true,
      owner_id: globalLock?.owner_id || null,
      run_id: globalLock?.run_id || null,
      expired: globalLock?.expired === true
    },
    discovered_cruises_touched_in_window: {
      created: createdInWindow.length,
      updated: updatedInWindow.length,
      sample_created: createdInWindow.slice(0, 10).map((r) => r.id),
      sample_updated: updatedInWindow.slice(0, 10).map((r) => r.id)
    },
    estimated_committed_writes: writes,
    weekly_lock_expired: weeklyLock.held !== true,
    global_lock_not_held_by_run:
      globalLock?.held !== true ||
      (globalLock.run_id !== run.stats?.run_id && globalLock.run_record_id !== run.id && globalLock.owner_id !== run.stats?.run_id)
  };

  if (finalize && run.status === "running" && report.weekly_lock_expired && report.global_lock_not_held_by_run) {
    if (writes > 0) {
      report.finalize = {
        skipped: true,
        reason: "partial_writes_detected",
        estimated_committed_writes: writes
      };
    } else {
      const result = await stale.reconcileAbandonedMaintenanceRuns(sb, {
        lineSlug: "disney-cruise-line",
        runType: "disney_weekly_maintenance",
        cruiseLineId: lineId,
        minAgeMs: 30 * 60 * 1000
      });
      report.finalize = result;
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
