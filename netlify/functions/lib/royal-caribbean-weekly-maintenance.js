/**
 * Royal Caribbean International — read-only weekly maintenance dry-run.
 * Uses authoritative multi-page-size union enumeration. Production writes refused until activation.
 */

const {
  simulateRoyalCaribbeanInventory,
  officialProductKey: royalCaribbeanOfficialProductKey,
  LINE_SLUG: ROYAL_CARIBBEAN_LINE_SLUG
} = require("./royal-caribbean-discovery-adapter");
const { buildRoyalCaribbeanBatchManifest, indexExistingRoyalCaribbeanRecords } = require("./royal-caribbean-discovery-writes");
const { resolveRoyalCaribbeanDiscoveryMode, assertRoyalCaribbeanWritesAllowed } = require("./royal-caribbean-discovery-mode");
const { isRoyalCaribbeanWeeklyReconciliationEnabled } = require("./cruise-discovery-maintenance");
const {
  buildRoyalCaribbeanWeeklyManifestFromDryRun,
  validateFrozenWeeklyManifest
} = require("./royal-caribbean-weekly-manifest");
const { applyRoyalCaribbeanWeeklyManifest } = require("./royal-caribbean-weekly-apply");
const {
  buildRoyalCaribbeanReconciliationArithmetic,
  evaluateRoyalCaribbeanDryRunHealth
} = require("./royal-caribbean-reconciliation-summary");
const {
  ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE,
  perthCalendarDate
} = require("./cruise-discovery-maintenance");
const {
  PUBLIC_BOOKING_CUTOFF_DAYS,
  publicBookingCutoffDate,
  daysUntilDeparture,
  shouldRemoveFromPublicInventory
} = require("./public-discovered-cruise-inventory");
const {
  enumerateShipCoveragePartition,
  computeSourceSnapshotIdFromSailingIds,
  evaluateWeeklyAuthoritativeEnumerationHealth,
  auditProductionIdsViaDetailLookup,
  sourceAbsenceActionAllowed
} = require("./royal-caribbean-source-enumeration");
const {
  classifyRoyalCaribbeanSourceAbsence,
  extractPreviousAbsentSailingIds
} = require("./royal-caribbean-source-absence");
const { classifyRoyalCaribbeanWeeklyUpdates } = require("./royal-caribbean-weekly-updates");
const { evaluateRoyalCaribbeanWeeklyHealth } = require("./royal-caribbean-weekly-health");
const { indexGenuineRoyalCaribbeanProduction } = require("./royal-caribbean-post-write-verification");

const AUTHORITATIVE_UNION_PAGE_SIZES = [25, 50, 100];

