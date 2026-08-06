#!/usr/bin/env node
/**
 * Celebrity inventory close-out: snapshot, set reconciliation, deterministic repair.
 *
 *   node scripts/celebrity-closeout-reconciliation.mjs --snapshot
 *   node scripts/celebrity-closeout-reconciliation.mjs --reconcile
 *   node scripts/celebrity-closeout-reconciliation.mjs --manifest
 *   node scripts/celebrity-closeout-reconciliation.mjs --apply
 *   node scripts/celebrity-closeout-reconciliation.mjs --backfill-reconciliation-run
 *   node scripts/celebrity-closeout-reconciliation.mjs --verify
 *   node scripts/celebrity-closeout-reconciliation.mjs --all
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const DATE = "2026-08-06";
const SNAPSHOT_PATH = path.join(root, `reports/celebrity-closeout-snapshot-${DATE}.json`);
const RECON_PATH = path.join(root, `reports/celebrity-closeout-set-reconciliation-${DATE}.json`);
const MANIFEST_PATH = path.join(root, `reports/celebrity-final-closeout-manifest-${DATE}.json`);
const BACKUP_PATH = path.join(root, `reports/celebrity-closeout-pre-repair-backup-${DATE}.json`);
const ROLLBACK_PATH = path.join(root, `reports/celebrity-closeout-rollback-${DATE}.json`);

const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  simulateCelebrityInventory,
  catalogueDestinations,
  isEligibleCelebrityCruise,
  officialGroupKey
} = require(path.join(root, "netlify/functions/lib/celebrity-discovery-adapter"));
const { applyCelebrityBatchWrites, indexExistingCelebrityRecords } = require(path.join(
  root,
  "netlify/functions/lib/celebrity-discovery-writes"
));
const { supabase } = require(path.join(root, "netlify/functions/lib/cruise-discovery-ops"));
const { fetchRowsBySailingIds, summariseActivationAudit } = require(path.join(
  root,
  "scripts/lib/celebrity-batch-audit.cjs"
));
const { sha256File, withCelebrityRunRecord } = require(path.join(root, "scripts/lib/celebrity-run-tracking.cjs"));
const {
  buildCelebrityRunStats,
  createCelebrityDiscoveryRun,
  finalizeCelebrityDiscoveryRun,
  CELEBRITY_CLOSEOUT_RUN_TYPE,
  CELEBRITY_RECON_RUN_TYPE
} = require(path.join(root, "netlify/functions/lib/celebrity-discovery-run-tracking"));
const { loadCelebrityDatabaseInventoryCounts } = require(path.join(
  root,
  "netlify/functions/lib/celebrity-inventory-counts"
));

function loadEnv() {
  try {
    require("dotenv").config({ path: path.join(root, ".env") });
  } catch {
    /* optional */
  }
}
loadEnv();

function parseArgs(argv) {
  return {
    snapshot: argv.includes("--snapshot"),
    reconcile: argv.includes("--reconcile"),
    manifest: argv.includes("--manifest"),
    apply: argv.includes("--apply"),
    backfillReconRun: argv.includes("--backfill-reconciliation-run"),
    verify: argv.includes("--verify"),
    all: argv.includes("--all")
  };
}

