#!/usr/bin/env node
/**
 * P3K W38 ledger + Friday Azamara/Silversea verification.
 * Unique validation namespace. Does not claim scheduled leases.
 *
 *   node scripts/run-p3k-w38-friday-verify.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { scheduledWeeklyDispatchKey, perthIsoWeek } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);
const { WEEKLY_LINE_SCHEDULE } = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-map"));

const LINES = [
  { slug: "holland-america-line", label: "HAL" },
  { slug: "celebrity-cruises", label: "Celebrity" },
  { slug: "princess-cruises", label: "Princess" },
  { slug: "explora-journeys", label: "Explora" },
  { slug: "seabourn-cruise-line", label: "Seabourn" },
  { slug: "royal-caribbean-international", label: "Royal" },
  { slug: "norwegian-cruise-line", label: "Norwegian" },
  { slug: "carnival-cruise-line", label: "Carnival" },
  { slug: "disney-cruise-line", label: "Disney" },
  { slug: "azamara", label: "Azamara" },
  { slug: "silversea-cruises", label: "Silversea" }
];

function perthStamp(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-CA", { timeZone: "Australia/Perth", hour12: false });
}

function compactRun(row) {
  const stats = row.stats || {};
  return {
    id: row.id,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    perth_started: perthStamp(row.started_at),
    line_slug: stats.line_slug || null,
    run_type: stats.run_type || null,
    trigger_type: stats.trigger_type || null,
    terminal_status: stats.terminal_status || stats.status || row.status,
    source_repair_required: stats.source_repair_required === true,
    source_unstable: stats.source_unstable === true,
    eligible: stats.source_total ?? stats.official_source_total ?? stats.source_eligible ?? stats.eligible_total ?? null,
    inserts: stats.writes_performed?.inserted ?? stats.inserted ?? 0,
    updates: stats.writes_performed?.updated ?? stats.updated ?? 0,
    reviews: stats.proposed_identity_review ?? (stats.identity_review_sailing_ids || []).length ?? 0,
    writes:
      (stats.writes_performed?.inserted || 0) +
      (stats.writes_performed?.updated || 0) +
      (stats.writes_performed?.failed || 0),
    dry_run: stats.dry_run === true,
    error: row.error_message || stats.error || null
  };
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const week = perthIsoWeek();
  const since = "2026-09-13T16:00:00.000Z";
  const runs = await sb(
    `cruise_discovery_runs?started_at=gte.${encodeURIComponent(since)}&select=id,status,stats,started_at,finished_at,error_message&order=started_at.desc&limit=200`
  );
  const compact = (runs || []).map(compactRun);
  const byLine = {};
  for (const line of LINES) {
    const schedule = WEEKLY_LINE_SCHEDULE.find((s) => s.slug === line.slug);
    const lineRuns = compact.filter(
      (r) => r.line_slug === line.slug || String(r.run_type || "").includes(line.slug.split("-")[0])
    );
    const scheduled = lineRuns.filter((r) => r.trigger_type === "scheduled");
    const lease = await loadMaintenanceLockStatus(sb, scheduledWeeklyDispatchKey(line.slug));
    byLine[line.label] = {
      slug: line.slug,
      scheduled_perth: schedule
        ? `${schedule.weekday} ${String(schedule.perth_hour).padStart(2, "0")}:${String(schedule.perth_minute).padStart(2, "0")}`
        : null,
      cron_utc: schedule?.cron_utc || null,
      scheduled_lease_held: lease.held === true,
      scheduled_lease_owner: lease.owner_id || null,
      scheduled_runs: scheduled,
      all_runs: lineRuns.slice(0, 8)
    };
  }

  const azLease = await loadMaintenanceLockStatus(sb, scheduledWeeklyDispatchKey("azamara"));
  const ssLease = await loadMaintenanceLockStatus(sb, scheduledWeeklyDispatchKey("silversea-cruises"));
  const running = compact.filter((r) => !r.finished_at && /run/i.test(String(r.status || "")));
  const missed = compact.filter((r) => /MISSED_SCHEDULE/i.test(String(r.terminal_status || r.error || "")));

  const report = {
    generated_at: new Date().toISOString(),
    week,
    azamara_scheduled_lease: { key: scheduledWeeklyDispatchKey("azamara"), held: azLease.held === true },
    silversea_scheduled_lease: { key: scheduledWeeklyDispatchKey("silversea-cruises"), held: ssLease.held === true },
    missed_schedule_rows: missed,
    stale_running_rows: running,
    lines: byLine
  };
  const file = path.join(root, "reports", `azamara-p3k-w38-ledger-${Date.now()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report_file: file, week, missed: missed.length, running: running.length, az_lease: azLease.held, ss_lease: ssLease.held }, null, 2));
  for (const line of LINES) {
    const row = byLine[line.label];
    const last = (row.scheduled_runs[0] || row.all_runs[0]) || null;
    console.log(
      [
        line.label.padEnd(10),
        row.scheduled_perth || "-",
        `lease=${row.scheduled_lease_held}`,
        `sched_runs=${row.scheduled_runs.length}`,
        last ? `${last.status}/${last.terminal_status} eligible=${last.eligible} writes=${last.writes} finished=${Boolean(last.finished_at)}` : "NO_RUN"
      ].join(" | ")
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
