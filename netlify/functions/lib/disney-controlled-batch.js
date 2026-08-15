/**
 * Disney Cruise Line — Phase 3 controlled first-batch selection, freeze, and gates.
 */

const {
  ADAPTER_ID,
  ADAPTER_VERSION,
  DISNEY_LINE_ID,
  disneyExternalKey,
  buildDisneyUpsertCandidate
} = require("./disney-discovery-adapter");
const { hashFrozenBatchCandidates } = require("./disney-endpoint-evidence");
const { cruiseIdentityKey } = require("./cruise-discovery-ops");
const { daysUntilDeparture, PUBLIC_BOOKING_CUTOFF_DAYS } = require("./public-discovered-cruise-inventory");

const DISNEY_LINE_SLUG = "disney-cruise-line";
const MAX_CONTROLLED_DISNEY_BATCH = 20;
const MAX_CATCHUP_DISNEY_BATCH = 100;
const APPLY_CONFIRMATION_TOKEN = "DISNEY-FIRST-CONTROLLED-BATCH";
const CATCHUP_CONFIRMATION_TOKEN = "DISNEY-CONTROLLED-CATCHUP";
const PHASE2D_OBSOLETE_HASH = "29eec188212e19502c910f02987d00b2be8b6478a9d12f9ea237aa347b6a548d";
const MANIFEST_MODE = "disney_phase3_first_controlled_freeze";
const CATCHUP_MANIFEST_MODE = "disney_phase4a_catchup_freeze";

const DISNEY_LEGACY_ROW_IDS = Object.freeze([
  "88adb900-0aed-4a21-bdf6-fd5bc65b1348",
  "ac4ff6fc-dae5-47fa-9708-62ea1ebd5542",
  "5a2a9a59-ee1d-410d-bc47-4747757e08d0",
  "d5fb2cfe-cc46-4138-a21a-04fd5777dc64",
  "342e0a91-899b-457c-b9d7-4acd8e9e56ae",
  "04a3bf11-7c10-462e-83b6-63f2a5d5044d"
]);

const SENTINEL_LINE_SLUGS = Object.freeze([
  "princess-cruises",
  "celebrity-cruises",
  "holland-america-line",
  "seabourn-cruise-line",
  "norwegian-cruise-line",
  "royal-caribbean-international",
  "carnival-cruise-line",
  "silversea-cruises"
]);

function rejectObsoletePhase2dHash(hash) {
  return hash === PHASE2D_OBSOLETE_HASH;
}

function isFirstBatchEligible(row, today, existingByOfficialId = new Map()) {
  if (!row?.eligibility?.production_eligible) return false;
  const productKey = row.official_sailing_id;
  if (!productKey) return false;
  if (existingByOfficialId.has(String(productKey).toUpperCase())) return false;

  const days =
    row.days_until_departure != null
      ? row.days_until_departure
      : daysUntilDeparture(row.candidate?.departure_date, today);
  if (days == null || days <= PUBLIC_BOOKING_CUTOFF_DAYS) return false;

  const dep = row.candidate?.departure_port_meta;
  const arr = row.candidate?.arrival_port_meta;
  if (dep?.status !== "resolved" || (dep.unresolved_conflicts || []).length) return false;
  if (row.raw?.one_way_itinerary === true) {
    if (arr?.status !== "resolved" || (arr.unresolved_conflicts || []).length) return false;
  }
  if (!row.ship_resolution?.resolved) return false;
  if (row.destination_resolution?.status !== "resolved") return false;
  if (row.duration_validation?.exact_match !== true) return false;
  return true;
}

function selectFrozenBatchProducts(normalisedRows, frozenIds, { today, existingByOfficialId = new Map() } = {}) {
  const byId = new Map((normalisedRows || []).map((r) => [r.official_sailing_id, r]));
  const selected = [];
  const missing = [];
  const noLongerEligible = [];

  for (const id of frozenIds || []) {
    const row = byId.get(id);
    if (!row) {
      missing.push(id);
      continue;
    }
    if (!isFirstBatchEligible(row, today, existingByOfficialId)) {
      noLongerEligible.push(id);
      continue;
    }
    selected.push(row);
  }

  return {
    selected,
    selected_ids: selected.map((r) => r.official_sailing_id),
    missing,
    no_longer_eligible: noLongerEligible,
    frozen_still_eligible: selected.length === (frozenIds || []).length
  };
}

