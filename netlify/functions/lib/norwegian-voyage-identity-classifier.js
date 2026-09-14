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

const P3B_CLASSIFICATIONS = Object.freeze([
  "RECOGNISED",
  "UNIQUE_ID_REMAP",
  "TRUE_NEW",
  "ALREADY_MATCH_REQUIRED",
  "MULTIPLE_PRODUCTION_MATCHES",
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
    normaliseComparable(row.departure_port)
  ].join("|");
}

function voyageKeyComplete(key) {
  const parts = String(key || "").split("|");
  return parts.length === 5 && parts.every((part) => part !== "");
}

function pushIndex(map, key, row) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(row);
}

function indexProduction(productionRows = []) {
  const byOfficial = new Map();
  const byOfficialAll = new Map();
  const byExternal = new Map();
  const byExternalAll = new Map();
  const byIdentity = new Map();
  const byIdentityAll = new Map();
  const byCompactOfficial = new Map();
  const byVoyage = new Map();
  const seenIds = new Set();
  for (const row of productionRows || []) {
    if (row?.id) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
    }
    if (row.official_sailing_id) {
      const official = normaliseComparable(row.official_sailing_id);
      byOfficial.set(official, row);
      pushIndex(byOfficialAll, official, row);
      const compact = compactOfficialId(row.official_sailing_id);
      if (compact) {
        if (!byCompactOfficial.has(compact)) byCompactOfficial.set(compact, []);
        byCompactOfficial.get(compact).push(row);
      }
    }
    if (row.external_key) {
      const external = normaliseComparable(row.external_key);
      byExternal.set(external, row);
      pushIndex(byExternalAll, external, row);
    }
    if (row.identity_key) {
      const identity = normaliseComparable(row.identity_key);
      byIdentity.set(identity, row);
      pushIndex(byIdentityAll, identity, row);
    }
    const voyage = voyageEquivalenceKey(row);
    if (!byVoyage.has(voyage)) byVoyage.set(voyage, []);
    byVoyage.get(voyage).push(row);
  }
  return {
    byOfficial,
    byOfficialAll,
    byExternal,
    byExternalAll,
    byIdentity,
    byIdentityAll,
    byCompactOfficial,
    byVoyage
  };
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

function emptyP3bCounts() {
  return Object.fromEntries(P3B_CLASSIFICATIONS.map((name) => [name, 0]));
}

