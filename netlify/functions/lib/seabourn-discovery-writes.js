/**
 * Seabourn controlled-batch manifest + production writes.
 */

const crypto = require("crypto");
const {
  officialProductKey,
  ADAPTER_ID,
  ADAPTER_VERSION,
  isEligibleSeabournInventory
} = require("./seabourn-discovery-adapter");
const { cruiseIdentityKey, upsertCandidateRecord  } = require("./cruise-discovery-ops");
const { ensureGlobalCruiseWriteLockForMutation } = require("./cruise-discovery-global-write-lock");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");

function seabournExternalKey(cruiseLineId, productKey) {
  const basis = [ADAPTER_ID, cruiseLineId || "", productKey || ""].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function isSeabournCruisetour(productType) {
  return productType === "cruisetour";
}

function buildSeabournUpsertCandidate(row, cruiseLine) {
  if (!row?.eligibility?.production_eligible || !isEligibleSeabournInventory(row.product_type)) return null;
  const c = row.candidate || {};
  const productKey = officialProductKey(row.raw);
  if (!productKey || !cruiseLine?.id || !c.destination_id) return null;

  const external_key = seabournExternalKey(cruiseLine.id, productKey);
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
      seabourn_sailing_id: productKey,
      seabourn_cruise_id: row.raw?.cruise_id || null,
      seabourn_itinerary_id: row.raw?.itinerary_id || null,
      seabourn_product_type: row.product_type,
      seabourn_adapter_id: ADAPTER_ID,
      seabourn_adapter_version: ADAPTER_VERSION,
      seabourn_batch_write: true,
      structured_source: row.raw?.structured_source || "sbncruisesearch_api",
      destination_key: row.destination_resolution?.destinationKey || null,
      ship_match_method: row.ship_resolution?.method || null
    }
  };
}

function classifyProposedAction(row, existing) {
  if (isSeabournCruisetour(row.product_type)) return "policy_excluded_cruisetour";
  if (!isEligibleSeabournInventory(row.product_type)) return "policy_excluded_product_type";
  if (!row.eligibility?.production_eligible) {
    const reason = row.eligibility?.primary_exclusion_reason || "not_production_eligible";
    if (reason === "within_21_day_cutoff" || reason === "past_departure") return "cutoff_excluded";
    if (reason === "required_embark_port_unresolved") return "embark_port_unresolved";
    if (reason === "required_ship_unresolved") return "ship_unresolved";
    if (reason === "required_destination_unresolved") return "destination_unresolved";
    if (reason === "confidence_gate_failure") return "confidence_blocked";
    return "not_production_eligible";
  }
  if (!existing) return "insert_active";

  const existingKey =
    existing.official_sailing_id || existing.raw_extract?.seabourn_sailing_id || null;
  const productKey = officialProductKey(row.raw);

  if (existingKey && productKey && existingKey === productKey) {
    const candidate = buildSeabournUpsertCandidate(row, { id: existing.cruise_line_id });
    if (!candidate) return "invalid_skip";
    const changed =
      existing.ship_id !== candidate.ship_id ||
      existing.destination_id !== candidate.destination_id ||
      existing.departure_date !== candidate.departure_date ||
      existing.return_date !== candidate.return_date ||
      existing.nights !== candidate.nights ||
      String(existing.departure_port || "") !== String(candidate.departure_port || "") ||
      String(existing.itinerary || "") !== String(candidate.itinerary || "") ||
      existing.status !== "active";
    return changed ? "update_exact_legacy_match" : "duplicate_skip";
  }

  return "insert_active";
}

function buildManifestEntry(row, cruiseLine, destinations, existing) {
  const productKey = officialProductKey(row.raw);
  const dest = destinations.find((d) => d.slug === row.destination_resolution?.destinationKey);
  const action = classifyProposedAction(row, existing);
  const candidate = buildSeabournUpsertCandidate(row, cruiseLine);

  const rollback =
    existing && action === "update_exact_legacy_match"
      ? {
          ship_id: existing.ship_id,
          destination_id: existing.destination_id,
          departure_date: existing.departure_date,
          return_date: existing.return_date,
          nights: existing.nights,
          departure_port: existing.departure_port,
          itinerary: existing.itinerary,
          status: existing.status,
          official_url: existing.official_url,
          raw_extract: existing.raw_extract
        }
      : action === "insert_active"
        ? { delete_on_rollback: true }
        : null;

  return {
    official_seabourn_sailing_id: productKey,
    stable_product_identity_key: productKey,
    stable_identity_key: productKey,
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
    destination_id: dest?.id || row.candidate?.destination_id || null,
    destination_name: dest?.name || row.destination_resolution?.destinationKey || null,
    completeness: row.eligibility?.production_eligible ? "production_eligible" : "not_production_eligible",
    primary_exclusion_reason: row.eligibility?.primary_exclusion_reason || null,
    existing_record_match: existing?.id || null,
    existing_record_status: existing?.status || null,
    proposed_action: action,
    rollback,
    official_url: row.raw?.official_url || row.candidate?.official_url || null,
    candidate
  };
}

async function indexExistingSeabournRecords(supabase, cruiseLineId) {
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
  for (const row of rows || []) {
    const pk = row.official_sailing_id || row.raw_extract?.seabourn_sailing_id || null;
    if (pk) byProductKey.set(pk, row);
  }
  return { rows: rows || [], byProductKey };
}