function buildFreezeEntry(row, cruiseLine) {
  const productKey = row.official_sailing_id;
  const candidate = row.candidate || {};
  const depMeta = candidate.departure_port_meta || {};
  const arrMeta = candidate.arrival_port_meta || {};
  const endpointMethod = [depMeta.embark_method || depMeta.evidence_method, arrMeta.method]
    .filter(Boolean)
    .join(" / ");

  return {
    official_sailing_id: productKey,
    raw_sailing_id: row.raw?.sailing_id || null,
    ship_id: candidate.ship_id,
    ship_name: row.raw?.ship_name || null,
    departure_date: candidate.departure_date,
    return_date: candidate.return_date,
    nights: candidate.nights,
    departure_port: candidate.departure_port,
    arrival_port: candidate.arrival_port || null,
    destination_id: candidate.destination_id,
    destination_key: candidate.destination_key || null,
    official_url: candidate.official_url,
    source_url: candidate.source_url,
    external_key: disneyExternalKey(cruiseLine.id, productKey),
    identity_key: cruiseIdentityKey({
      cruiseLineId: cruiseLine.id,
      shipId: candidate.ship_id,
      departureDate: candidate.departure_date,
      officialUrl: candidate.official_url,
      nights: candidate.nights,
      returnDate: candidate.return_date,
      officialSailingId: productKey
    }),
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    endpoint_evidence_method: endpointMethod,
    endpoint_unresolved_conflict_count:
      (depMeta.unresolved_conflicts || []).length + (arrMeta.unresolved_conflicts || []).length,
    proposed_action: "insert_active"
  };
}

function buildPhase3FreezeReport({
  simulation,
  cruiseLine,
  today,
  sourceSnapshotTotal,
  sourceComplete
}) {
  const batch = simulation.first_controlled_batch;
  const entries = (batch.entries || []).map((entry) => {
    const row = simulation.products.find((r) => r.official_sailing_id === entry.official_product_key);
    return row ? buildFreezeEntry(row, cruiseLine) : { ...entry, official_sailing_id: entry.official_product_key };
  });

  const frozen_candidate_hash = hashFrozenBatchCandidates(
    entries.map((e) => ({
      official_product_key: e.official_sailing_id,
      ship_id: e.ship_id,
      departure_date: e.departure_date,
      return_date: e.return_date,
      nights: e.nights,
      departure_port: e.departure_port,
      arrival_port: e.arrival_port,
      destination_id: e.destination_id,
      identity_key: e.identity_key,
      external_key: e.external_key
    })),
    ADAPTER_VERSION
  );

  return {
    mode: MANIFEST_MODE,
    freeze_generated_at: new Date().toISOString(),
    freeze_source_snapshot_total: sourceSnapshotTotal,
    freeze_source_complete: sourceComplete === true,
    current_perth_date: today,
    batch_size: MAX_CONTROLLED_DISNEY_BATCH,
    strategy: "insert_only",
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    invalidates_phase2d_batch: true,
    phase2d_obsolete_hash: PHASE2D_OBSOLETE_HASH,
    frozen_candidate_hash,
    frozen_identities: entries.map((e) => e.official_sailing_id),
    entries
  };
}

function loadFrozenReport(report) {
  if (!report || typeof report !== "object") throw new Error("invalid_frozen_report");
  if (rejectObsoletePhase2dHash(report.frozen_candidate_hash)) {
    throw new Error("phase2d_obsolete_hash_rejected");
  }
  return report;
}