function classifyNorwegianP3bCandidate(candidate = {}, productionRows = [], indexes = null, sourceOfficialCounts = null) {
  const idx = indexes || indexProduction(productionRows);
  const official = normaliseComparable(candidate.official_sailing_id);
  const external = normaliseComparable(candidate.external_key || candidate.candidate?.external_key);
  const identity = normaliseComparable(candidate.identity_key || candidate.candidate?.identity_key);
  const voyage = voyageEquivalenceKey({
    ship_id: candidate.ship_id || candidate.candidate?.ship_id,
    departure_date: candidate.departure_date || candidate.candidate?.departure_date,
    return_date: candidate.return_date || candidate.candidate?.return_date,
    nights: candidate.nights ?? candidate.candidate?.nights,
    departure_port: candidate.departure_port || candidate.candidate?.departure_port
  });

  if (official && sourceOfficialCounts && (sourceOfficialCounts.get(official) || 0) > 1) {
    return {
      classification: "SOURCE_DUPLICATE",
      reason: "duplicate_official_id_in_source_eligible_set",
      matching_production: idx.byOfficialAll.get(official) || []
    };
  }

  const officialMatches = official ? idx.byOfficialAll.get(official) || [] : [];
  if (officialMatches.length === 1) {
    const existing = officialMatches[0];
    if (existing.status === "match_required") {
      return {
        classification: "ALREADY_MATCH_REQUIRED",
        reason: "official_sailing_id_present_match_required",
        matching_production: officialMatches,
        existing_uuid: existing.id
      };
    }
    return {
      classification: "RECOGNISED",
      reason: "unique_official_sailing_id",
      matching_production: officialMatches,
      existing_uuid: existing.id
    };
  }
  if (officialMatches.length > 1) {
    return {
      classification: "MULTIPLE_PRODUCTION_MATCHES",
      reason: "official_sailing_id_matches_multiple_production_rows",
      matching_production: officialMatches
    };
  }

  const externalMatches = external ? idx.byExternalAll.get(external) || [] : [];
  if (externalMatches.length > 1) {
    return {
      classification: "MULTIPLE_PRODUCTION_MATCHES",
      reason: "external_key_matches_multiple_production_rows",
      matching_production: externalMatches
    };
  }
  const identityMatches = identity ? idx.byIdentityAll.get(identity) || [] : [];
  if (identityMatches.length > 1) {
    return {
      classification: "MULTIPLE_PRODUCTION_MATCHES",
      reason: "identity_key_matches_multiple_production_rows",
      matching_production: identityMatches
    };
  }

  const compact = compactOfficialId(official);
  const compactMatches = compact ? idx.byCompactOfficial.get(compact) || [] : [];
  if (compactMatches.length > 1) {
    return {
      classification: "MULTIPLE_PRODUCTION_MATCHES",
      reason: "multiple_compact_official_id_matches",
      matching_production: compactMatches
    };
  }

  if (!voyageKeyComplete(voyage)) {
    return { classification: "AMBIGUOUS", reason: "incomplete_voyage_equivalence", matching_production: [] };
  }

  const voyageMatches = idx.byVoyage.get(voyage) || [];
  if (voyageMatches.length > 1) {
    return {
      classification: "MULTIPLE_PRODUCTION_MATCHES",
      reason: "multiple_production_rows_same_voyage",
      matching_production: voyageMatches
    };
  }
  if (voyageMatches.length === 1) {
    const existing = voyageMatches[0];
    if (existing.status === "match_required") {
      return {
        classification: "ALREADY_MATCH_REQUIRED",
        reason: "unique_voyage_match_required",
        matching_production: voyageMatches,
        existing_uuid: existing.id,
        previous_official_sailing_id: existing.official_sailing_id,
        next_official_sailing_id: official
      };
    }
    return {
      classification: "UNIQUE_ID_REMAP",
      reason: "unique_voyage_equivalence_different_official_id",
      matching_production: voyageMatches,
      existing_uuid: existing.id,
      previous_official_sailing_id: existing.official_sailing_id,
      next_official_sailing_id: official
    };
  }

  if (externalMatches.length === 1) {
    const existing = externalMatches[0];
    if (existing.status === "match_required") {
      return {
        classification: "ALREADY_MATCH_REQUIRED",
        reason: "unique_external_key_match_required",
        matching_production: externalMatches,
        existing_uuid: existing.id
      };
    }
    return {
      classification: "UNIQUE_ID_REMAP",
      reason: "unique_external_key",
      matching_production: externalMatches,
      existing_uuid: existing.id
    };
  }
  if (identityMatches.length === 1) {
    const existing = identityMatches[0];
    if (existing.status === "match_required") {
      return {
        classification: "ALREADY_MATCH_REQUIRED",
        reason: "unique_identity_key_match_required",
        matching_production: identityMatches,
        existing_uuid: existing.id
      };
    }
    return {
      classification: "UNIQUE_ID_REMAP",
      reason: "unique_identity_key",
      matching_production: identityMatches,
      existing_uuid: existing.id
    };
  }
  if (compactMatches.length === 1) {
    const existing = compactMatches[0];
    if (existing.status === "match_required") {
      return {
        classification: "ALREADY_MATCH_REQUIRED",
        reason: "compact_official_id_match_required",
        matching_production: compactMatches,
        existing_uuid: existing.id
      };
    }
    return {
      classification: "UNIQUE_ID_REMAP",
      reason: "official_id_punctuation_or_case_variant",
      matching_production: compactMatches,
      existing_uuid: existing.id,
      previous_official_sailing_id: existing.official_sailing_id,
      next_official_sailing_id: official
    };
  }

  return {
    classification: "TRUE_NEW",
    reason: "no_official_external_identity_or_voyage_match",
    matching_production: []
  };
}

