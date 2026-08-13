/**
 * Royal Caribbean International — dry-run manifest and write guards.
 * Prompt 2: apply functions must not mutate production. Write flags stay OFF.
 */

const crypto = require("crypto");
const {
  officialProductKey,
  officialGroupKey,
  ADAPTER_ID,
  ADAPTER_VERSION,
  isEligibleRoyalCaribbeanCruise,
  isRoyalCaribbeanCruisetour
} = require("./royal-caribbean-discovery-adapter");
const { cruiseIdentityKey } = require("./cruise-discovery-ops");
const {
  resolveRoyalCaribbeanDiscoveryMode,
  assertRoyalCaribbeanWritesAllowed
} = require("./royal-caribbean-discovery-mode");

function royalCaribbeanExternalKey(cruiseLineId, productKey) {
  const basis = [ADAPTER_ID, cruiseLineId || "", productKey || ""].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function isLegacyHtmlDiscoveryRow(row) {
  if (!row) return false;
  const sailingId =
    row.official_sailing_id ||
    row.raw_extract?.royal_caribbean_sailing_id ||
    row.raw_extract?.celebrity_sailing_id ||
    null;
  return !sailingId;
}

function buildRoyalCaribbeanUpsertCandidate(row, cruiseLine) {
  if (!row?.complete_high_confidence || !isEligibleRoyalCaribbeanCruise(row.product_type)) return null;
  if (row.status_class && row.status_class !== "open") return null;
  if (row.time_eligibility && row.time_eligibility !== "eligible") return null;
  const c = row.candidate || {};
  const productKey = officialProductKey(row.raw);
  if (!productKey || !cruiseLine?.id || !c.destination_id) return null;

  const external_key = royalCaribbeanExternalKey(cruiseLine.id, productKey);
  const identity_key = cruiseIdentityKey({
    cruiseLineId: cruiseLine.id,
    shipId: c.ship_id,
    departureDate: c.departure_date,
    officialUrl: c.official_url,
    nights: c.nights,
    returnDate: c.return_date,
    officialSailingId: productKey
  });

  return {
    ...c,
    cruise_line_id: cruiseLine.id,
    status: "active",
    match_confidence: "high",
    external_key,
    identity_key,
    official_sailing_id: productKey,
    raw_extract: {
      ...(c.raw_extract || {}),
      royal_caribbean_sailing_id: productKey,
      royal_caribbean_group_id: officialGroupKey(row.raw),
      royal_caribbean_product_type: row.product_type,
      royal_caribbean_adapter_id: ADAPTER_ID,
      royal_caribbean_adapter_version: ADAPTER_VERSION
    }
  };
}

function classifyProposedAction(row, existing) {
  if (isRoyalCaribbeanCruisetour(row.product_type)) return "ocean_cruisetour_skip";
  if (row.product_type === "unknown" || row.product_type === "malformed_or_unknown") return "invalid_skip";
  if (row.status_class === "unfamiliar_status" || row.status_class === "missing_status") {
    return "unfamiliar_status_skip";
  }
  if (row.time_eligibility === "past") return "past_skip";
  if (row.time_eligibility === "within_21_day_cutoff") return "within_21_day_cutoff_skip";
  if (!row.complete_high_confidence || !isEligibleRoyalCaribbeanCruise(row.product_type)) {
    return "incomplete_skip";
  }
  if (isLegacyHtmlDiscoveryRow(existing)) existing = null;
  if (!existing) return "insert_active";

  const existingKey =
    existing.official_sailing_id ||
    existing.raw_extract?.royal_caribbean_sailing_id ||
    null;
  const productKey = officialProductKey(row.raw);
  if (existingKey && productKey && existingKey === productKey) {
    const candidate = buildRoyalCaribbeanUpsertCandidate(row, { id: existing.cruise_line_id });
    if (!candidate) return "invalid_skip";
    const changed =
      existing.ship_id !== candidate.ship_id ||
      existing.destination_id !== candidate.destination_id ||
      existing.departure_date !== candidate.departure_date ||
      existing.return_date !== candidate.return_date ||
      existing.nights !== candidate.nights ||
      String(existing.departure_port || "") !== String(candidate.departure_port || "") ||
      existing.status !== "active";
    return changed ? "update_exact_legacy_match" : "duplicate_skip";
  }

  return "insert_active";
}

function buildManifestEntry(row, cruiseLine, destinations, existing) {
  const productKey = officialProductKey(row.raw);
  const groupKey = officialGroupKey(row.raw);
  const dest = destinations.find((d) => d.slug === row.destination_resolution?.destinationKey);
  const action = classifyProposedAction(row, existing);
  const candidate = buildRoyalCaribbeanUpsertCandidate(row, cruiseLine);

  return {
    official_royal_caribbean_sailing_id: productKey,
    official_royal_caribbean_group_id: groupKey,
    stable_identity_key: productKey,
    shared_official_url: false,
    product_type: row.product_type,
    source_url: row.raw?.official_url || row.candidate?.official_url || null,
    canonical_ship_id: row.ship_resolution?.ship?.id || row.candidate?.ship_id || null,
    canonical_ship_name: row.ship_resolution?.ship?.name || row.raw?.ship_name || null,
    official_ship_code: row.raw?.ship_code || null,
    departure_date: row.candidate?.departure_date || null,
    return_date: row.candidate?.return_date || null,
    nights: row.candidate?.nights || null,
    official_departure_port: row.raw?.departure_port || null,
    canonical_departure_port: row.candidate?.departure_port || null,
    arrival_port: row.raw?.arrival_port || null,
    destination_id: dest?.id || row.candidate?.destination_id || null,
    destination_name: dest?.name || row.destination_resolution?.destinationKey || null,
    round_trip: row.raw?.round_trip === true,
    sailing_status: row.sailing_status || row.raw?.sailing_status || null,
    confidence: row.adapter_confidence || null,
    completeness: row.complete_high_confidence ? "complete_high_confidence" : "incomplete",
    existing_record_match: existing && !isLegacyHtmlDiscoveryRow(existing) ? existing.id : null,
    existing_record_status: existing && !isLegacyHtmlDiscoveryRow(existing) ? existing.status : null,
    proposed_action: action,
    official_url: row.raw?.official_url || row.candidate?.official_url || null,
    candidate
  };
}

async function indexExistingRoyalCaribbeanRecords(supabase, cruiseLineId) {
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

  const byProductKey = new Map();
  const byIdentity = new Map();
  const byExternal = new Map();
  const legacyHtmlArtefacts = [];
  for (const row of rows || []) {
    if (isLegacyHtmlDiscoveryRow(row)) {
      legacyHtmlArtefacts.push({
        id: row.id,
        status: row.status,
        official_url: row.official_url || null,
        official_sailing_id: row.official_sailing_id || null
      });
      continue;
    }
    const pk = row.official_sailing_id || row.raw_extract?.royal_caribbean_sailing_id || null;
    if (pk) byProductKey.set(pk, row);
    if (row.identity_key) byIdentity.set(row.identity_key, row);
    if (row.external_key) byExternal.set(row.external_key, row);
  }
  return { rows: rows || [], byProductKey, byIdentity, byExternal, legacyHtmlArtefacts };
}

function findExistingRecord(indexes, row, cruiseLine) {
  const productKey = officialProductKey(row.raw);
  if (!productKey) return null;
  const external_key = royalCaribbeanExternalKey(cruiseLine.id, productKey);
  const identity_key = cruiseIdentityKey({
    cruiseLineId: cruiseLine.id,
    shipId: row.candidate?.ship_id,
    departureDate: row.candidate?.departure_date,
    officialUrl: row.candidate?.official_url,
    nights: row.candidate?.nights,
    returnDate: row.candidate?.return_date,
    officialSailingId: productKey
  });
  return (
    indexes.byProductKey.get(productKey) ||
    indexes.byIdentity.get(identity_key) ||
    indexes.byExternal.get(external_key) ||
    null
  );
}

async function buildRoyalCaribbeanBatchManifest({
  products,
  cruiseLine,
  destinations,
  supabase,
  runId
}) {
  const indexes = supabase
    ? await indexExistingRoyalCaribbeanRecords(supabase, cruiseLine.id)
    : { byProductKey: new Map(), byIdentity: new Map(), byExternal: new Map(), legacyHtmlArtefacts: [], rows: [] };

  const seenInsertKeys = new Set();
  const entries = (products || []).map((row) => {
    const existing = findExistingRecord(indexes, row, cruiseLine);
    const entry = buildManifestEntry(row, cruiseLine, destinations || [], existing);
    if (entry.proposed_action === "insert_active") {
      if (seenInsertKeys.has(entry.stable_identity_key)) {
        entry.proposed_action = "duplicate_skip";
      } else {
        seenInsertKeys.add(entry.stable_identity_key);
      }
    }
    return entry;
  });

  const urlCounts = new Map();
  for (const entry of entries) {
    const url = entry.source_url || entry.official_url;
    if (url) urlCounts.set(url, (urlCounts.get(url) || 0) + 1);
  }
  for (const entry of entries) {
    const url = entry.source_url || entry.official_url;
    entry.shared_official_url = url ? (urlCounts.get(url) || 0) > 1 : false;
  }

  return {
    generated_at: new Date().toISOString(),
    mode: "royal_caribbean_dry_run_manifest",
    run_id: runId || null,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    cruise_line_id: cruiseLine.id,
    writes_performed: false,
    actual_writes: 0,
    legacy_html_discovery_artefacts: indexes.legacyHtmlArtefacts || [],
    products: entries
  };
}

const { upsertCandidateRecord } = require("./cruise-discovery-ops");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");
const {
  MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
  ALLOWED_CONTROLLED_BATCH_SIZES,
  isAllowedControlledBatchMode,
  resolveManifestBatchLimit,
  resolveBatchProfile,
  validateFrozenManifest
} = require("./royal-caribbean-controlled-batch");

function assertControlledBatchManifest(manifest, options = {}) {
  if (!manifest || !isAllowedControlledBatchMode(manifest.mode)) {
    const err = new Error("Royal Caribbean controlled apply requires a frozen controlled_batch manifest");
    err.code = "royal_caribbean_missing_frozen_manifest";
    throw err;
  }
  const profile = resolveBatchProfile(manifest);
  if (options.confirmToken && options.confirmToken !== profile.confirm_token) {
    const err = new Error(
      `Royal Caribbean confirmation token mismatch for ${manifest.mode}: expected ${profile.confirm_token}`
    );
    err.code = "royal_caribbean_confirm_token_mismatch";
    throw err;
  }
  const hardMax = resolveManifestBatchLimit(manifest);
  const entries = manifest.entries || [];
  if (!ALLOWED_CONTROLLED_BATCH_SIZES.has(entries.length)) {
    const err = new Error(
      `Royal Caribbean controlled batch size not allowed: ${entries.length} (allowed: 20, 100)`
    );
    err.code = "royal_caribbean_batch_size_not_allowed";
    throw err;
  }
  if (entries.length > hardMax) {
    const err = new Error(
      `Royal Caribbean controlled batch hard limit exceeded: ${entries.length} > ${hardMax}`
    );
    err.code = "royal_caribbean_batch_limit_exceeded";
    throw err;
  }
  if (options.expectedCount != null && entries.length !== options.expectedCount) {
    const err = new Error(
      `Royal Caribbean manifest count mismatch: expected ${options.expectedCount}, got ${entries.length}`
    );
    err.code = "royal_caribbean_manifest_count_mismatch";
    throw err;
  }
  if (options.expectedHash && manifest.manifest_hash !== options.expectedHash) {
    const err = new Error("Royal Caribbean manifest hash mismatch");
    err.code = "royal_caribbean_manifest_hash_mismatch";
    throw err;
  }
  const validation = validateFrozenManifest(manifest, {
    expectedHash: options.expectedHash || null,
    today: manifest.perth_today || options.today || null,
    priorSailingIds: options.priorSailingIds || manifest.exclude_overlap_ids || []
  });
  if (!validation.passed) {
    const err = new Error(`Royal Caribbean manifest validation failed: ${validation.failures.join("; ")}`);
    err.code = "royal_caribbean_manifest_validation_failed";
    err.failures = validation.failures;
    throw err;
  }
  return validation;
}

async function applyRoyalCaribbeanControlledManifest({
  manifest,
  cruiseLine,
  supabase,
  runId,
  expectedHash = null,
  expectedCount = null,
  maxWrites = null,
  confirmToken = null,
  performWrites = true
}) {
  const manifestLimit = resolveManifestBatchLimit(manifest);
  const hardMax = Math.min(maxWrites ?? manifestLimit, manifestLimit);
  const count = expectedCount ?? manifestLimit;
  assertControlledBatchManifest(manifest, {
    expectedHash,
    expectedCount: count,
    confirmToken,
    today: manifest.perth_today,
    priorSailingIds: manifest.exclude_overlap_ids || []
  });

  const entries = manifest.entries || [];
  if (entries.length > hardMax) {
    const err = new Error(`Abort before write: manifest contains ${entries.length} records (max ${hardMax})`);
    err.code = "royal_caribbean_batch_limit_exceeded";
    throw err;
  }

  const stats = {
    attempted: 0,
    inserted: 0,
    duplicate_skips: 0,
    failed: 0,
    stopped_early: false,
    write_details: [],
    inserted_ids: [],
    manifest_hash: manifest.manifest_hash,
    expected_insert_count: entries.length
  };

  const indexes = supabase ? await indexExistingRoyalCaribbeanRecords(supabase, cruiseLine.id) : null;
  const upsertStats = { new: 0, upserted_active: 0, cruises_inserted: 0, cruises_updated: 0 };

  for (const entry of entries) {
    if (stats.inserted >= hardMax) break;
    if (entry.proposed_action !== "insert_active") {
      stats.duplicate_skips += 1;
      continue;
    }

    stats.attempted += 1;
    const candidate = entry.candidate;
    if (!candidate?.cruise_line_id || !candidate?.ship_id || !candidate?.destination_id) {
      stats.failed += 1;
      stats.stopped_early = true;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "failed",
        error: "missing_write_candidate"
      });
      break;
    }

    const existing =
      indexes?.byProductKey.get(entry.official_sailing_id) ||
      indexes?.byIdentity.get(entry.identity_key) ||
      indexes?.byExternal.get(entry.external_key) ||
      null;

    if (existing && !isLegacyHtmlDiscoveryRow(existing)) {
      stats.duplicate_skips += 1;
      stats.stopped_early = true;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        discovered_cruise_id: existing.id,
        result_action: "duplicate_abort",
        error: "official_sailing_id_already_exists"
      });
      break;
    }

    if (!performWrites) continue;

    try {
      const result = await upsertCandidateRecord(candidate, upsertStats, {
        prevRecord: null,
        matchPolicy: "official_sailing_id_only",
        syncDestinationLinks: false
      });
      if (!result.created || !result.row?.id) {
        stats.failed += 1;
        stats.stopped_early = true;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          result_action: result.duplicate ? "duplicate_abort" : "failed",
          discovered_cruise_id: result.row?.id || null,
          error: result.duplicate ? "duplicate_during_insert" : "insert_not_created"
        });
        break;
      }

      stats.inserted += 1;
      stats.inserted_ids.push(result.row.id);
      if (indexes) {
        indexes.byProductKey.set(entry.official_sailing_id, result.row);
        if (result.row.identity_key) indexes.byIdentity.set(result.row.identity_key, result.row);
        if (result.row.external_key) indexes.byExternal.set(result.row.external_key, result.row);
      }
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        discovered_cruise_id: result.row.id,
        external_key: candidate.external_key,
        identity_key: candidate.identity_key,
        result_action: "inserted",
        created: true,
        rollback_snapshot: snapshotRecordForRollback(result.row)
      });
    } catch (error) {
      stats.failed += 1;
      stats.stopped_early = true;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "failed",
        error: error.message || String(error)
      });
      break;
    }
  }

  return { stats, run_id: runId, upsert_stats: upsertStats };
}