function validateFrozenManifest(report, options = {}) {
  const failures = [];
  const expectedCount = options.expectedCount ?? MAX_CONTROLLED_DISNEY_BATCH;
  const entries = report?.entries || [];

  if (report?.mode !== MANIFEST_MODE) failures.push("invalid_manifest_mode");
  if (entries.length !== expectedCount) failures.push(`expected_${expectedCount}_entries:${entries.length}`);
  if (Number(report?.batch_size) !== MAX_CONTROLLED_DISNEY_BATCH) failures.push("batch_size_not_20");
  if (report?.strategy !== "insert_only") failures.push("strategy_not_insert_only");
  if (rejectObsoletePhase2dHash(report?.frozen_candidate_hash)) failures.push("phase2d_obsolete_hash");

  const recomputed = hashFrozenBatchCandidates(
    entries.map((e) => ({
      official_product_key: e.official_sailing_id,
      ship_id: e.ship_id,
      departure_date: e.departure_date,
      return_date: e.return_date,
      nights: e.nights,
      departure_port: e.departure_port,
      arrival_port: e.arrival_port,
      destination_id: e.destination_id,
      identity_key: e.identity_key,
      external_key: e.external_key
    })),
    report.adapter_version || ADAPTER_VERSION
  );
  if (report.frozen_candidate_hash !== recomputed) failures.push("frozen_candidate_hash_mismatch");

  const ids = entries.map((e) => e.official_sailing_id).filter(Boolean);
  if (new Set(ids).size !== ids.length) failures.push("duplicate_official_sailing_ids");

  return { ok: failures.length === 0, failures, entries, expectedCount, recomputed_hash: recomputed };
}

function validateSelectedAgainstFreshSource(selectedIds, productsByKey, frozenEntries, adapterVersion, cruiseLine) {
  const failures = [];
  const freshEntries = [];

  for (const id of selectedIds || []) {
    const live = productsByKey.get(id);
    if (!live) {
      failures.push({ official_sailing_id: id, issue: "missing_from_live_source" });
      continue;
    }
    if (!live.eligibility?.production_eligible) {
      failures.push({ official_sailing_id: id, issue: "no_longer_production_eligible" });
    }
    freshEntries.push(buildFreezeEntry(live, cruiseLine));
  }

  const freshHash = hashFrozenBatchCandidates(
    freshEntries.map((e) => ({
      official_product_key: e.official_sailing_id,
      ship_id: e.ship_id,
      departure_date: e.departure_date,
      return_date: e.return_date,
      nights: e.nights,
      departure_port: e.departure_port,
      arrival_port: e.arrival_port,
      destination_id: e.destination_id,
      identity_key: e.identity_key,
      external_key: e.external_key
    })),
    adapterVersion
  );

  const frozenHash = hashFrozenBatchCandidates(
    (frozenEntries || []).map((e) => ({
      official_product_key: e.official_sailing_id,
      ship_id: e.ship_id,
      departure_date: e.departure_date,
      return_date: e.return_date,
      nights: e.nights,
      departure_port: e.departure_port,
      arrival_port: e.arrival_port,
      destination_id: e.destination_id,
      identity_key: e.identity_key,
      external_key: e.external_key
    })),
    adapterVersion
  );

  if (freshHash !== frozenHash) {
    failures.push({ issue: "candidate_hash_mismatch", fresh_hash: freshHash, frozen_hash: frozenHash });
  }

  return { ok: failures.length === 0, failures, fresh_hash: freshHash, frozen_hash: frozenHash };
}

function isCatchupEligible(row, today, existingByOfficialId = new Map()) {
  return isFirstBatchEligible(row, today, existingByOfficialId);
}

function catchupSortKey(row) {
  const dep = row.candidate?.departure_date || row.raw?.departure_date || "";
  const id = row.official_sailing_id || "";
  return `${dep}|${id}`;
}

