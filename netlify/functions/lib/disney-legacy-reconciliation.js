/**
 * Disney Phase 2C — legacy discovered_cruises reconciliation (read-only audit).
 */

const DISNEY_LINE_ID = "8f7aadcb-7843-4060-b0cb-a60631936b3a";

const NON_SAILING_URL_RE =
  /\/(cruise-destinations|port-adventures|overview|itineraries)\//i;

function extractLegacyIdentityFromRow(row = {}) {
  const url = String(row.official_url || row.source_url || "").trim();
  const title = String(row.raw_extract?.title || "").trim();
  const hints = {
    sailing_id: null,
    departure_date: row.departure_date || null,
    nights: row.nights != null ? Number(row.nights) : null,
    ship_id: row.ship_id || null,
    departure_port: row.departure_port || null,
    destination_id: row.destination_id || null,
    official_product_key: row.official_sailing_id || row.raw_extract?.disney_official_product_key || null,
    title,
    url,
    non_sailing_page: NON_SAILING_URL_RE.test(url) && !/\/list\//i.test(url)
  };

  const urlMatch = url.match(/\/list\/([A-Z0-9]+)\/[^/]+\/(\d{4}-\d{2}-\d{2})-/i);
  if (urlMatch) {
    hints.sailing_id = urlMatch[1];
    hints.departure_date = hints.departure_date || urlMatch[2];
    hints.official_product_key = hints.official_product_key || `${urlMatch[1]}|${urlMatch[2]}`;
    hints.legacy_url_sailing = true;
  }

  if (!hints.nights) {
    const nightsMatch = title.match(/^(\d+)-Night/i);
    if (nightsMatch) hints.nights = Number(nightsMatch[1]);
  }

  const shipSlugMatch = url.match(/-Disney-([A-Za-z-]+)\/?$/i);
  if (shipSlugMatch) {
    hints.ship_slug = shipSlugMatch[1].replace(/-/g, " ");
  }

  return hints;
}

function indexNormalisedProducts(products = []) {
  const byOfficialKey = new Map();
  const list = [];
  for (const row of products) {
    const key = row.official_sailing_id || row.raw?.official_product_key;
    if (key) byOfficialKey.set(key, row);
    list.push(row);
  }
  return { byOfficialKey, list };
}

function confirmLegacyMatch(existing, product, hints) {
  const confirmations = [];
  if (existing.destination_id && product.candidate?.destination_id && existing.destination_id === product.candidate.destination_id) {
    confirmations.push("destination");
  }
  if (existing.departure_port && product.candidate?.departure_port && existing.departure_port === product.candidate.departure_port) {
    confirmations.push("departure_port");
  }
  if (hints.title && product.raw?.product_name && hints.title.toLowerCase() === product.raw.product_name.toLowerCase()) {
    confirmations.push("title");
  }
  if (product.raw?.itinerary_id || (product.raw?.ports_of_call_ordered || []).length) {
    confirmations.push("itinerary_evidence");
  }
  return confirmations;
}

