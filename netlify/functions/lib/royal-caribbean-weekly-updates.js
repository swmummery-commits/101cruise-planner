/**
 * Royal Caribbean weekly update classification — safe operational refresh vs review-required.
 */

const SAFE_UPDATE_FIELDS = new Set([
  "official_url",
  "booking_url",
  "sailing_status",
  "return_date",
  "nights",
  "departure_port"
]);

const REVIEW_REQUIRED_FIELDS = new Set([
  "ship_id",
  "destination_id",
  "departure_date",
  "identity_key",
  "official_sailing_id",
  "itinerary"
]);

function compareRoyalCaribbeanProductionUpdate(existing, candidate) {
  if (!existing || !candidate) return { changed_fields: [], safe: [], review_required: [], no_change: true };
  const pairs = [
    ["ship_id", existing.ship_id, candidate.ship_id],
    ["destination_id", existing.destination_id, candidate.destination_id],
    ["departure_date", existing.departure_date, candidate.departure_date],
    ["return_date", existing.return_date, candidate.return_date],
    ["nights", existing.nights, candidate.nights],
    ["departure_port", existing.departure_port, candidate.departure_port],
    ["official_url", existing.official_url, candidate.official_url],
    ["sailing_status", existing.raw_extract?.sailing_status, candidate.raw_extract?.sailing_status]
  ];
  const changedFields = [];
  const safe = [];
  const reviewRequired = [];
  for (const [field, before, after] of pairs) {
    if (String(before ?? "") === String(after ?? "")) continue;
    changedFields.push({ field, before, after });
    if (REVIEW_REQUIRED_FIELDS.has(field)) reviewRequired.push(field);
    else if (SAFE_UPDATE_FIELDS.has(field)) safe.push(field);
    else reviewRequired.push(field);
  }
  if (String(existing.itinerary || "") !== String(candidate.itinerary || "")) {
    changedFields.push({
      field: "itinerary",
      before: existing.itinerary,
      after: candidate.itinerary
    });
    reviewRequired.push("itinerary");
  }
  return {
    changed_fields: changedFields,
    safe,
    review_required: [...new Set(reviewRequired)],
    no_change: changedFields.length === 0
  };
}

function classifyRoyalCaribbeanWeeklyUpdates(manifestProducts = [], existingBySailingId = new Map()) {
  const safeUpdates = [];
  const reviewRequired = [];
  let noChange = 0;
  for (const entry of manifestProducts) {
    if (entry.proposed_action !== "update_exact_legacy_match") {
      if (entry.proposed_action === "duplicate_skip") noChange += 1;
      continue;
    }
    const existing = existingBySailingId.get(entry.stable_identity_key);
    const diff = compareRoyalCaribbeanProductionUpdate(existing, entry.candidate);
    const record = {
      official_sailing_id: entry.stable_identity_key,
      changed_fields: diff.changed_fields,
      safe_fields: diff.safe,
      review_required_fields: diff.review_required,
      proposed_action: diff.review_required.length ? "review_required_update" : "proposed_safe_update"
    };
    if (diff.review_required.length) reviewRequired.push(record);
    else safeUpdates.push(record);
  }
  return {
    safe_update_allowlist: [...SAFE_UPDATE_FIELDS],
    review_required_fields: [...REVIEW_REQUIRED_FIELDS],
    safe_proposed_updates: safeUpdates,
    review_required_updates: reviewRequired,
    no_change_records: noChange,
    identity_mutation_forbidden: true
  };
}

function assertNoIdentityMutation(existingKey, incomingKey) {
  if (!existingKey || !incomingKey) return true;
  return String(existingKey) === String(incomingKey);
}

module.exports = {
  SAFE_UPDATE_FIELDS,
  REVIEW_REQUIRED_FIELDS,
  compareRoyalCaribbeanProductionUpdate,
  classifyRoyalCaribbeanWeeklyUpdates,
  assertNoIdentityMutation
};
