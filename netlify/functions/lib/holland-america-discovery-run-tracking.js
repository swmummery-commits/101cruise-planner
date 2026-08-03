/**
 * Holland America controlled/automatic batch run records (cruise_discovery_runs).
 */

const { ADAPTER_ID, ADAPTER_VERSION } = require("./holland-america-discovery-adapter");
const { HAL_DISCOVERY_WRITE_ENABLED } = require("./holland-america-discovery-mode");

const HAL_RUN_TYPE = "hal_controlled_batch";
const HAL_AUTO_RUN_TYPE = "hal_automatic_batch";

function halRunScope() {
  return "cruise_line";
}

function halRunType({ automatic = false } = {}) {
  return automatic ? HAL_AUTO_RUN_TYPE : HAL_RUN_TYPE;
}

function buildHalRunStats({
  runType,
  mode,
  cursorStart,
  cursorEnd,
  pagesFetched,
  productsEncountered,
  proposedWrites,
  inserted,
  updated,
  skipped = {},
  failed,
  nextCursor,
  numFoundOfficial,
  timing,
  cruiseMetrics,
  destinationCounts,
  aggregatedHealth,
  writesEnabled,
  runId
}) {
  return {
    run_type: runType,
    run_id: runId || null,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    mode: mode?.mode || mode || null,
    writes_enabled: writesEnabled,
    cursor_start: cursorStart ?? null,
    cursor_end: cursorEnd ?? null,
    next_cursor: nextCursor ?? null,
    num_found_official: numFoundOfficial ?? null,
    pages_fetched: pagesFetched ?? 0,
    products_encountered: productsEncountered ?? 0,
    proposed_writes: proposedWrites ?? 0,
    inserted: inserted ?? 0,
    updated: updated ?? 0,
    duplicate_skips: skipped.duplicate_skips ?? 0,
    incomplete_skips: skipped.incomplete_skips ?? 0,
    cruisetour_skips: skipped.cruisetour_skips ?? 0,
    invalid_skips: skipped.invalid_skips ?? 0,
    failed_writes: failed ?? 0,
    europe_unresolved: aggregatedHealth?.europe_unresolved ?? 0,
    cruisetour_products: aggregatedHealth?.cruisetour_products ?? 0,
    fairbanks_land_embark: aggregatedHealth?.fairbanks_land_embark ?? 0,
    destination_counts: destinationCounts || {},
    cruise_metrics: cruiseMetrics || {},
    timing: timing || null,
    triggered_by: runType === "hal_automatic_batch" ? "hal_automatic_continuation" : "hal_controlled_batch"
  };
}

async function createHalDiscoveryRun(supabase, {
  cruiseLineId,
  runId,
  mode,
  cursorStart,
  automatic = false,
  writesEnabled = null
}) {
  const runType = automatic ? "hal_automatic_batch" : "hal_controlled_batch";
  const enabled =
    writesEnabled != null
      ? Boolean(writesEnabled)
      : String(process.env.HAL_DISCOVERY_WRITE_ENABLED || "").toLowerCase() === "true";

  const insert = await supabase("cruise_discovery_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      scope: halRunScope(),
      cruise_line_id: cruiseLineId,
      destination_id: null,
      status: "running",
      started_at: new Date().toISOString(),
      stats: buildHalRunStats({
        runType,
        mode,
        cursorStart,
        writesEnabled: enabled,
        runId
      })
    })
  });

  return insert?.[0] || null;
}

async function finalizeHalDiscoveryRun(supabase, runId, { status, stats, errorMessage = null }) {
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

async function completeHalDiscoveryRun(supabase, dbRunId, payload) {
  return finalizeHalDiscoveryRun(supabase, dbRunId, {
    status: "completed",
    stats: payload.stats,
    errorMessage: null
  });
}

async function failHalDiscoveryRun(supabase, dbRunId, { stats, errorMessage, reason }) {
  const merged = {
    ...(stats || {}),
    failure_reason: reason || errorMessage || "hal_batch_failed"
  };
  return finalizeHalDiscoveryRun(supabase, dbRunId, {
    status: "failed",
    stats: merged,
    errorMessage: errorMessage || reason || "HAL batch failed"
  });
}

async function loadHalInventoryProgress(supabase, cruiseLineId) {
  const runs = await supabase(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&scope=eq.cruise_line&select=id,scope,status,stats,started_at,finished_at,created_at,error_message&order=created_at.desc&limit=100`
  );

  const halRuns = (runs || []).filter((r) =>
    [HAL_RUN_TYPE, HAL_AUTO_RUN_TYPE].includes(r.stats?.run_type)
  );
  const completed = halRuns.filter((r) => r.status === "completed");
  const last = halRuns[0] || null;
  const lastCompleted = completed[0] || null;
  const nextCursor =
    lastCompleted?.stats?.next_cursor ??
    last?.stats?.next_cursor ??
    lastCompleted?.stats?.cursor_end ??
    0;
  const numFound = lastCompleted?.stats?.num_found_official ?? last?.stats?.num_found_official ?? null;

  let recordsActivated = 0;
  let batchesCompleted = 0;
  let cruisetourSkips = 0;
  let europeUnresolved = 0;
  for (const run of completed) {
    batchesCompleted += 1;
    recordsActivated += (run.stats?.inserted || 0) + (run.stats?.updated || 0);
    cruisetourSkips += run.stats?.cruisetour_skips || 0;
    europeUnresolved += run.stats?.europe_unresolved || 0;
  }

  const paused =
    last?.status === "failed" ||
    (last?.stats?.automatic_continuation === "paused" && last?.status !== "running");

  return {
    cruise_line_id: cruiseLineId,
    inventory_state: numFound != null && nextCursor >= numFound ? "completed" : paused ? "paused" : "in_progress",
    current_cursor: nextCursor,
    next_eligible_cursor: nextCursor,
    total_hal_api_results: numFound,
    completed_batches: batchesCompleted,
    records_activated: recordsActivated,
    skipped_cruisetours: cruisetourSkips,
    europe_unresolved_total: europeUnresolved,
    last_batch_duration_ms: lastCompleted?.stats?.timing?.total_ms ?? last?.stats?.timing?.total_ms ?? null,
    last_run_id: last?.stats?.run_id || null,
    last_run_record_id: last?.id || null,
    last_run_status: last?.status || null,
    last_run_type: last?.stats?.run_type || last?.scope || null,
    last_failure_reason: last?.error_message || last?.stats?.failure_reason || null,
    automatic_continuation_enabled: false
  };
}

module.exports = {
  HAL_RUN_TYPE,
  HAL_AUTO_RUN_TYPE,
  halRunScope,
  halRunType,
  buildHalRunStats,
  createHalDiscoveryRun,
  completeHalDiscoveryRun,
  failHalDiscoveryRun,
  loadHalInventoryProgress
};
