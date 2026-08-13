/**
 * Royal Caribbean phased weekly read-only reconciliation.
 * Consumes a frozen six-phase source union; never refetches catalogue pages and
 * never writes production application data.
 */
const {
  normaliseRoyalCaribbeanProduct,
  stampTimeEligibility,
  auditRoyalCaribbeanShips,
  auditRoyalCaribbeanPorts,
  auditRoyalCaribbeanDestinations,
  catalogueDestinations,
  officialProductKey,
  LINE_SLUG
} = require("./royal-caribbean-discovery-adapter");
const {
  fetchRoyalCaribbeanFleet,
  summariseRoyalCaribbeanSailings
} = require("./royal-caribbean-discovery-source");
const { buildPhasedAuthoritativeFetchResult } = require("./royal-caribbean-phased-enumeration");
const { loadClassificationDestinations } = require("./destination-queries");
const { buildRoyalCaribbeanBatchManifest, indexExistingRoyalCaribbeanRecords } = require("./royal-caribbean-discovery-writes");
const { indexGenuineRoyalCaribbeanProduction } = require("./royal-caribbean-post-write-verification");
const {
  buildRoyalCaribbeanReconciliationArithmetic,
  evaluateRoyalCaribbeanDryRunHealth
} = require("./royal-caribbean-reconciliation-summary");
const {
  enumerateShipCoveragePartition,
  computeSourceSnapshotIdFromSailingIds,
  evaluateWeeklyAuthoritativeEnumerationHealth,
  auditProductionIdsViaDetailLookup,
  sourceAbsenceActionAllowed
} = require("./royal-caribbean-source-enumeration");
const { classifyRoyalCaribbeanSourceAbsence, extractPreviousAbsentSailingIds } = require("./royal-caribbean-source-absence");
const { classifyRoyalCaribbeanWeeklyUpdates } = require("./royal-caribbean-weekly-updates");
const { evaluateRoyalCaribbeanWeeklyHealth } = require("./royal-caribbean-weekly-health");
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

async function loadContext(sb) {
  const line = (await sb(`ci_cruise_lines?slug=eq.${encodeURIComponent(LINE_SLUG)}&select=id,name,slug&limit=1`))?.[0];
  if (!line) throw new Error("Royal Caribbean line not found");
  const destinationRows = await loadClassificationDestinations(sb);
  const destinations = catalogueDestinations(destinationRows || []);
  const ships = await sb(`ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,official_line_ship_id,ship_class,active`);
  return { line, destinations, ships: ships || [] };
}

async function previousScheduledRun(sb, cruiseLineId) {
  const rows = await sb(`cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&scope=eq.cruise_line&status=eq.completed&select=id,stats,finished_at,created_at&order=finished_at.desc&limit=20`);
  return (rows || []).find((row) => row.stats?.run_type === ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE && row.stats?.trigger_type === "scheduled") || null;
}

function incompletenessReasons(products) {
  const out = {};
  for (const p of products.filter((row) => row.ocean_bucket === "incomplete")) {
    for (const reason of p.failure_reasons || ["unknown"]) out[reason] = (out[reason] || 0) + 1;
  }
  return out;
}

