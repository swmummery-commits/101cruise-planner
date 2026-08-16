/**
 * Silversea controlled-batch manifest + production writes (insert-only first batch).
 */

const crypto = require("crypto");
const {
  officialProductKey,
  ADAPTER_ID,
  ADAPTER_VERSION,
  isEligibleSilverseaCruise
} = require("./silversea-discovery-adapter");
const { isFirstBatchEligible } = require("./silversea-controlled-batch");
const { isExpeditionProductionEligible } = require("./silversea-expedition-controlled-batch");
const { EXPEDITION_FIRST_BATCH_MODE } = require("./silversea-expedition-controlled-batch");
const { classifyExpeditionExclusiveBucket } = require("./silversea-expedition-eligibility");
const { EXPEDITION_SEMANTIC } = require("./silversea-expedition-semantics");
const { cruiseIdentityKey, upsertCandidateRecord  } = require("./cruise-discovery-ops");
const { ensureGlobalCruiseWriteLockForMutation } = require("./cruise-discovery-global-write-lock");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");

function silverseaExternalKey(cruiseLineId, productKey) {
  const basis = [ADAPTER_ID, cruiseLineId || "", productKey || ""].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function buildItineraryPorts(normalised) {
  return (normalised.itinerary || [])
    .filter(
      (stop) =>
        stop.kind === "port" &&
        stop.port_resolution?.status === "resolved" &&
        !stop.port_resolution?.expedition_logistics_gateway &&
        (!stop.expedition_semantic || stop.expedition_semantic === EXPEDITION_SEMANTIC.CONVENTIONAL_PORT)
    )
    .map((stop) => stop.port_resolution.canonicalPortName)
    .filter(Boolean);
}

function buildItinerarySummary(normalised) {
  const ports = buildItineraryPorts(normalised);
  if (ports.length) return ports.join(", ");
  const raw = normalised.raw || {};
  return [raw.departure_port, raw.arrival_port].filter(Boolean).join(" to ") || normalised.official_sailing_id;
}

function isLegacyHiddenRow(row) {
  if (!row) return false;
  return !row.official_sailing_id;
}

function buildSilverseaUpsertCandidate(normalised, cruiseLine) {
  if (!isFirstBatchEligible(normalised)) return null;
  if (!isEligibleSilverseaCruise(normalised.product_type)) return null;

  const c = normalised.candidate || {};
  const productKey = officialProductKey(normalised.raw);
  if (!productKey || !cruiseLine?.id || !c.destination_id || !c.ship_id) return null;

  const itinerary_ports = buildItineraryPorts(normalised);
  const itinerary = buildItinerarySummary(normalised);
  const external_key = silverseaExternalKey(cruiseLine.id, productKey);
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
    itinerary,
    itinerary_ports,
    raw_extract: {
      ...(c.raw_extract || {}),
      silversea_cruise_code: productKey,
      silversea_adapter_id: ADAPTER_ID,
      silversea_adapter_version: ADAPTER_VERSION,
      silversea_batch_write: true,
      silversea_controlled_first_batch: true,
      destination_key: normalised.destination_resolution?.destinationKey || null,
      ship_match_method: normalised.ship_resolution?.method || null,
      duration_matches_dates: normalised.raw?.duration_matches_dates === true
    }
  };
}

function classifyProposedAction(normalised, existing, today, existingByOfficialId) {
  if (!isFirstBatchEligible(normalised, today, existingByOfficialId)) {
    return "not_first_batch_eligible";
  }
  if (isLegacyHiddenRow(existing)) existing = null;
  if (!existing) return "insert_active";

  const existingKey = existing.official_sailing_id || existing.raw_extract?.silversea_cruise_code || null;
  const productKey = officialProductKey(normalised.raw);
  if (existingKey && productKey && String(existingKey).toUpperCase() === String(productKey).toUpperCase()) {
    return "duplicate_skip";
  }
  return "insert_active";
}

