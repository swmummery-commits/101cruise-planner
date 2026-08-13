/**
 * Weekly cruise-line inventory maintenance runner (HAL + Celebrity).
 * Fetches full official snapshot, compares with production, applies bounded writes.
 */

const crypto = require("crypto");
const {
  simulateHalDiscovery,
  catalogueDestinations: halCatalogueDestinations,
  officialProductKey: halOfficialProductKey
} = require("./holland-america-discovery-adapter");
const {
  simulateCelebrityInventory,
  catalogueDestinations: celebrityCatalogueDestinations,
  isEligibleCelebrityCruise,
  officialProductKey: celebrityOfficialProductKey
} = require("./celebrity-discovery-adapter");
const {
  simulatePrincessInventory,
  catalogueDestinations: princessCatalogueDestinations,
  isEligiblePrincessCruise,
  officialProductKey: princessOfficialProductKey
} = require("./princess-discovery-adapter");
const {
  simulateExploraInventory,
  catalogueDestinations: exploraCatalogueDestinations,
  isEligibleExploraCruise,
  officialProductKey: exploraOfficialProductKey
} = require("./explora-discovery-adapter");
const {
  simulateSeabournDiscovery,
  catalogueDestinations: seabournCatalogueDestinations,
  isEligibleSeabournInventory,
  officialProductKey: seabournOfficialProductKey,
  buildEligibilityWaterfall
} = require("./seabourn-discovery-adapter");
const {
  buildHalBatchManifest,
  applyHalBatchWrites,
  indexExistingHalRecords
} = require("./holland-america-discovery-writes");
const {
  buildCelebrityBatchManifest,
  applyCelebrityBatchWrites,
  indexExistingCelebrityRecords
} = require("./celebrity-discovery-writes");
const {
  buildPrincessBatchManifest,
  applyPrincessBatchWrites
} = require("./princess-discovery-writes");
const {
  buildExploraBatchManifest,
  applyExploraBatchWrites
} = require("./explora-discovery-writes");
const {
  buildSeabournBatchManifest,
  applySeabournBatchWrites
} = require("./seabourn-discovery-writes");
const { resolveHalDiscoveryMode } = require("./holland-america-discovery-mode");
const { resolveCelebrityDiscoveryMode } = require("./celebrity-discovery-mode");
const { resolvePrincessDiscoveryMode } = require("./princess-discovery-mode");
const { resolveExploraDiscoveryMode } = require("./explora-discovery-mode");
const { resolveSeabournDiscoveryMode } = require("./seabourn-discovery-mode");
const { supabase: defaultSupabase } = require("./cruise-discovery-ops");
const { loadClassificationDestinations } = require("./destination-queries");
const {
  HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
  PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
  EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE,
  SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
  perthCalendarDate
} = require("./cruise-discovery-maintenance");
const { headCountSupabase, loadCelebrityDatabaseInventoryCounts } = require("./celebrity-inventory-counts");
const {
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock,
  verifyMaintenanceLockOwnership,
  weeklyLockKey
} = require("./cruise-discovery-maintenance-locks");
const { persistMaintenanceRollbackManifest } = require("./cruise-discovery-maintenance-manifests");
const {
  partitionByPublicBookingCutoff,
  PUBLIC_BOOKING_CUTOFF_DAYS,
  publicBookingMinimumDepartureDate
} = require("./public-discovered-cruise-inventory");
const { buildPrincessReconciliationSummary } = require("./princess-reconciliation-summary");
const { buildSeabournReconciliationSummary } = require("./seabourn-reconciliation-summary");
const {
  classifySeabournSourceAbsence,
  extractPreviousAbsentSailingIds
} = require("./seabourn-source-absence");

const MAX_WRITES_PER_BATCH = 100;
const MAX_WEEKLY_WRITES = 30;
/** Explora onboarding runs with its own, lower weekly cap so Princess limits stay untouched. */
const EXPLORA_MAX_WEEKLY_WRITES = Math.max(
  1,
  Number(process.env.EXPLORA_MAX_WEEKLY_WRITES) || 25
);
const SEABOURN_MAX_WEEKLY_WRITES = Math.max(
  1,
  Number(process.env.SEABOURN_MAX_WEEKLY_WRITES) || 30
);
const WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP = "weekly_change_volume_exceeds_initial_cap";

async function loadActiveProductionTotal(supabase, cruiseLineId, lineSlug) {
  if (lineSlug === "celebrity-cruises") {
    const counts = await loadCelebrityDatabaseInventoryCounts(supabase, cruiseLineId);
    return counts.active;
  }
  return headCountSupabase(
    supabase,
    "discovered_cruises",
    `cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&status=eq.active`
  );
}

