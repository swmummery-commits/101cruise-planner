#!/usr/bin/env node
/**
 * Seabourn first controlled production batch (insert-only, max 20).
 * Uses production_write mode — weekly_maintenance blocks when outstanding > weekly cap.
 *
 *   node scripts/run-seabourn-first-production-batch.mjs --dry-run
 *   SEABOURN_DISCOVERY_WRITE_ENABLED=true node scripts/run-seabourn-first-production-batch.mjs \
 *     --apply --confirm=SEABOURN-FIRST-PRODUCTION-BATCH --batch-size=20
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

const FIRST_BATCH_MAX = 20;
const APPLY_CONFIRMATION_TOKEN = "SEABOURN-FIRST-PRODUCTION-BATCH";
const SEABOURN_LINE_SLUG = "seabourn-cruise-line";
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

function parseArgs(argv = process.argv) {
  const args = { dryRun: false, apply: false, confirm: null, batchSize: FIRST_BATCH_MAX };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--confirm=")) args.confirm = arg.slice("--confirm=".length);
    if (arg.startsWith("--batch-size=")) args.batchSize = Number(arg.slice("--batch-size=".length));
  }
  if (!args.apply) args.dryRun = true;
  return args;
}

function assertApplyAllowed(args) {
  if (!args.apply) return;
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
  const n = Number(args.batchSize);
  if (!Number.isFinite(n) || n < 1 || n > FIRST_BATCH_MAX) {
    throw new Error(`batch-size must be 1..${FIRST_BATCH_MAX}`);
  }
}

function selectDeterministicBatch(manifest, limit) {
  return (manifest?.products || [])
    .filter((p) => p.proposed_action === "insert_active")
    .sort((a, b) => (a.stable_identity_key || "").localeCompare(b.stable_identity_key || ""))
    .slice(0, limit);
}

async function main() {
  getSupabaseConfig(root);
  const args = parseArgs();
  assertApplyAllowed(args);

  const sb = createMaintenanceSupabase(root);
  const line = (
    await sb(`ci_cruise_lines?slug=eq.${SEABOURN_LINE_SLUG}&select=id,name,slug&limit=1`)
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${SEABOURN_LINE_SLUG}`);

  const activeCount = async () =>
    (await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`))
      .count;

  const startedAt = new Date().toISOString();
  const runId = `seabourn-first-batch-${startedAt.replace(/[:.]/g, "-")}`;
  const countsBefore = { seabourn_active: await activeCount() };

  if (args.apply && countsBefore.seabourn_active >= FIRST_BATCH_MAX) {
    throw new Error(
      `First controlled batch already present (${countsBefore.seabourn_active} active). Stop after first batch.`
    );
  }

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
      triggerType: "seabourn_first_controlled_batch",
      stats: {
        line_slug: SEABOURN_LINE_SLUG,
        controlled_batch: true,
        max_writes: args.batchSize
      }
    });
  }

  const result = await runSeabournWeeklyMaintenance({
    dryRun: !args.apply,
    performWrites: args.apply,
    writeMode: args.apply ? "production_write" : "production_read_only",
    maxWrites: args.batchSize,
    runId,
    runRecordId: dbRun?.id || null,
    supabase: sb,
    triggerType: args.apply ? "seabourn_first_controlled_batch" : "seabourn_first_controlled_batch_dry_run"
  });

  const selected = selectDeterministicBatch(result.manifest, args.batchSize);
  const proposedUpdates = (result.manifest?.products || []).filter(
    (p) => p.proposed_action === "update_exact_legacy_match"
  ).length;

  if (args.apply && proposedUpdates > 0) {
    throw new Error(`Refusing apply: ${proposedUpdates} proposed updates (insert-only batch)`);
  }

  if (dbRun?.id) {
    const summary = result.summary || {};
    await finalizeMaintenanceRun(sb, dbRun.id, {
      status: resolveMaintenanceRunStatus({ ok: result.ok, summary }),
      stats: buildMaintenanceRunStats(summary, {
        run_type: SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
        run_id: runId,
        trigger_type: "seabourn_first_controlled_batch",
        controlled_batch: true,
        inventory_changed: (summary.inserts || 0) + (summary.updates || 0) > 0
      })
    });
  }

  const countsAfter = { seabourn_active: await activeCount() };
  const report = {
    phase: args.apply ? "apply" : "dry_run",
    run_id: runId,
    run_record_id: dbRun?.id || null,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    batch_size: args.batchSize,
    snapshot_id: result.summary?.snapshot_id || null,
    preflight_snapshot_id: result.summary?.snapshot_id || null,
    result_ok: result.ok,
    reason: result.reason || null,
    counts_before: countsBefore,
    counts_after: countsAfter,
    summary: result.summary || null,
    selected_batch: selected.map((p) => ({
      official_sailing_id: p.stable_identity_key,
      ship: p.canonical_ship_name,
      departure: p.departure_date,
      nights: p.nights,
      embarkation: p.canonical_departure_port || p.official_departure_port,
      destination: p.destination_name,
      product_type: p.product_type,
      source_url: p.source_url
    })),
    write_result: result.write_result || null,
    writes_performed: (result.summary?.inserts || 0) + (result.summary?.updates || 0),
    proposed_updates_at_preflight: proposedUpdates
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `seabourn-first-controlled-batch-${runId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  report.report_path = reportPath;

  console.log(JSON.stringify(report, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ status: "failed", error: err.code || err.message }, null, 2));
  process.exit(1);
});
