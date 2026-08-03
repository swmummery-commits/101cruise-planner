/**
 * Resumable Holland America Discovery batch runner.
 * Paginates the official HAL search API in bounded chunks suitable for Netlify functions.
 */

const {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  fetchHalSearchPage,
  parseRawVoyageFromDoc,
  normaliseHalVoyage,
  officialProductKey,
  classifyHalProductType,
  clearHalFetchCache
} = require("./holland-america-discovery-adapter");
const { resolveHalDiscoveryMode, assertHalWritesAllowed } = require("./holland-america-discovery-mode");
const { applyHalBatchWrites, buildHalBatchManifest } = require("./holland-america-discovery-writes");
const { supabase: defaultSupabase } = require("./cruise-discovery-ops");
const { createHalBatchTiming } = require("./holland-america-discovery-timing");
const {
  createHalDiscoveryRun,
  completeHalDiscoveryRun,
  failHalDiscoveryRun,
  buildHalRunStats
} = require("./holland-america-discovery-run-tracking");
const {
  evaluateAutomaticQualityGate,
  halAutomaticLimits,
  isHalAutomaticContinuationEnabled
} = require("./holland-america-discovery-automation");

const DEFAULT_PAGES_PER_EXECUTION = 12;
const DEFAULT_MAX_CANDIDATES_PER_EXECUTION = 100;
const DEFAULT_PAGE_SIZE = 100;
const REQUEST_DELAY_MS = 150;

const activeRunLocks = new Map();