function selectCatchupBatchProducts(normalisedRows, manifest = [], context = {}) {
  const maxSize = context.maxSize ?? MAX_CATCHUP_DISNEY_BATCH;
  const today = context.today;
  const existingByOfficialId = context.existingByOfficialId || new Map();
  const excludeOfficialIds = context.excludeOfficialIds || new Set();

  const eligible = (manifest || [])
    .filter((m) => m.action === "insert_active")
    .map((m) => ({ manifest: m, row: (normalisedRows || []).find((r) => r.official_sailing_id === m.official_product_key) }))
    .filter((e) => e.row && isCatchupEligible(e.row, today, existingByOfficialId))
    .filter((e) => !excludeOfficialIds.has(e.row.official_sailing_id))
    .sort((a, b) => catchupSortKey(a.row).localeCompare(catchupSortKey(b.row)));

  const selected = eligible.slice(0, maxSize).map((e) => e.row);
  return {
    eligible_total: eligible.length,
    selected,
    selected_ids: selected.map((r) => r.official_sailing_id),
    max_size: maxSize
  };
}

function buildCatchupFreezeReport({
  simulation,
  cruiseLine,
  today,
  batchNumber = 1,
  excludeOfficialIds = new Set(),
  maxSize = MAX_CATCHUP_DISNEY_BATCH,
  existingByOfficialId = new Map()
}) {
  const selection = selectCatchupBatchProducts(simulation.products, simulation.write_manifest?.manifest || [], {
    maxSize,
    today,
    existingByOfficialId,
    excludeOfficialIds
  });

  const entries = selection.selected.map((row) => buildFreezeEntry(row, cruiseLine));
  const frozen_candidate_hash = hashFrozenBatchCandidates(
    entries.map((e) => ({
      official_product_key: e.official_sailing_id,
      ship_id: e.ship_id,
      departure_date: e.departure_date,
      return_date: e.return_date,
      nights: e.nights,
      departure_port: e.departure_port,
      arrival_port: e.arrival_port,
      destination_id: e.destination_id,
      identity_key: e.identity_key,
      external_key: e.external_key
    })),
    ADAPTER_VERSION
  );

  return {
    mode: CATCHUP_MANIFEST_MODE,
    batch_number: batchNumber,
    batch_size: maxSize,
    strategy: "insert_only",
    generated_at: new Date().toISOString(),
    current_perth_date: today,
    source_snapshot_total: simulation.source_unique_sailings,
    source_complete: simulation.quality_gate?.source_complete === true,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    frozen_candidate_hash,
    frozen_identities: entries.map((e) => e.official_sailing_id),
    entries,
    selection_meta: {
      eligible_total: selection.eligible_total,
      selected_count: entries.length
    }
  };
}

function evaluateCatchupPreWriteGate(params = {}) {
  const expected = params.expectedCount ?? MAX_CATCHUP_DISNEY_BATCH;
  const failures = [];
  if (!params.sourceComplete) failures.push("source_incomplete");
  if ((params.identityCollisions || 0) > 0) failures.push("identity_collisions");
  if ((params.endpointUnresolvedConflicts || 0) > 0) failures.push("endpoint_unresolved_conflicts");
  if (!params.eligibilityArithmeticPass) failures.push("eligibility_arithmetic");
  if (!params.oneWayNativeParsePass) failures.push("one_way_native_parse");
  if (!params.legacyBaselineOk) failures.push("legacy_baseline_changed");
  if (!params.phase3TwentyVerified) failures.push("phase3_twenty_not_verified");
  if ((params.selectedCount || 0) !== expected) failures.push(`selected_count_not_${expected}`);
  if ((params.existingSelectedOfficialIds || 0) > 0) failures.push("selected_already_in_production");
  if ((params.externalKeyCollisions || 0) > 0) failures.push("external_key_collisions");
  if ((params.identityKeyCollisions || 0) > 0) failures.push("identity_key_collisions");
  if (params.hashMismatch) failures.push("candidate_hash_mismatch");
  if (!params.lockSmokePassed) failures.push("lock_smoke_failed");
  if (!params.phase3RollbackOk) failures.push("phase3_rollback_manifest_missing");
  return { passed: failures.length === 0, failures, reason: failures[0] || null, expectedCount: expected };
}

