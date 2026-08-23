/**
 * Silversea weekly maintenance — read-only proposal policy, guards, and contracts.
 * M1: design/simulation only. No production writes.
 */

const crypto = require("crypto");
const { portsArrayEqual, normalizeStoredPorts } = require("./silversea-expedition-itinerary-ports-backfill");

const MAINTENANCE_CLASSIFICATION = Object.freeze({
  UNCHANGED: "UNCHANGED",
  INSERT_ELIGIBLE: "INSERT_ELIGIBLE",
  UPDATE_ELIGIBLE: "UPDATE_ELIGIBLE",
  UPDATE_UNSAFE: "UPDATE_UNSAFE",
  SOURCE_ABSENT_OBSERVATION: "SOURCE_ABSENT_OBSERVATION",
  WITHIN_21_DAY_CUTOFF: "WITHIN_21_DAY_CUTOFF",
  REFERENCE_BLOCKED: "REFERENCE_BLOCKED",
  SEMANTIC_BLOCKED: "SEMANTIC_BLOCKED",
  DURATION_BLOCKED: "DURATION_BLOCKED",
  DEFERRED_SPECIAL_PRODUCT: "DEFERRED_SPECIAL_PRODUCT",
  IDENTITY_CONFLICT: "IDENTITY_CONFLICT",
  SOURCE_UNSAFE: "SOURCE_UNSAFE",
  IDENTITY_UNSAFE: "IDENTITY_UNSAFE",
  OTHER_UNSAFE: "OTHER_UNSAFE"
});

const IDENTITY_RELATION = Object.freeze({
  SOURCE_AND_PRODUCTION: "SOURCE_AND_PRODUCTION",
  SOURCE_ONLY: "SOURCE_ONLY",
  PRODUCTION_ONLY: "PRODUCTION_ONLY"
});

const IMMUTABLE_FIELDS = Object.freeze([
  "id",
  "official_sailing_id",
  "cruise_line_id",
  "external_key",
  "identity_key"
]);

const MAINTAINABLE_FIELDS = Object.freeze([
  "title",
  "ship_id",
  "departure_date",
  "return_date",
  "nights",
  "departure_port",
  "itinerary",
  "itinerary_ports",
  "destination_id",
  "official_url",
  "source_url",
  "raw_extract",
  "brochure_fare",
  "brochure_fare_display",
  "currency"
]);

const LIFECYCLE_FIELDS = Object.freeze([
  "status",
  "last_changed_at",
  "last_seen_at",
  "last_verified_at",
  "review_reason",
  "match_confidence"
]);

const SOURCE_ABSENCE_POLICY = Object.freeze({
  required_consecutive_healthy_absences: 3,
  observation_cadence: "weekly",
  confirmation_window_days: 21,
  reset_on_source_return: true,
  quarantine_after_threshold: true,
  single_miss_action: "SOURCE_ABSENT_OBSERVATION_ONLY",
  physical_delete_proposed: false,
  hide_on_single_miss: false,
  requires_healthy_source_snapshot: true
});

const PROPOSED_ACTION_CEILINGS = Object.freeze({
  insert: 1,
  update: 1,
  quarantine_or_hide: 1,
  delete: 0
});

const ITINERARY_SHRINK_GUARD = Object.freeze({
  max_shrink_ratio_without_extra_evidence: 0.15,
  require_detail_enriched: true,
  require_duration_unchanged: true,
  require_embark_disembark_align: true
});

const POPULATION_ANOMALY_THRESHOLDS = Object.freeze({
  min_catalogue_count: 200,
  min_unique_ratio: 0.99,
  min_field_coverage_ratio: 0.95,
  max_catalogue_drop_ratio: 0.25
});

const WEEKLY_HARD_STOP_CONDITIONS = Object.freeze([
  "source_health_failed",
  "duplicate_source_official_ids",
  "identity_collision_detected",
  "reference_dependency_spike",
  "itinerary_shrink_spike",
  "proposal_exceeds_safety_ceiling",
  "global_lock_unavailable_at_apply",
  "implausible_source_population_change",
  "source_parser_schema_break"
]);

const FUTURE_MAINTENANCE_LOCK_CONTRACT = Object.freeze({
  steps: [
    "compute_proposal_outside_lock",
    "acquire_global_cruise_lock",
    "re_fetch_production_preconditions",
    "validate_frozen_source_and_proposal",
    "execute_bounded_action",
    "verify_under_lock",
    "persist_verified_complete",
    "release_lock_in_finally"
  ],
  global_lock_key: "controlled_production_import:global",
  default_lease_seconds: 1800
});

