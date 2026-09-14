#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require("./lib/supabase-rest.cjs");

getSupabaseConfig(root);
const sb = createMaintenanceSupabase(root);

function compact(run) {
  if (!run) return null;
  const s = run.stats || {};
  return {
    id: run.id,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    trigger: s.trigger_type || null,
    run_type: s.run_type || null,
    terminal: s.terminal_status || null,
    eligible: s.eligible_total ?? s.official_eligible_inventory ?? null,
    inserts: s.inserts ?? 0,
    updates: s.updates ?? 0,
    reviews: s.review_candidates ?? s.proposed_updates_identity_review ?? (s.review_sailing_ids || []).length,
    writes: s.writes_performed ?? (s.inserts || 0) + (s.updates || 0),
    dry_run: s.dry_run ?? null,
    error: run.error_message || s.failure_reason || null
  };
}

async function main() {
  const lines = await sb("ci_cruise_lines?select=id,slug,name&slug=in.(holland-america-line,celebrity-cruises,princess-cruises,explora-journeys,seabourn-cruise-line,royal-caribbean-international,norwegian-cruise-line,carnival-cruise-line,disney-cruise-line,azamara,silversea-cruises)");
  const locks = await sb(
    "cruise_discovery_maintenance_locks?select=lock_key,owner_id,acquired_at,expires_at&or=(lock_key.ilike.*:scheduled,lock_key.ilike.*:weekly,lock_key.eq.controlled_production_import:global)&order=acquired_at.desc"
  );
  const out = { locks, lines: {} };
  for (const line of lines || []) {
    const runs = await sb(
      `cruise_discovery_runs?cruise_line_id=eq.${line.id}&scope=eq.cruise_line&select=id,status,stats,started_at,finished_at,error_message&order=created_at.desc&limit=6`
    );
    out.lines[line.slug] = (runs || []).map(compact);
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
