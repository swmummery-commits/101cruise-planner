/**
 * Silversea Expedition — controlled production batch (Phase E3).
 * Insert-only; uses expedition E2a semantic + eligibility pipeline.
 */

const crypto = require("crypto");
const { officialProductKey } = require("./silversea-discovery-adapter");
const {
  PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE,
  daysUntilDeparture
} = require("./public-discovered-cruise-inventory");
const {
  EXPEDITION_EXCLUSIVE_BUCKETS,
  classifyExpeditionExclusiveBucket,
  evaluateExpeditionEligibility,
  analyseExpeditionItineraryStops,
  isComboSegmentProduct
} = require("./silversea-expedition-eligibility");
const { isExpeditionEndpointResolved } = require("./silversea-expedition-endpoint-resolution");
const { MAX_CONTROLLED_BATCH } = require("./silversea-controlled-batch");
const { SEMANTIC_CONFIDENCE, EXPEDITION_SEMANTIC } = require("./silversea-expedition-semantics");

const EXPEDITION_FIRST_BATCH_MODE = "silversea_expedition_e3_first_250";
const EXPEDITION_APPLY_CONFIRMATION_TOKEN = "SILVERSEA-EXPEDITION-FIRST-CONTROLLED-BATCH";
const EXPEDITION_SECOND_BATCH_MODE = "silversea_expedition_e5_next_batch";
const EXPEDITION_E5_APPLY_CONFIRMATION_TOKEN = "SILVERSEA-EXPEDITION-SECOND-CONTROLLED-BATCH";
const EXPEDITION_BATCH_SIZE = 250;
const E3_COMPLETE_POOL_FIXTURE = "scripts/fixtures/silversea/expedition-e3-complete-pool.json";
const E3_FIRST_250_FIXTURE = "scripts/fixtures/silversea/expedition-e3-first-250.json";
const E5_COMPLETE_REMAINDER_FIXTURE = "scripts/fixtures/silversea/expedition-e5-complete-remainder.json";
const E5_NEXT_BATCH_FIXTURE = "scripts/fixtures/silversea/expedition-e5-next-batch.json";

function isExpeditionProduct(raw) {
  return String(raw?.cruise_type || "").trim().toLowerCase() === "expedition";
}

function isDeferredSpecialVoyage(raw) {
  return Boolean(raw?.deferred_special_voyage);
}

function expeditionCandidateSortKey(normalised) {
  const dep = normalised?.candidate?.departure_date || normalised?.raw?.departure_date || "";
  const id = normalised?.official_sailing_id || "";
  return `${dep}|${String(id).toUpperCase()}`;
}

function isExpeditionProductionEligible(normalised, today, existingByOfficialId = new Map()) {
  const raw = normalised?.raw || {};
  if (!isExpeditionProduct(raw)) return false;
  if (isDeferredSpecialVoyage(raw)) return false;
  if (!raw.cruise_code_valid || !normalised.official_sailing_id) return false;
  if (String(normalised.official_sailing_id).toUpperCase() !== String(officialProductKey(raw)).toUpperCase()) {
    return false;
  }
  if (existingByOfficialId.has(String(normalised.official_sailing_id).toUpperCase())) return false;
  return classifyExpeditionExclusiveBucket(normalised, today) === "expedition_e2_complete";
}