function classifyNorwegianP3bEligibleSet(eligibleProducts = [], productionRows = []) {
  const indexes = indexProduction(productionRows);
  const sourceOfficialCounts = new Map();
  for (const product of eligibleProducts || []) {
    const official = normaliseComparable(product.official_sailing_id);
    if (!official) continue;
    sourceOfficialCounts.set(official, (sourceOfficialCounts.get(official) || 0) + 1);
  }
  const classified = (eligibleProducts || []).map((product) => ({
    official_sailing_id: product.official_sailing_id || null,
    ...product,
    ...classifyNorwegianP3bCandidate(product, productionRows, indexes, sourceOfficialCounts)
  }));
  const counts = emptyP3bCounts();
  for (const row of classified) {
    counts[row.classification] = (counts[row.classification] || 0) + 1;
  }
  const sum = P3B_CLASSIFICATIONS.reduce((acc, name) => acc + (counts[name] || 0), 0);
  const outstanding = classified.filter((row) => row.classification !== "RECOGNISED");
  return {
    total: classified.length,
    counts,
    accounting_ok: sum === classified.length,
    classified,
    outstanding_total: outstanding.length,
    authorised_automatic: classified.filter((row) =>
      ["UNIQUE_ID_REMAP", "TRUE_NEW", "ALREADY_MATCH_REQUIRED"].includes(row.classification)
    ),
    review_required: classified.filter((row) =>
      ["MULTIPLE_PRODUCTION_MATCHES", "AMBIGUOUS", "SOURCE_DUPLICATE"].includes(row.classification)
    )
  };
}

function norwegianP3bWriteAllowed(classification) {
  return ["UNIQUE_ID_REMAP", "TRUE_NEW", "ALREADY_MATCH_REQUIRED"].includes(classification);
}

function norwegianMultipleProductionMatchBlocksWrite(classification) {
  return classification === "MULTIPLE_PRODUCTION_MATCHES";
}

const AMBIGUITY_REASONS = Object.freeze([
  "SOURCE_FIELD_INCOMPLETE",
  "PRODUCTION_FIELD_INCOMPLETE",
  "IDENTITY_FORMAT_DIFFERENCE",
  "DATE_OR_DURATION_DIFFERENCE",
  "PORT_DIFFERENCE",
  "DESTINATION_ONLY_DIFFERENCE",
  "OTHER"
]);

function fieldPresent(value) {
  if (value == null) return false;
  const text = String(value).trim();
  return text !== "" && text !== "undefined" && text !== "null";
}

function sourceVoyageFields(row = {}) {
  return {
    official_id: row.official_sailing_id || row.candidate?.official_sailing_id || null,
    ship: row.ship_id || row.canonical_ship_id || row.candidate?.ship_id || null,
    ship_name: row.ship_name || row.candidate?.ship_name || null,
    departure: String(row.departure_date || row.candidate?.departure_date || "").slice(0, 10) || null,
    return: String(row.return_date || row.candidate?.return_date || "").slice(0, 10) || null,
    nights: row.nights ?? row.candidate?.nights ?? null,
    departure_port: row.departure_port || row.canonical_departure_port || row.candidate?.departure_port || null,
    destination: row.destination_id || row.destination || row.candidate?.destination_id || null,
    itinerary: row.itinerary || row.candidate?.itinerary || row.itinerary_text || null,
    source_url: row.source_url || row.official_url || row.candidate?.source_url || null
  };
}