function snapshotChecksum(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function acquireMaintenanceLock(supabase, lineSlug, runId, runRecordId = null) {
  return acquireMaintenanceDbLock(supabase, {
    lockKey: weeklyLockKey(lineSlug),
    ownerId: runId,
    runId,
    runRecordId
  });
}

async function releaseMaintenanceLock(supabase, lineSlug, runId) {
  return releaseMaintenanceDbLock(supabase, {
    lockKey: weeklyLockKey(lineSlug),
    ownerId: runId
  });
}

async function loadLineContext(supabase, lineSlug) {
  const line = (
    await supabase(`ci_cruise_lines?slug=eq.${encodeURIComponent(lineSlug)}&select=id,name,slug,website_url,cruise_search_url&limit=1`)
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${lineSlug}`);
  const destRows = await loadClassificationDestinations(supabase);
  const destinations =
    lineSlug === "holland-america-line"
      ? halCatalogueDestinations(destRows || [])
      : lineSlug === "princess-cruises"
        ? princessCatalogueDestinations(destRows || [])
        : lineSlug === "explora-journeys"
          ? exploraCatalogueDestinations(destRows || [])
          : lineSlug === "seabourn-cruise-line"
            ? seabournCatalogueDestinations(destRows || [])
            : celebrityCatalogueDestinations(destRows || []);
  const ships = await supabase(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id,ship_class`
  );
  return { line, destinations, ships: ships || [], destRows: destRows || [] };
}

async function findPreviousSuccessfulMaintenanceRun(supabase, cruiseLineId, runType) {
  const runs = await supabase(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&scope=eq.cruise_line&status=eq.completed&select=id,stats,finished_at,created_at&order=finished_at.desc&limit=20`
  );
  return (runs || []).find((r) => r.stats?.run_type === runType && r.stats?.trigger_type === "scheduled") || null;
}

async function findPreviousSeabournMaintenanceRun(supabase, cruiseLineId, runType) {
  const runs = await supabase(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&scope=eq.cruise_line&status=eq.completed&select=id,stats,finished_at,created_at&order=finished_at.desc&limit=50`
  );
  return (runs || []).find((r) => r.stats?.run_type === runType) || null;
}

/** Exclude rapid controlled catch-up runs — absence chaining needs separated observations. */
const SEABOURN_ABSENCE_OBSERVATION_MIN_GAP_MS = 60 * 60 * 1000;

async function findPreviousSeabournAbsenceObservationRun(supabase, cruiseLineId, runType) {
  const now = Date.now();
  const runs = await supabase(
    `cruise_discovery_runs?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&scope=eq.cruise_line&status=eq.completed&select=id,stats,finished_at,created_at&order=finished_at.desc&limit=50`
  );
  return (
    (runs || []).find((r) => {
      if (r.stats?.run_type !== runType) return false;
      if (r.stats?.catch_up_batch || r.stats?.controlled_batch) return false;
      const finishedAt = new Date(r.finished_at || r.created_at).getTime();
      if (Number.isFinite(finishedAt) && now - finishedAt < SEABOURN_ABSENCE_OBSERVATION_MIN_GAP_MS) {
        return false;
      }
      return Array.isArray(r.stats?.source_absent_sailing_ids) && r.stats.source_absent_sailing_ids.length > 0;
    }) || null
  );
}

function computeHalResolutionRates(products) {
  const cruises = products.filter((p) => p.product_type === "cruise");
  const total = cruises.length || 1;
  const complete = cruises.filter((p) => p.complete_high_confidence);
  return {
    eligible_total: complete.length,
    ship_resolution_pct: (cruises.filter((p) => p.ship_resolution?.resolved).length / total) * 100,
    departure_port_resolution_pct:
      (cruises.filter(
        (p) => p.candidate?.departure_port || p.candidate?.departure_port_meta?.status === "resolved"
      ).length /
        total) *
      100,
    destination_resolution_pct:
      (cruises.filter((p) => p.destination_resolution?.status === "resolved").length / total) * 100,
    identity_coverage_pct: 100,
    duplicate_official_identities: 0
  };
}

function computeCelebrityResolutionRates(products) {
  const eligible = products.filter((p) => p.complete_high_confidence && isEligibleCelebrityCruise(p.product_type));
  const rivers = eligible.filter((p) => p.product_type === "river_cruise");
  const riverTotal = rivers.length || 1;
  const total = eligible.length || 1;
  const keys = new Set();
  let dups = 0;
  for (const p of eligible) {
    const k = celebrityOfficialProductKey(p.raw);
    if (keys.has(k)) dups += 1;
    keys.add(k);
  }
  return {
    eligible_total: eligible.length,
    ship_resolution_pct: (eligible.filter((p) => p.ship_resolution?.resolved).length / total) * 100,
    departure_port_resolution_pct:
      (eligible.filter((p) => p.departure_port_resolution?.status === "resolved").length / total) * 100,
    destination_resolution_pct:
      (eligible.filter((p) => p.destination_resolution?.status === "resolved").length / total) * 100,
    river_ship_resolution_pct:
      rivers.length === 0
        ? 100
        : (rivers.filter((p) => p.ship_resolution?.resolved).length / riverTotal) * 100,
    river_departure_port_resolution_pct:
      rivers.length === 0
        ? 100
        : (rivers.filter((p) => p.departure_port_resolution?.status === "resolved").length / riverTotal) * 100,
    river_destination_resolution_pct:
      rivers.length === 0
        ? 100
        : (rivers.filter((p) => p.destination_resolution?.status === "resolved").length / riverTotal) * 100,
    identity_coverage_pct: eligible.length ? ((eligible.length - dups) / eligible.length) * 100 : 100,
    duplicate_official_identities: dups
  };
}

function computePrincessResolutionRates(products) {
  const eligible = products.filter((p) => p.complete_high_confidence && isEligiblePrincessCruise(p.product_type));
  const total = eligible.length || 1;
  const keys = new Set();
  let dups = 0;
  for (const p of eligible) {
    const k = princessOfficialProductKey(p.raw);
    if (keys.has(k)) dups += 1;
    keys.add(k);
  }
  return {
    eligible_total: eligible.length,
    ship_resolution_pct: (eligible.filter((p) => p.ship_resolution?.resolved).length / total) * 100,
    departure_port_resolution_pct:
      (eligible.filter((p) => p.departure_port_resolution?.status === "resolved").length / total) * 100,
    destination_resolution_pct:
      (eligible.filter((p) => p.destination_resolution?.status === "resolved").length / total) * 100,
    identity_coverage_pct: eligible.length ? ((eligible.length - dups) / eligible.length) * 100 : 100,
    duplicate_official_identities: dups
  };
}

function computeExploraResolutionRates(products) {
  const eligible = products.filter((p) => p.complete_high_confidence && isEligibleExploraCruise(p.product_type));
  const total = eligible.length || 1;
  const keys = new Set();
  let dups = 0;
  for (const p of eligible) {
    const k = exploraOfficialProductKey(p.raw);
    if (keys.has(k)) dups += 1;
    keys.add(k);
  }
  return {
    eligible_total: eligible.length,
    ship_resolution_pct: (eligible.filter((p) => p.ship_resolution?.resolved).length / total) * 100,
    departure_port_resolution_pct:
      (eligible.filter((p) => p.departure_port_resolution?.status === "resolved").length / total) * 100,
    destination_resolution_pct:
      (eligible.filter((p) => p.destination_resolution?.status === "resolved").length / total) * 100,
    identity_coverage_pct: eligible.length ? ((eligible.length - dups) / eligible.length) * 100 : 100,
    duplicate_official_identities: dups
  };
}

function computeSeabournResolutionRates(products) {
  const eligible = (products || []).filter((p) => p.eligibility?.production_eligible);
  const total = eligible.length || 1;
  const keys = new Set();
  let dups = 0;
  for (const p of eligible) {
    const k = seabournOfficialProductKey(p.raw);
    if (keys.has(k)) dups += 1;
    keys.add(k);
  }
  return {
    eligible_total: eligible.length,
    ship_resolution_pct: (eligible.filter((p) => p.ship_resolution?.resolved).length / total) * 100,
    departure_port_resolution_pct:
      (eligible.filter((p) => p.candidate?.departure_port_meta?.status === "resolved").length / total) * 100,
    destination_resolution_pct:
      (eligible.filter((p) => p.destination_resolution?.status === "resolved").length / total) * 100,
    identity_coverage_pct: eligible.length ? ((eligible.length - dups) / eligible.length) * 100 : 100,
    duplicate_official_identities: dups
  };
}

function evaluateSeabournSourceQualityGate(simulation) {
  const failures = [];
  const accounting = simulation?.fetch_result?.source_row_accounting || simulation?.source_row_accounting;
  const pagination = simulation?.fetch_result?.pagination || simulation?.pagination;
  const numFound = simulation?.num_found_official || simulation?.fetch_result?.numFound || 0;

  if (!numFound) failures.push("source_num_found_zero");
  if (accounting && accounting.reconciles !== true) failures.push("source_row_accounting_failed");
  if (pagination && pagination.exhausted !== true) failures.push("source_pagination_incomplete");
  if ((pagination?.repeated_page_signatures || 0) > 0) failures.push("source_repeated_page_detected");
  if ((pagination?.zero_progress_pages || 0) > 0) failures.push("source_zero_progress_pagination");
  if (accounting?.malformed_or_invalid_rows != null && accounting.raw_source_rows > 0) {
    const malformedRate = accounting.malformed_or_invalid_rows / accounting.raw_source_rows;
    if (malformedRate > 0.05) failures.push("source_malformed_rate_above_5pct");
  }
  if (simulation?.identity?.official_key_collisions?.length) failures.push("official_identity_collisions");

  return {
    passed: failures.length === 0,
    failures,
    blocked: failures.length > 0
  };
}

function evaluateMaintenanceQualityGate({ lineSlug, metrics, previousEligible, manifest, dryRun }) {
  const failures = [];
  const eligible = metrics.eligible_total || 0;
  const prev = previousEligible?.stats?.eligible_total ?? previousEligible?.stats?.official_eligible_total ?? null;

  if (prev != null && prev > 0 && eligible < prev * 0.8) {
    failures.push("eligible_inventory_collapse_gt_20pct");
  }
  if (metrics.ship_resolution_pct < 98) failures.push("ship_resolution_below_98pct");
  if (metrics.departure_port_resolution_pct < 95) failures.push("departure_port_resolution_below_95pct");
  if (metrics.destination_resolution_pct < 90) failures.push("destination_resolution_below_90pct");
  if (metrics.identity_coverage_pct < 100) failures.push("identity_coverage_below_100pct");
  if ((metrics.duplicate_official_identities || 0) > 0) failures.push("duplicate_official_identities");

  if (lineSlug === "celebrity-cruises") {
    if (metrics.river_ship_resolution_pct < 100) failures.push("river_ship_resolution_below_100pct");
    if (metrics.river_departure_port_resolution_pct < 100) failures.push("river_departure_port_below_100pct");
    if (metrics.river_destination_resolution_pct < 100) failures.push("river_destination_below_100pct");
  }

  const writes = (manifest?.products || []).filter((p) =>
    ["insert_active", "update_existing", "update_exact_legacy_match"].includes(p.proposed_action)
  );
  if (writes.some((p) => String(p.product_type || "").includes("cruisetour"))) {
    failures.push("cruisetour_in_proposed_write_set");
  }

  if (dryRun && failures.length) {
    return { passed: false, failures, blocked: true };
  }
  if (!dryRun && failures.length) {
    return { passed: false, failures, blocked: true };
  }
  return { passed: true, failures: [], blocked: false };
}

async function findSourceAbsentActive({ supabase, cruiseLineId, eligibleKeys, today, officialProductKeyFn }) {
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
    const sid =
      row.official_sailing_id ||
      row.raw_extract?.seabourn_sailing_id ||
      row.raw_extract?.celebrity_sailing_id ||
      row.raw_extract?.princess_sailing_id ||
      row.raw_extract?.explora_sailing_id ||
      row.raw_extract?.hal_product_key ||
      null;
    const key = sid || (row.raw_extract ? officialProductKeyFn(row.raw_extract) : null);
    if (key && !eligibleKeys.has(key)) {
      absent.push({
        discovered_cruise_id: row.id,
        official_sailing_id: sid || key,
        departure_date: row.departure_date,
        action: "source_absent_retained_active"
      });
    }
  }
  return absent;
}

