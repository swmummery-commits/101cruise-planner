/**
 * Princess weekly maintenance update classification.
 * Identity-critical changes require review — never auto-applied in scheduled weekly APPLY.
 */

const IDENTITY_CRITICAL_FIELDS = [
  "official_sailing_id",
  "external_key",
  "identity_key",
  "ship_id",
  "destination_id",
  "departure_date",
  "return_date",
  "nights",
  "departure_port",
  "status"
];

const PROTECTED_IDENTITY_FIELDS = [
  "official_sailing_id",
  "external_key",
  "identity_key",
  "ship_id",
  "destination_id",
  "departure_date",
  "return_date",
  "nights",
  "departure_port",
  "status"
];

const ALLOWED_WEEKLY_UPDATE_FIELDS = ["official_url", "raw_extract", "match_confidence", "itinerary"];

const COMPARE_FIELDS = [
  "ship_id",
  "destination_id",
  "departure_date",
  "return_date",
  "nights",
  "departure_port",
  "itinerary",
  "official_url",
  "external_key",
  "identity_key",
  "status",
  "match_confidence"
];

function normaliseComparable(value) {
  if (value == null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

function diffPrincessUpdateCandidate(existing, candidate) {
  const fieldDiffs = [];
  for (const field of COMPARE_FIELDS) {
    const before = field === "raw_extract" ? existing?.raw_extract : existing?.[field];
    const after = field === "raw_extract" ? candidate?.raw_extract : candidate?.[field];
    const beforeNorm = normaliseComparable(before);
    const afterNorm = normaliseComparable(after);
    if (beforeNorm !== afterNorm) {
      fieldDiffs.push({ field, before, after });
    }
  }
  return fieldDiffs;
}

function princessItineraryNameProvenance(row) {
  const raw = row?.raw_extract && typeof row.raw_extract === "object" ? row.raw_extract : {};
  return raw.princess_itinerary_name || raw.itinerary_name || null;
}

function isPrincessItineraryLabelOnlyChange(fieldDiffs = [], existing = {}, candidate = {}) {
  const fields = new Set(fieldDiffs.map((d) => d.field));
  if (!fields.has("itinerary")) return false;
  const extra = [...fields].filter((f) => !ALLOWED_WEEKLY_UPDATE_FIELDS.includes(f));
  if (extra.length) return false;
  for (const field of PROTECTED_IDENTITY_FIELDS) {
    if (normaliseComparable(existing?.[field]) !== normaliseComparable(candidate?.[field])) {
      return false;
    }
  }
  const afterName = String(candidate?.itinerary || "").trim();
  const provenance = String(princessItineraryNameProvenance(candidate) || "").trim();
  if (!afterName || !provenance || provenance !== afterName) return false;
  return true;
}

function classifyPrincessUpdateRisk(fieldDiffs = [], existing = {}, candidate = {}) {
  if (!fieldDiffs.length) return { risk: "LOW", high_risk_fields: [], low_risk_fields: [] };
  if (isPrincessItineraryLabelOnlyChange(fieldDiffs, existing, candidate)) {
    return {
      risk: "LOW",
      high_risk_fields: [],
      low_risk_fields: fieldDiffs.map((d) => d.field),
      itinerary_label_only: true
    };
  }
  const high = [];
  const low = [];
  for (const diff of fieldDiffs) {
    if (diff.field === "itinerary") high.push(diff.field);
    else if (IDENTITY_CRITICAL_FIELDS.includes(diff.field)) high.push(diff.field);
    else if (ALLOWED_WEEKLY_UPDATE_FIELDS.includes(diff.field)) low.push(diff.field);
    else high.push(diff.field);
  }
  if (high.length) return { risk: "HIGH", high_risk_fields: high, low_risk_fields: low };
  if (low.length) return { risk: "LOW", high_risk_fields: high, low_risk_fields: low };
  return { risk: "UNEXPLAINED", high_risk_fields: high, low_risk_fields: low };
}

function classifyPrincessUpdateCategory(fieldDiffs = []) {
  const fields = new Set(fieldDiffs.map((d) => d.field));
  if (fields.has("ship_id")) return "H";
  if (fields.has("departure_date")) return "G";
  if (fields.has("return_date") || fields.has("nights")) return "F";
  if (fields.has("destination_id")) return "B";
  if (fields.has("departure_port")) return "C";
  if (fields.has("itinerary")) return "D";
  if (fields.has("official_url")) return "E";
  if (fields.has("external_key") || fields.has("identity_key") || fields.has("official_sailing_id")) return "I";
  if (fields.has("raw_extract")) return "A";
  return "L";
}

function refinePrincessProposedActionForWeekly(baseAction, existing, candidate) {
  if (baseAction !== "update_exact_legacy_match") return baseAction;
  const fieldDiffs = diffPrincessUpdateCandidate(existing, candidate);
  const risk = classifyPrincessUpdateRisk(fieldDiffs, existing, candidate);
  if (risk.risk === "LOW") return "update_safe_metadata_allowed";
  if (risk.risk === "HIGH" || risk.risk === "UNEXPLAINED") return "update_identity_review_required";
  return "update_identity_review_required";
}

module.exports = {
  IDENTITY_CRITICAL_FIELDS,
  PROTECTED_IDENTITY_FIELDS,
  ALLOWED_WEEKLY_UPDATE_FIELDS,
  COMPARE_FIELDS,
  princessItineraryNameProvenance,
  isPrincessItineraryLabelOnlyChange,
  diffPrincessUpdateCandidate,
  classifyPrincessUpdateRisk,
  classifyPrincessUpdateCategory,
  refinePrincessProposedActionForWeekly
};
