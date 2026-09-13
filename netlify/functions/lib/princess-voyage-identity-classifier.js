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
  "AMBIGUOUS",
  "MULTIPLE_PRODUCTION_MATCHES"
]);

const P3B_CLASSIFICATIONS = Object.freeze([
  "RECOGNISED_CURRENT_ID",
  "UNIQUE_OFFICIAL_ID_REMAP",
  "UNIQUE_ALTERNATE_ID_FORMAT",
  "TRUE_NEW",
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
    normaliseComparable(row.departure_port),
    normaliseComparable(row.destination_id || row.destination)
  ].join("|");
}

function voyageKeyComplete(key) {
  const parts = String(key || "").split("|");
  return parts.length === 6 && parts.every((part) => part !== "");
}

function strictVoyageFingerprint(row = {}) {
  return [
    normaliseComparable(row.ship_id || row.canonical_ship_id),
    String(row.departure_date || "").slice(0, 10),
    String(row.return_date || "").slice(0, 10),
    String(row.nights ?? ""),
    normaliseComparable(row.departure_port || row.canonical_departure_port)
  ].join("|");
}

function strictVoyageFingerprintComplete(key) {
  const parts = String(key || "").split("|");
  return parts.length === 5 && parts.every((part) => part !== "");
}

function destinationValue(row = {}) {
  return normaliseComparable(row.destination_id || row.destination || row.canonical_destination_id);
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
  const byStrictVoyage = new Map();
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
    pushIndex(byStrictVoyage, strictVoyageFingerprint(row), row);
  }
  return {
    byOfficial,
    byOfficialAll,
    byExternal,
    byExternalAll,
    byIdentity,
    byIdentityAll,
    byCompactOfficial,
    byVoyage,
    byStrictVoyage
  };
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
      classification: "MULTIPLE_PRODUCTION_MATCHES",
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
    MULTIPLE_PRODUCTION_MATCHES: classified.filter((row) => row.classification === "MULTIPLE_PRODUCTION_MATCHES"),
    AMBIGUOUS: classified.filter((row) => row.classification === "AMBIGUOUS"),
    classified
  };
}

function emptyP3bCounts() {
  return Object.fromEntries(P3B_CLASSIFICATIONS.map((name) => [name, 0]));
}

