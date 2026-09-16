/**
 * P3H forensic classification of Norwegian Wednesday material writes.
 */

const {
  voyageEquivalenceKey,
  voyageKeyComplete,
  missingNorwegianSourceFields
} = require("./norwegian-voyage-identity-classifier");
const { daysUntilDeparture, PUBLIC_BOOKING_CUTOFF_DAYS } = require("./public-discovered-cruise-inventory");

const INSERT_CLASSES = Object.freeze([
  "VALID_NEW_INSERT",
  "SHOULD_HAVE_MATCHED_EXISTING",
  "SHOULD_HAVE_MATCHED_MATCH_REQUIRED",
  "AMBIGUOUS"
]);

function present(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

function voyageOf(row = {}) {
  return voyageEquivalenceKey({
    ship_id: row.ship_id || row.candidate?.ship_id,
    departure_date: row.departure_date || row.candidate?.departure_date,
    return_date: row.return_date || row.candidate?.return_date,
    nights: row.nights ?? row.candidate?.nights,
    departure_port: row.departure_port || row.candidate?.departure_port
  });
}

function identityComplete(row = {}) {
  return (
    present(row.official_sailing_id) &&
    present(row.ship_id) &&
    present(row.departure_date) &&
    present(row.return_date) &&
    row.nights != null &&
    present(row.departure_port)
  );
}

function classifyNorwegianWednesdayInsert(row = {}, context = {}) {
  const official = row.official_sailing_id || null;
  const voyage = voyageOf(row);
  const sourceEligible = context.sourceEligible || [];
  const priorActive = (context.priorActive || []).filter((item) => item.id !== row.id);
  const priorMatchRequired = (context.priorMatchRequired || []).filter((item) => item.id !== row.id);
  const production = (context.productionRows || []).filter((item) => item.id !== row.id);

  const sourceHit = sourceEligible.find((item) => item.official_sailing_id && item.official_sailing_id === official);
  const sourceVoyageHit = sourceEligible.find((item) => voyageKeyComplete(voyage) && voyageOf(item) === voyage);
  const sourceExists = Boolean(sourceHit || sourceVoyageHit);
  const complete = identityComplete(row);
  const sourceGaps = sourceHit ? missingNorwegianSourceFields(sourceHit) : null;

  const officialActive = priorActive.filter((item) => official && item.official_sailing_id === official);
  const voyageActive = priorActive.filter((item) => voyageKeyComplete(voyage) && voyageOf(item) === voyage);
  const officialMatchRequired = priorMatchRequired.filter((item) => official && item.official_sailing_id === official);
  const voyageMatchRequired = priorMatchRequired.filter(
    (item) => voyageKeyComplete(voyage) && voyageOf(item) === voyage
  );

  const officialCollisions = production.filter((item) => official && item.official_sailing_id === official);
  const externalCollisions = production.filter(
    (item) => row.external_key && item.external_key === row.external_key
  );
  const identityCollisions = production.filter(
    (item) => row.identity_key && item.identity_key === row.identity_key
  );
  const voyageDuplicates = production.filter((item) => voyageKeyComplete(voyage) && voyageOf(item) === voyage);

  if (officialActive.length || voyageActive.length) {
    return {
      classification: "SHOULD_HAVE_MATCHED_EXISTING",
      reason: officialActive.length ? "prior_active_official_id" : "prior_active_voyage_fingerprint",
      official_sailing_id: official,
      matching_ids: [...officialActive, ...voyageActive].map((item) => item.id)
    };
  }
  if (officialMatchRequired.length || voyageMatchRequired.length) {
    return {
      classification: "SHOULD_HAVE_MATCHED_MATCH_REQUIRED",
      reason: officialMatchRequired.length
        ? "prior_match_required_official_id"
        : "prior_match_required_voyage_fingerprint",
      official_sailing_id: official,
      matching_ids: [...officialMatchRequired, ...voyageMatchRequired].map((item) => item.id)
    };
  }
  if (!sourceExists || !complete || officialCollisions.length || externalCollisions.length || identityCollisions.length) {
    return {
      classification: "AMBIGUOUS",
      reason: [
        !sourceExists && "source_voyage_missing",
        !complete && "identity_incomplete",
        officialCollisions.length && "official_id_collision",
        externalCollisions.length && "external_key_collision",
        identityCollisions.length && "identity_key_collision"
      ]
        .filter(Boolean)
        .join(","),
      official_sailing_id: official,
      source_missing_fields: sourceGaps?.missing_required || [],
      voyage_duplicates: voyageDuplicates.map((item) => item.id)
    };
  }

  return {
    classification: "VALID_NEW_INSERT",
    reason: "complete_source_backed_no_prior_equivalent",
    official_sailing_id: official,
    source_exists: true,
    identity_complete: true,
    prior_active_equivalent: 0,
    prior_match_required_equivalent: 0,
    duplicate_voyage_fingerprint: voyageDuplicates.length,
    official_id_collision: officialCollisions.length,
    external_key_collision: externalCollisions.length,
    identity_key_collision: identityCollisions.length
  };
}

function verifyNorwegianCutoffHide(row = {}, { perthToday, expectedRunId = null } = {}) {
  const days = daysUntilDeparture(row.departure_date, perthToday);
  const reason =
    row.raw_extract?.ncl_maintenance_hide_reason ||
    row.raw_extract?.expiration_reason ||
    row.raw_extract?.public_unavailability ||
    null;
  const withinCutoff = days != null && days <= PUBLIC_BOOKING_CUTOFF_DAYS;
  const cutoffReason = reason === "within_public_booking_cutoff";
  const runMatches = !expectedRunId || row.raw_extract?.expiration_run_id === expectedRunId;
  return {
    id: row.id,
    official_sailing_id: row.official_sailing_id || row.identity_key || null,
    departure_date: row.departure_date || null,
    previous_status: row.raw_extract?.previous_status || null,
    new_status: row.status || null,
    perth_as_of: perthToday,
    days_until_departure: days,
    public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    hide_reason: reason,
    expiration_run_id: row.raw_extract?.expiration_run_id || null,
    within_21_day_cutoff: withinCutoff === true && cutoffReason === true && runMatches === true,
    failures: [
      !withinCutoff && "not_within_21_day_cutoff",
      !cutoffReason && "not_cutoff_hide_reason",
      !runMatches && "expiration_run_id_mismatch",
      row.status !== "expired" && "status_not_expired"
    ].filter(Boolean)
  };
}

module.exports = {
  INSERT_CLASSES,
  classifyNorwegianWednesdayInsert,
  verifyNorwegianCutoffHide,
  identityComplete,
  voyageOf
};
