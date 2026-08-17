/**
 * Azamara — weekly maintenance runner.
 */

const { simulateAzamaraDiscovery } = require("./azamara-discovery-adapter");
const { resolveAzamaraDiscoveryMode, assertAzamaraWritesAllowed } = require("./azamara-discovery-mode");
const { AZAMARA_WEEKLY_MAINTENANCE_RUN_TYPE, perthCalendarDate } = require("./cruise-discovery-maintenance");
const { buildAzamaraWeeklyManifest, validateAzamaraWeeklyManifest, AZAMARA_MAX_WEEKLY_WRITES } = require("./azamara-weekly-manifest");
const { applyAzamaraWeeklyManifest } = require("./azamara-weekly-apply");
const { assessAzamaraWeeklyWriteSafety } = require("./azamara-weekly-update-policy");
const { indexExistingAzamaraRecords: loadIndexes } = require("./azamara-discovery-writes");
const { loadClassificationDestinations } = require("./destination-queries");
const { loadShipAliases, loadDestinationAliases } = require("./cruise-discovery-ops");
const { withGlobalCruiseWriteLock, executeControlledProductionApply } = require("./cruise-discovery-global-write-lock");
const { AZAMARA_LINE_ID } = require("./azamara-discovery-source");

const AZAMARA_LINE_SLUG = "azamara";

async function runAzamaraWeeklyMaintenance(context = {}) {
  const sb = context.supabase;
  if (!sb) throw new Error("Azamara weekly maintenance requires an explicit supabase client");

  const dryRun = context.dryRun !== false && context.dry_run !== false;
  const performWrites = Boolean(context.performWrites ?? context.perform_writes) && !dryRun;
  const runId = String(context.runId || context.run_id || `azamara-weekly-${Date.now()}`).trim();
  const today = context.today || perthCalendarDate();
  const maxWrites = context.maxWrites ?? context.max_writes ?? AZAMARA_MAX_WEEKLY_WRITES;
  const startedAt = Date.now();
  const fetchImpl = context.fetchImpl || null;
  const maxUrls = context.maxUrls ?? context.max_urls ?? null;

  const modeGate = resolveAzamaraDiscoveryMode(performWrites ? "weekly_maintenance" : "production_read_only");
  if (performWrites) assertAzamaraWritesAllowed(modeGate);

  const line =
    context.cruiseLine ||
    (await sb(`ci_cruise_lines?slug=eq.${encodeURIComponent(AZAMARA_LINE_SLUG)}&select=id,name,slug&limit=1`))?.[0] ||
    (await sb(`ci_cruise_lines?id=eq.${AZAMARA_LINE_ID}&select=id,name,slug&limit=1`))?.[0];
  if (!line) throw new Error("Azamara Cruise Line not found");

  const [ships, shipAliases, destinations, destinationAliases, indexes] = await Promise.all([
    sb(
      `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id&order=name.asc`
    ),
    loadShipAliases(line.id),
    loadClassificationDestinations((p) => sb(p)),
    loadDestinationAliases(),
    loadIndexes(sb, line.id)
  ]);

  const simulation = await simulateAzamaraDiscovery({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    shipAliases,
    destinationAliases,
    existingOfficialBySailingId: indexes.officialBySailingId,
    today,
    fetchImpl,
    maxUrls,
    runId
  });

  if ((simulation.quality_gate_metrics?.duplicate_official_sailing_ids || 0) > 0) {
    return {
      success: false,
      blocked: true,
      reason: "duplicate_official_sailing_ids_in_source",
      run_id: runId,
      dry_run: !performWrites,
      simulation
    };
  }

  const manifest = await buildAzamaraWeeklyManifest({
    simulation,
    cruiseLine: line,
    supabase: sb,
    today,
    runId,
    previousRun: context.previousRun || context.previous_run || null,
    maxNewInserts: maxWrites
  });

  const manifestValidation = validateAzamaraWeeklyManifest(manifest);
  if (!manifestValidation.passed) {
    return {
      success: false,
      blocked: true,
      reason: "manifest_validation_failed",
      failures: manifestValidation.failures,
      run_id: runId,
      dry_run: !performWrites,
      manifest
    };
  }

  if (performWrites) {
    const writeSafety = assessAzamaraWeeklyWriteSafety({
      sourceAbsencePolicy: manifest.source_absence_policy,
      performWrites: true,
      proposedIdentityReviewUpdates: (manifest.identity_review || []).length
    });
    if (!writeSafety.ok) {
      return {
        success: false,
        blocked: true,
        reason: "weekly_write_safety_failed",
        failures: writeSafety.failures,
        run_id: runId,
        dry_run: false,
        manifest,
        write_safety: writeSafety
      };
    }
  }

  let applyResult = null;
  let globalLockReport = null;
  if (performWrites) {
    const applyWrap = await executeControlledProductionApply(
      sb,
      {
        runId,
        lineSlug: AZAMARA_LINE_SLUG,
        operation: "azamara_weekly_maintenance",
        performWrites: true
      },
      async () =>
        applyAzamaraWeeklyManifest({
          manifest,
          supabase: sb,
          cruiseLine: line,
          performWrites: true,
          runId,
          maxWrites
        })
    );

    if (applyWrap.blocked) {
      return {
        success: false,
        blocked: true,
        reason: applyWrap.reason || "global_production_import_lock_unavailable",
        run_id: runId,
        manifest,
        global_lock: applyWrap.global_lock
      };
    }
    applyResult = applyWrap.writeResult;
    globalLockReport = applyWrap.global_lock;
  }

  const summary = {
    run_id: runId,
    run_type: AZAMARA_WEEKLY_MAINTENANCE_RUN_TYPE,
    line_slug: AZAMARA_LINE_SLUG,
    dry_run: !performWrites,
    global_lock: globalLockReport,
    perth_today: today,
    elapsed_ms: Date.now() - startedAt,
    source_counts: manifest.source_counts,
    production_official: manifest.production_official,
    recognised_eligible: manifest.recognised_eligible,
    outstanding_eligible: manifest.outstanding_eligible,
    proposed_inserts: (manifest.inserts || []).length,
    proposed_updates: (manifest.updates || []).length,
    proposed_identity_review: (manifest.identity_review || []).length,
    proposed_cutoff_hides: (manifest.cutoff_hides || []).length,
    proposed_source_absence_hides: (manifest.source_absence_hides || []).length,
    legacy_ignored: manifest.legacy_ignored,
    would_insert: (manifest.inserts || []).length,
    would_update: (manifest.updates || []).length,
    writes_performed: applyResult?.stats || null,
    hard_deletes: 0,
    source_absent_sailing_ids: (manifest.source_absence_policy?.source_absent_observed_records || [])
      .map((r) => r.official_sailing_id)
      .concat((manifest.source_absence_policy?.source_absent_actionable_records || []).map((r) => r.official_sailing_id)),
    success: performWrites ? (applyResult?.stats?.failed || 0) === 0 : true
  };

  return {
    success: summary.success,
    dry_run: !performWrites,
    run_id: runId,
    manifest,
    summary,
    simulation,
    apply: applyResult
  };
}

module.exports = {
  AZAMARA_LINE_SLUG,
  AZAMARA_MAX_WEEKLY_WRITES,
  runAzamaraWeeklyMaintenance
};