function checksum(content) {
  return crypto.createHash("sha256").update(typeof content === "string" ? content : JSON.stringify(content)).digest("hex");
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

async function fetchAllActiveCelebrity(sb, lineId) {
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await sb.get(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(lineId)}&status=eq.active&select=id,status,departure_date,official_sailing_id,ship_id,destination_id,departure_port,return_date,nights,official_url,created_at,updated_at,raw_extract&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

async function loadCtx(sb) {
  const line = (await sb.get("ci_cruise_lines?slug=eq.celebrity-cruises&select=id,name,slug&limit=1"))?.[0];
  const halLine = (await sb.get("ci_cruise_lines?slug=eq.holland-america-line&select=id&limit=1"))?.[0];
  if (!line) throw new Error("Celebrity line not found");
  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id,ship_class`
  );
  const destRows = await sb.get(
    "destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled"
  );
  return { line, halLine, ships: ships || [], destinations: catalogueDestinations(destRows || []) };
}

async function captureBoundaryCounts(lineId, halLineId) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    discovered_cruises: await headCount("discovered_cruises"),
    active_discovered_cruises: await headCount("discovered_cruises", "status=eq.active"),
    active_future_cruises: await headCount(
      "discovered_cruises",
      `status=eq.active&departure_date=gte.${today}`
    ),
    celebrity_total: lineId
      ? await headCount("discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(lineId)}`)
      : 0,
    celebrity_active: lineId
      ? await headCount(
          "discovered_cruises",
          `cruise_line_id=eq.${encodeURIComponent(lineId)}&status=eq.active`
        )
      : 0,
    celebrity_ocean_active: lineId
      ? await headCount(
          "discovered_cruises",
          `cruise_line_id=eq.${encodeURIComponent(lineId)}&status=eq.active&raw_extract->>celebrity_product_type=eq.ocean_cruise`
        )
      : 0,
    celebrity_river_active: lineId
      ? await headCount(
          "discovered_cruises",
          `cruise_line_id=eq.${encodeURIComponent(lineId)}&status=eq.active&raw_extract->>celebrity_product_type=eq.river_cruise`
        )
      : 0,
    hal_active: halLineId
      ? await headCount(
          "discovered_cruises",
          `cruise_line_id=eq.${encodeURIComponent(halLineId)}&status=eq.active`
        )
      : 0,
    pending_reviews: await headCount("cruise_discovery_review_items", "status=eq.pending"),
    total_review_items: await headCount("cruise_discovery_review_items"),
    ship_aliases: await headCount("cruise_ship_aliases"),
    destination_aliases: await headCount("cruise_destination_aliases"),
    destinations: await headCount("destinations"),
    destination_ports: await headCount("destination_ports"),
    discovered_cruise_destinations: await headCount("discovered_cruise_destinations"),
    resolution_audit: await headCount("cruise_discovery_resolution_audit"),
    discovery_runs: await headCount("cruise_discovery_runs")
  };
}

function buildEligibleSet(simulation) {
  const eligible = simulation.products.filter(
    (p) => p.complete_high_confidence && isEligibleCelebrityCruise(p.product_type)
  );
  const byId = new Map();
  for (const p of eligible) {
    byId.set(p.official_product_key, {
      official_sailing_id: p.official_product_key,
      official_group_id: officialGroupKey(p.raw),
      product_type: p.product_type,
      ship: p.raw?.ship_name || p.ship_resolution?.ship?.name || null,
      departure_date: p.candidate?.departure_date || p.raw?.departure_date,
      return_date: p.candidate?.return_date || p.raw?.return_date,
      nights: p.candidate?.nights || p.raw?.nights,
      departure_port: p.candidate?.departure_port || p.raw?.departure_port,
      destination: p.destination_resolution?.destinationKey || null,
      source_url: p.raw?.official_url || p.candidate?.official_url,
      confidence: p.adapter_confidence || null,
      completeness: p.complete_high_confidence ? "complete_high_confidence" : "incomplete",
      pre_tour_duration: p.raw?.pre_tour_duration ?? null,
      post_tour_duration: p.raw?.post_tour_duration ?? null
    });
  }
  return { eligible, byId, ids: new Set(byId.keys()) };
}

function buildAllProductsMap(simulation) {
  const byId = new Map();
  for (const p of simulation.products) {
    byId.set(p.official_product_key, p);
  }
  return byId;
}

