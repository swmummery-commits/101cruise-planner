/**
 * Princess weekly maintenance — positive inventory expansion and source accounting gates.
 */

const { partitionByPublicBookingCutoff } = require("./public-discovered-cruise-inventory");

const PRINCESS_ELIGIBLE_EXPANSION_REVIEW_THRESHOLD = 0.2;
const PRINCESS_WEEKLY_WRITE_CAP = 30;

const PRINCESS_ELIGIBLE_EXPANSION_REQUIRES_REVIEW = "princess_eligible_inventory_expansion_requires_review";
const PRINCESS_SOURCE_ACCOUNTING_INCOMPLETE = "princess_source_accounting_incomplete";
const PRINCESS_OUTSTANDING_INSERTS_EXCEED_WEEKLY_CAP = "princess_outstanding_inserts_exceed_weekly_cap";

const REVIEW_REQUIRED_REASONS = new Set([
  PRINCESS_ELIGIBLE_EXPANSION_REQUIRES_REVIEW,
  PRINCESS_OUTSTANDING_INSERTS_EXCEED_WEEKLY_CAP,
  "weekly_change_volume_exceeds_initial_cap"
]);

function extractPreviousEligibleTotal(previousRun) {
  if (!previousRun) return null;
  const stats = previousRun.stats || previousRun;
  if (stats.accepted_inventory_baseline === true && stats.accepted_eligible_total != null) {
    return Number(stats.accepted_eligible_total);
  }
  return stats.eligible_total ?? stats.official_eligible_total ?? null;
}

function evaluatePrincessEligibleExpansionAnomaly({
  currentEligible,
  previousEligible,
  proposedInserts = 0,
  weeklyWriteCap = PRINCESS_WEEKLY_WRITE_CAP
} = {}) {
  const failures = [];
  const warnings = [];
  const prev = previousEligible == null ? null : Number(previousEligible);
  const current = Number(currentEligible) || 0;
  const inserts = Number(proposedInserts) || 0;

  let eligibleDelta = null;
  let eligibleChangePct = null;
  if (prev != null && prev > 0) {
    eligibleDelta = current - prev;
    eligibleChangePct = Number(((eligibleDelta / prev) * 100).toFixed(4));
    if (eligibleDelta > 0 && eligibleChangePct > PRINCESS_ELIGIBLE_EXPANSION_REVIEW_THRESHOLD * 100) {
      failures.push(PRINCESS_ELIGIBLE_EXPANSION_REQUIRES_REVIEW);
    }
  }

  if (inserts > weeklyWriteCap) {
    failures.push(PRINCESS_OUTSTANDING_INSERTS_EXCEED_WEEKLY_CAP);
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
    previous_eligible_total: prev,
    current_eligible_total: current,
    eligible_delta: eligibleDelta,
    eligible_change_pct: eligibleChangePct,
    expansion_review_threshold_pct: PRINCESS_ELIGIBLE_EXPANSION_REVIEW_THRESHOLD * 100,
    proposed_inserts: inserts,
    weekly_write_cap: weeklyWriteCap,
    requires_controlled_remediation: failures.length > 0
  };
}

/**
 * Disjoint partition of Princess expanded cruise inventory.
 * Each dated sailing appears in exactly one bucket.
 *
 * Princess source exposes cruiseType=C products only — cruisetours are absent (other_excluded = 0).
 */
function computePrincessDisjointSourceAccounting({
  normalised = [],
  today,
  isEligibleProductType = () => true,
  getDepartureDate = (p) => p.candidate?.departure_date || p.departure_date || p.raw?.departure_date
} = {}) {
  const cruises = (normalised || []).filter((p) => p.product_type === "cruise");
  const cruisetours = (normalised || []).filter((p) => p.product_type === "cruisetour");
  const expanded = cruises.length;

  const { publiclyEligible: outsideCutoffPool, withinCutoff: withinPublicCutoffItems } =
    partitionByPublicBookingCutoff(cruises, getDepartureDate, today);

  let publicEligibleComplete = 0;
  let publicIncomplete = 0;

  for (const row of outsideCutoffPool) {
    if (row.complete_high_confidence && isEligibleProductType(row.product_type)) {
      publicEligibleComplete += 1;
    } else {
      publicIncomplete += 1;
    }
  }

  const withinPublicCutoff = withinPublicCutoffItems.length;
  const otherExcluded = cruisetours.length;
  const outsideCutoffTotal = publicEligibleComplete + publicIncomplete;
  const accountedTotal = withinPublicCutoff + outsideCutoffTotal + otherExcluded;
  const accountingDelta = expanded - accountedTotal;

  return {
    raw_groups: null,
    expanded_dated_sailings: expanded,
    within_public_cutoff: withinPublicCutoff,
    outside_cutoff_total: outsideCutoffTotal,
    public_eligible_complete: publicEligibleComplete,
    public_incomplete: publicIncomplete,
    other_excluded: otherExcluded,
    cruisetours_excluded: otherExcluded,
    cruisetours_absent_in_princess_source: cruisetours.length === 0,
    accounted_total: accountedTotal,
    accounting_delta: accountingDelta,
    accounting_exact: accountingDelta === 0,
    public_eligible: publicEligibleComplete,
    incomplete: publicIncomplete,
    within_cutoff: withinPublicCutoff
  };
}

