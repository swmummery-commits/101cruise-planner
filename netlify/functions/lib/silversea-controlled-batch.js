/**
 * Silversea Cruises — first controlled production batch (Classic sailings only).
 * Hard limit: 100 inserts. Insert-only for the first onboarding batch.
 */

const crypto = require("crypto");
const { officialProductKey } = require("./silversea-discovery-adapter");
const {
  PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE,
  daysUntilDeparture
} = require("./public-discovered-cruise-inventory");

const MAX_FIRST_CONTROLLED_BATCH = 100;
const APPLY_CONFIRMATION_TOKEN = "SILVERSEA-FIRST-CONTROLLED-BATCH";
const FIRST_BATCH_MODE = "silversea_first_controlled_batch";

const EXCLUSIVE_BUCKETS = [
  "departed",
  "within_21_day_cutoff",
  "expedition_deferred",
  "classic_duration_mismatch",
  "classic_ship_unresolved",
  "classic_embark_unresolved",
  "classic_disembark_unresolved",
  "classic_destination_unresolved",
  "classic_itinerary_port_unresolved",
  "classic_other_incomplete",
  "recognised_existing_official_id",
  "classic_production_eligible",
  "invalid_identity"
];

function isClassic(raw) {
  return String(raw?.cruise_type || "").trim().toLowerCase() === "classic";
}

function isExpedition(raw) {
  return String(raw?.cruise_type || "").trim().toLowerCase() === "expedition";
}

function hasDurationExactMatch(raw) {
  return raw?.duration_matches_dates === true;
}

function hasUnresolvedActualItineraryPort(normalised) {
  return (normalised.itinerary || [])
    .filter((stop) => stop.kind === "port")
    .some((stop) => stop.port_resolution?.status !== "resolved");
}

function actualItineraryPortCount(normalised) {
  return (normalised.itinerary || []).filter((stop) => stop.kind === "port").length;
}

function resolvedItineraryPortCount(normalised) {
  return (normalised.itinerary || []).filter(
    (stop) => stop.kind === "port" && stop.port_resolution?.status === "resolved"
  ).length;
}

function classifyExclusiveBucket(normalised, today, existingByOfficialId = new Map()) {
  const raw = normalised?.raw || {};
  const dep = normalised?.candidate?.departure_date || raw.departure_date;
  const officialId = normalised?.official_sailing_id || officialProductKey(raw);

  if (!raw.cruise_code_valid || !officialId) return "invalid_identity";
  if (dep && dep < today) return "departed";

  const days = dep ? daysUntilDeparture(dep, today) : null;
  if (days != null && days < PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE) {
    return "within_21_day_cutoff";
  }

  if (isExpedition(raw)) return "expedition_deferred";
  if (!isClassic(raw)) return "classic_other_incomplete";
  if (!hasDurationExactMatch(raw)) return "classic_duration_mismatch";
  if (!normalised.ship_resolution?.resolved) return "classic_ship_unresolved";
  if (normalised.departure_port_resolution?.status !== "resolved") return "classic_embark_unresolved";
  if (normalised.arrival_port_resolution?.status !== "resolved") return "classic_disembark_unresolved";
  if (normalised.destination_resolution?.status !== "resolved") return "classic_destination_unresolved";
  if (!normalised.candidate?.destination_id) return "classic_destination_unresolved";
  if (hasUnresolvedActualItineraryPort(normalised)) return "classic_itinerary_port_unresolved";
  if (
    !normalised.complete_high_confidence ||
    normalised.match_required ||
    (normalised.failure_reasons || []).length > 0 ||
    !raw.detail_enriched
  ) {
    return "classic_other_incomplete";
  }

  if (existingByOfficialId.has(String(officialId).toUpperCase())) {
    return "recognised_existing_official_id";
  }

  return "classic_production_eligible";
}

function buildExclusiveClassificationFunnel(normalisedRows, { today, existingByOfficialId = new Map() } = {}) {
  const counts = Object.fromEntries(EXCLUSIVE_BUCKETS.map((b) => [b, 0]));
  const byBucket = Object.fromEntries(EXCLUSIVE_BUCKETS.map((b) => [b, []]));
  const assignments = [];

  for (const row of normalisedRows || []) {
    const bucket = classifyExclusiveBucket(row, today, existingByOfficialId);
    counts[bucket] = (counts[bucket] || 0) + 1;
    byBucket[bucket].push(row.official_sailing_id);
    assignments.push({
      official_sailing_id: row.official_sailing_id,
      bucket,
      cruise_type: row.raw?.cruise_type || null,
      departure_date: row.candidate?.departure_date || row.raw?.departure_date || null
    });
  }

  const total = (normalisedRows || []).length;
  const sum = Object.values(counts).reduce((n, v) => n + v, 0);

  return {
    total,
    sum,
    reconciles: sum === total,
    counts,
    assignments,
    by_bucket_sample: Object.fromEntries(
      EXCLUSIVE_BUCKETS.map((b) => [b, (byBucket[b] || []).slice(0, 5)])
    )
  };
}

