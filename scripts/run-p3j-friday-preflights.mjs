#!/usr/bin/env node
/**
 * P3J Friday Azamara + Silversea READ-ONLY preflights.
 * Unique preflight namespace. Must not claim Friday scheduled leases.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const { scheduledWeeklyDispatchKey, perthIsoWeek } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);
const { runAzamaraWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/azamara-weekly-maintenance")
);
const { runSilverseaWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/silversea-weekly-maintenance")
);

async function leaseSnapshot(sb, slug) {
  return loadMaintenanceLockStatus(sb, scheduledWeeklyDispatchKey(slug));
}

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const week = perthIsoWeek();
  const azBefore = await leaseSnapshot(sb, "azamara");
  const ssBefore = await leaseSnapshot(sb, "silversea-cruises");

  const azRunId = `azamara:p3j-friday-preflight-${week}-${Date.now()}`;
  const az = await runAzamaraWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    runId: azRunId,
    triggerType: "preflight"
  });

  const ssRunId = `silversea:p3j-friday-preflight-${week}-${Date.now()}`;
  const ss = await runSilverseaWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    runId: ssRunId
  });

  const azAfter = await leaseSnapshot(sb, "azamara");
  const ssAfter = await leaseSnapshot(sb, "silversea-cruises");
  const report = {
    generated_at: new Date().toISOString(),
    azamara: {
      run_id: azRunId,
      eligible: az.summary?.eligible_total ?? az.summary?.production_eligible_total ?? az.summary?.source_total,
      source_total: az.summary?.source_total ?? az.summary?.official_source_total,
      terminal_status: az.terminal_status || az.summary?.terminal_status,
      collapse_gate: az.summary?.collapse_guard?.collapse_gate_passed ?? az.collapse_guard?.collapse_gate_passed,
      writes: az.summary?.writes_performed ?? 0,
      reason: az.reason || az.summary?.reason,
      scheduled_lease_before_held: azBefore.held === true,
      scheduled_lease_after_held: azAfter.held === true,
      scheduled_lease_created: azBefore.held !== true && azAfter.held === true,
      friday_readiness:
        Number(az.summary?.source_total || az.summary?.official_source_total || 0) > 0 &&
        az.summary?.collapse_guard?.collapse_gate_passed !== false
          ? "LEAVE_FRIDAY_CRON"
          : "SOURCE_REPAIR_BEFORE_FRIDAY"
    },
    silversea: {
      run_id: ssRunId,
      review: ss.summary?.proposed_updates_identity_review ?? ss.plan?.review?.length ?? ss.report?.review_count,
      terminal_status: ss.terminal_status || ss.summary?.terminal_status || ss.status,
      writes: ss.writeStats || ss.summary?.writes_performed || 0,
      scheduled_lease_before_held: ssBefore.held === true,
      scheduled_lease_after_held: ssAfter.held === true,
      scheduled_lease_created: ssBefore.held !== true && ssAfter.held === true,
      friday_readiness: "READ_ONLY_LEAVE_CRON"
    }
  };
  const file = path.join(root, "reports", `p3j-friday-preflights-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report_file: file, ...report }, null, 2));
  if (report.azamara.scheduled_lease_created || report.silversea.scheduled_lease_created) process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