function extractPrincessSourceAccounting(simulation = {}, summary = {}) {
  const fetch = simulation.fetch_result || {};
  const metrics = simulation.metrics || {};
  const normalised = simulation.products || [];
  const rawGroups =
    simulation.raw_group_count ?? fetch.raw_group_count ?? summary.official_source_total ?? null;

  const disjoint =
    summary.disjoint_accounting ||
    (normalised.length
      ? computePrincessDisjointSourceAccounting({
          normalised,
          today: summary.perth_today || undefined,
          isEligibleProductType: summary._isEligibleProductType || (() => true)
        })
      : null);

  const expanded =
    simulation.raw_sailing_count ??
    metrics.expanded_dated_sailings ??
    disjoint?.expanded_dated_sailings ??
    fetch.products?.length ??
    fetch.audit?.expanded_sailings ??
    null;

  if (disjoint) {
    return {
      raw_groups: rawGroups,
      expanded_dated_sailings: expanded ?? disjoint.expanded_dated_sailings,
      within_public_cutoff: disjoint.within_public_cutoff,
      outside_cutoff_total: disjoint.outside_cutoff_total,
      public_eligible_complete: disjoint.public_eligible_complete,
      public_incomplete: disjoint.public_incomplete,
      other_excluded: disjoint.other_excluded,
      cruisetours_excluded: disjoint.other_excluded,
      cruisetours_absent_in_princess_source: disjoint.cruisetours_absent_in_princess_source,
      accounted_total: disjoint.accounted_total,
      accounting_delta: disjoint.accounting_delta,
      accounting_exact: disjoint.accounting_exact,
      public_eligible: summary.eligible_total ?? disjoint.public_eligible_complete,
      incomplete: disjoint.public_incomplete,
      within_cutoff: disjoint.within_public_cutoff,
      official_source_total: summary.official_source_total ?? simulation.num_found_official ?? null,
      legacy_complete_high_confidence: metrics.complete_high_confidence ?? null,
      legacy_cruise_products: normalised.filter((p) => p.product_type === "cruise").length || null
    };
  }

  const cruises = normalised.filter((p) => p.product_type === "cruise");
  return {
    raw_groups: rawGroups,
    expanded_dated_sailings: expanded,
    public_eligible: summary.eligible_total ?? null,
    incomplete: summary.incomplete_skipped ?? null,
    within_cutoff: summary.within_public_cutoff_excluded ?? null,
    official_source_total: summary.official_source_total ?? simulation.num_found_official ?? null,
    accounting_exact: false,
    accounting_delta: null,
    accounted_total: null
  };
}

