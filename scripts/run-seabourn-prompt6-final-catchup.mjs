#!/usr/bin/env node
/**
 * Prompt 6: sequential Seabourn final catch-up orchestrator.
 * Uses canonical runControlledBatch — does not implement its own write path.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { runControlledBatch, parseArgs, CATCHUP_MAX, APPLY_CONFIRMATION_TOKEN } from "./run-seabourn-first-production-batch.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
try { require("dotenv").config({ path: path.join(root, ".env") }); } catch {}
try { require("dotenv").config({ path: path.join(root, ".env.local") }); } catch {}

const { assessSeabournCatchUpSafety } = require(path.join(
  root,
  "netlify/functions/lib/seabourn-source-absence"
));
const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { runSeabournWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const weeklyMaint = await import(path.join(root, "scripts/run-seabourn-weekly-maintenance.mjs"));

const REPORT_DIR = path.join(root, "reports");
const MASTER_PATH = path.join(REPORT_DIR, `seabourn-prompt6a-master-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

async function productionCheckpoint(sb, lineId) {
  const active = (await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${lineId}&status=eq.active`)).count;
  const activeRows = await sb(
    `discovered_cruises?cruise_line_id=eq.${lineId}&status=eq.active&select=official_sailing_id&order=official_sailing_id.asc`
  );
  const sailingCounts = {};
  for (const r of activeRows || []) sailingCounts[r.official_sailing_id] = (sailingCounts[r.official_sailing_id] || 0) + 1;
  const dups = Object.entries(sailingCounts).filter(([, c]) => c > 1);
  const legacy = await sb(
    `discovered_cruises?cruise_line_id=eq.${lineId}&status=in.(hidden,match_required,validation_failed)&select=status`
  );
  const legacyCounts = {};
  for (const r of legacy || []) legacyCounts[r.status] = (legacyCounts[r.status] || 0) + 1;
  return { active, dups, legacyCounts, sailingIds: (activeRows || []).map((r) => r.official_sailing_id) };
}

async function verifyBatch(sb, lineId, selected, writeDetails) {
  const ships = await sb(`ci_cruise_ships?cruise_line_id=eq.${lineId}&select=id,name`);
  const shipMap = Object.fromEntries((ships || []).map((s) => [s.id, s.name]));
  const dests = await sb("destinations?select=id,name");
  const destMap = Object.fromEntries((dests || []).map((d) => [d.id, d.name]));
  const succeeded = (writeDetails || []).filter((d) => d.created || d.result_action === "inserted");
  const results = { expected: succeeded.length, found: 0, missing: [], duplicate: [], mismatched: [] };
  for (const detail of succeeded) {
    const sid = detail.seabourn_sailing_id;
    const expected = selected.find((s) => s.official_sailing_id === sid);
    const rows = await sb(
      `discovered_cruises?cruise_line_id=eq.${lineId}&official_sailing_id=eq.${encodeURIComponent(sid)}&select=id,status,official_sailing_id,departure_date,nights,departure_port,ship_id,destination_id,raw_extract&limit=5`
    );
    if (!rows?.length) { results.missing.push(sid); continue; }
    if (rows.length > 1) { results.duplicate.push({ sid, count: rows.length }); continue; }
    const row = rows[0];
    const issues = [];
    if (row.status !== "active") issues.push("status");
    if (expected?.departure && row.departure_date?.slice(0, 10) !== expected.departure) issues.push("departure");
    if (expected?.nights != null && row.nights != null && Number(row.nights) !== Number(expected.nights)) issues.push("nights");
    const shipName = shipMap[row.ship_id];
    if (expected?.ship && shipName && !shipName.includes(expected.ship)) issues.push("ship");
    if (issues.length) results.mismatched.push({ sid, issues });
    else results.found += 1;
  }
  results.all_pass = !results.missing.length && !results.duplicate.length && !results.mismatched.length;
  return results;
}

function gateOk(summary) {
  const catchUpGate = assessSeabournCatchUpSafety({
    sourceAbsencePolicy: summary?.source_absence_policy || {
      source_absent_observed: summary?.source_absent_observed ?? summary?.source_absent_active ?? 0,
      source_absent_actionable: summary?.source_absent_actionable ?? 0
    },
    activeProductionTotal: summary?.active_production_total ?? 0,
    sourceQualityGatePassed: summary?.source_quality_gate?.passed !== false,
    reconciliationArithmeticOk:
      summary?.reconciliation_arithmetic_ok !== false &&
      summary?.active_production_arithmetic_ok !== false,
    proposedUpdates: summary?.proposed_updates ?? 0
  });
  return summary?.result_ok !== false
    && summary?.source_quality_gate?.passed !== false
    && summary?.quality_gate?.passed !== false
    && catchUpGate.ok
    && Number(summary?.proposed_updates || 0) === 0;
}

async function runPostWriteDryRun(sb, line) {
  const startedAt = new Date().toISOString();
  const activeCount = async () =>
    (await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`)).count;
  const countsBefore = { seabourn: await activeCount() };
  const result = await runSeabournWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    writeMode: "production_read_only",
    maxWrites: 0,
    runId: `seabourn-weekly-${startedAt.replace(/[:.]/g, "-")}`,
    supabase: sb,
    triggerType: "weekly_dry_run"
  });
  const countsAfter = { seabourn: await activeCount() };
  const report = weeklyMaint.buildWeeklyMaintenanceReport({
    mode: "dry_run",
    startedAt,
    endedAt: new Date().toISOString(),
    environment: weeklyMaint.classifyExecutionEnvironment(process.env, { applyMode: false }),
    result,
    countsBefore,
    countsAfter
  });
  const { filePath } = weeklyMaint.writeWeeklyMaintenanceReportFile(report);
  report.report_path = filePath;
  return report;
}

async function shipProductInventory(sb, lineId) {
  const rows = await sb(
    `discovered_cruises?cruise_line_id=eq.${lineId}&status=eq.active&select=ship_id,raw_extract,ci_cruise_ships(name)&limit=500`
  );
  const shipDist = {};
  const productDist = {};
  for (const r of rows || []) {
    const ship = r.ci_cruise_ships?.name?.replace(/^Seabourn\s+/i, "") || "unknown";
    const pt = r.raw_extract?.product_type || r.raw_extract?.seabourn_product_type || "unknown";
    shipDist[ship] = (shipDist[ship] || 0) + 1;
    productDist[pt] = (productDist[pt] || 0) + 1;
  }
  return { shipDist, productDist, active: rows?.length || 0 };
}

async function main() {
  const sb = createMaintenanceSupabase(root);
  const line = (await sb("ci_cruise_lines?slug=eq.seabourn-cruise-line&select=id&limit=1"))[0];
  const master = {
    prompt: 6,
    catchup_support_sha: "d5fcb420aa241486b4005ba4d1dec3eb53d2ec8e",
    started_at: new Date().toISOString(),
    pre_checkpoint: await productionCheckpoint(sb, line.id),
    batches: [],
    totals: { inserts: 0, updates: 0, deactivations: 0, deletes: 0 },
    stopped: false,
    stop_reason: null
  };

  if (master.pre_checkpoint.active < 120) {
    master.stopped = true;
    master.stop_reason = `unexpected_active_count_${master.pre_checkpoint.active}`;
    fs.writeFileSync(MASTER_PATH, JSON.stringify(master, null, 2));
    console.error(JSON.stringify(master, null, 2));
    process.exit(1);
  }

  let batchNum = 0;
  while (true) {
    batchNum += 1;
    const activeBefore = (await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`)).count;

    const preDry = await runControlledBatch({
      args: parseArgs(["node", "x", "--dry-run", `--batch-size=${CATCHUP_MAX}`]),
      writeReport: true
    });
    const preSummary = preDry.summary || {};
    const outstanding = Number(preSummary.outstanding_eligible_inserts || 0);
    const preOutstanding = outstanding;

    if (!preDry.result_ok || !gateOk(preSummary)) {
      master.stopped = true;
      master.stop_reason = `preflight_gate_fail_batch_${batchNum}`;
      master.batches.push({
        batchNum,
        phase: "preflight_fail",
        observed_absent: preSummary.source_absent_observed ?? 0,
        actionable_absent: preSummary.source_absent_actionable ?? 0,
        preDry
      });
      break;
    }
    if (outstanding <= 0) {
      master.completed = true;
      master.stop_reason = "outstanding_zero";
      break;
    }

    const batchSize = Math.min(CATCHUP_MAX, outstanding);
    if (batchSize !== CATCHUP_MAX && batchSize !== outstanding) {
      master.stopped = true;
      master.stop_reason = "invalid_batch_size_selection";
      break;
    }

    const applyArgs = parseArgs([
      "node", "x", "--apply",
      `--confirm=${APPLY_CONFIRMATION_TOKEN}`,
      `--batch-size=${batchSize}`
    ]);
    process.env.SEABOURN_DISCOVERY_WRITE_ENABLED = "true";
    let applyReport;
    try {
      applyReport = await runControlledBatch({ args: applyArgs, writeReport: true });
    } finally {
      delete process.env.SEABOURN_DISCOVERY_WRITE_ENABLED;
    }

    const succeeded = Number(applyReport.summary?.inserts || 0);
    const failed = Number(applyReport.summary?.failed_writes || 0);
    const updates = Number(applyReport.summary?.updates || 0);
    const activeAfter = (await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`)).count;
    const verify = await verifyBatch(sb, line.id, applyReport.selected_batch, applyReport.write_result?.stats?.write_details);

    const postDry = await runPostWriteDryRun(sb, line);
    const postSummary = postDry?.summary || {};
    const postOutstanding = Number(postSummary.outstanding_eligible_inserts ?? 0);
    const postEligible = Number(postSummary.eligible_total ?? 0);
    const preEligible = Number(preSummary.eligible_total || 0);
    const sourceDelta = postEligible - preEligible;
    const expectedPostOutstanding = preOutstanding - succeeded + Math.max(0, sourceDelta);
    const reconciles = postOutstanding === expectedPostOutstanding || postOutstanding === preOutstanding - succeeded + sourceDelta;

    const batchRecord = {
      batchNum,
      pre_outstanding: preOutstanding,
      observed_absent: preSummary.source_absent_observed ?? 0,
      actionable_absent: preSummary.source_absent_actionable ?? 0,
      pre_eligible: preEligible,
      selected: batchSize,
      attempted: Number(applyReport.summary?.write_attempts || batchSize),
      succeeded,
      failed,
      updates,
      deactivations: 0,
      deletes: 0,
      active_before: activeBefore,
      active_after: activeAfter,
      active_reconciles: activeBefore + succeeded === activeAfter,
      post_outstanding: postOutstanding,
      post_eligible: postEligible,
      source_delta_eligible: sourceDelta,
      outstanding_reconciles: reconciles,
      rollback_manifest_id: applyReport.summary?.rollback_manifest_id,
      pre_dry_run: preDry.report_path,
      apply_report: applyReport.report_path,
      post_dry_run: postDry?.report_path,
      verify,
      idempotency_ok: postSummary.recognised_existing_eligible >= activeAfter && Number(postSummary.proposed_updates || 0) === 0,
      ship_distribution: applyReport.selected_ship_distribution
    };

    master.batches.push(batchRecord);
    master.totals.inserts += succeeded;
    master.totals.updates += updates;

    fs.writeFileSync(MASTER_PATH, JSON.stringify(master, null, 2));

    if (failed > 0 || updates > 0 || !applyReport.result_ok || !verify.all_pass || !batchRecord.active_reconciles || !gateOk(postSummary)) {
      master.stopped = true;
      master.stop_reason = !applyReport.result_ok
        ? `batch_${batchNum}_apply_failed_${applyReport.reason || "unknown"}`
        : `batch_${batchNum}_integrity_fail`;
      break;
    }
    if (postOutstanding <= 0) {
      master.completed = true;
      break;
    }
  }

  master.final_checkpoint = await productionCheckpoint(sb, line.id);
  master.final_inventory = await shipProductInventory(sb, line.id);
  master.ended_at = new Date().toISOString();
  fs.writeFileSync(MASTER_PATH, JSON.stringify(master, null, 2));
  console.log(JSON.stringify({ master_path: MASTER_PATH, ...master }, null, 2));
  if (master.stopped && !master.completed) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ status: "failed", error: err.message }, null, 2));
  process.exit(1);
});
