#!/usr/bin/env node
/**
 * Unique-ID preflight for Explora / Seabourn. Must not create :scheduled leases.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { scheduledWeeklyDispatchKey, perthIsoWeek } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);

const lineArg = process.argv.find((arg) => arg.startsWith("--line="))?.slice("--line=".length);
const SPECS = {
  explora: {
    slug: "explora-journeys",
    dispatch: async (sb, dispatchId) => {
      const { runExploraWeeklyBackgroundMaintenance } = require(
        path.join(root, "netlify/functions/lib/explora-weekly-maintenance-dispatch")
      );
      process.env.EXPLORA_WEEKLY_RECONCILIATION_ENABLED = "true";
      return runExploraWeeklyBackgroundMaintenance({
        dryRun: true,
        maxWrites: 25,
        triggerType: "preflight",
        dispatchId,
        supabaseClient: sb
      });
    }
  },
  seabourn: {
    slug: "seabourn-cruise-line",
    dispatch: async (sb, dispatchId) => {
      const { runSeabournWeeklyBackgroundMaintenance } = require(
        path.join(root, "netlify/functions/lib/seabourn-weekly-maintenance-dispatch")
      );
      process.env.SEABOURN_WEEKLY_RECONCILIATION_ENABLED = "true";
      return runSeabournWeeklyBackgroundMaintenance({
        dryRun: true,
        maxWrites: 20,
        triggerType: "preflight",
        dispatchId,
        supabaseClient: sb
      });
    }
  }
};

async function main() {
  if (!SPECS[lineArg]) throw new Error("use --line=explora|seabourn");
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const spec = SPECS[lineArg];
  const periodKey = scheduledWeeklyDispatchKey(spec.slug);
  const before = await loadMaintenanceLockStatus(sb, periodKey);
  const dispatchId = `${spec.slug}:p3f-preflight-${perthIsoWeek()}-${Date.now()}`;
  const result = await spec.dispatch(sb, dispatchId);
  const after = await loadMaintenanceLockStatus(sb, periodKey);
  const report = {
    line: spec.slug,
    iso_week: perthIsoWeek(),
    dispatch_id: dispatchId,
    trigger_type: "preflight",
    scheduled_period_key: periodKey,
    scheduled_lease_before: before,
    scheduled_lease_after: after,
    scheduled_lease_created_by_preflight: before.held !== true && after.held === true,
    result: {
      ok: result.ok,
      success: result.success,
      review_required: result.review_required,
      terminal_status: result.summary?.terminal_status || result.terminal_status,
      eligible: result.summary?.eligible_total ?? result.summary?.eligible ?? null,
      writes: (result.summary?.inserts || 0) + (result.summary?.updates || 0),
      review_sailing_ids: result.summary?.review_sailing_ids || [],
      reason: result.reason || null
    }
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.scheduled_lease_created_by_preflight) {
    console.error("CRITICAL: preflight created a scheduled lease");
    process.exit(2);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
