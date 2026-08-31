#!/usr/bin/env node
/**
 * Read-only production weekly-maintenance ledger snapshot.
 * ZERO discovered_cruises writes.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const LINES = [
  { slug: "holland-america-line", runType: "hal_weekly_maintenance", label: "HAL" },
  { slug: "celebrity-cruises", runType: "celebrity_weekly_maintenance", label: "Celebrity" },
  { slug: "princess-cruises", runType: "princess_weekly_maintenance", label: "Princess" },
  { slug: "explora-journeys", runType: "explora_weekly_maintenance", label: "Explora" },
  { slug: "seabourn-cruise-line", runType: "seabourn_weekly_maintenance", label: "Seabourn" },
  { slug: "royal-caribbean-international", runType: "royal_caribbean_weekly_maintenance", label: "Royal Caribbean" },
  { slug: "norwegian-cruise-line", runType: "norwegian_weekly_maintenance", label: "Norwegian" },
  { slug: "carnival-cruise-line", runType: "carnival_weekly_maintenance", label: "Carnival" },
  { slug: "disney-cruise-line", runType: "disney_weekly_maintenance", label: "Disney" },
  { slug: "azamara", runType: "azamara_weekly_maintenance", label: "Azamara" },
  { slug: "silversea-cruises", runType: "silversea_weekly_maintenance", label: "Silversea" }
];

function isGenuineSuccess(run) {
  if (!run || run.status !== "completed") return false;
  const s = run.stats || {};
  if (s.dry_run === true) return false;
  if (s.blocked_by_lock === true) return false;
  if (s.review_required === true) return false;
  if (s.blocked_by_global_lock === true) return false;
  return true;
}

function summariseRun(run) {
  if (!run) return null;
  const s = run.stats || {};
  return {
    id: run.id,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    error_message: run.error_message || null,
    run_type: s.run_type || null,
    dry_run: s.dry_run === true,
    blocked_by_lock: s.blocked_by_lock === true,
    review_required: s.review_required === true,
    eligible_total: s.eligible_total ?? null,
    proposed_inserts: s.proposed_inserts ?? null,
    proposed_updates: s.proposed_updates ?? null,
    inserts: s.inserts ?? null,
    updates: s.updates ?? null,
    source_absent_active: s.source_absent_active ?? null,
    failure_reason: s.failure_reason || run.error_message || null,
    inventory_changed: s.inventory_changed === true,
    trigger_type: s.trigger_type || null,
    expired_count: s.expired_count ?? null
  };
}

async function count(table, query) {
  const r = await exactCountSupabase(root, table, query);
  return r.count;
}

async function main() {
  const sb = createMaintenanceSupabase(root);
  const capturedAt = new Date().toISOString();

  const lines = await sb(
    "ci_cruise_lines?select=id,name,slug&slug=in.(" +
      LINES.map((l) => l.slug).join(",") +
      ")"
  );

  const locks = await sb(
    "cruise_discovery_maintenance_locks?select=lock_key,owner_id,run_id,run_record_id,acquired_at,expires_at&limit=100"
  ).catch(() => []);

  const snapshot = {
    captured_at: capturedAt,
    production_cruise_writes: 0,
    global_lock: (locks || []).find((l) => l.lock_key === "controlled_production_import:global") || null,
    locks: locks || [],
    lines: {},
    daily_expiry: null
  };

  for (const spec of LINES) {
    const line = (lines || []).find((l) => l.slug === spec.slug);
    if (!line) {
      snapshot.lines[spec.slug] = { error: "line_not_found" };
      continue;
    }

    const [active, expired] = await Promise.all([
      count("discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`),
      count("discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.expired`)
    ]);

    const runs = await sb(
      `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(line.id)}&scope=eq.cruise_line&select=id,status,stats,started_at,finished_at,error_message,created_at&order=created_at.desc&limit=40`
    );
    const typed = (runs || []).filter((r) => r.stats?.run_type === spec.runType);
    const lastAttempt = typed[0] || null;
    const lastGenuine = typed.find(isGenuineSuccess) || null;
    const lastFailed = typed.find((r) => r.status === "failed") || null;
    const running = typed.filter((r) => r.status === "running");
    const lineLock = (locks || []).find((l) => l.lock_key === `${spec.slug}:weekly`) || null;

    const todayWindow = typed.filter((r) => {
      const t = r.started_at || r.created_at;
      return t && t >= "2026-08-30T00:00:00Z";
    });

    snapshot.lines[spec.slug] = {
      label: spec.label,
      cruise_line_id: line.id,
      name: line.name,
      active_production: active,
      expired_production: expired,
      last_attempted: summariseRun(lastAttempt),
      last_genuine_successful_apply: summariseRun(lastGenuine),
      last_failure: summariseRun(lastFailed),
      latest_error: lastFailed?.error_message || lastAttempt?.error_message || lastAttempt?.stats?.failure_reason || null,
      latest_eligible: lastAttempt?.stats?.eligible_total ?? null,
      latest_proposed_inserts: lastAttempt?.stats?.proposed_inserts ?? null,
      latest_proposed_updates: lastAttempt?.stats?.proposed_updates ?? null,
      latest_source_absence: lastAttempt?.stats?.source_absent_active ?? null,
      running_or_stale: running.map(summariseRun),
      line_lock: lineLock,
      recent_typed_runs: typed.slice(0, 12).map(summariseRun),
      attempts_since_2026_08_30: todayWindow.map(summariseRun)
    };
  }

  const expiryRuns = await sb(
    "cruise_discovery_runs?scope=eq.full&select=id,status,stats,started_at,finished_at,error_message,created_at&order=created_at.desc&limit=40"
  );
  const expiryTyped = (expiryRuns || []).filter((r) => r.stats?.run_type === "daily_expiry_maintenance");
  const lastExpiry = expiryTyped[0] || null;
  const lastExpirySuccess = expiryTyped.find((r) => r.status === "completed" && !r.stats?.dry_run) || null;
  snapshot.daily_expiry = {
    last_attempted: summariseRun(lastExpiry),
    last_genuine_success: summariseRun(lastExpirySuccess),
    last_failure: summariseRun(expiryTyped.find((r) => r.status === "failed")),
    recent: expiryTyped.slice(0, 15).map(summariseRun),
    lock: (locks || []).find((l) => l.lock_key === "daily_expiry") || null
  };

  const out = path.join(root, "reports/_ledger-weekly-maintenance-p0-2026-08-31.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2));
  console.log(JSON.stringify({
    captured_at: capturedAt,
    output: out,
    lines: Object.fromEntries(
      Object.entries(snapshot.lines).map(([k, v]) => [
        k,
        {
          active: v.active_production,
          last_status: v.last_attempted?.status || null,
          last_error: v.latest_error,
          last_genuine: v.last_genuine_successful_apply?.finished_at || null,
          running: (v.running_or_stale || []).length,
          attempts_since_aug30: (v.attempts_since_2026_08_30 || []).length
        }
      ])
    ),
    daily_expiry: {
      last_status: snapshot.daily_expiry.last_attempted?.status,
      expired_count: snapshot.daily_expiry.last_attempted?.expired_count,
      last_success: snapshot.daily_expiry.last_genuine_success?.finished_at
    }
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
