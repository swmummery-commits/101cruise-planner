/**
 * Celebrity Discovery batch run records (prepared; writes blocked by default).
 */

const { ADAPTER_ID, ADAPTER_VERSION } = require("./celebrity-discovery-adapter");
const { isCelebrityDiscoveryWriteEnabled } = require("./celebrity-discovery-automation");

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
    next_skip: nextSkip ?? null,
    num_found_official: numFoundOfficial ?? null,
    pages_fetched: pagesFetched ?? 0,
    products_encountered: productsEncountered ?? 0,
    proposed_writes: proposedWrites ?? 0,
    inserted,
    updated,
    failed_writes: failed,
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
  if (!isCelebrityDiscoveryWriteEnabled()) return null;
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
  if (!runId || !isCelebrityDiscoveryWriteEnabled()) return null;
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
  return { id: runId, status, stats };
}

function loadCelebrityInventoryProgress(runs = []) {
  const celebrityRuns = (runs || []).filter((r) => r?.stats?.adapter_id === ADAPTER_ID);
  const last = celebrityRuns[0];
  if (!last) {
    return {
      adapter_id: ADAPTER_ID,
      cursor: null,
      next_skip: 0,
      num_found_official: null,
      last_run_at: null,
      status: "not_started"
    };
  }
  return {
    adapter_id: ADAPTER_ID,
    cursor: last.stats?.skip_end ?? last.stats?.next_skip ?? null,
    next_skip: last.stats?.next_skip ?? 0,
    num_found_official: last.stats?.num_found_official ?? null,
    last_run_at: last.finished_at || last.started_at,
    status: last.status
  };
}

module.exports = {
  CELEBRITY_RUN_TYPE,
  CELEBRITY_AUTO_RUN_TYPE,
  buildCelebrityRunStats,
  createCelebrityDiscoveryRun,
  finalizeCelebrityDiscoveryRun,
  loadCelebrityInventoryProgress
};