function evaluatePrincessSourceAccountingContinuity(simulation = {}, summary = {}) {
  const accounting = extractPrincessSourceAccounting(simulation, summary);
  const failures = [];

  if (accounting.expanded_dated_sailings == null) {
    failures.push("expanded_dated_sailings_missing");
  }
  if (accounting.public_eligible == null && accounting.public_eligible_complete == null) {
    failures.push("public_eligible_missing");
  }
  if (accounting.raw_groups == null) {
    failures.push("raw_groups_missing");
  }

  if (accounting.accounting_exact !== true) {
    if (accounting.accounting_delta !== 0) {
      failures.push("accounting_delta_nonzero");
    } else {
      failures.push("disjoint_accounting_unavailable");
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    blocked: failures.length > 0,
    accounting
  };
}

function isPrincessReviewRequiredOnly({
  reason = "",
  qualityGateFailures = [],
  writeCapReason = null
} = {}) {
  const capReason = writeCapReason || reason;
  if (capReason && REVIEW_REQUIRED_REASONS.has(capReason)) return true;

  const failures = qualityGateFailures || [];
  if (!failures.length) return false;

  const expansionOnly = failures.every(
    (f) =>
      f === PRINCESS_ELIGIBLE_EXPANSION_REQUIRES_REVIEW ||
      f === PRINCESS_OUTSTANDING_INSERTS_EXCEED_WEEKLY_CAP ||
      String(f).includes(PRINCESS_ELIGIBLE_EXPANSION_REQUIRES_REVIEW) ||
      String(f).includes(PRINCESS_OUTSTANDING_INSERTS_EXCEED_WEEKLY_CAP)
  );
  return expansionOnly;
}

function evaluatePrincessWeeklyQualityGate({
  metrics,
  previousEligible,
  manifest,
  dryRun,
  simulation,
  summary,
  performWrites = false,
  allowControlledRemediationApply = false
} = {}) {
  const baseFailures = [];
  const eligible = metrics?.eligible_total || 0;
  const prev = extractPreviousEligibleTotal(previousEligible);

  if (prev != null && prev > 0 && eligible < prev * 0.8) {
    baseFailures.push("eligible_inventory_collapse_gt_20pct");
  }
  if ((metrics?.ship_resolution_pct ?? 100) < 98) baseFailures.push("ship_resolution_below_98pct");
  if ((metrics?.departure_port_resolution_pct ?? 100) < 95) {
    baseFailures.push("departure_port_resolution_below_95pct");
  }
  if ((metrics?.destination_resolution_pct ?? 100) < 90) {
    baseFailures.push("destination_resolution_below_90pct");
  }
  if ((metrics?.identity_coverage_pct ?? 100) < 100) baseFailures.push("identity_coverage_below_100pct");
  if ((metrics?.duplicate_official_identities || 0) > 0) baseFailures.push("duplicate_official_identities");

  const proposedInserts = (manifest?.products || []).filter((p) => p.proposed_action === "insert_active").length;
  const identityReviewUpdates = (manifest?.products || []).filter(
    (p) => p.proposed_action === "update_identity_review_required"
  ).length;
  const expansion = evaluatePrincessEligibleExpansionAnomaly({
    currentEligible: eligible,
    previousEligible: prev,
    proposedInserts,
    weeklyWriteCap: PRINCESS_WEEKLY_WRITE_CAP
  });

  const accountingGate = evaluatePrincessSourceAccountingContinuity(simulation, summary);

  const failures = [...baseFailures];
  const skipExpansionBlock = allowControlledRemediationApply === true;
  if (performWrites && expansion.failures.length && !skipExpansionBlock) {
    failures.push(...expansion.failures);
  }
  if (!accountingGate.passed) {
    failures.push(...accountingGate.failures.map((f) => `${PRINCESS_SOURCE_ACCOUNTING_INCOMPLETE}:${f}`));
  }
  if (performWrites && identityReviewUpdates > 0) {
    failures.push("identity_critical_updates_require_review");
  }

  const blockApply =
    performWrites &&
    !skipExpansionBlock &&
    (expansion.failures.length > 0 || !accountingGate.passed || identityReviewUpdates > 0);

  return {
    passed: failures.length === 0,
    failures,
    blocked: blockApply,
    expansion_anomaly: expansion,
    source_accounting: accountingGate,
    auto_apply_permitted: !blockApply,
    inventory_discontinuity_detected: expansion.failures.length > 0,
    identity_review_updates: identityReviewUpdates,
    review_required:
      (performWrites && expansion.failures.length > 0 && baseFailures.length === 0 && accountingGate.passed) ||
      identityReviewUpdates > 0
  };
}

module.exports = {
  PRINCESS_ELIGIBLE_EXPANSION_REVIEW_THRESHOLD,
  PRINCESS_WEEKLY_WRITE_CAP,
  PRINCESS_ELIGIBLE_EXPANSION_REQUIRES_REVIEW,
  PRINCESS_SOURCE_ACCOUNTING_INCOMPLETE,
  PRINCESS_OUTSTANDING_INSERTS_EXCEED_WEEKLY_CAP,
  REVIEW_REQUIRED_REASONS,
  extractPreviousEligibleTotal,
  evaluatePrincessEligibleExpansionAnomaly,
  computePrincessDisjointSourceAccounting,
  extractPrincessSourceAccounting,
  evaluatePrincessSourceAccountingContinuity,
  isPrincessReviewRequiredOnly,
  evaluatePrincessWeeklyQualityGate
};
