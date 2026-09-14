#!/usr/bin/env node
/**
 * Fresh NCL review forensic: missing-field breakdown and match_required dedupe.
 * Read-only. No discovered_cruises writes.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runNorwegianWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/norwegian-weekly-maintenance")
);
const { perthIsoWeek } = require(path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control"));

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  process.env.NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED = "true";
  const result = await runNorwegianWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    maxWrites: 200,
    runId: `norwegian-p3f-forensic-${perthIsoWeek()}-${Date.now()}`,
    triggerType: "preflight"
  });
  const reviewItems = result.summary?.review_items || result.manifest?.review_items || [];
  const matchRequired = await sb(
    "discovered_cruises?cruise_line_id=eq." +
      encodeURIComponent((await sb("ci_cruise_lines?slug=eq.norwegian-cruise-line&select=id&limit=1"))[0].id) +
      "&status=eq.match_required&select=id,official_sailing_id,status"
  );
  const report = {
    generated_at: new Date().toISOString(),
    eligible: result.summary?.eligible_total ?? result.summary?.source_counts?.eligible ?? null,
    review_count: reviewItems.length,
    review_items: reviewItems,
    missing_field_breakdown: result.summary?.incomplete_source_field_breakdown || null,
    existing_match_required_count: (matchRequired || []).length,
    writes: (result.summary?.inserts || 0) + (result.summary?.updates || 0),
    terminal_status: result.summary?.terminal_status || result.terminal_status,
    review_required: result.review_required === true
  };
  const file = path.join(root, "reports", `norwegian-p3f-review-forensic-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        report_file: file,
        eligible: report.eligible,
        review_count: report.review_count,
        missing_field_breakdown: report.missing_field_breakdown,
        existing_match_required_count: report.existing_match_required_count,
        writes: report.writes,
        terminal_status: report.terminal_status
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
