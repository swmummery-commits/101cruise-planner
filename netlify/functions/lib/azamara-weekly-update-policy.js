/**
 * Azamara weekly maintenance update classification (Seabourn policy).
 * Identity-critical field changes require review — never auto-applied weekly.
 */

const IDENTITY_CRITICAL_FIELDS = [
  "ship_id",
  "departure_date",
  "return_date",
  "nights",
  "departure_port",
  "itinerary",
  "status"
];

const ALLOWED_WEEKLY_UPDATE_FIELDS = ["official_url", "raw_extract"];

function isAzamaraSourceAbsenceDeactivationEnabled(env = process.env) {
  return String(env.AZAMARA_SOURCE_ABSENCE_DEACTIVATION_ENABLED || "").trim().toLowerCase() === "true";
}

function classifyAzamaraUpdateRisk(existing, candidate) {
  if (!existing || !candidate) {
    return { risk: "none", identity_critical_changes: [], safe_metadata_changes: [] };
  }

  const identityCriticalChanges = [];
  for (const field of IDENTITY_CRITICAL_FIELDS) {
    const before = existing[field];
    const after = candidate[field];
    if (field === "status" && (after == null || after === "")) continue;
    if (String(before ?? "") !== String(after ?? "")) {
      identityCriticalChanges.push(field);
    }
  }

  const safeMetadataChanges = [];
  if (String(existing.official_url || "") !== String(candidate.official_url || "")) {
    safeMetadataChanges.push("official_url");
  }
  if (JSON.stringify(existing.raw_extract || {}) !== JSON.stringify(candidate.raw_extract || {})) {
    safeMetadataChanges.push("raw_extract");
  }

  const risk = identityCriticalChanges.length > 0 ? "identity_critical" : "safe_or_unchanged";
  return {
    risk,
    identity_critical_changes: identityCriticalChanges,
    safe_metadata_changes: safeMetadataChanges
  };
}

function refineProposedActionForWeekly(baseAction, existing, candidate) {
  if (baseAction !== "update_official_match") return baseAction;
  const assessment = classifyAzamaraUpdateRisk(existing, candidate);
  if (assessment.risk === "identity_critical") return "update_identity_review_required";
  if (assessment.safe_metadata_changes.length > 0) return "update_safe_metadata_allowed";
  return "duplicate_skip";
}

function assessAzamaraWeeklyWriteSafety({
  sourceAbsencePolicy,
  performWrites = false,
  proposedIdentityReviewUpdates = 0,
  env = process.env
} = {}) {
  const observed = Number(sourceAbsencePolicy?.source_absent_observed || 0);
  const actionable = Number(sourceAbsencePolicy?.source_absent_actionable || 0);
  const failures = [];

  if (isAzamaraSourceAbsenceDeactivationEnabled(env)) {
    failures.push("source_absence_deactivation_enabled_forbidden");
  }

  if (performWrites && actionable > 0) {
    failures.push("source_absent_actionable_blocks_weekly_writes");
  }

  if (performWrites && proposedIdentityReviewUpdates > 0) {
    failures.push("identity_critical_updates_require_review");
  }

  return {
    ok: failures.length === 0,
    failures,
    source_absent_observed: observed,
    source_absent_actionable: actionable,
    source_absence_deactivation_allowed: false,
    weekly_writes_permitted_with_observed_absence:
      performWrites && observed > 0 && actionable === 0 && failures.length === 0
  };
}

module.exports = {
  IDENTITY_CRITICAL_FIELDS,
  ALLOWED_WEEKLY_UPDATE_FIELDS,
  isAzamaraSourceAbsenceDeactivationEnabled,
  classifyAzamaraUpdateRisk,
  refineProposedActionForWeekly,
  assessAzamaraWeeklyWriteSafety
};