async function buildSimulation({ sb, runId, today }) {
  const fetchResult = await buildPhasedAuthoritativeFetchResult({ runId, today });
  if (!fetchResult.ok) {
    return { ok: false, fetch_result: fetchResult, products: [], actual_writes: 0 };
  }
  const { line, destinations, ships } = await loadContext(sb);
  const fleet = await fetchRoyalCaribbeanFleet();
  const context = { cruiseLine: line, destinations, ships, today };
  const products = (fetchResult.raw_sailings || []).map((raw) => normaliseRoyalCaribbeanProduct(raw, context));
  const time = stampTimeEligibility(products, today);
  const ocean = products.filter((p) => p.product_type === "ocean_cruise");
  const cruisetours = products.filter((p) => p.product_type === "ocean_cruisetour");
  const statuses = {};
  for (const p of products) {
    const key = p.sailing_status || p.status_class || "unknown";
    statuses[key] = (statuses[key] || 0) + 1;
  }
  return {
    ok: true,
    read_only: true,
    writes_blocked: true,
    fetch_result: fetchResult,
    official_reported_total: fetchResult.total_official,
    itinerary_groups_fetched: fetchResult.itinerary_groups_fetched,
    sailing_records_expanded: products.length,
    pagination: fetchResult.pagination,
    ingestion_audit: fetchResult.ingestion_audit,
    fleet: { ok: fleet.ok === true, ships: fleet.ships || [] },
    sample_stats: summariseRoyalCaribbeanSailings(fetchResult.raw_sailings || [], { today, perthToday: today }),
    classification: {
      ordinary_ocean_cruises: ocean.length,
      ocean_cruisetours_excluded: cruisetours.length,
      unknown_products: products.filter((p) => p.product_type === "unknown").length,
      source_complete: products.filter((p) => p.source_complete).length,
      source_incomplete: products.filter((p) => !p.source_complete).length,
      source_statuses: statuses,
      unfamiliar_status_records: products.filter((p) => p.status_class === "unfamiliar_status").length
    },
    time_eligibility: {
      future_sailings: products.filter((p) => p.time_eligibility !== "past").length,
      more_than_21_day_eligible: time.publiclyEligible.length,
      within_21_day_cutoff: time.withinCutoff.length,
      already_departed: products.filter((p) => p.time_eligibility === "past").length,
      perth_cutoff_date: time.cutoffDate
    },
    ship_audit: auditRoyalCaribbeanShips(products, ships, fleet.ships || []),
    port_audit: auditRoyalCaribbeanPorts(ocean),
    destination_audit: auditRoyalCaribbeanDestinations(ocean),
    products,
    publicly_eligible_products: time.publiclyEligible,
    within_cutoff_products: time.withinCutoff,
    phased_enumeration_health: fetchResult.phased_enumeration_health,
    phase_manifests: fetchResult.phase_manifests,
    _context: { line, destinations, ships }
  };
}

