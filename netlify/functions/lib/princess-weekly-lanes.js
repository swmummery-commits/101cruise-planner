/**
 * Princess weekly Safe Lane vs Review Lane.
 *
 * A review row must not stop unrelated Safe Lane work when canonical
 * accounting is otherwise exact.
 */

const PRINCESS_WEEKLY_WRITE_CAP = 30;

const SAFE_ACTIONS = Object.freeze([
  "insert_active",
  "update_safe_metadata_allowed",
  "remap_official_id_allowed"
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildPrincessWeeklyLanes({
  safeInserts = [],
  safeUpdates = [],
  deterministicRemaps = [],
  reviewItems = [],
  unexplainedUuids = [],
  sourceHealthPass = false,
  sourceAccountingExact = false,
  canonicalAccountingExact = false,
  writeCap = PRINCESS_WEEKLY_WRITE_CAP
} = {}) {
  const laneA = [
    ...asArray(safeInserts).map((row) => ({ ...row, lane: "A", action: row.action || "insert_active" })),
    ...asArray(safeUpdates).map((row) => ({
      ...row,
      lane: "A",
      action: row.action || "update_safe_metadata_allowed"
    })),
    ...asArray(deterministicRemaps).map((row) => ({
      ...row,
      lane: "A",
      action: row.action || "remap_official_id_allowed"
    }))
  ];
  const laneB = [
    ...asArray(reviewItems).map((row) => ({ ...row, lane: "B" })),
    ...asArray(unexplainedUuids).map((uuid) => ({
      discovered_cruise_id: uuid,
      lane: "B",
      action: "unexplained_active",
      reason: "unexplained_active_row"
    }))
  ];

  const unexplainedCount = asArray(unexplainedUuids).length;
  const combinedSafe = laneA.length;
  const writeCapPass = combinedSafe <= Number(writeCap || PRINCESS_WEEKLY_WRITE_CAP);
  const eachTargetSafe = laneA.every((row) => SAFE_ACTIONS.includes(row.action));

  const canRunSafeLane =
    sourceHealthPass === true &&
    sourceAccountingExact === true &&
    canonicalAccountingExact === true &&
    unexplainedCount === 0 &&
    writeCapPass &&
    eachTargetSafe;

  return {
    lane_a_safe: laneA,
    lane_b_review: laneB,
    safe_count: laneA.length,
    review_count: asArray(reviewItems).length,
    unexplained_count: unexplainedCount,
    write_cap: Number(writeCap || PRINCESS_WEEKLY_WRITE_CAP),
    write_cap_pass: writeCapPass,
    each_target_safe: eachTargetSafe,
    can_run_safe_lane: canRunSafeLane,
    review_does_not_block_safe_lane: canRunSafeLane && asArray(reviewItems).length > 0,
    blocked_reason: canRunSafeLane
      ? null
      : unexplainedCount > 0
        ? "unexplained_active_rows"
        : !sourceHealthPass
          ? "source_health_failed"
          : !sourceAccountingExact
            ? "source_accounting_inexact"
            : !canonicalAccountingExact
              ? "canonical_accounting_inexact"
              : !writeCapPass
                ? "weekly_change_volume_exceeds_initial_cap"
                : "safe_lane_target_failed_gate"
  };
}

function freezePrincessMaterialPlan(lanes, extras = {}) {
  const crypto = require("crypto");
  const plan = {
    lane_a_safe: (lanes.lane_a_safe || []).map((row) => ({
      action: row.action,
      official_sailing_id: row.official_sailing_id || row.new_official_sailing_id || null,
      discovered_cruise_id: row.discovered_cruise_id || row.production_uuid || null,
      existing_record_id: row.existing_record_id || row.production_uuid || null
    })),
    lane_b_review: (lanes.lane_b_review || []).map((row) => ({
      action: row.action || row.classification || "review",
      official_sailing_id: row.official_sailing_id || row.new_official_sailing_id || null,
      discovered_cruise_id: row.discovered_cruise_id || row.production_uuid || null
    })),
    can_run_safe_lane: lanes.can_run_safe_lane === true,
    ...extras
  };
  const planHash = crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  return { ...plan, plan_hash: planHash };
}

module.exports = {
  PRINCESS_WEEKLY_WRITE_CAP,
  SAFE_ACTIONS,
  buildPrincessWeeklyLanes,
  freezePrincessMaterialPlan
};