function buildManifestEntry(normalised, cruiseLine, destinations, existing, today, existingByOfficialId) {
  const productKey = officialProductKey(normalised.raw);
  const dest = destinations.find((d) => d.slug === normalised.destination_resolution?.destinationKey);
  const action = classifyProposedAction(normalised, existing, today, existingByOfficialId);
  const candidate = buildSilverseaUpsertCandidate(normalised, cruiseLine);

  return {
    official_sailing_id: productKey,
    stable_identity_key: productKey,
    product_type: normalised.product_type,
    cruise_type: normalised.raw?.cruise_type || null,
    source_url: normalised.raw?.official_url || normalised.candidate?.official_url || null,
    full_path: normalised.raw?.full_path || null,
    canonical_ship_id: normalised.ship_resolution?.ship?.id || normalised.candidate?.ship_id || null,
    canonical_ship_name: normalised.ship_resolution?.ship?.name || normalised.raw?.ship_name || null,
    departure_date: normalised.candidate?.departure_date || null,
    return_date: normalised.candidate?.return_date || null,
    nights: normalised.candidate?.nights || null,
    official_departure_port: normalised.raw?.departure_port || null,
    canonical_departure_port: normalised.candidate?.departure_port || null,
    official_arrival_port: normalised.raw?.arrival_port || null,
    canonical_arrival_port: normalised.arrival_port_resolution?.canonicalPortName || null,
    destination_id: dest?.id || normalised.candidate?.destination_id || null,
    destination_name: dest?.name || normalised.destination_resolution?.destinationKey || null,
    itinerary_port_call_count: (normalised.itinerary || []).filter((s) => s.kind === "port").length,
    duration_exact_match: normalised.raw?.duration_matches_dates === true,
    completeness: action === "insert_active" ? "classic_production_eligible" : "not_eligible",
    existing_record_match: existing && !isLegacyHiddenRow(existing) ? existing.id : null,
    existing_record_status: existing?.status || null,
    proposed_action: action,
    rollback: action === "insert_active" ? { delete_on_rollback: true } : null,
    official_url: normalised.raw?.official_url || normalised.candidate?.official_url || null,
    candidate
  };
}

async function indexExistingSilverseaRecords(supabase, cruiseLineId) {
  const select =
    "id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,itinerary_ports,status,official_url,source_url,external_key,identity_key,official_sailing_id,raw_extract,review_reason";
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
  const byOfficialId = new Map();
  for (const row of rows) {
    const pk = row.official_sailing_id || row.raw_extract?.silversea_cruise_code || null;
    if (pk) byOfficialId.set(String(pk).toUpperCase(), row);
  }
  return { rows: rows || [], byOfficialId };
}

async function buildSilverseaBatchManifest({
  selectedProducts,
  cruiseLine,
  destinations,
  supabase,
  runId,
  today,
  existingByOfficialId
}) {
  const indexes = supabase
    ? await indexExistingSilverseaRecords(supabase, cruiseLine.id)
    : { byOfficialId: existingByOfficialId || new Map() };

  const entries = (selectedProducts || []).map((normalised) => {
    const existing = indexes.byOfficialId.get(String(normalised.official_sailing_id).toUpperCase()) || null;
    return buildManifestEntry(
      normalised,
      cruiseLine,
      destinations,
      existing,
      today,
      indexes.byOfficialId
    );
  });

  return {
    generated_at: new Date().toISOString(),
    mode: "silversea_first_controlled_batch",
    run_id: runId || null,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    cruise_line_id: cruiseLine.id,
    writes_performed: false,
    selected_official_sailing_ids: entries.map((e) => e.official_sailing_id),
    products: entries
  };
}

