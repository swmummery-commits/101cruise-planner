/**
 * Resumable Celebrity Cruises Discovery batch runner.
 * Paginates the official Celebrity GraphQL API in bounded chunks suitable for Netlify functions.
 */

const {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  DEFAULT_PAGE_SIZE,
  fetchCelebrityInventoryPages,
  fetchAllCelebrityRawSailings,
  expandGraphGroupsToRawSailings,
  normaliseCelebrityProduct,
  computeCelebrityMetrics,
  isEligibleCelebrityCruise,
  isCelebrityCruisetour
} = require("./celebrity-discovery-adapter");
const { resolveCelebrityDiscoveryMode, assertCelebrityWritesAllowed } = require("./celebrity-discovery-mode");
const {
  applyCelebrityBatchWrites,
  buildCelebrityBatchManifest,
  selectControlledBatchProducts,
  evaluateAcceptanceGate
} = require("./celebrity-discovery-writes");
const { supabase: defaultSupabase } = require("./cruise-discovery-ops");
const { createCelebrityBatchTiming } = require("./celebrity-discovery-timing");
const {
  createCelebrityDiscoveryRun,
  finalizeCelebrityDiscoveryRun,
  buildCelebrityRunStats,
  CELEBRITY_RUN_TYPE,
  CELEBRITY_AUTO_RUN_TYPE
} = require("./celebrity-discovery-run-tracking");
const {
  evaluateCelebrityQualityGate,
  celebrityAutomaticLimits,
  isCelebrityAutomaticContinuationEnabled
} = require("./celebrity-discovery-automation");

