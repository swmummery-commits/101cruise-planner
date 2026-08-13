#!/usr/bin/env node
/**
 * Seabourn controlled production batches (insert-only).
 * Uses production_write mode — weekly_maintenance blocks when outstanding > weekly cap.
 *
 * First batch when active = 0 (max 20):
 *   node scripts/run-seabourn-first-production-batch.mjs --dry-run --batch-size=20
 *   SEABOURN_DISCOVERY_WRITE_ENABLED=true node scripts/run-seabourn-first-production-batch.mjs \
 *     --apply --confirm=SEABOURN-FIRST-PRODUCTION-BATCH --batch-size=20
 *
 * Catch-up when active > 0 (max 100 per apply):
 *   node scripts/run-seabourn-first-production-batch.mjs --dry-run --batch-size=100
 *   SEABOURN_DISCOVERY_WRITE_ENABLED=true node scripts/run-seabourn-first-production-batch.mjs \
 *     --apply --confirm=SEABOURN-FIRST-PRODUCTION-BATCH --batch-size=100
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

export const FIRST_BATCH_MAX = 20;
export const CATCHUP_MAX = 100;
export const CONTROLLED_BATCH_MAX = 100;
export const APPLY_CONFIRMATION_TOKEN = "SEABOURN-FIRST-PRODUCTION-BATCH";
export const SEABOURN_LINE_SLUG = "seabourn-cruise-line";
const REPORT_DIR = path.join(root, "reports");

const { createMaintenanceSupabase, exactCountSupabase, getSupabaseConfig } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { runSeabournWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const {
  createMaintenanceRun,
  finalizeMaintenanceRun,
  buildMaintenanceRunStats,
  resolveMaintenanceRunStatus
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const { SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));
const { loadMaintenanceLockStatus, weeklyLockKey } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-locks"
));

export function parseArgs(argv = process.argv) {
  const args = { dryRun: false, apply: false, confirm: null, batchSize: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--confirm=")) args.confirm = arg.slice("--confirm=".length);
    if (arg.startsWith("--batch-size=")) args.batchSize = Number(arg.slice("--batch-size=".length));
  }
  if (!args.apply) args.dryRun = true;
  return args;
}

export function resolveMaxBatchSize(activeCount) {
  if (activeCount <= 0) return FIRST_BATCH_MAX;
  return CATCHUP_MAX;
}

export function assertBatchSize(batchSize, activeCount) {
  const n = Number(batchSize);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("batch-size must be >= 1");
  }
  if (n > CONTROLLED_BATCH_MAX) {
    throw new Error(`batch-size must be <= ${CONTROLLED_BATCH_MAX}`);
  }
  if (activeCount <= 0 && n > FIRST_BATCH_MAX) {
    throw new Error(`first batch batch-size must be <= ${FIRST_BATCH_MAX} when active inventory is 0`);
  }
  return n;
}

export function assertApplyAllowed(args, activeCount = 0) {
  if (!args.apply) return assertBatchSize(args.batchSize ?? resolveMaxBatchSize(activeCount), activeCount);
  if (args.confirm !== APPLY_CONFIRMATION_TOKEN) {
    const err = new Error("weekly_apply_confirmation_required");
    err.code = "weekly_apply_confirmation_required";
    throw err;
  }
  if (String(process.env.SEABOURN_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    const err = new Error("SEABOURN_DISCOVERY_WRITE_ENABLED must be true for apply");
    err.code = "seabourn_discovery_write_disabled";
    throw err;
  }
  return assertBatchSize(args.batchSize ?? resolveMaxBatchSize(activeCount), activeCount);
}

export function selectDeterministicBatch(manifest, limit) {
  return (manifest?.products || [])
    .filter((p) => p.proposed_action === "insert_active")
    .sort((a, b) => (a.stable_identity_key || "").localeCompare(b.stable_identity_key || ""))
    .slice(0, limit);
}

export function distributionFromBatch(selected) {
  const shipDist = {};
  const productDist = {};
  for (const row of selected) {
    const ship = row.ship || row.canonical_ship_name || "unknown";
    const pt = row.product_type || "unknown";
    shipDist[ship] = (shipDist[ship] || 0) + 1;
    productDist[pt] = (productDist[pt] || 0) + 1;
  }
  return { shipDist, productDist };
}

export function buildRunContext(activeCount, apply) {
  const catchUp = activeCount > 0;
  const prefix = catchUp ? "seabourn-catchup-batch" : "seabourn-first-batch";
  const triggerApply = catchUp ? "seabourn_catchup_controlled_batch" : "seabourn_first_controlled_batch";
  const triggerDryRun = catchUp
    ? "seabourn_catchup_controlled_batch_dry_run"
    : "seabourn_first_controlled_batch_dry_run";
  const reportPrefix = catchUp ? "seabourn-catchup-controlled-batch" : "seabourn-first-controlled-batch";
  return { catchUp, prefix, triggerApply, triggerDryRun, reportPrefix };
}

export async function runControlledBatch(options = {}) {
  getSupabaseConfig(root);
  const args = options.args || parseArgs(options.argv);
  const sb = options.supabase || createMaintenanceSupabase(root);

  const line = (
    await sb(`ci_cruise_lines?slug=eq.${SEABOURN_LINE_SLUG}&select=id,name,slug&limit=1`)
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${SEABOURN_LINE_SLUG}`);

  const activeCountFn =
    options.activeCountFn ||
    (async () =>
      (await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`))
        .count);

  const startedAt = options.startedAt || new Date().toISOString();
  const countsBefore = { seabourn_active: await activeCountFn() };
  const batchSize = assertApplyAllowed(args, countsBefore.seabourn_active);
  const { catchUp, prefix, triggerApply, triggerDryRun, reportPrefix } = buildRunContext(
    countsBefore.seabourn_active,
    args.apply
  );
  const runId = options.runId || `${prefix}-${startedAt.replace(/[:.]/g, "-")}`;

  const lockKey = weeklyLockKey(SEABOURN_LINE_SLUG);
  if (args.apply) {
    const held = await loadMaintenanceLockStatus(sb, lockKey);
    if (held.held && held.owner_id && held.owner_id !== runId) {
      throw new Error(`Seabourn lock held by ${held.owner_id}`);
    }
  }

  let dbRun = null;
  if (args.apply) {
    dbRun = await createMaintenanceRun(sb, {
      cruiseLineId: line.id,
      runId,
      runType: SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
      triggerType: triggerApply,
      stats: {
        line_slug: SEABOURN_LINE_SLUG,
        controlled_batch: true,
        catch_up_batch: catchUp,
        max_writes: batchSize
      }
    });
  }

  const result = await runSeabournWeeklyMaintenance({
    dryRun: !args.apply,
    performWrites: args.apply,
    writeMode: args.apply ? "production_write" : "production_read_only",
    maxWrites: batchSize,
    runId,
    runRecordId: dbRun?.id || null,
    supabase: sb,
    triggerType: args.apply ? triggerApply : triggerDryRun
  });

  const selectedProducts = selectDeterministicBatch(result.manifest, batchSize);
  const selectedBatch = selectedProducts.map((p) => ({
    official_sailing_id: p.stable_identity_key,
    cruise_id: p.cruise_id || p.official_cruise_id || null,
    itinerary_id: p.itinerary_id || p.official_itinerary_id || null,
    ship: p.canonical_ship_name,
    departure: p.departure_date,
    nights: p.nights,
    embarkation: p.canonical_departure_port || p.official_departure_port,
    destination: p.destination_name,
    product_type: p.product_type,
    source_url: p.source_url
  }));

  const proposedUpdates = (result.manifest?.products || []).filter(
    (p) => p.proposed_action === "update_exact_legacy_match"
  ).length;
  const sourceAbsent = Number(result.summary?.source_absent_active || 0);

  if (args.apply && proposedUpdates > 0) {
    throw new Error(`Refusing apply: ${proposedUpdates} proposed updates (insert-only batch)`);
  }
  if (args.apply && sourceAbsent > 0) {
    throw new Error(`Refusing apply: ${sourceAbsent} source-absent active records`);
  }

  if (dbRun?.id) {
    const summary = result.summary || {};
    await finalizeMaintenanceRun(sb, dbRun.id, {
      status: resolveMaintenanceRunStatus({ ok: result.ok, summary }),
      stats: buildMaintenanceRunStats(summary, {
        run_type: SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
        run_id: runId,
        trigger_type: triggerApply,
        controlled_batch: true,
        catch_up_batch: catchUp,
        inventory_changed: (summary.inserts || 0) + (summary.updates || 0) > 0
      })
    });
  }

  const countsAfter = { seabourn_active: await activeCountFn() };
  const { shipDist, productDist } = distributionFromBatch(selectedBatch);
  const report = {
    phase: args.apply ? "apply" : "dry_run",
    catch_up_batch: catchUp,
    run_id: runId,
    run_record_id: dbRun?.id || null,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    batch_size: batchSize,
    snapshot_id: result.summary?.snapshot_id || null,
    preflight_snapshot_id: result.summary?.snapshot_id || null,
    result_ok: result.ok,
    reason: result.reason || null,
    counts_before: countsBefore,
    counts_after: countsAfter,
    summary: result.summary || null,
    selected_batch: selectedBatch,
    selected_ship_distribution: shipDist,
    selected_product_type_distribution: productDist,
    write_result: result.write_result || null,
    writes_performed: (result.summary?.inserts || 0) + (result.summary?.updates || 0),
    proposed_updates_at_preflight: proposedUpdates,
    source_absent_at_preflight: sourceAbsent
  };

  if (options.writeReport !== false) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `${reportPrefix}-${runId}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    report.report_path = reportPath;
  }

  return report;
}

async function main() {
  try {
    const report = await runControlledBatch();
    console.log(JSON.stringify(report, null, 2));
    if (!report.result_ok) process.exit(1);
  } catch (err) {
    console.error(JSON.stringify({ status: "failed", error: err.code || err.message }, null, 2));
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