function buildExpeditionExclusiveFunnel(expRows, today) {
  const counts = Object.fromEntries(EXPEDITION_EXCLUSIVE_BUCKETS.map((b) => [b, 0]));
  for (const row of expRows || []) {
    const bucket = classifyExpeditionExclusiveBucket(row, today);
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  const total = (expRows || []).length;
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  return { total, sum, reconciles: sum === total, counts };
}

function selectExpeditionCompletePool(expRows, { today, existingByOfficialId = new Map() } = {}) {
  const eligible = (expRows || [])
    .filter((row) => isExpeditionProductionEligible(row, today, existingByOfficialId))
    .sort((a, b) => expeditionCandidateSortKey(a).localeCompare(expeditionCandidateSortKey(b)));

  const ids = eligible.map((r) => r.official_sailing_id);
  const unique = new Set(ids.map((id) => String(id).toUpperCase()));

  return {
    eligible,
    eligible_count: eligible.length,
    eligible_ids: ids,
    unique_count: unique.size,
    collision_free: unique.size === ids.length
  };
}

function selectNewCompleteExpeditionPool(expRows, { today, existingByOfficialId = new Map() } = {}) {
  return selectExpeditionCompletePool(expRows, { today, existingByOfficialId });
}

function selectNextExpeditionBatch(newCompletePool, limit = MAX_CONTROLLED_BATCH) {
  const pool = newCompletePool?.eligible || newCompletePool || [];
  const batchLimit = Math.min(limit, pool.length);
  return selectFirstExpeditionBatch(pool, batchLimit);
}

function reconcileRemainderSets(previousIds, currentIds) {
  const prev = new Set((previousIds || []).map((id) => String(id).toUpperCase()));
  const curr = new Set((currentIds || []).map((id) => String(id).toUpperCase()));
  const stillPresent = [...prev].filter((id) => curr.has(id));
  const removed = [...prev].filter((id) => !curr.has(id));
  const newlyAdded = [...curr].filter((id) => !prev.has(id));
  return {
    previous_count: prev.size,
    current_count: curr.size,
    still_present: stillPresent,
    removed,
    newly_added: newlyAdded,
    delta: curr.size - prev.size
  };
}

function selectFirstExpeditionBatch(completePool, limit = EXPEDITION_BATCH_SIZE) {
  const selected = (completePool || []).slice(0, limit);
  const ids = selected.map((r) => r.official_sailing_id);
  const unique = new Set(ids.map((id) => String(id).toUpperCase()));
  return {
    selected,
    selected_ids: ids,
    frozen_count: selected.length,
    frozen_unique_count: unique.size,
    frozen_selection: true
  };
}

function loadFrozenExpeditionIds(fixture) {
  const ids =
    fixture?.selection?.selected_official_sailing_ids ||
    fixture?.official_sailing_ids ||
    fixture?.candidates?.map((c) => c.official_sailing_id);
  if (!Array.isArray(ids) || !ids.length) {
    const err = new Error("expedition_frozen_selection_not_found");
    err.code = "expedition_frozen_selection_not_found";
    throw err;
  }
  return ids.map((id) => String(id).trim().toUpperCase()).filter(Boolean);
}

function selectFrozenExpeditionBatch(expRows, frozenIds, { today, existingByOfficialId = new Map() } = {}) {
  const byCode = new Map();
  for (const row of expRows || []) {
    if (row.official_sailing_id) {
      byCode.set(String(row.official_sailing_id).toUpperCase(), row);
    }
  }

  const selected = [];
  const missing = [];
  const noLongerEligible = [];

  for (const id of frozenIds || []) {
    const key = String(id).toUpperCase();
    const row = byCode.get(key);
    if (!row) {
      missing.push(id);
      continue;
    }
    if (!isExpeditionProductionEligible(row, today, existingByOfficialId)) {
      noLongerEligible.push({
        official_sailing_id: id,
        bucket: classifyExpeditionExclusiveBucket(row, today),
        evaluation: evaluateExpeditionEligibility(row, today)
      });
      continue;
    }
    selected.push(row);
  }

  const frozenCount = (frozenIds || []).length;
  const uniqueFrozen = new Set((frozenIds || []).map((id) => String(id).toUpperCase()));

  return {
    frozen_count: frozenCount,
    frozen_unique_count: uniqueFrozen.size,
    selected,
    selected_ids: selected.map((r) => r.official_sailing_id),
    missing,
    no_longer_eligible: noLongerEligible,
    frozen_still_eligible: selected.length,
    exact_frozen_set_match:
      selected.length === frozenCount &&
      missing.length === 0 &&
      noLongerEligible.length === 0 &&
      uniqueFrozen.size === frozenCount
  };
}

function endpointResolutionType(portMeta) {
  if (!portMeta || portMeta.status !== "resolved") return "unresolved";
  if (portMeta.expedition_logistics_gateway) return "expedition_logistics_gateway";
  if (portMeta.canonicalPortName) return "conventional_catalogue";
  return "resolved_other";
}

function countItinerarySemantics(normalised) {
  const itinerary = normalised.itinerary || [];
  let conventional = 0;
  let deterministicNonPort = 0;
  let ambiguous = 0;
  for (const stop of itinerary) {
    if (stop.kind !== "port") continue;
    if (stop.semantic_confidence === SEMANTIC_CONFIDENCE.AMBIGUOUS || !stop.expedition_semantic) {
      ambiguous += 1;
      continue;
    }
    if (stop.expedition_semantic === EXPEDITION_SEMANTIC.CONVENTIONAL_PORT) {
      if (stop.port_resolution?.status === "resolved") conventional += 1;
      continue;
    }
    deterministicNonPort += 1;
  }
  return { conventional, deterministicNonPort, ambiguous, totalPortStops: itinerary.filter((s) => s.kind === "port").length };
}

function buildExpeditionPreWriteTableRow(sequence, normalised, today) {
  const raw = normalised.raw || {};
  const evalResult = evaluateExpeditionEligibility(normalised, today);
  const semantics = countItinerarySemantics(normalised);
  const dep = normalised.candidate?.departure_date || raw.departure_date;
  const days = dep ? daysUntilDeparture(dep, today) : null;

  return {
    sequence,
    official_sailing_id: normalised.official_sailing_id,
    cruise_code: normalised.official_sailing_id,
    ship: normalised.ship_resolution?.ship?.name || raw.ship_name,
    departure: dep,
    arrival: normalised.candidate?.return_date || raw.return_date,
    nights: normalised.candidate?.nights,
    embark: normalised.candidate?.departure_port || raw.departure_port,
    embark_resolution_type: endpointResolutionType(normalised.departure_port_resolution),
    disembark: normalised.candidate?.arrival_port || raw.arrival_port,
    disembark_resolution_type: endpointResolutionType(normalised.arrival_port_resolution),
    destination: raw.destination_name,
    destination_key: normalised.destination_resolution?.destinationKey || null,
    itinerary_stop_count: evalResult.itinerary_stop_count,
    conventional_port_count: semantics.conventional,
    deterministic_semantic_non_port_count: semantics.deterministicNonPort,
    ambiguous_stop_count: semantics.ambiguous,
    combo_segment: isComboSegmentProduct(raw),
    source_url: raw.official_url || normalised.candidate?.official_url,
    full_path: raw.full_path,
    days_until_departure: days,
    eligibility: evalResult.eligible ? "PASS" : "FAIL",
    exclusive_bucket: evalResult.exclusive_bucket,
    production_dedupe: "NEW",
    match_required: Boolean(normalised.match_required)
  };
}

function validateExpeditionCandidate(normalised, today, existingByOfficialId = new Map()) {
  const failures = [];
  const raw = normalised?.raw || {};
  if (!isExpeditionProduct(raw)) failures.push("not_expedition");
  if (!raw.cruise_code_valid) failures.push("invalid_cruise_code");
  if (!normalised.official_sailing_id) failures.push("missing_official_sailing_id");
  if (isDeferredSpecialVoyage(raw)) failures.push("deferred_special_voyage");
  const dep = normalised.candidate?.departure_date || raw.departure_date;
  const days = dep ? daysUntilDeparture(dep, today) : null;
  if (days != null && days < PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE) failures.push("within_cutoff");
  if (raw.duration_matches_dates !== true) failures.push("duration_mismatch");
  if (!normalised.ship_resolution?.resolved) failures.push("ship_unresolved");
  if (!isExpeditionEndpointResolved(normalised.departure_port_resolution)) failures.push("embark_unresolved");
  if (!isExpeditionEndpointResolved(normalised.arrival_port_resolution)) failures.push("disembark_unresolved");
  if (normalised.destination_resolution?.status !== "resolved" || !normalised.candidate?.destination_id) {
    failures.push("destination_unresolved");
  }
  const analysis = analyseExpeditionItineraryStops(normalised.itinerary || []);
  if (analysis.conventionalUnresolved > 0) failures.push("conventional_port_unresolved");
  if (analysis.ambiguous > 0) failures.push("ambiguous_semantic_itinerary");
  if (normalised.match_required) failures.push("match_required");
  if ((normalised.failure_reasons || []).length > 0) failures.push("failure_reasons_present");
  if (!raw.detail_enriched) failures.push("detail_not_enriched");
  if (existingByOfficialId.has(String(normalised.official_sailing_id || "").toUpperCase())) {
    failures.push("already_in_production");
  }
  return { ok: failures.length === 0, failures };
}

function validateAllExpeditionCandidates(rows, today, existingByOfficialId = new Map()) {
  const results = (rows || []).map((row) => ({
    official_sailing_id: row.official_sailing_id,
    ...validateExpeditionCandidate(row, today, existingByOfficialId)
  }));
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    total: results.length,
    passed: results.length - failed.length,
    failed
  };
}

