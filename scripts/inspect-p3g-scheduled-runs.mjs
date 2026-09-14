#!/usr/bin/env node
/**
 * Read-only inspection of current-week scheduled leases and maintenance runs.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { scheduledWeeklyDispatchKey, perthIsoWeek } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);
const { WEEKLY_LINE_SCHEDULE, classifyWeeklyDueState, slotStartMs } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-map")
);

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const week = perthIsoWeek();
  const now = new Date();
  const lines = await sb("ci_cruise_lines?select=id,slug,name");
  const bySlug = new Map((lines || []).map((row) => [row.slug, row]));
  const matrix = [];
  for (const schedule of WEEKLY_LINE_SCHEDULE) {
    const line = bySlug.get(schedule.slug);
    const periodKey = scheduledWeeklyDispatchKey(schedule.slug);
    const lease = await loadMaintenanceLockStatus(sb, periodKey);
    const runs = line
      ? await sb(
          `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(line.id)}&scope=eq.cruise_line&select=id,status,stats,started_at,finished_at&order=created_at.desc&limit=12`
        )
      : [];
    const slotMs = slotStartMs(schedule, now);
    const scheduledRuns = (runs || []).filter((run) => {
      const trigger = run.stats?.trigger_type || "";
      if (trigger !== "scheduled" && trigger !== "weekly_scheduled_apply") return false;
      const started = Date.parse(run.started_at || 0);
      return Number.isFinite(started) && started >= slotMs - 30 * 60 * 1000;
    });
    const due = classifyWeeklyDueState({
      now,
      schedule,
      scheduledExecutionExists: scheduledRuns.length > 0,
      scheduledLeaseExists: lease.held === true
    });
    matrix.push({
      slug: schedule.slug,
      perth_slot: `${schedule.weekday} ${String(schedule.perth_hour).padStart(2, "0")}:${String(schedule.perth_minute).padStart(2, "0")}`,
      due_state: due.due_state,
      scheduled_period_key: periodKey,
      scheduled_lease_held: lease.held === true,
      scheduled_run_count: scheduledRuns.length,
      scheduled_run_ids: scheduledRuns.map((run) => run.stats?.run_id || run.id),
      latest_scheduled: scheduledRuns[0]
        ? {
            id: scheduledRuns[0].id,
            run_id: scheduledRuns[0].stats?.run_id || null,
            status: scheduledRuns[0].status,
            terminal_status: scheduledRuns[0].stats?.terminal_status || null,
            trigger_type: scheduledRuns[0].stats?.trigger_type || null,
            finished_at: scheduledRuns[0].finished_at,
            writes: scheduledRuns[0].stats?.actual_writes ?? scheduledRuns[0].stats?.committed_material_writes ?? 0,
            eligible: scheduledRuns[0].stats?.eligible_total ?? scheduledRuns[0].stats?.eligible ?? null
          }
        : null
    });
  }
  const report = { generated_at: now.toISOString(), iso_week: week, matrix };
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
