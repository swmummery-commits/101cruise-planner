#!/usr/bin/env node
/**
 * Controlled Explora Journeys production batches. Dry-run is the default and the only
 * mode that runs without explicit opt-in.
 *
 *   node scripts/run-explora-first-production-batch.mjs                      # dry run
 *   node scripts/run-explora-first-production-batch.mjs --dry-run --batch-size=100
 *
 * Writes additionally require ALL of:
 *   EXPLORA_DISCOVERY_WRITE_ENABLED=true
 *   --apply --confirm=EXPLORA-FIRST-PRODUCTION-BATCH
 *   --batch-size=<1..100>
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createMaintenanceSupabase, createSupabaseRest, exactCountSupabase, getSupabaseConfig } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const { runExploraWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const {
  createMaintenanceRun,
  finalizeMaintenanceRun,
  buildMaintenanceRunStats,
  resolveMaintenanceRunStatus
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const { EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));
const { loadMaintenanceLockStatus, weeklyLockKey } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-locks"
));
const postWriteVerification = require(path.join(
  root,
  "netlify/functions/lib/explora-post-write-verification"
));

const EXPLORA_LINE_ID = postWriteVerification.EXPLORA_LINE_ID;
const EXPLORA_LINE_SLUG = "explora-journeys";
const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const HAL_LINE_ID = "a8d0e678-0cb2-4ea7-ad73-251f0eb36ea2";
const CELEBRITY_LINE_ID = "aa2c50ed-7ff5-472d-bc96-3d686d76c5ec";
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 100;
const APPLY_CONFIRMATION_TOKEN = "EXPLORA-FIRST-PRODUCTION-BATCH";
const REPORT_DIR = path.join(root, "reports");

/** Unique local report path per controlled-batch run (avoids overwriting prior apply reports). */
export function buildExploraControlledBatchReportPath(reportDir, runId) {
  const safeRunId = String(runId || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
  return path.join(reportDir, `explora-controlled-batch-${safeRunId}.json`);
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    apply: false,
    idempotency: false,
    verify: false,
    confirm: null,
    batchSize: DEFAULT_BATCH_SIZE
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--idempotency") args.idempotency = true;
    if (arg === "--verify") args.verify = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--batch-size=")) args.batchSize = Number(arg.split("=")[1]);
    if (arg.startsWith("--max-writes=")) args.batchSize = Number(arg.split("=")[1]);
  }
  if (!args.apply && !args.idempotency && !args.verify) args.dryRun = true;
  return args;
}

