#!/usr/bin/env node
/**
 * Execute all batches in the frozen Phase 4B master plan serially.
 * Stops immediately on any batch gate failure.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const REPORT_DIR = path.join(root, "reports");
const MASTER_PLAN_PATH = path.join(REPORT_DIR, "disney-phase4b-catchup-master-plan.json");
const COMPLETE_REPORT_PATH = path.join(REPORT_DIR, "disney-phase4b-complete-catchup.json");

const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const controlled = require(path.join(root, "netlify/functions/lib/disney-controlled-batch"));
const adapter = require(path.join(root, "netlify/functions/lib/disney-discovery-adapter"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { runDisneyPhase4bCatchup } = await import("./run-disney-phase4b-catchup.mjs");

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

async function loadContext(sb) {
  const line = (
    await sb(`ci_cruise_lines?slug=eq.${controlled.DISNEY_LINE_SLUG}&select=id,name,slug&limit=1`)
  )?.[0];
  const existingRows = await sb(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
      line.id
    )}&select=id,status,official_sailing_id,identity_key,external_key,raw_extract`
  );
  return { line, existingRows: existingRows || [] };
}

async function main() {
  const startingSha = git("git rev-parse HEAD");
  if (!fs.existsSync(MASTER_PLAN_PATH)) {
    throw new Error("Run --master-plan and --generate-freezes first");
  }
  const masterPlan = controlled.loadCatchupMasterPlan(JSON.parse(fs.readFileSync(MASTER_PLAN_PATH, "utf8")));
  const sb = createMaintenanceSupabase(root);
  const today = perthCalendarDate();
  const batchResults = [];
  let stopped = false;
  let blocker = null;

  for (const batch of masterPlan.batch_plan) {
    const freezePath = path.join(root, controlled.catchupBatchFreezePath(batch.batch_number));
    console.error(`\n=== Phase 4B batch ${batch.batch_number} (${batch.batch_size} rows) ===`);
    try {
      process.env.DISNEY_DISCOVERY_WRITE_ENABLED = "true";
      const report = await runDisneyPhase4bCatchup({
        args: {
          apply: true,
          batchNumber: batch.batch_number,
          confirm: controlled.CATCHUP_CONFIRMATION_TOKEN,
          frozenReport: freezePath,
          lockSmoke: true,
          preflight: true
        }
      });
      batchResults.push({
        batch_number: batch.batch_number,
        batch_size: batch.batch_size,
        freeze_hash: report.frozen_catchup?.candidate_hash,
        attempted: report.write_result?.attempted,
        inserted: report.write_result?.inserted,
        updated: report.write_result?.updated,
        failed: report.write_result?.failed,
        rollback_manifest_id: report.rollback_manifest?.manifest_record_id,
        verification: report.verification?.verified_count,
        official_count_after: report.official_count_after,
        cumulative_duplicate_skip: report.cumulative_reconciliation?.duplicate_skip,
        remaining_master_plan_inserts: report.remaining_master_plan_inserts,
        global_lock_released: report.global_lock?.global_lock_released === true,
        passed: report.quality_gate?.overall_passed === true
      });
      if (!report.quality_gate?.overall_passed) {
        stopped = true;
        blocker = `batch_${batch.batch_number}_quality_gate_failed`;
        break;
      }
    } catch (err) {
      stopped = true;
      blocker = `batch_${batch.batch_number}:${err.message}`;
      batchResults.push({ batch_number: batch.batch_number, passed: false, error: err.message });
      break;
    }
  }

  const ctx = await loadContext(sb);
  const finalSim = await adapter.simulateDisneyDiscovery({
    cruiseLine: ctx.line,
    ships: [],
    destinations: [],
    today,
    existingRows: ctx.existingRows,
    supabaseQuery: sb
  }).catch(() => null);

  const { official, legacy } = controlled.classifyDisneyProductionRows(ctx.existingRows);
  const duplicateAudit = controlled.auditOfficialDuplicateKeys(ctx.existingRows);
  const legacyImmut = controlled.verifyLegacyImmutability(
    controlled.snapshotLegacyRows(ctx.existingRows),
    ctx.existingRows
  );
  const newSincePlan = finalSim
    ? controlled.computeNewSourceInsertsSinceMasterPlan(finalSim, masterPlan)
    : [];
  const remainingMaster = controlled.remainingMasterPlanIdentities(
    masterPlan,
    new Set(controlled.collectExistingOfficialIds(ctx.existingRows))
  );

  const totalInserted = batchResults.reduce((sum, b) => sum + (b.inserted || 0), 0);
  const complete = !stopped && remainingMaster.length === 0;

  const completeReport = {
    phase: "4B",
    repository: {
      starting_sha: startingSha,
      tooling_sha: startingSha,
      final_report_sha: null
    },
    master_plan_hash: masterPlan.overall_planned_identity_hash,
    master_plan: {
      source_total: masterPlan.source_snapshot_total,
      production_eligible: masterPlan.production_eligible,
      starting_existing_official: masterPlan.existing_official_count,
      planned_inserts: masterPlan.planned_insert_total,
      batch_sizes: masterPlan.batch_plan.map((b) => b.batch_size),
      planned_identities: masterPlan.ordered_planned_identities.length
    },
    batches: batchResults,
    total_phase4b_inserts: totalInserted,
    final: {
      official_production_count: official.length,
      active_official_count: official.filter((r) => r.status === "active").length,
      legacy_count: legacy.length,
      disney_total: ctx.existingRows.length,
      duplicate_skip_count: finalSim
        ? controlled.verifyCumulativeDuplicateSkipReconciliation(finalSim, ctx.existingRows).duplicate_skip
        : null,
      remaining_master_plan_inserts: remainingMaster.length,
      new_source_inserts_since_master_plan: newSincePlan.length,
      duplicate_audit: duplicateAudit,
      legacy_immutability: legacyImmut
    },
    stopped,
    blocker,
    overall_passed: complete && duplicateAudit.passed && legacyImmut.passed,
    complete_current_disney_catchup: complete,
    ready_for_weekly_maintenance: complete && duplicateAudit.passed && legacyImmut.passed && newSincePlan.length === 0
  };

  fs.writeFileSync(COMPLETE_REPORT_PATH, JSON.stringify(completeReport, null, 2));
  console.log(JSON.stringify(completeReport, null, 2));
  if (!completeReport.overall_passed) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ status: "failed", error: err.message }, null, 2));
  process.exit(1);
});
