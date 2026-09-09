/**
 * Norwegian proposed-insert waterfall.
 *
 * Weekly matching is official_sailing_id first. A source-id format shift can
 * fill the per-run insert cap (200) while the true backlog is remaps or
 * already-active voyages. Classify against production before any write.
 */

const CLASSIFICATIONS = Object.freeze([
  "TRUE_NEW",
  "ALREADY_ACTIVE_DIFFERENT_ID",
  "ALREADY_MATCH_REQUIRED",
  "IDENTITY_FORMAT_CHANGE",
  "DUPLICATE",
  "UNRESOLVED"
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
    normaliseComparable(row.departure_port)
  ].join("|");
}

function voyageKeyComplete(key) {
  const parts = String(key || "").split("|");
  return parts.length === 5 && parts.every((part) => part !== "");
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

function statusBucket(row) {
  if (row?.status === "match_required") return "ALREADY_MATCH_REQUIRED";
  return "ALREADY_ACTIVE_DIFFERENT_ID";
}

function classifyNorwegianVoyageInsert(insert = {}, productionRows = [], indexes = null) {
  const idx = indexes || indexProduction(productionRows);
  const official = normaliseComparable(insert.official_sailing_id);
  const external = normaliseComparable(insert.external_key || insert.candidate?.external_key);
  const identity = normaliseComparable(insert.identity_key || insert.candidate?.identity_key);
  const voyage = voyageEquivalenceKey({
    ship_id: insert.ship_id || insert.candidate?.ship_id,
    departure_date: insert.departure_date || insert.candidate?.departure_date,
    return_date: insert.return_date || insert.candidate?.return_date,
    nights: insert.nights ?? insert.candidate?.nights,
    departure_port: insert.departure_port || insert.candidate?.departure_port
  });

  if (official && idx.byOfficial.has(official)) {
    const existing = idx.byOfficial.get(official);
    return {
      classification: existing.status === "match_required" ? "ALREADY_MATCH_REQUIRED" : "ALREADY_ACTIVE_DIFFERENT_ID",
      reason: "official_sailing_id_already_present",
      matching_production: [existing],
      existing_uuid: existing.id
    };
  }
  if (external && idx.byExternal.has(external)) {
    const existing = idx.byExternal.get(external);
    return {
      classification: statusBucket(existing),
      reason: "external_key_already_present",
      matching_production: [existing],
      existing_uuid: existing.id
    };
  }
  if (identity && idx.byIdentity.has(identity)) {
    const existing = idx.byIdentity.get(identity);
    return {
      classification: "IDENTITY_FORMAT_CHANGE",
      reason: "identity_key_already_present",
      matching_production: [existing],
      existing_uuid: existing.id
    };
  }

  const compact = compactOfficialId(official);
  const compactMatches = compact ? idx.byCompactOfficial.get(compact) || [] : [];
  if (compactMatches.length === 1) {
    return {
      classification: "IDENTITY_FORMAT_CHANGE",
      reason: "official_id_punctuation_or_case_variant",
      matching_production: compactMatches,
      existing_uuid: compactMatches[0].id
    };
  }
  if (compactMatches.length > 1) {
    return {
      classification: "DUPLICATE",
      reason: "multiple_compact_official_id_matches",
      matching_production: compactMatches
    };
  }

  if (!voyageKeyComplete(voyage)) {
    return { classification: "UNRESOLVED", reason: "incomplete_voyage_equivalence", matching_production: [] };
  }

  const voyageMatches = idx.byVoyage.get(voyage) || [];
  if (voyageMatches.length === 1) {
    const existing = voyageMatches[0];
    return {
      classification: statusBucket(existing),
      reason: "unique_voyage_equivalence_different_official_id",
      matching_production: voyageMatches,
      existing_uuid: existing.id,
      previous_official_sailing_id: existing.official_sailing_id,
      next_official_sailing_id: official
    };
  }
  if (voyageMatches.length > 1) {
    return {
      classification: "DUPLICATE",
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

function classifyNorwegianVoyageInsertSet(inserts = [], productionRows = []) {
  const indexes = indexProduction(productionRows);
  const classified = (inserts || []).map((insert) => ({
    official_sailing_id: insert.official_sailing_id || null,
    ...insert,
    ...classifyNorwegianVoyageInsert(insert, productionRows, indexes)
  }));
  const counts = Object.fromEntries(CLASSIFICATIONS.map((name) => [name, 0]));
  for (const row of classified) {
    counts[row.classification] = (counts[row.classification] || 0) + 1;
  }
  return {
    total: classified.length,
    counts,
    TRUE_NEW: classified.filter((row) => row.classification === "TRUE_NEW"),
    ALREADY_ACTIVE_DIFFERENT_ID: classified.filter((row) => row.classification === "ALREADY_ACTIVE_DIFFERENT_ID"),
    ALREADY_MATCH_REQUIRED: classified.filter((row) => row.classification === "ALREADY_MATCH_REQUIRED"),
    IDENTITY_FORMAT_CHANGE: classified.filter((row) => row.classification === "IDENTITY_FORMAT_CHANGE"),
    DUPLICATE: classified.filter((row) => row.classification === "DUPLICATE"),
    UNRESOLVED: classified.filter((row) => row.classification === "UNRESOLVED"),
    classified
  };
}

module.exports = {
  CLASSIFICATIONS,
  voyageEquivalenceKey,
  classifyNorwegianVoyageInsert,
  classifyNorwegianVoyageInsertSet
};