function missingNorwegianSourceFields(row = {}) {
  const src = sourceVoyageFields(row);
  const required = ["official_id", "ship", "departure", "return", "nights", "departure_port"];
  const optional = ["destination", "itinerary", "source_url"];
  const missing = [];
  for (const field of [...required, ...optional]) {
    if (!fieldPresent(src[field])) missing.push(field);
  }
  return { fields: src, missing_required: required.filter((field) => !fieldPresent(src[field])), missing };
}

const INCOMPLETENESS_LAYERS = Object.freeze([
  "OFFICIAL_SOURCE_MISSING",
  "PARSER_MISSING",
  "NORMALISATION_MISSING",
  "RESOLVER_MISSING",
  "REFERENCE_DATA_MISSING"
]);

function classifyNorwegianIncompletenessLayer(row = {}, missing = null) {
  const src = missing?.fields || sourceVoyageFields(row);
  const gaps = missing || missingNorwegianSourceFields(row);
  if (gaps.missing_required.includes("official_id") && !fieldPresent(src.official_id)) {
    return "OFFICIAL_SOURCE_MISSING";
  }
  if (gaps.missing_required.includes("ship") && fieldPresent(src.ship_name)) {
    return "RESOLVER_MISSING";
  }
  if (gaps.missing_required.includes("ship") && !fieldPresent(src.ship_name)) {
    return "REFERENCE_DATA_MISSING";
  }
  if (gaps.missing_required.some((field) => ["departure", "return", "nights"].includes(field))) {
    return "PARSER_MISSING";
  }
  if (gaps.missing_required.includes("departure_port") || gaps.missing.includes("destination")) {
    return "REFERENCE_DATA_MISSING";
  }
  if (gaps.missing.length) return "NORMALISATION_MISSING";
  return "PARSER_MISSING";
}

const OPERATIONAL_IDENTITY_CLASSES = Object.freeze([
  "EXISTING_ACTIVE",
  "EXISTING_MATCH_REQUIRED",
  "TRUE_NEW_COMPLETE",
  "INCOMPLETE_SOURCE",
  "AMBIGUOUS"
]);

function classifyNorwegianOperationalIdentity(row = {}) {
  if (row.classification === "RECOGNISED" || row.classification === "ALREADY_ACTIVE_DIFFERENT_ID") {
    return "EXISTING_ACTIVE";
  }
  if (row.classification === "ALREADY_MATCH_REQUIRED") return "EXISTING_MATCH_REQUIRED";
  if (row.classification === "TRUE_NEW" || row.classification === "UNIQUE_ID_REMAP") return "TRUE_NEW_COMPLETE";
  const missing = missingNorwegianSourceFields(row);
  if (missing.missing_required.length > 0 || row.ambiguity_reason === "SOURCE_FIELD_INCOMPLETE") {
    return "INCOMPLETE_SOURCE";
  }
  return "AMBIGUOUS";
}

function scoreNearestNorwegianProduction(source = {}, productionRows = []) {
  const src = sourceVoyageFields(source);
  let best = [];
  let bestScore = -1;
  for (const row of productionRows || []) {
    let score = 0;
    if (src.ship && row.ship_id === src.ship) score += 8;
    if (src.departure && String(row.departure_date || "").slice(0, 10) === src.departure) score += 6;
    if (src.return && String(row.return_date || "").slice(0, 10) === src.return) score += 3;
    if (src.nights != null && Number(row.nights) === Number(src.nights)) score += 2;
    if (src.departure_port && normaliseComparable(row.departure_port) === normaliseComparable(src.departure_port)) {
      score += 2;
    }
    if (src.destination && (row.destination_id || row.destination) === src.destination) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = [row];
    } else if (score === bestScore && score > 0) {
      best.push(row);
    }
  }
  return { nearest: best, score: bestScore };
}