function assertWriteContract(args, env = process.env) {
  if (String(env.EXPLORA_DISCOVERY_WRITE_ENABLED || "").trim().toLowerCase() !== "true") {
    throw new Error("EXPLORA_DISCOVERY_WRITE_ENABLED must be true for write modes");
  }
  if (args.confirm !== APPLY_CONFIRMATION_TOKEN) {
    throw new Error(`--confirm=${APPLY_CONFIRMATION_TOKEN} is required for write modes`);
  }
  if (!Number.isFinite(args.batchSize) || args.batchSize < 1 || args.batchSize > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size must be between 1 and ${MAX_BATCH_SIZE}`);
  }
}

async function count(query) {
  const { count: value } = await exactCountSupabase(root, "discovered_cruises", query);
  return value;
}

async function baselineCounts() {
  return {
    explora_active: await count(`status=eq.active&cruise_line_id=eq.${EXPLORA_LINE_ID}`),
    princess_active: await count(`status=eq.active&cruise_line_id=eq.${PRINCESS_LINE_ID}`),
    hal_active: await count(`status=eq.active&cruise_line_id=eq.${HAL_LINE_ID}`),
    celebrity_active: await count(`status=eq.active&cruise_line_id=eq.${CELEBRITY_LINE_ID}`)
  };
}

async function runBatch({ dryRun, apply, idempotency, batchSize, triggerType, runIdSuffix }) {
  const sb = createMaintenanceSupabase(root);
  const runId = `explora-${runIdSuffix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const countsBefore = await baselineCounts();
  const writeAttempt = apply || idempotency;

  if (writeAttempt) {
    const lockKey = weeklyLockKey(EXPLORA_LINE_SLUG);
    const held = await loadMaintenanceLockStatus(sb, lockKey);
    if (held.held && held.owner_id && held.owner_id !== runId) {
      throw new Error(`Explora maintenance lock already held by ${held.owner_id} (key: ${lockKey})`);
    }
  }

  let dbRun = null;
  if (writeAttempt) {
    dbRun = await createMaintenanceRun(sb, {
      cruiseLineId: EXPLORA_LINE_ID,
      runId,
      runType: EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE,
      triggerType,
      stats: {
        line_slug: EXPLORA_LINE_SLUG,
        controlled_batch: true,
        max_writes: idempotency ? 0 : batchSize
      }
    });
  }

  const result = await runExploraWeeklyMaintenance({
    dryRun: Boolean(dryRun || idempotency),
    performWrites: Boolean(apply),
    writeMode: apply ? "production_write" : "production_read_only",
    maxWrites: idempotency ? 0 : batchSize,
    runId,
    runRecordId: dbRun?.id || null,
    supabase: sb,
    triggerType
  });

  if (dbRun?.id) {
    const summary = result.summary || {};
    await finalizeMaintenanceRun(sb, dbRun.id, {
      status: resolveMaintenanceRunStatus({ ok: result.ok, summary }),
      stats: buildMaintenanceRunStats(summary, {
        run_type: EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE,
        run_id: runId,
        trigger_type: triggerType,
        controlled_batch: true,
        inventory_changed: (summary.inserts || 0) + (summary.updates || 0) > 0
      })
    });
  }

  const countsAfter = await baselineCounts();
  const insertedIds = (result.write_result?.stats?.write_details || [])
    .filter((d) => d.created || d.result_action === "inserted" || d.recovered_after_fetch_failure)
    .map((d) => d.discovered_cruise_id)
    .filter(Boolean);

  const insertedRows = insertedIds.length
    ? await postWriteVerification.fetchExploraActiveRows(sb, insertedIds)
    : [];

  const report = {
    phase: dryRun ? "dry_run" : idempotency ? "idempotency" : "apply",
    run_id: runId,
    run_record_id: dbRun?.id || null,
    trigger_type: triggerType,
    batch_size: batchSize,
    writes_performed: (result.summary?.inserts || 0) + (result.summary?.updates || 0),
    result_ok: result.ok,
    summary: result.summary || null,
    reconciliation_summary: result.summary
      ? {
          active_production_total: result.summary.active_production_total ?? null,
          eligible_total: result.summary.eligible_total ?? null,
          recognised_existing_eligible:
            result.summary.recognised_existing_eligible ?? result.summary.unchanged ?? null,
          outstanding_eligible_inserts:
            result.summary.outstanding_eligible_inserts ?? result.summary.proposed_inserts ?? null,
          proposed_updates: result.summary.proposed_updates ?? null,
          source_absent_active: result.summary.source_absent_active ?? null,
          reconciliation_arithmetic_ok: result.summary.reconciliation_arithmetic_ok ?? null
        }
      : null,
    quality_gate: result.summary?.quality_gate || null,
    write_result: result.write_result?.stats || null,
    rollback_manifest_id: result.summary?.rollback_manifest_id || null,
    counts_before: countsBefore,
    counts_after: countsAfter,
    inserted_ids: insertedIds,
    inserted_verification: postWriteVerification.verifyInsertedRows(insertedRows),
    explora_active_delta: countsAfter.explora_active - countsBefore.explora_active,
    princess_unchanged: countsAfter.princess_active === countsBefore.princess_active,
    hal_unchanged: countsAfter.hal_active === countsBefore.hal_active,
    celebrity_unchanged: countsAfter.celebrity_active === countsBefore.celebrity_active
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = buildExploraControlledBatchReportPath(REPORT_DIR, runId);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  report.report_path = reportPath;
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  getSupabaseConfig(root);

  let report;
  if (args.verify) {
    const sb = createSupabaseRest(root);
    const rows = await postWriteVerification.fetchExploraActiveRows((query) => sb.get(query));
    report = {
      phase: "verify",
      active_count: rows.length,
      verification: postWriteVerification.verifyInsertedRows(rows)
    };
  } else if (args.apply) {
    assertWriteContract(args);
    report = await runBatch({
      apply: true,
      batchSize: args.batchSize,
      triggerType: "controlled_first_run",
      runIdSuffix: "apply"
    });
    if (!report.result_ok || report.inserted_verification?.ok === false) process.exit(1);
  } else if (args.idempotency) {
    assertWriteContract(args);
    report = await runBatch({
      idempotency: true,
      batchSize: 0,
      triggerType: "idempotency_verification",
      runIdSuffix: "idempotency"
    });
    if (report.explora_active_delta !== 0 || report.writes_performed > 0) process.exit(1);
  } else {
    report = await runBatch({
      dryRun: true,
      batchSize: args.batchSize,
      triggerType: "controlled_dry_run",
      runIdSuffix: "dry-run"
    });
    if (!report.quality_gate?.passed) process.exit(1);
  }

  console.log(JSON.stringify(report, null, 2));
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
