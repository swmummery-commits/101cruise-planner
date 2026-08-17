/**
 * Azamara weekly maintenance update classification (Seabourn policy).
 * Identity-critical field changes require review — never auto-applied weekly.
 */

const { resolveDepartureFromSource } = require("./discovery-departure-port");
const { azamaraStableRawExtractEquivalent } = require("./azamara-weekly-safe-metadata");

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

const STALE_FIELD_REFRESH_FIELDS = ["departure_port", "departure_date", "return_date"];

function isAzamaraSourceAbsenceDeactivationEnabled(env = process.env) {
  return String(env.AZAMARA_SOURCE_ABSENCE_DEACTIVATION_ENABLED || "").trim().toLowerCase() === "true";
}

const OFFICIAL_SAILING_DATE_RE = /^(JR|ON|PR|QS)(\d{2})(\d{2})(\d{2})-/i;

function normaliseComparableString(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalisePortName(value) {
  return normaliseComparableString(value).replace(/[()]/g, "");
}

function packageDepartureDateFromOfficialSailingId(officialSailingId) {
  const m = String(officialSailingId || "").trim().match(OFFICIAL_SAILING_DATE_RE);
  if (!m) return null;
  const year = Number(m[2]) >= 70 ? 1900 + Number(m[2]) : 2000 + Number(m[2]);
  return `${year}-${String(m[3]).padStart(2, "0")}-${String(m[4]).padStart(2, "0")}`;
}

function resolveProductionEvidencePort(existing) {
  const meta = resolveDepartureFromSource({
    title: existing?.raw_extract?.title,
    description: existing?.raw_extract?.description,
    excerpt: existing?.raw_extract?.excerpt,
    shipNames: existing?.raw_extract?.ship_name_guesses,
    shipName: existing?.matched_ship?.name,
    destinationName: existing?.destination_name || existing?.raw_extract?.destination_name
  });
  if (meta?.status === "resolved" && meta.canonicalPortName) {
    return {
      canonicalPortName: meta.canonicalPortName,
      canonicalPortId: meta.canonicalPortId || null,
      sourceField: meta.sourceField || null
    };
  }
  return {
    canonicalPortName: existing?.departure_port || null,
    canonicalPortId: existing?.raw_extract?.departure_port_meta?.canonicalPortId || null,
    sourceField: existing?.raw_extract?.departure_port_meta?.sourceField || null
  };
}

function candidatePortName(candidate) {
  return candidate?.departure_port_meta?.canonicalPortName || candidate?.departure_port || null;
}

function departurePortsEquivalent(existing, candidate) {
  const evidence = resolveProductionEvidencePort(existing);
  const candidatePort = candidatePortName(candidate);
  if (!evidence.canonicalPortName || !candidatePort) {
    return normalisePortName(existing?.departure_port) === normalisePortName(candidatePort);
  }
  if (evidence.canonicalPortId && candidate?.departure_port_meta?.canonicalPortId) {
    if (evidence.canonicalPortId === candidate.departure_port_meta.canonicalPortId) return true;
  }
  return normalisePortName(evidence.canonicalPortName) === normalisePortName(candidatePort);
}

function departureDatesEquivalent(existing, candidate) {
  const after = String(candidate?.departure_date || "");
  if (!after) return String(existing?.departure_date ?? "") === after;
  const packageDate = packageDepartureDateFromOfficialSailingId(existing?.official_sailing_id);
  const existingDate = String(existing?.departure_date || "");
  if (packageDate && after === packageDate && existingDate !== after) {
    return true;
  }
  return existingDate === after;
}

function returnDatesEquivalent(existing, candidate) {
  const after = String(candidate?.return_date || "");
  if (!after) return String(existing?.return_date ?? "") === after;
  if (
    departureDatesEquivalent(existing, candidate) &&
    Number(existing?.nights) === Number(candidate?.nights) &&
    String(existing?.departure_date || "") !== String(candidate?.departure_date || "")
  ) {
    return true;
  }
  return String(existing?.return_date ?? "") === after;
}

function itinerariesEquivalent(before, after) {
  const left = String(before ?? "").trim();
  const right = String(after ?? "").trim();
  if (!left && !right) return true;
  return left === right;
}

function identityFieldChanged(field, existing, candidate) {
  const before = existing?.[field];
  const after = candidate?.[field];
  if (field === "status" && (after == null || after === "")) return false;
  if (field === "departure_port") return !departurePortsEquivalent(existing, candidate);
  if (field === "departure_date") return !departureDatesEquivalent(existing, candidate);
  if (field === "return_date") return !returnDatesEquivalent(existing, candidate);
  if (field === "itinerary") return !itinerariesEquivalent(before, after);
  return String(before ?? "") !== String(after ?? "");
}

function staleFieldsNeedingRefresh(existing, candidate) {
  const refresh = [];
  if (
    departurePortsEquivalent(existing, candidate) &&
    normalisePortName(existing?.departure_port) !== normalisePortName(candidatePortName(candidate))
  ) {
    refresh.push("departure_port");
  }
  if (
    departureDatesEquivalent(existing, candidate) &&
    String(existing?.departure_date || "") !== String(candidate?.departure_date || "")
  ) {
    refresh.push("departure_date");
  }
  if (
    returnDatesEquivalent(existing, candidate) &&
    String(existing?.return_date || "") !== String(candidate?.return_date || "")
  ) {
    refresh.push("return_date");
  }
  return refresh.filter((field) => STALE_FIELD_REFRESH_FIELDS.includes(field));
}

function classifyAzamaraUpdateRisk(existing, candidate) {
  if (!existing || !candidate) {
    return { risk: "none", identity_critical_changes: [], safe_metadata_changes: [], stale_field_refresh: [] };
  }

  const identityCriticalChanges = [];
  for (const field of IDENTITY_CRITICAL_FIELDS) {
    if (identityFieldChanged(field, existing, candidate)) {
      identityCriticalChanges.push(field);
    }
  }

  const safeMetadataChanges = [];
  if (String(existing.official_url || "") !== String(candidate.official_url || "")) {
    safeMetadataChanges.push("official_url");
  }
  if (!azamaraStableRawExtractEquivalent(existing.raw_extract, candidate.raw_extract)) {
    safeMetadataChanges.push("raw_extract");
  }

  const staleFieldRefresh = identityCriticalChanges.length === 0 ? staleFieldsNeedingRefresh(existing, candidate) : [];

  const risk = identityCriticalChanges.length > 0 ? "identity_critical" : "safe_or_unchanged";
  return {
    risk,
    identity_critical_changes: identityCriticalChanges,
    safe_metadata_changes: safeMetadataChanges,
    stale_field_refresh: staleFieldRefresh
  };
}

function refineProposedActionForWeekly(baseAction, existing, candidate) {
  if (baseAction !== "update_official_match") return baseAction;
  const assessment = classifyAzamaraUpdateRisk(existing, candidate);
  if (assessment.risk === "identity_critical") return "update_identity_review_required";
  if (assessment.safe_metadata_changes.length > 0) return "update_safe_metadata_allowed";
  if (assessment.stale_field_refresh?.length > 0) return "duplicate_skip";
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
  STALE_FIELD_REFRESH_FIELDS,
  isAzamaraSourceAbsenceDeactivationEnabled,
  packageDepartureDateFromOfficialSailingId,
  resolveProductionEvidencePort,
  departurePortsEquivalent,
  departureDatesEquivalent,
  identityFieldChanged,
  staleFieldsNeedingRefresh,
  classifyAzamaraUpdateRisk,
  refineProposedActionForWeekly,
  assessAzamaraWeeklyWriteSafety
};