function classifyNorwegianAmbiguityReason(candidate = {}, productionRows = []) {
  const src = sourceVoyageFields(candidate);
  const missing = missingNorwegianSourceFields(candidate);
  const sourceIncomplete = missing.missing_required.length > 0;
  if (sourceIncomplete) {
    const layer = classifyNorwegianIncompletenessLayer(candidate, missing);
    const origin = !fieldPresent(src.official_id)
      ? "OFFICIAL_SOURCE_MISSING"
      : missing.missing_required.includes("ship")
        ? layer
        : layer;
    return {
      ambiguity_reason: "SOURCE_FIELD_INCOMPLETE",
      detail: `source voyage fingerprint missing ${missing.missing_required.join(", ")}`,
      missing_source_fields: missing.missing,
      missing_required_fields: missing.missing_required,
      incompleteness_origin: origin,
      incompleteness_layer: layer
    };
  }

  const { nearest } = scoreNearestNorwegianProduction(candidate, productionRows);
  if (!nearest.length) {
    return { ambiguity_reason: "OTHER", detail: "no scored production neighbour" };
  }

  const productionIncomplete = nearest.some((row) =>
    ["ship_id", "departure_date", "return_date", "nights", "departure_port"].some((field) => !fieldPresent(row[field]))
  );
  if (productionIncomplete) {
    return {
      ambiguity_reason: "PRODUCTION_FIELD_INCOMPLETE",
      detail: "nearest production candidate missing voyage fingerprint fields"
    };
  }

  const sameShip = nearest.filter((row) => row.ship_id === src.ship);
  const compare = sameShip[0] || nearest[0];
  const prodDate = String(compare.departure_date || "").slice(0, 10);
  const prodReturn = String(compare.return_date || "").slice(0, 10);
  if (prodDate !== src.departure || prodReturn !== src.return || Number(compare.nights) !== Number(src.nights)) {
    return {
      ambiguity_reason: "DATE_OR_DURATION_DIFFERENCE",
      detail: "nearest production neighbour differs in departure, return, or nights"
    };
  }
  if (normaliseComparable(compare.departure_port) !== normaliseComparable(src.departure_port)) {
    return { ambiguity_reason: "PORT_DIFFERENCE", detail: "nearest production neighbour differs in departure port" };
  }

  const srcOfficial = compactOfficialId(candidate.official_sailing_id);
  const prodOfficial = compactOfficialId(compare.official_sailing_id);
  if (srcOfficial && prodOfficial && srcOfficial !== prodOfficial) {
    const sharedPrefix =
      srcOfficial.slice(0, 8) && prodOfficial.startsWith(srcOfficial.slice(0, 8));
    if (sharedPrefix) {
      return {
        ambiguity_reason: "IDENTITY_FORMAT_DIFFERENCE",
        detail: "official sailing id format differs from nearest production neighbour"
      };
    }
  }

  const srcDest = normaliseComparable(src.destination);
  const prodDest = normaliseComparable(compare.destination_id || compare.destination);
  if (srcDest && prodDest && srcDest !== prodDest) {
    return {
      ambiguity_reason: "DESTINATION_ONLY_DIFFERENCE",
      detail: "protected voyage fields agree; destination is the only disagreement"
    };
  }

  return { ambiguity_reason: "OTHER", detail: candidate.reason || "unresolved_norwegian_identity" };
}

module.exports = {
  CLASSIFICATIONS,
  P3B_CLASSIFICATIONS,
  AMBIGUITY_REASONS,
  voyageEquivalenceKey,
  voyageKeyComplete,
  classifyNorwegianVoyageInsert,
  classifyNorwegianVoyageInsertSet,
  classifyNorwegianP3bCandidate,
  classifyNorwegianP3bEligibleSet,
  classifyNorwegianAmbiguityReason,
  missingNorwegianSourceFields,
  classifyNorwegianIncompletenessLayer,
  classifyNorwegianOperationalIdentity,
  INCOMPLETENESS_LAYERS,
  OPERATIONAL_IDENTITY_CLASSES,
  norwegianP3bWriteAllowed,
  norwegianMultipleProductionMatchBlocksWrite
};
