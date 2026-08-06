/**
 * Celebrity Discovery batch run records (cruise_discovery_runs).
 */

const { ADAPTER_ID, ADAPTER_VERSION } = require("./celebrity-discovery-adapter");
const { isCelebrityDiscoveryWriteEnabled, isCelebrityAutomaticContinuationEnabled } = require("./celebrity-discovery-automation");
const { loadCelebrityDatabaseInventoryCounts } = require("./celebrity-inventory-counts");

const CELEBRITY_RUN_TYPE = "celebrity_controlled_batch";
const CELEBRITY_AUTO_RUN_TYPE = "celebrity_automatic_batch";
const CELEBRITY_RECON_RUN_TYPE = "celebrity_import_reconciliation";
const CELEBRITY_CLOSEOUT_RUN_TYPE = "celebrity_closeout_repair";
const CELEBRITY_CLASSIFICATION_RUN_TYPE = "celebrity_classification_reconciliation";

function celebrityRunScope() {
  return "cruise_line";
}

function buildCelebrityRunStats({
  runType,
  mode,
  skipStart,
  skipEnd,
  pagesFetched,
  productsEncountered,
  proposedWrites,
  inserted = 0,
  updated = 0,
  failed = 0,
  duplicateSkips = 0,
  incompleteSkips = 0,
  nextSkip,
  numFoundOfficial,
  cruiseMetrics,
  writesEnabled,
  runId,
  timing = null,
  sourceSession = null,
  rollbackManifest = null,
  backfilled = false,
  triggeredBy = null
}) {
  const resolvedType = runType || CELEBRITY_RUN_TYPE;
  return {
    run_type: resolvedType,
    run_id: runId || null,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    mode: mode?.mode || mode || null,
    writes_enabled: writesEnabled,
    skip_start: skipStart ?? null,
    skip_end: skipEnd ?? null,
    next_skip: nextSkip ?? skipEnd ?? null,
    num_found_official: numFoundOfficial ?? null,
    pages_fetched: pagesFetched ?? 0,
    products_encountered: productsEncountered ?? 0,
    proposed_writes: proposedWrites ?? 0,
    inserted,
    updated,
    failed_writes: failed,
    duplicate_skips: duplicateSkips,
    incomplete_skips: incompleteSkips,
    ocean_inserts: cruiseMetrics?.ocean_inventory?.complete_high_confidence ?? null,
    river_inserts: cruiseMetrics?.river_inventory?.complete_high_confidence ?? null,
    cruise_metrics: cruiseMetrics || {},
    timing: timing || null,
    source_session: sourceSession || null,
    rollback_manifest: rollbackManifest || null,
    backfilled: Boolean(backfilled),
    triggered_by:
      triggeredBy ||
      (resolvedType === CELEBRITY_AUTO_RUN_TYPE
        ? "celebrity_automatic_continuation"
        : resolvedType === CELEBRITY_RECON_RUN_TYPE
          ? "celebrity_import_reconciliation"
          : resolvedType === CELEBRITY_CLOSEOUT_RUN_TYPE
            ? "celebrity_closeout_repair"
            : resolvedType === CELEBRITY_CLASSIFICATION_RUN_TYPE
              ? "celebrity_classification_reconciliation"
              : "celebrity_controlled_batch")
  };
}

async function createCelebrityDiscoveryRun(supabase, {
  cruiseLineId,
  runId,
  mode,
  skipStart,
  automatic = false,
  runType = null,
  writesEnabled = null
}) {
  const resolvedType =
    runType || (automatic ? CELEBRITY_AUTO_RUN_TYPE : CELEBRITY_RUN_TYPE);
  const enabled = writesEnabled != null ? Boolean(writesEnabled) : isCelebrityDiscoveryWriteEnabled();
  const insert = await supabase("cruise_discovery_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      scope: celebrityRunScope(),
      cruise_line_id: cruiseLineId,
      destination_id: null,
      status: "running",
      started_at: new Date().toISOString(),
      stats: buildCelebrityRunStats({
        runType: resolvedType,
        mode,
        skipStart,
        writesEnabled: enabled,
        runId
      })
    })
  });
  return insert?.[0] || null;
}

