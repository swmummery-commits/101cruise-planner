/**
 * Princess proposed-insert waterfall.
 *
 * Official-sailing-id matching alone can report hundreds of "new" voyages
 * after a source ID format shift. Classify every unmatched insert against
 * production before any write.
 */

const CLASSIFICATIONS = Object.freeze([
  "TRUE_NEW",
  "OFFICIAL_ID_REMAP",
  "ALTERNATE_SOURCE_ID_FORMAT",
  "PRODUCTION_IDENTITY_REGRESSION",
  "SOURCE_DUPLICATE",
  "AMBIGUOUS"
]);

function normaliseComparable(value) {
  if (value == null) return "";
  return String(value).trim();
}

function compactOfficialId(value) {
  return normaliseComparable(value).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function voyageEquivalenceKey(row = {}) {
  return [
    normaliseComparable(row.ship_id),
    String(row.departure_date || "").slice(0, 10),
    String(row.return_date || "").slice(0, 10),
    String(row.nights ?? ""),
    normaliseComparable(row.departure_port),
    normaliseComparable(row.destination_id || row.destination)
  ].join("|");
}

function voyageKeyComplete(key) {
  const parts = String(key || "").split("|");
  return parts.length === 6 && parts.every((part) => part !== "");
}

function indexProduction(productionRows = []) {
  const byOfficial = new Map();
  const byExternal = new Map();
  const byIdentity = new Map();
  const byCompactOfficial = new Map();
  const byVoyage = new Map();
  for (const row of productionRows || []) {
    if (row.official_sailing_id) {
      byOfficial.set(normaliseComparable(row.official_sailing_id), row);
      const compact = compactOfficialId(row.official_sailing_id);
      if (compact) {
        if (!byCompactOfficial.has(compact)) byCompactOfficial.set(compact, []);
        byCompactOfficial.get(compact).push(row);
      }
    }
    if (row.external_key) byExternal.set(normaliseComparable(row.external_key), row);
    if (row.identity_key) byIdentity.set(normaliseComparable(row.identity_key), row);
    const voyage = voyageEquivalenceKey(row);
    if (!byVoyage.has(voyage)) byVoyage.set(voyage, []);
    byVoyage.get(voyage).push(row);
  }
  return { byOfficial, byExternal, byIdentity, byCompactOfficial, byVoyage };
}

function classifyPrincessVoyageInsert(insert = {}, productionRows = [], indexes = null) {
  const idx = indexes || indexProduction(productionRows);
  const official = normaliseComparable(insert.official_sailing_id || insert.official_princess_sailing_id);
  const external = normaliseComparable(insert.external_key || insert.candidate?.external_key);
  const identity = normaliseComparable(insert.identity_key || insert.candidate?.identity_key);
  const voyage = voyageEquivalenceKey({
    ship_id: insert.ship_id || insert.canonical_ship_id || insert.candidate?.ship_id,
    departure_date: insert.departure_date || insert.candidate?.departure_date,
    return_date: insert.return_date || insert.candidate?.return_date,
    nights: insert.nights ?? insert.candidate?.nights,
    departure_port: insert.departure_port || insert.canonical_departure_port || insert.candidate?.departure_port,
    destination_id: insert.destination_id || insert.candidate?.destination_id
  });

  if (official && idx.byOfficial.has(official)) {
    return {
      classification: "PRODUCTION_IDENTITY_REGRESSION",
      reason: "official_sailing_id_already_present",
      matching_production: [idx.byOfficial.get(official)]
    };
  }
  if (external && idx.byExternal.has(external)) {
    return {
      classification: "PRODUCTION_IDENTITY_REGRESSION",
      reason: "external_key_already_present",
      matching_production: [idx.byExternal.get(external)],
      existing_uuid: idx.byExternal.get(external).id
    };
  }
  if (identity && idx.byIdentity.has(identity)) {
    return {
      classification: "PRODUCTION_IDENTITY_REGRESSION",
      reason: "identity_key_already_present",
      matching_production: [idx.byIdentity.get(identity)],
      existing_uuid: idx.byIdentity.get(identity).id
    };
  }

  const compact = compactOfficialId(official);
  const compactMatches = compact ? idx.byCompactOfficial.get(compact) || [] : [];
  if (compactMatches.length === 1 && normaliseComparable(compactMatches[0].official_sailing_id) !== official) {
    return {
      classification: "ALTERNATE_SOURCE_ID_FORMAT",
      reason: "official_id_punctuation_or_case_variant",
      matching_production: compactMatches,
      existing_uuid: compactMatches[0].id,
      previous_official_sailing_id: compactMatches[0].official_sailing_id,
      next_official_sailing_id: official
    };
  }
  if (compactMatches.length > 1) {
    return {
      classification: "AMBIGUOUS",
      reason: "multiple_compact_official_id_matches",
      matching_production: compactMatches
    };
  }

  if (!voyageKeyComplete(voyage)) {
    return {
      classification: "AMBIGUOUS",
      reason: "incomplete_voyage_equivalence",
      matching_production: []
    };
  }

  const voyageMatches = idx.byVoyage.get(voyage) || [];
  if (voyageMatches.length === 1) {
    const existing = voyageMatches[0];
    if (normaliseComparable(existing.official_sailing_id) === official) {
      return {
        classification: "PRODUCTION_IDENTITY_REGRESSION",
        reason: "voyage_and_official_id_already_present",
        matching_production: voyageMatches,
        existing_uuid: existing.id
      };
    }
    return {
      classification: "OFFICIAL_ID_REMAP",
      reason: "unique_voyage_equivalence_different_official_id",
      matching_production: voyageMatches,
      existing_uuid: existing.id,
      previous_official_sailing_id: existing.official_sailing_id,
      next_official_sailing_id: official
    };
  }
  if (voyageMatches.length > 1) {
    return {
      classification: "SOURCE_DUPLICATE",
      reason: "multiple_production_rows_same_voyage",
      matching_production: voyageMatches
    };
  }

  return {
    classification: "TRUE_NEW",
    reason: "no_official_external_identity_or_voyage_match",
    matching_production: []
  };
}

function classifyPrincessVoyageInsertSet(inserts = [], productionRows = []) {
  const indexes = indexProduction(productionRows);
  const classified = (inserts || []).map((insert) => ({
    official_sailing_id: insert.official_sailing_id || insert.official_princess_sailing_id || null,
    ...insert,
    ...classifyPrincessVoyageInsert(insert, productionRows, indexes)
  }));
  const counts = Object.fromEntries(CLASSIFICATIONS.map((name) => [name, 0]));
  for (const row of classified) {
    counts[row.classification] = (counts[row.classification] || 0) + 1;
  }
  return {
    total: classified.length,
    counts,
    TRUE_NEW: classified.filter((row) => row.classification === "TRUE_NEW"),
    OFFICIAL_ID_REMAP: classified.filter((row) => row.classification === "OFFICIAL_ID_REMAP"),
    ALTERNATE_SOURCE_ID_FORMAT: classified.filter((row) => row.classification === "ALTERNATE_SOURCE_ID_FORMAT"),
    PRODUCTION_IDENTITY_REGRESSION: classified.filter((row) => row.classification === "PRODUCTION_IDENTITY_REGRESSION"),
    SOURCE_DUPLICATE: classified.filter((row) => row.classification === "SOURCE_DUPLICATE"),
    AMBIGUOUS: classified.filter((row) => row.classification === "AMBIGUOUS"),
    classified
  };
}

module.exports = {
  CLASSIFICATIONS,
  compactOfficialId,
  voyageEquivalenceKey,
  classifyPrincessVoyageInsert,
  classifyPrincessVoyageInsertSet
};
