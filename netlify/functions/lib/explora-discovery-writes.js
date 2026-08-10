/**
 * Explora Journeys controlled-batch manifest + production writes.
 */

const crypto = require("crypto");
const {
  officialProductKey,
  ADAPTER_ID,
  ADAPTER_VERSION,
  isEligibleExploraCruise,
  isExploraNonCruise
} = require("./explora-discovery-adapter");
const { journeyIdFromUrl } = require("./explora-discovery-source");
const { cruiseIdentityKey, upsertCandidateRecord } = require("./cruise-discovery-ops");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");

/**
 * Identity of a stored row. Legacy Explora rows predate official_sailing_id, so the journey id is
 * recovered from the stored official URL to keep them matchable instead of duplicated.
 */
function existingRecordKey(row) {
  const stored = row?.official_sailing_id || row?.raw_extract?.explora_sailing_id || null;
  const key = stored || journeyIdFromUrl(row?.official_url) || null;
  return key ? String(key).trim().toUpperCase() : null;
}

function exploraExternalKey(cruiseLineId, productKey) {
  const basis = [ADAPTER_ID, cruiseLineId || "", productKey || ""].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function buildExploraUpsertCandidate(row, cruiseLine) {
  if (!row?.complete_high_confidence || !isEligibleExploraCruise(row.product_type)) return null;
  const c = row.candidate || {};
  const productKey = officialProductKey(row.raw);
  if (!productKey || !cruiseLine?.id || !c.destination_id) return null;

  const external_key = exploraExternalKey(cruiseLine.id, productKey);
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
      explora_sailing_id: productKey,
      explora_journey_id: productKey,
      explora_product_type: row.product_type,
      explora_adapter_id: ADAPTER_ID,
      explora_adapter_version: ADAPTER_VERSION,
      explora_batch_write: true,
      destination_key: row.destination_resolution?.destinationKey || null,
      ship_match_method: row.ship_resolution?.method || null
    }
  };
}

function classifyProposedAction(row, existing) {
  if (isExploraNonCruise(row.product_type)) return "non_cruise_skip";
  if (row.product_type === "unknown") return "invalid_skip";
  if (!row.complete_high_confidence) return "incomplete_skip";
  if (!existing) return "insert_active";

  const existingKey = existingRecordKey(existing);
  const productKey = officialProductKey(row.raw);

  if (existingKey && productKey && existingKey === productKey) {
    const candidate = buildExploraUpsertCandidate(row, { id: existing.cruise_line_id });
    if (!candidate) return "invalid_skip";
    const changed =
      existing.ship_id !== candidate.ship_id ||
      existing.destination_id !== candidate.destination_id ||
      existing.departure_date !== candidate.departure_date ||
      existing.return_date !== candidate.return_date ||
      existing.nights !== candidate.nights ||
      String(existing.departure_port || "") !== String(candidate.departure_port || "") ||
      String(existing.itinerary || "") !== String(candidate.itinerary || "") ||
      String(existing.official_url || "") !== String(candidate.official_url || "") ||
      existing.status !== "active";
    return changed ? "update_exact_legacy_match" : "duplicate_skip";
  }

  return "insert_active";
}

function buildManifestEntry(row, cruiseLine, destinations, existing) {
  const productKey = officialProductKey(row.raw);
  const dest = destinations.find((d) => d.slug === row.destination_resolution?.destinationKey);
  const action = classifyProposedAction(row, existing);
  const candidate = buildExploraUpsertCandidate(row, cruiseLine);

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
    official_explora_journey_id: productKey,
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
    completeness: row.complete_high_confidence ? "complete_high_confidence" : "incomplete",
    existing_record_match: existing?.id || null,
    existing_record_status: existing?.status || null,
    proposed_action: action,
    rollback,
    official_url: row.raw?.official_url || row.candidate?.official_url || null,
    candidate
  };
}

