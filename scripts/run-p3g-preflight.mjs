#!/usr/bin/env node
/**
 * Unique-ID P3G preflight. Must not create :scheduled leases.
 *
 *   node scripts/run-p3g-preflight.mjs --line=royal|ncl|carnival|disney|azamara|silversea
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
  royal: {
    slug: "royal-caribbean-international",
    dispatch: async (sb, dispatchId) => {
      const { runRoyalCaribbeanWeeklyBackgroundMaintenance } = require(
        path.join(root, "netlify/functions/lib/royal-caribbean-weekly-maintenance-dispatch")
      );
      return runRoyalCaribbeanWeeklyBackgroundMaintenance({
        dryRun: true,
        maxWrites: 0,
        triggerType: "preflight",
        dispatchId,
        supabaseClient: sb
      });
    }
  },
  ncl: {
    slug: "norwegian-cruise-line",
    dispatch: async (sb, dispatchId) => {
      const { runNorwegianWeeklyBackgroundMaintenance } = require(
        path.join(root, "netlify/functions/lib/norwegian-weekly-maintenance-dispatch")
      );
      process.env.NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED = "true";
      return runNorwegianWeeklyBackgroundMaintenance({
        dryRun: true,
        maxWrites: 0,
        triggerType: "preflight",
        dispatchId,
        supabaseClient: sb
      });
    }
  },
  carnival: {
    slug: "carnival-cruise-line",
    dispatch: async (sb, dispatchId) => {
      const { runCclWeeklyBackgroundMaintenance } = require(
        path.join(root, "netlify/functions/lib/carnival-weekly-maintenance-dispatch")
      );
      return runCclWeeklyBackgroundMaintenance({
        dryRun: true,
        maxWrites: 0,
        triggerType: "preflight",
        dispatchId,
        supabaseClient: sb
      });
    }
  },
  disney: {
    slug: "disney-cruise-line",
    dispatch: async (sb, dispatchId) => {
      const { runDisneyWeeklyMaintenance } = require(
        path.join(root, "netlify/functions/lib/disney-weekly-maintenance")
      );
      return runDisneyWeeklyMaintenance({
        supabase: sb,
        dryRun: true,
        performWrites: false,
        maxWrites: 0,
        triggerType: "preflight",
        runId: dispatchId,
        deadlineMs: 480000
      });
    }
  },
  azamara: {
    slug: "azamara",
    dispatch: async (sb, dispatchId) => {
      const { runAzamaraWeeklyBackgroundMaintenance } = require(
        path.join(root, "netlify/functions/lib/azamara-weekly-maintenance-dispatch")
      );
      return runAzamaraWeeklyBackgroundMaintenance({
        dryRun: true,
        maxWrites: 0,
        triggerType: "preflight",
        dispatchId,
        supabaseClient: sb
      });
    }
  },
  silversea: {
    slug: "silversea-cruises",
    dispatch: async (sb, dispatchId) => {
      const { runSilverseaWeeklyBackgroundMaintenance } = require(
        path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-dispatch")
      );
      return runSilverseaWeeklyBackgroundMaintenance({
        dryRun: true,
        maxWrites: 0,
        triggerType: "preflight",
        dispatchId,
        supabaseClient: sb
      });
    }
  }
};

function compact(result = {}) {
  const summary = result.summary || {};
  return {
    ok: result.ok,
    success: result.success,
    review_required: result.review_required,
    source_repair_required: result.source_repair_required,
    controlled_catchup_required: result.controlled_catchup_required,
    terminal_status: summary.terminal_status || result.terminal_status,
    eligible: summary.eligible_total ?? summary.eligible ?? summary.proposed_new_eligible_sailings ?? null,
    union: summary.union_sailing_identities ?? null,
    proposed_inserts: summary.proposed_inserts ?? null,
    reviews: (summary.review_items || summary.review_sailing_ids || []).length,
    writes: (summary.inserts || 0) + (summary.updates || 0) + (summary.actual_writes || 0),
    unexplained_current: (summary.unexplained_current_production_ids || []).length,
    reason: result.reason || null
  };
}

async function main() {
  if (!SPECS[lineArg]) throw new Error("use --line=royal|ncl|carnival|disney|azamara|silversea");
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const spec = SPECS[lineArg];
  const periodKey = scheduledWeeklyDispatchKey(spec.slug);
  const before = await loadMaintenanceLockStatus(sb, periodKey);
  const dispatchId = `${spec.slug}:p3g-preflight-${perthIsoWeek()}-${Date.now()}`;
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
    result: compact(result)
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
