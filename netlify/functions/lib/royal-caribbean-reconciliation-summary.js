/**
 * Royal Caribbean inventory reconciliation arithmetic for dry-run reporting.
 */

function buildRoyalCaribbeanReconciliationArithmetic({
  uniqueSailings = 0,
  oceanCruises = 0,
  oceanCruisetours = 0,
  unknownProducts = 0,
  otherProductTypes = 0,
  oceanIncomplete = 0,
  oceanEligible = 0,
  oceanWithinCutoff = 0,
  oceanPast = 0,
  oceanUnfamiliarStatus = 0,
  oceanOtherExclusions = 0,
  recognisedExistingEligible = 0,
  outstandingEligibleInserts = 0,
  proposedUpdates = 0
} = {}) {
  const productAccounted = oceanCruises + oceanCruisetours + unknownProducts + otherProductTypes;
  const productOk = uniqueSailings === productAccounted;

  const oceanAccounted =
    oceanIncomplete +
    oceanEligible +
    oceanWithinCutoff +
    oceanPast +
    oceanUnfamiliarStatus +
    oceanOtherExclusions;
  const oceanOk = oceanCruises === oceanAccounted;

  const eligibleAccounted = recognisedExistingEligible + outstandingEligibleInserts + proposedUpdates;
  const eligibleOk = oceanEligible === eligibleAccounted;

  return {
    source_unique_sailings: uniqueSailings,
    product_accounted: productAccounted,
    product_arithmetic_ok: productOk,
    ordinary_ocean: oceanCruises,
    cruisetour_excluded: oceanCruisetours,
    unknown_products: unknownProducts,
    other_product_types: otherProductTypes,
    ocean_incomplete: oceanIncomplete,
    ocean_eligible: oceanEligible,
    ocean_within_cutoff: oceanWithinCutoff,
    ocean_past: oceanPast,
    ocean_unfamiliar_status: oceanUnfamiliarStatus,
    ocean_other_exclusions: oceanOtherExclusions,
    ocean_accounted: oceanAccounted,
    ocean_arithmetic_ok: oceanOk,
    recognised_existing_eligible: recognisedExistingEligible,
    outstanding_eligible_inserts: outstandingEligibleInserts,
    proposed_updates: proposedUpdates,
    eligible_accounted: eligibleAccounted,
    eligible_arithmetic_ok: eligibleOk,
    reconciliation_arithmetic_ok: productOk && oceanOk && eligibleOk
  };
}

function evaluateRoyalCaribbeanDryRunHealth({
  simulation,
  arithmetic,
  manifest,
  actualWrites = 0,
  enumerationHealth = null
}) {
  const failures = [];
  if (!simulation?.ok && enumerationHealth?.royal_caribbean_source_enumeration_ok !== true) {
    failures.push("source_fetch_failed");
  }
  if (simulation?.pagination?.incomplete_pagination && enumerationHealth?.royal_caribbean_source_enumeration_ok !== true) {
    failures.push("incomplete_pagination");
  }
  if ((simulation?.pagination?.pages_failed || 0) > 0) failures.push("failed_pages");
  if (enumerationHealth && enumerationHealth.royal_caribbean_source_enumeration_ok !== true) {
    failures.push("source_enumeration_unhealthy");
  }
  if (!arithmetic?.reconciliation_arithmetic_ok) failures.push("reconciliation_arithmetic_failed");
  const products = simulation?.products || [];
  const withId = products.filter((p) => p.official_sailing_id);
  if (withId.length !== products.length) failures.push("identity_coverage_below_100pct");
  const ids = withId.map((p) => p.official_sailing_id);
  if (new Set(ids).size !== ids.length) failures.push("duplicate_official_identities");
  if (Number(actualWrites) !== 0) failures.push("unexpected_writes");
  const writes = (manifest?.products || []).filter((p) =>
    ["insert_active", "update_exact_legacy_match"].includes(p.proposed_action)
  );
  if (writes.some((p) => String(p.product_type || "").includes("cruisetour"))) {
    failures.push("cruisetour_in_proposed_write_set");
  }
  const insertKeys = new Set();
  for (const p of writes.filter((w) => w.proposed_action === "insert_active")) {
    if (insertKeys.has(p.stable_identity_key)) failures.push("duplicate_insert_identity");
    insertKeys.add(p.stable_identity_key);
  }
  return { passed: failures.length === 0, failures };
}

module.exports = {
  buildRoyalCaribbeanReconciliationArithmetic,
  evaluateRoyalCaribbeanDryRunHealth
};