function matchLegacyDisneyRow(existingRow, productIndex, ships = []) {
  const hints = extractLegacyIdentityFromRow(existingRow);
  const shipNameById = new Map((ships || []).map((s) => [s.id, s.name]));

  if (hints.non_sailing_page && !hints.legacy_url_sailing) {
    return {
      existing_id: existingRow.id,
      match_status: "no_source_match",
      matched_disney_identity: null,
      evidence: { reason: "non_sailing_marketing_or_destination_page", hints },
      confidence: "high"
    };
  }

  if (hints.official_product_key && productIndex.byOfficialKey.has(hints.official_product_key)) {
    const product = productIndex.byOfficialKey.get(hints.official_product_key);
    return {
      existing_id: existingRow.id,
      match_status: "exact_official_identity",
      matched_disney_identity: hints.official_product_key,
      sailing_id: product.raw?.sailing_id,
      ship: product.raw?.ship_name,
      departure_date: product.raw?.departure_date,
      nights: product.raw?.nights,
      departure_port: product.candidate?.departure_port,
      evidence: { tier: "A", method: "official_product_key", hints },
      confidence: "high"
    };
  }

  const tierBCandidates = productIndex.list.filter((product) => {
    const sameDate = hints.departure_date && product.raw?.departure_date === hints.departure_date;
    const sameNights = hints.nights && product.raw?.nights === hints.nights;
    const sameShip =
      (hints.ship_id && product.candidate?.ship_id === hints.ship_id) ||
      (hints.sailing_id && product.raw?.sailing_id === hints.sailing_id) ||
      (hints.ship_slug &&
        String(product.raw?.ship_name || "")
          .toLowerCase()
          .includes(hints.ship_slug.toLowerCase()));
    return sameShip && sameDate && sameNights;
  });

  if (tierBCandidates.length === 1) {
    const product = tierBCandidates[0];
    const confirmations = confirmLegacyMatch(existingRow, product, hints);
    if (confirmations.length >= 1 || hints.legacy_url_sailing) {
      return {
        existing_id: existingRow.id,
        match_status: "exact_legacy_match",
        matched_disney_identity: product.official_sailing_id,
        sailing_id: product.raw?.sailing_id,
        ship: product.raw?.ship_name,
        departure_date: product.raw?.departure_date,
        nights: product.raw?.nights,
        departure_port: product.candidate?.departure_port,
        evidence: { tier: "B", confirmations, hints },
        confidence: confirmations.length >= 2 ? "high" : "medium"
      };
    }
  }

  if (tierBCandidates.length > 1) {
    return {
      existing_id: existingRow.id,
      match_status: "ambiguous",
      matched_disney_identity: null,
      evidence: { tier: "B", reason: "multiple_ship_date_duration_matches", count: tierBCandidates.length, hints },
      confidence: "low"
    };
  }

  const tierCCandidates = productIndex.list.filter((product) => {
    const sameDate = hints.departure_date && product.raw?.departure_date === hints.departure_date;
    const sameShip =
      (hints.ship_id && product.candidate?.ship_id === hints.ship_id) ||
      (hints.sailing_id && product.raw?.sailing_id === hints.sailing_id) ||
      (hints.ship_slug &&
        String(product.raw?.ship_name || "")
          .toLowerCase()
          .includes(hints.ship_slug.toLowerCase()));
    const samePort =
      hints.departure_port &&
      product.candidate?.departure_port &&
      hints.departure_port === product.candidate.departure_port;
    const compatibleDuration =
      hints.nights && product.raw?.nights && Math.abs(hints.nights - product.raw.nights) <= 0;
    return sameShip && sameDate && samePort && compatibleDuration;
  });

  if (tierCCandidates.length === 1) {
    const product = tierCCandidates[0];
    return {
      existing_id: existingRow.id,
      match_status: "exact_legacy_match",
      matched_disney_identity: product.official_sailing_id,
      sailing_id: product.raw?.sailing_id,
      ship: product.raw?.ship_name,
      departure_date: product.raw?.departure_date,
      nights: product.raw?.nights,
      departure_port: product.candidate?.departure_port,
      evidence: { tier: "C", hints },
      confidence: "medium"
    };
  }

  if (tierCCandidates.length > 1) {
    return {
      existing_id: existingRow.id,
      match_status: "ambiguous",
      matched_disney_identity: null,
      evidence: { tier: "C", reason: "multiple_tier_c_matches", count: tierCCandidates.length, hints },
      confidence: "low"
    };
  }

  const reason = hints.legacy_url_sailing || hints.official_product_key ? "not_in_current_snapshot" : "insufficient_legacy_evidence";
  return {
    existing_id: existingRow.id,
    match_status: "no_source_match",
    matched_disney_identity: null,
    evidence: { reason, hints, ship_name: hints.ship_id ? shipNameById.get(hints.ship_id) : null },
    confidence: "high"
  };
}

