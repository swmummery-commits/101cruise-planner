#!/usr/bin/env node
/**
 * Production-equivalent HAL weekly READ ONLY after pagination repair.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runHalWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner")
);

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const result = await runHalWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    maxWrites: 100,
    runId: `hal-p3f-readonly-${Date.now()}`,
    triggerType: "preflight"
  });
  const summary = result.summary || {};
  const report = {
    generated_at: new Date().toISOString(),
    ok: result.ok,
    success: result.success,
    reason: result.reason || null,
    source_repair_required: result.source_repair_required === true,
    terminal_status: summary.terminal_status || result.terminal_status || null,
    eligible: summary.eligible_total ?? null,
    active: summary.active_production ?? summary.active_production_inventory ?? null,
    recognised: summary.recognised_eligible ?? summary.recognised ?? null,
    proposed_inserts: summary.proposed_inserts ?? summary.outstanding_eligible ?? null,
    proposed_updates: summary.proposed_updates ?? 0,
    reviews: summary.review_candidates ?? (summary.review_sailing_ids || []).length,
    source_absent: summary.source_absent_active ?? null,
    quality_gate: summary.quality_gate || result.quality_gate || null,
    pagination: summary.pagination || result.simulation?.pagination || null,
    writes: (summary.inserts || 0) + (summary.updates || 0),
    summary
  };
  const file = path.join(root, "reports", `hal-p3f-readonly-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report_file: file, ...report, summary: undefined }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
