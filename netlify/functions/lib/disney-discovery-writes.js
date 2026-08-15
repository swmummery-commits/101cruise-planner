/**
 * Disney Cruise Line — Phase 3 controlled-batch production writes (insert-only first batch).
 */

const {
  officialProductKey,
  ADAPTER_ID,
  ADAPTER_VERSION,
  buildDisneyUpsertCandidate,
  classifyProposedAction,
  resolveDisneyItineraryPortText
} = require("./disney-discovery-adapter");
const { cruiseIdentityKey, upsertCandidateRecord } = require("./cruise-discovery-ops");
const { ensureGlobalCruiseWriteLockForMutation } = require("./cruise-discovery-global-write-lock");
const { DISNEY_LEGACY_ROW_IDS, MAX_CONTROLLED_DISNEY_BATCH } = require("./disney-controlled-batch");

const REJECTED_ACTIONS = new Set([
  "update_exact_existing",
  "update_exact_legacy_match",
  "review_required",
  "blocked_unresolved"
]);

function buildItineraryPorts(row) {
  return (row.raw?.ports_of_call_ordered || [])
    .map((port) => {
      const resolved = resolveDisneyItineraryPortText(port);
      return resolved.status === "resolved" ? resolved.canonicalPortName : null;
    })
    .filter(Boolean);
}

function enhanceDisneyCandidate(normalised, cruiseLine) {
  const candidate = buildDisneyUpsertCandidate(normalised, cruiseLine);
  if (!candidate) return null;

  const depMeta = normalised.candidate?.departure_port_meta || {};
  const arrMeta = normalised.candidate?.arrival_port_meta || {};
  const itinerary_ports = buildItineraryPorts(normalised);

  return {
    ...candidate,
    itinerary: normalised.candidate?.itinerary || itinerary_ports.join(" • ") || null,
    itinerary_ports,
    raw_extract: {
      ...(candidate.raw_extract || {}),
      disney_adapter_id: ADAPTER_ID,
      disney_adapter_version: ADAPTER_VERSION,
      disney_controlled_first_batch: true,
      disney_batch_write: true,
      embark_method: depMeta.embark_method || depMeta.evidence_method || null,
      arrival_method: arrMeta.method || null,
      embark_evidence_tier: depMeta.evidence_tier || null,
      arrival_evidence_tier: arrMeta.evidence_tier || null,
      destination_key: normalised.candidate?.destination_key || null,
      ship_match_method: normalised.ship_resolution?.method || null
    }
  };
}

