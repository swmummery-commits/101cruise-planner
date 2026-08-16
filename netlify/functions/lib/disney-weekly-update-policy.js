/**
 * Disney Cruise Line — weekly maintenance update classification.
 * Identity-critical field changes require review — never auto-applied weekly.
 */

const DISNEY_MAX_WEEKLY_MATERIAL_WRITES = 30;

const IDENTITY_IMMUTABLE_FIELDS = Object.freeze([
  "cruise_line_id",
  "official_sailing_id",
  "external_key",
  "identity_key"
]);

const IDENTITY_CRITICAL_FIELDS = Object.freeze([
  "ship_id",
  "departure_date",
  "return_date",
  "nights",
  "departure_port",
  "destination_id",
  "status"
]);

const SAFE_METADATA_FIELDS = Object.freeze(["official_url", "source_url"]);

function isDisneyProductionWritesEnabled(env = process.env) {
  return String(env.DISNEY_DISCOVERY_PRODUCTION_WRITES || "").trim().toLowerCase() === "true";
}

function isDisneyMaintenanceScheduledEnabled(env = process.env) {
  return String(env.DISNEY_DISCOVERY_MAINTENANCE_SCHEDULED_ENABLED || "").trim().toLowerCase() === "true";
}

function isDisneySourceAbsenceDeactivationEnabled(env = process.env) {
  return (
    String(env.DISNEY_DISCOVERY_SOURCE_ABSENCE_DEACTIVATION_ENABLED || "").trim().toLowerCase() === "true"
  );
}

function classifyDisneyUpdateRisk(existing, candidate) {
  if (!existing || !candidate) {
    return { risk: "none", identity_critical_changes: [], safe_metadata_changes: [], immutable_violations: [] };
  }

  const immutableViolations = [];
  for (const field of IDENTITY_IMMUTABLE_FIELDS) {
    const before = existing[field];
    const after = candidate[field];
    if (before != null && after != null && String(before) !== String(after)) {
      immutableViolations.push(field);
    }
  }

  const identityCriticalChanges = [];
  for (const field of IDENTITY_CRITICAL_FIELDS) {
    const before = existing[field];
    const after = candidate[field];
    if (String(before ?? "") !== String(after ?? "")) {
      identityCriticalChanges.push(field);
    }
  }

  const safeMetadataChanges = [];
  for (const field of SAFE_METADATA_FIELDS) {
    if (String(existing[field] || "") !== String(candidate[field] || "")) {
      safeMetadataChanges.push(field);
    }
  }

  let risk = "safe_or_unchanged";
  if (immutableViolations.length > 0 || identityCriticalChanges.length > 0) {
    risk = "identity_critical";
  } else if (safeMetadataChanges.length > 0) {
    risk = "safe_metadata";
  }

  return {
    risk,
    identity_critical_changes: identityCriticalChanges,
    safe_metadata_changes: safeMetadataChanges,
    immutable_violations: immutableViolations
  };
}

function refineDisneyProposedActionForWeekly(baseAction, existing, candidate) {
  if (baseAction === "duplicate_skip") return baseAction;
  if (baseAction === "insert_active") return baseAction;
  if (!["update_exact_existing", "update_exact_legacy_match"].includes(baseAction)) return baseAction;

  const assessment = classifyDisneyUpdateRisk(existing, candidate);
  if (assessment.immutable_violations.length > 0 || assessment.identity_critical_changes.length > 0) {
    return "update_identity_review_required";
  }
  if (assessment.safe_metadata_changes.length > 0) return "update_safe_metadata_allowed";
  return "duplicate_skip";
}

function assessDisneyWeeklyWriteSafety({
  sourceAbsencePolicy,
  performWrites = false,
  proposedIdentityReviewUpdates = 0,
  sourceQualityGatePassed = true,
  collapseGatePassed = true
} = {}) {
  const failures = [];
  if (!sourceQualityGatePassed) failures.push("source_quality_gate_failed");
  if (!collapseGatePassed) failures.push("catastrophic_source_collapse");
  if (performWrites && proposedIdentityReviewUpdates > 0) {
    failures.push("identity_critical_updates_require_review");
  }

  return {
    ok: failures.length === 0,
    failures,
    source_absent_observed: Number(sourceAbsencePolicy?.source_absent_observed || 0),
    source_absent_confirmed: Number(sourceAbsencePolicy?.source_absent_confirmed || 0),
    hard_deletes: false,
    cancellation_inferred_from_absence: false
  };
}

function boundMaterialActions(actions = [], maxWrites = DISNEY_MAX_WEEKLY_MATERIAL_WRITES) {
  const sorted = [...actions].sort((a, b) =>
    String(a.official_sailing_id || "").localeCompare(String(b.official_sailing_id || ""))
  );
  const applied = sorted.slice(0, maxWrites);
  const deferred = sorted.slice(maxWrites);
  return {
    material_actions_total: sorted.length,
    material_actions_applied: applied.length,
    material_actions_deferred: deferred.length,
    applied,
    deferred
  };
}

module.exports = {
  DISNEY_MAX_WEEKLY_MATERIAL_WRITES,
  IDENTITY_IMMUTABLE_FIELDS,
  IDENTITY_CRITICAL_FIELDS,
  SAFE_METADATA_FIELDS,
  isDisneyProductionWritesEnabled,
  isDisneyMaintenanceScheduledEnabled,
  isDisneySourceAbsenceDeactivationEnabled,
  classifyDisneyUpdateRisk,
  refineDisneyProposedActionForWeekly,
  assessDisneyWeeklyWriteSafety,
  boundMaterialActions
};