async function runHalWeeklyMaintenance(context = {}) {
  const sb = context.supabase || defaultSupabase;
  const dryRun = Boolean(context.dryRun ?? context.dry_run);
  const performWrites = Boolean(context.performWrites ?? context.perform_writes) && !dryRun;
  const maxWrites = Math.min(MAX_WRITES_PER_BATCH, Number(context.maxWrites ?? context.max_writes ?? 100) || 100);
  const runId = String(context.runId || context.run_id || `hal-weekly-${Date.now()}`).trim();
  const runRecordId = context.runRecordId || context.run_record_id || null;
  const today = context.today || perthCalendarDate();
  const lineSlug = "holland-america-line";
  const runType = HAL_WEEKLY_MAINTENANCE_RUN_TYPE;

  const lock = await acquireMaintenanceLock(sb, lineSlug, runId, runRecordId);
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
    const { line, destinations, ships } = await loadLineContext(sb, lineSlug);
    const modeGate = resolveHalDiscoveryMode(performWrites ? "weekly_maintenance" : "production_read_only");
    if (performWrites && !modeGate.writes_allowed) {
      return { ok: false, blocked: true, reason: modeGate.reason, line_slug: lineSlug };
    }

    const simulation = await simulateHalDiscovery({
      cruiseLine: line,
      ships,
      destinations,
      today,
      useCache: false
    });

    if (!simulation?.voyages?.length && simulation?.fetch_failed) {
      return {
        ok: false,
        blocked: false,
        failed: true,
        reason: "official_source_unreachable",
        line_slug: lineSlug,
        simulation
      };
    }

    const normalised = simulation.voyages || simulation.normalised || [];
    const { publiclyEligible: normalisedPublic, withinCutoff: withinPublicCutoff } =
      partitionByPublicBookingCutoff(
        normalised,
        (p) => p.candidate?.departure_date || p.departure_date || p.raw?.departure_date,
        today
      );
    const products = normalisedPublic.filter(
      (p) => p.complete_high_confidence && p.product_type === "cruise"
    );
    const eligibleKeys = new Set(products.map((p) => halOfficialProductKey(p.raw)).filter(Boolean));
    const metrics = computeHalResolutionRates(normalised);
    const previousRun = await findPreviousSuccessfulMaintenanceRun(sb, line.id, runType);

    const manifest = await buildHalBatchManifest({
      products: normalisedPublic,
      cruiseLine: line,
      destinations,
      supabase: sb,
      runId
    });

    const proposedInserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
    const proposedUpdates = manifest.products.filter((p) => p.proposed_action === "update_existing");
    const unchanged = manifest.products.filter((p) => p.proposed_action === "duplicate_skip");
    const sourceAbsent = await findSourceAbsentActive({
      supabase: sb,
      cruiseLineId: line.id,
      eligibleKeys,
      today,
      officialProductKeyFn: (raw) => halOfficialProductKey(raw)
    });

    const qualityGate = evaluateMaintenanceQualityGate({
      lineSlug,
      metrics,
      previousEligible: previousRun,
      manifest,
      dryRun
    });

    const snapshotId = snapshotChecksum(Array.from(eligibleKeys).sort());

    const summary = {
      line_slug: lineSlug,
      run_id: runId,
      run_type: runType,
      trigger_type: context.triggerType || context.trigger_type || "scheduled",
      dry_run: dryRun,
      official_source_total: simulation.num_found_official || simulation.raw_voyage_count || null,
      eligible_total: metrics.eligible_total,
      active_production_total: await loadActiveProductionTotal(sb, line.id, lineSlug),
      proposed_inserts: proposedInserts.length,
      proposed_updates: proposedUpdates.length,
      unchanged: unchanged.length,
      source_absent_active: sourceAbsent.length,
      source_absent_sailing_ids: sourceAbsent.map((r) => r.official_sailing_id),
      cruisetours_excluded: normalised.filter((p) => p.product_type === "cruisetour").length,
      incomplete_skipped: normalised.filter((p) => !p.complete_high_confidence).length,
      within_public_cutoff_excluded: withinPublicCutoff.length,
      public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
      resolution_rates: metrics,
      quality_gate: qualityGate,
      snapshot_id: snapshotId,
      inventory_changed: false
    };

    if (!qualityGate.passed) {
      return { ok: false, blocked: true, failed: true, reason: qualityGate.failures.join("; "), summary };
    }

    if (dryRun || !performWrites) {
      return { ok: true, dry_run: true, summary, manifest };
    }

    const writeProducts = normalisedPublic.filter((row) => {
      const entry = manifest.products.find(
        (p) => p.stable_product_identity_key === halOfficialProductKey(row.raw)
      );
      return entry && ["insert_active", "update_existing"].includes(entry.proposed_action);
    });

    const writeResult = await applyHalBatchWrites({
      products: writeProducts.slice(0, maxWrites),
      cruiseLine: line,
      maxWrites,
      runId,
      supabase: sb,
      destinations,
      performWrites: true,
      mode: "weekly_maintenance",
      maintenanceTrace: {
        run_id: runId,
        run_record_id: runRecordId,
        cruise_line_id: line.id,
        cruise_line_slug: lineSlug,
        trigger_type: context.triggerType || context.trigger_type || "scheduled"
      }
    });

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
    summary.duplicate_skips = writeResult.stats?.duplicate_skips || 0;
    summary.failed_writes = writeResult.stats?.failed || 0;
    summary.recovered_after_fetch_failure = writeResult.stats?.recovered_after_fetch_failure || 0;
    summary.write_attempts =
      (writeResult.stats?.inserted || 0) +
      (writeResult.stats?.updated || 0) +
      (writeResult.stats?.failed || 0) +
      (writeResult.stats?.duplicate_skips || 0);
    summary.inventory_changed = (summary.inserts || 0) + (summary.updates || 0) > 0;
    summary.rollback_manifest_id = rollback?.manifest_record_id || null;

    return {
      ok: writeResult.stats?.failed === 0,
      summary,
      write_result: writeResult.stats,
      manifest,
      rollback_manifest: rollback?.manifest || null
    };
  } finally {
    await releaseMaintenanceLock(sb, lineSlug, runId);
  }
}