async function indexExistingExploraRecords(supabase, cruiseLineId) {
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
    const pk = existingRecordKey(row);
    if (!pk) continue;
    const current = byProductKey.get(pk);
    // Prefer a row that already carries the official identity over a legacy URL-only match.
    if (!current || (!current.official_sailing_id && row.official_sailing_id)) byProductKey.set(pk, row);
  }
  return { rows: rows || [], byProductKey };
}

function findExistingRecord(indexes, row) {
  const productKey = officialProductKey(row.raw);
  if (!productKey) return null;
  return indexes.byProductKey.get(productKey) || null;
}

async function buildExploraBatchManifest({ products, cruiseLine, destinations, supabase, runId }) {
  const indexes = supabase
    ? await indexExistingExploraRecords(supabase, cruiseLine.id)
    : { byProductKey: new Map() };

  const entries = (products || []).map((row) => {
    const existing = findExistingRecord(indexes, row);
    return buildManifestEntry(row, cruiseLine, destinations || [], existing);
  });

  return {
    generated_at: new Date().toISOString(),
    mode: "explora_batch_manifest",
    run_id: runId || null,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    cruise_line_id: cruiseLine.id,
    writes_performed: false,
    products: entries
  };
}

function assertExploraWriteCandidate(candidate, cruiseLine) {
  if (!candidate) {
    const err = new Error("explora_write_candidate_missing");
    err.code = "explora_write_candidate_missing";
    throw err;
  }
  if (!candidate.cruise_line_id) {
    const err = new Error("explora_write_candidate_missing_cruise_line_id");
    err.code = "explora_write_candidate_missing_cruise_line_id";
    throw err;
  }
  if (cruiseLine?.id && candidate.cruise_line_id !== cruiseLine.id) {
    const err = new Error("explora_write_candidate_cruise_line_mismatch");
    err.code = "explora_write_candidate_cruise_line_mismatch";
    throw err;
  }
  if (!candidate.ship_id) {
    const err = new Error("explora_write_candidate_missing_ship_id");
    err.code = "explora_write_candidate_missing_ship_id";
    throw err;
  }
  return candidate;
}

function isAmbiguousTransportError(message) {
  const msg = String(message || "");
  return /fetch failed|network error|ECONNRESET|ETIMEDOUT|socket hang up|UND_ERR/i.test(msg);
}

async function recoverCommittedWriteAfterFetchFailure(supabase, cruiseLineId, officialSailingId, expected = {}) {
  if (!supabase || !cruiseLineId || !officialSailingId) return null;
  const rows = await supabase(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
      cruiseLineId
    )}&official_sailing_id=eq.${encodeURIComponent(
      officialSailingId
    )}&select=id,status,official_sailing_id,cruise_line_id,ship_id,departure_date&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.id || row.status !== "active") return null;
  if (row.cruise_line_id !== cruiseLineId) return null;
  if (row.official_sailing_id !== officialSailingId) return null;
  if (expected.ship_id && row.ship_id !== expected.ship_id) return null;
  if (
    expected.departure_date &&
    String(row.departure_date).slice(0, 10) !== String(expected.departure_date).slice(0, 10)
  ) {
    return null;
  }
  return row;
}

