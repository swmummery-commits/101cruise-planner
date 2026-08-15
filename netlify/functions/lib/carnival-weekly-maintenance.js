/**
 * Carnival Cruise Line — weekly maintenance runner.
 */

const adapter = require("./carnival-discovery-adapter");
const { resolveCarnivalDiscoveryMode, assertCarnivalWritesAllowed } = require("./carnival-discovery-mode");
const {
  isCarnivalWeeklyReconciliationEnabled,
  CARNIVAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  perthCalendarDate
} = require("./cruise-discovery-maintenance");
const { buildCclWeeklyManifest } = require("./carnival-weekly-manifest");
const { applyCclWeeklyManifest } = require("./carnival-weekly-apply");
const { evaluatePreApplyQualityGate } = require("./carnival-controlled-batch");
const { withGlobalCruiseWriteLock } = require("./cruise-discovery-global-write-lock");

const CCL_LINE_SLUG = "carnival-cruise-line";
const CCL_MAX_WEEKLY_WRITES = 250;

async function runCclWeeklyMaintenance(context = {}) {
  const sb = context.supabase;
  if (!sb) throw new Error("Carnival weekly maintenance requires an explicit supabase client");

  const dryRun = context.dryRun !== false && context.dry_run !== false;
  const performWrites = Boolean(context.performWrites ?? context.perform_writes) && !dryRun;
  const runId = String(context.runId || context.run_id || `ccl-weekly-${Date.now()}`).trim();
  const today = context.today || perthCalendarDate();
  const maxWrites = context.maxWrites ?? context.max_writes ?? CCL_MAX_WEEKLY_WRITES;
  const startedAt = Date.now();

  const modeGate = resolveCarnivalDiscoveryMode(performWrites ? "weekly_maintenance" : "production_read_only");
  if (performWrites) assertCarnivalWritesAllowed(modeGate);

  const line = (
    await sb(`ci_cruise_lines?slug=eq.${encodeURIComponent(CCL_LINE_SLUG)}&select=id,name,slug&limit=1`)
  )?.[0];
  if (!line) throw new Error("Carnival Cruise Line not found");

  const [ships, shipAliases, destRows] = await Promise.all([
    sb(`ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id,active&order=name.asc`),
    sb(`cruise_ship_aliases?cruise_line_id=eq.${line.id}&select=ship_id,raw_alias,normalised_alias`),
    sb("destinations?select=id,name,slug,status,classification_enabled")
  ]);

  adapter.clearCclFetchCache();
  require("./carnival-discovery-source").clearCarnivalFetchCache();

  const simulation = await adapter.simulateCclDiscovery({
    cruiseLine: line,
    ships: ships || [],
    shipAliases: shipAliases || [],
    destinations: adapter.catalogueDestinations(destRows || []),
    today
  });

  const qualityGate = evaluatePreApplyQualityGate(simulation);
  if (!qualityGate.ok) {
    return {
      success: false,
      blocked: true,
      reason: "quality_gate_failed",
      quality_gate: qualityGate,
      run_id: runId,
      dry_run: !performWrites
    };
  }

  const manifest = await buildCclWeeklyManifest({
    simulation,
    cruiseLine: line,
    supabase: sb,
    today,
    runId,
    previousRun: context.previousRun || context.previous_run || null,
    maxNewInserts: maxWrites
  });

  let applyResult = null;
  let globalLockReport = null;
  if (performWrites) {
    const applyWrap = await withGlobalCruiseWriteLock(sb, {
      ownerId: runId,
      runId,
      lineSlug: CCL_LINE_SLUG,
      operation: "carnival_weekly_maintenance"
    }, async () =>
      applyCclWeeklyManifest({
        manifest,
        supabase: sb,
        cruiseLine: line,
        performWrites: true,
        runId,
        maxWrites
      }));

    if (!applyWrap.acquired) {
      return {
        success: false,
        blocked: true,
        reason: applyWrap.reason || "global_production_import_lock_unavailable",
        run_id: runId,
        manifest,
        global_lock: applyWrap.observability
      };
    }
    applyResult = applyWrap.result;
    globalLockReport = applyWrap.observability;
  }

  const summary = {
    run_id: runId,
    run_type: CARNIVAL_WEEKLY_MAINTENANCE_RUN_TYPE,
    line_slug: CCL_LINE_SLUG,
    dry_run: !performWrites,
    global_lock: globalLockReport,
    perth_today: today,
    elapsed_ms: Date.now() - startedAt,
    quality_gate: qualityGate,
    source_counts: manifest.source_counts,
    production_official: manifest.production_official,
    recognised_eligible: manifest.recognised_eligible,
    outstanding_eligible: manifest.outstanding_eligible,
    proposed_inserts: (manifest.inserts || []).length,
    proposed_updates: (manifest.updates || []).length,
    proposed_cutoff_hides: (manifest.cutoff_hides || []).length,
    proposed_source_absence_hides: (manifest.source_absence_hides || []).length,
    legacy_ignored: manifest.legacy_ignored,
    writes_performed: applyResult?.stats || null,
    source_absent_sailing_ids: [
      ...(manifest.source_absence_policy?.source_absent_observed_records || []).map((r) => r.official_sailing_id),
      ...(manifest.source_absence_policy?.source_absent_actionable_records || []).map((r) => r.official_sailing_id)
    ],
    success: performWrites ? (applyResult?.stats?.failed || 0) === 0 : true
  };

  return {
    success: summary.success,
    dry_run: !performWrites,
    run_id: runId,
    manifest,
    summary,
    apply: applyResult
  };
}

module.exports = {
  CCL_LINE_SLUG,
  CCL_MAX_WEEKLY_WRITES,
  runCclWeeklyMaintenance
};