async function runCelebrityWeeklyMaintenance(context = {}) {
  const sb = context.supabase || defaultSupabase;
  const dryRun = Boolean(context.dryRun ?? context.dry_run);
  const performWrites = Boolean(context.performWrites ?? context.perform_writes) && !dryRun;
  const maxWrites = Math.min(MAX_WRITES_PER_BATCH, Number(context.maxWrites ?? context.max_writes ?? 100) || 100);
  const runId = String(context.runId || context.run_id || `celebrity-weekly-${Date.now()}`).trim();
  const runRecordId = context.runRecordId || context.run_record_id || null;
  const today = context.today || perthCalendarDate();
  const lineSlug = "celebrity-cruises";
  const runType = CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE;

  const lock = await acquireMaintenanceLock(sb, lineSlug, runId, runRecordId);
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
    const { line, destinations, ships } = await loadLineContext(sb, lineSlug);
    const modeGate = resolveCelebrityDiscoveryMode(performWrites ? "weekly_maintenance" : "production_read_only");
    if (performWrites && !modeGate.writes_allowed) {
      return { ok: false, blocked: true, reason: modeGate.reason, line_slug: lineSlug };
    }

    const simulation = await simulateCelebrityInventory({
      cruiseLine: line,
      ships,
      destinations,
      today,
      useCache: false
    });

    const { publiclyEligible: celebrityPublic, withinCutoff: withinPublicCutoff } =
      partitionByPublicBookingCutoff(
        simulation.products || [],
        (p) => p.candidate?.departure_date || p.departure_date || p.raw?.departure_date,
        today
      );

    const products = celebrityPublic.filter(
      (p) => p.complete_high_confidence && isEligibleCelebrityCruise(p.product_type)
    );
    const eligibleKeys = new Set(products.map((p) => celebrityOfficialProductKey(p.raw)).filter(Boolean));
    const metrics = computeCelebrityResolutionRates(celebrityPublic);
    const previousRun = await findPreviousSuccessfulMaintenanceRun(sb, line.id, runType);

    const manifest = await buildCelebrityBatchManifest({
      products: celebrityPublic,
      cruiseLine: line,
      destinations,
      supabase: sb,
      runId
    });

    const proposedInserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
    const proposedUpdates = manifest.products.filter((p) => p.proposed_action === "update_exact_legacy_match");
    const unchanged = manifest.products.filter((p) => p.proposed_action === "duplicate_skip");
    const sourceAbsent = await findSourceAbsentActive({
      supabase: sb,
      cruiseLineId: line.id,
      eligibleKeys,
      today,
      officialProductKeyFn: (raw) => celebrityOfficialProductKey(raw)
    });

    const qualityGate = evaluateMaintenanceQualityGate({
      lineSlug,
      metrics,
      previousEligible: previousRun,
      manifest,
      dryRun
    });

    const snapshotId = snapshotChecksum(Array.from(eligibleKeys).sort());

    const activeProductionTotal = await loadActiveProductionTotal(sb, line.id, lineSlug);

    const summary = {
      line_slug: lineSlug,
      run_id: runId,
      run_type: runType,
      trigger_type: context.triggerType || context.trigger_type || "scheduled",
      dry_run: dryRun,
      official_source_total: simulation.official_reported_total || null,
      eligible_total: metrics.eligible_total,
      active_production_total: activeProductionTotal,
      proposed_inserts: proposedInserts.length,
      proposed_updates: proposedUpdates.length,
      unchanged: unchanged.length,
      source_absent_active: sourceAbsent.length,
      source_absent_sailing_ids: sourceAbsent.map((r) => r.official_sailing_id),
      cruisetours_excluded: (simulation.products || []).filter((p) =>
        String(p.product_type || "").includes("cruisetour")
      ).length,
      incomplete_skipped: (simulation.products || []).filter((p) => !p.complete_high_confidence).length,
      within_public_cutoff_excluded: withinPublicCutoff.length,
      public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
      resolution_rates: metrics,
      quality_gate: qualityGate,
      snapshot_id: snapshotId,
      inventory_changed: false
    };

    if (!qualityGate.passed) {
      return { ok: false, blocked: true, failed: true, reason: qualityGate.failures.join("; "), summary };
    }

    if (dryRun || !performWrites) {
      return { ok: true, dry_run: true, summary, manifest };
    }

    const writeProducts = celebrityPublic.filter((row) => {
      const entry = manifest.products.find(
        (p) => p.stable_identity_key === celebrityOfficialProductKey(row.raw)
      );
      return entry && ["insert_active", "update_exact_legacy_match"].includes(entry.proposed_action);
    });

    const writeResult = await applyCelebrityBatchWrites({
      products: writeProducts.slice(0, maxWrites),
      cruiseLine: line,
      maxWrites,
      runId,
      supabase: sb,
      destinations,
      performWrites: true,
      mode: "weekly_maintenance",
      maintenanceTrace: {
        run_id: runId,
        run_record_id: runRecordId,
        cruise_line_id: line.id,
        cruise_line_slug: lineSlug,
        trigger_type: context.triggerType || context.trigger_type || "scheduled"
      }
    });

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
    summary.duplicate_skips = writeResult.stats?.duplicate_skips || 0;
    summary.failed_writes = writeResult.stats?.failed || 0;
    summary.recovered_after_fetch_failure = writeResult.stats?.recovered_after_fetch_failure || 0;
    summary.write_attempts =
      (writeResult.stats?.inserted || 0) +
      (writeResult.stats?.updated || 0) +
      (writeResult.stats?.failed || 0) +
      (writeResult.stats?.duplicate_skips || 0);
    summary.inventory_changed = (summary.inserts || 0) + (summary.updates || 0) > 0;
    summary.rollback_manifest_id = rollback?.manifest_record_id || null;

    return {
      ok: writeResult.stats?.failed === 0,
      summary,
      write_result: writeResult.stats,
      manifest,
      rollback_manifest: rollback?.manifest || null
    };
  } finally {
    await releaseMaintenanceLock(sb, lineSlug, runId);
  }
}

