#!/usr/bin/env node
/**
 * P3O Princess READ-ONLY source freeze. Zero discovered_cruises writes.
 *   node scripts/snapshot-princess-p3o-readonly.mjs MAC
 *   node scripts/snapshot-princess-p3o-readonly.mjs NETLIFY-LOCAL
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* optional */
}

const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));

const label = process.argv[2] || "MAC";
const outPath = path.join(root, "reports", `princess-p3o-source-snapshot-${label}-${Date.now()}.json`);

async function main() {
  const sb = createMaintenanceSupabase(root);
  const started = new Date().toISOString();
  const result = await runPrincessWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    writeMode: "weekly_maintenance",
    triggerType: "p3o_readonly_snapshot",
    collectSourceDiagnostics: true
  });
  const summary = result.summary || {};
  const report = {
    label,
    started,
    finished: new Date().toISOString(),
    discovered_cruises_writes: 0,
    ok: result.ok === true,
    terminal_status: result.terminal_status || summary.terminal_status || null,
    official_source_total: summary.official_source_total ?? null,
    eligible_total: summary.eligible_total ?? null,
    active_production_total: summary.active_production_total ?? null,
    snapshot_id: summary.snapshot_id ?? null,
    resolution_rates: summary.resolution_rates || null,
    source_accounting: summary.source_accounting || null,
    canonical_active_counts: summary.canonical_active_counts || null,
    unexplained_active_rows: summary.unexplained_active_rows ?? null,
    proposed_inserts: summary.proposed_inserts ?? null,
    proposed_updates: summary.proposed_updates ?? null,
    proposed_updates_safe_metadata: summary.proposed_updates_safe_metadata ?? null,
    remap_classifications: (summary.remap_classifications || []).map((row) => ({
      classification: row.classification,
      old: row.old_official_sailing_id,
      neu: row.new_official_sailing_id,
      uuid: row.production_uuid
    })),
    weekly_lanes: summary.weekly_lanes || null,
    official_group_ids: (result.simulation?.products || [])
      .map((row) => row.raw?.itinerary_group_id || row.raw?.itinerary_id)
      .filter(Boolean),
    eligible_official_ids: summary.frozen_source?.official_ids || [],
    expanded_official_ids: (result.simulation?.products || [])
      .map((row) => row.candidate?.official_sailing_id || row.raw?.official_sailing_id)
      .filter(Boolean)
  };
  report.official_group_ids = [...new Set(report.official_group_ids)].sort();
  report.expanded_official_ids = [...new Set(report.expanded_official_ids)].sort();
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        outPath,
        eligible: report.eligible_total,
        hash: report.snapshot_id,
        unexplained: report.unexplained_active_rows,
        writes: 0
      },
      null,
      2
    )
  );
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
