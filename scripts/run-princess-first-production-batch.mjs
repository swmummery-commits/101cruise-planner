#!/usr/bin/env node
/**
 * Controlled Princess first production batch (max 20 writes).
 *
 *   PRINCESS_DISCOVERY_WRITE_ENABLED=true node scripts/run-princess-first-production-batch.mjs --dry-run
 *   PRINCESS_DISCOVERY_WRITE_ENABLED=true node scripts/run-princess-first-production-batch.mjs --apply
 *   PRINCESS_DISCOVERY_WRITE_ENABLED=true node scripts/run-princess-first-production-batch.mjs --idempotency
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { createMaintenanceSupabase, createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
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
const MAX_WRITES = 20;
const REPORT_DIR = path.join(root, "reports");

function parseArgs(argv) {
  const args = { dryRun: false, apply: false, idempotency: false, verify: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--idempotency") args.idempotency = true;
    if (arg === "--verify") args.verify = true;
  }
  if (!args.dryRun && !args.apply && !args.idempotency && !args.verify) args.dryRun = true;
  return args;
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
  }
  return { ok: issues.length === 0, issues, minDeparture: minDep };
}

async function runBatch({ dryRun, apply, idempotency, triggerType, runIdSuffix }) {
  const sb = createMaintenanceSupabase(root);
  const runId = `princess-controlled-${runIdSuffix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const countsBefore = await baselineCounts();
  const lockKey = weeklyLockKey("princess-cruises");

  if (apply && triggerType === "controlled_first_run" && countsBefore.princess_active >= MAX_WRITES) {
    throw new Error(
      `Controlled Princess batch already present (${countsBefore.princess_active} active). ` +
        "Use --idempotency to verify stability, not --apply."
    );
  }

  if (apply || idempotency) {
    const held = await loadMaintenanceLockStatus(sb, lockKey);
    if (held.held && held.owner_id && held.owner_id !== runId) {
      throw new Error(
        `Princess maintenance lock already held by ${held.owner_id} (key: ${lockKey}). Aborting before writes.`
      );
    }
  }

  let dbRun = null;
  if (apply || idempotency) {
    if (String(process.env.PRINCESS_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
      throw new Error("PRINCESS_DISCOVERY_WRITE_ENABLED must be true for apply/idempotency");
    }
    dbRun = await createMaintenanceRun(sb, {
      cruiseLineId: PRINCESS_LINE_ID,
      runId,
      runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
      triggerType,
      stats: { line_slug: "princess-cruises", controlled_batch: true, max_writes: MAX_WRITES }
    });
  }

  const result = await runPrincessWeeklyMaintenance({
    dryRun: dryRun && !apply,
    performWrites: apply,
    writeMode: apply ? "production_write" : "production_read_only",
    maxWrites: MAX_WRITES,
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
        controlled_batch: true
      })
    });
  }

  const countsAfter = await baselineCounts();
  const insertedIds = (result.write_result?.write_details || result.summary?.write_details || [])
    .filter((d) => d.created || d.result_action === "inserted")
    .map((d) => d.discovered_cruise_id)
    .filter(Boolean);

  const insertedRows = insertedIds.length
    ? await fetchPrincessActiveRows(createSupabaseRest(root), insertedIds)
    : [];
  const verification = verifyInsertedRows(insertedRows);

  const report = {
    phase: dryRun ? "dry_run" : apply ? "apply" : "idempotency",
    run_id: runId,
    run_record_id: dbRun?.id || null,
    trigger_type: triggerType,
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
  } else if (args.apply) {
    report = await runBatch({
      dryRun: false,
      apply: true,
      idempotency: false,
      triggerType: "controlled_first_run",
      runIdSuffix: "apply"
    });
    if (!report.result_ok || report.inserted_verification?.ok === false) process.exit(1);
  } else if (args.idempotency) {
    report = await runBatch({
      dryRun: false,
      apply: true,
      idempotency: true,
      triggerType: "idempotency_verification",
      runIdSuffix: "idempotency"
    });
    const s = report.summary || {};
    const wr = report.write_result || {};
    const delta = report.princess_active_delta || 0;
    if (
      delta !== 0 ||
      (wr.inserted || s.inserts || 0) > 0 ||
      (wr.updated || s.updates || 0) > 0 ||
      (wr.failed || s.failed_writes || 0) > 0
    ) {
      process.exit(1);
    }
  } else {
    report = await runBatch({
      dryRun: true,
      apply: false,
      idempotency: false,
      triggerType: "controlled_dry_run",
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