async function runPrincessWeeklyMaintenance(context = {}) {
  const sb = context.supabase || defaultSupabase;
  const dryRun = Boolean(context.dryRun ?? context.dry_run);
  const performWrites = Boolean(context.performWrites ?? context.perform_writes) && !dryRun;
  const maxWrites = Math.min(MAX_WRITES_PER_BATCH, Number(context.maxWrites ?? context.max_writes ?? 100) || 100);
  const runId = String(context.runId || context.run_id || `princess-weekly-${Date.now()}`).trim();
  const runRecordId = context.runRecordId || context.run_record_id || null;
  const today = context.today || perthCalendarDate();
  const lineSlug = "princess-cruises";
  const runType = PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE;

  const lock = await acquireMaintenanceLock(sb, lineSlug, runId, runRecordId);
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
    const { line, destinations, ships } = await loadLineContext(sb, lineSlug);
    const writeMode =
      context.writeMode ||
      context.write_mode ||
      (performWrites ? "weekly_maintenance" : "production_read_only");
    const modeGate = resolvePrincessDiscoveryMode(writeMode);
    if (performWrites && !modeGate.writes_allowed) {
      return { ok: false, blocked: true, reason: modeGate.reason, line_slug: lineSlug };
    }

    const simulation = await simulatePrincessInventory({
      cruiseLine: line,
      ships,
      destinations,
      today,
      useCache: false,
      collectSourceDiagnostics: Boolean(context.collectSourceDiagnostics ?? context.collect_source_diagnostics)
    });

    if (!simulation?.products?.length && simulation?.fetch_failed) {
      return {
        ok: false,
        blocked: false,
        failed: true,
        reason: "official_source_unreachable",
        line_slug: lineSlug,
        simulation
      };
    }

    const normalised = simulation.products || [];
    const { publiclyEligible: princessPublic, withinCutoff: withinPublicCutoff } =
      partitionByPublicBookingCutoff(
        normalised,
        (p) => p.candidate?.departure_date || p.departure_date || p.raw?.departure_date,
        today
      );
    const products = princessPublic.filter(
      (p) => p.complete_high_confidence && isEligiblePrincessCruise(p.product_type)
    );
    const eligibleKeys = new Set(products.map((p) => princessOfficialProductKey(p.raw)).filter(Boolean));
    const metrics = computePrincessResolutionRates(princessPublic);
    const previousRun = await findPreviousSuccessfulMaintenanceRun(sb, line.id, runType);

    const manifest = await buildPrincessBatchManifest({
      products: princessPublic,
      cruiseLine: line,
      destinations,
      supabase: sb,
      runId
    });

    const proposedInserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
    const proposedUpdates = manifest.products.filter((p) => p.proposed_action === "update_exact_legacy_match");
    const unchanged = manifest.products.filter((p) => p.proposed_action === "duplicate_skip");
    const sourceAbsent = await findSourceAbsentActive({
      supabase: sb,
      cruiseLineId: line.id,
      eligibleKeys,
      today,
      officialProductKeyFn: (raw) => princessOfficialProductKey(raw)
    });

    const qualityGate = evaluateMaintenanceQualityGate({
      lineSlug,
      metrics,
      previousEligible: previousRun,
      manifest,
      dryRun
    });

    const snapshotId = snapshotChecksum(Array.from(eligibleKeys).sort());
    const activeProductionTotal = await loadActiveProductionTotal(sb, line.id, lineSlug);
    const reconciliation = buildPrincessReconciliationSummary({
      activeProductionTotal,
      eligibleTotal: metrics.eligible_total,
      recognisedExistingEligible: unchanged.length,
      outstandingEligibleInserts: proposedInserts.length,
      proposedUpdates: proposedUpdates.length,
      sourceAbsentActive: sourceAbsent.length,
      writesExecuted: 0
    });

    const summary = {
      line_slug: lineSlug,
      run_id: runId,
      run_type: runType,
      trigger_type: context.triggerType || context.trigger_type || "scheduled",
      dry_run: dryRun,
      official_source_total: simulation.num_found_official || simulation.raw_group_count || null,
      eligible_total: metrics.eligible_total,
      active_production_total: activeProductionTotal,
      proposed_inserts: proposedInserts.length,
      proposed_updates: proposedUpdates.length,
      unchanged: unchanged.length,
      recognised_existing_eligible: reconciliation.recognised_existing_eligible,
      outstanding_eligible_inserts: reconciliation.outstanding_eligible_inserts,
      source_absent_active: sourceAbsent.length,
      source_absent_sailing_ids: sourceAbsent.map((r) => r.official_sailing_id),
      reconciliation_arithmetic_ok: reconciliation.reconciliation_arithmetic_ok,
      all_active_recognised_in_eligible_source: reconciliation.all_active_recognised_in_eligible_source,
      cruisetours_excluded: normalised.filter((p) => p.product_type === "cruisetour").length,
      incomplete_skipped: normalised.filter((p) => !p.complete_high_confidence).length,
      within_public_cutoff_excluded: withinPublicCutoff.length,
      public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
      resolution_rates: metrics,
      quality_gate: qualityGate,
      snapshot_id: snapshotId,
      inventory_changed: false
    };

    if (!qualityGate.passed) {
      return { ok: false, blocked: true, failed: true, reason: qualityGate.failures.join("; "), summary, simulation };
    }

    if (!reconciliation.reconciliation_arithmetic_ok) {
      return {
        ok: false,
        blocked: false,
        failed: true,
        reason: "reconciliation_arithmetic_failed",
        summary,
        simulation
      };
    }

    if (dryRun || !performWrites) {
      return { ok: true, dry_run: true, summary, manifest, simulation };
    }

    const isWeeklyMaintenanceWrite =
      (context.writeMode || context.write_mode || "weekly_maintenance") === "weekly_maintenance";
    const combinedProposed = proposedInserts.length + proposedUpdates.length;
    const effectiveMaxWrites = isWeeklyMaintenanceWrite
      ? Math.min(maxWrites, MAX_WEEKLY_WRITES)
      : maxWrites;
    summary.effective_max_writes = effectiveMaxWrites;

    if (isWeeklyMaintenanceWrite && combinedProposed > MAX_WEEKLY_WRITES) {
      return {
        ok: false,
        blocked: false,
        failed: true,
        reason: WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP,
        summary: {
          ...summary,
          weekly_write_cap: MAX_WEEKLY_WRITES,
          combined_proposed_changes: combinedProposed,
          proposed_inserts: proposedInserts.length,
          proposed_updates: proposedUpdates.length
        },
        simulation
      };
    }

    if (combinedProposed === 0) {
      summary.inserts = 0;
      summary.updates = 0;
      summary.failed_writes = 0;
      summary.recovered_after_fetch_failure = 0;
      summary.write_attempts = 0;
      summary.duplicate_skips = unchanged.length;
      summary.inventory_changed = false;
      summary.zero_change_apply = true;
      return { ok: true, dry_run: false, zero_change_apply: true, summary, manifest, simulation };
    }

    const lockKey = weeklyLockKey(lineSlug);
    const lockOwnership = await verifyMaintenanceLockOwnership(sb, { lockKey, ownerId: runId });
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

    const writeProducts = princessPublic
      .filter((row) => {
        const entry = manifest.products.find(
          (p) => p.stable_identity_key === princessOfficialProductKey(row.raw)
        );
        return entry && ["insert_active", "update_exact_legacy_match"].includes(entry.proposed_action);
      })
      .sort((a, b) => {
        const ka = princessOfficialProductKey(a.raw) || "";
        const kb = princessOfficialProductKey(b.raw) || "";
        return ka.localeCompare(kb);
      });

    const writeResult = await applyPrincessBatchWrites({
      products: writeProducts.slice(0, effectiveMaxWrites),
      cruiseLine: line,
      maxWrites: effectiveMaxWrites,
      runId,
      supabase: sb,
      destinations,
      performWrites: true,
      maintenanceTrace: {
        run_id: runId,
        run_record_id: runRecordId,
        cruise_line_id: line.id,
        cruise_line_slug: lineSlug,
        trigger_type: context.triggerType || context.trigger_type || "scheduled"
      }
    });

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
    summary.duplicate_skips = writeResult.stats?.duplicate_skips || 0;
    summary.failed_writes = writeResult.stats?.failed || 0;
    summary.recovered_after_fetch_failure = writeResult.stats?.recovered_after_fetch_failure || 0;
    summary.write_attempts =
      (writeResult.stats?.inserted || 0) +
      (writeResult.stats?.updated || 0) +
      (writeResult.stats?.failed || 0) +
      (writeResult.stats?.duplicate_skips || 0);
    summary.inventory_changed = (summary.inserts || 0) + (summary.updates || 0) > 0;
    summary.rollback_manifest_id = rollback?.manifest_record_id || null;

    return {
      ok: writeResult.stats?.failed === 0,
      summary,
      write_result: writeResult,
      manifest,
      rollback_result: rollback || null,
      rollback_manifest: rollback?.manifest || null
    };
  } finally {
    await releaseMaintenanceLock(sb, lineSlug, runId);
  }
}

