#!/usr/bin/env node
/**
 * Two complete read-only Royal Caribbean weekly enumerations.
 * Preflight namespace — must not consume the Wednesday scheduled lease.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runRoyalCaribbeanWeeklyBackgroundMaintenance } = require(
  path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance-dispatch")
);
const { scheduledWeeklyDispatchKey, perthIsoWeek } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);

function summarise(result) {
  const summary = result.summary || {};
  return {
    ok: result.ok,
    success: result.success,
    terminal_status: summary.terminal_status || result.terminal_status,
    union_identities: summary.union_sailing_ids || summary.eligible_total || summary.official_eligible_inventory || null,
    eligible: summary.eligible_total ?? null,
    recognised: summary.recognised_eligible ?? summary.recognised ?? null,
    proposed_inserts: summary.proposed_inserts ?? summary.outstanding_eligible ?? null,
    unexplained_current_ids: summary.unexplained_current_production_ids || [],
    disposition_counts: summary.absent_production_disposition_counts || null,
    source_repair_required: result.source_repair_required === true,
    writes: (summary.inserts || 0) + (summary.updates || 0)
  };
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const periodKey = scheduledWeeklyDispatchKey("royal-caribbean-international");
  const before = await loadMaintenanceLockStatus(sb, periodKey);
  const run1 = await runRoyalCaribbeanWeeklyBackgroundMaintenance({
    dryRun: true,
    maxWrites: 1,
    triggerType: "preflight",
    dispatchId: `royal-caribbean:p3f-union-1-${perthIsoWeek()}-${Date.now()}`,
    supabaseClient: sb
  });
  const run2 = await runRoyalCaribbeanWeeklyBackgroundMaintenance({
    dryRun: true,
    maxWrites: 1,
    triggerType: "preflight",
    dispatchId: `royal-caribbean:p3f-union-2-${perthIsoWeek()}-${Date.now()}`,
    supabaseClient: sb
  });
  const after = await loadMaintenanceLockStatus(sb, periodKey);
  const report = {
    generated_at: new Date().toISOString(),
    scheduled_period_key: periodKey,
    scheduled_lease_before: before.held === true,
    scheduled_lease_after: after.held === true,
    scheduled_lease_created_by_preflight: before.held !== true && after.held === true,
    run_1: summarise(run1),
    run_2: summarise(run2)
  };
  const file = path.join(root, "reports", `royal-p3f-unions-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report_file: file, ...report }, null, 2));
  process.exit(report.scheduled_lease_created_by_preflight ? 2 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
