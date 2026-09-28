/**
 * Princess official-ID remap classification.
 *
 * A supplier sailing-ID change is not automatically identity-critical.
 * DETERMINISTIC_REMAP requires a proven one-to-one voyage identity across
 * two source snapshots. Anything less is review-only.
 */

const { voyageEquivalenceKey, compactOfficialId } = require("./princess-voyage-identity-classifier");

const REMAP_CLASSES = Object.freeze([
  "DETERMINISTIC_REMAP",
  "AMBIGUOUS_REMAP",
  "TRUE_IDENTITY_CHANGE",
  "NOT_SAME_VOYAGE"
]);

function normalise(value) {
  if (value == null) return "";
  return String(value).trim();
}

function dateOnly(value) {
  return String(value || "").slice(0, 10);
}

function voyageFields(row = {}) {
  return {
    official_sailing_id: normalise(row.official_sailing_id || row.official_princess_sailing_id),
    ship_id: normalise(row.ship_id || row.canonical_ship_id),
    departure_date: dateOnly(row.departure_date),
    return_date: dateOnly(row.return_date),
    nights: row.nights == null || row.nights === "" ? "" : String(row.nights),
    departure_port: normalise(row.departure_port || row.canonical_departure_port),
    destination_id: normalise(row.destination_id || row.destination || row.canonical_destination_id),
    external_key: normalise(row.external_key),
    identity_key: normalise(row.identity_key),
    itinerary: normalise(row.itinerary)
  };
}

function comparePrincessVoyageIdentityFields(left = {}, right = {}) {
  const a = voyageFields(left);
  const b = voyageFields(right);
  const fields = [
    "official_sailing_id",
    "ship_id",
    "departure_date",
    "return_date",
    "nights",
    "departure_port",
    "destination_id",
    "external_key",
    "identity_key",
    "itinerary"
  ];
  const diffs = [];
  const matches = {};
  for (const field of fields) {
    const same = a[field] === b[field];
    matches[field] = same;
    if (!same) diffs.push({ field, production: a[field] || null, source: b[field] || null });
  }
  return {
    production: a,
    source: b,
    matches,
    diffs,
    identity_core_equal:
      matches.ship_id &&
      matches.departure_date &&
      matches.return_date &&
      matches.nights &&
      matches.departure_port &&
      matches.destination_id
  };
}

function indexByOfficial(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    const official = voyageFields(row).official_sailing_id;
    if (!official) continue;
    if (!map.has(official)) map.set(official, []);
    map.get(official).push(row);
  }
  return map;
}

function voyageMatches(productionRow, sourceRows = []) {
  const key = voyageEquivalenceKey(productionRow);
  if (!key || key.split("|").some((part) => part === "")) return [];
  return (sourceRows || []).filter((row) => voyageEquivalenceKey(row) === key);
}

function snapshotAgreesOnIdentity(snapshotOfficialIds, officialId) {
  if (!snapshotOfficialIds) return false;
  const set = snapshotOfficialIds instanceof Set ? snapshotOfficialIds : new Set(snapshotOfficialIds);
  return set.has(normalise(officialId));
}

function hasCollision({ productionRow, sourceCandidate, productionRows = [] }) {
  const nextOfficial = voyageFields(sourceCandidate).official_sailing_id;
  const nextExternal = voyageFields(sourceCandidate).external_key;
  const nextIdentity = voyageFields(sourceCandidate).identity_key;
  const others = (productionRows || []).filter(
    (row) => normalise(row.id) && normalise(row.id) !== normalise(productionRow.id)
  );
  const officialCollision = others.some((row) => voyageFields(row).official_sailing_id === nextOfficial);
  const externalCollision =
    nextExternal && others.some((row) => voyageFields(row).external_key === nextExternal);
  const identityCollision =
    nextIdentity && others.some((row) => voyageFields(row).identity_key === nextIdentity);
  return {
    official_id_collision: officialCollision,
    external_key_collision: Boolean(externalCollision),
    identity_key_collision: Boolean(identityCollision),
    any: officialCollision || Boolean(externalCollision) || Boolean(identityCollision)
  };
}

/**
 * Classify one production row against the current eligible source set.
 * Two snapshot identity sets are required before DETERMINISTIC_REMAP.
 */
