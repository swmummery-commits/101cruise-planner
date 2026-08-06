/**
 * Local Celebrity batch run tracking helpers for production scripts.
 */

const crypto = require("crypto");
const path = require("path");

function sha256File(filePath) {
  const fs = require("fs");
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function withCelebrityRunRecord({
  supabase,
  cruiseLineId,
  runId,
  runType,
  automatic = false,
  mode = "production_write",
  writesEnabled = true,
  execute
}) {
  const {
    createCelebrityDiscoveryRun,
    finalizeCelebrityDiscoveryRun,
    buildCelebrityRunStats,
    CELEBRITY_RUN_TYPE,
    CELEBRITY_AUTO_RUN_TYPE,
    CELEBRITY_RECON_RUN_TYPE
  } = require(path.join(__dirname, "../../netlify/functions/lib/celebrity-discovery-run-tracking"));

  const resolvedType =
    runType ||
    (automatic ? CELEBRITY_AUTO_RUN_TYPE : CELEBRITY_RUN_TYPE);

  const dbRun = await createCelebrityDiscoveryRun(supabase, {
    cruiseLineId,
    runId,
    mode,
    skipStart,
    automatic: resolvedType === CELEBRITY_AUTO_RUN_TYPE,
    runType: resolvedType,
    writesEnabled
  });

  const started = Date.now();
  try {
    const result = await execute();
    const stats = buildCelebrityRunStats({
      runType: resolvedType,
      mode,
      runId,
      writesEnabled,
      proposedWrites: result.stats?.proposed_writes ?? result.proposed_writes ?? null,
      inserted: result.stats?.inserted ?? 0,
      updated: result.stats?.updated ?? 0,
      failed: result.stats?.failed ?? result.stats?.failed_writes ?? 0,
      duplicateSkips: result.stats?.duplicate_skips ?? 0,
      incompleteSkips: result.stats?.incomplete_skips ?? 0,
      cruiseMetrics: result.cruise_metrics || result.stats?.cruise_metrics || {},
      timing: { total_ms: Date.now() - started, ...(result.timing || result.stats?.timing || {}) },
      ...(result.run_stats || {})
    });
    if (result.stats?.duplicate_skips != null) stats.duplicate_skips = result.stats.duplicate_skips;
    if (result.stats?.incomplete_skips != null) stats.incomplete_skips = result.stats.incomplete_skips;
    if (result.source_session) stats.source_session = result.source_session;
    if (result.rollback_manifest) stats.rollback_manifest = result.rollback_manifest;

    await finalizeCelebrityDiscoveryRun(supabase, dbRun.id, {
      status: (result.stats?.failed || 0) > 0 ? "failed" : "completed",
      stats
    });
    return { db_run_id: dbRun.id, result, stats };
  } catch (err) {
    await finalizeCelebrityDiscoveryRun(supabase, dbRun.id, {
      status: "failed",
      stats: buildCelebrityRunStats({
        runType: resolvedType,
        mode,
        runId,
        writesEnabled,
        failed: 1
      }),
      errorMessage: err.message || String(err)
    });
    throw err;
  }
}

module.exports = {
  sha256File,
  withCelebrityRunRecord
};