function buildExpeditionCandidateMetadata(normalised, today) {
  const raw = normalised.raw || {};
  const table = buildExpeditionPreWriteTableRow(0, normalised, today);
  return {
    official_sailing_id: normalised.official_sailing_id,
    cruise_code: normalised.official_sailing_id,
    ship: table.ship,
    departure_date: table.departure,
    return_date: table.arrival,
    nights: table.nights,
    destination: table.destination,
    destination_key: table.destination_key,
    combo_segment: table.combo_segment,
    source_url: table.source_url,
    full_path: table.full_path,
    exclusive_bucket: table.exclusive_bucket,
    embark_resolution_type: table.embark_resolution_type,
    disembark_resolution_type: table.disembark_resolution_type,
    conventional_port_count: table.conventional_port_count,
    deterministic_semantic_non_port_count: table.deterministic_semantic_non_port_count,
    ambiguous_stop_count: table.ambiguous_stop_count
  };
}

function computeExpeditionManifestHash(manifest) {
  const basis = JSON.stringify({
    mode: manifest.mode,
    run_id: manifest.run_id,
    cruise_line_id: manifest.cruise_line_id,
    selected_official_sailing_ids: (manifest.selected_official_sailing_ids || []).slice().sort()
  });
  return crypto.createHash("sha256").update(basis).digest("hex");
}

