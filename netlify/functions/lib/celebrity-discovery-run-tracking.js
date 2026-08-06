/**
 * Celebrity Discovery batch run records (cruise_discovery_runs).
 */

const { ADAPTER_ID, ADAPTER_VERSION } = require("./celebrity-discovery-adapter");
const { isCelebrityDiscoveryWriteEnabled, isCelebrityAutomaticContinuationEnabled } = require("./celebrity-discovery-automation");

const CELEBRITY_RUN_TYPE = "celebrity_controlled_batch";
const CELEBRITY_AUTO_RUN_TYPE = "celebrity_automatic_batch";

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
  nextSkip,
  numFoundOfficial,
  cruiseMetrics,
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
    ocean_inserts: cruiseMetrics?.ocean_inventory?.complete_high_confidence ?? null,
    river_inserts: cruiseMetrics?.river_inventory?.complete_high_confidence ?? null,
    cruise_metrics: cruiseMetrics || {},
    triggered_by: runType === CELEBRITY_AUTO_RUN_TYPE ? "celebrity_automatic_continuation" : "celebrity_controlled_batch"
  };
}

async function createCelebrityDiscoveryRun(supabase, {
  cruiseLineId,
  runId,
  mode,
  skipStart,
  automatic = false,
  writesEnabled = null
}) {
  const runType = automatic ? CELEBRITY_AUTO_RUN_TYPE : CELEBRITY_RUN_TYPE;
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
      stats: buildCelebrityRunStats({ runType, mode, skipStart, writesEnabled: enabled, runId })
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

async function loadCelebrityInventoryProgress(supabase, cruiseLineId) {
  const runs = await supabase(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&scope=eq.cruise_line&select=id,scope,status,stats,started_at,finished_at,created_at,error_message&order=created_at.desc&limit=100`
  );

  const celebrityRuns = (runs || []).filter((r) =>
    [CELEBRITY_RUN_TYPE, CELEBRITY_AUTO_RUN_TYPE].includes(r.stats?.run_type)
  );
  const completed = celebrityRuns.filter((r) => r.status === "completed");
  const last = celebrityRuns[0] || null;
  const lastCompleted = completed[0] || null;
  const nextSkip =
    last?.stats?.next_skip ??
    lastCompleted?.stats?.next_skip ??
    lastCompleted?.stats?.skip_end ??
    0;
  const numFound = lastCompleted?.stats?.num_found_official ?? last?.stats?.num_found_official ?? null;

  let recordsActivated = 0;
  let batchesCompleted = 0;
  let oceanCruisetourSkips = 0;
  let riverCruisetourSkips = 0;
  for (const run of completed) {
    batchesCompleted += 1;
    recordsActivated += (run.stats?.inserted || 0) + (run.stats?.updated || 0);
    oceanCruisetourSkips += run.stats?.ocean_cruisetour_skips || 0;
    riverCruisetourSkips += run.stats?.river_cruisetour_skips || 0;
  }

  const paused = last?.status === "failed";

  return {
    cruise_line_id: cruiseLineId,
    inventory_state: numFound != null && nextSkip >= numFound ? "completed" : paused ? "paused" : "in_progress",
    current_skip: nextSkip,
    next_eligible_skip: nextSkip,
    official_inventory_total: numFound,
    completed_batches: batchesCompleted,
    records_activated: recordsActivated,
    ocean_cruisetours_excluded: oceanCruisetourSkips,
    river_cruisetours_excluded: riverCruisetourSkips,
    last_batch_duration_ms: lastCompleted?.stats?.timing?.total_ms ?? last?.stats?.timing?.total_ms ?? null,
    last_run_id: last?.stats?.run_id || null,
    last_run_record_id: last?.id || null,
    last_run_status: last?.status || null,
    last_run_type: last?.stats?.run_type || null,
    last_failure_reason: last?.error_message || last?.stats?.failure_reason || null,
    automatic_continuation_enabled: isCelebrityAutomaticContinuationEnabled()
  };
}

async function findRunningCelebrityBatch(supabase, cruiseLineId) {
  const runs = await supabase(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&scope=eq.cruise_line&status=eq.running&select=id,status,stats,started_at&order=started_at.desc&limit=5`
  );
  return (runs || []).filter((r) =>
    [CELEBRITY_RUN_TYPE, CELEBRITY_AUTO_RUN_TYPE].includes(r.stats?.run_type)
  );
}

module.exports = {
  CELEBRITY_RUN_TYPE,
  CELEBRITY_AUTO_RUN_TYPE,
  buildCelebrityRunStats,
  createCelebrityDiscoveryRun,
  finalizeCelebrityDiscoveryRun,
  loadCelebrityInventoryProgress,
  findRunningCelebrityBatch
};
