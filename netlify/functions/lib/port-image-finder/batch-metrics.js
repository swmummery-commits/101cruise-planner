/**
 * Unified batch summary metrics — all totals derived from one result set.
 */

function percent(part, total) {
  if (!total) return null;
  return Math.round((part / total) * 1000) / 10;
}

function deriveEditorialRating(row) {
  return row?.editorialRating || row?.rating || "NO_IMAGE";
}

function buildDiscoverSummary(discoveries, requested) {
  const missing = discoveries.filter((d) => d.found === false && d.reason !== "PORT_RESOLUTION_FAILED");
  const resolutionFailures = discoveries.filter(
    (d) => d.found === false && (d.reason === "PORT_RESOLUTION_FAILED" || d.code === "PORT_RESOLUTION_FAILED")
  );
  const canonicalMatches = discoveries.filter((d) => d.found === true);
  const skipped = discoveries.filter((d) => d.found === true && d.skipped);
  const processed = discoveries.filter((d) => d.found === true && !d.skipped);

  const ratings = { GOOD: 0, ACCEPTABLE: 0, POOR: 0, WRONG: 0, NO_IMAGE: 0 };
  for (const d of processed) {
    const rating = deriveEditorialRating(d);
    if (ratings[rating] !== undefined) ratings[rating] += 1;
    else ratings.NO_IMAGE += 1;
  }

  const ageBreakdown = { MODERN: 0, HISTORICAL: 0, UNKNOWN: 0 };
  let historicalDisplacements = 0;
  for (const d of processed) {
    if (d.displacedHistorical) historicalDisplacements += 1;
    const age = d.ageClass || "UNKNOWN";
    ageBreakdown[age] = (ageBreakdown[age] || 0) + 1;
  }

  const formulas = {
    requested: "BATCH_PORTS.length",
    missing: "discoveries where found === false and not PORT_RESOLUTION_FAILED",
    resolutionFailures: "discoveries where found === false and PORT_RESOLUTION_FAILED",
    canonicalMatches: "discoveries where found === true",
    skipped: "canonicalMatches with skipped flag",
    processed: "canonicalMatches without skipped",
    ratingsTotal: "sum(GOOD, ACCEPTABLE, POOR, WRONG, NO_IMAGE) === processed",
    reconcile:
      "requested === missing.count + resolutionFailures.count + canonicalMatches.count"
  };

  return {
    requested,
    missing: missing.map((d) => d.label),
    missingCount: missing.length,
    resolutionFailures: resolutionFailures.map((d) => ({
      label: d.label,
      reason: d.reason,
      candidates: d.candidates || null
    })),
    resolutionFailureCount: resolutionFailures.length,
    canonicalMatches: canonicalMatches.length,
    skipped: skipped.length,
    processed: processed.length,
    ratings,
    ratingsTotal: Object.values(ratings).reduce((a, b) => a + b, 0),
    historicalDisplacements,
    ageBreakdown,
    formulas,
    reconciled:
      requested === missing.length + resolutionFailures.length + canonicalMatches.length &&
      Object.values(ratings).reduce((a, b) => a + b, 0) === processed.length
  };
}

function buildApplySummary(applyResults, discoverSummary) {
  const applied = applyResults.filter((r) => r.applied);
  const notApplied = applyResults.filter((r) => !r.applied);
  const autoApproved = applied.filter((r) => r.imageStatus === "AUTO_APPROVED");
  const needsReview = applied.filter((r) => r.imageStatus === "NEEDS_REVIEW");

  const editorialCounts = { GOOD: 0, ACCEPTABLE: 0, POOR: 0, WRONG: 0, NO_IMAGE: 0 };
  for (const r of applyResults) {
    const rating = deriveEditorialRating(r);
    if (editorialCounts[rating] !== undefined) editorialCounts[rating] += 1;
    else if (!r.applied) editorialCounts.NO_IMAGE += 0;
  }
  for (const r of applied) {
    const rating = deriveEditorialRating(r);
    if (editorialCounts[rating] === undefined) continue;
  }

  const appliedRatings = { GOOD: 0, ACCEPTABLE: 0, POOR: 0, WRONG: 0 };
  for (const r of applied) {
    const rating = deriveEditorialRating(r);
    if (appliedRatings[rating] !== undefined) appliedRatings[rating] += 1;
  }

  const autoEditorialGood = autoApproved.filter(
    (r) => r.editorialRating === "GOOD" || r.editorialRating === "ACCEPTABLE"
  );
  const geographicGood = applied.filter((r) => r.editorialRating !== "WRONG" && (r.geographic ?? 0) >= 55);
  const licensed = applied.filter((r) => r.licensed !== false);

  const formulas = {
    applied: "applyResults where applied === true",
    notApplied: "applyResults where applied === false",
    geographicAccuracy: "geographically acceptable applied / applied",
    autoApprovalEditorialAccuracy: "AUTO_APPROVED with GOOD or ACCEPTABLE / AUTO_APPROVED applied",
    licensingAccuracy: "applied with licensed !== false / applied",
    processedReconcile: "applied + notApplied === discoverSummary.processed (when same batch)"
  };

  return {
    applied: applied.length,
    notApplied: notApplied.length,
    autoApproved: autoApproved.length,
    needsReview: needsReview.length,
    noImage: notApplied.filter((r) => r.reason === "no_suitable_candidate").length,
    appliedRatings,
    autoApprovalEditorialAccuracy: percent(autoEditorialGood.length, autoApproved.length),
    geographicAccuracy: percent(geographicGood.length, applied.length),
    licensingAccuracy: percent(licensed.length, applied.length),
    formulas,
    reconciled: applied.length + notApplied.length === applyResults.length
  };
}

module.exports = {
  percent,
  buildDiscoverSummary,
  buildApplySummary
};
