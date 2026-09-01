/**
 * Disney Cruise Line — weekly production maintenance orchestration.
 */

const crypto = require("crypto");
const {
  simulateDisneyDiscovery,
  officialProductKey,
  buildEligibilityWaterfall
} = require("./disney-discovery-adapter");
const { resolveDisneyDiscoveryMode } = require("./disney-discovery-mode");
const {
  DISNEY_WEEKLY_MAINTENANCE_RUN_TYPE,
  perthCalendarDate
} = require("./cruise-discovery-maintenance");
const {
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock,
  verifyMaintenanceLockOwnership,
  weeklyLockKey
} = require("./cruise-discovery-maintenance-locks");
const { runGlobalProtectedMaintenanceWrites } = require("./cruise-discovery-global-write-lock");
const { persistMaintenanceRollbackManifest } = require("./cruise-discovery-maintenance-manifests");
const {
  partitionByPublicBookingCutoff,
  PUBLIC_BOOKING_CUTOFF_DAYS,
  publicBookingMinimumDepartureDate
} = require("./public-discovered-cruise-inventory");
const { supabase: defaultSupabase } = require("./cruise-discovery-ops");
const { loadClassificationDestinations } = require("./destination-queries");
const {
  classifyDisneyProductionRows,
  verifyCumulativeProductionBaseline,
  DISNEY_LEGACY_ROW_IDS
} = require("./disney-controlled-batch");
const {
  DISNEY_MAX_WEEKLY_MATERIAL_WRITES,
  assessDisneyWeeklyWriteSafety,
  isDisneySourceAbsenceDeactivationEnabled,
  boundMaterialActions
} = require("./disney-weekly-update-policy");
const {
  classifyDisneySourceAbsence,
  extractPreviousObservationMap
} = require("./disney-source-absence");
const {
  evaluateDisneyWeeklySourceQualityGate,
  evaluateDisneyCollapseGuard,
  isDisneySourceSnapshotComplete
} = require("./disney-weekly-quality");
const {
  buildDisneyWeeklyManifest,
  applyDisneyWeeklyMaintenanceWrites
} = require("./disney-weekly-apply");

const DISNEY_LINE_SLUG = "disney-cruise-line";
const DISNEY_MAX_WEEKLY_WRITES = DISNEY_MAX_WEEKLY_MATERIAL_WRITES;

async function loadDisneyLineContext(supabase) {
  const line = (
    await supabase(
      `ci_cruise_lines?slug=eq.${encodeURIComponent(DISNEY_LINE_SLUG)}&select=id,name,slug,website_url,cruise_search_url&limit=1`
    )
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${DISNEY_LINE_SLUG}`);
  const destRows = await loadClassificationDestinations(supabase);
  const destinations = (destRows || []).filter((d) => d.status !== "archived");
  const ships = await supabase(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id,ship_class`
  );
  return { line, destinations, ships: ships || [], destRows: destRows || [] };
}

async function acquireMaintenanceLock(supabase, runId, runRecordId = null) {
  return acquireMaintenanceDbLock(supabase, {
    lockKey: weeklyLockKey(DISNEY_LINE_SLUG),
    ownerId: runId,
    runId,
    runRecordId
  });
}

async function releaseMaintenanceLock(supabase, runId) {
  return releaseMaintenanceDbLock(supabase, {
    lockKey: weeklyLockKey(DISNEY_LINE_SLUG),
    ownerId: runId
  });
}

async function findPreviousDisneyMaintenanceRun(supabase, cruiseLineId, runType) {
  const runs = await supabase(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&scope=eq.cruise_line&status=eq.completed&select=id,stats,finished_at,created_at&order=finished_at.desc&limit=50`
  );
  return (runs || []).find((r) => r.stats?.run_type === runType) || null;
}

async function loadActiveOfficialCount(supabase, cruiseLineId) {
  const rows = await supabase(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&select=id,status,official_sailing_id,raw_extract`
  );
  const { official } = classifyDisneyProductionRows(rows || []);
  return official.filter((r) => r.status === "active").length;
}

