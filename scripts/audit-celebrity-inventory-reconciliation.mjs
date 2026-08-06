#!/usr/bin/env node
/**
 * Authoritative Celebrity inventory reconciliation audit.
 *   node scripts/audit-celebrity-inventory-reconciliation.mjs
 *   node scripts/audit-celebrity-inventory-reconciliation.mjs --export-active
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const OUTPUT = path.join(root, "reports/celebrity-inventory-reconciliation-audit-2026-08-06.json");
const ACTIVE_EXPORT = path.join(root, "reports/celebrity-active-records-export-2026-08-06.json");

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

async function fetchAll(sb, path, pageSize = 1000) {
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await sb.get(`${path}&limit=${pageSize}&offset=${offset}`);
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function groupCount(rows, fn) {
  const m = {};
  for (const r of rows) m[fn(r)] = (m[fn(r)] || 0) + 1;
  return m;
}

async function main() {
  const exportActive = process.argv.includes("--export-active");
  const sb = createSupabaseRest(root);
  const today = new Date().toISOString().slice(0, 10);

  const celebrityLine = (await sb.get("ci_cruise_lines?slug=eq.celebrity-cruises&select=id,name,slug&limit=1"))?.[0];
  const halLine = (await sb.get("ci_cruise_lines?slug=eq.holland-america-line&select=id,name&limit=1"))?.[0];
  if (!celebrityLine) throw new Error("Celebrity line not found");

  const lineId = celebrityLine.id;
  const halId = halLine?.id;

  const allCounts = {
    total: await headCount("discovered_cruises"),
    active: await headCount("discovered_cruises", "status=eq.active"),
    active_future: await headCount(
      "discovered_cruises",
      `status=eq.active&departure_date=gte.${today}`
    ),
    expired: await headCount("discovered_cruises", "status=eq.expired"),
    hidden: await headCount("discovered_cruises", "status=eq.hidden"),
    match_required: await headCount("discovered_cruises", "status=eq.match_required"),
    validation_failed: await headCount("discovered_cruises", "status=eq.validation_failed")
  };

  const celebrityAll = await fetchAll(
    sb,
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(lineId)}&select=id,status,departure_date,official_sailing_id,ship_id,destination_id,departure_port,return_date,nights,official_url,identity_key,created_at,updated_at,last_changed_at,raw_extract`
  );

  const celebrityActive = celebrityAll.filter((r) => r.status === "active");
  const celebrityActiveFuture = celebrityActive.filter((r) => r.departure_date >= today);

  const productType = (r) => r.raw_extract?.celebrity_product_type || null;
  const batchWrite = (r) => r.raw_extract?.celebrity_batch_write === true;
  const adapterId = (r) => r.raw_extract?.celebrity_adapter_id || null;

  const typedOcean = celebrityActive.filter((r) => productType(r) === "ocean_cruise");
  const typedRiver = celebrityActive.filter((r) => productType(r) === "river_cruise");
  const typedOther = celebrityActive.filter(
    (r) => productType(r) && !["ocean_cruise", "river_cruise"].includes(productType(r))
  );
  const untypedActive = celebrityActive.filter((r) => !productType(r));

  const sailingIdCounts = groupCount(
    celebrityActive.filter((r) => r.official_sailing_id),
    (r) => r.official_sailing_id
  );
  const duplicateSailingIds = Object.entries(sailingIdCounts).filter(([, c]) => c > 1);

  const identityCounts = groupCount(
    celebrityActive.filter((r) => r.identity_key),
    (r) => r.identity_key
  );
  const duplicateIdentity = Object.entries(identityCounts).filter(([, c]) => c > 1);

  const runs = await fetchAll(
    sb,
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(lineId)}&select=id,status,started_at,finished_at,stats,error_message,created_at&order=created_at.asc`
  );
  const celebrityRuns = runs.filter((r) =>
    ["celebrity_controlled_batch", "celebrity_automatic_batch"].includes(r.stats?.run_type)
  );

  const rollbackFiles = [
    "reports/celebrity-first-production-batch-rollback-2026-08-06T05-26-12-313Z.json",
    "reports/celebrity-first-production-batch-rollback-2026-08-06T06-08-20-016Z.json"
  ].filter((f) => fs.existsSync(path.join(root, f)));

  const runReconciliation = celebrityRuns.map((r) => ({
    run_record_id: r.id,
    run_id: r.stats?.run_id,
    run_type: r.stats?.run_type,
    status: r.status,
    started_at: r.started_at,
    finished_at: r.finished_at,
    inserted: r.stats?.inserted ?? null,
    updated: r.stats?.updated ?? null,
    failed_writes: r.stats?.failed_writes ?? null,
    proposed_writes: r.stats?.proposed_writes ?? null
  }));

  const autoSummaryPath = fs
    .readdirSync(path.join(root, "reports"))
    .filter((f) => f.startsWith("celebrity-automatic-continuation-") && f.endsWith(".json"))
    .sort()
    .pop();
  let autoSession = null;
  if (autoSummaryPath) {
    autoSession = JSON.parse(fs.readFileSync(path.join(root, "reports", autoSummaryPath), "utf8"));
  }

  const untypedAudit = untypedActive.map((r) => ({
    id: r.id,
    official_sailing_id: r.official_sailing_id,
    official_url: r.official_url,
    departure_date: r.departure_date,
    ship_id: r.ship_id,
    destination_id: r.destination_id,
    departure_port: r.departure_port,
    created_at: r.created_at,
    updated_at: r.updated_at,
    raw_extract_keys: Object.keys(r.raw_extract || {}),
    celebrity_batch_write: batchWrite(r),
    celebrity_adapter_id: adapterId(r),
    has_celebrity_sailing_id: Boolean(r.raw_extract?.celebrity_sailing_id)
  }));

  const stageArithmetic = {
    post_rollback_expected: { discovered_cruises: 1064, celebrity_active: 0 },
    clean_controlled_inserts: 40,
    auto_session_reported: autoSession
      ? {
          batches: autoSession.batch_count,
          sum_inserted: (autoSession.batches || []).reduce((n, b) => n + (b.inserted || 0), 0),
          eligible_pending_at_start: autoSession.eligible_pending_at_start
        }
      : null,
    current_database: {
      discovered_cruises_total: allCounts.total,
      celebrity_total: celebrityAll.length,
      celebrity_active: celebrityActive.length,
      celebrity_active_future: celebrityActiveFuture.length,
      celebrity_typed_ocean: typedOcean.length,
      celebrity_typed_river: typedRiver.length,
      celebrity_typed_other: typedOther.length,
      celebrity_untyped_active: untypedActive.length,
      celebrity_with_official_sailing_id: celebrityActive.filter((r) => r.official_sailing_id).length,
      celebrity_batch_marked: celebrityActive.filter((r) => batchWrite(r)).length,
      celebrity_with_adapter: celebrityActive.filter((r) => adapterId(r) === "celebrity").length
    },
    naive_sum_error_explanation:
      "1064 + 40 + 803 assumes every automatic write was a net new discovered_cruises row with no intervening broken-auto inserts/deletes and no cross-line effects; actual net delta = current_total - 1064"
  };

  stageArithmetic.net_discovered_delta_from_post_rollback =
    allCounts.total - 1064;
  stageArithmetic.net_celebrity_active_delta_from_post_rollback = celebrityActive.length;

  const report = {
    generated_at: new Date().toISOString(),
    queries: {
      celebrity_line_id: lineId,
      hal_line_id: halId,
      head_count_pattern: "HEAD /rest/v1/{table}?select=id&{filters} Prefer: count=exact",
      celebrity_fetch: `discovered_cruises?cruise_line_id=eq.${lineId}&select=...`
    },
    all_discovered_cruises: allCounts,
    hal_active: halId
      ? await headCount("discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(halId)}&status=eq.active`)
      : null,
    celebrity: {
      total: celebrityAll.length,
      active: celebrityActive.length,
      active_future: celebrityActiveFuture.length,
      inactive_by_status: groupCount(
        celebrityAll.filter((r) => r.status !== "active"),
        (r) => r.status
      ),
      with_official_sailing_id: celebrityAll.filter((r) => r.official_sailing_id).length,
      without_official_sailing_id: celebrityAll.filter((r) => !r.official_sailing_id).length,
      active_ocean_cruise: typedOcean.length,
      active_river_cruise: typedRiver.length,
      active_other_product_type: typedOther.length,
      active_untyped: untypedActive.length,
      active_batch_marked: celebrityActive.filter((r) => batchWrite(r)).length,
      active_with_celebrity_adapter: celebrityActive.filter((r) => adapterId(r) === "celebrity").length,
      active_no_batch_metadata: celebrityActive.filter((r) => !batchWrite(r) && adapterId(r) !== "celebrity").length,
      duplicate_official_sailing_ids: duplicateSailingIds,
      duplicate_identity_keys: duplicateIdentity
    },
    review_and_aliases: {
      pending_review: await headCount("cruise_discovery_review_items", "status=eq.pending"),
      total_review: await headCount("cruise_discovery_review_items"),
      ship_aliases: await headCount("cruise_ship_aliases"),
      destination_aliases: await headCount("cruise_destination_aliases"),
      discovered_cruise_destinations: await headCount("discovered_cruise_destinations"),
      destinations: await headCount("destinations"),
      destination_ports: await headCount("destination_ports")
    },
    run_reconciliation: runReconciliation,
    auto_session_file: autoSummaryPath || null,
    auto_session: autoSession,
    rollback_files_found: rollbackFiles,
    stage_arithmetic: stageArithmetic,
    untyped_active_audit: untypedAudit
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));

  if (exportActive) {
    fs.writeFileSync(
      ACTIVE_EXPORT,
      JSON.stringify(
        celebrityActive.map((r) => ({
          id: r.id,
          official_sailing_id: r.official_sailing_id,
          official_group_id: r.raw_extract?.celebrity_group_id || r.raw_extract?.group_id,
          official_url: r.official_url,
          product_type: productType(r),
          ship_id: r.ship_id,
          departure_date: r.departure_date,
          return_date: r.return_date,
          nights: r.nights,
          departure_port: r.departure_port,
          destination_id: r.destination_id,
          celebrity_batch_write: batchWrite(r),
          celebrity_adapter_id: adapterId(r),
          created_at: r.created_at,
          updated_at: r.updated_at
        })),
        null,
        2
      )
    );
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