const {
  MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK,
  CATCHUP_CONFIRM_TOKEN,
  CATCHUP_CHUNK_MODE,
  validateCatchupChunk
} = require("./royal-caribbean-final-catchup");

function assertCatchupChunkManifest(chunkManifest, masterManifest, options = {}) {
  if (!chunkManifest || chunkManifest.mode !== CATCHUP_CHUNK_MODE) {
    const err = new Error("Royal Caribbean catch-up apply requires a frozen chunk manifest");
    err.code = "royal_caribbean_missing_catchup_chunk_manifest";
    throw err;
  }
  if (options.confirmToken && options.confirmToken !== CATCHUP_CONFIRM_TOKEN) {
    const err = new Error(
      `Royal Caribbean confirmation token mismatch: expected ${CATCHUP_CONFIRM_TOKEN}`
    );
    err.code = "royal_caribbean_confirm_token_mismatch";
    throw err;
  }
  const entries = chunkManifest.entries || [];
  if (entries.length === 0 || entries.length > MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK) {
    const err = new Error(
      `Royal Caribbean catch-up chunk size invalid: ${entries.length} (max ${MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK})`
    );
    err.code = "royal_caribbean_catchup_chunk_size_invalid";
    throw err;
  }
  if (options.expectedCount != null && entries.length !== options.expectedCount) {
    const err = new Error(
      `Royal Caribbean catch-up chunk count mismatch: expected ${options.expectedCount}, got ${entries.length}`
    );
    err.code = "royal_caribbean_manifest_count_mismatch";
    throw err;
  }
  if (options.expectedHash && chunkManifest.manifest_hash !== options.expectedHash) {
    const err = new Error("Royal Caribbean manifest hash mismatch");
    err.code = "royal_caribbean_manifest_hash_mismatch";
    throw err;
  }
  const validation = validateCatchupChunk(chunkManifest, masterManifest, {
    expectedHash: options.expectedHash || null,
    today: chunkManifest.perth_today || options.today || null
  });
  if (!validation.passed) {
    const err = new Error(`Royal Caribbean catch-up chunk validation failed: ${validation.failures.join("; ")}`);
    err.code = "royal_caribbean_manifest_validation_failed";
    err.failures = validation.failures;
    throw err;
  }
  return validation;
}

