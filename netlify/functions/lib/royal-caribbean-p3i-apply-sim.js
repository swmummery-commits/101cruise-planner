/**
 * P3I Royal normal-apply simulations. No production writes.
 */

const { evaluateRoyalCaribbeanWeeklyHealth } = require("./royal-caribbean-weekly-health");
const {
  buildRoyalCaribbeanWeeklyManifestFromDryRun,
  assertWeeklyCeilings
} = require("./royal-caribbean-weekly-manifest");

function healthyBase(overrides = {}) {
  return {
    sourceRuntimeOk: true,
    enumerationHealth: { royal_caribbean_source_enumeration_ok: true },
    reconciliationArithmeticOk: true,
    shipResolutionOk: true,
    embarkationResolutionOk: true,
    unknownStatusCount: 0,
    newEligibleCount: 0,
    proposedUpdateCount: 0,
    sourceAbsentCandidateCount: 0,
    cutoffCandidateCount: 0,
    actualWrites: 0,
    sourceAbsencePolicy: {
      source_absence_actions_allowed: false,
      source_absent_action_eligible_count: 0
    },
    performWrites: true,
    ...overrides
  };
}

function simulateRoyalNormalApplyCase(name, params) {
  const health = evaluateRoyalCaribbeanWeeklyHealth(healthyBase(params.health || {}));
  const reviewRequired = params.reviewRequired === true;
  const cutoffCandidates = params.cutoffCandidateCount || 0;
  const manifest = buildRoyalCaribbeanWeeklyManifestFromDryRun({
    dryRunResult: {
      summary: {
        source_snapshot_id: "sim-snap",
        run_id: `sim-${name}`,
        update_analysis: {
          safe_proposed_updates: (params.safeUpdates || []).map((id) => ({
            official_sailing_id: id,
            safe_fields: ["official_url"]
          })),
          review_required_updates: (params.reviewUpdates || []).map((id) => ({
            official_sailing_id: id,
            review_required_fields: ["ship_id"]
          }))
        },
        source_absence_policy: params.health?.sourceAbsencePolicy || {
          source_absence_actions_allowed: false,
          source_absent_action_eligible_count: 0,
          source_absent_candidates: [],
          source_absent_action_eligible: []
        },
        production_cutoff_candidates: Array.from({ length: cutoffCandidates }, (_, i) => ({
          id: `cutoff-${i}`,
          official_sailing_id: `CUT_${i}`,
          departure_date: "2026-10-07"
        }))
      },
      manifest: {
        products: (params.insertIds || []).map((id) => ({
          proposed_action: "insert_active",
          stable_identity_key: id,
          candidate: { official_sailing_id: id }
        }))
      }
    },
    today: "2026-09-17",
    firstActivationCycle: false
  });
  const ceilings = assertWeeklyCeilings(manifest);
  const sourceUnhealthy =
    health.source_runtime_ok !== true ||
    health.royal_caribbean_source_enumeration_ok !== true ||
    health.reconciliation_arithmetic_ok !== true;
  const volumeExceeded = health.weekly_change_volume_exceeded === true;
  const writes =
    sourceUnhealthy || reviewRequired || volumeExceeded
      ? { inserts: 0, updates: 0 }
      : {
          inserts: manifest.inserts.length,
          updates: manifest.updates.length
        };

  return {
    name,
    weekly_maintenance_healthy: health.weekly_maintenance_healthy,
    volume_exceeded: volumeExceeded,
    planned_rcl_material_writes: health.planned_rcl_material_writes,
    cutoff_hides_in_manifest: manifest.cutoff_hides.length,
    daily_expiry_managed: manifest.daily_expiry_managed_cutoff_candidates.length,
    source_absence_hides: manifest.source_absence_hides.length,
    ceilings_ok: ceilings.ok,
    ceiling_failures: ceilings.failures,
    review_required: reviewRequired,
    terminal: sourceUnhealthy
      ? "source_repair_required"
      : reviewRequired
        ? "review_required"
        : volumeExceeded
          ? "controlled_catchup_required"
          : "completed",
    writes,
    cutoff_candidates_are_rcl_material_writes: health.cutoff_candidates_are_rcl_material_writes
  };
}

module.exports = {
  simulateRoyalNormalApplyCase
};