async function finalizeCelebrityDiscoveryRun(supabase, runId, { status, stats, errorMessage = null }) {
  if (!runId) return null;
  await supabase(`cruise_discovery_runs?id=eq.${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status,
      finished_at: new Date().toISOString(),
      stats,
      error_message: errorMessage || null
    })
  });
  return { id: runId, status, stats, error_message: errorMessage || null };
}

function sumTrackedRunInserts(runs) {
  let inserted = 0;
  let updated = 0;
  let failed = 0;
  let duplicateSkips = 0;
  for (const run of runs) {
    inserted += run.stats?.inserted || 0;
    updated += run.stats?.updated || 0;
    failed += run.stats?.failed_writes || 0;
    duplicateSkips += run.stats?.duplicate_skips || 0;
  }
  return { inserted, updated, failed, duplicate_skips: duplicateSkips };
}

function loadHistoricalUntrackedImportSummary() {
  return {
    label: "historical local import (reconciled)",
    controlled_batch_records: 40,
    final_full_queue_records: 803,
    total_untracked_records: 843,
    source_session_files: [
      "reports/celebrity-first-production-batch-manifest-2026-08-06-v2.json",
      "reports/celebrity-automatic-continuation-2026-08-06T06-24-09-878Z.json"
    ],
    note: "Local production writes executed without per-batch cruise_discovery_runs rows; reconciled via celebrity_import_reconciliation record."
  };
}

async function loadCelebrityInventoryProgress(supabase, cruiseLineId) {
  const runs = await supabase(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&scope=eq.cruise_line&select=id,scope,status,stats,started_at,finished_at,created_at,error_message&order=created_at.desc&limit=100`
  );

  const trackedTypes = new Set([
    CELEBRITY_RUN_TYPE,
    CELEBRITY_AUTO_RUN_TYPE,
    CELEBRITY_RECON_RUN_TYPE,
    CELEBRITY_CLOSEOUT_RUN_TYPE,
    CELEBRITY_CLASSIFICATION_RUN_TYPE
  ]);
  const celebrityRuns = (runs || []).filter((r) => trackedTypes.has(r.stats?.run_type));
  const batchRuns = celebrityRuns.filter((r) =>
    [CELEBRITY_RUN_TYPE, CELEBRITY_AUTO_RUN_TYPE].includes(r.stats?.run_type)
  );
  const reconRuns = celebrityRuns.filter((r) => r.stats?.run_type === CELEBRITY_RECON_RUN_TYPE);
  const closeoutRuns = celebrityRuns.filter((r) => r.stats?.run_type === CELEBRITY_CLOSEOUT_RUN_TYPE);
  const classificationRuns = celebrityRuns.filter((r) => r.stats?.run_type === CELEBRITY_CLASSIFICATION_RUN_TYPE);
  const latestClassification = classificationRuns[0] || null;
  const classificationStats = latestClassification?.stats || {};
  const completed = celebrityRuns.filter((r) => r.status === "completed");
  const last = celebrityRuns[0] || null;
  const lastCompleted = completed[0] || null;
  const nextSkip =
    last?.stats?.next_skip ??
    lastCompleted?.stats?.next_skip ??
    lastCompleted?.stats?.skip_end ??
    0;
  const numFound = lastCompleted?.stats?.num_found_official ?? last?.stats?.num_found_official ?? null;

  const inventory = await loadCelebrityDatabaseInventoryCounts(supabase, cruiseLineId);
  const trackedBatchTotals = sumTrackedRunInserts(batchRuns.filter((r) => r.status === "completed"));
  const historicalUntracked = loadHistoricalUntrackedImportSummary();
  const reconRecord = reconRuns.find((r) => r.stats?.backfilled) || reconRuns[0] || null;

  let oceanCruisetourSkips = 0;
  let riverCruisetourSkips = 0;
  for (const run of batchRuns.filter((r) => r.status === "completed")) {
    oceanCruisetourSkips += run.stats?.ocean_cruisetour_skips || 0;
    riverCruisetourSkips += run.stats?.river_cruisetour_skips || 0;
  }

  const paused = last?.status === "failed";
  const bulkImportComplete =
    inventory.active >= (historicalUntracked.total_untracked_records || 0) + (trackedBatchTotals.inserted || 0);

  return {
    cruise_line_id: cruiseLineId,
    inventory,
    inventory_state:
      bulkImportComplete && inventory.untyped_active === 0 && inventory.duplicate_official_identities === 0
        ? "completed"
        : paused
          ? "paused"
          : "in_progress",
    current_skip: nextSkip,
    next_eligible_skip: nextSkip,
    official_inventory_total: numFound,
    execution_history: {
      tracked_controlled_and_automatic_batches: batchRuns.filter((r) => r.status === "completed").length,
      tracked_run_inserts: trackedBatchTotals.inserted,
      tracked_run_updates: trackedBatchTotals.updated,
      tracked_run_failures: trackedBatchTotals.failed,
      tracked_duplicate_skips: trackedBatchTotals.duplicate_skips,
      historical_untracked_import: historicalUntracked,
      reconciliation_record: reconRecord
        ? {
            run_record_id: reconRecord.id,
            run_id: reconRecord.stats?.run_id,
            backfilled: reconRecord.stats?.backfilled === true,
            records_attributed: reconRecord.stats?.records_attributed || null
          }
        : null,
      closeout_repairs: closeoutRuns.map((r) => ({
        run_record_id: r.id,
        run_id: r.stats?.run_id,
        inserted: r.stats?.inserted || 0,
        status: r.status
      }))
    },
    display: {
      active_inventory_total: inventory.active,
      active_ocean_cruises: inventory.ocean_active,
      active_river_cruises: inventory.river_active,
      tracked_run_inserts: trackedBatchTotals.inserted,
      historical_reconciled_imports: historicalUntracked.total_untracked_records,
      official_eligible_snapshot_total: classificationStats.official_eligible_total ?? null,
      official_eligible_ocean: classificationStats.official_eligible_ocean ?? null,
      official_eligible_river: classificationStats.official_eligible_river ?? null,
      product_type_mismatch_count: classificationStats.product_type_mismatches ?? 0,
      out_of_snapshot_active_count: classificationStats.out_of_snapshot_active ?? null
    },
    classification_reconciliation: {
      last_run_id: classificationStats.run_id || null,
      last_run_record_id: latestClassification?.id || null,
      last_run_at: latestClassification?.finished_at || latestClassification?.created_at || null,
      product_type_mismatches: classificationStats.product_type_mismatches ?? 0,
      official_eligible_total: classificationStats.official_eligible_total ?? null,
      official_eligible_ocean: classificationStats.official_eligible_ocean ?? null,
      official_eligible_river: classificationStats.official_eligible_river ?? null,
      eligible_in_production_total: classificationStats.eligible_in_production_total ?? null,
      out_of_snapshot_active: classificationStats.out_of_snapshot_active ?? null,
      out_of_snapshot_sailing_ids: classificationStats.out_of_snapshot_sailing_ids || [],
      snapshot_checksum: classificationStats.snapshot_checksum || null,
      note: "Inventory counts from unique database rows; classification stats from latest reconciliation run"
    },
    ocean_cruisetours_excluded: oceanCruisetourSkips,
    river_cruisetours_excluded: riverCruisetourSkips,
    last_batch_duration_ms: lastCompleted?.stats?.timing?.total_ms ?? last?.stats?.timing?.total_ms ?? null,
    last_run_id: last?.stats?.run_id || null,
    last_run_record_id: last?.id || null,
    last_run_status: last?.status || null,
    last_run_type: last?.stats?.run_type || null,
    last_failure_reason: last?.error_message || last?.stats?.failure_reason || null,
    automatic_continuation_enabled: isCelebrityAutomaticContinuationEnabled(),
    write_enabled: isCelebrityDiscoveryWriteEnabled()
  };
}

async function findRunningCelebrityBatch(supabase, cruiseLineId) {
  const runs = await supabase(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&scope=eq.cruise_line&status=eq.running&select=id,status,stats,started_at&order=started_at.desc&limit=5`
  );
  return (runs || []).filter((r) =>
    [CELEBRITY_RUN_TYPE, CELEBRITY_AUTO_RUN_TYPE, CELEBRITY_CLOSEOUT_RUN_TYPE].includes(r.stats?.run_type)
  );
}

module.exports = {
  CELEBRITY_RUN_TYPE,
  CELEBRITY_AUTO_RUN_TYPE,
  CELEBRITY_RECON_RUN_TYPE,
  CELEBRITY_CLOSEOUT_RUN_TYPE,
  CELEBRITY_CLASSIFICATION_RUN_TYPE,
  buildCelebrityRunStats,
  createCelebrityDiscoveryRun,
  finalizeCelebrityDiscoveryRun,
  loadCelebrityInventoryProgress,
  loadCelebrityDatabaseInventoryCounts,
  findRunningCelebrityBatch,
  loadHistoricalUntrackedImportSummary
};