const SOURCE_ABSENCE_FIXTURE_ID = "SN280222C25";

const OBSERVATION_STATE_SCHEMA = Object.freeze({
  table: "cruise_source_observation_state",
  rpc_advance: "advance_cruise_source_absence_observation",
  rpc_resolve: "resolve_cruise_source_absence_observation",
  fields: [
    "id",
    "cruise_line_id",
    "official_sailing_id",
    "observation_type",
    "status",
    "production_cruise_uuid",
    "consecutive_healthy_absence_count",
    "first_observed_at",
    "last_observed_at",
    "last_observation_period_key",
    "last_counted_snapshot_hash",
    "last_source_health",
    "last_run_id",
    "reason_code",
    "metadata",
    "resolved_at",
    "created_at",
    "updated_at"
  ],
  m1_persistence: "deferred_to_m4",
  m7a_event_table: "cruise_source_observation_events",
  m4_canary: SOURCE_ABSENCE_FIXTURE_ID
});

const M0E_DRIFT_CASE_IDS = Object.freeze([
  "SL270927009",
  "WH271121011",
  "WH271202011",
  "WH280329011",
  "WH281126C27",
  "WH281126010"
]);

function snapshotFingerprint(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function multisetEqual(a, b) {
  const sa = [...(a || [])].sort();
  const sb = [...(b || [])].sort();
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

function shrinkRatio(beforeCount, afterCount) {
  if (!beforeCount) return 0;
  return Math.max(0, (beforeCount - afterCount) / beforeCount);
}

function evaluateItineraryShrinkGuard({
  storedPorts = [],
  expectedPorts = [],
  raw = {},
  candidate = {},
  productionRow = {}
}) {
  const before = normalizeStoredPorts(storedPorts);
  const after = normalizeStoredPorts(expectedPorts);
  if (portsArrayEqual(before, after)) {
    return { pass: true, reason: "no_change", shrink_ratio: 0, disappeared: [] };
  }
  const beforeCount = before.length;
  const afterCount = after.length;
  const ratio = shrinkRatio(beforeCount, afterCount);
  const disappeared = before.filter((p) => !after.includes(p));
  const detailHealthy = raw.detail_enriched === true;
  const durationUnchanged =
    productionRow.nights == null ||
    candidate.nights == null ||
    Number(productionRow.nights) === Number(candidate.nights);
  const embarkAlign =
    !productionRow.departure_port ||
    !candidate.departure_port ||
    String(productionRow.departure_port).trim() === String(candidate.departure_port).trim();

  if (afterCount >= beforeCount) {
    return { pass: true, reason: "not_a_shrink", shrink_ratio: ratio, disappeared };
  }

  const plausibleCompleteManifest =
    detailHealthy &&
    durationUnchanged &&
    embarkAlign &&
    ratio <= ITINERARY_SHRINK_GUARD.max_shrink_ratio_without_extra_evidence;

  if (plausibleCompleteManifest) {
    return { pass: true, reason: "small_shrink_plausible", shrink_ratio: ratio, disappeared };
  }

  return {
    pass: false,
    reason: "source_truncation_suspected",
    shrink_ratio: ratio,
    disappeared,
    detail_enriched: detailHealthy,
    duration_unchanged: durationUnchanged,
    embark_align: embarkAlign
  };
}

function evaluateItineraryReorderGuard({ storedPorts = [], expectedPorts = [] }) {
  const before = normalizeStoredPorts(storedPorts);
  const after = normalizeStoredPorts(expectedPorts);
  if (portsArrayEqual(before, after)) {
    return { pass: true, reason: "exact_match", reorder_only: false };
  }
  if (before.length !== after.length) {
    return { pass: false, reason: "length_mismatch", reorder_only: false };
  }
  const reorderOnly = multisetEqual(before, after);
  return {
    pass: reorderOnly,
    reason: reorderOnly ? "multiset_reorder_source_authoritative" : "content_change",
    reorder_only: reorderOnly
  };
}

function evaluateItineraryPortsUpdateSafety(ctx) {
  const shrink = evaluateItineraryShrinkGuard(ctx);
  if (!shrink.pass) return { eligible: false, guard: "shrink", ...shrink };
  const reorder = evaluateItineraryReorderGuard(ctx);
  if (!reorder.pass && !reorder.reorder_only) {
    return { eligible: false, guard: "reorder_or_content", ...reorder };
  }
  return { eligible: true, guard: "pass", shrink, reorder };
}

function assessSourcePopulationAnomaly(currentSummary, baselineSummary = null) {
  const issues = [];
  const catalogue = Number(currentSummary?.catalogue_nodes || currentSummary?.unique_cruise_codes || 0);
  if (catalogue < POPULATION_ANOMALY_THRESHOLDS.min_catalogue_count) {
    issues.push("catalogue_below_minimum");
  }
  const uniqueRatio =
    catalogue > 0
      ? Number(currentSummary?.unique_cruise_codes || catalogue) / catalogue
      : 0;
  if (uniqueRatio < POPULATION_ANOMALY_THRESHOLDS.min_unique_ratio) {
    issues.push("duplicate_source_ids");
  }
  if (baselineSummary) {
    const baseline = Number(baselineSummary.catalogue_nodes || baselineSummary.unique_cruise_codes || 0);
    if (baseline > 0) {
      const drop = (baseline - catalogue) / baseline;
      if (drop > POPULATION_ANOMALY_THRESHOLDS.max_catalogue_drop_ratio) {
        issues.push("implausible_catalogue_drop");
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

function classifySourceOnlyBucketToMaintenance(bucket, { raw, productType, isNewComboSegment }) {
  if (raw?.deferred_special_voyage || productType === "deferred_special_voyage" || isNewComboSegment) {
    return MAINTENANCE_CLASSIFICATION.DEFERRED_SPECIAL_PRODUCT;
  }
  if (bucket === "within_21_day_cutoff") return MAINTENANCE_CLASSIFICATION.WITHIN_21_DAY_CUTOFF;
  if (bucket === "invalid_identity") return MAINTENANCE_CLASSIFICATION.IDENTITY_UNSAFE;
  if (bucket === "departed") return MAINTENANCE_CLASSIFICATION.OTHER_UNSAFE;
  if (bucket === "classic_duration_mismatch" || bucket === "duration_mismatch") {
    return MAINTENANCE_CLASSIFICATION.DURATION_BLOCKED;
  }
  if (
    bucket === "classic_ship_unresolved" ||
    bucket === "classic_embark_unresolved" ||
    bucket === "classic_disembark_unresolved" ||
    bucket === "classic_destination_unresolved" ||
    bucket === "classic_itinerary_port_unresolved" ||
    bucket === "ship_unresolved" ||
    bucket === "embark_unresolved" ||
    bucket === "disembark_unresolved" ||
    bucket === "destination_unresolved" ||
    bucket === "conventional_itinerary_port_unresolved"
  ) {
    return MAINTENANCE_CLASSIFICATION.REFERENCE_BLOCKED;
  }
  if (
    bucket === "ambiguous_semantic_itinerary" ||
    bucket === "classic_other_incomplete" ||
    bucket === "expedition_deferred"
  ) {
    return MAINTENANCE_CLASSIFICATION.SEMANTIC_BLOCKED;
  }
  if (bucket === "classic_production_eligible" || bucket === "expedition_e2_complete") {
    return MAINTENANCE_CLASSIFICATION.INSERT_ELIGIBLE;
  }
  if (bucket === "recognised_existing_official_id") {
    return MAINTENANCE_CLASSIFICATION.OTHER_UNSAFE;
  }
  return MAINTENANCE_CLASSIFICATION.OTHER_UNSAFE;
}

function proposalChecksum(proposal) {
  const stable = {
    classifications: proposal.records.map((r) => ({
      official_sailing_id: r.official_sailing_id,
      classification: r.classification,
      secondary_reason: r.secondary_reason || null,
      changed_fields: (r.changed_fields || []).slice().sort()
    })),
    counts: proposal.counts
  };
  return snapshotFingerprint(stable);
}

module.exports = {
  MAINTENANCE_CLASSIFICATION,
  IDENTITY_RELATION,
  IMMUTABLE_FIELDS,
  MAINTAINABLE_FIELDS,
  LIFECYCLE_FIELDS,
  SOURCE_ABSENCE_POLICY,
  PROPOSED_ACTION_CEILINGS,
  ITINERARY_SHRINK_GUARD,
  POPULATION_ANOMALY_THRESHOLDS,
  WEEKLY_HARD_STOP_CONDITIONS,
  FUTURE_MAINTENANCE_LOCK_CONTRACT,
  OBSERVATION_STATE_SCHEMA,
  M0E_DRIFT_CASE_IDS,
  SOURCE_ABSENCE_FIXTURE_ID,
  snapshotFingerprint,
  multisetEqual,
  shrinkRatio,
  evaluateItineraryShrinkGuard,
  evaluateItineraryReorderGuard,
  evaluateItineraryPortsUpdateSafety,
  assessSourcePopulationAnomaly,
  classifySourceOnlyBucketToMaintenance,
  proposalChecksum
};