async function runRoyalCaribbeanPhasedWeeklyDryRun({ sb, runId, today = perthCalendarDate(), triggerType = "phased_runtime_proof" } = {}) {
  if (!sb) throw new Error("supabase client required");
  if (!runId) throw new Error("run_id required");
  const started = Date.now();
  const simulation = await buildSimulation({ sb, runId, today });
  if (!simulation.ok) {
    return { ok: false, reason: "phased_source_unhealthy", simulation, actual_writes: 0 };
  }
  const { line, destinations } = simulation._context;
  const products = simulation.products || [];
  const ocean = products.filter((p) => p.product_type === "ocean_cruise");
  const eligibleOcean = ocean.filter((p) => p.ocean_bucket === "eligible");
  const unionSailingIds = new Set(products.map((p) => p.official_sailing_id).filter(Boolean));
  const eligibleKeys = new Set(eligibleOcean.map((p) => officialProductKey(p.raw)).filter(Boolean));

  const productionIndex = await indexGenuineRoyalCaribbeanProduction(sb);
  const existingRecords = await indexExistingRoyalCaribbeanRecords(sb, line.id);
  const existingBySailingId = new Map((existingRecords.rows || []).filter((r) => r.official_sailing_id).map((r) => [r.official_sailing_id, r]));
  const manifest = await buildRoyalCaribbeanBatchManifest({ products, cruiseLine: line, destinations, supabase: sb, runId });
  const manifestByKey = new Map(manifest.products.filter((m) => m.stable_identity_key).map((m) => [m.stable_identity_key, m]));
  const recognisedExistingEligible = eligibleOcean.filter((p) => ["duplicate_skip", "update_exact_legacy_match"].includes(manifestByKey.get(p.official_sailing_id)?.proposed_action)).length;
  const outstandingEligibleInserts = eligibleOcean.filter((p) => manifestByKey.get(p.official_sailing_id)?.proposed_action === "insert_active").length;
  const eligibleUpdates = eligibleOcean.filter((p) => manifestByKey.get(p.official_sailing_id)?.proposed_action === "update_exact_legacy_match").length;
  const proposedInserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
  const proposedUpdates = manifest.products.filter((p) => p.proposed_action === "update_exact_legacy_match");

  const arithmetic = buildRoyalCaribbeanReconciliationArithmetic({
    uniqueSailings: products.length,
    oceanCruises: ocean.length,
    oceanCruisetours: products.filter((p) => p.product_type === "ocean_cruisetour").length,
    unknownProducts: products.filter((p) => p.product_type === "unknown").length,
    otherProductTypes: products.filter((p) => !["ocean_cruise", "ocean_cruisetour", "unknown"].includes(p.product_type)).length,
    oceanIncomplete: ocean.filter((p) => p.ocean_bucket === "incomplete").length,
    oceanEligible: eligibleOcean.length,
    oceanWithinCutoff: ocean.filter((p) => p.ocean_bucket === "within_cutoff").length,
    oceanPast: ocean.filter((p) => p.ocean_bucket === "past").length,
    oceanUnfamiliarStatus: ocean.filter((p) => p.ocean_bucket === "unfamiliar_status").length,
    oceanOtherExclusions: ocean.filter((p) => p.ocean_bucket && !["incomplete", "eligible", "within_cutoff", "past", "unfamiliar_status"].includes(p.ocean_bucket)).length,
    recognisedExistingEligible,
    outstandingEligibleInserts,
    proposedUpdates: eligibleUpdates
  });

  const productionSailingIds = productionIndex.official_sailing_ids || new Set();
  const missingFromUnion = [...productionSailingIds].filter((id) => !unionSailingIds.has(id));
  const detailLookupResults = missingFromUnion.length ? await auditProductionIdsViaDetailLookup({
    missingSailingIds: missingFromUnion,
    productionBySailingId: productionIndex.by_official_sailing_id
  }) : [];
  const shipCoverage = await enumerateShipCoveragePartition({ unionResult: { products: products.map((p) => ({ ship_code: p.raw?.ship_code, official_sailing_id: p.official_sailing_id })) }, today });
  const enumerationHealth = evaluateWeeklyAuthoritativeEnumerationHealth({
    simulationOk: simulation.ok === true && simulation.phased_enumeration_health?.ok === true,
    unionSailingIds,
    productionSailingIds,
    duplicateSailingIds: 0,
    shipCoverage,
    detailLookupResults
  });

  const retrievableGapIds = new Set(detailLookupResults.filter((r) => r.retrievable).map((r) => r.official_sailing_id));
  const sourceAbsentRows = (productionIndex.rows || []).filter((row) => row.status === "active" && row.official_sailing_id && !eligibleKeys.has(row.official_sailing_id) && !retrievableGapIds.has(row.official_sailing_id));
  const previousRun = await previousScheduledRun(sb, line.id);
  const sourceAbsencePolicy = classifyRoyalCaribbeanSourceAbsence({
    currentAbsentRows: sourceAbsentRows,
    previousAbsentSailingIds: extractPreviousAbsentSailingIds(previousRun),
    enumerationHealthy: enumerationHealth.royal_caribbean_source_enumeration_ok === true
  });
  const updateAnalysis = classifyRoyalCaribbeanWeeklyUpdates(manifest.products, existingBySailingId);
  const productionCutoffCandidates = (productionIndex.rows || []).filter((row) => shouldRemoveFromPublicInventory({ departureDate: row.departure_date, status: row.status, perthToday: today }));
  const dryRunHealth = evaluateRoyalCaribbeanDryRunHealth({ simulation, arithmetic, manifest, actualWrites: 0, enumerationHealth });
  const unresolvedEmbark = (simulation.port_audit?.unresolved_conventional || []).filter((row) => row.role === "embarkation");
  const weeklyHealth = evaluateRoyalCaribbeanWeeklyHealth({
    sourceRuntimeOk: simulation.ok === true && simulation.phased_enumeration_health?.ok === true,
    enumerationHealth,
    reconciliationArithmeticOk: arithmetic.reconciliation_arithmetic_ok === true,
    shipResolutionOk: (simulation.ship_audit?.unresolved || 0) === 0,
    embarkationResolutionOk: unresolvedEmbark.length === 0,
    unknownStatusCount: simulation.classification?.unfamiliar_status_records || 0,
    newEligibleCount: outstandingEligibleInserts,
    proposedUpdateCount: proposedUpdates.length,
    sourceAbsentCandidateCount: sourceAbsencePolicy.source_absent_candidate_count,
    cutoffCandidateCount: productionCutoffCandidates.length,
    actualWrites: 0,
    sourceAbsencePolicy,
    performWrites: false
  });
  const sourceSnapshotId = computeSourceSnapshotIdFromSailingIds([...unionSailingIds]);
  const passed = dryRunHealth.passed && weeklyHealth.weekly_maintenance_healthy;

  const summary = {
    line_slug: LINE_SLUG,
    run_id: runId,
    run_type: ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE,
    trigger_type: triggerType,
    dry_run: true,
    phased_authoritative_enumeration: true,
    source_snapshot_id: sourceSnapshotId,
    official_source_total: simulation.official_reported_total,
    union_groups: simulation.itinerary_groups_fetched,
    union_sailing_identities: unionSailingIds.size,
    pages_requested: simulation.pagination?.pages_requested || 0,
    phase_manifests: simulation.phase_manifests,
    phased_enumeration_health: simulation.phased_enumeration_health,
    classification: simulation.classification,
    time_eligibility: simulation.time_eligibility,
    production_genuine_sailing_count: productionIndex.genuine_sailing_count,
    production_legacy_html_count: productionIndex.legacy_html_count,
    recognised_existing_eligible_sailings: recognisedExistingEligible,
    proposed_new_eligible_sailings: outstandingEligibleInserts,
    proposed_insert_sample: proposedInserts.slice(0, 25).map((p) => p.stable_identity_key),
    proposed_updates: proposedUpdates.length,
    update_analysis: updateAnalysis,
    incomplete_skipped: manifest.products.filter((p) => p.proposed_action === "incomplete_skip").length,
    cruisetours_excluded: manifest.products.filter((p) => p.proposed_action === "ocean_cruisetour_skip").length,
    within_public_cutoff_excluded: manifest.products.filter((p) => p.proposed_action === "within_21_day_cutoff_skip").length,
    source_absent_active: sourceAbsentRows.length,
    source_absent_sailing_ids: sourceAbsentRows.map((r) => r.official_sailing_id),
    enumeration_gap_sailings: [...retrievableGapIds],
    source_absence_policy: sourceAbsencePolicy,
    source_absence_actions_allowed: sourceAbsenceActionAllowed(enumerationHealth),
    production_cutoff_candidates: productionCutoffCandidates.map((row) => ({ official_sailing_id: row.official_sailing_id, departure_date: row.departure_date, days_until_departure: daysUntilDeparture(row.departure_date, today), proposed_action: "hide_from_public_inventory", delete: false })),
    public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    public_booking_cutoff_date: publicBookingCutoffDate(today),
    enumeration_health: enumerationHealth,
    reconciliation_arithmetic: arithmetic,
    reconciliation_arithmetic_ok: arithmetic.reconciliation_arithmetic_ok,
    dry_run_health: dryRunHealth,
    weekly_health: weeklyHealth,
    weekly_maintenance_healthy: weeklyHealth.weekly_maintenance_healthy === true,
    adapter_incomplete_by_reason: incompletenessReasons(ocean),
    actual_writes: 0,
    duration_ms: Date.now() - started
  };

  return { ok: passed, dry_run: true, summary, manifest, simulation, actual_writes: 0 };
}

module.exports = { runRoyalCaribbeanPhasedWeeklyDryRun, buildSimulation };
