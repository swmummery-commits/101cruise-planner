/**
 * Carnival Cruise Line controlled-batch manifest + production writes.
 */

const crypto = require("crypto");
const {
  officialSailingId,
  officialProductKey,
  immutableIdentitySnapshot,
  ADAPTER_ID,
  ADAPTER_VERSION
} = require("./carnival-discovery-adapter");
const { SOURCE_ID } = require("./carnival-discovery-source");
const { cruiseIdentityKey, upsertCandidateRecord } = require("./cruise-discovery-ops");
const { ensureGlobalCruiseWriteLockForMutation } = require("./cruise-discovery-global-write-lock");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");
const { evaluateDiscoveryConfidence } = require("./discovery-confidence");
const { CCL_LINE_ID } = require("./carnival-controlled-batch");

function cclExternalKey(cruiseLineId, sailingId) {
  const basis = [ADAPTER_ID, cruiseLineId || "", sailingId || ""].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function isOfficialCclStructuredRecord(row) {
  const structuredSource = row?.raw_extract?.structured_source;
  return structuredSource === SOURCE_ID && Boolean(String(row?.official_sailing_id || "").trim());
}

function isLegacyGenericCclRow(row) {
  if (isOfficialCclStructuredRecord(row)) return false;
  if (!row?.official_sailing_id) return true;
  return row?.raw_extract?.structured_source !== SOURCE_ID;
}

function buildCclUpsertCandidate(row, cruiseLine) {
  if (!row?.eligibility?.discovery_ready) return null;
  const sailingId = officialSailingId(row.raw);
  if (!sailingId || !cruiseLine?.id) return null;

  const c = row.candidate || {};
  if (!c.ship_id || !c.destination_id || !c.departure_date) return null;

  const identity_key = cruiseIdentityKey({
    cruiseLineId: cruiseLine.id,
    shipId: c.ship_id,
    departureDate: c.departure_date,
    officialUrl: c.official_url,
    nights: c.nights,
    returnDate: c.return_date,
    officialSailingId: sailingId
  });

  const confidenceEval = evaluateDiscoveryConfidence({
    ...c,
    cruiseLine,
    cruise_line_name: cruiseLine.name,
    title: c.itinerary,
    url: c.official_url,
    official_url: c.official_url,
    structured_source: SOURCE_ID,
    sailing_id: sailingId,
    itinerary_code: row.raw?.itinerary_code,
    ship_code: row.raw?.ship_code,
    shipResolution: row.ship_resolution,
    destinationResolution: row.destination_resolution,
    raw_extract: c.raw_extract
  });

  return {
    ...c,
    cruise_line_id: cruiseLine.id,
    match_confidence: confidenceEval.confidence === "high" ? "high" : "medium",
    external_key: cclExternalKey(cruiseLine.id, sailingId),
    identity_key,
    official_sailing_id: sailingId,
    raw_extract: {
      ...(c.raw_extract || {}),
      ccl_sailing_id: sailingId,
      ccl_itinerary_code: row.raw?.itinerary_code || null,
      ccl_ship_code: row.raw?.ship_code || null,
      ccl_group_id: row.raw?.group_id || null,
      ccl_region_code: row.raw?.region_code || null,
      ccl_region_name: row.raw?.region_name || null,
      ccl_adapter_id: ADAPTER_ID,
      ccl_adapter_version: ADAPTER_VERSION,
      ccl_controlled_batch: true,
      structured_source: SOURCE_ID,
      destination_key: row.destination_resolution?.destinationKey || null,
      ship_match_method: row.ship_resolution?.method || null,
      discovery_confidence_outcome: confidenceEval.outcome
    }
  };
}

function classifyProposedAction(row, existingOfficial, existingLegacyMatch) {
  if (!row.eligibility?.discovery_ready) {
    const reason = row.eligibility?.primary_exclusion_reason || "not_discovery_ready";
    if (reason === "within_21_day_cutoff" || reason === "past_departure") return "cutoff_excluded";
    return "not_discovery_ready";
  }

  const sailingId = officialSailingId(row.raw);
  if (!sailingId) return "missing_official_sailing_id";

  if (existingOfficial) {
    const candidate = buildCclUpsertCandidate(row, { id: existingOfficial.cruise_line_id });
    if (!candidate) return "invalid_skip";
    const changed =
      existingOfficial.ship_id !== candidate.ship_id ||
      existingOfficial.destination_id !== candidate.destination_id ||
      existingOfficial.departure_date !== candidate.departure_date ||
      existingOfficial.return_date !== candidate.return_date ||
      existingOfficial.nights !== candidate.nights ||
      String(existingOfficial.departure_port || "") !== String(candidate.departure_port || "") ||
      String(existingOfficial.itinerary || "") !== String(candidate.itinerary || "");
    return changed ? "update_official_match" : "duplicate_skip";
  }

  if (existingLegacyMatch) return "legacy_collision_review";

  return "insert_active";
}

function buildManifestEntry(row, cruiseLine, existingOfficial, existingLegacyMatch, batchPosition) {
  const sailingId = officialSailingId(row.raw);
  const candidate = buildCclUpsertCandidate(row, cruiseLine);
  const action = classifyProposedAction(row, existingOfficial, existingLegacyMatch);
  const expectedStatus = candidate ? "active" : null;

  return {
    batch_position: batchPosition,
    official_sailing_id: sailingId,
    stable_identity_key: sailingId,
    itinerary_code: row.raw?.itinerary_code || null,
    ship_code: row.raw?.ship_code || null,
    canonical_ship_id: row.ship_resolution?.ship?.id || row.candidate?.ship_id || null,
    canonical_ship_name: row.ship_resolution?.ship?.name || row.raw?.ship_name || null,
    departure_date: row.candidate?.departure_date || null,
    return_date: row.candidate?.return_date || null,
    nights: row.candidate?.nights || null,
    departure_port: row.candidate?.departure_port || null,
    canonical_departure_port: row.candidate?.departure_port_meta?.canonicalPortName || null,
    region_code: row.raw?.region_code || null,
    region_name: row.raw?.region_name || null,
    destination_id: row.candidate?.destination_id || null,
    destination_name: row.destination_resolution?.destinationName || null,
    title: row.candidate?.itinerary || row.raw?.itinerary_title || null,
    official_url: row.candidate?.official_url || row.raw?.official_url || null,
    identity_key: candidate?.identity_key || null,
    external_key: candidate?.external_key || null,
    source_snapshot: immutableIdentitySnapshot(row.raw),
    existing_official_record_id: existingOfficial?.id || null,
    existing_legacy_record_id: existingLegacyMatch?.id || null,
    proposed_action: action,
    expected_status: expectedStatus,
    candidate,
    raw: row.raw
  };
}

async function indexExistingCclRecords(supabase, cruiseLineId) {
  const select =
    "id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,status,official_url,external_key,identity_key,official_sailing_id,raw_extract";
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const batch = await supabase(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&select=${select}&limit=${pageSize}&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  const officialBySailingId = new Map();
  const legacyRows = [];
  for (const row of rows) {
    if (isOfficialCclStructuredRecord(row) && row.official_sailing_id) {
      officialBySailingId.set(String(row.official_sailing_id), row);
    } else if (isLegacyGenericCclRow(row)) {
      legacyRows.push(row);
    }
  }
  return { rows, officialBySailingId, legacyRows };
}

function findExistingOfficial(indexes, row) {
  const sailingId = officialSailingId(row.raw);
  return sailingId ? indexes.officialBySailingId.get(sailingId) || null : null;
}

function findLegacyCollision(indexes, row) {
  const candidate = row.candidate || {};
  for (const legacy of indexes.legacyRows || []) {
    if (legacy.ship_id && candidate.ship_id && legacy.ship_id === candidate.ship_id) {
      if (legacy.departure_date && candidate.departure_date && legacy.departure_date === candidate.departure_date) {
        return legacy;
      }
    }
  }
  return null;
}

async function buildCclBatchManifest({ products, cruiseLine, supabase, selectedOnly = null }) {
  const indexes = supabase ? await indexExistingCclRecords(supabase, cruiseLine.id) : { officialBySailingId: new Map(), legacyRows: [] };
  const sourceRows = selectedOnly || products || [];
  const entries = sourceRows.map((row, index) => {
    const existingOfficial = findExistingOfficial(indexes, row);
    const legacyMatch = findLegacyCollision(indexes, row);
    return buildManifestEntry(row, cruiseLine, existingOfficial, legacyMatch, index + 1);
  });

  return {
    generated_at: new Date().toISOString(),
    mode: "carnival_batch_manifest",
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    cruise_line_id: cruiseLine.id,
    writes_performed: false,
    legacy_rows_excluded: indexes.legacyRows?.length || 0,
    official_rows_existing: indexes.officialBySailingId?.size || 0,
    entries
  };
}

function evaluatePreflightWritePlan(entries, { maxWrites = 20 } = {}) {
  const actionable = (entries || []).filter((entry) =>
    ["insert_active", "update_official_match"].includes(entry.proposed_action)
  );
  const inserts = actionable.filter((entry) => entry.proposed_action === "insert_active");
  const updates = actionable.filter((entry) => entry.proposed_action === "update_official_match");
  const legacyCollisions = (entries || []).filter((entry) => entry.proposed_action === "legacy_collision_review");
  const conflicts = (entries || []).filter((entry) =>
    ["legacy_collision_review", "missing_official_sailing_id", "invalid_skip"].includes(entry.proposed_action)
  );

  const failures = [];
  if (actionable.length > maxWrites) failures.push(`proposed_writes_exceed_cap:${actionable.length}`);
  if (legacyCollisions.length) failures.push(`legacy_collisions:${legacyCollisions.length}`);
  if (updates.length) failures.push(`unexpected_updates:${updates.length}`);

  return {
    candidates_selected: entries.length,
    inserts: inserts.length,
    updates: updates.length,
    skipped: (entries || []).filter((entry) => entry.proposed_action === "duplicate_skip").length,
    conflicts,
    legacy_collisions: legacyCollisions,
    actionable,
    ok: failures.length === 0 && inserts.length <= maxWrites,
    failures
  };
}

async function applyCclBatchWritesBody({
  manifest,
  cruiseLine,
  maxWrites = 20,
  runId,
  supabase,
  performWrites = true,
  expectedHash = null
}) {
  if (expectedHash && manifest?.manifest_hash && expectedHash !== manifest.manifest_hash) {
    throw new Error("Manifest hash mismatch at apply");
  }

  const stats = {
    inserted: 0,
    updated: 0,
    duplicate_skips: 0,
    invalid_skips: 0,
    legacy_collisions: 0,
    failed: 0,
    write_details: []
  };

  const indexes = supabase ? await indexExistingCclRecords(supabase, cruiseLine.id) : null;
  const upsertStats = { new: 0, upserted_active: 0, cruises_inserted: 0, cruises_updated: 0 };
  let writesRemaining = maxWrites;

  for (const entry of manifest.entries || []) {
    if (!["insert_active", "update_official_match"].includes(entry.proposed_action)) {
      if (entry.proposed_action === "duplicate_skip") stats.duplicate_skips += 1;
      else if (entry.proposed_action === "legacy_collision_review") stats.legacy_collisions += 1;
      else stats.invalid_skips += 1;
      continue;
    }
    if (writesRemaining <= 0) break;

    const candidate = entry.candidate;
    if (!candidate) {
      stats.invalid_skips += 1;
      continue;
    }

    const existingOfficial = indexes?.officialBySailingId.get(String(entry.official_sailing_id)) || null;

    if (!performWrites) {
      writesRemaining -= 1;
      continue;
    }

    try {
      const before = existingOfficial ? snapshotRecordForRollback(existingOfficial) : null;
      const result = await upsertCandidateRecord(candidate, upsertStats, {
        matchPolicy: "official_sailing_id_only",
        syncDestinationLinks: true,
        prevRecord: entry.proposed_action === "update_official_match" ? existingOfficial : null
      });
      writesRemaining -= 1;
      if (result.created) stats.inserted += 1;
      else stats.updated += 1;
      stats.write_details.push({
        discovered_cruise_id: result.row?.id || null,
        official_sailing_id: candidate.official_sailing_id,
        proposed_action: entry.proposed_action,
        result_action: result.created ? "inserted" : "updated",
        status: result.status,
        rollback_before: before
      });
    } catch (error) {
      stats.failed += 1;
      stats.write_details.push({
        official_sailing_id: candidate.official_sailing_id,
        proposed_action: entry.proposed_action,
        error: error.message || String(error)
      });
    }
  }

  return { stats, upsertStats, performWrites: performWrites === true, rollback_entries: stats.write_details };
}

async function applyCclBatchWrites(params = {}) {
  if (params.performWrites === false) return applyCclBatchWritesBody(params);
  return ensureGlobalCruiseWriteLockForMutation(params.supabase, {
    ownerId: params.runId,
    runId: params.runId,
    lineSlug: params.cruiseLine?.slug,
    operation: "carnival_controlled_batch_apply"
  }, () => applyCclBatchWritesBody(params));
}

module.exports = {
  CCL_LINE_ID,
  cclExternalKey,
  isOfficialCclStructuredRecord,
  isLegacyGenericCclRow,
  buildCclUpsertCandidate,
  classifyProposedAction,
  buildManifestEntry,
  indexExistingCclRecords,
  buildCclBatchManifest,
  evaluatePreflightWritePlan,
  applyCclBatchWrites
};
