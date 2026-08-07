#!/usr/bin/env node
/**
 * Controlled Princess production batches.
 *
 * First batch (max 20):
 *   PRINCESS_DISCOVERY_WRITE_ENABLED=true node scripts/run-princess-first-production-batch.mjs --dry-run
 *   PRINCESS_DISCOVERY_WRITE_ENABLED=true node scripts/run-princess-first-production-batch.mjs --apply
 *   PRINCESS_DISCOVERY_WRITE_ENABLED=true node scripts/run-princess-first-production-batch.mjs --idempotency
 *
 * Catch-up batch (max 100, explicit checkpoint):
 *   node scripts/run-princess-first-production-batch.mjs --dry-run
 *   PRINCESS_DISCOVERY_WRITE_ENABLED=true node scripts/run-princess-first-production-batch.mjs \
 *     --next-batch --apply \
 *     --expected-active-count=20 \
 *     --expected-snapshot-id=<SNAPSHOT_ID> \
 *     --max-writes=100
 *   PRINCESS_DISCOVERY_WRITE_ENABLED=true node scripts/run-princess-first-production-batch.mjs \
 *     --next-batch --catch-up-idempotency \
 *     --expected-active-count=120 \
 *     --expected-snapshot-id=<SNAPSHOT_ID>
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { createMaintenanceSupabase, createSupabaseRest, getSupabaseConfig } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const {
  createMaintenanceRun,
  finalizeMaintenanceRun,
  buildMaintenanceRunStats
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const { PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));
const {
  loadMaintenanceLockStatus,
  weeklyLockKey
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const { publicBookingMinimumDepartureDate, perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const HAL_LINE_ID = "a8d0e678-0cb2-4ea7-ad73-251f0eb36ea2";
const FIRST_BATCH_MAX = 20;
const CATCHUP_MAX = 100;
const REPORT_DIR = path.join(root, "reports");

function parseArgs(argv) {
  const args = {
    dryRun: false,
    apply: false,
    idempotency: false,
    catchUpIdempotency: false,
    verify: false,
    nextBatch: false,
    expectedActiveCount: null,
    expectedSnapshotId: null,
    maxWrites: null
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--idempotency") args.idempotency = true;
    if (arg === "--catch-up-idempotency") args.catchUpIdempotency = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--next-batch") args.nextBatch = true;
    if (arg.startsWith("--expected-active-count=")) {
      args.expectedActiveCount = Number(arg.split("=")[1]);
    }
    if (arg.startsWith("--expected-snapshot-id=")) {
      args.expectedSnapshotId = String(arg.split("=")[1]).trim();
    }
    if (arg.startsWith("--max-writes=")) {
      args.maxWrites = Number(arg.split("=")[1]);
    }
  }
  if (!args.dryRun && !args.apply && !args.idempotency && !args.catchUpIdempotency && !args.verify) {
    args.dryRun = true;
  }
  return args;
}

function validateNextBatchArgs(args, { requireMaxWrites = false } = {}) {
  if (!args.nextBatch) return;
  if (args.expectedActiveCount == null || Number.isNaN(args.expectedActiveCount)) {
    throw new Error("--next-batch requires --expected-active-count=<number>");
  }
  if (!args.expectedSnapshotId) {
    throw new Error("--next-batch requires --expected-snapshot-id=<snapshot_id>");
  }
  if (requireMaxWrites) {
    if (args.maxWrites == null || Number.isNaN(args.maxWrites)) {
      throw new Error("--next-batch --apply requires --max-writes=<number>");
    }
    if (args.maxWrites < 1 || args.maxWrites > CATCHUP_MAX) {
      throw new Error(`--max-writes must be between 1 and ${CATCHUP_MAX}`);
    }
  }
}

async function headCount(table, query = "") {
  const https = require("https");
  const { url, key } = getSupabaseConfig(root);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${table}?select=id${query ? `&${query}` : ""}`);
    https
      .request(
        u,
        { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } },
        (res) => {
          const range = res.headers["content-range"] || "";
          const m = range.match(/\/(\d+)/);
          resolve(m ? Number(m[1]) : 0);
        }
      )
      .on("error", reject)
      .end();
  });
}

async function baselineCounts() {
  return {
    princess_active: await headCount(
      "discovered_cruises",
      `status=eq.active&cruise_line_id=eq.${PRINCESS_LINE_ID}`
    ),
    hal_active: await headCount("discovered_cruises", `status=eq.active&cruise_line_id=eq.${HAL_LINE_ID}`),
    celebrity_active: await headCount(
      "discovered_cruises",
      `status=eq.active&cruise_line_id=eq.aa2c50ed-7ff5-472d-bc96-3d686d76c5ec`
    ),
    manifests: await headCount("cruise_discovery_maintenance_manifests")
  };
}

async function fetchPrincessActiveRows(sb, ids = null) {
  if (ids?.length) {
    return sb.get(
      `discovered_cruises?id=in.(${ids.join(",")})&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,official_url,official_sailing_id,status,raw_extract`
    );
  }
  return sb.get(
    `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,official_url,official_sailing_id,status,raw_extract&order=created_at.desc`
  );
}

function verifyInsertedRows(rows) {
  const minDep = publicBookingMinimumDepartureDate(perthCalendarDate());
  const issues = [];
  for (const row of rows || []) {
    if (row.cruise_line_id !== PRINCESS_LINE_ID) issues.push({ id: row.id, issue: "wrong_line" });
    if (!row.cruise_line_id) issues.push({ id: row.id, issue: "null_cruise_line_id" });
    if (row.status !== "active") issues.push({ id: row.id, issue: "not_active" });
    if (!row.official_sailing_id) issues.push({ id: row.id, issue: "missing_official_sailing_id" });
    if (!row.ship_id) issues.push({ id: row.id, issue: "missing_ship_id" });
    if (!row.destination_id) issues.push({ id: row.id, issue: "missing_destination_id" });
    if (!row.departure_port) issues.push({ id: row.id, issue: "missing_departure_port" });
    if (!row.official_url) issues.push({ id: row.id, issue: "missing_official_url" });
    if (String(row.departure_date).slice(0, 10) < minDep) {
      issues.push({ id: row.id, issue: "inside_21_day_cutoff", departure_date: row.departure_date, minDep });
    }
    if (row.raw_extract?.princess_product_type === "cruisetour") {
      issues.push({ id: row.id, issue: "cruisetour" });
    }
    if (!String(row.official_url || "").includes("princess.com")) {
      issues.push({ id: row.id, issue: "invalid_official_url" });
    }
  }
  return { ok: issues.length === 0, issues, minDeparture: minDep };
}

async function preflightNextBatch(sb, { expectedActiveCount, expectedSnapshotId, runId }) {
  const counts = await baselineCounts();
  if (counts.princess_active !== expectedActiveCount) {
    return {
      ok: false,
      aborted: true,
      reason: "expected_active_count_mismatch",
      expected_active_count: expectedActiveCount,
      actual_active_count: counts.princess_active,
      writes_performed: false
    };
  }

  const held = await loadMaintenanceLockStatus(sb, weeklyLockKey("princess-cruises"));
  if (held.held && held.owner_id && held.owner_id !== runId) {
    return {
      ok: false,
      aborted: true,
      reason: "maintenance_lock_held",
      lock_owner: held.owner_id,
      writes_performed: false
    };
  }

  const dry = await runPrincessWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    maxWrites: 0,
    runId: `${runId}-preflight`,
    supabase: sb,
    triggerType: "catch_up_preflight"
  });

  const snapshotId = dry.summary?.snapshot_id || null;
  if (snapshotId !== expectedSnapshotId) {
    return {
      ok: false,
      aborted: true,
      reason: "expected_snapshot_id_mismatch",
      expected_snapshot_id: expectedSnapshotId,
      actual_snapshot_id: snapshotId,
      dry_run_summary: dry.summary || null,
      writes_performed: false
    };
  }

  if (!dry.summary?.quality_gate?.passed) {
    return {
      ok: false,
      aborted: true,
      reason: "quality_gate_failed",
      quality_gate: dry.summary?.quality_gate || null,
      writes_performed: false
    };
  }

  return { ok: true, counts, dry_run_summary: dry.summary, snapshot_id: snapshotId };
}

async function runBatch({
  dryRun,
  apply,
  idempotency,
  catchUpIdempotency,
  nextBatch,
  expectedActiveCount,
  expectedSnapshotId,
  maxWrites,
  triggerType,
  runIdSuffix
}) {
  const sb = createMaintenanceSupabase(root);
  const runId = `princess-${runIdSuffix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const countsBefore = await baselineCounts();
  const lockKey = weeklyLockKey("princess-cruises");
  const effectiveMaxWrites = nextBatch ? maxWrites : FIRST_BATCH_MAX;
  const writeAttempt = apply || idempotency || catchUpIdempotency;

  if (apply && !nextBatch && countsBefore.princess_active >= FIRST_BATCH_MAX) {
    throw new Error(
      `Controlled Princess first batch already present (${countsBefore.princess_active} active). ` +
        "Use --next-batch with explicit checkpoints for later batches."
    );
  }

  if (apply && nextBatch) {
    validateNextBatchArgs(
      { nextBatch, expectedActiveCount, expectedSnapshotId, maxWrites },
      { requireMaxWrites: true }
    );
  }

  if ((idempotency || catchUpIdempotency) && nextBatch) {
    validateNextBatchArgs({ nextBatch, expectedActiveCount, expectedSnapshotId, maxWrites });
  }

  if (apply && nextBatch) {
    const preflight = await preflightNextBatch(sb, {
      expectedActiveCount,
      expectedSnapshotId,
      runId
    });
    if (!preflight.ok) {
      const report = {
        phase: "preflight_abort",
        run_id: runId,
        trigger_type: triggerType,
        result_ok: false,
        preflight,
        counts_before: countsBefore,
        counts_after: countsBefore,
        rollback_manifest_id: null,
        princess_active_delta: 0
      };
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const reportPath = path.join(REPORT_DIR, `princess-controlled-batch-${runIdSuffix}.json`);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      report.report_path = reportPath;
      return report;
    }
  }

  if (writeAttempt) {
    const held = await loadMaintenanceLockStatus(sb, lockKey);
    if (held.held && held.owner_id && held.owner_id !== runId) {
      throw new Error(
        `Princess maintenance lock already held by ${held.owner_id} (key: ${lockKey}). Aborting before writes.`
      );
    }
  }

  if ((catchUpIdempotency || (idempotency && nextBatch)) && expectedActiveCount != null) {
    const preflight = await preflightNextBatch(sb, {
      expectedActiveCount,
      expectedSnapshotId,
      runId
    });
    if (!preflight.ok) {
      throw new Error(`Catch-up idempotency preflight failed: ${preflight.reason}`);
    }
  }

  let dbRun = null;
  if (writeAttempt) {
    if (String(process.env.PRINCESS_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
      throw new Error("PRINCESS_DISCOVERY_WRITE_ENABLED must be true for write modes");
    }
    dbRun = await createMaintenanceRun(sb, {
      cruiseLineId: PRINCESS_LINE_ID,
      runId,
      runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
      triggerType,
      stats: {
        line_slug: "princess-cruises",
        controlled_batch: true,
        next_batch: nextBatch === true,
        max_writes: catchUpIdempotency || (idempotency && !apply) ? 0 : effectiveMaxWrites,
        expected_active_count: expectedActiveCount,
        expected_snapshot_id: expectedSnapshotId
      }
    });
  }

  const performWrites = Boolean(apply);
  const maintenanceDryRun = Boolean(dryRun || catchUpIdempotency);

  const result = await runPrincessWeeklyMaintenance({
    dryRun: maintenanceDryRun,
    performWrites,
    writeMode: performWrites ? "production_write" : "production_read_only",
    maxWrites: catchUpIdempotency ? 0 : effectiveMaxWrites,
    runId,
    runRecordId: dbRun?.id || null,
    supabase: sb,
    triggerType
  });

  if (dbRun?.id) {
    const summary = result.summary || {};
    await finalizeMaintenanceRun(sb, dbRun.id, {
      status: result.ok ? "completed" : "failed",
      stats: buildMaintenanceRunStats(summary, {
        run_type: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
        run_id: runId,
        trigger_type: triggerType,
        controlled_batch: true,
        next_batch: nextBatch === true,
        inventory_changed: (summary.inserts || 0) + (summary.updates || 0) > 0
      })
    });
  }

  const countsAfter = await baselineCounts();
  const insertedIds = (result.write_result?.write_details || [])
    .filter((d) => d.created || d.result_action === "inserted")
    .map((d) => d.discovered_cruise_id)
    .filter(Boolean);

  const insertedRows = insertedIds.length
    ? await fetchPrincessActiveRows(createSupabaseRest(root), insertedIds)
    : [];
  const verification = verifyInsertedRows(insertedRows);

  const report = {
    phase: dryRun
      ? "dry_run"
      : catchUpIdempotency
        ? "catch_up_idempotency"
        : apply
          ? "apply"
          : "idempotency",
    run_id: runId,
    run_record_id: dbRun?.id || null,
    trigger_type: triggerType,
    next_batch: nextBatch === true,
    expected_active_count: expectedActiveCount,
    expected_snapshot_id: expectedSnapshotId,
    max_writes: effectiveMaxWrites,
    result_ok: result.ok,
    summary: result.summary || null,
    quality_gate: result.summary?.quality_gate || null,
    write_result: result.write_result || null,
    rollback_manifest_id: result.summary?.rollback_manifest_id || null,
    counts_before: countsBefore,
    counts_after: countsAfter,
    inserted_ids: insertedIds,
    inserted_verification: verification,
    princess_active_delta: countsAfter.princess_active - countsBefore.princess_active,
    hal_unchanged: countsAfter.hal_active === countsBefore.hal_active,
    celebrity_unchanged: countsAfter.celebrity_active === countsBefore.celebrity_active
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `princess-controlled-batch-${runIdSuffix}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  report.report_path = reportPath;

  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  let report;

  if (args.verify) {
    const sb = createSupabaseRest(root);
    const rows = await fetchPrincessActiveRows(sb);
    report = { phase: "verify", active_count: rows.length, verification: verifyInsertedRows(rows), rows };
  } else if (args.apply && args.nextBatch) {
    report = await runBatch({
      dryRun: false,
      apply: true,
      nextBatch: true,
      expectedActiveCount: args.expectedActiveCount,
      expectedSnapshotId: args.expectedSnapshotId,
      maxWrites: args.maxWrites,
      triggerType: "controlled_catch_up_batch",
      runIdSuffix: "catch-up-apply"
    });
    if (!report.result_ok || report.preflight?.aborted || report.inserted_verification?.ok === false) {
      process.exit(1);
    }
  } else if (args.apply) {
    report = await runBatch({
      dryRun: false,
      apply: true,
      triggerType: "controlled_first_run",
      runIdSuffix: "apply"
    });
    if (!report.result_ok || report.inserted_verification?.ok === false) process.exit(1);
  } else if (args.catchUpIdempotency) {
    validateNextBatchArgs(args);
    report = await runBatch({
      dryRun: false,
      apply: false,
      catchUpIdempotency: true,
      nextBatch: true,
      expectedActiveCount: args.expectedActiveCount,
      expectedSnapshotId: args.expectedSnapshotId,
      triggerType: "catch_up_idempotency_verification",
      runIdSuffix: "catch-up-idempotency"
    });
    const delta = report.princess_active_delta || 0;
    const wr = report.write_result || {};
    const s = report.summary || {};
    if (
      delta !== 0 ||
      (wr.inserted || s.inserts || 0) > 0 ||
      (wr.updated || s.updates || 0) > 0 ||
      report.rollback_manifest_id
    ) {
      process.exit(1);
    }
  } else if (args.idempotency) {
    report = await runBatch({
      dryRun: false,
      apply: true,
      idempotency: true,
      triggerType: "idempotency_verification",
      runIdSuffix: "idempotency"
    });
    const delta = report.princess_active_delta || 0;
    const wr = report.write_result || {};
    const s = report.summary || {};
    if (
      delta !== 0 ||
      (wr.inserted || s.inserts || 0) > 0 ||
      (wr.updated || s.updates || 0) > 0
    ) {
      process.exit(1);
    }
  } else {
    report = await runBatch({
      dryRun: true,
      triggerType: args.nextBatch ? "catch_up_dry_run" : "controlled_dry_run",
      runIdSuffix: "dry-run"
    });
    if (!report.quality_gate?.passed) process.exit(1);
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