async function applySilverseaBatchWritesBody({
  selectedProducts,
  cruiseLine,
  runId,
  supabase,
  today,
  existingByOfficialId,
  performWrites = true,
  maxWrites = 100
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

  const indexes = supabase
    ? await indexExistingSilverseaRecords(supabase, cruiseLine.id)
    : { byOfficialId: existingByOfficialId || new Map() };

  let writesRemaining = maxWrites;
  const upsertStats = { new: 0, upserted_active: 0, cruises_inserted: 0, cruises_updated: 0 };

  for (const normalised of selectedProducts || []) {
    if (writesRemaining <= 0) break;

    const productKey = officialProductKey(normalised.raw);
    const existing =
      indexes.byOfficialId.get(String(productKey).toUpperCase()) ||
      null;
    const action = classifyProposedAction(normalised, existing, today, indexes.byOfficialId);

    if (action === "duplicate_skip") {
      stats.duplicate_skips += 1;
      stats.write_details.push({
        official_sailing_id: productKey,
        proposed_action: action,
        duplicate: true
      });
      continue;
    }
    if (action !== "insert_active") {
      stats.invalid_skips += 1;
      continue;
    }

    const candidate = buildSilverseaUpsertCandidate(normalised, cruiseLine);
    if (!candidate) {
      stats.invalid_skips += 1;
      continue;
    }

    stats.attempted += 1;
    if (!performWrites) continue;

    try {
      const freshExisting =
        (
          await supabase(
            `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
              cruiseLine.id
            )}&official_sailing_id=eq.${encodeURIComponent(productKey)}&select=id,official_sailing_id,status&limit=1`
          )
        )?.[0] || null;

      if (freshExisting?.official_sailing_id) {
        stats.duplicate_skips += 1;
        stats.write_details.push({
          official_sailing_id: productKey,
          proposed_action: "duplicate_skip",
          duplicate: true,
          discovered_cruise_id: freshExisting.id
        });
        continue;
      }

      const result = await upsertCandidateRecord(candidate, upsertStats, {
        matchPolicy: "official_sailing_id_only",
        syncDestinationLinks: false,
        prevRecord: null
      });

      writesRemaining -= 1;
      if (result.created) stats.inserted += 1;
      else stats.updated += 1;

      stats.write_details.push({
        discovered_cruise_id: result.row?.id || null,
        official_sailing_id: productKey,
        proposed_action: action,
        result_action: result.created ? "inserted" : "updated",
        created: result.created === true,
        rollback_before: null
      });
    } catch (error) {
      stats.failed += 1;
      stats.write_details.push({
        official_sailing_id: productKey,
        proposed_action: action,
        error: error.message || String(error)
      });
    }
  }

  return { stats, upsertStats, performWrites: performWrites === true, run_id: runId || null };
}

async function applySilverseaBatchWrites(params = {}) {
  if (params.performWrites === false) return applySilverseaBatchWritesBody(params);
  return ensureGlobalCruiseWriteLockForMutation(params.supabase, {
    ownerId: params.runId,
    runId: params.runId,
    lineSlug: "silversea-cruises",
    operation: params.mode || params.operation || "silversea_batch_apply"
  }, () => applySilverseaBatchWritesBody(params));
}

function buildExpeditionUpsertCandidate(normalised, cruiseLine, today = new Date().toISOString().slice(0, 10)) {
  if (classifyExpeditionExclusiveBucket(normalised, today) !== "expedition_e2_complete") return null;
  if (!isEligibleSilverseaCruise(normalised.product_type)) return null;

  const c = normalised.candidate || {};
  const productKey = officialProductKey(normalised.raw);
  if (!productKey || !cruiseLine?.id || !c.destination_id || !c.ship_id) return null;

  const itinerary_ports = buildItineraryPorts(normalised);
  const itinerary = buildItinerarySummary(normalised);
  const external_key = silverseaExternalKey(cruiseLine.id, productKey);
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
    itinerary,
    itinerary_ports,
    raw_extract: {
      ...(c.raw_extract || {}),
      silversea_cruise_code: productKey,
      silversea_adapter_id: ADAPTER_ID,
      silversea_adapter_version: ADAPTER_VERSION,
      silversea_batch_write: true,
      silversea_expedition_controlled_batch: true,
      silversea_cruise_type: "Expedition",
      destination_key: normalised.destination_resolution?.destinationKey || null,
      ship_match_method: normalised.ship_resolution?.method || null,
      duration_matches_dates: normalised.raw?.duration_matches_dates === true,
      expedition_endpoint_embark: normalised.departure_port_resolution || null,
      expedition_endpoint_disembark: normalised.arrival_port_resolution || null
    }
  };
}

function classifyExpeditionProposedAction(normalised, existing, today, existingByOfficialId) {
  if (!isExpeditionProductionEligible(normalised, today, existingByOfficialId)) {
    return "not_expedition_batch_eligible";
  }
  if (isLegacyHiddenRow(existing)) existing = null;
  if (!existing) return "insert_active";
  return "duplicate_skip";
}

