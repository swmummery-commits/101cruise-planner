/**
 * Celebrity Cruises Discovery batch runner — read-only by default.
 */

const {
  ADAPTER_ID,
  ADAPTER_VERSION,
  DEFAULT_PAGE_SIZE,
  fetchCelebrityInventoryPages,
  expandGraphGroupsToRawSailings,
  normaliseCelebrityProduct,
  computeCelebrityMetrics
} = require("./celebrity-discovery-adapter");
const { isCelebrityDiscoveryWriteEnabled } = require("./celebrity-discovery-automation");

const DEFAULT_PAGES_PER_EXECUTION = 12;
const DEFAULT_MAX_CANDIDATES = 100;
const REQUEST_DELAY_MS = 150;

const activeRunLocks = new Map();

function emptyBatchStats(skipStart = 0) {
  return {
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    api_calls: 0,
    pages_fetched: 0,
    skip_start: skipStart,
    next_skip: skipStart,
    num_found_official: 0,
    itinerary_groups_seen: 0,
    sailing_products_normalised: 0,
    product_type_cruise: 0,
    product_type_cruisetour: 0,
    product_type_unknown: 0,
    duplicates_suppressed: 0,
    writes_attempted: 0,
    writes_performed: 0,
    batch_status: "partial"
  };
}

function acquireRunLock(runId) {
  const id = String(runId || "").trim();
  if (!id) return { acquired: true, run_id: null };
  if (activeRunLocks.has(id)) return { acquired: false, run_id: id, reason: "overlapping_run_blocked" };
  activeRunLocks.set(id, Date.now());
  return { acquired: true, run_id: id };
}

function releaseRunLock(runId) {
  const id = String(runId || "").trim();
  if (id) activeRunLocks.delete(id);
}

async function runCelebrityDiscoveryBatch({
  mode = "production_read_only",
  runId = null,
  skipStart = 0,
  maxPages = DEFAULT_PAGES_PER_EXECUTION,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
  pageSize = DEFAULT_PAGE_SIZE,
  cruiseLine,
  ships = [],
  destinations = [],
  today = new Date().toISOString().slice(0, 10)
} = {}) {
  const requestedWrite = mode === "production_write";
  if (requestedWrite && !isCelebrityDiscoveryWriteEnabled()) {
    return {
      ok: false,
      blocked: true,
      reason: "celebrity_write_flag_disabled",
      writes_performed: false,
      stats: emptyBatchStats(skipStart)
    };
  }

  const lock = acquireRunLock(runId);
  if (!lock.acquired) {
    return {
      ok: false,
      blocked: true,
      reason: lock.reason,
      writes_performed: false,
      stats: emptyBatchStats(skipStart)
    };
  }

  try {
    const stats = emptyBatchStats(skipStart);
    const fetchResult = await fetchCelebrityInventoryPages({
      pageSize,
      maxPages,
      startSkip: skipStart,
      requestDelayMs: REQUEST_DELAY_MS
    });
    stats.api_calls = fetchResult.pagination_requests;
    stats.pages_fetched = fetchResult.pagination_requests;
    stats.num_found_official = fetchResult.total_official;
    stats.itinerary_groups_seen = fetchResult.groups.length;
    stats.next_skip = fetchResult.next_skip ?? skipStart + fetchResult.groups.length;

    const expanded = expandGraphGroupsToRawSailings(fetchResult.groups, { today, futureOnly: true });
    stats.duplicates_suppressed =
      (expanded.audit?.duplicate_sailing_ids || 0) + (expanded.audit?.duplicate_group_ids || 0);

    const context = { cruiseLine, ships, destinations, today };
    const products = [];
    for (const raw of expanded.products) {
      const normalised = normaliseCelebrityProduct(raw, context);
      products.push(normalised);
      if (normalised.product_type === "cruise") stats.product_type_cruise += 1;
      else if (normalised.product_type === "cruisetour") stats.product_type_cruisetour += 1;
      else stats.product_type_unknown += 1;
      if (products.length >= maxCandidates) break;
    }
    stats.sailing_products_normalised = products.length;

    const cruiseMetrics = computeCelebrityMetrics(products);
    const batchStatus =
      stats.next_skip >= stats.num_found_official && stats.num_found_official > 0 ? "completed" : "partial";
    stats.batch_status = batchStatus;

    return {
      ok: fetchResult.ok,
      blocked: false,
      mode,
      writes_performed: false,
      cursor: { start: skipStart, next_start: stats.next_skip, total: stats.num_found_official },
      stats,
      cruise_metrics: cruiseMetrics,
      products: products.slice(0, maxCandidates),
      page_log: fetchResult.page_log
    };
  } finally {
    releaseRunLock(runId);
  }
}

module.exports = {
  DEFAULT_PAGES_PER_EXECUTION,
  DEFAULT_MAX_CANDIDATES,
  runCelebrityDiscoveryBatch
};