async function runExploraWeeklyMaintenance(context = {}) {
  const sb = context.supabase || defaultSupabase;
  const dryRun = Boolean(context.dryRun ?? context.dry_run);
  const performWrites = Boolean(context.performWrites ?? context.perform_writes) && !dryRun;
  const maxWrites = Math.min(MAX_WRITES_PER_BATCH, Number(context.maxWrites ?? context.max_writes ?? 100) || 100);
  const runId = String(context.runId || context.run_id || `explora-weekly-${Date.now()}`).trim();
  const runRecordId = context.runRecordId || context.run_record_id || null;
  const today = context.today || perthCalendarDate();
  const lineSlug = "explora-journeys";
  const runType = EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE;

  const lock = await acquireMaintenanceLock(sb, lineSlug, runId, runRecordId);
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
    const { line, destinations, ships } = await loadLineContext(sb, lineSlug);
    const writeMode =
      context.writeMode ||
      context.write_mode ||
      (performWrites ? "weekly_maintenance" : "production_read_only");
    const modeGate = resolveExploraDiscoveryMode(writeMode);
    if (performWrites && !modeGate.writes_allowed) {
      return { ok: false, blocked: true, reason: modeGate.reason, line_slug: lineSlug };
    }

    const simulation = await simulateExploraInventory({
      cruiseLine: line,
      ships,
      destinations,
      today,
      useCache: false,
      concurrency: context.concurrency,
      maxJourneys: context.maxJourneys ?? context.max_journeys,
      transport: context.transport
    });

    if (!simulation?.products?.length && simulation?.fetch_failed) {
      return {
        ok: false,
        blocked: false,
        failed: true,
        reason: "official_source_unreachable",
        line_slug: lineSlug,
        simulation
      };
    }

    const normalised = simulation.products || [];
    const { publiclyEligible: exploraPublic, withinCutoff: withinPublicCutoff } =
      partitionByPublicBookingCutoff(
        normalised,
        (p) => p.candidate?.departure_date || p.departure_date || p.raw?.departure_date,
        today
      );
    const products = exploraPublic.filter(
      (p) => p.complete_high_confidence && isEligibleExploraCruise(p.product_type)
    );
    const eligibleKeys = new Set(products.map((p) => exploraOfficialProductKey(p.raw)).filter(Boolean));
    const metrics = computeExploraResolutionRates(exploraPublic);
    const previousRun = await findPreviousSuccessfulMaintenanceRun(sb, line.id, runType);

    const manifest = await buildExploraBatchManifest({
      products: exploraPublic,
      cruiseLine: line,
      destinations,
      supabase: sb,
      runId
    });

    const proposedInserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
    const proposedUpdates = manifest.products.filter((p) => p.proposed_action === "update_exact_legacy_match");
    const unchanged = manifest.products.filter((p) => p.proposed_action === "duplicate_skip");
    const sourceAbsent = await findSourceAbsentActive({
      supabase: sb,
      cruiseLineId: line.id,
      eligibleKeys,
      today,
      officialProductKeyFn: (raw) => exploraOfficialProductKey(raw)
    });

    const qualityGate = evaluateMaintenanceQualityGate({
      lineSlug,
      metrics,
      previousEligible: previousRun,
      manifest,
      dryRun
    });

    const snapshotId = snapshotChecksum(Array.from(eligibleKeys).sort());
    const activeProductionTotal = await loadActiveProductionTotal(sb, line.id, lineSlug);
    const reconciliation = buildPrincessReconciliationSummary({
      activeProductionTotal,
      eligibleTotal: metrics.eligible_total,
      recognisedExistingEligible: unchanged.length,
      outstandingEligibleInserts: proposedInserts.length,
      proposedUpdates: proposedUpdates.length,
      sourceAbsentActive: sourceAbsent.length,
      writesExecuted: 0
    });

    const summary = {
      line_slug: lineSlug,
      run_id: runId,
      run_type: runType,
      trigger_type: context.triggerType || context.trigger_type || "scheduled",
      dry_run: dryRun,
      official_source_total: simulation.num_found_official || simulation.raw_journey_count || null,
      eligible_total: metrics.eligible_total,
      active_production_total: activeProductionTotal,
      proposed_inserts: proposedInserts.length,
      proposed_updates: proposedUpdates.length,
      unchanged: unchanged.length,
      recognised_existing_eligible: reconciliation.recognised_existing_eligible,
      outstanding_eligible_inserts: reconciliation.outstanding_eligible_inserts,
      source_absent_active: sourceAbsent.length,
      source_absent_sailing_ids: sourceAbsent.map((r) => r.official_sailing_id),
      reconciliation_arithmetic_ok: reconciliation.reconciliation_arithmetic_ok,
      all_active_recognised_in_eligible_source: reconciliation.all_active_recognised_in_eligible_source,
      non_cruise_excluded: normalised.filter((p) => p.product_type !== "ocean_cruise").length,
      incomplete_skipped: normalised.filter((p) => !p.complete_high_confidence).length,
      within_public_cutoff_excluded: withinPublicCutoff.length,
      public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
      resolution_rates: metrics,
      quality_gate: qualityGate,
      snapshot_id: snapshotId,
      weekly_write_cap: EXPLORA_MAX_WEEKLY_WRITES,
      inventory_changed: false
    };

    if (!qualityGate.passed) {
      return { ok: false, blocked: true, failed: true, reason: qualityGate.failures.join("; "), summary, simulation };
    }

    if (!reconciliation.reconciliation_arithmetic_ok) {
      return {
        ok: false,
        blocked: false,
        failed: true,
        reason: "reconciliation_arithmetic_failed",
        summary,
        simulation
      };
    }

    if (dryRun || !performWrites) {
      return { ok: true, dry_run: true, summary, manifest, simulation };
    }

    const isWeeklyMaintenanceWrite =
      (context.writeMode || context.write_mode || "weekly_maintenance") === "weekly_maintenance";
    const combinedProposed = proposedInserts.length + proposedUpdates.length;
    const effectiveMaxWrites = isWeeklyMaintenanceWrite
      ? Math.min(maxWrites, EXPLORA_MAX_WEEKLY_WRITES)
      : maxWrites;
    summary.effective_max_writes = effectiveMaxWrites;

    if (isWeeklyMaintenanceWrite && combinedProposed > EXPLORA_MAX_WEEKLY_WRITES) {
      return {
        ok: false,
        blocked: false,
        failed: true,
        reason: WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP,
        summary: {
          ...summary,
          weekly_write_cap: EXPLORA_MAX_WEEKLY_WRITES,
          combined_proposed_changes: combinedProposed,
          proposed_inserts: proposedInserts.length,
          proposed_updates: proposedUpdates.length
        },
        simulation
      };
    }

    if (combinedProposed === 0) {
      summary.inserts = 0;
      summary.updates = 0;
      summary.failed_writes = 0;
      summary.recovered_after_fetch_failure = 0;
      summary.write_attempts = 0;
      summary.duplicate_skips = unchanged.length;
      summary.inventory_changed = false;
      summary.zero_change_apply = true;
      return { ok: true, dry_run: false, zero_change_apply: true, summary, manifest, simulation };
    }

    const lockKey = weeklyLockKey(lineSlug);
    const lockOwnership = await verifyMaintenanceLockOwnership(sb, { lockKey, ownerId: runId });
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

    const writeProducts = exploraPublic
      .filter((row) => {
        const entry = manifest.products.find(
          (p) => p.stable_identity_key === exploraOfficialProductKey(row.raw)
        );
        return entry && ["insert_active", "update_exact_legacy_match"].includes(entry.proposed_action);
      })
      .sort((a, b) => {
        const ka = exploraOfficialProductKey(a.raw) || "";
        const kb = exploraOfficialProductKey(b.raw) || "";
        return ka.localeCompare(kb);
      });

    const writeResult = await applyExploraBatchWrites({
      products: writeProducts.slice(0, effectiveMaxWrites),
      cruiseLine: line,
      maxWrites: effectiveMaxWrites,
      runId,
      supabase: sb,
      destinations,
      performWrites: true,
      maintenanceTrace: {
        run_id: runId,
        run_record_id: runRecordId,
        cruise_line_id: line.id,
        cruise_line_slug: lineSlug,
        trigger_type: context.triggerType || context.trigger_type || "scheduled"
      }
    });

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
    summary.duplicate_skips = writeResult.stats?.duplicate_skips || 0;
    summary.failed_writes = writeResult.stats?.failed || 0;
    summary.recovered_after_fetch_failure = writeResult.stats?.recovered_after_fetch_failure || 0;
    summary.write_attempts =
      (writeResult.stats?.inserted || 0) +
      (writeResult.stats?.updated || 0) +
      (writeResult.stats?.failed || 0) +
      (writeResult.stats?.duplicate_skips || 0);
    summary.inventory_changed = (summary.inserts || 0) + (summary.updates || 0) > 0;
    summary.rollback_manifest_id = rollback?.manifest_record_id || null;

    return {
      ok: writeResult.stats?.failed === 0,
      summary,
      write_result: writeResult,
      manifest,
      rollback_result: rollback || null,
      rollback_manifest: rollback?.manifest || null
    };
  } finally {
    await releaseMaintenanceLock(sb, lineSlug, runId);
  }
}

