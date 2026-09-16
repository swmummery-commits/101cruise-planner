/**
 * P3H Royal Caribbean candidate-set comparison and freeze gate.
 * Compare identity sets, not totals. Unexplained appear/disappear blocks catch-up.
 */

const { daysUntilDeparture, PUBLIC_BOOKING_CUTOFF_DAYS } = require("./public-discovered-cruise-inventory");

const P3H_DELTA_CLASSES = Object.freeze([
  "NEW_OFFICIAL_PUBLICATION",
  "SOURCE_REMOVED",
  "CUT_OFF_DATE_AGING",
  "IDENTITY_REMAP",
  "SOURCE_VOLATILITY",
  "UNEXPLAINED"
]);

const WEDNESDAY_AS_OF = "2026-09-15";

function asSet(ids = []) {
  return new Set((ids || []).filter(Boolean).map((id) => String(id)));
}

function compareRoyalCandidateSets(wednesdayIds = [], freshIds = []) {
  const wednesday = asSet(wednesdayIds);
  const fresh = asSet(freshIds);
  const intersection = [...wednesday].filter((id) => fresh.has(id)).sort();
  const wednesdayOnly = [...wednesday].filter((id) => !fresh.has(id)).sort();
  const freshOnly = [...fresh].filter((id) => !wednesday.has(id)).sort();
  return {
    wednesday_count: wednesday.size,
    fresh_count: fresh.size,
    intersection_count: intersection.length,
    intersection,
    wednesday_only: wednesdayOnly,
    fresh_only: freshOnly,
    comparable: wednesday.size > 0
  };
}

function classifyRoyalCandidateDelta(id, side, context = {}) {
  const departure = context.departureById?.get?.(id) || context.departureById?.[id] || null;
  const freshUnion = context.freshUnionIds instanceof Set ? context.freshUnionIds : asSet(context.freshUnionIds);
  const wednesdayUnion =
    context.wednesdayUnionIds instanceof Set ? context.wednesdayUnionIds : asSet(context.wednesdayUnionIds);
  const remap = context.identityRemapIds instanceof Set ? context.identityRemapIds : asSet(context.identityRemapIds);
  const volatility =
    context.volatilityIds instanceof Set ? context.volatilityIds : asSet(context.volatilityIds);
  const wednesdayAsOf = context.wednesdayAsOf || WEDNESDAY_AS_OF;
  const freshAsOf = context.freshAsOf || null;
  const daysWed = departure && wednesdayAsOf ? daysUntilDeparture(departure, wednesdayAsOf) : null;
  const daysFresh = departure && freshAsOf ? daysUntilDeparture(departure, freshAsOf) : null;
  const agedOut =
    daysWed != null &&
    daysFresh != null &&
    daysWed > PUBLIC_BOOKING_CUTOFF_DAYS &&
    daysFresh <= PUBLIC_BOOKING_CUTOFF_DAYS;
  const agedIn =
    daysWed != null &&
    daysFresh != null &&
    daysWed <= PUBLIC_BOOKING_CUTOFF_DAYS &&
    daysFresh > PUBLIC_BOOKING_CUTOFF_DAYS;

  if (remap.has(id)) {
    return { official_sailing_id: id, side, classification: "IDENTITY_REMAP", departure_date: departure };
  }
  if (volatility.has(id)) {
    return { official_sailing_id: id, side, classification: "SOURCE_VOLATILITY", departure_date: departure };
  }

  if (side === "wednesday_only") {
    if (agedOut) {
      return { official_sailing_id: id, side, classification: "CUT_OFF_DATE_AGING", departure_date: departure };
    }
    if (freshUnion.size && !freshUnion.has(id)) {
      return { official_sailing_id: id, side, classification: "SOURCE_REMOVED", departure_date: departure };
    }
    return { official_sailing_id: id, side, classification: "UNEXPLAINED", departure_date: departure };
  }

  if (side === "fresh_only") {
    if (agedIn) {
      return { official_sailing_id: id, side, classification: "CUT_OFF_DATE_AGING", departure_date: departure };
    }
    if (wednesdayUnion.size && !wednesdayUnion.has(id) && freshUnion.has(id)) {
      return { official_sailing_id: id, side, classification: "NEW_OFFICIAL_PUBLICATION", departure_date: departure };
    }
    if (!wednesdayUnion.size && freshUnion.has(id)) {
      return { official_sailing_id: id, side, classification: "NEW_OFFICIAL_PUBLICATION", departure_date: departure };
    }
    return { official_sailing_id: id, side, classification: "UNEXPLAINED", departure_date: departure };
  }

  return { official_sailing_id: id, side, classification: "UNEXPLAINED", departure_date: departure };
}