function auditLegacyDisneyRows(existingRows = [], normalisedProducts = [], context = {}) {
  const productIndex = indexNormalisedProducts(normalisedProducts);
  const rows = (existingRows || []).map((existing) =>
    matchLegacyDisneyRow(existing, productIndex, context.ships || [])
  );

  const matchedKeys = new Map();
  const matchedExisting = new Map();
  const ambiguities = [];

  for (const row of rows) {
    if (row.match_status === "exact_official_identity" || row.match_status === "exact_legacy_match") {
      if (matchedKeys.has(row.matched_disney_identity)) {
        ambiguities.push({
          type: "one_source_many_existing",
          identity: row.matched_disney_identity,
          existing_ids: [matchedKeys.get(row.matched_disney_identity), row.existing_id]
        });
      } else {
        matchedKeys.set(row.matched_disney_identity, row.existing_id);
      }
      if (matchedExisting.has(row.existing_id)) {
        ambiguities.push({
          type: "one_existing_many_source",
          existing_id: row.existing_id,
          identities: [matchedExisting.get(row.existing_id), row.matched_disney_identity]
        });
      } else {
        matchedExisting.set(row.existing_id, row.matched_disney_identity);
      }
    }
    if (row.match_status === "ambiguous") {
      ambiguities.push({ type: "ambiguous_row", existing_id: row.existing_id, evidence: row.evidence });
    }
  }

  return {
    total_existing_disney_rows: existingRows.length,
    exact_official_matches: rows.filter((r) => r.match_status === "exact_official_identity").length,
    exact_legacy_matches: rows.filter((r) => r.match_status === "exact_legacy_match").length,
    ambiguous: rows.filter((r) => r.match_status === "ambiguous").length,
    no_source_match: rows.filter((r) => r.match_status === "no_source_match").length,
    rows,
    legacy_match_by_identity: Object.fromEntries(matchedKeys),
    legacy_match_by_existing_id: Object.fromEntries(
      rows
        .filter((r) => r.matched_disney_identity)
        .map((r) => [r.existing_id, { identity: r.matched_disney_identity, match_status: r.match_status, evidence: r.evidence }])
    ),
    ambiguities,
    safe: ambiguities.length === 0
  };
}

