#!/usr/bin/env node
/**
 * Production Princess inventory reconciliation audit (read-only).
 *
 *   node scripts/reconcile-princess-production-inventory.mjs
 *   node scripts/reconcile-princess-production-inventory.mjs --json > reports/princess-reconcile.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createSupabaseRest, exactCountSupabase, fetchAllPaginated } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const FIRST_BATCH_RUN = "princess-controlled-apply-2026-08-07T00-20-47-206Z";
const CATCHUP_RUN = "princess-catch-up-apply-2026-08-07T05-41-02-846Z";
const FAILED_SAILING_ID = "AST070|ST|2027-09-12";

function loadReport(name) {
  const file = path.join(root, "reports", name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function idsFromReport(report) {
  if (!report) return new Set();
  if (Array.isArray(report.inserted_ids) && report.inserted_ids.length) {
    return new Set(report.inserted_ids);
  }
  return new Set(
    (report.write_result?.write_details || [])
      .filter((row) => row.created || row.result_action === "inserted")
      .map((row) => row.discovered_cruise_id)
      .filter(Boolean)
  );
}

async function main() {
  const sb = createSupabaseRest(root);
  const firstReport = loadReport("princess-controlled-batch-apply.json");
  const catchupReport = loadReport("princess-controlled-batch-catch-up-apply.json");
  const firstIds = idsFromReport(firstReport);
  const catchIds = idsFromReport(catchupReport);

  const activeFilter = `cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active`;
  const { count: activeExact } = await exactCountSupabase(root, "discovered_cruises", activeFilter);
  const active = await fetchAllPaginated(
    root,
    `discovered_cruises?${activeFilter}&select=id,official_sailing_id,departure_date,departure_port,created_at,updated_at&order=created_at.asc`
  );
  const allPrincess = await fetchAllPaginated(
    root,
    `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&select=id,status,official_sailing_id,created_at`
  );
  const runs = await sb.get(
    `cruise_discovery_runs?cruise_line_id=eq.${PRINCESS_LINE_ID}&select=id,status,stats,started_at,finished_at&order=created_at.desc&limit=20`
  );
  const manifests = await sb.get(
    `cruise_discovery_maintenance_manifests?select=id,run_record_id,created_at&order=created_at.desc&limit=10`
  );

  const groupA = [];
  const groupB = [];
  const groupBFalseFailure = [];
  const groupC = [];

  for (const row of active) {
    if (firstIds.has(row.id)) groupA.push(row);
    else if (catchIds.has(row.id)) groupB.push(row);
    else if (row.official_sailing_id === FAILED_SAILING_ID) groupBFalseFailure.push(row);
    else groupC.push(row);
  }

  const failedDetail = (catchupReport?.write_result?.write_details || []).find(
    (row) => row.error && !row.discovered_cruise_id
  );

  const inactive = allPrincess.filter((row) => row.status !== "active");

  const report = {
    reconciled_at: new Date().toISOString(),
    active_total: activeExact,
    active_rows_loaded: active.length,
    arithmetic: {
      first_controlled_batch: groupA.length,
      catch_up_tracked: groupB.length,
      catch_up_false_failure_committed: groupBFalseFailure.length,
      other_active: groupC.length,
      sum: groupA.length + groupB.length + groupBFalseFailure.length + groupC.length
    },
    explanation:
      groupBFalseFailure.length === 1
        ? "Catch-up reported 99 inserts + 1 failed write, but the failed sailing AST070|ST|2027-09-12 exists in production. The +1 vs 20+99=119 discrepancy is this false-negative write, not a mystery 120th record."
        : null,
    failed_write: failedDetail
      ? {
          official_sailing_id: failedDetail.princess_sailing_id,
          error: failedDetail.error,
          exists_in_production: groupBFalseFailure.length > 0,
          production_record: groupBFalseFailure[0] || null
        }
      : null,
    groups: {
      A_first_controlled_batch: {
        count: groupA.length,
        run_id: FIRST_BATCH_RUN,
        records: groupA
      },
      B_catch_up_tracked: {
        count: groupB.length,
        run_id: CATCHUP_RUN,
        records: groupB
      },
      B_catch_up_false_failure: groupBFalseFailure,
      C_other_active: groupC,
      D_inactive_or_non_active: inactive.map((row) => ({
        id: row.id,
        status: row.status,
        official_sailing_id: row.official_sailing_id,
        created_at: row.created_at
      }))
    },
    maintenance_runs: runs.map((row) => ({
      id: row.id,
      status: row.status,
      run_id: row.stats?.run_id,
      trigger_type: row.stats?.trigger_type,
      inserts: row.stats?.inserts,
      failed_writes: row.stats?.failed_writes,
      active_production_total: row.stats?.active_production_total,
      finished_at: row.finished_at
    })),
    manifest_count: manifests.length
  };

  console.log(JSON.stringify(report, null, 2));
  if (report.arithmetic.sum !== report.active_total) process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