function evaluateExpeditionPreWriteGate({
  completePoolCount,
  selection,
  proposedInserts,
  proposedUpdates,
  revalidation,
  sourceHealthOk,
  expectedCount = EXPEDITION_BATCH_SIZE,
  existingSelectedOfficialIds = 0
}) {
  const failures = [];
  if (!sourceHealthOk) failures.push("source_health_failed");
  if (completePoolCount < expectedCount) failures.push(`complete_pool_below_${expectedCount}:${completePoolCount}`);
  if (selection.frozen_count !== expectedCount) failures.push(`frozen_count_not_${expectedCount}:${selection.frozen_count}`);
  if (selection.frozen_unique_count !== expectedCount) {
    failures.push(`frozen_unique_not_${expectedCount}:${selection.frozen_unique_count}`);
  }
  if (!selection.exact_frozen_set_match) failures.push("frozen_set_no_longer_eligible");
  if (!revalidation?.ok) failures.push(`revalidation_failed:${revalidation?.failed?.length || "unknown"}`);
  if (proposedUpdates > 0) failures.push(`proposed_updates:${proposedUpdates}`);
  if (proposedInserts !== expectedCount) failures.push(`proposed_inserts_not_${expectedCount}:${proposedInserts}`);
  if (existingSelectedOfficialIds > 0) failures.push(`existing_selected_ids:${existingSelectedOfficialIds}`);
  return { passed: failures.length === 0, failures, authorised_count: expectedCount };
}

function buildE3RollbackTemplate({ fixturePath, officialIds, gitSha }) {
  return {
    phase: "expedition_e3_rollback_template",
    note: "Populate inserted_record_ids after E4 apply; do not run before production insert",
    frozen_fixture_path: fixturePath,
    git_sha: gitSha,
    expected_inserts: officialIds.length,
    expected_updates: 0,
    expected_deletes: 0,
    expected_pre_existing_selected_ids: 0,
    batch_ceiling: MAX_CONTROLLED_BATCH,
    official_sailing_ids: officialIds,
    rollback_strategy: "exact_inserted_record_ids_only",
    inserted_record_ids: []
  };
}

module.exports = {
  EXPEDITION_FIRST_BATCH_MODE,
  EXPEDITION_APPLY_CONFIRMATION_TOKEN,
  EXPEDITION_SECOND_BATCH_MODE,
  EXPEDITION_E5_APPLY_CONFIRMATION_TOKEN,
  EXPEDITION_BATCH_SIZE,
  E3_COMPLETE_POOL_FIXTURE,
  E3_FIRST_250_FIXTURE,
  E5_COMPLETE_REMAINDER_FIXTURE,
  E5_NEXT_BATCH_FIXTURE,
  isExpeditionProductionEligible,
  buildExpeditionExclusiveFunnel,
  selectExpeditionCompletePool,
  selectNewCompleteExpeditionPool,
  selectFirstExpeditionBatch,
  selectNextExpeditionBatch,
  reconcileRemainderSets,
  loadFrozenExpeditionIds,
  selectFrozenExpeditionBatch,
  expeditionCandidateSortKey,
  buildExpeditionPreWriteTableRow,
  validateExpeditionCandidate,
  validateAllExpeditionCandidates,
  buildExpeditionCandidateMetadata,
  computeExpeditionManifestHash,
  evaluateExpeditionPreWriteGate,
  buildE3RollbackTemplate,
  countItinerarySemantics,
  endpointResolutionType
};