function analyseDuplicateSafety(normalised = [], existingRows = [], manifest = [], legacyAudit = {}, helpers = {}) {
  const issues = [];
  const productionEligible = normalised.filter((r) => r.eligibility?.production_eligible);
  const inserts = manifest.filter((m) => m.action === "insert_active");
  const disneyExternalKey = helpers.disneyExternalKey;
  const cruiseIdentityKeyFn = helpers.cruiseIdentityKey;

  const externalKeys = new Set();
  const identityKeys = new Set();
  const officialIds = new Set();

  for (const row of productionEligible) {
    const candidate = row.candidate || {};
    const productKey = row.official_sailing_id;
    if (!productKey) continue;
    if (disneyExternalKey) {
      const externalKey = disneyExternalKey(DISNEY_LINE_ID, productKey);
      if (externalKeys.has(externalKey)) issues.push({ type: "duplicate_external_key", externalKey, productKey });
      externalKeys.add(externalKey);
    }
    if (cruiseIdentityKeyFn) {
      const identityKey = cruiseIdentityKeyFn({
        cruiseLineId: DISNEY_LINE_ID,
        shipId: candidate.ship_id,
        departureDate: candidate.departure_date,
        officialUrl: candidate.official_url,
        nights: candidate.nights,
        returnDate: candidate.return_date,
        officialSailingId: productKey
      });
      if (identityKeys.has(identityKey)) issues.push({ type: "duplicate_identity_key", identityKey, productKey });
      identityKeys.add(identityKey);
    }
    if (officialIds.has(productKey)) issues.push({ type: "duplicate_official_sailing_id", productKey });
    officialIds.add(productKey);
  }

  for (const entry of inserts) {
    const legacyMatch = legacyAudit.legacy_match_by_identity?.[entry.official_product_key];
    if (legacyMatch) {
      issues.push({
        type: "insert_conflicts_with_legacy_match",
        official_product_key: entry.official_product_key,
        existing_id: legacyMatch
      });
    }
  }

  if (!legacyAudit.safe) {
    issues.push({ type: "legacy_ambiguity", ambiguities: legacyAudit.ambiguities });
  }

  const existingOfficial = new Set(
    (existingRows || [])
      .map((r) => r.official_sailing_id || r.raw_extract?.disney_official_product_key)
      .filter(Boolean)
  );
  for (const entry of inserts) {
    if (existingOfficial.has(entry.official_product_key)) {
      issues.push({ type: "insert_duplicates_existing_official_id", official_product_key: entry.official_product_key });
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    production_eligible_count: productionEligible.length,
    proposed_inserts: inserts.length
  };
}

function buildFirstControlledBatch(normalised = [], manifest = [], options = {}) {
  const maxSize = options.maxSize || 20;
  const eligible = manifest
    .filter((m) => m.action === "insert_active")
    .map((m) => ({
      manifest: m,
      row: normalised.find((r) => r.official_sailing_id === m.official_product_key)
    }))
    .filter((e) => e.row)
    .sort((a, b) => a.manifest.official_product_key.localeCompare(b.manifest.official_product_key));

  const seenShip = new Set();
  const seenPort = new Set();
  const seenDest = new Set();
  const seenNights = new Set();
  const remaining = [...eligible];
  const picked = [];

  while (picked.length < maxSize && remaining.length > 0) {
    remaining.sort((a, b) => diversityScore(b.row, seenShip, seenPort, seenDest, seenNights) - diversityScore(a.row, seenShip, seenPort, seenDest, seenNights));
    const entry = remaining.shift();
    const row = entry.row;
    picked.push({
      official_product_key: entry.manifest.official_product_key,
      sailing_id: row.raw?.sailing_id,
      ship_name: row.raw?.ship_name,
      departure_date: row.raw?.departure_date,
      nights: row.raw?.nights,
      departure_port: row.candidate?.departure_port,
      destination_key: row.candidate?.destination_key,
      action: "insert_active"
    });
    if (row.raw?.ship_name) seenShip.add(row.raw.ship_name);
    if (row.candidate?.departure_port) seenPort.add(row.candidate.departure_port);
    if (row.candidate?.destination_key) seenDest.add(row.candidate.destination_key);
    if (row.raw?.nights) seenNights.add(row.raw.nights);
  }

  picked.sort((a, b) => a.official_product_key.localeCompare(b.official_product_key));

  return {
    size: picked.length,
    max_size: maxSize,
    strategy: "insert_only",
    strategy_reason:
      "No exact legacy production matches among six existing rows (five marketing pages, one past sailing absent from current snapshot). INSERT-only avoids coupling first batch to legacy enrichment rollback.",
    action_mix: {
      insert_active: picked.length,
      update_exact_legacy_match: 0
    },
    frozen_identities: picked.map((f) => f.official_product_key),
    entries: picked,
    execution_performed: false
  };
}

function diversityScore(row, seenShip, seenPort, seenDest, seenNights) {
  let score = 0;
  if (!seenShip.has(row.raw?.ship_name)) score += 4;
  if (!seenPort.has(row.candidate?.departure_port)) score += 4;
  if (!seenDest.has(row.candidate?.destination_key)) score += 2;
  if (!seenNights.has(row.raw?.nights)) score += 1;
  return score;
}

module.exports = {
  DISNEY_LINE_ID,
  extractLegacyIdentityFromRow,
  matchLegacyDisneyRow,
  auditLegacyDisneyRows,
  analyseDuplicateSafety,
  buildFirstControlledBatch
};