function classifyPrincessIdentityRemap({
  productionRow,
  sourceCandidates = [],
  productionRows = [],
  snapshotAOfficialIds = null,
  snapshotBOfficialIds = null
} = {}) {
  const production = voyageFields(productionRow);
  const failures = [];
  if (!productionRow?.id) failures.push("missing_production_uuid");
  if (!production.official_sailing_id) failures.push("missing_production_official_id");
  if (!production.ship_id || !production.departure_date || !production.return_date) {
    failures.push("incomplete_production_voyage");
  }

  const sourceByOfficial = indexByOfficial(sourceCandidates);
  const oldStillPresent = sourceByOfficial.has(production.official_sailing_id);
  const matches = voyageMatches(productionRow, sourceCandidates);
  const uniqueMatchIds = [...new Set(matches.map((row) => voyageFields(row).official_sailing_id).filter(Boolean))];

  if (oldStillPresent) {
    return {
      classification: "NOT_SAME_VOYAGE",
      reason: "old_official_id_still_present_in_source",
      production_uuid: productionRow?.id || null,
      old_official_sailing_id: production.official_sailing_id,
      new_official_sailing_id: null,
      comparison: null,
      failures: ["old_source_id_present"],
      write_allowed: false
    };
  }

  if (matches.length === 0) {
    return {
      classification: "NOT_SAME_VOYAGE",
      reason: "no_voyage_equivalent_source_candidate",
      production_uuid: productionRow?.id || null,
      old_official_sailing_id: production.official_sailing_id,
      new_official_sailing_id: null,
      comparison: null,
      failures: ["no_source_candidate"],
      write_allowed: false
    };
  }

  if (matches.length !== 1 || uniqueMatchIds.length !== 1) {
    return {
      classification: "AMBIGUOUS_REMAP",
      reason: "competing_source_candidates",
      production_uuid: productionRow?.id || null,
      old_official_sailing_id: production.official_sailing_id,
      new_official_sailing_id: uniqueMatchIds[0] || null,
      competing_official_ids: uniqueMatchIds,
      comparison: matches.map((row) => comparePrincessVoyageIdentityFields(productionRow, row)),
      failures: ["competing_candidate"],
      write_allowed: false
    };
  }

  const sourceCandidate = matches[0];
  const source = voyageFields(sourceCandidate);
  const comparison = comparePrincessVoyageIdentityFields(productionRow, sourceCandidate);
  if (!comparison.identity_core_equal) {
    return {
      classification: "TRUE_IDENTITY_CHANGE",
      reason: "voyage_identity_fields_disagree",
      production_uuid: productionRow.id,
      old_official_sailing_id: production.official_sailing_id,
      new_official_sailing_id: source.official_sailing_id,
      comparison,
      failures: comparison.diffs.map((d) => d.field),
      write_allowed: false
    };
  }

  const productionSameVoyage = [];
  const seenProduction = new Set();
  for (const row of productionRows || []) {
    const uuid = normalise(row.id);
    if (uuid && seenProduction.has(uuid)) continue;
    if (uuid) seenProduction.add(uuid);
    if (voyageEquivalenceKey(row) === voyageEquivalenceKey(productionRow)) {
      productionSameVoyage.push(row);
    }
  }
  if (productionSameVoyage.length !== 1) {
    return {
      classification: "AMBIGUOUS_REMAP",
      reason: "multiple_production_uuids_same_voyage",
      production_uuid: productionRow.id,
      old_official_sailing_id: production.official_sailing_id,
      new_official_sailing_id: source.official_sailing_id,
      comparison,
      failures: ["competing_production_uuid"],
      write_allowed: false
    };
  }

  const collisions = hasCollision({ productionRow, sourceCandidate, productionRows });
  if (collisions.any) {
    return {
      classification: "AMBIGUOUS_REMAP",
      reason: "identity_collision",
      production_uuid: productionRow.id,
      old_official_sailing_id: production.official_sailing_id,
      new_official_sailing_id: source.official_sailing_id,
      comparison,
      collisions,
      failures: Object.entries(collisions)
        .filter(([key, value]) => key !== "any" && value)
        .map(([key]) => key),
      write_allowed: false
    };
  }

  const newPresent = Boolean(source.official_sailing_id);
  if (!newPresent) {
    return {
      classification: "AMBIGUOUS_REMAP",
      reason: "new_official_id_missing",
      production_uuid: productionRow.id,
      old_official_sailing_id: production.official_sailing_id,
      new_official_sailing_id: null,
      comparison,
      failures: ["new_source_id_absent"],
      write_allowed: false
    };
  }

  const twoSnapshots =
    snapshotAOfficialIds != null &&
    snapshotBOfficialIds != null &&
    snapshotAgreesOnIdentity(snapshotAOfficialIds, source.official_sailing_id) &&
    snapshotAgreesOnIdentity(snapshotBOfficialIds, source.official_sailing_id) &&
    !snapshotAgreesOnIdentity(snapshotAOfficialIds, production.official_sailing_id) &&
    !snapshotAgreesOnIdentity(snapshotBOfficialIds, production.official_sailing_id);

  if (!twoSnapshots) {
    return {
      classification: "AMBIGUOUS_REMAP",
      reason: "two_source_snapshots_required",
      production_uuid: productionRow.id,
      old_official_sailing_id: production.official_sailing_id,
      new_official_sailing_id: source.official_sailing_id,
      comparison,
      failures: ["two_snapshots_not_agreed"],
      write_allowed: false,
      deterministic_candidate: true
    };
  }

  return {
    classification: "DETERMINISTIC_REMAP",
    reason: "one_to_one_voyage_identity_two_snapshots",
    production_uuid: productionRow.id,
    old_official_sailing_id: production.official_sailing_id,
    new_official_sailing_id: source.official_sailing_id,
    old_external_key: production.external_key || null,
    new_external_key: source.external_key || null,
    old_identity_key: production.identity_key || null,
    new_identity_key: source.identity_key || null,
    comparison,
    compact_id_variant:
      compactOfficialId(production.official_sailing_id) === compactOfficialId(source.official_sailing_id),
    failures: [],
    write_allowed: true
  };
}

function classifyPrincessRemapSet({
  productionRows = [],
  sourceCandidates = [],
  snapshotAOfficialIds = null,
  snapshotBOfficialIds = null
} = {}) {
  const classified = (productionRows || []).map((row) =>
    classifyPrincessIdentityRemap({
      productionRow: row,
      sourceCandidates,
      productionRows,
      snapshotAOfficialIds,
      snapshotBOfficialIds
    })
  );
  return {
    classified,
    DETERMINISTIC_REMAP: classified.filter((row) => row.classification === "DETERMINISTIC_REMAP"),
    AMBIGUOUS_REMAP: classified.filter((row) => row.classification === "AMBIGUOUS_REMAP"),
    TRUE_IDENTITY_CHANGE: classified.filter((row) => row.classification === "TRUE_IDENTITY_CHANGE"),
    NOT_SAME_VOYAGE: classified.filter((row) => row.classification === "NOT_SAME_VOYAGE")
  };
}

module.exports = {
  REMAP_CLASSES,
  voyageFields,
  comparePrincessVoyageIdentityFields,
  classifyPrincessIdentityRemap,
  classifyPrincessRemapSet
};