async function runSeabournWeeklyMaintenance(context = {}) {
  const sb = context.supabase || defaultSupabase;
  const dryRun = context.dryRun ?? context.dry_run;
  const explicitDryRun = dryRun === undefined ? true : Boolean(dryRun);
  const performWrites =
    Boolean(context.performWrites ?? context.perform_writes) && !explicitDryRun;
  const maxWrites = Math.min(MAX_WRITES_PER_BATCH, Number(context.maxWrites ?? context.max_writes ?? 100) || 100);
  const runId = String(context.runId || context.run_id || `seabourn-weekly-${Date.now()}`).trim();
  const runRecordId = context.runRecordId || context.run_record_id || null;
  const today = context.today || perthCalendarDate();
  const lineSlug = "seabourn-cruise-line";
  const runType = SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE;

  const lock = await acquireMaintenanceLock(sb, lineSlug, runId, runRecordId);
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
    const { line, destinations, ships } = await loadLineContext(sb, lineSlug);
    const writeMode =
      context.writeMode ||
      context.write_mode ||
      (performWrites ? "weekly_maintenance" : "production_read_only");
    const modeGate = resolveSeabournDiscoveryMode(writeMode);
    if (performWrites && !modeGate.writes_allowed) {
      return { ok: false, blocked: true, reason: modeGate.reason, line_slug: lineSlug };
    }

    const simulation = await simulateSeabournDiscovery({
      cruiseLine: line,
      ships,
      destinations,
      today,
      useCache: false,
      supabaseQuery: sb,
      runEnrichment: false
    });

    const sourceQualityGate = evaluateSeabournSourceQualityGate(simulation);
    if (!sourceQualityGate.passed) {
      return {
        ok: false,
        blocked: true,
        failed: true,
        reason: sourceQualityGate.failures.join("; "),
        line_slug: lineSlug,
        source_quality_gate: sourceQualityGate,
        simulation
      };
    }

    const normalised = simulation.products || [];
    const { publiclyEligible: sbnPublic, withinCutoff: withinPublicCutoff } = partitionByPublicBookingCutoff(
      normalised,
      (p) => p.candidate?.departure_date || p.raw?.departure_date,
      today
    );
    const productionEligible = sbnPublic.filter((p) => p.eligibility?.production_eligible);
    const manifestProducts = sbnPublic.filter((p) => p.eligibility?.product_policy?.included !== false);
    const eligibleKeys = new Set(productionEligible.map((p) => seabournOfficialProductKey(p.raw)).filter(Boolean));
    const metrics = computeSeabournResolutionRates(productionEligible);
    const previousRun = await findPreviousSeabournMaintenanceRun(sb, line.id, runType);
    const previousAbsenceRun = await findPreviousSeabournAbsenceObservationRun(sb, line.id, runType);
    const waterfall = buildEligibilityWaterfall(normalised, today);

    const manifest = await buildSeabournBatchManifest({
      products: manifestProducts,
      cruiseLine: line,
      destinations,
      supabase: sb,
      runId
    });

    const proposedInserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
    const proposedUpdates = manifest.products.filter((p) => p.proposed_action === "update_exact_legacy_match");
    const unchanged = manifest.products.filter((p) => p.proposed_action === "duplicate_skip");
    const sourceAbsent = await findSourceAbsentActive({
      supabase: sb,
      cruiseLineId: line.id,
      eligibleKeys,
      today,
      officialProductKeyFn: (raw) => seabournOfficialProductKey(raw)
    });
    const sourceAbsencePolicy = classifySeabournSourceAbsence({
      currentAbsentRows: sourceAbsent,
      previousAbsentSailingIds: extractPreviousAbsentSailingIds(previousAbsenceRun),
      enumerationHealthy: sourceQualityGate.passed === true
    });

    const qualityGate = evaluateMaintenanceQualityGate({
      lineSlug,
      metrics,
      previousEligible: previousRun,
      manifest,
      dryRun: explicitDryRun
    });

    const snapshotId = snapshotChecksum(Array.from(eligibleKeys).sort());
    const activeProductionTotal = await loadActiveProductionTotal(sb, line.id, lineSlug);
    const reconciliation = buildSeabournReconciliationSummary({
      activeProductionTotal,
      eligibleTotal: metrics.eligible_total,
      recognisedExistingEligible: unchanged.length,
      outstandingEligibleInserts: proposedInserts.length,
      proposedUpdates: proposedUpdates.length,
      sourceAbsentActive: sourceAbsent.length,
      sourceAbsentObserved: sourceAbsencePolicy.source_absent_observed,
      sourceAbsentRetained: sourceAbsencePolicy.source_absent_retained,
      writesExecuted: 0
    });

    const accounting = simulation.fetch_result?.source_row_accounting || simulation.source_row_accounting || null;

    const summary = {
      line_slug: lineSlug,
      run_id: runId,
      run_type: runType,
      trigger_type: context.triggerType || context.trigger_type || "scheduled",
      dry_run: explicitDryRun,
      write_authorisation: performWrites ? "apply_requested" : "dry_run",
      official_source_total: simulation.num_found_official || accounting?.raw_source_rows || null,
      source_row_accounting: accounting,
      eligible_total: metrics.eligible_total,
      active_production_total: activeProductionTotal,
      proposed_inserts: proposedInserts.length,
      proposed_updates: proposedUpdates.length,
      unchanged: unchanged.length,
      recognised_existing_eligible: reconciliation.recognised_existing_eligible,
      outstanding_eligible_inserts: reconciliation.outstanding_eligible_inserts,
      source_absent_active: sourceAbsent.length,
      source_absent_sailing_ids: sourceAbsent.map((r) => r.official_sailing_id),
      source_absent_observed: sourceAbsencePolicy.source_absent_observed,
      source_absent_actionable: sourceAbsencePolicy.source_absent_actionable,
      source_absent_retained: sourceAbsencePolicy.source_absent_retained,
      source_absence_policy: sourceAbsencePolicy,
      source_absent_observed_records: sourceAbsencePolicy.source_absent_observed_records,
      source_absent_actionable_records: sourceAbsencePolicy.source_absent_actionable_records,
      reconciliation_arithmetic_ok: reconciliation.reconciliation_arithmetic_ok,
      active_production_arithmetic_ok: reconciliation.active_production_arithmetic_ok,
      all_active_recognised_in_eligible_source: reconciliation.all_active_recognised_in_eligible_source,
      policy_excluded_cruisetours: waterfall.waterfall?.policy_excluded_cruisetour || 0,
      within_public_cutoff_excluded: withinPublicCutoff.length,
      public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
      eligibility_waterfall: waterfall.waterfall,
      resolution_rates: metrics,
      source_quality_gate: sourceQualityGate,
      quality_gate: qualityGate,
      snapshot_id: snapshotId,
      inventory_changed: false,
      writes_performed: 0
    };

    if (!qualityGate.passed) {
      return { ok: false, blocked: true, failed: true, reason: qualityGate.failures.join("; "), summary, simulation };
    }

    if (!reconciliation.reconciliation_arithmetic_ok) {
      return {
        ok: false,
        blocked: false,
        failed: true,
        reason: "reconciliation_arithmetic_failed",
        summary,
        simulation
      };
    }

    if (!reconciliation.active_production_arithmetic_ok) {
      return {
        ok: false,
        blocked: false,
        failed: true,
        reason: "active_production_arithmetic_failed",
        summary,
        simulation
      };
    }

    if (explicitDryRun || !performWrites) {
      return { ok: true, dry_run: true, summary, manifest, simulation };
    }

    const isWeeklyMaintenanceWrite =
      (context.writeMode || context.write_mode || "weekly_maintenance") === "weekly_maintenance";
    const combinedProposed = proposedInserts.length + proposedUpdates.length;
    const effectiveMaxWrites = isWeeklyMaintenanceWrite
      ? Math.min(maxWrites, SEABOURN_MAX_WEEKLY_WRITES)
      : maxWrites;
    summary.effective_max_writes = effectiveMaxWrites;

    if (isWeeklyMaintenanceWrite && combinedProposed > SEABOURN_MAX_WEEKLY_WRITES) {
      return {
        ok: false,
        blocked: false,
        failed: true,
        reason: WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP,
        summary: {
          ...summary,
          weekly_write_cap: SEABOURN_MAX_WEEKLY_WRITES,
          combined_proposed_changes: combinedProposed,
          proposed_inserts: proposedInserts.length,
          proposed_updates: proposedUpdates.length
        },
        simulation
      };
    }

    if (combinedProposed === 0) {
      summary.inserts = 0;
      summary.updates = 0;
      summary.failed_writes = 0;
      summary.write_attempts = 0;
      summary.duplicate_skips = unchanged.length;
      summary.inventory_changed = false;
      summary.zero_change_apply = true;
      return { ok: true, dry_run: false, zero_change_apply: true, summary, manifest, simulation };
    }

    const lockKey = weeklyLockKey(lineSlug);
    const lockOwnership = await verifyMaintenanceLockOwnership(sb, { lockKey, ownerId: runId });
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

    const writeProducts = productionEligible
      .filter((row) => {
        const entry = manifest.products.find(
          (p) => p.stable_identity_key === seabournOfficialProductKey(row.raw)
        );
        return entry && ["insert_active", "update_exact_legacy_match"].includes(entry.proposed_action);
      })
      .sort((a, b) => {
        const ka = seabournOfficialProductKey(a.raw) || "";
        const kb = seabournOfficialProductKey(b.raw) || "";
        return ka.localeCompare(kb);
      });

    const writeResult = await applySeabournBatchWrites({
      products: writeProducts.slice(0, effectiveMaxWrites),
      cruiseLine: line,
      maxWrites: effectiveMaxWrites,
      runId,
      supabase: sb,
      destinations,
      performWrites: true,
      maintenanceTrace: {
        run_id: runId,
        run_record_id: runRecordId,
        cruise_line_id: line.id,
        cruise_line_slug: lineSlug,
        trigger_type: context.triggerType || context.trigger_type || "scheduled"
      }
    });

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
    summary.duplicate_skips = writeResult.stats?.duplicate_skips || 0;
    summary.failed_writes = writeResult.stats?.failed || 0;
    summary.write_attempts =
      (writeResult.stats?.inserted || 0) +
      (writeResult.stats?.updated || 0) +
      (writeResult.stats?.failed || 0) +
      (writeResult.stats?.duplicate_skips || 0);
    summary.inventory_changed = (summary.inserts || 0) + (summary.updates || 0) > 0;
    summary.writes_performed = summary.inventory_changed ? summary.inserts + summary.updates : 0;
    summary.rollback_manifest_id = rollback?.manifest_record_id || null;

    return {
      ok: writeResult.stats?.failed === 0,
      summary,
      write_result: writeResult,
      manifest,
      rollback_result: rollback || null,
      rollback_manifest: rollback?.manifest || null
    };
  } finally {
    await releaseMaintenanceLock(sb, lineSlug, runId);
  }
}

module.exports = {
  runHalWeeklyMaintenance,
  runCelebrityWeeklyMaintenance,
  runPrincessWeeklyMaintenance,
  runExploraWeeklyMaintenance,
  runSeabournWeeklyMaintenance,
  acquireMaintenanceLock,
  releaseMaintenanceLock,
  evaluateMaintenanceQualityGate,
  evaluateSeabournSourceQualityGate,
  computeExploraResolutionRates,
  computeSeabournResolutionRates,
  findSourceAbsentActive,
  MAX_WRITES_PER_BATCH,
  MAX_WEEKLY_WRITES,
  EXPLORA_MAX_WEEKLY_WRITES,
  SEABOURN_MAX_WEEKLY_WRITES,
  WEEKLY_CHANGE_VOLUME_EXCEEDS_CAP
};
