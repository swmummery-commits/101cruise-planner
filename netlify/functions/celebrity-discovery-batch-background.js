/**
 * Background worker: resumable Celebrity Cruises Discovery batches.
 *
 * Invoked with header x-discovery-cron-secret = DISCOVERY_CRON_SECRET.
 * Read-only by default; production_write remains blocked unless CELEBRITY_DISCOVERY_WRITE_ENABLED=true.
 */

const { runCelebrityDiscoveryBatch } = require("./lib/celebrity-discovery-batch");
const { catalogueDestinations } = require("./lib/celebrity-discovery-adapter");
const { supabase } = require("./lib/cruise-discovery-runner");
const { loadClassificationDestinations } = require("./lib/destination-queries");
const {
  celebrityAutomaticLimits,
  isCelebrityAutomaticContinuationEnabled
} = require("./lib/celebrity-discovery-automation");
const {
  loadCelebrityInventoryProgress,
  findRunningCelebrityBatch
} = require("./lib/celebrity-discovery-run-tracking");

function cronSecret() {
  return String(process.env.DISCOVERY_CRON_SECRET || "").trim();
}

function assertCronAuth(event) {
  const expected = cronSecret();
  if (!expected) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.statusCode = 503;
    throw err;
  }
  const provided = String(
    event.headers?.["x-discovery-cron-secret"] ||
      event.headers?.["X-Discovery-Cron-Secret"] ||
      ""
  ).trim();
  if (provided !== expected) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

exports.handler = async (event) => {
  try {
    assertCronAuth(event);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    const mode = String(body.mode || "production_read_only").trim();
    const skipStart = Number(body.skip_start ?? body.skipStart ?? body.cursor_start ?? body.cursorStart ?? 0) || 0;
    const maxPages = Math.min(20, Math.max(1, Number(body.max_pages ?? body.maxPages ?? 12) || 12));
    const maxWrites = Math.min(500, Math.max(0, Number(body.max_writes ?? body.maxWrites ?? 100) || 100));
    const runId = String(body.run_id || body.runId || `celebrity-batch-${Date.now()}`).trim();
    const performWrites = mode === "production_write" && body.perform_writes !== false;
    const buildManifest = body.build_manifest === true;
    const controlledBatch = body.controlled_batch === true;
    const controlledSailingIds = Array.isArray(body.controlled_sailing_ids)
      ? body.controlled_sailing_ids
      : Array.isArray(body.controlledSailingIds)
        ? body.controlledSailingIds
        : null;

    const automaticRequested =
      body.automatic === true ||
      (body.automatic !== false && isCelebrityAutomaticContinuationEnabled() && mode === "production_write");
    const autoLimits = celebrityAutomaticLimits();

    const lines = await supabase(
      "ci_cruise_lines?slug=eq.celebrity-cruises&select=id,name,slug,website_url,cruise_search_url&limit=1"
    );
    const line = lines?.[0];
    if (!line) {
      return {
        statusCode: 404,
        body: JSON.stringify({ success: false, error: "Celebrity Cruises line not found" })
      };
    }

    let resolvedSkipStart = skipStart;
    if (automaticRequested && body.skip_start == null && body.skipStart == null && body.cursor_start == null) {
      const progress = await loadCelebrityInventoryProgress(supabase, line.id);
      resolvedSkipStart = progress.next_eligible_skip ?? 0;
      const running = await findRunningCelebrityBatch(supabase, line.id);
      if (running.length) {
        return {
          statusCode: 409,
          body: JSON.stringify({
            success: false,
            blocked: true,
            reason: "celebrity_batch_already_running",
            running_run_ids: running.map((r) => r.id)
          })
        };
      }
    }

    const resolvedMaxPages = automaticRequested ? Math.min(autoLimits.max_pages, maxPages) : maxPages;
    const resolvedMaxWrites = automaticRequested ? Math.min(autoLimits.max_writes, maxWrites) : maxWrites;

    const [ships, destRows] = await Promise.all([
      supabase(
        `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id`
      ),
      loadClassificationDestinations(supabase)
    ]);

    const result = await runCelebrityDiscoveryBatch({
      mode,
      runId,
      skipStart: resolvedSkipStart,
      maxPages: resolvedMaxPages,
      maxWrites: resolvedMaxWrites,
      maxCandidates: Math.max(resolvedMaxWrites, 100),
      performWrites,
      buildManifest: buildManifest || automaticRequested || controlledBatch,
      controlledBatch,
      controlledSailingIds,
      recordRun: body.record_run === true || automaticRequested || controlledBatch,
      automatic: automaticRequested,
      writeConcurrency: automaticRequested ? autoLimits.write_concurrency : undefined,
      useCache: body.use_cache !== false,
      cruiseLine: line,
      ships: ships || [],
      destinations: catalogueDestinations(destRows || []),
      supabase
    });

    return {
      statusCode: result.blocked ? 409 : result.ok ? 200 : 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        success: result.ok && !result.blocked,
        blocked: result.blocked || false,
        reason: result.reason || null,
        mode,
        automatic: automaticRequested,
        run_id: runId,
        run_record_id: result.run_record_id || null,
        writes_performed: result.writes_performed || false,
        write_result: result.write_result || null,
        manifest: result.manifest ? { acceptance_gate: result.manifest.acceptance_gate, product_count: result.manifest.products?.length } : null,
        cursor: result.cursor || null,
        stats: result.stats || null,
        cruise_metrics: result.cruise_metrics || null,
        automatic_gate: result.automatic_gate || null
      })
    };
  } catch (error) {
    console.error("celebrity-discovery-batch-background", error.message || error);
    return {
      statusCode: error.statusCode || 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        success: false,
        error: error.message || "celebrity_batch_failed",
        writes_performed: false
      })
    };
  }
};