function classifyOutOfSetRecord(dbRow, allProductsById, eligibleIds) {
  const sid = dbRow.official_sailing_id || dbRow.raw_extract?.celebrity_sailing_id;
  const official = sid ? allProductsById.get(sid) : null;
  if (official && eligibleIds.has(sid)) {
    return { classification: "G", reason: "database_reporting_mismatch_eligible_in_current_snapshot" };
  }
  if (official && isEligibleCelebrityCruise(official.product_type) && official.complete_high_confidence) {
    return { classification: "A", reason: "still_valid_eligible_cruise_in_current_graphql" };
  }
  if (official && isEligibleCelebrityCruise(official.product_type) && !official.complete_high_confidence) {
    return { classification: "F", reason: "source_data_now_incomplete", graphql_type: official.product_type };
  }
  if (official && !isEligibleCelebrityCruise(official.product_type)) {
    const pt = official.product_type;
    if (pt.includes("cruisetour")) {
      return { classification: "D", reason: "reclassified_cruisetour_in_graphql", graphql_type: pt };
    }
    return { classification: "F", reason: "invalid_product_type_in_graphql", graphql_type: pt };
  }
  if (!official) {
    return { classification: "C", reason: "absent_from_current_full_graphql_fetch", graphql_present: false };
  }
  return { classification: "G", reason: "unresolved_mismatch" };
}