async function applyExploraBatchWrites({
  products,
  cruiseLine,
  maxWrites = 100,
  runId,
  supabase,
  performWrites = true
}) {
  const stats = {
    inserted: 0,
    updated: 0,
    duplicate_skips: 0,
    incomplete_skips: 0,
    non_cruise_skips: 0,
    invalid_skips: 0,
    failed: 0,
    recovered_after_fetch_failure: 0,
    write_details: []
  };

  let writesRemaining = maxWrites;
  const indexes = supabase ? await indexExistingExploraRecords(supabase, cruiseLine.id) : null;
  const upsertStats = { new: 0, upserted_active: 0, cruises_inserted: 0, cruises_updated: 0 };

  for (const row of products || []) {
    if (isExploraNonCruise(row.product_type)) {
      stats.non_cruise_skips += 1;
      continue;
    }
    if (!row.complete_high_confidence) {
      stats.incomplete_skips += 1;
      continue;
    }

    const existing = indexes ? findExistingRecord(indexes, row) : null;
    const action = classifyProposedAction(row, existing);
    if (action === "duplicate_skip") {
      stats.duplicate_skips += 1;
      continue;
    }
    if (action === "incomplete_skip" || action === "invalid_skip" || action === "non_cruise_skip") {
      stats.invalid_skips += 1;
      continue;
    }
    if (writesRemaining <= 0) break;

    const built = buildExploraUpsertCandidate(row, cruiseLine);
    if (!built) {
      stats.invalid_skips += 1;
      continue;
    }

    let candidate;
    try {
      candidate = assertExploraWriteCandidate(built, cruiseLine);
    } catch (validationError) {
      stats.failed += 1;
      stats.write_details.push({
        explora_sailing_id: built.official_sailing_id || officialProductKey(row.raw),
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

      // official_sailing_id_only clears prev when the legacy row has a null sailing id, so an
      // intended legacy update can insert a canonical row beside the orphan. Retire the orphan.
      let legacySuperseded = false;
      if (
        action === "update_exact_legacy_match" &&
        result.created &&
        existing?.id &&
        result.row?.id &&
        existing.id !== result.row.id &&
        supabase
      ) {
        await supabase(`discovered_cruises?id=eq.${encodeURIComponent(existing.id)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            status: "ignored",
            review_reason: "explora_legacy_superseded_by_official_sailing_record",
            raw_extract: {
              ...(existing.raw_extract || {}),
              explora_legacy_remediation: {
                at: new Date().toISOString(),
                reason: "update_exact_legacy_match_inserted_under_official_sailing_id_only",
                superseded_by_discovered_cruise_id: result.row.id,
                official_sailing_id: candidate.official_sailing_id,
                run_id: runId || null
              }
            }
          })
        });
        legacySuperseded = true;
      }

      if (result.created && !legacySuperseded) stats.inserted += 1;
      else stats.updated += 1;
      stats.write_details.push({
        discovered_cruise_id: result.row?.id || null,
        explora_sailing_id: candidate.official_sailing_id,
        official_sailing_id: candidate.official_sailing_id,
        proposed_action: action,
        result_action: legacySuperseded ? "updated_via_insert_and_legacy_retire" : result.created ? "inserted" : "updated",
        created: result.created === true && !legacySuperseded,
        legacy_superseded_id: legacySuperseded ? existing.id : null,
        rollback_before: before
      });
    } catch (error) {
      const msg = error.message || String(error);
      const recovered =
        isAmbiguousTransportError(msg) && supabase
          ? await recoverCommittedWriteAfterFetchFailure(supabase, cruiseLine.id, candidate.official_sailing_id, {
              ship_id: candidate.ship_id,
              departure_date: candidate.departure_date
            })
          : null;
      if (recovered) {
        writesRemaining -= 1;
        stats.inserted += 1;
        stats.recovered_after_fetch_failure += 1;
        stats.write_details.push({
          discovered_cruise_id: recovered.id,
          explora_sailing_id: candidate.official_sailing_id,
          official_sailing_id: candidate.official_sailing_id,
          proposed_action: action,
          result_action: "inserted",
          created: true,
          recovered_after_fetch_failure: true,
          transport_error: msg,
          rollback_before: existing ? snapshotRecordForRollback(existing) : null
        });
        continue;
      }
      stats.failed += 1;
      stats.write_details.push({
        explora_sailing_id: candidate.official_sailing_id,
        proposed_action: action,
        error: msg
      });
    }
  }

  return { stats, run_id: runId };
}

module.exports = {
  existingRecordKey,
  exploraExternalKey,
  buildExploraUpsertCandidate,
  buildExploraBatchManifest,
  applyExploraBatchWrites,
  indexExistingExploraRecords,
  findExistingRecord,
  classifyProposedAction,
  assertExploraWriteCandidate,
  recoverCommittedWriteAfterFetchFailure,
  isAmbiguousTransportError
};