async function applyRoyalCaribbeanCatchupChunk({
  chunkManifest,
  masterManifest,
  cruiseLine,
  supabase,
  runId,
  expectedHash = null,
  expectedCount = null,
  confirmToken = null,
  performWrites = true
}) {
  assertCatchupChunkManifest(chunkManifest, masterManifest, {
    expectedHash,
    expectedCount,
    confirmToken,
    today: chunkManifest.perth_today
  });

  const entries = chunkManifest.entries || [];
  const stats = {
    attempted: 0,
    inserted: 0,
    duplicate_skips: 0,
    failed: 0,
    stopped_early: false,
    write_details: [],
    inserted_ids: [],
    manifest_hash: chunkManifest.manifest_hash,
    expected_insert_count: entries.length
  };

  const indexes = supabase ? await indexExistingRoyalCaribbeanRecords(supabase, cruiseLine.id) : null;
  const upsertStats = { new: 0, upserted_active: 0, cruises_inserted: 0, cruises_updated: 0 };

  for (const entry of entries) {
    if (entry.proposed_action !== "insert_active") {
      stats.duplicate_skips += 1;
      continue;
    }

    stats.attempted += 1;
    const candidate = entry.candidate;
    if (!candidate?.cruise_line_id || !candidate?.ship_id || !candidate?.destination_id) {
      stats.failed += 1;
      stats.stopped_early = true;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "failed",
        error: "missing_write_candidate"
      });
      break;
    }

    const existing =
      indexes?.byProductKey.get(entry.official_sailing_id) ||
      indexes?.byIdentity.get(entry.identity_key) ||
      indexes?.byExternal.get(entry.external_key) ||
      null;

    if (existing && !isLegacyHtmlDiscoveryRow(existing)) {
      stats.duplicate_skips += 1;
      stats.stopped_early = true;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        discovered_cruise_id: existing.id,
        result_action: "duplicate_abort",
        error: "official_sailing_id_already_exists"
      });
      break;
    }

    if (!performWrites) continue;

    try {
      const result = await upsertCandidateRecord(candidate, upsertStats, {
        prevRecord: null,
        matchPolicy: "official_sailing_id_only",
        syncDestinationLinks: false
      });
      if (!result.created || !result.row?.id) {
        stats.failed += 1;
        stats.stopped_early = true;
        stats.write_details.push({
          official_sailing_id: entry.official_sailing_id,
          result_action: result.duplicate ? "duplicate_abort" : "failed",
          discovered_cruise_id: result.row?.id || null,
          error: result.duplicate ? "duplicate_during_insert" : "insert_not_created"
        });
        break;
      }

      stats.inserted += 1;
      stats.inserted_ids.push(result.row.id);
      if (indexes) {
        indexes.byProductKey.set(entry.official_sailing_id, result.row);
        if (result.row.identity_key) indexes.byIdentity.set(result.row.identity_key, result.row);
        if (result.row.external_key) indexes.byExternal.set(result.row.external_key, result.row);
      }
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        discovered_cruise_id: result.row.id,
        external_key: candidate.external_key,
        identity_key: candidate.identity_key,
        result_action: "inserted",
        created: true,
        rollback_snapshot: snapshotRecordForRollback(result.row)
      });
    } catch (error) {
      stats.failed += 1;
      stats.stopped_early = true;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "failed",
        error: error.message || String(error)
      });
      break;
    }
  }

  return { stats, run_id: runId, upsert_stats: upsertStats };
}