async function runSnapshot(ctx) {
  const today = new Date().toISOString().slice(0, 10);
  const simulation = await simulateCelebrityInventory({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today,
    requestDelayMs: 150
  });

  const { eligible, byId } = buildEligibleSet(simulation);
  const snapshot = {
    generated_at: new Date().toISOString(),
    cache_disabled: true,
    page_size: simulation.page_log?.[0] ? 25 : 25,
    pagination_requests: simulation.pagination_requests,
    page_log: simulation.page_log,
    official_reported_total: simulation.official_reported_total,
    itinerary_groups_fetched: simulation.itinerary_groups_fetched,
    sailing_products_fetched: simulation.sailing_products_fetched,
    ingestion_audit: simulation.ingestion_audit,
    cruise_metrics: simulation.cruise_metrics,
    eligible_count: eligible.length,
    eligible_ocean: eligible.filter((p) => p.product_type === "ocean_cruise").length,
    eligible_river: eligible.filter((p) => p.product_type === "river_cruise").length,
    eligible_products: [...byId.values()],
    checksum: null
  };
  snapshot.checksum = checksum(snapshot.eligible_products);

  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

async function runReconcile(ctx, sb, snapshot) {
  const activeRows = await fetchAllActiveCelebrity(sb, ctx.line.id);
  const activeIds = new Set(
    activeRows.map((r) => r.official_sailing_id || r.raw_extract?.celebrity_sailing_id).filter(Boolean)
  );
  const eligibleIds = new Set(snapshot.eligible_products.map((p) => p.official_sailing_id));

  const eligibleAndActive = [...eligibleIds].filter((id) => activeIds.has(id));
  const eligibleMissing = [...eligibleIds].filter((id) => !activeIds.has(id));
  const activeNotEligible = [...activeIds].filter((id) => !eligibleIds.has(id));

  const sailingCounts = {};
  for (const id of activeIds) sailingCounts[id] = (sailingCounts[id] || 0) + 1;
  const duplicateIdentities = Object.entries(sailingCounts).filter(([, c]) => c > 1);
  const untyped = activeRows.filter((r) => !r.raw_extract?.celebrity_product_type);
  const invalidType = activeRows.filter(
    (r) =>
      r.raw_extract?.celebrity_product_type &&
      !["ocean_cruise", "river_cruise"].includes(r.raw_extract.celebrity_product_type)
  );
  const missingIdentity = activeRows.filter(
    (r) => !(r.official_sailing_id || r.raw_extract?.celebrity_sailing_id)
  );

  const today = new Date().toISOString().slice(0, 10);
  const liveSim = await simulateCelebrityInventory({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today
  });
  const allProductsById = buildAllProductsMap(liveSim);

  const outOfSetAudit = activeNotEligible.map((sid) => {
    const dbRow = activeRows.find(
      (r) => (r.official_sailing_id || r.raw_extract?.celebrity_sailing_id) === sid
    );
    const official = allProductsById.get(sid);
    const audit = classifyOutOfSetRecord(dbRow, allProductsById, eligibleIds);
    return {
      discovered_cruise_id: dbRow?.id,
      official_sailing_id: sid,
      group_id: dbRow?.raw_extract?.celebrity_group_id || officialGroupKey(dbRow?.raw_extract || {}),
      product_type: dbRow?.raw_extract?.celebrity_product_type,
      ship_id: dbRow?.ship_id,
      departure_date: dbRow?.departure_date,
      source_url: dbRow?.official_url,
      created_at: dbRow?.created_at,
      graphql_present: Boolean(official),
      graphql_product_type: official?.product_type || null,
      graphql_complete: official?.complete_high_confidence ?? null,
      classification: audit.classification,
      reason: audit.reason
    };
  });

  const sm07 = snapshot.eligible_products.find((p) => p.official_sailing_id === "SM07A393_2026-08-28") ||
    liveSim.products.find((p) => p.official_product_key === "SM07A393_2026-08-28");

  const recon = {
    generated_at: new Date().toISOString(),
    snapshot_timestamp: snapshot.generated_at,
    snapshot_checksum: snapshot.checksum,
    set_counts: {
      official_eligible: eligibleIds.size,
      active_celebrity: activeIds.size,
      eligible_and_active: eligibleAndActive.length,
      eligible_missing_from_production: eligibleMissing.length,
      active_not_in_current_eligible_set: activeNotEligible.length,
      duplicate_official_identities: duplicateIdentities.length,
      active_without_official_identity: missingIdentity.length,
      active_invalid_product_type: invalidType.length,
      active_untyped: untyped.length
    },
    eligible_and_active_ids: eligibleAndActive.sort(),
    eligible_missing_ids: eligibleMissing.sort(),
    active_not_eligible_ids: activeNotEligible.sort(),
    duplicate_official_identities: duplicateIdentities,
    out_of_set_audit: outOfSetAudit,
    sm07a393_audit: sm07
      ? {
          official_sailing_id: sm07.official_sailing_id || sm07.official_product_key,
          official_group_id: sm07.official_group_id || officialGroupKey(sm07.raw || {}),
          product_type: sm07.product_type,
          ship: sm07.ship || sm07.raw?.ship_name,
          departure_date: sm07.departure_date || sm07.candidate?.departure_date,
          return_date: sm07.return_date || sm07.candidate?.return_date,
          nights: sm07.nights || sm07.candidate?.nights,
          departure_port: sm07.departure_port || sm07.candidate?.departure_port,
          destination: sm07.destination || sm07.destination_resolution?.destinationKey,
          source_url: sm07.source_url || sm07.raw?.official_url,
          pre_tour: sm07.pre_tour_duration ?? sm07.raw?.pre_tour_duration ?? null,
          post_tour: sm07.post_tour_duration ?? sm07.raw?.post_tour_duration ?? null,
          completeness: sm07.completeness || (sm07.complete_high_confidence ? "complete_high_confidence" : "incomplete"),
          confidence: sm07.confidence || sm07.adapter_confidence,
          in_eligible_set: eligibleIds.has("SM07A393_2026-08-28"),
          in_active_database: activeIds.has("SM07A393_2026-08-28")
        }
      : { error: "not_found_in_fresh_snapshot" }
  };

  fs.mkdirSync(path.dirname(RECON_PATH), { recursive: true });
  fs.writeFileSync(RECON_PATH, JSON.stringify(recon, null, 2));
  return recon;
}

function buildManifest(recon, snapshot) {
  const actions = [];
  const missing = recon.eligible_missing_ids || [];

  for (const sid of missing) {
    const eligible = snapshot.eligible_products.find((p) => p.official_sailing_id === sid);
    if (!eligible) continue;
    actions.push({
      action: "insert_missing_eligible",
      official_sailing_id: sid,
      discovered_cruise_id: null,
      before_values: null,
      proposed_values: { status: "active", ...eligible },
      official_source_evidence: eligible,
      source_snapshot_timestamp: snapshot.generated_at,
      reason: "eligible_in_official_snapshot_missing_from_active_database",
      expected_updated_at: null,
      rollback_values: { delete_on_rollback: true }
    });
  }

  for (const row of recon.out_of_set_audit || []) {
    if (row.classification === "D") {
      actions.push({
        action: "hide_reclassified_cruisetour",
        official_sailing_id: row.official_sailing_id,
        discovered_cruise_id: row.discovered_cruise_id,
        before_values: { status: "active" },
        proposed_values: { status: "hidden" },
        official_source_evidence: {
          graphql_product_type: row.graphql_product_type,
          snapshot_timestamp: snapshot.generated_at
        },
        source_snapshot_timestamp: snapshot.generated_at,
        reason: row.reason,
        expected_updated_at: null,
        rollback_values: { status: "active" }
      });
    } else {
      actions.push({
        action: "unchanged",
        official_sailing_id: row.official_sailing_id,
        discovered_cruise_id: row.discovered_cruise_id,
        classification: row.classification,
        reason: row.reason
      });
    }
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    source_snapshot: SNAPSHOT_PATH,
    source_snapshot_checksum: snapshot.checksum,
    set_reconciliation: RECON_PATH,
    actions,
    checksum: null
  };
  manifest.checksum = checksum(manifest.actions);
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return manifest;
}

async function runApply(ctx, sb, manifest, snapshot) {
  if (String(process.env.CELEBRITY_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("Set CELEBRITY_DISCOVERY_WRITE_ENABLED=true temporarily for close-out apply");
  }

  const inserts = manifest.actions.filter((a) => a.action === "insert_missing_eligible");
  const hides = manifest.actions.filter((a) => a.action === "hide_reclassified_cruisetour");
  if (!inserts.length && !hides.length) {
    return { applied: false, reason: "no_deterministic_write_actions" };
  }

  const countsBefore = await captureBoundaryCounts(ctx.line.id, ctx.halLine?.id);
  fs.mkdirSync(path.dirname(BACKUP_PATH), { recursive: true });
  fs.writeFileSync(BACKUP_PATH, JSON.stringify({ counts_before: countsBefore, manifest_checksum: manifest.checksum }, null, 2));

  const today = new Date().toISOString().slice(0, 10);
  const simulation = await simulateCelebrityInventory({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today
  });

  const runId = `celebrity-closeout-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const rollbackEntries = [];
  const applied = [];

  const dbRun = await createCelebrityDiscoveryRun(supabase, {
    cruiseLineId: ctx.line.id,
    runId,
    mode: "production_write",
    runType: CELEBRITY_CLOSEOUT_RUN_TYPE,
    writesEnabled: true
  });

  let inserted = 0;
  let updated = 0;
  let failed = 0;

  try {
    for (const action of inserts) {
      const product = simulation.products.find((p) => p.official_product_key === action.official_sailing_id);
      if (!product || !product.complete_high_confidence || !isEligibleCelebrityCruise(product.product_type)) {
        failed += 1;
        applied.push({ ...action, result: "skipped_not_eligible_in_live_simulation" });
        continue;
      }
      const writeResult = await applyCelebrityBatchWrites({
        products: simulation.products,
        cruiseLine: ctx.line,
        maxWrites: 1,
        runId,
        supabase,
        controlledSelection: [product]
      });
      inserted += writeResult.stats.inserted || 0;
      failed += writeResult.stats.failed || 0;
      for (const detail of writeResult.stats.write_details || []) {
        rollbackEntries.push({
          action: "delete_inserted",
          discovered_cruise_id: detail.discovered_cruise_id,
          official_sailing_id: detail.celebrity_sailing_id,
          rollback: { delete_on_rollback: true }
        });
      }
      applied.push({ ...action, write_result: writeResult.stats });
    }

    for (const action of hides) {
      const rows = await supabase(
        `discovered_cruises?id=eq.${encodeURIComponent(action.discovered_cruise_id)}&select=*&limit=1`
      );
      const before = rows?.[0];
      if (!before) continue;
      rollbackEntries.push({
        action: "restore_hidden",
        discovered_cruise_id: before.id,
        official_sailing_id: action.official_sailing_id,
        rollback: action.rollback_values,
        before
      });
      await supabase(`discovered_cruises?id=eq.${encodeURIComponent(before.id)}`, {
        method: "PATCH",
        body: { status: "hidden", updated_at: new Date().toISOString() }
      });
      updated += 1;
      applied.push({ ...action, result: "hidden" });
    }

    const rollbackDoc = {
      generated_at: new Date().toISOString(),
      run_id: runId,
      db_run_id: dbRun.id,
      manifest_checksum: manifest.checksum,
      source_snapshot_checksum: snapshot.checksum,
      rollback_entries: rollbackEntries
    };
    fs.writeFileSync(ROLLBACK_PATH, JSON.stringify(rollbackDoc, null, 2));

    await finalizeCelebrityDiscoveryRun(supabase, dbRun.id, {
      status: failed > 0 ? "failed" : "completed",
      stats: buildCelebrityRunStats({
        runType: CELEBRITY_CLOSEOUT_RUN_TYPE,
        mode: "production_write",
        runId,
        writesEnabled: true,
        proposedWrites: inserts.length + hides.length,
        inserted,
        updated,
        failed,
        rollbackManifest: path.basename(ROLLBACK_PATH),
        sourceSession: { manifest: path.basename(MANIFEST_PATH), snapshot_checksum: snapshot.checksum }
      })
    });
  } catch (err) {
    await finalizeCelebrityDiscoveryRun(supabase, dbRun.id, {
      status: "failed",
      stats: buildCelebrityRunStats({ runType: CELEBRITY_CLOSEOUT_RUN_TYPE, runId, failed: 1 }),
      errorMessage: err.message
    });
    throw err;
  }

  const countsAfter = await captureBoundaryCounts(ctx.line.id, ctx.halLine?.id);
  return { applied: true, run_id: runId, inserted, updated, failed, applied_actions: applied, counts_before: countsBefore, counts_after: countsAfter, rollback_path: ROLLBACK_PATH };
}

async function backfillReconciliationRun(ctx) {
  const controlledManifest = path.join(root, "reports/celebrity-first-production-batch-manifest-2026-08-06-v2.json");
  const autoSession = path.join(root, "reports/celebrity-automatic-continuation-2026-08-06T06-24-09-878Z.json");
  const runId = `celebrity-import-reconciliation-${DATE}`;

  const existing = await supabase(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(ctx.line.id)}&select=id,stats&limit=100`
  );
  if ((existing || []).some((r) => r.stats?.run_type === CELEBRITY_RECON_RUN_TYPE && r.stats?.run_id === runId)) {
    return { skipped: true, reason: "reconciliation_run_already_exists", run_id: runId };
  }

  const dbRun = await createCelebrityDiscoveryRun(supabase, {
    cruiseLineId: ctx.line.id,
    runId,
    mode: "reconciliation_metadata",
    runType: CELEBRITY_RECON_RUN_TYPE,
    writesEnabled: false
  });

  const stats = buildCelebrityRunStats({
    runType: CELEBRITY_RECON_RUN_TYPE,
    mode: "reconciliation_metadata",
    runId,
    writesEnabled: false,
    inserted: 0,
    updated: 0,
    backfilled: true,
    triggeredBy: "celebrity_import_reconciliation",
    sourceSession: {
      controlled_batch_records: 40,
      final_full_queue_records: 803,
      total_untracked_records: 843,
      controlled_manifest: path.basename(controlledManifest),
      controlled_manifest_checksum: sha256File(controlledManifest),
      final_session_file: path.basename(autoSession),
      final_session_checksum: sha256File(autoSession),
      note: "Historical local imports; not a single execution batch"
    }
  });
  stats.records_attributed = 843;
  stats.controlled_batch_records = 40;
  stats.final_full_queue_records = 803;

  await finalizeCelebrityDiscoveryRun(supabase, dbRun.id, {
    status: "completed",
    stats
  });

  return { created: true, run_id: runId, db_run_id: dbRun.id, stats };
}

async function runVerify(ctx, sb) {
  const inventory = await loadCelebrityDatabaseInventoryCounts(supabase, ctx.line.id);
  const counts = await captureBoundaryCounts(ctx.line.id, ctx.halLine?.id);
  const running = await supabase(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(ctx.line.id)}&status=eq.running&select=id,stats&limit=5`
  );

  const activeSample = await sb.get(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(ctx.line.id)}&status=eq.active&select=id,official_sailing_id,raw_extract&limit=5`
  );

  return {
    inventory,
    boundary_counts: counts,
    active_sample: activeSample,
    running_celebrity_workers: (running || []).length,
    manifest_path: fs.existsSync(MANIFEST_PATH) ? MANIFEST_PATH : null,
    rollback_path: fs.existsSync(ROLLBACK_PATH) ? ROLLBACK_PATH : null
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!Object.values(args).some(Boolean)) {
    console.error("Use --snapshot, --reconcile, --manifest, --apply, --backfill-reconciliation-run, --verify, or --all");
    process.exit(1);
  }

  const sb = createSupabaseRest(root);
  const ctx = await loadCtx(sb);
  const result = {};

  if (args.snapshot || args.all) {
    result.snapshot = await runSnapshot(ctx);
    console.log("Snapshot:", SNAPSHOT_PATH, "eligible:", result.snapshot.eligible_count);
  }

  const snapshot =
    result.snapshot ||
    (fs.existsSync(SNAPSHOT_PATH) ? JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) : null);
  if ((args.reconcile || args.manifest || args.all) && !snapshot) {
    throw new Error("Snapshot required; run --snapshot first");
  }

  if (args.reconcile || args.all) {
    result.reconciliation = await runReconcile(ctx, sb, snapshot);
    console.log("Reconciliation:", RECON_PATH);
    console.log("Missing:", result.reconciliation.set_counts.eligible_missing_from_production);
    console.log("Active not eligible:", result.reconciliation.set_counts.active_not_in_current_eligible_set);
  }

  const recon =
    result.reconciliation ||
    (fs.existsSync(RECON_PATH) ? JSON.parse(fs.readFileSync(RECON_PATH, "utf8")) : null);

  if (args.manifest || args.all) {
    result.manifest = buildManifest(recon, snapshot);
    console.log("Manifest:", MANIFEST_PATH, "actions:", result.manifest.actions.filter((a) => a.action !== "unchanged").length);
  }

  if (args.apply || args.all) {
    const manifest =
      result.manifest ||
      (fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) : null);
    result.apply = await runApply(ctx, sb, manifest, snapshot);
    console.log("Apply:", JSON.stringify(result.apply, null, 2));
  }

  if (args.backfillReconRun || args.all) {
    result.backfill = await backfillReconciliationRun(ctx);
    console.log("Backfill:", JSON.stringify(result.backfill, null, 2));
  }

  if (args.verify || args.all) {
    result.verify = await runVerify(ctx, sb);
    console.log("Verify:", JSON.stringify(result.verify, null, 2));
  }

  if (!args.all) return;
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
