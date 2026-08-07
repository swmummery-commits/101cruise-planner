#!/usr/bin/env node
/**
 * Reconcile Princess catch-up audit metadata after a false-negative fetch failure.
 *
 * Read-only (default):
 *   node scripts/reconcile-princess-catch-up-audit.mjs
 *
 * Apply reconciliation to production metadata (no inventory writes):
 *   node scripts/reconcile-princess-catch-up-audit.mjs --apply
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { publicBookingMinimumDepartureDate, perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const RUN_RECORD_ID = "b86d0c83-a712-4c39-9d98-8e349ff46ab3";
const RUN_ID = "princess-catch-up-apply-2026-08-07T05-41-02-846Z";
const MANIFEST_ID = "852fc89e-8325-4dcd-9a91-b9df3db21b98";
const RECOVERED_RECORD_ID = "18aeb2c1-c615-4a3b-84cd-e699f5b71570";
const RECOVERED_SAILING_ID = "AST070|ST|2027-09-12";
const REPORT_PATH = path.join(root, "reports", "princess-controlled-batch-catch-up-apply.json");

function parseArgs(argv) {
  return { apply: argv.includes("--apply") };
}

function loadCatchUpReport() {
  if (!fs.existsSync(REPORT_PATH)) return null;
  return JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
}

function verifyRecoveredRecord(record) {
  const minDep = publicBookingMinimumDepartureDate(perthCalendarDate());
  const issues = [];
  if (!record) issues.push("record_missing");
  if (record?.cruise_line_id !== PRINCESS_LINE_ID) issues.push("wrong_cruise_line");
  if (record?.status !== "active") issues.push("not_active");
  if (record?.official_sailing_id !== RECOVERED_SAILING_ID) issues.push("wrong_official_sailing_id");
  if (!record?.ship_id) issues.push("missing_ship_id");
  if (!record?.destination_id) issues.push("missing_destination_id");
  if (!record?.departure_port) issues.push("missing_departure_port");
  if (String(record?.departure_date || "").slice(0, 10) < minDep) {
    issues.push("inside_21_day_cutoff");
  }
  return { ok: issues.length === 0, issues, minDeparture: minDep };
}

function buildReconciledManifest(originalManifest, record, report) {
  const manifest = JSON.parse(JSON.stringify(originalManifest));
  const insertedIds = new Set(manifest.inserted_record_ids || []);
  const officialIds = new Set(manifest.official_sailing_ids || []);
  const failedDetail = (report?.write_result?.write_details || []).find(
    (row) => row.princess_sailing_id === RECOVERED_SAILING_ID && row.error
  );

  if (!insertedIds.has(record.id)) {
    const entry = {
      discovered_cruise_id: record.id,
      official_sailing_id: RECOVERED_SAILING_ID,
      action: "insert",
      before_values: null,
      after_values: null,
      reconciled_after_fetch_failure: true,
      original_client_error: failedDetail?.error || "fetch failed"
    };
    manifest.inserted = [...(manifest.inserted || []), entry];
    manifest.inserted_record_ids = [...insertedIds, record.id];
    manifest.official_sailing_ids = [...officialIds, RECOVERED_SAILING_ID];
  }

  manifest.reconciliation = {
    amended_at: new Date().toISOString(),
    reason:
      "False-negative write: insert committed but client observed transient fetch failed. " +
      "Manifest amended to include all committed inserts without altering inventory.",
    original_inserted_count: (originalManifest.inserted_record_ids || []).length,
    reconciled_inserted_count: manifest.inserted_record_ids.length,
    recovered_record_id: record.id,
    recovered_official_sailing_id: RECOVERED_SAILING_ID,
    original_client_observed_error: failedDetail?.error || "fetch failed",
    supplemental_audit_manifest: true
  };

  if (manifest.stats) {
    manifest.stats.inserted = manifest.inserted_record_ids.length;
    manifest.stats.failed = 0;
    manifest.stats.recovered_after_fetch_failure = 1;
  }

  return manifest;
}

function buildSupplementalAuditManifest(originalManifest, reconciledManifest, record) {
  return {
    run_id: RUN_ID,
    run_record_id: RUN_RECORD_ID,
    cruise_line_id: PRINCESS_LINE_ID,
    cruise_line_slug: "princess-cruises",
    trigger_type: "controlled_catch_up_batch",
    created_at: new Date().toISOString(),
    audit_type: "fetch_failure_reconciliation",
    original_rollback_manifest_id: MANIFEST_ID,
    original_inserted_count: (originalManifest.inserted_record_ids || []).length,
    reconciled_inserted_count: reconciledManifest.inserted_record_ids.length,
    recovered_record: {
      discovered_cruise_id: record.id,
      official_sailing_id: record.official_sailing_id,
      departure_date: record.departure_date,
      departure_port: record.departure_port,
      ship_id: record.ship_id,
      destination_id: record.destination_id,
      created_at: record.created_at
    },
    original_client_observed_error: reconciledManifest.reconciliation?.original_client_observed_error,
    note: "Supplemental audit record; original rollback manifest preserved with reconciliation block."
  };
}

function buildReconciledRunStats(run, reconciledManifest) {
  const stats = { ...(run.stats || {}) };
  stats.inserts = reconciledManifest.inserted_record_ids.length;
  stats.failed_writes = 0;
  stats.recovered_after_fetch_failure = 1;
  stats.reconciliation = {
    amended_at: new Date().toISOString(),
    rollback_manifest_id: MANIFEST_ID,
    original_client_observed_error: "fetch failed",
    original_failed_writes: run.stats?.failed_writes ?? 1,
    original_inserts: run.stats?.inserts ?? 99,
    note: "Run reconciled after verifying committed insert for AST070|ST|2027-09-12"
  };
  return stats;
}

async function main() {
  const { apply } = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const report = loadCatchUpReport();

  const [runRows, manifestRows, recordRows] = await Promise.all([
    sb.get(`cruise_discovery_runs?id=eq.${RUN_RECORD_ID}&select=id,status,stats,error_message,started_at,finished_at`),
    sb.get(
      `cruise_discovery_maintenance_manifests?id=eq.${MANIFEST_ID}&select=id,manifest_type,run_id,run_record_id,manifest,created_at`
    ),
    sb.get(
      `discovered_cruises?id=eq.${RECOVERED_RECORD_ID}&select=id,official_sailing_id,cruise_line_id,ship_id,destination_id,departure_date,departure_port,status,created_at,updated_at,raw_extract`
    )
  ]);

  const run = runRows?.[0];
  const manifestRow = manifestRows?.[0];
  const record = recordRows?.[0];
  const verification = verifyRecoveredRecord(record);
  const originalManifest = manifestRow?.manifest || {};
  const alreadyReconciled =
    (originalManifest.inserted_record_ids || []).includes(RECOVERED_RECORD_ID) &&
    Number(run?.stats?.failed_writes || 0) === 0;

  const reconciledManifest = buildReconciledManifest(originalManifest, record, report);
  const supplementalManifest = buildSupplementalAuditManifest(originalManifest, reconciledManifest, record);
  const reconciledStats = run ? buildReconciledRunStats(run, reconciledManifest) : null;

  const plan = {
    mode: apply ? "apply" : "dry_run",
    run_record_id: RUN_RECORD_ID,
    run_id: RUN_ID,
    rollback_manifest_id: MANIFEST_ID,
    recovered_record_id: RECOVERED_RECORD_ID,
    recovered_official_sailing_id: RECOVERED_SAILING_ID,
    record_verification: verification,
    timing: {
      run_started_at: run?.started_at || null,
      run_finished_at: run?.finished_at || null,
      record_created_at: record?.created_at || null
    },
    before: {
      run_status: run?.status || null,
      inserts: run?.stats?.inserts ?? null,
      failed_writes: run?.stats?.failed_writes ?? null,
      manifest_inserted_ids: (originalManifest.inserted_record_ids || []).length
    },
    after: {
      run_status: "completed",
      inserts: reconciledManifest.inserted_record_ids.length,
      failed_writes: 0,
      recovered_after_fetch_failure: 1,
      manifest_inserted_ids: reconciledManifest.inserted_record_ids.length
    },
    already_reconciled: alreadyReconciled,
    supplemental_audit_manifest: supplementalManifest
  };

  if (!verification.ok) {
    plan.error = "record_verification_failed";
    console.log(JSON.stringify(plan, null, 2));
    process.exit(1);
  }

  if (apply && !alreadyReconciled) {
    await sb.patch(`cruise_discovery_maintenance_manifests?id=eq.${MANIFEST_ID}`, {
      manifest: reconciledManifest
    });
    await sb.post("cruise_discovery_maintenance_manifests", {
      manifest_type: "historical_audit",
      run_id: RUN_ID,
      run_record_id: RUN_RECORD_ID,
      cruise_line_id: PRINCESS_LINE_ID,
      cruise_line_slug: "princess-cruises",
      manifest: supplementalManifest
    });
    await sb.patch(`cruise_discovery_runs?id=eq.${RUN_RECORD_ID}`, {
      status: "completed",
      error_message: null,
      stats: reconciledStats
    });
    plan.applied = true;
  } else if (apply) {
    plan.applied = false;
    plan.note = "Already reconciled; no changes applied";
  }

  console.log(JSON.stringify(plan, null, 2));
  if (!apply) process.exit(0);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
