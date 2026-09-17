#!/usr/bin/env node
/**
 * Read-only: Thursday Carnival/Disney runs, Wednesday RCL dry_run stats, P3H manifests.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const IDS = {
  wednesday_rcl: "f086ae94-3d5e-4f6c-bb6d-38937bb6ec7d",
  ncl: "9e15fbc1-8865-42b4-b196-18e1a785f403",
  manifests: [
    "23db0640-383b-4c3a-8767-0976312f9c9d",
    "1676f548-18ed-4ff4-9438-7ffd0333417a",
    "405d5356-86a3-4f76-b261-03b4a87cab79",
    "6cbd189f-2da3-4dd1-b32f-9677b8317f29"
  ]
};

function compactRun(run) {
  if (!run) return null;
  const s = run.stats || {};
  return {
    id: run.id,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    trigger_type: s.trigger_type,
    run_id: s.run_id,
    dry_run: s.dry_run,
    terminal_status: s.terminal_status,
    proposed_inserts: s.proposed_inserts,
    proposed_updates: s.proposed_updates,
    actual_writes: s.actual_writes,
    inserts: s.inserts,
    committed_material_writes: s.committed_material_writes,
    weekly_change_volume_exceeded: s.weekly_change_volume_exceeded ?? s.weekly_health?.weekly_change_volume_exceeded,
    weekly_maintenance_healthy: s.weekly_maintenance_healthy,
    controlled_catchup_required: s.controlled_catchup_required,
    writes_allowed: s.writes_allowed,
    failure_reason: s.failure_reason,
    inventory_changed: s.inventory_changed,
    cutoff_candidate_count: s.cutoff_candidate_count,
    source_absent_action_eligible_count: s.source_absent_action_eligible_count,
    source_absent_candidate_count: s.source_absent_candidate_count,
    dispatch_id: s.dispatch_id,
    run_type: s.run_type,
    stats_keys: Object.keys(s).sort()
  };
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const lines = await sb(
    "ci_cruise_lines?slug=in.(carnival-cruise-line,disney-cruise-line,royal-caribbean-international,norwegian-cruise-line)&select=id,slug"
  );
  const bySlug = Object.fromEntries((lines || []).map((row) => [row.slug, row.id]));
  const thursdayCutoff = "2026-09-16T16:00:00Z";
  const carnival = await sb(
    `cruise_discovery_runs?cruise_line_id=eq.${bySlug["carnival-cruise-line"]}&scope=eq.cruise_line&started_at=gte.${thursdayCutoff}&select=id,status,stats,started_at,finished_at,error_message&order=started_at.desc&limit=5`
  );
  const disney = await sb(
    `cruise_discovery_runs?cruise_line_id=eq.${bySlug["disney-cruise-line"]}&scope=eq.cruise_line&started_at=gte.${thursdayCutoff}&select=id,status,stats,started_at,finished_at,error_message&order=started_at.desc&limit=5`
  );
  const wednesday = (
    await sb(`cruise_discovery_runs?id=eq.${IDS.wednesday_rcl}&select=id,status,stats,started_at,finished_at`)
  )?.[0];
  const manifests = [];
  for (const id of IDS.manifests) {
    const rows = await sb(
      `cruise_discovery_maintenance_manifests?id=eq.${id}&select=id,manifest_type,run_id,run_record_id,cruise_line_id,cruise_line_slug,created_at,manifest`
    );
    const row = rows?.[0];
    manifests.push({
      id: row?.id,
      manifest_type: row?.manifest_type,
      run_id: row?.run_id,
      run_record_id: row?.run_record_id,
      cruise_line_id: row?.cruise_line_id,
      cruise_line_slug: row?.cruise_line_slug,
      created_at: row?.created_at,
      inserted_count: row?.manifest?.inserted_record_ids?.length || 0,
      trigger_type: row?.manifest?.trigger_type || null
    });
  }
  console.log(
    JSON.stringify(
      {
        carnival: (carnival || []).map(compactRun),
        disney: (disney || []).map(compactRun),
        wednesday_rcl: compactRun(wednesday),
        wednesday_dry_run_raw: wednesday?.stats?.dry_run,
        manifests
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
