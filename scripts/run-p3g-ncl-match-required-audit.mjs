#!/usr/bin/env node
/**
 * Read-only NCL match_required audit. Does not write discovered_cruises.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runNorwegianWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/norwegian-weekly-maintenance")
);
const { perthIsoWeek, scheduledWeeklyDispatchKey } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);
const { auditNorwegianMatchRequiredRows } = require(
  path.join(root, "netlify/functions/lib/norwegian-match-required-audit")
);

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const periodKey = scheduledWeeklyDispatchKey("norwegian-cruise-line");
  const before = await loadMaintenanceLockStatus(sb, periodKey);
  const line = (await sb("ci_cruise_lines?slug=eq.norwegian-cruise-line&select=id&limit=1"))[0];
  process.env.NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED = "true";
  const result = await runNorwegianWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    maxWrites: 0,
    runId: `norwegian-p3g-match-required-audit-${perthIsoWeek()}-${Date.now()}`,
    triggerType: "preflight"
  });
  const after = await loadMaintenanceLockStatus(sb, periodKey);
  const matchRequired = await sb(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&status=eq.match_required&select=id,official_sailing_id,status,ship_id,departure_date,return_date,nights,departure_port,destination_id,raw_extract`
  );
  const sourceEligible = result.summary?.eligible_products || result.products || [];
  const productionRows = result.summary?.production_rows || matchRequired || [];
  const audit = auditNorwegianMatchRequiredRows(matchRequired || [], {
    sourceEligible,
    productionRows
  });
  const reviewItems = result.summary?.review_items || [];
  const oldIncomplete = reviewItems.filter(
    (item) => item.ambiguity_reason === "SOURCE_FIELD_INCOMPLETE" || item.reason === "incomplete_voyage_equivalence"
  );
  const report = {
    generated_at: new Date().toISOString(),
    iso_week: perthIsoWeek(),
    trigger_type: "preflight",
    scheduled_lease_created: before.held !== true && after.held === true,
    eligible: result.summary?.eligible_total ?? null,
    review_count: reviewItems.length,
    old_34_incomplete_reviews: oldIncomplete.length,
    match_required_count: (matchRequired || []).length,
    audit,
    writes: (result.summary?.inserts || 0) + (result.summary?.updates || 0),
    terminal_status: result.summary?.terminal_status || result.terminal_status
  };
  const file = path.join(root, "reports", `norwegian-p3g-match-required-audit-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report_file: file, ...report, audit: report.audit.counts }, null, 2));
  if (report.scheduled_lease_created) process.exit(2);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
