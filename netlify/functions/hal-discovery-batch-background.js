/**
 * Background worker: resumable Holland America Discovery batches.
 *
 * Invoked with header x-discovery-cron-secret = DISCOVERY_CRON_SECRET.
 * Read-only by default; production_write remains blocked unless HAL_DISCOVERY_WRITE_ENABLED=true.
 */

const { runHalDiscoveryBatch } = require("./lib/holland-america-discovery-batch");
const { catalogueDestinations } = require("./lib/holland-america-discovery-adapter");
const { supabase } = require("./lib/cruise-discovery-runner");
const { loadClassificationDestinations } = require("./lib/destination-queries");
const {
  halAutomaticLimits,
  isHalAutomaticContinuationEnabled
} = require("./lib/holland-america-discovery-automation");
const { loadHalInventoryProgress, findRunningHalBatch } = require("./lib/holland-america-discovery-run-tracking");

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
    const cursorStart = Number(body.cursor_start ?? body.cursorStart ?? 0) || 0;
    const maxPages = Math.min(20, Math.max(1, Number(body.max_pages ?? body.maxPages ?? 12) || 12));
    const maxWrites = Math.min(500, Math.max(0, Number(body.max_writes ?? body.maxWrites ?? 100) || 100));
    const runId = String(body.run_id || body.runId || `hal-batch-${Date.now()}`).trim();
    const performWrites = mode === "production_write" && body.perform_writes !== false;
    const buildManifest = body.build_manifest === true;

    const automaticRequested =
      body.automatic === true ||
      (body.automatic !== false && isHalAutomaticContinuationEnabled() && mode === "production_write");
    const autoLimits = halAutomaticLimits();

    const lines = await supabase(
      "ci_cruise_lines?slug=eq.holland-america-line&select=id,name,slug,website_url,cruise_search_url&limit=1"
    );
    const line = lines?.[0];
    if (!line) {
      return {
        statusCode: 404,
        body: JSON.stringify({ success: false, error: "Holland America Line not found" })
      };
    }

    let resolvedCursorStart = cursorStart;
    if (automaticRequested && !body.cursor_start && body.cursorStart == null) {
      const progress = await loadHalInventoryProgress(supabase, line.id);
      resolvedCursorStart = progress.next_eligible_cursor ?? 0;
      const running = await findRunningHalBatch(supabase, line.id);
      if (running.length) {
        return {
          statusCode: 409,
          body: JSON.stringify({
            success: false,
            blocked: true,
            reason: "hal_batch_already_running",
            running_run_ids: running.map((r) => r.id)
          })
        };
      }
    }

    const resolvedMaxPages = automaticRequested
      ? Math.min(autoLimits.max_pages, maxPages)
      : maxPages;
    const resolvedMaxWrites = automaticRequested
      ? Math.min(autoLimits.max_writes, maxWrites)
      : maxWrites;

    const [ships, destRows] = await Promise.all([
      supabase(
        `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id`
      ),
      loadClassificationDestinations(supabase)
    ]);

    const result = await runHalDiscoveryBatch({
      mode,
      runId,
      cursorStart: resolvedCursorStart,
      maxPages: resolvedMaxPages,
      maxWrites: resolvedMaxWrites,
      maxCandidates: resolvedMaxWrites,
      performWrites,
      buildManifest: buildManifest || automaticRequested,
      recordRun: body.record_run === true || automaticRequested,
      automatic: automaticRequested,
      writeConcurrency: automaticRequested ? autoLimits.write_concurrency : undefined,
      useCache: body.use_cache !== false,
      cruiseLine: line,
      ships: ships || [],
      destinations: catalogueDestinations(destRows || []),
      supabase
    });

    return {
      statusCode: result.blocked ? 409 : 200,
      body: JSON.stringify({
        success: result.ok && !result.blocked,
        run_id: runId,
        mode: result.mode,
        writes_performed: result.writes_performed,
        write_result: result.write_result || null,
        manifest_summary: result.manifest
          ? {
              acceptance_gate: result.manifest.acceptance_gate,
              product_count: result.manifest.products?.length || 0
            }
          : null,
        cursor: result.cursor,
        automatic: automaticRequested,
        stats: result.stats,
        cruise_metrics: result.cruise_metrics,
        destination_counts: result.destination_counts,
        run_record_id: result.run_record_id || null,
        timing: result.timing || null,
        blocked: result.blocked || false,
        reason: result.reason || null
      })
    };
  } catch (error) {
    console.error("hal-discovery-batch-background", error);
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify({
        success: false,
        error: error.message || "HAL batch failed"
      })
    };
  }
};