async function runRoyalCaribbeanWeeklyMaintenance(context = {}) {
  const sb = context.supabase;
  if (!sb) throw new Error("Royal Caribbean maintenance requires an explicit supabase client");

  const dryRun = context.dryRun !== false && context.dry_run !== false;
  const performWrites = Boolean(context.performWrites ?? context.perform_writes) && !dryRun;
  const runId = String(context.runId || context.run_id || `royal-caribbean-weekly-${Date.now()}`).trim();
  const today = context.today || perthCalendarDate();
  const lineSlug = ROYAL_CARIBBEAN_LINE_SLUG;
  const runType = ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE;
  const startedAt = Date.now();

  const firstActivationCycle = Boolean(context.firstActivationCycle ?? context.first_activation_cycle);
  const frozenManifestInput = context.frozenManifest || context.frozen_manifest || null;

  const modeGate = resolveRoyalCaribbeanDiscoveryMode(
    performWrites ? "weekly_maintenance" : "production_read_only"
  );
  const { loadLineContext, findSourceAbsentActive, findPreviousSuccessfulMaintenanceRun } = context._deps || {};

  const { line, destinations } = await loadLineContext(sb, lineSlug);
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,official_line_ship_id,ship_class,active`
  );

  const simulation = await simulateRoyalCaribbeanInventory({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today,
    authoritativeEnumeration: context.authoritativeEnumeration !== false,
    unionPageSizes: context.unionPageSizes || AUTHORITATIVE_UNION_PAGE_SIZES,
    requestDelayMs: context.requestDelayMs ?? 100
  });

  const productionIndex = await indexGenuineRoyalCaribbeanProduction(sb);
  const existingRecords = await indexExistingRoyalCaribbeanRecords(sb, line.id);
  const existingBySailingId = new Map(
    (existingRecords.rows || [])
      .filter((row) => row.official_sailing_id)
      .map((row) => [row.official_sailing_id, row])
  );

  const manifest = await buildRoyalCaribbeanBatchManifest({
    products: simulation.products || [],
    cruiseLine: line,
    destinations,
    supabase: sb,
    runId
  });

  const ocean = (simulation.products || []).filter((p) => p.product_type === "ocean_cruise");
  const eligibleOcean = ocean.filter((p) => p.ocean_bucket === "eligible");
  const eligibleKeys = new Set(eligibleOcean.map((p) => royalCaribbeanOfficialProductKey(p.raw)).filter(Boolean));
  const proposedInserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
  const proposedUpdates = manifest.products.filter((p) => p.proposed_action === "update_exact_legacy_match");

  const manifestByKey = new Map(
    manifest.products.filter((m) => m.stable_identity_key).map((m) => [m.stable_identity_key, m])
  );
  const recognisedExistingEligible = eligibleOcean.filter((p) => {
    const entry = manifestByKey.get(p.official_sailing_id);
    return entry && ["duplicate_skip", "update_exact_legacy_match"].includes(entry.proposed_action);
  }).length;
  const outstandingEligibleInserts = eligibleOcean.filter((p) => {
    const entry = manifestByKey.get(p.official_sailing_id);
    return entry?.proposed_action === "insert_active";
  }).length;
  const eligibleUpdates = eligibleOcean.filter((p) => {
    const entry = manifestByKey.get(p.official_sailing_id);
    return entry?.proposed_action === "update_exact_legacy_match";
  }).length;

  const arithmetic = buildRoyalCaribbeanReconciliationArithmetic({
    uniqueSailings: (simulation.products || []).length,
    oceanCruises: ocean.length,
    oceanCruisetours: (simulation.products || []).filter((p) => p.product_type === "ocean_cruisetour").length,
    unknownProducts: (simulation.products || []).filter((p) => p.product_type === "unknown").length,
    otherProductTypes: (simulation.products || []).filter(
      (p) => !["ocean_cruise", "ocean_cruisetour", "unknown"].includes(p.product_type)
    ).length,
    oceanIncomplete: ocean.filter((p) => p.ocean_bucket === "incomplete").length,
    oceanEligible: eligibleOcean.length,
    oceanWithinCutoff: ocean.filter((p) => p.ocean_bucket === "within_cutoff").length,
    oceanPast: ocean.filter((p) => p.ocean_bucket === "past").length,
    oceanUnfamiliarStatus: ocean.filter((p) => p.ocean_bucket === "unfamiliar_status").length,
    oceanOtherExclusions: ocean.filter(
      (p) =>
        p.ocean_bucket &&
        !["incomplete", "eligible", "within_cutoff", "past", "unfamiliar_status"].includes(p.ocean_bucket)
    ).length,
    recognisedExistingEligible,
    outstandingEligibleInserts,
    proposedUpdates: eligibleUpdates
  });

  const sourceAbsentRows = findSourceAbsentActive
    ? await findSourceAbsentActive({
        supabase: sb,
        cruiseLineId: line.id,
        eligibleKeys,
        today,
        officialProductKeyFn: (raw) =>
          raw?.royal_caribbean_sailing_id || raw?.official_sailing_id || royalCaribbeanOfficialProductKey(raw)
      })
    : [];

  const previousRun = findPreviousSuccessfulMaintenanceRun
    ? await findPreviousSuccessfulMaintenanceRun(sb, line.id, runType)
    : null;
  const previousAbsentIds = extractPreviousAbsentSailingIds(previousRun);

  const shipCoverage = await enumerateShipCoveragePartition({
    unionResult: {
      products: (simulation.products || []).map((p) => ({
        ship_code: p.raw?.ship_code,
        official_sailing_id: p.official_sailing_id
      }))
    },
    today
  });

  const productionSailingIds = productionIndex.official_sailing_ids || new Set();
  const unionSailingIds = new Set(
    (simulation.products || []).map((p) => p.official_sailing_id).filter(Boolean)
  );
  const missingFromUnion = [...productionSailingIds].filter((id) => !unionSailingIds.has(id));
  const detailLookupResults = missingFromUnion.length
    ? await auditProductionIdsViaDetailLookup({
        missingSailingIds: missingFromUnion,
        productionBySailingId: productionIndex.by_official_sailing_id
      })
    : [];
  const enumerationHealth = evaluateWeeklyAuthoritativeEnumerationHealth({
    simulationOk: simulation.ok === true,
    unionSailingIds,
    productionSailingIds,
    duplicateSailingIds: simulation.ingestion_audit?.duplicate_sailing_ids || 0,
    shipCoverage,
    detailLookupResults
  });

  const retrievableEnumerationGapIds = new Set(
    detailLookupResults.filter((row) => row.retrievable).map((row) => row.official_sailing_id)
  );
  const filteredSourceAbsentRows = sourceAbsentRows.filter(
    (row) => !retrievableEnumerationGapIds.has(row.official_sailing_id)
  );

  const sourceAbsencePolicy = classifyRoyalCaribbeanSourceAbsence({
    currentAbsentRows: filteredSourceAbsentRows,
    previousAbsentSailingIds: previousAbsentIds,
    enumerationHealthy: enumerationHealth.royal_caribbean_source_enumeration_ok === true
  });

  const updateAnalysis = classifyRoyalCaribbeanWeeklyUpdates(manifest.products, existingBySailingId);

  const cutoffDate = publicBookingCutoffDate(today);
  const productionCutoffCandidates = (productionIndex.rows || []).filter((row) =>
    shouldRemoveFromPublicInventory({ departureDate: row.departure_date, status: row.status, perthToday: today })
  );

  const health = evaluateRoyalCaribbeanDryRunHealth({
    simulation,
    arithmetic,
    manifest,
    actualWrites: 0,
    enumerationHealth
  });

  const shipAudit = simulation.ship_audit || {};
  const portAudit = simulation.port_audit || {};
  const shipResolutionOk = (shipAudit.unresolved || 0) === 0;
  const embarkationResolutionOk =
    (portAudit.unresolved_conventional || []).filter((r) => r.role === "embarkation").length === 0;

  const weeklyHealth = evaluateRoyalCaribbeanWeeklyHealth({
    sourceRuntimeOk: simulation.ok === true && enumerationHealth.royal_caribbean_source_enumeration_ok === true,
    enumerationHealth,
    reconciliationArithmeticOk: arithmetic.reconciliation_arithmetic_ok === true,
    shipResolutionOk,
    embarkationResolutionOk,
    unknownStatusCount: simulation.classification?.unfamiliar_status_records || 0,
    newEligibleCount: outstandingEligibleInserts,
    proposedUpdateCount: proposedUpdates.length,
    sourceAbsentCandidateCount: sourceAbsencePolicy.source_absent_candidate_count,
    cutoffCandidateCount: productionCutoffCandidates.length,
    actualWrites: 0,
    sourceAbsencePolicy,
    performWrites
  });

  const incompleteByReason = {};
  for (const p of ocean.filter((row) => row.ocean_bucket === "incomplete")) {
    for (const reason of p.failure_reasons || ["unknown"]) {
      incompleteByReason[reason] = (incompleteByReason[reason] || 0) + 1;
    }
  }

  const sourceSnapshotId = computeSourceSnapshotIdFromSailingIds([...unionSailingIds]);
  const dryRunPassed = health.passed && weeklyHealth.weekly_maintenance_healthy;

  const summary = {
    line_slug: lineSlug,
    cruise_line: line.name,
    run_id: runId,
    run_type: runType,
    trigger_type: context.triggerType || context.trigger_type || (performWrites ? "weekly_apply" : "dry_run"),
    dry_run: !performWrites,
    writes_allowed: modeGate.writes_allowed,
    authoritative_enumeration: true,
    union_page_sizes: AUTHORITATIVE_UNION_PAGE_SIZES,
    source_snapshot_id: sourceSnapshotId,
    official_source_total: simulation.official_reported_total || null,
    itinerary_groups: simulation.itinerary_groups_fetched,
    union_groups: simulation.itinerary_groups_fetched,
    union_sailing_identities: unionSailingIds.size,
    sailing_records_expanded: simulation.sailing_records_expanded,
    unique_sailing_ids: (simulation.products || []).length,
    duplicate_sailing_ids: simulation.ingestion_audit?.duplicate_sailing_ids || 0,
    pages_requested: simulation.pagination?.pages_requested || simulation.page_log?.length || 0,
    pages_successful: simulation.pagination?.pages_successful || 0,
    pages_failed: simulation.pagination?.pages_failed || 0,
    classification: simulation.classification,
    time_eligibility: simulation.time_eligibility,
    ship_audit: simulation.ship_audit,
    port_audit: {
      exact_resolved: simulation.port_audit?.exact_resolved?.length || 0,
      alias_resolved: simulation.port_audit?.alias_resolved?.length || 0,
      unresolved_conventional: simulation.port_audit?.unresolved_conventional?.length || 0,
      scenic_cruising: simulation.port_audit?.scenic_cruising?.length || 0,
      sea_day: simulation.port_audit?.sea_day?.length || 0,
      likely_aliases: simulation.port_audit?.likely_aliases || [],
      unresolved_conventional_ports: simulation.port_audit?.unresolved_conventional || [],
      scenic_cruising_stops: simulation.port_audit?.scenic_cruising || [],
      unresolved_embarkation_ports: (simulation.port_audit?.unresolved_conventional || []).filter(
        (row) => row.role === "embarkation"
      )
    },
    destination_audit: simulation.destination_audit,
    production_genuine_sailing_count: productionIndex.genuine_sailing_count,
    production_legacy_html_count: productionIndex.legacy_html_count,
    recognised_existing_eligible_sailings: recognisedExistingEligible,
    proposed_new_eligible_sailings: outstandingEligibleInserts,
    proposed_inserts: proposedInserts.length,
    proposed_insert_sample: proposedInserts.slice(0, 25).map((p) => p.stable_identity_key),
    proposed_updates: proposedUpdates.length,
    update_analysis: updateAnalysis,
    source_duplicates_skipped: simulation.ingestion_audit?.duplicate_sailing_ids || 0,
    duplicate_skips: manifest.products.filter((p) => p.proposed_action === "duplicate_skip").length,
    incomplete_skipped: manifest.products.filter((p) => p.proposed_action === "incomplete_skip").length,
    cruisetours_excluded: manifest.products.filter((p) => p.proposed_action === "ocean_cruisetour_skip").length,
    within_public_cutoff_excluded: manifest.products.filter((p) => p.proposed_action === "within_21_day_cutoff_skip")
      .length,
    unfamiliar_status_skipped: manifest.products.filter((p) => p.proposed_action === "unfamiliar_status_skip").length,
    legacy_html_discovery_artefacts: manifest.legacy_html_discovery_artefacts || [],
    source_absent_active: filteredSourceAbsentRows.length,
    source_absent_sailing_ids: filteredSourceAbsentRows.map((r) => r.official_sailing_id),
    enumeration_gap_sailings: [...retrievableEnumerationGapIds],
    source_absence_policy: sourceAbsencePolicy,
    source_absence_actions_allowed: sourceAbsenceActionAllowed(enumerationHealth),
    production_cutoff_candidates: productionCutoffCandidates.map((row) => ({
      id: row.id,
      official_sailing_id: row.official_sailing_id,
      departure_date: row.departure_date,
      days_until_departure: daysUntilDeparture(row.departure_date, today),
      proposed_action: "hide_from_public_inventory",
      delete: false
    })),
    public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    public_booking_cutoff_date: cutoffDate,
    enumeration_health: enumerationHealth,
    detail_lookup_audit: detailLookupResults,
    royal_caribbean_source_enumeration_ok: enumerationHealth.royal_caribbean_source_enumeration_ok === true,
    ship_coverage: shipCoverage,
    reconciliation_arithmetic: arithmetic,
    reconciliation_arithmetic_ok: arithmetic.reconciliation_arithmetic_ok,
    dry_run_health: health,
    weekly_health: weeklyHealth,
    weekly_maintenance_healthy: weeklyHealth.weekly_maintenance_healthy === true,
    adapter_incomplete_by_reason: incompleteByReason,
    proposed_writes: proposedInserts.length + proposedUpdates.length,
    duration_ms: Date.now() - startedAt,
    actual_writes: 0,
    production_cruise_inserts: 0,
    production_cruise_updates: 0,
    production_cruise_deletes: 0,
    production_expiry_changes: 0,
    production_ship_changes: 0,
    production_alias_changes: 0,
    production_port_changes: 0,
    production_destination_changes: 0,
    inventory_changed: false
  };

  let weeklyManifest = frozenManifestInput;
  let applyResult = null;

  if (performWrites) {
    if (!isRoyalCaribbeanWeeklyReconciliationEnabled()) {
      return {
        ok: false,
        blocked: true,
        reason: "royal_caribbean_weekly_reconciliation_disabled",
        line_slug: lineSlug,
        dry_run: false,
        actual_writes: 0,
        summary
      };
    }
    assertRoyalCaribbeanWritesAllowed(modeGate);

    weeklyManifest =
      weeklyManifest ||
      buildRoyalCaribbeanWeeklyManifestFromDryRun({
        dryRunResult: { summary, manifest },
        today,
        firstActivationCycle
      });

    const manifestValidation = validateFrozenWeeklyManifest(weeklyManifest, { firstActivationCycle });
    if (!manifestValidation.passed || !dryRunPassed) {
      return {
        ok: false,
        blocked: true,
        reason: !dryRunPassed
          ? [...health.failures, ...weeklyHealth.failures].join("; ")
          : manifestValidation.failures.join("; "),
        line_slug: lineSlug,
        dry_run: false,
        actual_writes: 0,
        summary,
        weekly_manifest: weeklyManifest,
        manifest_validation: manifestValidation
      };
    }

    applyResult = await applyRoyalCaribbeanWeeklyManifest({
      manifest: weeklyManifest,
      supabase: sb,
      cruiseLine: line,
      performWrites: true,
      runId,
      firstActivationCycle
    });

    summary.actual_writes = applyResult.stats.actual_writes;
    summary.production_cruise_inserts = applyResult.stats.inserted;
    summary.production_cruise_updates = applyResult.stats.updated;
    summary.production_expiry_changes = applyResult.stats.expired;
    summary.inventory_changed = applyResult.stats.actual_writes > 0;
    summary.weekly_manifest_hash = weeklyManifest.manifest_hash;
    summary.write_details = applyResult.stats.write_details;

    weeklyHealth.actual_writes = applyResult.stats.actual_writes;
    if (applyResult.stats.actual_writes > 0 && applyResult.ok !== true) {
      weeklyHealth.failures = [...(weeklyHealth.failures || []), "apply_failed"];
      weeklyHealth.weekly_maintenance_healthy = false;
    }
  }

  const passed = performWrites ? applyResult?.ok === true && dryRunPassed : dryRunPassed;

  return {
    ok: passed,
    dry_run: !performWrites,
    blocked: !passed,
    reason: passed
      ? null
      : performWrites
        ? applyResult?.stats?.write_details?.find((row) => row.error)?.error ||
          [...health.failures, ...weeklyHealth.failures].join("; ")
        : [...health.failures, ...weeklyHealth.failures].join("; "),
    summary,
    manifest,
    weekly_manifest: weeklyManifest,
    apply_result: applyResult,
    simulation_ok: simulation.ok,
    sample_stats: simulation.sample_stats,
    page_log: simulation.page_log,
    products: simulation.products
  };
}

module.exports = {
  runRoyalCaribbeanWeeklyMaintenance,
  AUTHORITATIVE_UNION_PAGE_SIZES
};