async function applyRoyalCaribbeanBatchWrites(options = {}) {
  const modeGate = resolveRoyalCaribbeanDiscoveryMode(options.mode || "simulation");
  assertRoyalCaribbeanWritesAllowed(modeGate);

  if (modeGate.mode === "controlled_batch" && options.manifest) {
    return applyRoyalCaribbeanControlledManifest({
      manifest: options.manifest,
      cruiseLine: options.cruiseLine,
      supabase: options.supabase,
      runId: options.runId,
      expectedHash: options.expectedHash,
      expectedCount: options.expectedCount,
      maxWrites: options.maxWrites,
      confirmToken: options.confirmToken,
      performWrites: options.performWrites !== false
    });
  }

  if (modeGate.mode === "final_catchup" && options.chunkManifest && options.masterManifest) {
    return applyRoyalCaribbeanCatchupChunk({
      chunkManifest: options.chunkManifest,
      masterManifest: options.masterManifest,
      cruiseLine: options.cruiseLine,
      supabase: options.supabase,
      runId: options.runId,
      expectedHash: options.expectedHash,
      expectedCount: options.expectedCount,
      confirmToken: options.confirmToken,
      performWrites: options.performWrites !== false
    });
  }

  const err = new Error(
    "Royal Caribbean production writes require controlled_batch or final_catchup mode with a frozen manifest"
  );
  err.code = "royal_caribbean_writes_disabled";
  throw err;
}

module.exports = {
  MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
  royalCaribbeanExternalKey,
  isLegacyHtmlDiscoveryRow,
  buildRoyalCaribbeanUpsertCandidate,
  classifyProposedAction,
  indexExistingRoyalCaribbeanRecords,
  buildRoyalCaribbeanBatchManifest,
  assertControlledBatchManifest,
  assertCatchupChunkManifest,
  applyRoyalCaribbeanControlledManifest,
  applyRoyalCaribbeanCatchupChunk,
  applyRoyalCaribbeanBatchWrites
};