function verifyCatchupCountReconciliation(before, after, writeResult) {
  const inserted = writeResult?.inserted || 0;
  const disneyTotalDelta = (after.disney_total || 0) - (before.disney_total || 0);
  const disneyActiveDelta = (after.disney_active || 0) - (before.disney_active || 0);
  const globalDelta = (after.global_total || 0) - (before.global_total || 0);
  const sentinelOk = (before.sentinel_active || []).every((row) => {
    const afterRow = (after.sentinel_active || []).find((r) => r.slug === row.slug);
    return afterRow && afterRow.active === row.active;
  });
  return {
    passed: disneyTotalDelta === inserted && disneyActiveDelta === inserted && globalDelta === inserted,
    disney_total_delta: disneyTotalDelta,
    disney_active_delta: disneyActiveDelta,
    global_total_delta: globalDelta,
    actual_inserted: inserted,
    sentinel_unchanged: sentinelOk,
    sentinel_external_change_detected: !sentinelOk
  };
}

function snapshotPhase3Rows(rows = [], phase3OfficialIds = []) {
  const idSet = new Set(phase3OfficialIds);
  return (rows || [])
    .filter((r) => idSet.has(r.official_sailing_id))
    .map((r) => ({
      id: r.id,
      status: r.status,
      ship_id: r.ship_id,
      destination_id: r.destination_id,
      departure_date: r.departure_date,
      return_date: r.return_date,
      nights: r.nights,
      departure_port: r.departure_port,
      official_sailing_id: r.official_sailing_id,
      identity_key: r.identity_key,
      external_key: r.external_key,
      official_url: r.official_url,
      source_url: r.source_url,
      raw_extract: r.raw_extract
    }));
}

function verifyPhase3TwentyImmutability(beforeSnapshot, afterRows) {
  const afterById = new Map((afterRows || []).map((r) => [r.id, r]));
  const comparisons = [];
  let unchanged = 0;

  for (const before of beforeSnapshot || []) {
    const after = afterById.get(before.id);
    if (!after) {
      comparisons.push({ id: before.id, unchanged: false, reason: "row_missing" });
      continue;
    }
    const fields = [
      "status",
      "ship_id",
      "destination_id",
      "departure_date",
      "return_date",
      "nights",
      "departure_port",
      "official_sailing_id",
      "identity_key",
      "external_key",
      "official_url",
      "source_url"
    ];
    const diffs = fields.filter((f) => String(before[f] ?? "") !== String(after[f] ?? ""));
    const rawSame = JSON.stringify(before.raw_extract || {}) === JSON.stringify(after.raw_extract || {});
    const ok = diffs.length === 0 && rawSame;
    if (ok) unchanged += 1;
    comparisons.push({ id: before.id, unchanged: ok, changed_fields: diffs, raw_extract_changed: !rawSame });
  }

  const expected = (beforeSnapshot || []).length;
  return {
    passed: unchanged === expected && expected > 0,
    unchanged_count: unchanged,
    expected,
    comparisons
  };
}

async function buildPartialWriteRecoveryReport({
  supabase,
  cruiseLineId,
  frozenOfficialIds = [],
  existingBeforeIds = new Set(),
  writeStats = {},
  error = null
}) {
  const quoted = frozenOfficialIds.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",");
  const rows = quoted.length
    ? await supabase(
        `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
          cruiseLineId
        )}&official_sailing_id=in.(${quoted})&select=id,official_sailing_id,status,created_at`
      )
    : [];

  const byOfficial = new Map((rows || []).map((r) => [r.official_sailing_id, r]));
  const perIdentity = frozenOfficialIds.map((officialId) => {
    const row = byOfficial.get(officialId) || null;
    const existedBefore = row?.id && existingBeforeIds.has(row.id);
    const insertedThisRun = row?.id && !existingBeforeIds.has(row.id);
    return {
      official_sailing_id: officialId,
      exists: Boolean(row),
      discovered_cruise_id: row?.id || null,
      existed_before: existedBefore,
      inserted_this_run: insertedThisRun,
      not_inserted: !row
    };
  });

  return {
    partial_write: true,
    error: error?.message || String(error || ""),
    attempted: writeStats.attempted || 0,
    inserted: writeStats.inserted || 0,
    failed: writeStats.failed || 0,
    per_identity: perIdentity,
    inserted_this_run_ids: perIdentity.filter((p) => p.inserted_this_run).map((p) => p.discovered_cruise_id),
    inserted_this_run_official_ids: perIdentity.filter((p) => p.inserted_this_run).map((p) => p.official_sailing_id)
  };
}

