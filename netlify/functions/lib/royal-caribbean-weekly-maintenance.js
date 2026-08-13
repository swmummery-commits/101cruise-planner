/**
 * Royal Caribbean International — read-only weekly maintenance dry-run.
 * Production cruise writes are refused in Prompt 2/3.
 */

const {
  simulateRoyalCaribbeanInventory,
  officialProductKey: royalCaribbeanOfficialProductKey,
  LINE_SLUG: ROYAL_CARIBBEAN_LINE_SLUG
} = require("./royal-caribbean-discovery-adapter");
const { buildRoyalCaribbeanBatchManifest } = require("./royal-caribbean-discovery-writes");
const { resolveRoyalCaribbeanDiscoveryMode } = require("./royal-caribbean-discovery-mode");
const {
  buildRoyalCaribbeanReconciliationArithmetic,
  evaluateRoyalCaribbeanDryRunHealth
} = require("./royal-caribbean-reconciliation-summary");
const {
  ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE,
  perthCalendarDate
} = require("./cruise-discovery-maintenance");
const {
  partitionByPublicBookingCutoff,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require("./public-discovered-cruise-inventory");

async function runRoyalCaribbeanWeeklyMaintenance(context = {}) {
  const sb = context.supabase;
  if (!sb) throw new Error("Royal Caribbean maintenance requires an explicit supabase client");

  const dryRun = context.dryRun !== false && context.dry_run !== false;
  const performWrites = Boolean(context.performWrites ?? context.perform_writes) && !dryRun;
  const runId = String(context.runId || context.run_id || `royal-caribbean-weekly-${Date.now()}`).trim();
  const today = context.today || perthCalendarDate();
  const lineSlug = ROYAL_CARIBBEAN_LINE_SLUG;
  const runType = ROYAL_CARIBBEAN_WEEKLY_MAINTENANCE_RUN_TYPE;

  if (performWrites) {
    return {
      ok: false,
      blocked: true,
      reason: "royal_caribbean_writes_disabled",
      line_slug: lineSlug,
      dry_run: true,
      actual_writes: 0
    };
  }

  const modeGate = resolveRoyalCaribbeanDiscoveryMode("production_read_only");
  const { loadLineContext, findSourceAbsentActive } = context._deps || {};

  const { line, destinations } = await loadLineContext(sb, lineSlug);
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,official_line_ship_id,ship_class,active`
  );

  const simulation = await simulateRoyalCaribbeanInventory({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today,
    pageSize: context.pageSize || 50,
    maxPages: context.maxPages,
    requestDelayMs: context.requestDelayMs
  });

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
  const recognisedExistingEligible = eligibleOcean.filter((p) => {
    const entry = manifest.products.find((m) => m.stable_identity_key === p.official_sailing_id);
    return entry && ["duplicate_skip", "update_exact_legacy_match"].includes(entry.proposed_action);
  }).length;
  const outstandingEligibleInserts = eligibleOcean.filter((p) => {
    const entry = manifest.products.find((m) => m.stable_identity_key === p.official_sailing_id);
    return entry?.proposed_action === "insert_active";
  }).length;
  const eligibleUpdates = eligibleOcean.filter((p) => {
    const entry = manifest.products.find((m) => m.stable_identity_key === p.official_sailing_id);
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

  const sourceAbsent = findSourceAbsentActive
    ? await findSourceAbsentActive({
        supabase: sb,
        cruiseLineId: line.id,
        eligibleKeys,
        today,
        officialProductKeyFn: (raw) =>
          raw?.royal_caribbean_sailing_id || raw?.official_sailing_id || royalCaribbeanOfficialProductKey(raw)
      })
    : [];

  const health = evaluateRoyalCaribbeanDryRunHealth({
    simulation,
    arithmetic,
    manifest,
    actualWrites: 0
  });

  const incompleteByReason = {};
  for (const p of ocean.filter((row) => row.ocean_bucket === "incomplete")) {
    for (const reason of p.failure_reasons || ["unknown"]) {
      incompleteByReason[reason] = (incompleteByReason[reason] || 0) + 1;
    }
  }

  const summary = {
    line_slug: lineSlug,
    cruise_line: line.name,
    run_id: runId,
    run_type: runType,
    trigger_type: context.triggerType || context.trigger_type || "dry_run",
    dry_run: true,
    writes_allowed: modeGate.writes_allowed,
    official_source_total: simulation.official_reported_total || null,
    itinerary_groups: simulation.itinerary_groups_fetched,
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
    recognised_existing_eligible_sailings: recognisedExistingEligible,
    proposed_new_eligible_sailings: outstandingEligibleInserts,
    proposed_inserts: proposedInserts.length,
    proposed_updates: proposedUpdates.length,
    source_duplicates_skipped: simulation.ingestion_audit?.duplicate_sailing_ids || 0,
    duplicate_skips: manifest.products.filter((p) => p.proposed_action === "duplicate_skip").length,
    incomplete_skipped: manifest.products.filter((p) => p.proposed_action === "incomplete_skip").length,
    cruisetours_excluded: manifest.products.filter((p) => p.proposed_action === "ocean_cruisetour_skip").length,
    within_public_cutoff_excluded: manifest.products.filter((p) => p.proposed_action === "within_21_day_cutoff_skip")
      .length,
    unfamiliar_status_skipped: manifest.products.filter((p) => p.proposed_action === "unfamiliar_status_skip").length,
    legacy_html_discovery_artefacts: manifest.legacy_html_discovery_artefacts || [],
    source_absent_active: sourceAbsent.length,
    source_absent_sailing_ids: sourceAbsent.map((r) => r.official_sailing_id),
    public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    public_booking_cutoff_date: simulation.public_booking_cutoff_date,
    reconciliation_arithmetic: arithmetic,
    reconciliation_arithmetic_ok: arithmetic.reconciliation_arithmetic_ok,
    dry_run_health: health,
    adapter_incomplete_by_reason: incompleteByReason,
    proposed_writes: proposedInserts.length + proposedUpdates.length,
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

  return {
    ok: health.passed,
    dry_run: true,
    blocked: !health.passed,
    reason: health.passed ? null : health.failures.join("; "),
    summary,
    manifest,
    simulation_ok: simulation.ok,
    sample_stats: simulation.sample_stats,
    page_log: simulation.page_log,
    products: simulation.products
  };
}

module.exports = {
  runRoyalCaribbeanWeeklyMaintenance
};
