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
const APPLY_CONFIRMATION_TOKEN = "DISNEY-FIRST-CONTROLLED-BATCH";
const PHASE2D_OBSOLETE_HASH = "29eec188212e19502c910f02987d00b2be8b6478a9d12f9ea237aa347b6a548d";
const MANIFEST_MODE = "disney_phase3_first_controlled_freeze";

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
  "seabourn",
  "norwegian-cruise-line",
  "royal-caribbean-international",
  "carnival-cruise-line"
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
  APPLY_CONFIRMATION_TOKEN,
  PHASE2D_OBSOLETE_HASH,
  MANIFEST_MODE,
  DISNEY_LEGACY_ROW_IDS,
  SENTINEL_LINE_SLUGS,
  rejectObsoletePhase2dHash,
  isFirstBatchEligible,
  selectFrozenBatchProducts,
  buildFreezeEntry,
  buildPhase3FreezeReport,
  loadFrozenReport,
  validateFrozenManifest,
  validateSelectedAgainstFreshSource,
  evaluatePreWriteGate,
  verifyCountReconciliation,
  snapshotLegacyRows,
  verifyLegacyImmutability
};