function validateCatchupFrozenManifest(report, options = {}) {
  const expectedCount = options.expectedCount ?? MAX_CATCHUP_DISNEY_BATCH;
  const failures = [];
  const entries = report?.entries || [];
  if (report?.mode !== CATCHUP_MANIFEST_MODE) failures.push("invalid_manifest_mode");
  if (entries.length !== expectedCount) failures.push(`expected_${expectedCount}_entries:${entries.length}`);
  if (Number(report?.batch_size) !== expectedCount) failures.push("batch_size_mismatch");
  if (report?.strategy !== "insert_only") failures.push("strategy_not_insert_only");
  const recomputed = hashFrozenBatchCandidates(
    entries.map((e) => ({
      official_product_key: e.official_sailing_id,
      ship_id: e.ship_id,
      departure_date: e.departure_date,
      return_date: e.return_date,
      nights: e.nights,
      departure_port: e.departure_port,
      arrival_port: e.arrival_port,
      destination_id: e.destination_id,
      identity_key: e.identity_key,
      external_key: e.external_key
    })),
    report.adapter_version || ADAPTER_VERSION
  );
  if (report.frozen_candidate_hash !== recomputed) failures.push("frozen_candidate_hash_mismatch");
  return { ok: failures.length === 0, failures, entries, expectedCount, recomputed_hash: recomputed };
}

function loadCatchupFrozenReport(report) {
  if (!report || typeof report !== "object") throw new Error("invalid_catchup_frozen_report");
  return report;
}

function analysePhase3LockAnomaly() {
  return {
    exact_error: "global_production_import_lock_unavailable: maintenance_lock_owner_mismatch",
    reconstructed_origin:
      "assertGlobalCruiseWriteLockHeld inside upsertCandidateRecord during Phase 3 first apply; original stack trace not preserved",
    first_apply_path:
      "executeControlledProductionApply -> applyDisneyBatchWrites (nested ensureGlobalCruiseWriteLockForMutation) before Phase 3 post-apply hardening",
    second_apply_path: "pre-write gate blocked on idempotency collisions after 20 rows already existed",
    lock_key: "controlled_production_import:global",
    root_cause:
      "Nested global-lock path could release ownership while writes/post-write work still assumed lock held; ALS ownerId was not re-verified on nested reuse; apply used nested writer instead of applyDisneyBatchWritesBody",
    fix_applied: [
      "resolveGlobalLockOwnerId for acquire/context/release",
      "ensureGlobalCruiseWriteLockForMutation verifies ownership when ALS context exists",
      "Disney apply uses applyDisneyBatchWritesBody inside executeControlledProductionApply only",
      "explicit globalWriteLockOwnerId on upsertCandidateRecord",
      "runGlobalLockSmokeTest helper",
      "partial-write recovery report builder"
    ],
    unresolved_questions: [
      "Original stack trace from first apply terminal output was not archived; exact upsert index at failure cannot be proven"
    ],
    writes_committed_despite_error: true,
    all_twenty_verified_in_production: true
  };
}

async function findPhase3RollbackManifest(supabase, phase3InsertedIds = []) {
  const { MANIFEST_TABLE } = require("./cruise-discovery-maintenance-manifests");
  const rows =
    (await supabase(
      `${MANIFEST_TABLE}?cruise_line_slug=eq.disney-cruise-line&manifest_type=eq.rollback&select=id,run_id,manifest,created_at&order=created_at.desc`
    )) || [];
  for (const row of rows) {
    const inserted = row.manifest?.inserted || [];
    const ids = inserted.map((e) => e.discovered_cruise_id).filter(Boolean);
    if (ids.length === 20 && phase3InsertedIds.every((id) => ids.includes(id))) {
      return { existed: true, manifest_record_id: row.id, run_id: row.run_id, inserted_count: ids.length, manifest: row.manifest };
    }
    if (inserted.length === 20 && row.run_id?.includes("disney-phase3")) {
      return { existed: true, manifest_record_id: row.id, run_id: row.run_id, inserted_count: inserted.length, manifest: row.manifest };
    }
  }
  return { existed: false, manifest_record_id: null, inserted_count: 0 };
}

