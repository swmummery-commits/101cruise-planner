/**
 * Disney weekly maintenance — source quality gate and catastrophic collapse guard.
 */

const COLLAPSE_THRESHOLD = 0.2;
const MAX_UNRESOLVED_DESTINATION_SAILINGS = 200;

function extractDisneyUnresolvedDestinations(simulation) {
  const products = simulation?.products || [];
  const analysis = simulation?.destination_analysis || {};
  const combinations = (analysis.unresolved || []).map((combo) => ({
    destination_code: combo.destination_code || null,
    geo_area: combo.geo_area || null,
    sailing_count: combo.sailing_count || 0,
    sample_product_names: combo.sample_product_names || [],
    sample_ports: combo.sample_ports || [],
    proposed_canonical: combo.proposed_canonical || null,
    resolution_method: combo.resolution_method || null,
    confidence: combo.confidence ?? null
  }));
  const sailings = products
    .filter((row) => row.destination_resolution?.status !== "resolved")
    .slice(0, MAX_UNRESOLVED_DESTINATION_SAILINGS)
    .map((row) => {
      const raw = row.raw || {};
      return {
        official_sailing_id: row.official_sailing_id || raw.official_product_key || raw.sailing_id || null,
        ship_name: row.ship_resolution?.ship_name || raw.ship_name || row.candidate?.ship_name || null,
        departure_date: row.candidate?.departure_date || raw.departure_date || null,
        itinerary: raw.product_name || row.candidate?.itinerary || null,
        destination_code: raw.destination_code || null,
        geo_area: raw.geo_area || null,
        raw_destination: raw.destination || raw.destination_name || null,
        proposed_canonical: row.destination_resolution?.destinationKey || null,
        resolution_method: row.destination_resolution?.method || null
      };
    });
  return {
    destination_resolution_pct:
      simulation?.quality_gate?.destination_resolution_pct ?? analysis.destination_resolution_pct ?? null,
    unresolved_combination_count: combinations.length,
    unresolved_sailing_count: products.filter((row) => row.destination_resolution?.status !== "resolved").length,
    unresolved_combinations: combinations,
    unresolved_sailings: sailings
  };
}

function evaluateDisneyWeeklySourceQualityGate(simulation) {
  const failures = [];
  const normalised = simulation?.products || [];
  const qg = simulation?.quality_gate || {};
  const snapshot = simulation?.snapshot || {};
  const expansion = snapshot?.expansion || {};
  const waterfall = simulation?.eligibility || {};
  const unresolvedDestinations = extractDisneyUnresolvedDestinations(simulation);

  const sourceTotal = normalised.length;
  if (sourceTotal <= 0) failures.push("zero_source_total");
  if (expansion.expansion_errors !== 0) failures.push("expansion_errors");
  if (qg.source_complete !== true) failures.push("source_incomplete");
  if ((qg.identity_coverage_pct ?? 0) < 100) failures.push("identity_coverage_below_100");
  if ((qg.duplicate_official_identities || 0) > 0) failures.push("identity_collisions");
  if ((qg.ship_resolution_pct ?? 0) < 100) failures.push("ship_resolution_below_100");
  if ((qg.embarkation_resolution_pct ?? 0) < 100) failures.push("embark_resolution_below_100");
  if ((qg.destination_resolution_pct ?? 0) < 100) failures.push("destination_resolution_below_100");
  if ((qg.duration_validation_pct ?? 0) < 100) failures.push("duration_integrity_below_100");
  if ((qg.endpoint_unresolved_conflicts || 0) > 0) failures.push("endpoint_unresolved_conflicts");
  if (waterfall.arithmetic?.reconciles !== true) failures.push("eligibility_arithmetic_failed");

  return {
    passed: failures.length === 0,
    failures,
    blocked: failures.length > 0,
    source_total: sourceTotal,
    source_complete: qg.source_complete === true,
    expansion_errors: expansion.expansion_errors || 0,
    identity_collisions: qg.duplicate_official_identities || 0,
    endpoint_unresolved_conflicts: qg.endpoint_unresolved_conflicts || 0,
    eligibility_arithmetic_pass: waterfall.arithmetic?.reconciles === true,
    destination_resolution_pct: unresolvedDestinations.destination_resolution_pct,
    unresolved_destinations: failures.includes("destination_resolution_below_100")
      ? unresolvedDestinations
      : null
  };
}

function evaluateDisneyCollapseGuard({ currentRawIdentities = [], previousAcceptedBaseline = null }) {
  const currentSet = new Set((currentRawIdentities || []).map(String).filter(Boolean));
  const current_source_total = currentSet.size;
  const previous_accepted_source_total =
    previousAcceptedBaseline == null ? null : Number(previousAcceptedBaseline) || 0;

  if (previous_accepted_source_total == null || previous_accepted_source_total <= 0) {
    return {
      collapse_gate_passed: true,
      previous_accepted_source_total,
      current_source_total,
      missing_count: 0,
      missing_pct: 0,
      collapse_threshold: COLLAPSE_THRESHOLD,
      accepted_baseline_updated: current_source_total
    };
  }

  const missing_count = Math.max(0, previous_accepted_source_total - current_source_total);
  const missing_pct = missing_count / previous_accepted_source_total;
  const collapse_gate_passed = missing_pct < COLLAPSE_THRESHOLD;

  return {
    collapse_gate_passed,
    previous_accepted_source_total,
    current_source_total,
    missing_count,
    missing_pct,
    collapse_threshold: COLLAPSE_THRESHOLD,
    accepted_baseline_updated: collapse_gate_passed ? current_source_total : previous_accepted_source_total
  };
}

function isDisneySourceSnapshotComplete(simulation, sourceQualityGate) {
  if (sourceQualityGate?.passed !== true) return false;
  const expansion = simulation?.snapshot?.expansion;
  if (!expansion || expansion.expansion_errors !== 0) return false;
  return (simulation?.products || []).length > 0;
}

module.exports = {
  COLLAPSE_THRESHOLD,
  MAX_UNRESOLVED_DESTINATION_SAILINGS,
  extractDisneyUnresolvedDestinations,
  evaluateDisneyWeeklySourceQualityGate,
  evaluateDisneyCollapseGuard,
  isDisneySourceSnapshotComplete
};