function findExistingRecord(indexes, row) {
  const productKey = officialProductKey(row.raw);
  return indexes.byProductKey.get(productKey) || null;
}

async function buildSeabournBatchManifest({ products, cruiseLine, destinations, supabase, runId }) {
  const indexes = supabase
    ? await indexExistingSeabournRecords(supabase, cruiseLine.id)
    : { byProductKey: new Map() };

  const entries = (products || []).map((row) => {
    const existing = findExistingRecord(indexes, row);
    return buildManifestEntry(row, cruiseLine, destinations, existing);
  });

  return {
    generated_at: new Date().toISOString(),
    mode: "seabourn_batch_manifest",
    run_id: runId || null,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    cruise_line_id: cruiseLine.id,
    writes_performed: false,
    products: entries
  };
}

function assertSeabournWriteCandidate(candidate, cruiseLine) {
  if (!candidate) {
    const err = new Error("seabourn_write_candidate_missing");
    err.code = "seabourn_write_candidate_missing";
    throw err;
  }
  if (!candidate.cruise_line_id) {
    const err = new Error("seabourn_write_candidate_missing_cruise_line_id");
    err.code = "seabourn_write_candidate_missing_cruise_line_id";
    throw err;
  }
  if (cruiseLine?.id && candidate.cruise_line_id !== cruiseLine.id) {
    const err = new Error("seabourn_write_candidate_cruise_line_mismatch");
    err.code = "seabourn_write_candidate_cruise_line_mismatch";
    throw err;
  }
  if (!candidate.ship_id) {
    const err = new Error("seabourn_write_candidate_missing_ship_id");
    err.code = "seabourn_write_candidate_missing_ship_id";
    throw err;
  }
  return candidate;
}

async function applySeabournBatchWritesBody({
  products,
  cruiseLine,
  maxWrites = 100,
  runId,
  supabase,
  destinations,
  performWrites = true,
  maintenanceTrace = null
}) {
  const stats = {
    inserted: 0,
    updated: 0,
    duplicate_skips: 0,
    policy_excluded_skips: 0,
    cutoff_skips: 0,
    resolution_skips: 0,
    invalid_skips: 0,
    failed: 0,
    write_details: []
  };

  let writesRemaining = maxWrites;
  const indexes = supabase ? await indexExistingSeabournRecords(supabase, cruiseLine.id) : null;
  const upsertStats = { new: 0, upserted_active: 0, cruises_inserted: 0, cruises_updated: 0 };

  for (const row of products || []) {
    if (!row.eligibility?.production_eligible) {
      if (isSeabournCruisetour(row.product_type)) stats.policy_excluded_skips += 1;
      else if (row.eligibility?.primary_exclusion_reason === "within_21_day_cutoff") stats.cutoff_skips += 1;
      else stats.resolution_skips += 1;
      continue;
    }

    const existing = indexes ? findExistingRecord(indexes, row) : null;
    const action = classifyProposedAction(row, existing);
    if (action === "duplicate_skip") {
      stats.duplicate_skips += 1;
      continue;
    }
    if (!["insert_active", "update_exact_legacy_match"].includes(action)) {
      stats.invalid_skips += 1;
      continue;
    }
    if (writesRemaining <= 0) break;

    const built = buildSeabournUpsertCandidate(row, cruiseLine);
    if (!built) {
      stats.invalid_skips += 1;
      continue;
    }

    let candidate;
    try {
      candidate = assertSeabournWriteCandidate(built, cruiseLine);
    } catch (validationError) {
      stats.failed += 1;
      stats.write_details.push({
        seabourn_sailing_id: built.official_sailing_id || officialProductKey(row.raw),
        proposed_action: action,
        error: validationError.message || String(validationError)
      });
      continue;
    }

    if (!performWrites) continue;

    try {
      const before = existing ? snapshotRecordForRollback(existing) : null;
      const result = await upsertCandidateRecord(candidate, upsertStats, {
        matchPolicy: "official_sailing_id_only",
        syncDestinationLinks: false,
        prevRecord: action === "update_exact_legacy_match" ? existing : null
      });
      writesRemaining -= 1;
      if (result.created) stats.inserted += 1;
      else stats.updated += 1;
      stats.write_details.push({
        discovered_cruise_id: result.row?.id || null,
        seabourn_sailing_id: candidate.official_sailing_id,
        proposed_action: action,
        result_action: result.created ? "inserted" : "updated",
        created: result.created === true,
        rollback_before: before
      });
    } catch (error) {
      stats.failed += 1;
      stats.write_details.push({
        seabourn_sailing_id: candidate.official_sailing_id,
        proposed_action: action,
        error: error.message || String(error)
      });
    }
  }

  return { stats, upsertStats, performWrites: performWrites === true };
}

async function applySeabournBatchWrites(params = {}) {
  if (params.performWrites === false) return applySeabournBatchWritesBody(params);
  return ensureGlobalCruiseWriteLockForMutation(params.supabase, {
    ownerId: params.runId,
    runId: params.runId,
    lineSlug: params.cruiseLine?.slug,
    operation: params.mode || params.operation || "seabourn_batch_apply"
  }, () => applySeabournBatchWritesBody(params));
}

module.exports = {
  seabournExternalKey,
  buildSeabournUpsertCandidate,
  classifyProposedAction,
  buildManifestEntry,
  indexExistingSeabournRecords,
  buildSeabournBatchManifest,
  applySeabournBatchWrites,
  assertSeabournWriteCandidate
};