function buildExpeditionManifestEntry(normalised, cruiseLine, destinations, existing, today, existingByOfficialId) {
  const productKey = officialProductKey(normalised.raw);
  const dest = destinations.find((d) => d.slug === normalised.destination_resolution?.destinationKey);
  const action = classifyExpeditionProposedAction(normalised, existing, today, existingByOfficialId);
  const candidate = buildExpeditionUpsertCandidate(normalised, cruiseLine, today);

  return {
    official_sailing_id: productKey,
    stable_identity_key: productKey,
    product_type: normalised.product_type,
    cruise_type: normalised.raw?.cruise_type || "Expedition",
    source_url: normalised.raw?.official_url || normalised.candidate?.official_url || null,
    full_path: normalised.raw?.full_path || null,
    canonical_ship_id: normalised.ship_resolution?.ship?.id || normalised.candidate?.ship_id || null,
    canonical_ship_name: normalised.ship_resolution?.ship?.name || normalised.raw?.ship_name || null,
    departure_date: normalised.candidate?.departure_date || null,
    return_date: normalised.candidate?.return_date || null,
    nights: normalised.candidate?.nights || null,
    official_departure_port: normalised.raw?.departure_port || null,
    canonical_departure_port: normalised.candidate?.departure_port || null,
    official_arrival_port: normalised.raw?.arrival_port || null,
    canonical_arrival_port: normalised.arrival_port_resolution?.canonicalPortName || null,
    destination_id: dest?.id || normalised.candidate?.destination_id || null,
    destination_name: dest?.name || normalised.destination_resolution?.destinationKey || null,
    itinerary_port_call_count: buildItineraryPorts(normalised).length,
    duration_exact_match: normalised.raw?.duration_matches_dates === true,
    completeness: action === "insert_active" ? "expedition_production_eligible" : "not_eligible",
    existing_record_match: existing && !isLegacyHiddenRow(existing) ? existing.id : null,
    existing_record_status: existing?.status || null,
    proposed_action: action,
    rollback: action === "insert_active" ? { delete_on_rollback: true } : null,
    official_url: normalised.raw?.official_url || normalised.candidate?.official_url || null,
    candidate
  };
}

async function buildExpeditionBatchManifest({
  selectedProducts,
  cruiseLine,
  destinations,
  supabase,
  runId,
  today,
  existingByOfficialId
}) {
  const indexes = supabase
    ? await indexExistingSilverseaRecords(supabase, cruiseLine.id)
    : { byOfficialId: existingByOfficialId || new Map() };

  const entries = (selectedProducts || []).map((normalised) => {
    const existing = indexes.byOfficialId.get(String(normalised.official_sailing_id).toUpperCase()) || null;
    return buildExpeditionManifestEntry(
      normalised,
      cruiseLine,
      destinations,
      existing,
      today,
      indexes.byOfficialId
    );
  });

  return {
    generated_at: new Date().toISOString(),
    mode: EXPEDITION_FIRST_BATCH_MODE,
    run_id: runId || null,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    cruise_line_id: cruiseLine.id,
    writes_performed: false,
    selected_official_sailing_ids: entries.map((e) => e.official_sailing_id),
    products: entries
  };
}

function dryRunExpeditionBatchManifest(manifest) {
  const products = manifest?.products || [];
  return {
    authorised: products.filter((p) => p.proposed_action === "insert_active").length,
    eligible: products.filter((p) => p.candidate).length,
    proposed_inserts: products.filter((p) => p.proposed_action === "insert_active").length,
    proposed_updates: products.filter((p) => p.proposed_action === "update_existing").length,
    proposed_deletes: 0,
    dedupe_new: products.filter((p) => p.proposed_action === "insert_active" && !p.existing_record_match).length,
    classic_proposed_updates: 0,
    legacy_proposed_updates: 0
  };
}

module.exports = {
  silverseaExternalKey,
  buildItineraryPorts,
  buildSilverseaUpsertCandidate,
  classifyProposedAction,
  buildManifestEntry,
  indexExistingSilverseaRecords,
  buildSilverseaBatchManifest,
  applySilverseaBatchWrites,
  isLegacyHiddenRow,
  buildExpeditionUpsertCandidate,
  buildExpeditionManifestEntry,
  buildExpeditionBatchManifest,
  dryRunExpeditionBatchManifest
};