async function recoverPhase3RollbackManifestIfMissing(supabase, { cruiseLineId, phase3InsertedRows = [], runId = "disney-phase3-recovery" }) {
  const lookup = await findPhase3RollbackManifest(
    supabase,
    phase3InsertedRows.map((r) => r.id)
  );
  if (lookup.existed) return { ...lookup, recovered: false };

  const { persistMaintenanceManifest } = require("./cruise-discovery-maintenance-manifests");
  const manifest = {
    run_id: runId,
    cruise_line_id: cruiseLineId,
    cruise_line_slug: DISNEY_LINE_SLUG,
    trigger_type: "disney_phase3_recovery",
    created_at: new Date().toISOString(),
    recovered_from_verified_phase3_postwrite_state: true,
    recovery_reason: "Phase 3 apply reported lock anomaly; verified 20 production rows and persisted audit rollback if missing",
    inserted: phase3InsertedRows.map((r) => ({
      discovered_cruise_id: r.id,
      official_sailing_id: r.official_sailing_id,
      action: "insert"
    })),
    inserted_record_ids: phase3InsertedRows.map((r) => r.id),
    official_sailing_ids: phase3InsertedRows.map((r) => r.official_sailing_id)
  };
  const row = await persistMaintenanceManifest(supabase, { manifestType: "rollback", manifest });
  return {
    existed: false,
    recovered: true,
    manifest_record_id: row?.id || null,
    inserted_count: phase3InsertedRows.length,
    manifest
  };
}

function evaluatePreWriteGate(params = {}) {
  const failures = [];
  if (!params.sourceComplete) failures.push("source_incomplete");
  if ((params.identityCollisions || 0) > 0) failures.push("identity_collisions");
  if ((params.endpointUnresolvedConflicts || 0) > 0) failures.push("endpoint_unresolved_conflicts");
  if (!params.eligibilityArithmeticPass) failures.push("eligibility_arithmetic");
  if (!params.oneWayNativeParsePass) failures.push("one_way_native_parse");
  if (!params.legacyBaselineOk) failures.push("legacy_baseline_changed");
  if ((params.selectedCount || 0) !== MAX_CONTROLLED_DISNEY_BATCH) failures.push("selected_count_not_20");
  if ((params.existingSelectedOfficialIds || 0) > 0) failures.push("selected_already_in_production");
  if ((params.externalKeyCollisions || 0) > 0) failures.push("external_key_collisions");
  if ((params.identityKeyCollisions || 0) > 0) failures.push("identity_key_collisions");
  if (params.hashMismatch) failures.push("candidate_hash_mismatch");
  if (params.phase2dHashRejected) failures.push("phase2d_hash_rejected");

  return {
    passed: failures.length === 0,
    failures,
    reason: failures[0] || null
  };
}

function verifyCountReconciliation(before, after, writeResult) {
  const disneyTotalDelta = (after.disney_total || 0) - (before.disney_total || 0);
  const disneyActiveDelta = (after.disney_active || 0) - (before.disney_active || 0);
  const globalDelta = (after.global_total || 0) - (before.global_total || 0);
  const inserted = writeResult?.inserted || 0;

  const sentinelOk = (before.sentinel_active || []).every((row) => {
    const afterRow = (after.sentinel_active || []).find((r) => r.slug === row.slug);
    return afterRow && afterRow.active === row.active;
  });

  return {
    passed:
      disneyTotalDelta === inserted &&
      disneyActiveDelta === inserted &&
      globalDelta === inserted &&
      inserted === MAX_CONTROLLED_DISNEY_BATCH &&
      sentinelOk,
    disney_total_delta: disneyTotalDelta,
    disney_active_delta: disneyActiveDelta,
    global_total_delta: globalDelta,
    expected_inserted: MAX_CONTROLLED_DISNEY_BATCH,
    actual_inserted: inserted,
    sentinel_unchanged: sentinelOk
  };
}