function emptyBatchStats() {
  return {
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    api_calls: 0,
    pages_fetched: 0,
    cursor_start: 0,
    next_cursor_start: 0,
    num_found_official: 0,
    raw_docs_seen: 0,
    products_parsed: 0,
    products_normalised: 0,
    product_type_cruise: 0,
    product_type_cruisetour: 0,
    product_type_unknown: 0,
    duplicates_suppressed: 0,
    writes_attempted: 0,
    writes_performed: 0,
    batch_status: "partial",
    aggregated_health: {
      cruisetour_products: 0,
      europe_unresolved: 0,
      fairbanks_land_embark: 0
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveBatchStatus({ nextCursorStart, numFound, failed }) {
  if (failed) return "failed";
  if (numFound > 0 && nextCursorStart >= numFound) return "completed";
  return "partial";
}

function acquireRunLock(runId) {
  const id = String(runId || "").trim();
  if (!id) return { acquired: true, run_id: null };
  if (activeRunLocks.has(id)) {
    return { acquired: false, run_id: id, reason: "overlapping_run_blocked" };
  }
  activeRunLocks.set(id, Date.now());
  return { acquired: true, run_id: id };
}

function releaseRunLock(runId) {
  const id = String(runId || "").trim();
  if (id) activeRunLocks.delete(id);
}

async function fetchHalBatchPages({
  cursorStart = 0,
  maxPages = DEFAULT_PAGES_PER_EXECUTION,
  pageSize = DEFAULT_PAGE_SIZE,
  today,
  localePrefix = "en_us",
  useCache = true
} = {}) {
  if (!useCache) clearHalFetchCache();

  const pageLog = [];
  const products = [];
  const seenKeys = new Set();
  let numFound = 0;
  let start = Math.max(0, Number(cursorStart) || 0);
  let apiCalls = 0;
  let duplicatesSuppressed = 0;
  let rawDocsSeen = 0;
  const todayIso = today || new Date().toISOString().slice(0, 10);

  for (let page = 0; page < maxPages; page += 1) {
    const batch = await fetchHalSearchPage({ start, size: pageSize });
    apiCalls += 1;
    pageLog.push({
      start,
      ok: batch.ok,
      docs_returned: batch.docs?.length || 0,
      url: batch.url
    });

    if (!batch.ok) {
      return {
        ok: false,
        error: batch.error || "fetch_failed",
        pageLog,
        products,
        numFound,
        apiCalls,
        nextCursorStart: start,
        duplicatesSuppressed,
        rawDocsSeen
      };
    }

    numFound = batch.numFound || numFound;
    const docs = batch.docs || [];
    rawDocsSeen += docs.length;
    if (!docs.length) break;

    for (const doc of docs) {
      const raw = parseRawVoyageFromDoc(doc, localePrefix);
      if (!raw) continue;
      if (raw.departure_date && raw.departure_date < todayIso) continue;

      const key = officialProductKey(raw);
      if (seenKeys.has(key)) {
        duplicatesSuppressed += 1;
        continue;
      }
      seenKeys.add(key);
      products.push(raw);
    }

    start += docs.length;
    if (start >= numFound) break;
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }

  return {
    ok: true,
    pageLog,
    products,
    numFound,
    apiCalls,
    nextCursorStart: start,
    duplicatesSuppressed,
    rawDocsSeen
  };
}

function summariseNormalisedRows(rows) {
  const stats = emptyBatchStats();
  const failureCounts = {};
  const destinationCounts = {};
  const aggregatedHealth = {
    cruisetour_products: 0,
    europe_unresolved: 0,
    fairbanks_land_embark: 0
  };

  const cruises = rows.filter((r) => r.product_type === "cruise");
  const cruisetours = rows.filter((r) => r.product_type === "cruisetour");
  const unknown = rows.filter((r) => r.product_type === "unknown");

  stats.product_type_cruise = cruises.length;
  stats.product_type_cruisetour = cruisetours.length;
  stats.product_type_unknown = unknown.length;
  aggregatedHealth.cruisetour_products = cruisetours.length;

  for (const row of rows) {
    for (const reason of row.failure_reasons || []) {
      failureCounts[reason] = (failureCounts[reason] || 0) + 1;
    }
    if (row.product_type === "cruisetour") continue;
    if (row.destination_resolution?.destinationKey) {
      const k = row.destination_resolution.destinationKey;
      destinationCounts[k] = (destinationCounts[k] || 0) + 1;
    }
    if (row.failure_reasons?.includes("destination_unresolved") && row.raw?.destination_codes?.includes("E")) {
      aggregatedHealth.europe_unresolved += 1;
    }
    if (/fairbanks/i.test(row.raw?.departure_port || "") && row.product_type === "cruisetour") {
      aggregatedHealth.fairbanks_land_embark += 1;
    }
  }

  const cruiseTotal = cruises.length || 1;
  const complete = cruises.filter((n) => n.complete_high_confidence);
  const shipOk = cruises.filter((n) => n.ship_resolution?.resolved).length;
  const dateOk = cruises.filter((n) => n.candidate?.departure_date).length;
  const portOk = cruises.filter(
    (n) => n.candidate?.departure_port || n.candidate?.departure_port_meta?.status === "resolved"
  ).length;
  const destOk = cruises.filter((n) => n.destination_resolution?.status === "resolved").length;

  return {
    stats,
    failureCounts,
    destinationCounts,
    aggregatedHealth,
    cruise_metrics: {
      genuine_cruise_products: cruises.length,
      complete_high_confidence: complete.length,
      incomplete_cruise: cruises.length - complete.length,
      ship_match_rate_pct: Math.round((shipOk / cruiseTotal) * 1000) / 10,
      departure_date_rate_pct: Math.round((dateOk / cruiseTotal) * 1000) / 10,
      departure_port_rate_pct: Math.round((portOk / cruiseTotal) * 1000) / 10,
      destination_resolution_rate_pct: Math.round((destOk / cruiseTotal) * 1000) / 10,
      projected_activations: complete.length,
      projected_steve_reviews: cruises.filter((n) => n.destination_resolution?.status === "ambiguous").length
    }
  };
}

async function runHalDiscoveryBatch(context = {}) {
  const modeGate = resolveHalDiscoveryMode(context.mode);
  const runId = String(context.runId || context.run_id || "").trim() || null;
  const lock = acquireRunLock(runId || `hal-batch-${context.cursorStart || 0}`);
  if (!lock.acquired) {
    return {
      ok: false,
      blocked: true,
      reason: lock.reason,
      mode: modeGate,
      writes_performed: false
    };
  }

  const stats = emptyBatchStats();
  stats.mode = modeGate.mode;
  stats.writes_allowed = modeGate.writes_allowed;
  const timing = createHalBatchTiming();
  timing.startBatch();
  let dbRun = null;

  try {
    timing.start("hal_api_fetch");
    const fetchResult = await fetchHalBatchPages({
      cursorStart: context.cursorStart ?? context.cursor_start ?? 0,
      maxPages: context.maxPages ?? context.max_pages ?? DEFAULT_PAGES_PER_EXECUTION,
      pageSize: context.pageSize ?? context.page_size ?? DEFAULT_PAGE_SIZE,
      today: context.today,
      useCache: context.useCache !== false
    });
    timing.end("hal_api_fetch");

    if (!fetchResult.ok) {
      stats.batch_status = "failed";
      return {
        ok: false,
        mode: modeGate,
        writes_performed: false,
        stats: {
          ...stats,
          ...fetchResult,
          batch_status: "failed"
        },
        timing: timing.snapshot()
      };
    }

    timing.start("normalisation");
    const normalised = [];
    const maxCandidates =
      context.maxCandidates ??
      context.max_candidates ??
      DEFAULT_MAX_CANDIDATES_PER_EXECUTION;

    for (const raw of fetchResult.products.slice(0, maxCandidates)) {
      const productMeta = classifyHalProductType(raw);
      const row = normaliseHalVoyage(raw, { ...context, productMeta });
      normalised.push(row);
    }
    timing.end("normalisation");

    const summary = summariseNormalisedRows(normalised);
    stats.api_calls = fetchResult.apiCalls;
    stats.pages_fetched = fetchResult.pageLog.length;
    stats.cursor_start = context.cursorStart ?? context.cursor_start ?? 0;
    stats.next_cursor_start = fetchResult.nextCursorStart;
    stats.num_found_official = fetchResult.numFound;
    stats.raw_docs_seen = fetchResult.rawDocsSeen;
    stats.products_parsed = fetchResult.products.length;
    stats.products_normalised = normalised.length;
    stats.duplicates_suppressed = fetchResult.duplicatesSuppressed;
    stats.product_type_cruise = summary.stats.product_type_cruise;
    stats.product_type_cruisetour = summary.stats.product_type_cruisetour;
    stats.product_type_unknown = summary.stats.product_type_unknown;
    stats.aggregated_health = summary.aggregatedHealth;
    stats.batch_status = deriveBatchStatus({
      nextCursorStart: fetchResult.nextCursorStart,
      numFound: fetchResult.numFound,
      failed: false
    });

    const maxWrites = Math.min(
      500,
      Math.max(0, Number(context.maxWrites ?? context.max_writes ?? DEFAULT_MAX_CANDIDATES_PER_EXECUTION) || DEFAULT_MAX_CANDIDATES_PER_EXECUTION)
    );
    const eligibleWrites = normalised.filter((n) => n.complete_high_confidence && n.product_type === "cruise");
    stats.writes_attempted = Math.min(eligibleWrites.length, maxWrites);

    let writeResult = null;
    let manifest = null;
    const sb = context.supabase || defaultSupabase;
    const recordRun = context.recordRun === true;
    const automatic = Boolean(context.automatic || isHalAutomaticContinuationEnabled());

    if (recordRun && context.cruiseLine?.id && sb) {
      dbRun = await createHalDiscoveryRun(sb, {
        cruiseLineId: context.cruiseLine.id,
        runId,
        mode: modeGate,
        cursorStart: stats.cursor_start,
        automatic
      });
    }

    if (context.buildManifest) {
      timing.start("manifest_generation");
      manifest = await buildHalBatchManifest({
        products: normalised,
        cruiseLine: context.cruiseLine,
        destinations: context.destinations,
        supabase: sb,
        runId: runId || context.run_id
      });
      timing.end("manifest_generation");
    }

    let writesPerformed = false;
    if (modeGate.writes_allowed && context.performWrites) {
      assertHalWritesAllowed(modeGate);
      const autoLimits = halAutomaticLimits();
      timing.start("writes_total");
      writeResult = await applyHalBatchWrites({
        products: normalised,
        cruiseLine: context.cruiseLine,
        maxWrites,
        runId: runId || context.run_id,
        supabase: sb,
        writeConcurrency: context.writeConcurrency ?? autoLimits.write_concurrency,
        timing
      });
      timing.end("writes_total");
      stats.writes_performed = (writeResult.stats.inserted || 0) + (writeResult.stats.updated || 0);
      stats.inserted = writeResult.stats.inserted;
      stats.updated = writeResult.stats.updated;
      stats.duplicate_skips = writeResult.stats.duplicate_skips;
      stats.incomplete_skips = writeResult.stats.incomplete_skips;
      stats.cruisetour_skips = writeResult.stats.cruisetour_skips;
      stats.invalid_skips = writeResult.stats.invalid_skips;
      stats.failed_writes = writeResult.stats.failed;
      writesPerformed = stats.writes_performed > 0;

      if (context.buildManifest && manifest && automatic) {
        const autoGate = evaluateAutomaticQualityGate({
          manifest,
          stats,
          cruiseMetrics: summary.cruise_metrics,
          writeResult
        });
        if (!autoGate.passed) {
          stats.batch_status = "failed";
          stats.automatic_gate_failures = autoGate.failures;
          if (dbRun?.id) {
            await failHalDiscoveryRun(sb, dbRun.id, {
              stats: buildHalRunStats({
                runType: automatic ? "hal_automatic_batch" : "hal_controlled_batch",
                mode: modeGate,
                cursorStart: stats.cursor_start,
                cursorEnd: stats.next_cursor_start,
                pagesFetched: stats.pages_fetched,
                productsEncountered: stats.products_normalised,
                proposedWrites: stats.writes_attempted,
                inserted: stats.inserted,
                updated: stats.updated,
                skipped: stats,
                failed: stats.failed_writes,
                nextCursor: stats.next_cursor_start,
                numFoundOfficial: stats.num_found_official,
                timing: timing.snapshot(),
                cruiseMetrics: summary.cruise_metrics,
                destinationCounts: summary.destinationCounts,
                aggregatedHealth: stats.aggregated_health,
                writesEnabled: modeGate.writes_allowed,
                runId
              }),
              errorMessage: autoGate.failures.join("; "),
              reason: autoGate.failures[0]
            });
          }
          return {
            ok: false,
            blocked: false,
            mode: modeGate,
            writes_performed: writesPerformed,
            write_result: writeResult,
            manifest,
            automatic_gate: autoGate,
            run_record_id: dbRun?.id || null,
            timing: timing.snapshot(),
            stats: { ...stats, batch_status: "failed" }
          };
        }
      }
    }

    const timingSnapshot = timing.snapshot();
    stats.timing = timingSnapshot;

    if (dbRun?.id && sb) {
      const runStats = buildHalRunStats({
        runType: automatic ? "hal_automatic_batch" : "hal_controlled_batch",
        mode: modeGate,
        cursorStart: stats.cursor_start,
        cursorEnd: stats.next_cursor_start,
        pagesFetched: stats.pages_fetched,
        productsEncountered: stats.products_normalised,
        proposedWrites: stats.writes_attempted,
        inserted: stats.inserted || 0,
        updated: stats.updated || 0,
        skipped: {
          duplicate_skips: stats.duplicate_skips,
          incomplete_skips: stats.incomplete_skips,
          cruisetour_skips: stats.cruisetour_skips,
          invalid_skips: stats.invalid_skips
        },
        failed: stats.failed_writes || 0,
        nextCursor: stats.next_cursor_start,
        numFoundOfficial: stats.num_found_official,
        timing: timingSnapshot,
        cruiseMetrics: summary.cruise_metrics,
        destinationCounts: summary.destinationCounts,
        aggregatedHealth: stats.aggregated_health,
        writesEnabled: modeGate.writes_allowed,
        runId
      });
      if (stats.batch_status === "failed") {
        await failHalDiscoveryRun(sb, dbRun.id, {
          stats: runStats,
          errorMessage: stats.error || "HAL batch failed",
          reason: stats.error || "hal_batch_failed"
        });
      } else {
        await completeHalDiscoveryRun(sb, dbRun.id, { stats: runStats });
      }
    }

    return {
      ok: true,
      blocked: false,
      mode: modeGate,
      writes_performed: writesPerformed,
      write_result: writeResult,
      manifest,
      run_record_id: dbRun?.id || null,
      source: SOURCE_CONTRACT,
      page_log: fetchResult.pageLog,
      cursor: {
        start: stats.cursor_start,
        next_start: stats.next_cursor_start,
        num_found: stats.num_found_official,
        completed: stats.batch_status === "completed"
      },
      stats,
      timing: timingSnapshot,
      cruise_metrics: summary.cruise_metrics,
      failure_reason_counts: summary.failureCounts,
      destination_counts: summary.destinationCounts,
      products: normalised
    };
  } catch (err) {
    if (dbRun?.id && (context.supabase || defaultSupabase)) {
      await failHalDiscoveryRun(context.supabase || defaultSupabase, dbRun.id, {
        stats: buildHalRunStats({
          runType: "hal_controlled_batch",
          mode: modeGate,
          cursorStart: stats.cursor_start,
          cursorEnd: stats.next_cursor_start,
          pagesFetched: stats.pages_fetched,
          productsEncountered: stats.products_normalised,
          proposedWrites: stats.writes_attempted,
          inserted: stats.inserted || 0,
          updated: stats.updated || 0,
          skipped: stats,
          failed: stats.failed_writes || 1,
          nextCursor: stats.next_cursor_start,
          numFoundOfficial: stats.num_found_official,
          timing: timing.snapshot(),
          cruiseMetrics: {},
          destinationCounts: {},
          aggregatedHealth: stats.aggregated_health,
          writesEnabled: modeGate.writes_allowed,
          runId
        }),
        errorMessage: err.message || String(err),
        reason: "hal_batch_exception"
      }).catch(() => {});
    }
    throw err;
  } finally {
    releaseRunLock(runId || lock.run_id);
  }
}

module.exports = {
  DEFAULT_PAGES_PER_EXECUTION,
  DEFAULT_MAX_CANDIDATES_PER_EXECUTION,
  DEFAULT_PAGE_SIZE,
  REQUEST_DELAY_MS,
  emptyBatchStats,
  fetchHalBatchPages,
  runHalDiscoveryBatch,
  acquireRunLock,
  releaseRunLock,
  deriveBatchStatus,
  summariseNormalisedRows
};