function classifyPrincessP3bCandidate(candidate = {}, productionRows = [], indexes = null, sourceOfficialCounts = null) {
  const idx = indexes || indexProduction(productionRows);
  const official = normaliseComparable(candidate.official_sailing_id || candidate.official_princess_sailing_id);
  const external = normaliseComparable(candidate.external_key || candidate.candidate?.external_key);
  const identity = normaliseComparable(candidate.identity_key || candidate.candidate?.identity_key);
  const shipId = candidate.ship_id || candidate.canonical_ship_id || candidate.candidate?.ship_id;
  const departureDate = candidate.departure_date || candidate.candidate?.departure_date;
  const returnDate = candidate.return_date || candidate.candidate?.return_date;
  const nights = candidate.nights ?? candidate.candidate?.nights;
  const departurePort = candidate.departure_port || candidate.canonical_departure_port || candidate.candidate?.departure_port;
  const destination = destinationValue(candidate.candidate || candidate);
  const fingerprint = strictVoyageFingerprint({
    ship_id: shipId,
    departure_date: departureDate,
    return_date: returnDate,
    nights,
    departure_port: departurePort
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
    return {
      classification: "RECOGNISED_CURRENT_ID",
      reason: "unique_official_sailing_id",
      matching_production: officialMatches,
      existing_uuid: officialMatches[0].id
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
  if (externalMatches.length === 1) {
    return {
      classification: "UNIQUE_ALTERNATE_ID_FORMAT",
      reason: "unique_external_key",
      matching_production: externalMatches,
      existing_uuid: externalMatches[0].id,
      previous_official_sailing_id: externalMatches[0].official_sailing_id,
      next_official_sailing_id: official || null
    };
  }
  if (externalMatches.length > 1) {
    return {
      classification: "MULTIPLE_PRODUCTION_MATCHES",
      reason: "external_key_matches_multiple_production_rows",
      matching_production: externalMatches
    };
  }

  const identityMatches = identity ? idx.byIdentityAll.get(identity) || [] : [];
  if (identityMatches.length === 1) {
    return {
      classification: "UNIQUE_ALTERNATE_ID_FORMAT",
      reason: "unique_identity_key",
      matching_production: identityMatches,
      existing_uuid: identityMatches[0].id,
      previous_official_sailing_id: identityMatches[0].official_sailing_id,
      next_official_sailing_id: official || null
    };
  }
  if (identityMatches.length > 1) {
    return {
      classification: "MULTIPLE_PRODUCTION_MATCHES",
      reason: "identity_key_matches_multiple_production_rows",
      matching_production: identityMatches
    };
  }

  const compact = compactOfficialId(official);
  const compactMatches = compact ? idx.byCompactOfficial.get(compact) || [] : [];
  if (compactMatches.length === 1 && normaliseComparable(compactMatches[0].official_sailing_id) !== official) {
    const destExisting = destinationValue(compactMatches[0]);
    if (destination && destExisting && destination !== destExisting) {
      return {
        classification: "AMBIGUOUS",
        reason: "alternate_id_format_destination_disagrees",
        matching_production: compactMatches,
        existing_uuid: compactMatches[0].id
      };
    }
    return {
      classification: "UNIQUE_ALTERNATE_ID_FORMAT",
      reason: "official_id_punctuation_or_case_variant",
      matching_production: compactMatches,
      existing_uuid: compactMatches[0].id,
      previous_official_sailing_id: compactMatches[0].official_sailing_id,
      next_official_sailing_id: official
    };
  }
  if (compactMatches.length > 1) {
    return {
      classification: "MULTIPLE_PRODUCTION_MATCHES",
      reason: "multiple_compact_official_id_matches",
      matching_production: compactMatches
    };
  }

  if (!strictVoyageFingerprintComplete(fingerprint)) {
    return {
      classification: "AMBIGUOUS",
      reason: "incomplete_strict_voyage_fingerprint",
      matching_production: []
    };
  }

  const voyageMatches = idx.byStrictVoyage.get(fingerprint) || [];
  if (voyageMatches.length === 1) {
    const existing = voyageMatches[0];
    const destExisting = destinationValue(existing);
    if (destination && destExisting && destination !== destExisting) {
      return {
        classification: "AMBIGUOUS",
        reason: "strict_voyage_match_destination_corroboration_failed",
        matching_production: voyageMatches,
        existing_uuid: existing.id
      };
    }
    if (!destination || !destExisting) {
      return {
        classification: "AMBIGUOUS",
        reason: "strict_voyage_match_destination_corroboration_incomplete",
        matching_production: voyageMatches,
        existing_uuid: existing.id
      };
    }
    return {
      classification: "UNIQUE_OFFICIAL_ID_REMAP",
      reason: "unique_strict_voyage_fingerprint_different_official_id",
      matching_production: voyageMatches,
      existing_uuid: existing.id,
      previous_official_sailing_id: existing.official_sailing_id,
      next_official_sailing_id: official
    };
  }
  if (voyageMatches.length > 1) {
    return {
      classification: "MULTIPLE_PRODUCTION_MATCHES",
      reason: "multiple_production_rows_same_strict_voyage_fingerprint",
      matching_production: voyageMatches
    };
  }

  return {
    classification: "TRUE_NEW",
    reason: "no_official_external_identity_or_voyage_match",
    matching_production: []
  };
}

function classifyPrincessP3bEligibleSet(eligibleProducts = [], productionRows = []) {
  const indexes = indexProduction(productionRows);
  const sourceOfficialCounts = new Map();
  for (const product of eligibleProducts || []) {
    const official = normaliseComparable(product.official_sailing_id || product.official_princess_sailing_id);
    if (!official) continue;
    sourceOfficialCounts.set(official, (sourceOfficialCounts.get(official) || 0) + 1);
  }
  const classified = (eligibleProducts || []).map((product) => ({
    official_sailing_id: product.official_sailing_id || product.official_princess_sailing_id || null,
    ...product,
    ...classifyPrincessP3bCandidate(product, productionRows, indexes, sourceOfficialCounts)
  }));
  const counts = emptyP3bCounts();
  for (const row of classified) {
    counts[row.classification] = (counts[row.classification] || 0) + 1;
  }
  const sum = P3B_CLASSIFICATIONS.reduce((acc, name) => acc + (counts[name] || 0), 0);
  return {
    total: classified.length,
    counts,
    accounting_ok: sum === classified.length,
    classified,
    authorised_automatic: classified.filter((row) =>
      ["UNIQUE_OFFICIAL_ID_REMAP", "UNIQUE_ALTERNATE_ID_FORMAT", "TRUE_NEW"].includes(row.classification)
    ),
    review_required: classified.filter((row) =>
      ["MULTIPLE_PRODUCTION_MATCHES", "AMBIGUOUS", "SOURCE_DUPLICATE"].includes(row.classification)
    )
  };
}

function princessP3bWriteAllowed(classification) {
  return ["UNIQUE_OFFICIAL_ID_REMAP", "UNIQUE_ALTERNATE_ID_FORMAT", "TRUE_NEW"].includes(classification);
}

module.exports = {
  CLASSIFICATIONS,
  P3B_CLASSIFICATIONS,
  compactOfficialId,
  voyageEquivalenceKey,
  strictVoyageFingerprint,
  indexProduction,
  classifyPrincessVoyageInsert,
  classifyPrincessVoyageInsertSet,
  classifyPrincessP3bCandidate,
  classifyPrincessP3bEligibleSet,
  princessP3bWriteAllowed
};