const DEFAULT_PAGES_PER_EXECUTION = 12;
const DEFAULT_MAX_CANDIDATES_PER_EXECUTION = 100;
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
    product_type_ocean_cruise: 0,
    product_type_river_cruise: 0,
    product_type_ocean_cruisetour: 0,
    product_type_river_cruisetour: 0,
    product_type_unknown: 0,
    duplicates_suppressed: 0,
    writes_attempted: 0,
    writes_performed: 0,
    inserted: 0,
    updated: 0,
    ocean_inserts: 0,
    river_inserts: 0,
    duplicate_skips: 0,
    incomplete_skips: 0,
    ocean_cruisetour_skips: 0,
    river_cruisetour_skips: 0,
    invalid_skips: 0,
    failed_writes: 0,
    batch_status: "partial"
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveBatchStatus({ nextSkip, numFound, failed }) {
  if (failed) return "failed";
  if (numFound > 0 && nextSkip >= numFound) return "completed";
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

async function fetchCelebrityBatchPages({
  skipStart = 0,
  maxPages = DEFAULT_PAGES_PER_EXECUTION,
  pageSize = DEFAULT_PAGE_SIZE,
  today,
  useCache = false
} = {}) {
  const todayIso = today || new Date().toISOString().slice(0, 10);
  const fetchResult = await fetchCelebrityInventoryPages({
    pageSize,
    maxPages,
    startSkip: skipStart,
    requestDelayMs: REQUEST_DELAY_MS,
    useCache
  });

  const expanded = expandGraphGroupsToRawSailings(fetchResult.groups, { today: todayIso, futureOnly: true });
  return {
    ok: fetchResult.ok,
    pageLog: fetchResult.page_log || [],
    products: expanded.products,
    numFound: fetchResult.total_official || 0,
    apiCalls: fetchResult.pagination_requests || 0,
    nextSkip: fetchResult.next_skip ?? skipStart,
    duplicatesSuppressed:
      (expanded.audit?.duplicate_sailing_ids || 0) + (expanded.audit?.duplicate_group_ids || 0),
    groupsSeen: fetchResult.groups?.length || 0,
    ingestionAudit: expanded.audit
  };
}

function summariseNormalisedRows(rows) {
  const destinationCounts = {};
  const shipCounts = {};
  const stats = emptyBatchStats();

  for (const row of rows) {
    if (row.product_type === "ocean_cruise") stats.product_type_ocean_cruise += 1;
    else if (row.product_type === "river_cruise") stats.product_type_river_cruise += 1;
    else if (row.product_type === "ocean_cruisetour") stats.product_type_ocean_cruisetour += 1;
    else if (row.product_type === "river_cruisetour") stats.product_type_river_cruisetour += 1;
    else stats.product_type_unknown += 1;

    if (isEligibleCelebrityCruise(row.product_type)) {
      const dest = row.destination_resolution?.destinationKey;
      if (dest) destinationCounts[dest] = (destinationCounts[dest] || 0) + 1;
      const ship = row.raw?.ship_name;
      if (ship) shipCounts[ship] = (shipCounts[ship] || 0) + 1;
    }
  }

  stats.sailing_products_normalised = rows.length;
  const cruiseMetrics = computeCelebrityMetrics(rows);
  return { stats, destinationCounts, shipCounts, cruiseMetrics };
}

async function runCelebrityDiscoveryBatch(context = {}) {
  const modeGate = resolveCelebrityDiscoveryMode(context.mode);
  const runId = String(context.runId || context.run_id || "").trim() || null;
  const skipStart = Number(context.skipStart ?? context.skip_start ?? context.cursorStart ?? context.cursor_start ?? 0) || 0;
  const lock = acquireRunLock(runId || `celebrity-batch-${skipStart}`);
  if (!lock.acquired) {
    return {
      ok: false,
      blocked: true,
      reason: lock.reason,
      mode: modeGate,
      writes_performed: false
    };
  }

  const stats = emptyBatchStats(skipStart);
  const timing = createCelebrityBatchTiming();
  timing.startBatch();
  let dbRun = null;

  try {
    timing.start("celebrity_api_fetch");
    let fetchResult;
    let fullInventory = false;
    const controlledSailingIds = context.controlledSailingIds || context.controlled_sailing_ids || null;

    if (controlledSailingIds?.length || context.controlledBatch && context.performWrites) {
      fullInventory = true;
      const all = await fetchAllCelebrityRawSailings({
        today: context.today,
        maxPages: null,
        pageSize: context.pageSize ?? context.page_size ?? DEFAULT_PAGE_SIZE
      });
      fetchResult = {
        ok: all.ok,
        pageLog: all.page_log || [],
        products: all.raw_sailings || [],
        numFound: all.total_official || 0,
        apiCalls: all.pagination_requests || 0,
        nextSkip: all.total_official || 0,
        duplicatesSuppressed:
          (all.ingestion_audit?.duplicate_sailing_ids || 0) + (all.ingestion_audit?.duplicate_group_ids || 0),
        groupsSeen: all.itinerary_groups_fetched || 0,
        ingestionAudit: all.ingestion_audit
      };
    } else {
      fetchResult = await fetchCelebrityBatchPages({
        skipStart,
        maxPages: context.maxPages ?? context.max_pages ?? DEFAULT_PAGES_PER_EXECUTION,
        pageSize: context.pageSize ?? context.page_size ?? DEFAULT_PAGE_SIZE,
        today: context.today,
        useCache: context.useCache !== false
      });
    }
    timing.end("celebrity_api_fetch");

    if (!fetchResult.ok) {
      stats.batch_status = "failed";
      return {
        ok: false,
        mode: modeGate,
        writes_performed: false,
        stats: { ...stats, batch_status: "failed", error: fetchResult.error || "fetch_failed" },
        timing: timing.snapshot()
      };
    }

    timing.start("normalisation");
    const normalised = [];
    const maxCandidates =
      context.maxCandidates ?? context.max_candidates ?? DEFAULT_MAX_CANDIDATES_PER_EXECUTION;
    const normalizeAllFetched =
      fullInventory || Boolean(context.automatic) || Boolean(context.controlledBatch && context.performWrites);
    const productsToNormalise = normalizeAllFetched
      ? fetchResult.products
      : fetchResult.products.slice(0, maxCandidates);
    for (const raw of productsToNormalise) {
      normalised.push(normaliseCelebrityProduct(raw, context));
    }
    timing.end("normalisation");

    const summary = summariseNormalisedRows(normalised);
    stats.api_calls = fetchResult.apiCalls;
    stats.pages_fetched = fetchResult.pageLog.length;
    stats.skip_start = skipStart;
    stats.next_skip = fetchResult.nextSkip;
    stats.num_found_official = fetchResult.numFound;
    stats.itinerary_groups_seen = fetchResult.groupsSeen;
    stats.sailing_products_normalised = normalised.length;
    stats.duplicates_suppressed = fetchResult.duplicatesSuppressed;
    Object.assign(stats, {
      product_type_ocean_cruise: summary.stats.product_type_ocean_cruise,
      product_type_river_cruise: summary.stats.product_type_river_cruise,
      product_type_ocean_cruisetour: summary.stats.product_type_ocean_cruisetour,
      product_type_river_cruisetour: summary.stats.product_type_river_cruisetour,
      product_type_unknown: summary.stats.product_type_unknown
    });
    stats.batch_status = deriveBatchStatus({
      nextSkip: fetchResult.nextSkip,
      numFound: fetchResult.numFound,
      failed: false
    });

    const controlledSelection =
      context.controlledSelection ||
      (controlledSailingIds?.length
        ? normalised.filter((p) => controlledSailingIds.includes(p.official_product_key))
        : null) ||
      (context.controlledBatch
        ? selectControlledBatchProducts(normalised, {
            oceanTarget: context.oceanTarget ?? 20,
            riverTarget: context.riverTarget ?? 20,
            maxWrites: context.maxWrites ?? context.max_writes ?? 40
          })
        : null);

    const writeSource = controlledSelection || normalised;
    const eligibleWrites = writeSource.filter((n) => n.complete_high_confidence && isEligibleCelebrityCruise(n.product_type));
    const maxWrites = Math.min(
      500,
      Math.max(0, Number(context.maxWrites ?? context.max_writes ?? DEFAULT_MAX_CANDIDATES_PER_EXECUTION) || DEFAULT_MAX_CANDIDATES_PER_EXECUTION)
    );
    stats.writes_attempted = Math.min(eligibleWrites.length, maxWrites);

    let writeResult = null;
    let manifest = null;
    const sb = context.supabase || defaultSupabase;
    const recordRun = context.recordRun === true;
    const automatic = Boolean(context.automatic || isCelebrityAutomaticContinuationEnabled());

    if (recordRun && context.cruiseLine?.id && sb) {
      dbRun = await createCelebrityDiscoveryRun(sb, {
        cruiseLineId: context.cruiseLine.id,
        runId,
        mode: modeGate,
        skipStart,
        automatic,
        writesEnabled: modeGate.writes_allowed
      });
    }

    if (context.buildManifest) {
      timing.start("manifest_generation");
      manifest = await buildCelebrityBatchManifest({
        products: normalised,
        cruiseLine: context.cruiseLine,
        destinations: context.destinations,
        supabase: sb,
        runId: runId || context.run_id,
        controlledBatch: Boolean(context.controlledBatch),
        controlledSelection
      });
      timing.end("manifest_generation");
    }

    let writesPerformed = false;
    if (modeGate.writes_allowed && context.performWrites) {
      assertCelebrityWritesAllowed(modeGate);
      if (manifest) {
        const preWriteGate = evaluateAcceptanceGate(manifest, {
          minOcean: context.controlledBatch ? 1 : 0,
          minRiver: context.controlledBatch ? 1 : 0,
          maxWrites: context.controlledBatch ? 40 : maxWrites
        });
        if (!preWriteGate.passed) {
          stats.batch_status = "failed";
          stats.automatic_gate_failures = preWriteGate.failures.map((f) => `pre_write_acceptance:${f}`);
          if (dbRun?.id) {
            await finalizeCelebrityDiscoveryRun(sb, dbRun.id, {
              status: "failed",
              stats: buildCelebrityRunStats({
                runType: automatic ? CELEBRITY_AUTO_RUN_TYPE : CELEBRITY_RUN_TYPE,
                mode: modeGate,
                skipStart,
                skipEnd: stats.next_skip,
                pagesFetched: stats.pages_fetched,
                productsEncountered: stats.sailing_products_normalised,
                proposedWrites: stats.writes_attempted,
                inserted: 0,
                updated: 0,
                failed: 0,
                nextSkip: skipStart,
                numFoundOfficial: stats.num_found_official,
                cruiseMetrics: summary.cruiseMetrics,
                writesEnabled: modeGate.writes_allowed,
                runId
              }),
              errorMessage: stats.automatic_gate_failures.join("; ")
            });
          }
          return {
            ok: false,
            blocked: false,
            mode: modeGate,
            writes_performed: false,
            manifest,
            automatic_gate: { passed: false, failures: stats.automatic_gate_failures },
            run_record_id: dbRun?.id || null,
            timing: timing.snapshot(),
            stats: { ...stats, batch_status: "failed" }
          };
        }
      }

      const autoLimits = celebrityAutomaticLimits();
      timing.start("writes_total");
      writeResult = await applyCelebrityBatchWrites({
        products: normalised,
        cruiseLine: context.cruiseLine,
        maxWrites,
        runId: runId || context.run_id,
        supabase: sb,
        writeConcurrency: context.writeConcurrency ?? autoLimits.write_concurrency,
        timing,
        controlledSelection
      });
      timing.end("writes_total");

      stats.writes_performed = (writeResult.stats.inserted || 0) + (writeResult.stats.updated || 0);
      stats.inserted = writeResult.stats.inserted;
      stats.updated = writeResult.stats.updated;
      stats.ocean_inserts = writeResult.stats.ocean_inserts;
      stats.river_inserts = writeResult.stats.river_inserts;
      stats.duplicate_skips = writeResult.stats.duplicate_skips;
      stats.incomplete_skips = writeResult.stats.incomplete_skips;
      stats.ocean_cruisetour_skips = writeResult.stats.ocean_cruisetour_skips;
      stats.river_cruisetour_skips = writeResult.stats.river_cruisetour_skips;
      stats.invalid_skips = writeResult.stats.invalid_skips;
      stats.failed_writes = writeResult.stats.failed;
      writesPerformed = stats.writes_performed > 0;

      if (manifest && automatic) {
        const autoGate = evaluateCelebrityQualityGate({
          cruiseMetrics: summary.cruiseMetrics,
          manifest,
          writeResult
        });
        if (!autoGate.passed) {
          stats.batch_status = "failed";
          stats.automatic_gate_failures = autoGate.failures;
          if (dbRun?.id) {
            await finalizeCelebrityDiscoveryRun(sb, dbRun.id, {
              status: "failed",
              stats: buildCelebrityRunStats({
                runType: CELEBRITY_AUTO_RUN_TYPE,
                mode: modeGate,
                skipStart,
                skipEnd: stats.next_skip,
                pagesFetched: stats.pages_fetched,
                productsEncountered: stats.sailing_products_normalised,
                proposedWrites: stats.writes_attempted,
                inserted: stats.inserted,
                updated: stats.updated,
                failed: stats.failed_writes,
                nextSkip: skipStart,
                numFoundOfficial: stats.num_found_official,
                cruiseMetrics: summary.cruiseMetrics,
                writesEnabled: modeGate.writes_allowed,
                runId
              }),
              errorMessage: autoGate.failures.join("; ")
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
      const runStats = buildCelebrityRunStats({
        runType: automatic ? CELEBRITY_AUTO_RUN_TYPE : CELEBRITY_RUN_TYPE,
        mode: modeGate,
        skipStart,
        skipEnd: stats.next_skip,
        pagesFetched: stats.pages_fetched,
        productsEncountered: stats.sailing_products_normalised,
        proposedWrites: stats.writes_attempted,
        inserted: stats.inserted || 0,
        updated: stats.updated || 0,
        failed: stats.failed_writes || 0,
        nextSkip: stats.next_skip,
        numFoundOfficial: stats.num_found_official,
        cruiseMetrics: summary.cruiseMetrics,
        writesEnabled: modeGate.writes_allowed,
        runId
      });
      await finalizeCelebrityDiscoveryRun(sb, dbRun.id, {
        status: stats.batch_status === "failed" ? "failed" : "completed",
        stats: runStats,
        errorMessage: stats.error || null
      });
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
        start: skipStart,
        next_start: stats.next_skip,
        num_found: stats.num_found_official,
        completed: stats.batch_status === "completed"
      },
      stats,
      timing: timingSnapshot,
      cruise_metrics: summary.cruiseMetrics,
      destination_counts: summary.destinationCounts,
      ship_counts: summary.shipCounts,
      products: normalised,
      controlled_selection: controlledSelection
    };
  } catch (err) {
    if (dbRun?.id && (context.supabase || defaultSupabase)) {
      await finalizeCelebrityDiscoveryRun(context.supabase || defaultSupabase, dbRun.id, {
        status: "failed",
        stats: buildCelebrityRunStats({
          runType: CELEBRITY_RUN_TYPE,
          mode: modeGate,
          skipStart,
          skipEnd: stats.next_skip,
          pagesFetched: stats.pages_fetched,
          productsEncountered: stats.sailing_products_normalised,
          proposedWrites: stats.writes_attempted,
          inserted: stats.inserted || 0,
          updated: stats.updated || 0,
          failed: stats.failed_writes || 1,
          nextSkip: stats.next_skip,
          numFoundOfficial: stats.num_found_official,
          cruiseMetrics: {},
          writesEnabled: modeGate.writes_allowed,
          runId
        }),
        errorMessage: err.message || String(err)
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
  fetchCelebrityBatchPages,
  runCelebrityDiscoveryBatch,
  acquireRunLock,
  releaseRunLock,
  deriveBatchStatus,
  summariseNormalisedRows
};
