/**
 * Princess weekly maintenance — positive inventory expansion and source accounting gates.
 */

const PRINCESS_ELIGIBLE_EXPANSION_REVIEW_THRESHOLD = 0.2;
const PRINCESS_WEEKLY_WRITE_CAP = 30;

const PRINCESS_ELIGIBLE_EXPANSION_REQUIRES_REVIEW = "princess_eligible_inventory_expansion_requires_review";
const PRINCESS_SOURCE_ACCOUNTING_INCOMPLETE = "princess_source_accounting_incomplete";
const PRINCESS_OUTSTANDING_INSERTS_EXCEED_WEEKLY_CAP = "princess_outstanding_inserts_exceed_weekly_cap";

function extractPreviousEligibleTotal(previousRun) {
  if (!previousRun) return null;
  const stats = previousRun.stats || previousRun;
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

function extractPrincessSourceAccounting(simulation = {}, summary = {}) {
  const fetch = simulation.fetch_result || {};
  const metrics = simulation.metrics || {};
  const normalised = simulation.products || [];
  const cruises = normalised.filter((p) => p.product_type === "cruise");
  const incomplete =
    summary.incomplete_skipped ??
    cruises.filter((p) => !p.complete_high_confidence).length;
  const withinCutoff = summary.within_public_cutoff_excluded ?? simulation.within_public_cutoff?.length ?? null;
  const cruisetours = summary.cruisetours_excluded ?? metrics.cruisetours_excluded ?? null;
  const complete =
    metrics.complete_high_confidence ??
    cruises.filter((p) => p.complete_high_confidence).length;
  const eligible = summary.eligible_total ?? metrics.complete_high_confidence ?? null;
  const expanded =
    simulation.raw_sailing_count ??
    metrics.expanded_dated_sailings ??
    fetch.products?.length ??
    fetch.audit?.expanded_sailings ??
    null;
  const rawGroups = simulation.raw_group_count ?? fetch.raw_group_count ?? summary.official_source_total ?? null;

  return {
    raw_groups: rawGroups,
    expanded_dated_sailings: expanded,
    cruise_products: cruises.length || null,
    complete_high_confidence: complete,
    incomplete,
    within_cutoff: withinCutoff,
    cruisetours_excluded: cruisetours,
    public_eligible: eligible,
    official_source_total: summary.official_source_total ?? simulation.num_found_official ?? null
  };
}

function evaluatePrincessSourceAccountingContinuity(simulation = {}, summary = {}) {
  const accounting = extractPrincessSourceAccounting(simulation, summary);
  const failures = [];

  if (accounting.expanded_dated_sailings == null) {
    failures.push("expanded_dated_sailings_missing");
  }
  if (accounting.public_eligible == null) {
    failures.push("public_eligible_missing");
  }
  if (accounting.raw_groups == null) {
    failures.push("raw_groups_missing");
  }

  const expanded = Number(accounting.expanded_dated_sailings);
  const eligible = Number(accounting.public_eligible) || 0;
  const withinCutoff = Number(accounting.within_cutoff) || 0;
  const incomplete = Number(accounting.incomplete) || 0;
  const cruisetours = Number(accounting.cruisetours_excluded) || 0;

  if (Number.isFinite(expanded) && expanded > 0) {
    const accounted = eligible + withinCutoff + incomplete + cruisetours;
    const cruiseProducts = Number(accounting.cruise_products) || expanded;
    if (Math.abs(accounted - cruiseProducts) > Math.max(5, cruiseProducts * 0.02)) {
      failures.push("eligible_arithmetic_mismatch");
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    blocked: failures.length > 0,
    accounting
  };
}

function evaluatePrincessWeeklyQualityGate({
  metrics,
  previousEligible,
  manifest,
  dryRun,
  simulation,
  summary,
  performWrites = false
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
  const expansion = evaluatePrincessEligibleExpansionAnomaly({
    currentEligible: eligible,
    previousEligible: prev,
    proposedInserts,
    weeklyWriteCap: PRINCESS_WEEKLY_WRITE_CAP
  });

  const accountingGate = evaluatePrincessSourceAccountingContinuity(simulation, summary);

  const failures = [...baseFailures];
  if (performWrites && expansion.failures.length) failures.push(...expansion.failures);
  if (!accountingGate.passed) {
    failures.push(...accountingGate.failures.map((f) => `${PRINCESS_SOURCE_ACCOUNTING_INCOMPLETE}:${f}`));
  }

  const blockApply = performWrites && (expansion.failures.length > 0 || !accountingGate.passed);

  return {
    passed: failures.length === 0,
    failures,
    blocked: blockApply,
    expansion_anomaly: expansion,
    source_accounting: accountingGate,
    auto_apply_permitted: !blockApply,
    inventory_discontinuity_detected: expansion.failures.length > 0
  };
}

module.exports = {
  PRINCESS_ELIGIBLE_EXPANSION_REVIEW_THRESHOLD,
  PRINCESS_WEEKLY_WRITE_CAP,
  PRINCESS_ELIGIBLE_EXPANSION_REQUIRES_REVIEW,
  PRINCESS_SOURCE_ACCOUNTING_INCOMPLETE,
  PRINCESS_OUTSTANDING_INSERTS_EXCEED_WEEKLY_CAP,
  extractPreviousEligibleTotal,
  evaluatePrincessEligibleExpansionAnomaly,
  extractPrincessSourceAccounting,
  evaluatePrincessSourceAccountingContinuity,
  evaluatePrincessWeeklyQualityGate
};