function snapshotChecksum(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function findDisneySourceAbsentActive({ supabase, cruiseLineId, eligibleKeys, today }) {
  const minDeparture = publicBookingMinimumDepartureDate(today);
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const batch = await supabase(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&status=eq.active&departure_date=gte.${minDeparture}&select=id,official_sailing_id,departure_date,raw_extract&limit=${pageSize}&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  const absent = [];
  for (const row of rows) {
    if (DISNEY_LEGACY_ROW_IDS.includes(row.id)) continue;
    const sid =
      row.official_sailing_id ||
      row.raw_extract?.disney_official_product_key ||
      null;
    if (sid && !eligibleKeys.has(sid) && !eligibleKeys.has(String(sid).toUpperCase())) {
      absent.push({
        discovered_cruise_id: row.id,
        official_sailing_id: sid,
        departure_date: row.departure_date,
        action: "source_absent_retained_active"
      });
    }
  }
  return absent;
}

async function runDisneyWeeklyMaintenance(context = {}) {
  const sb = context.supabase || defaultSupabase;
  const dryRun = context.dryRun ?? context.dry_run;
  const explicitDryRun = dryRun === undefined ? true : Boolean(dryRun);
  const performWrites =
    Boolean(context.performWrites ?? context.perform_writes) && !explicitDryRun;
  const maxWrites = Math.min(
    DISNEY_MAX_WEEKLY_WRITES,
    Number(context.maxWrites ?? context.max_writes ?? DISNEY_MAX_WEEKLY_WRITES) || DISNEY_MAX_WEEKLY_WRITES
  );
  const runId = String(context.runId || context.run_id || `disney-weekly-${Date.now()}`).trim();
  const runRecordId = context.runRecordId || context.run_record_id || null;
  const today = context.today || perthCalendarDate();
  const lineSlug = DISNEY_LINE_SLUG;
  const runType = DISNEY_WEEKLY_MAINTENANCE_RUN_TYPE;

  const lock = await acquireMaintenanceLock(sb, runId, runRecordId);
  if (!lock.acquired) {
    return {
      ok: false,
      blocked: true,
      reason: lock.reason || "maintenance_lock_held",
      worker_state: lock.worker_state || "already_running",
      line_slug: lineSlug
    };
  }

  try {
    const { line, destinations, ships } = await loadDisneyLineContext(sb);
    const writeMode =
      context.writeMode ||
      context.write_mode ||
      (performWrites ? "weekly_maintenance" : "production_read_only");
    const modeGate = resolveDisneyDiscoveryMode(writeMode);
    if (performWrites && !modeGate.writes_allowed) {
      return { ok: false, blocked: true, reason: modeGate.reason, line_slug: lineSlug };
    }

    const simulation = await simulateDisneyDiscovery({
      cruiseLine: line,
      ships,
      destinations,
      today,
      useCache: false,
      supabaseQuery: sb,
      runEnrichment: false
    });

    const sourceQualityGate = evaluateDisneyWeeklySourceQualityGate(simulation);
    if (!sourceQualityGate.passed) {
      return {
        ok: false,
        blocked: true,
        failed: true,
        reason: sourceQualityGate.failures.join("; "),
        line_slug: lineSlug,
        source_quality_gate: sourceQualityGate,
        summary: {
          line_slug: lineSlug,
          run_id: runId,
          run_type: runType,
          trigger_type: context.triggerType || context.trigger_type || "scheduled",
          dry_run: explicitDryRun,
          write_authorisation: "dry_run",
          official_source_total: sourceQualityGate.source_total,
          source_quality_gate: sourceQualityGate,
          resolution_rates: {
            destination_resolution_pct: sourceQualityGate.destination_resolution_pct
          },
          unresolved_destinations: sourceQualityGate.unresolved_destinations,
          inventory_changed: false,
          writes_performed: 0
        }
      };
    }

    const normalised = simulation.products || [];
    const rawIdentities = normalised.map((p) => p.official_sailing_id).filter(Boolean);
    const previousRun = await findPreviousDisneyMaintenanceRun(sb, line.id, runType);
    const previousBaseline =
      previousRun?.stats?.accepted_source_baseline_total ??
      previousRun?.stats?.source_total ??
      null;
    const collapseGuard = evaluateDisneyCollapseGuard({
      currentRawIdentities: rawIdentities,
      previousAcceptedBaseline: previousBaseline
    });

    if (!collapseGuard.collapse_gate_passed) {
      return {
        ok: false,
        blocked: true,
        failed: true,
        reason: "catastrophic_source_collapse",
        line_slug: lineSlug,
        source_quality_gate: sourceQualityGate,
        collapse_guard: collapseGuard,
        simulation
      };
    }

    const { publiclyEligible: disneyPublic, withinCutoff: withinPublicCutoff } = partitionByPublicBookingCutoff(
      normalised,
      (p) => p.candidate?.departure_date || p.raw?.departure_date,
      today
    );
    const productionEligible = disneyPublic.filter((p) => p.eligibility?.production_eligible);
    const eligibleKeys = new Set(productionEligible.map((p) => officialProductKey(p.raw)).filter(Boolean));
    const waterfall = buildEligibilityWaterfall(normalised, today);

    const manifest = await buildDisneyWeeklyManifest({
      products: productionEligible,
      cruiseLine: line,
      supabase: sb,
      runId
    });

    const proposedInserts = manifest.inserts || [];
    const proposedSafeUpdates = manifest.safe_updates || [];
    const proposedReview = manifest.review || [];
    const unchanged = manifest.unchanged || [];

    const sourceAbsent = await findDisneySourceAbsentActive({
      supabase: sb,
      cruiseLineId: line.id,
      eligibleKeys,
      today
    });

    const sourceComplete = isDisneySourceSnapshotComplete(simulation, sourceQualityGate);
    const deactivationEnabled = isDisneySourceAbsenceDeactivationEnabled();
    const previousAbsenceRun = await findPreviousDisneyMaintenanceRun(sb, line.id, runType);
    const sourceAbsencePolicy = classifyDisneySourceAbsence({
      currentAbsentRows: sourceAbsent,
      previousObservationBySailingId: extractPreviousObservationMap(previousAbsenceRun),
      enumerationHealthy: sourceQualityGate.passed === true,
      sourceComplete,
      deactivationEnabled
    });

    manifest.source_absence_hides = (sourceAbsencePolicy.source_absent_confirmed_records || [])
      .filter((r) => r.deactivation_allowed === true)
      .map((r) => ({
        discovered_cruise_id: r.discovered_cruise_id,
        official_sailing_id: r.official_sailing_id,
        reason: "source_absent_confirmed"
      }));

    const materialActions = boundMaterialActions(
      [
        ...proposedInserts.map((e) => ({ ...e, action: "insert" })),
        ...proposedSafeUpdates.map((e) => ({ ...e, action: "safe_update" })),
        ...(manifest.source_absence_hides || []).map((e) => ({ ...e, action: "source_absence" }))
      ],
      maxWrites
    );

    const existingRows = await sb(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,status,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract,created_at,updated_at`
    );
    const baseline = verifyCumulativeProductionBaseline(existingRows || [], simulation);

    const weeklyWriteSafety = assessDisneyWeeklyWriteSafety({
      sourceAbsencePolicy,
      performWrites,
      proposedIdentityReviewUpdates: proposedReview.length,
      sourceQualityGatePassed: sourceQualityGate.passed,
      collapseGatePassed: collapseGuard.collapse_gate_passed
    });

    const activeProductionTotal = await loadActiveOfficialCount(sb, line.id);
    const snapshotId = snapshotChecksum(Array.from(eligibleKeys).sort());

    const summary = {
      line_slug: lineSlug,
      run_id: runId,
      run_type: runType,
      trigger_type: context.triggerType || context.trigger_type || "scheduled",
      dry_run: explicitDryRun,
      write_authorisation: performWrites ? "apply_requested" : "dry_run",
      source_total: sourceQualityGate.source_total,
      source_complete: sourceQualityGate.source_complete,
      accepted_source_baseline_total: collapseGuard.previous_accepted_source_total,
      accepted_baseline_total: collapseGuard.previous_accepted_source_total,
      collapse_pct: collapseGuard.missing_pct,
      collapse_guard: collapseGuard,
      production_eligible_total: productionEligible.length,
      official_source_total: normalised.length,
      eligible_total: productionEligible.length,
      active_production_total: activeProductionTotal,
      proposed_inserts: proposedInserts.length,
      proposed_updates: proposedSafeUpdates.length,
      proposed_updates_identity_review: proposedReview.length,
      unchanged: unchanged.length,
      source_absent_active: sourceAbsent.length,
      source_absent_sailing_ids: sourceAbsent.map((r) => r.official_sailing_id),
      source_absent_observed: sourceAbsencePolicy.source_absent_observed,
      source_absent_confirmed: sourceAbsencePolicy.source_absent_confirmed,
      source_absence_cleared: sourceAbsencePolicy.source_absence_cleared_count,
      source_absence_policy: sourceAbsencePolicy,
      source_absence_observations: sourceAbsencePolicy.source_absence_observations,
      within_public_cutoff_excluded: withinPublicCutoff.length,
      public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
      eligibility_waterfall: waterfall.waterfall,
      source_quality_gate: sourceQualityGate,
      production_baseline: baseline,
      legacy_rows_excluded: DISNEY_LEGACY_ROW_IDS.length,
      legacy_rows_touched: 0,
      material_actions_total: materialActions.material_actions_total,
      material_actions_applied: 0,
      material_actions_deferred: materialActions.material_actions_deferred,
      snapshot_id: snapshotId,
      inventory_changed: false,
      writes_performed: 0,
      source_absence_deactivation_enabled: deactivationEnabled,
      weekly_write_safety: weeklyWriteSafety,
      hard_deletes: 0
    };

    if (!weeklyWriteSafety.ok && performWrites) {
      return {
        ok: false,
        blocked: false,
        failed: true,
        reason: weeklyWriteSafety.failures.join("; "),
        summary,
        manifest,
        simulation
      };
    }

    if (explicitDryRun || !performWrites) {
      summary.material_actions_applied = 0;
      return { ok: true, dry_run: true, summary, manifest, simulation };
    }

    const combinedMaterial = materialActions.material_actions_total;
    if (combinedMaterial === 0) {
      const touchManifest = {
        ...manifest,
        inserts: [],
        safe_updates: [],
        source_absence_hides: [],
        reactivations: []
      };
      const touchResult = await applyDisneyWeeklyMaintenanceWrites({
        manifest: touchManifest,
        supabase: sb,
        cruiseLine: line,
        performWrites: true,
        runId,
        maxMaterialWrites: 0,
        perthToday: today,
        sourceComplete,
        deactivationEnabled
      });
      summary.touches = touchResult.stats?.touches || 0;
      summary.duplicate_skips = unchanged.length;
      summary.zero_change_apply = true;
      summary.writes_performed = 0;
      return { ok: true, dry_run: false, zero_change_apply: true, summary, manifest, simulation, write_result: touchResult };
    }

    const lockOwnership = await verifyMaintenanceLockOwnership(sb, {
      lockKey: weeklyLockKey(lineSlug),
      ownerId: runId
    });
    if (!lockOwnership.ok) {
      return {
        ok: false,
        blocked: true,
        reason: lockOwnership.reason || "maintenance_lock_lost_before_write",
        worker_state: "already_running",
        line_slug: lineSlug,
        summary
      };
    }

    const applyManifest = {
      ...manifest,
      inserts: proposedInserts.slice(0, maxWrites),
      safe_updates: [],
      source_absence_hides: [],
      reactivations: []
    };
    let remaining = maxWrites - applyManifest.inserts.length;
    applyManifest.safe_updates = proposedSafeUpdates.slice(0, Math.max(0, remaining));
    remaining -= applyManifest.safe_updates.length;
    if (deactivationEnabled && sourceComplete) {
      applyManifest.source_absence_hides = (manifest.source_absence_hides || []).slice(0, Math.max(0, remaining));
    }

    const protectedWrites = await runGlobalProtectedMaintenanceWrites(sb, {
      runId,
      runRecordId,
      lineSlug,
      operation: "disney_weekly_maintenance",
      underLockRecheck: async () => {
        const activeNow = await loadActiveOfficialCount(sb, line.id);
        if (activeNow !== summary.active_production_total) {
          return { ok: false, reason: "under_lock_active_count_changed" };
        }
        return { ok: true };
      },
      writeFn: async () =>
        applyDisneyWeeklyMaintenanceWrites({
          manifest: applyManifest,
          supabase: sb,
          cruiseLine: line,
          performWrites: true,
          runId,
          maxMaterialWrites: maxWrites,
          perthToday: today,
          sourceComplete,
          deactivationEnabled
        })
    });

    if (protectedWrites.blocked) {
      summary.global_lock = protectedWrites.global_lock;
      return { ok: false, blocked: true, reason: protectedWrites.reason, summary, manifest };
    }

    const writeResult = protectedWrites.writeResult;
    summary.global_lock = protectedWrites.global_lock;

    const rollback = await persistMaintenanceRollbackManifest(sb, {
      runId,
      runRecordId,
      cruiseLineId: line.id,
      lineSlug,
      triggerType: context.triggerType || context.trigger_type,
      writeResult
    });

    summary.inserts = writeResult.stats?.inserted || 0;
    summary.updates = writeResult.stats?.updated || 0;
    summary.source_absence_actions = writeResult.stats?.source_absence_hidden || 0;
    summary.reactivations = writeResult.stats?.reactivated || 0;
    summary.touches = writeResult.stats?.touches || 0;
    summary.failed_writes = writeResult.stats?.failed || 0;
    summary.material_actions_applied = writeResult.stats?.material_actions_applied || 0;
    summary.material_actions_deferred = writeResult.stats?.material_actions_deferred || 0;
    summary.legacy_rows_touched = 0;
    summary.accepted_source_baseline_total = collapseGuard.accepted_baseline_updated;
    summary.inventory_changed =
      (summary.inserts || 0) +
        (summary.updates || 0) +
        (summary.source_absence_actions || 0) +
        (summary.reactivations || 0) >
      0;
    summary.writes_performed = summary.inventory_changed
      ? summary.inserts + summary.updates + summary.source_absence_actions + summary.reactivations
      : 0;
    summary.rollback_manifest_id = rollback?.manifest_record_id || null;
    summary.line_lock = { acquired: true, released: false };
    summary.hard_deletes = 0;

    return {
      ok: writeResult.stats?.failed === 0,
      summary,
      write_result: writeResult,
      manifest,
      rollback_result: rollback || null,
      rollback_manifest: rollback?.manifest || null,
      simulation
    };
  } finally {
    await releaseMaintenanceLock(sb, runId);
  }
}

module.exports = {
  DISNEY_LINE_SLUG,
  DISNEY_MAX_WEEKLY_WRITES,
  runDisneyWeeklyMaintenance,
  findDisneySourceAbsentActive,
  loadDisneyLineContext
};
