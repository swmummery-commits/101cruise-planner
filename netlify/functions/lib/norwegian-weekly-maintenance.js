/**
 * Norwegian Cruise Line — weekly maintenance runner.
 */

const { simulateNorwegianDiscovery } = require("./norwegian-discovery-adapter");
const { resolveNorwegianDiscoveryMode, assertNorwegianWritesAllowed } = require("./norwegian-discovery-mode");
const {
  isNorwegianWeeklyReconciliationEnabled,
  NORWEGIAN_WEEKLY_MAINTENANCE_RUN_TYPE,
  perthCalendarDate
} = require("./cruise-discovery-maintenance");
const {
  buildNorwegianWeeklyManifest,
  loadNorwegianProductionForWeekly
} = require("./norwegian-weekly-manifest");
const { applyNorwegianWeeklyManifest } = require("./norwegian-weekly-apply");
const { loadClassificationDestinations } = require("./destination-queries");
const { withGlobalCruiseWriteLock } = require("./cruise-discovery-global-write-lock");

const NCL_LINE_SLUG = "norwegian-cruise-line";
const NCL_MAX_WEEKLY_WRITES = 200;

async function runNorwegianWeeklyMaintenance(context = {}) {
  const sb = context.supabase;
  if (!sb) throw new Error("Norwegian weekly maintenance requires an explicit supabase client");

  const dryRun = context.dryRun !== false && context.dry_run !== false;
  const performWrites = Boolean(context.performWrites ?? context.perform_writes) && !dryRun;
  const runId = String(context.runId || context.run_id || `norwegian-weekly-${Date.now()}`).trim();
  const today = context.today || perthCalendarDate();
  const maxWrites = context.maxWrites ?? context.max_writes ?? NCL_MAX_WEEKLY_WRITES;
  const startedAt = Date.now();
  const insertOnly = Boolean(context.insertOnly ?? context.insert_only);

  const modeGate = resolveNorwegianDiscoveryMode(
    performWrites ? "weekly_maintenance" : "production_read_only"
  );
  if (performWrites) assertNorwegianWritesAllowed(modeGate);

  const lineSlug = NCL_LINE_SLUG;
  const lines = await sb(`ci_cruise_lines?slug=eq.${encodeURIComponent(lineSlug)}&select=id,name,slug&limit=1`);
  const line = lines?.[0];
  if (!line) throw new Error("Norwegian Cruise Line not found");

  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,official_line_ship_id,ship_class,active`
  );
  const destinations = await loadClassificationDestinations(sb);

  const simulation = await simulateNorwegianDiscovery({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today
  });

  const productionIndex = await loadNorwegianProductionForWeekly(sb, line.id);
  const previousRun = context.previousRun || context.previous_run || null;

  const manifest = await buildNorwegianWeeklyManifest({
    simulation,
    productionRows: productionIndex.rows || [],
    cruiseLine: line,
    destinations,
    supabase: sb,
    today,
    runId,
    previousRun,
    maxNewInserts: maxWrites
  });

  let applyResult = null;
  let globalLockReport = null;
  if (performWrites) {
    const applyWrap = await withGlobalCruiseWriteLock(sb, {
      ownerId: runId,
      runId,
      lineSlug,
      operation: "norwegian_weekly_maintenance"
    }, async () =>
      applyNorwegianWeeklyManifest({
        manifest,
        supabase: sb,
        cruiseLine: line,
        performWrites: true,
        runId,
        maxWrites,
        skipPromotions: insertOnly,
        skipCutoffHides: insertOnly,
        skipSourceAbsenceHides: insertOnly
      }));

    if (!applyWrap.acquired) {
      return {
        ok: false,
        success: false,
        blocked: true,
        review_required: false,
        reason: applyWrap.reason || "global_production_import_lock_unavailable",
        run_id: runId,
        manifest,
        summary: {
          run_id: runId,
          line_slug: lineSlug,
          blocked_by_global_lock: true,
          global_lock: applyWrap.observability
        },
        global_lock: applyWrap.observability
      };
    }
    applyResult = applyWrap.result;
    globalLockReport = applyWrap.observability;
  }

  const summary = {
    run_id: runId,
    run_type: NORWEGIAN_WEEKLY_MAINTENANCE_RUN_TYPE,
    line_slug: lineSlug,
    dry_run: !performWrites,
    global_lock: globalLockReport,
    perth_today: today,
    elapsed_ms: Date.now() - startedAt,
    source_counts: manifest.source_counts,
    production_genuine: manifest.production_genuine,
    recognised_eligible: manifest.recognised_eligible,
    outstanding_eligible: manifest.outstanding_eligible,
    proposed_inserts: (manifest.inserts || []).length,
    proposed_promotions: (manifest.promotions || []).length,
    proposed_cutoff_hides: (manifest.cutoff_hides || []).length,
    proposed_source_absence_hides: (manifest.source_absence_hides || []).length,
    legacy_ignored: manifest.legacy_ignored,
    writes_performed: applyResult?.stats || null,
    hard_deletes: 0,
    source_absent_sailing_ids: (manifest.source_absence_policy?.source_absent_observed_records || [])
      .map((r) => r.official_sailing_id)
      .concat((manifest.source_absence_policy?.source_absent_actionable_records || []).map((r) => r.official_sailing_id)),
    success: performWrites ? (applyResult?.stats?.failed || 0) === 0 : true
  };

  return {
    ok: summary.success,
    success: summary.success,
    blocked: false,
    review_required: false,
    reason: summary.success ? null : "norwegian_weekly_writes_failed",
    dry_run: !performWrites,
    run_id: runId,
    manifest,
    summary,
    apply: applyResult
  };
}

module.exports = {
  NCL_LINE_SLUG,
  NCL_MAX_WEEKLY_WRITES,
  runNorwegianWeeklyMaintenance
};