function classifyRoyalCandidateDeltas(compare, context = {}) {
  const classified = [
    ...(compare.wednesday_only || []).map((id) => classifyRoyalCandidateDelta(id, "wednesday_only", context)),
    ...(compare.fresh_only || []).map((id) => classifyRoyalCandidateDelta(id, "fresh_only", context))
  ];
  const counts = Object.fromEntries(P3H_DELTA_CLASSES.map((name) => [name, 0]));
  for (const row of classified) counts[row.classification] += 1;
  return { classified, counts, unexplained: classified.filter((row) => row.classification === "UNEXPLAINED") };
}

function reconstructCutoffAgingIds(products = [], wednesdayAsOf, freshAsOf) {
  const aged = [];
  for (const product of products || []) {
    const id = product.stable_identity_key || product.official_sailing_id || product.candidate?.official_sailing_id;
    const departure = product.departure_date || product.candidate?.departure_date || null;
    if (!id || !departure) continue;
    const daysWed = daysUntilDeparture(departure, wednesdayAsOf);
    const daysFresh = daysUntilDeparture(departure, freshAsOf);
    if (
      daysWed != null &&
      daysFresh != null &&
      daysWed > PUBLIC_BOOKING_CUTOFF_DAYS &&
      daysFresh <= PUBLIC_BOOKING_CUTOFF_DAYS
    ) {
      aged.push(id);
    }
  }
  return aged.sort();
}

function evaluateRoyalP3hFreezeGate({
  health = {},
  compare = {},
  deltas = {},
  classificationCounts = {},
  wednesdayIdentitiesPersisted = true,
  reconstructedAgingIds = [],
  wednesdayCandidateCount = null
} = {}) {
  const failures = [];
  if (health.weekly_maintenance_healthy !== true) failures.push("weekly_maintenance_unhealthy");
  if (health.royal_caribbean_source_enumeration_ok !== true) failures.push("source_enumeration_unhealthy");
  if (health.reconciliation_arithmetic_ok !== true) failures.push("reconciliation_arithmetic_failed");
  if ((health.review_count || 0) !== 0) failures.push("review_count_nonzero");
  if ((classificationCounts.AMBIGUOUS || 0) !== 0) failures.push("ambiguous_count_nonzero");
  if ((classificationCounts.REVIEW_REQUIRED || 0) !== 0) failures.push("incomplete_candidates");
  if ((classificationCounts.COLLISION || 0) !== 0) failures.push("collision_detected");
  if ((health.incomplete_inserts || 0) !== 0) failures.push("fresh_proposed_inserts_incomplete");

  const unexplained = deltas.unexplained || [];
  if (wednesdayIdentitiesPersisted && unexplained.length) {
    failures.push("unexplained_candidate_delta");
  }

  if (!wednesdayIdentitiesPersisted) {
    const aging = (reconstructedAgingIds || []).length;
    const wednesdayCount = Number(wednesdayCandidateCount);
    const freshCount = Number(compare.fresh_count);
    if (!Number.isFinite(wednesdayCount) || !Number.isFinite(freshCount)) {
      failures.push("candidate_counts_unavailable");
    } else {
      const expectedMin = wednesdayCount - aging;
      if (freshCount < expectedMin) failures.push("unexplained_candidate_disappearance");
    }
  }

  const deltaZero =
    compare.comparable === true &&
    (compare.wednesday_only || []).length === 0 &&
    (compare.fresh_only || []).length === 0;
  const deltaExplained = unexplained.length === 0 && (deltaZero || !wednesdayIdentitiesPersisted);

  return {
    freeze_authorised: failures.length === 0 && (deltaZero || deltaExplained),
    failures,
    delta_zero: deltaZero,
    delta_explained: deltaExplained,
    wednesday_identities_persisted: wednesdayIdentitiesPersisted,
    classification: failures.length === 0 ? "READY_FOR_CONTROLLED_CATCHUP_APPLY" : "READY_FOR_CONTROLLED_CATCHUP"
  };
}

function laterRoyalCatchupBatchesMustStop(batchResults = []) {
  const failed = (batchResults || []).find(
    (row) => row.failed_writes > 0 || row.stopped_early === true || row.ok === false
  );
  if (!failed) return { stop: false, skipped: [] };
  const skipped = (batchResults || []).filter((row) => row.batch_number > failed.batch_number);
  return {
    stop: true,
    failed_batch: failed.batch_number,
    skipped: skipped.map((row) => row.batch_number),
    later_batches_applied: skipped.some((row) => row.applied === true)
  };
}

module.exports = {
  P3H_DELTA_CLASSES,
  WEDNESDAY_AS_OF,
  compareRoyalCandidateSets,
  classifyRoyalCandidateDelta,
  classifyRoyalCandidateDeltas,
  reconstructCutoffAgingIds,
  evaluateRoyalP3hFreezeGate,
  laterRoyalCatchupBatchesMustStop
};
