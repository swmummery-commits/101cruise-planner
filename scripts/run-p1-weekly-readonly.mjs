#!/usr/bin/env node
/**
 * P1 production-equivalent READ-ONLY weekly maintenance into the central ledger.
 * Never enables write flags. Never --apply.
 *
 *   node scripts/run-p1-weekly-readonly.mjs --line=silversea
 *   node scripts/run-p1-weekly-readonly.mjs --line=celebrity
 *   node scripts/run-p1-weekly-readonly.mjs --line=hal
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { executeWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-cron"
));
const {
  runHalWeeklyMaintenance,
  runCelebrityWeeklyMaintenance,
  runPrincessWeeklyMaintenance,
  runExploraWeeklyMaintenance,
  runSeabournWeeklyMaintenance
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner"));
const { runSilverseaWeeklyBackgroundMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/silversea-weekly-maintenance-dispatch"
));
const {
  HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
  PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
  EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE,
  SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));

const LINES = {
  silversea: { slug: "silversea-cruises", kind: "silversea" },
  celebrity: {
    slug: "celebrity-cruises",
    runType: CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
    runMaintenance: runCelebrityWeeklyMaintenance
  },
  hal: {
    slug: "holland-america-line",
    runType: HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
    runMaintenance: runHalWeeklyMaintenance
  },
  princess: {
    slug: "princess-cruises",
    runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    runMaintenance: runPrincessWeeklyMaintenance
  },
  explora: {
    slug: "explora-journeys",
    runType: EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE,
    runMaintenance: runExploraWeeklyMaintenance
  },
  seabourn: {
    slug: "seabourn-cruise-line",
    runType: SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
    runMaintenance: runSeabournWeeklyMaintenance
  }
};

function parseArgs(argv) {
  const lineArg = argv.find((arg) => arg.startsWith("--line="));
  const line = String(lineArg?.slice("--line=".length) || "")
    .trim()
    .toLowerCase();
  if (!LINES[line]) {
    throw new Error(`--line must be one of ${Object.keys(LINES).join(", ")}`);
  }
  return { line };
}

async function main() {
  getSupabaseConfig(root);
  const { line } = parseArgs(process.argv.slice(2));
  const spec = LINES[line];
  const sb = createMaintenanceSupabase(root);
  const triggerType = "p1_readonly";

  let result;
  if (spec.kind === "silversea") {
    result = await runSilverseaWeeklyBackgroundMaintenance({
      dryRun: true,
      triggerType,
      dispatchId: `p1-silversea-readonly-${Date.now()}`,
      supabaseClient: sb
    });
  } else {
    const row = (await sb(`ci_cruise_lines?slug=eq.${spec.slug}&select=id,slug&limit=1`))?.[0];
    if (!row) throw new Error(`line not found: ${spec.slug}`);
    result = await executeWeeklyMaintenance({
      lineSlug: spec.slug,
      cruiseLineId: row.id,
      runType: spec.runType,
      assertEnabled: () => {},
      runMaintenance: spec.runMaintenance,
      dryRun: true,
      maxWrites: 100,
      triggerType,
      supabaseClient: sb
    });
  }

  const writes =
    Number(result.summary?.inserts || 0) +
    Number(result.summary?.updates || 0) +
    Number(result.summary?.promoted_active || 0);
  if (writes !== 0) {
    throw new Error(`readonly run committed writes=${writes}`);
  }

  const out = {
    line,
    dry_run: true,
    writes: 0,
    run_id: result.run_id || result.summary?.run_id || null,
    run_record_id: result.run_record_id || null,
    ok: result.success !== false && result.ok !== false,
    summary: result.summary || result.report || result
  };
  const file = path.join(root, "reports", `${line}-weekly-readonly-p1-pass2-2026-09-01.json`);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ report_path: file, ...out, summary: compact(out.summary) }, null, 2));
}

function compact(summary = {}) {
  return {
    run_id: summary.run_id,
    run_type: summary.run_type,
    dry_run: summary.dry_run,
    eligible_total: summary.eligible_total,
    active_production_total: summary.active_production_total,
    proposed_inserts: summary.proposed_inserts,
    proposed_updates: summary.proposed_updates,
    source_absent_active: summary.source_absent_active,
    snapshot_id: summary.snapshot_id || summary.source_snapshot_id,
    quality_gate: summary.quality_gate,
    inserts: summary.inserts || 0,
    updates: summary.updates || 0,
    inventory_changed: summary.inventory_changed,
    silversea_report_status: summary.silversea_report_status || null,
    source_healthy: summary.source?.healthy ?? summary.orchestration?.gates?.source_healthy ?? null
  };
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
  process.exit(1);
});