function snapshotLegacyRows(rows = []) {
  const legacySet = new Set(DISNEY_LEGACY_ROW_IDS);
  return (rows || [])
    .filter((r) => legacySet.has(r.id))
    .map((r) => ({
      id: r.id,
      status: r.status,
      ship_id: r.ship_id,
      destination_id: r.destination_id,
      departure_date: r.departure_date,
      return_date: r.return_date,
      nights: r.nights,
      departure_port: r.departure_port,
      official_sailing_id: r.official_sailing_id,
      identity_key: r.identity_key,
      external_key: r.external_key,
      official_url: r.official_url,
      source_url: r.source_url,
      raw_extract: r.raw_extract
    }));
}

function verifyLegacyImmutability(beforeSnapshot, afterRows) {
  const afterById = new Map((afterRows || []).map((r) => [r.id, r]));
  const comparisons = [];
  let unchanged = 0;

  for (const before of beforeSnapshot || []) {
    const after = afterById.get(before.id);
    if (!after) {
      comparisons.push({ id: before.id, unchanged: false, reason: "row_missing" });
      continue;
    }
    const fields = [
      "status",
      "ship_id",
      "destination_id",
      "departure_date",
      "return_date",
      "nights",
      "departure_port",
      "official_sailing_id",
      "identity_key",
      "external_key",
      "official_url",
      "source_url"
    ];
    const diffs = fields.filter((f) => String(before[f] ?? "") !== String(after[f] ?? ""));
    const rawSame = JSON.stringify(before.raw_extract || {}) === JSON.stringify(after.raw_extract || {});
    const ok = diffs.length === 0 && rawSame;
    if (ok) unchanged += 1;
    comparisons.push({ id: before.id, unchanged: ok, changed_fields: diffs, raw_extract_changed: !rawSame });
  }

  return {
    passed: unchanged === (beforeSnapshot || []).length && unchanged === DISNEY_LEGACY_ROW_IDS.length,
    unchanged_count: unchanged,
    expected: DISNEY_LEGACY_ROW_IDS.length,
    comparisons
  };
}

module.exports = {
  DISNEY_LINE_ID,
  DISNEY_LINE_SLUG,
  MAX_CONTROLLED_DISNEY_BATCH,
  MAX_CATCHUP_DISNEY_BATCH,
  APPLY_CONFIRMATION_TOKEN,
  CATCHUP_CONFIRMATION_TOKEN,
  PHASE2D_OBSOLETE_HASH,
  MANIFEST_MODE,
  CATCHUP_MANIFEST_MODE,
  DISNEY_LEGACY_ROW_IDS,
  SENTINEL_LINE_SLUGS,
  rejectObsoletePhase2dHash,
  isFirstBatchEligible,
  isCatchupEligible,
  selectFrozenBatchProducts,
  selectCatchupBatchProducts,
  buildFreezeEntry,
  buildPhase3FreezeReport,
  buildCatchupFreezeReport,
  loadFrozenReport,
  loadCatchupFrozenReport,
  validateFrozenManifest,
  validateCatchupFrozenManifest,
  validateSelectedAgainstFreshSource,
  evaluatePreWriteGate,
  evaluateCatchupPreWriteGate,
  verifyCountReconciliation,
  verifyCatchupCountReconciliation,
  snapshotLegacyRows,
  snapshotPhase3Rows,
  verifyLegacyImmutability,
  verifyPhase3TwentyImmutability,
  buildPartialWriteRecoveryReport,
  analysePhase3LockAnomaly,
  findPhase3RollbackManifest,
  recoverPhase3RollbackManifestIfMissing
};