async function indexExistingDisneyRecords(supabase, cruiseLineId) {
  const rows =
    (await supabase(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
        cruiseLineId
      )}&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,status,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract,created_at,updated_at`
    )) || [];

  const byOfficialId = new Map();
  const byExternalKey = new Map();
  const byIdentityKey = new Map();
  const legacyRows = [];

  for (const row of rows) {
    if (DISNEY_LEGACY_ROW_IDS.includes(row.id)) legacyRows.push(row);
    const key = row.official_sailing_id || row.raw_extract?.disney_official_product_key;
    if (key) byOfficialId.set(String(key).toUpperCase(), row);
    if (row.external_key) byExternalKey.set(row.external_key, row);
    if (row.identity_key) byIdentityKey.set(row.identity_key, row);
  }

  return { rows, byOfficialId, byExternalKey, byIdentityKey, legacyRows };
}

function buildManifestEntry(normalised, cruiseLine, existing, frozenEntry) {
  const productKey = officialProductKey(normalised.raw);
  const action = classifyProposedAction(normalised, existing, null);

  return {
    official_sailing_id: productKey,
    raw_sailing_id: normalised.raw?.sailing_id,
    ship_id: normalised.candidate?.ship_id,
    ship_name: normalised.raw?.ship_name,
    departure_date: normalised.candidate?.departure_date,
    return_date: normalised.candidate?.return_date,
    nights: normalised.candidate?.nights,
    departure_port: normalised.candidate?.departure_port,
    arrival_port: normalised.candidate?.arrival_port || null,
    destination_id: normalised.candidate?.destination_id,
    destination_key: normalised.candidate?.destination_key,
    official_url: normalised.candidate?.official_url,
    source_url: normalised.candidate?.source_url,
    external_key: frozenEntry?.external_key || null,
    identity_key: frozenEntry?.identity_key || null,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    endpoint_evidence_method: frozenEntry?.endpoint_evidence_method || null,
    endpoint_unresolved_conflict_count: frozenEntry?.endpoint_unresolved_conflict_count || 0,
    proposed_action: action,
    frozen_match: frozenEntry ? candidateMatchesFrozen(normalised, cruiseLine, frozenEntry) : null
  };
}

function candidateMatchesFrozen(normalised, cruiseLine, frozenEntry) {
  const candidate = enhanceDisneyCandidate(normalised, cruiseLine);
  if (!candidate) return { ok: false, reason: "candidate_build_failed" };

  const checks = [
    ["official_sailing_id", candidate.official_sailing_id, frozenEntry.official_sailing_id],
    ["ship_id", candidate.ship_id, frozenEntry.ship_id],
    ["departure_date", candidate.departure_date, frozenEntry.departure_date],
    ["return_date", candidate.return_date, frozenEntry.return_date],
    ["nights", candidate.nights, frozenEntry.nights],
    ["departure_port", candidate.departure_port, frozenEntry.departure_port],
    ["arrival_port", candidate.arrival_port || null, frozenEntry.arrival_port || null],
    ["destination_id", candidate.destination_id, frozenEntry.destination_id],
    ["external_key", candidate.external_key, frozenEntry.external_key],
    ["identity_key", candidate.identity_key, frozenEntry.identity_key]
  ];

  const mismatches = checks.filter(([, live, frozen]) => String(live ?? "") !== String(frozen ?? ""));
  return { ok: mismatches.length === 0, mismatches: mismatches.map(([field]) => field) };
}

async function buildDisneyBatchManifest({
  selectedProducts = [],
  cruiseLine,
  frozenEntriesById = new Map(),
  supabase,
  runId
}) {
  const indexes = supabase ? await indexExistingDisneyRecords(supabase, cruiseLine.id) : { byOfficialId: new Map() };

  const products = (selectedProducts || []).map((normalised) => {
    const productKey = officialProductKey(normalised.raw);
    const existing = indexes.byOfficialId.get(String(productKey).toUpperCase()) || null;
    const frozenEntry = frozenEntriesById.get(productKey) || null;
    return buildManifestEntry(normalised, cruiseLine, existing, frozenEntry);
  });

  return {
    run_id: runId || null,
    cruise_line_id: cruiseLine.id,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    batch_size: products.length,
    products
  };
}

async function applyDisneyBatchWritesBody({
  selectedProducts = [],
  frozenEntriesById = new Map(),
  cruiseLine,
  runId,
  supabase,
  performWrites = true,
  maxWrites = MAX_CONTROLLED_DISNEY_BATCH
}) {
  const stats = {
    attempted: 0,
    inserted: 0,
    updated: 0,
    duplicate_skips: 0,
    invalid_skips: 0,
    failed: 0,
    write_details: []
  };

  if (maxWrites > MAX_CONTROLLED_DISNEY_BATCH) {
    throw new Error("disney_controlled_batch_max_exceeded");
  }

  const upsertStats = { new: 0, upserted_active: 0, cruises_inserted: 0, cruises_updated: 0 };
  let writesRemaining = maxWrites;

  for (const normalised of selectedProducts || []) {
    if (writesRemaining <= 0) break;

    const productKey = officialProductKey(normalised.raw);
    const frozenEntry = frozenEntriesById.get(productKey);
    if (!frozenEntry) {
      stats.invalid_skips += 1;
      stats.write_details.push({ official_sailing_id: productKey, proposed_action: "not_in_frozen_manifest" });
      continue;
    }

    const action = classifyProposedAction(normalised, null, null);
    if (action !== "insert_active" || REJECTED_ACTIONS.has(action)) {
      stats.invalid_skips += 1;
      stats.write_details.push({ official_sailing_id: productKey, proposed_action: action, rejected: true });
      continue;
    }

    const frozenMatch = candidateMatchesFrozen(normalised, cruiseLine, frozenEntry);
    if (!frozenMatch.ok) {
      stats.invalid_skips += 1;
      stats.write_details.push({
        official_sailing_id: productKey,
        proposed_action: "frozen_candidate_mismatch",
        mismatches: frozenMatch.mismatches
      });
      continue;
    }

    const candidate = enhanceDisneyCandidate(normalised, cruiseLine);
    if (!candidate) {
      stats.invalid_skips += 1;
      continue;
    }

    stats.attempted += 1;
    if (!performWrites) {
      stats.write_details.push({ official_sailing_id: productKey, proposed_action: "insert_active", dry_run: true });
      continue;
    }

    try {
      const freshOfficial =
        (
          await supabase(
            `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
              cruiseLine.id
            )}&official_sailing_id=eq.${encodeURIComponent(productKey)}&select=id,official_sailing_id,status&limit=1`
          )
        )?.[0] || null;

      if (freshOfficial?.official_sailing_id) {
        stats.failed += 1;
        stats.write_details.push({
          official_sailing_id: productKey,
          proposed_action: "duplicate_official_sailing_id",
          discovered_cruise_id: freshOfficial.id,
          error: "official_sailing_id_collision"
        });
        throw new Error(`official_sailing_id_collision:${productKey}`);
      }

      const freshExternal =
        (
          await supabase(
            `discovered_cruises?external_key=eq.${encodeURIComponent(
              candidate.external_key
            )}&select=id,external_key,cruise_line_id&limit=1`
          )
        )?.[0] || null;
      if (freshExternal?.id) {
        stats.failed += 1;
        stats.write_details.push({
          official_sailing_id: productKey,
          proposed_action: "duplicate_external_key",
          discovered_cruise_id: freshExternal.id,
          error: "external_key_collision"
        });
        throw new Error(`external_key_collision:${productKey}`);
      }

      const freshIdentity =
        (
          await supabase(
            `discovered_cruises?identity_key=eq.${encodeURIComponent(
              candidate.identity_key
            )}&select=id,identity_key,cruise_line_id&limit=1`
          )
        )?.[0] || null;
      if (freshIdentity?.id) {
        stats.failed += 1;
        stats.write_details.push({
          official_sailing_id: productKey,
          proposed_action: "duplicate_identity_key",
          discovered_cruise_id: freshIdentity.id,
          error: "identity_key_collision"
        });
        throw new Error(`identity_key_collision:${productKey}`);
      }

      const result = await upsertCandidateRecord(candidate, upsertStats, {
        matchPolicy: "official_sailing_id_only",
        syncDestinationLinks: false,
        prevRecord: null
      });

      if (!result.created) {
        stats.failed += 1;
        stats.write_details.push({
          official_sailing_id: productKey,
          proposed_action: "insert_active",
          error: "update_path_not_permitted",
          result_action: result.created ? "inserted" : "updated"
        });
        throw new Error(`update_path_not_permitted:${productKey}`);
      }

      writesRemaining -= 1;
      stats.inserted += 1;
      stats.write_details.push({
        discovered_cruise_id: result.row?.id || null,
        official_sailing_id: productKey,
        proposed_action: "insert_active",
        result_action: "inserted",
        created: true
      });
    } catch (error) {
      if (!stats.write_details.some((d) => d.official_sailing_id === productKey && d.error)) {
        stats.failed += 1;
        stats.write_details.push({
          official_sailing_id: productKey,
          proposed_action: "insert_active",
          error: error.message || String(error)
        });
      }
      throw error;
    }
  }

  return { stats, upsertStats, performWrites: performWrites === true, run_id: runId || null };
}

async function applyDisneyBatchWrites(params = {}) {
  if (params.performWrites === false) return applyDisneyBatchWritesBody(params);
  return ensureGlobalCruiseWriteLockForMutation(params.supabase, {
    ownerId: params.runId,
    runId: params.runId,
    lineSlug: "disney-cruise-line",
    operation: params.operation || "disney_first_controlled_batch"
  }, () => applyDisneyBatchWritesBody(params));
}

function verifyInsertedRecords(insertedRows, frozenEntriesById, cruiseLineId) {
  const results = [];
  let verified = 0;
  let failed = 0;

  for (const row of insertedRows || []) {
    const frozen = frozenEntriesById.get(row.official_sailing_id);
    const checks = [
      ["cruise_line_id", row.cruise_line_id, cruiseLineId],
      ["official_sailing_id", row.official_sailing_id, frozen?.official_sailing_id],
      ["ship_id", row.ship_id, frozen?.ship_id],
      ["destination_id", row.destination_id, frozen?.destination_id],
      ["departure_date", row.departure_date, frozen?.departure_date],
      ["return_date", row.return_date, frozen?.return_date],
      ["nights", row.nights, frozen?.nights],
      ["departure_port", row.departure_port, frozen?.departure_port],
      ["identity_key", row.identity_key, frozen?.identity_key],
      ["external_key", row.external_key, frozen?.external_key],
      ["status", row.status, "active"]
    ];
    const mismatches = checks.filter(([, live, expected]) => String(live ?? "") !== String(expected ?? ""));
    const raw = row.raw_extract || {};
    const rawOk =
      raw.disney_sailing_id &&
      raw.disney_official_product_key &&
      raw.disney_adapter_id &&
      raw.disney_adapter_version;

    const ok = mismatches.length === 0 && rawOk;
    if (ok) verified += 1;
    else failed += 1;
    results.push({
      id: row.id,
      official_sailing_id: row.official_sailing_id,
      verified: ok,
      mismatches: mismatches.map(([f]) => f),
      raw_extract_ok: rawOk
    });
  }

  return { verified_count: verified, failed_count: failed, rows: results, passed: failed === 0 };
}

function verifyDuplicateChecks(insertedRows) {
  const officialIds = insertedRows.map((r) => r.official_sailing_id);
  const externalKeys = insertedRows.map((r) => r.external_key);
  const identityKeys = insertedRows.map((r) => r.identity_key);
  const legacyOverlap = insertedRows.filter((r) => DISNEY_LEGACY_ROW_IDS.includes(r.id));

  return {
    passed:
      new Set(officialIds).size === officialIds.length &&
      new Set(externalKeys).size === externalKeys.length &&
      new Set(identityKeys).size === identityKeys.length &&
      legacyOverlap.length === 0,
    unique_official_sailing_id: new Set(officialIds).size === officialIds.length,
    unique_external_key: new Set(externalKeys).size === externalKeys.length,
    unique_identity_key: new Set(identityKeys).size === identityKeys.length,
    legacy_overlap_count: legacyOverlap.length
  };
}

module.exports = {
  enhanceDisneyCandidate,
  indexExistingDisneyRecords,
  buildDisneyBatchManifest,
  applyDisneyBatchWrites,
  applyDisneyBatchWritesBody,
  verifyInsertedRecords,
  verifyDuplicateChecks,
  candidateMatchesFrozen,
  REJECTED_ACTIONS
};