function isFirstBatchEligible(normalised, today, existingByOfficialId = new Map()) {
  return classifyExclusiveBucket(normalised, today, existingByOfficialId) === "classic_production_eligible";
}

function candidateSortKey(normalised) {
  const dep = normalised?.candidate?.departure_date || normalised?.raw?.departure_date || "";
  const id = normalised?.official_sailing_id || "";
  return `${dep}|${id}`;
}

function selectFirstBatchProducts(normalisedRows, { maxWrites = MAX_FIRST_CONTROLLED_BATCH, today, existingByOfficialId = new Map() } = {}) {
  const limit = Math.min(maxWrites, MAX_FIRST_CONTROLLED_BATCH);
  const eligible = (normalisedRows || [])
    .filter((row) => isFirstBatchEligible(row, today, existingByOfficialId))
    .sort((a, b) => candidateSortKey(a).localeCompare(candidateSortKey(b)));

  const selected = eligible.slice(0, limit);
  return {
    eligible_count: eligible.length,
    selected,
    selected_ids: selected.map((r) => r.official_sailing_id),
    sufficient_for_batch: eligible.length >= limit
  };
}

function buildPreWriteTableRow(sequence, normalised) {
  const raw = normalised.raw || {};
  const portStops = (normalised.itinerary || []).filter((s) => s.kind === "port");
  return {
    sequence,
    official_sailing_id: normalised.official_sailing_id,
    ship: normalised.ship_resolution?.ship?.name || raw.ship_name,
    departure: normalised.candidate?.departure_date,
    arrival: normalised.candidate?.return_date,
    nights: normalised.candidate?.nights,
    embark: normalised.candidate?.departure_port,
    disembark: normalised.arrival_port_resolution?.canonicalPortName || raw.arrival_port,
    destination: normalised.destination_resolution?.destinationKey,
    cruise_type: raw.cruise_type,
    itinerary_port_call_count: portStops.length,
    source_url: raw.official_url || normalised.candidate?.official_url,
    full_path: raw.full_path,
    dedupe_status: normalised.identity_class?.class || "new",
    duration_exact_match: raw.duration_matches_dates === true
  };
}

function computeManifestHash(manifest) {
  const basis = JSON.stringify({
    mode: manifest.mode,
    run_id: manifest.run_id,
    cruise_line_id: manifest.cruise_line_id,
    selected_official_sailing_ids: (manifest.selected_official_sailing_ids || []).slice().sort()
  });
  return crypto.createHash("sha256").update(basis).digest("hex");
}

function validateSelectedAgainstFreshSource(selectedIds, productsByCode) {
  const missing = [];
  const changed = [];

  for (const id of selectedIds || []) {
    const key = String(id).toUpperCase();
    const fresh = productsByCode.get(key);
    if (!fresh) {
      missing.push(id);
      continue;
    }
    const raw = fresh.raw || {};
    if (String(raw.cruise_type || "").toLowerCase() !== "classic") {
      changed.push({ cruise_code: id, field: "cruise_type", value: raw.cruise_type });
    }
    if (raw.duration_matches_dates !== true) {
      changed.push({ cruise_code: id, field: "duration_matches_dates", value: raw.duration_matches_dates });
    }
  }

  return {
    ok: missing.length === 0 && changed.length === 0,
    missing,
    changed
  };
}

function evaluatePreWriteGate({
  funnel,
  selection,
  proposedInserts,
  proposedUpdates,
  sourceHealthOk,
  sourceRefreshOk,
  maxWrites = MAX_FIRST_CONTROLLED_BATCH
}) {
  const failures = [];
  if (!funnel?.reconciles) failures.push("exclusive_classification_does_not_reconcile");
  if (!sourceHealthOk) failures.push("source_health_failed");
  if (!sourceRefreshOk) failures.push("source_refresh_validation_failed");
  if (!selection?.sufficient_for_batch) {
    failures.push(`insufficient_eligible_classic:${selection?.eligible_count ?? 0}`);
  }
  if (proposedUpdates > 0) failures.push(`proposed_updates:${proposedUpdates}`);
  if (proposedInserts > maxWrites) failures.push(`proposed_inserts_exceed_limit:${proposedInserts}`);
  if (proposedInserts < 1 && maxWrites > 0) failures.push("no_proposed_inserts");

  return { passed: failures.length === 0, failures };
}

module.exports = {
  MAX_FIRST_CONTROLLED_BATCH,
  APPLY_CONFIRMATION_TOKEN,
  FIRST_BATCH_MODE,
  EXCLUSIVE_BUCKETS,
  isClassic,
  isExpedition,
  hasDurationExactMatch,
  hasUnresolvedActualItineraryPort,
  actualItineraryPortCount,
  resolvedItineraryPortCount,
  classifyExclusiveBucket,
  buildExclusiveClassificationFunnel,
  isFirstBatchEligible,
  candidateSortKey,
  selectFirstBatchProducts,
  buildPreWriteTableRow,
  computeManifestHash,
  validateSelectedAgainstFreshSource,
  evaluatePreWriteGate
};
