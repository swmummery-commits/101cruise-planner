/**
 * Holland America controlled-batch manifest + production writes.
 * Only complete high-confidence cruise products are written as active sailings.
 */

const crypto = require("crypto");
const { officialProductKey, ADAPTER_ID, ADAPTER_VERSION } = require("./holland-america-discovery-adapter");
const { cruiseIdentityKey, upsertCandidateRecord } = require("./cruise-discovery-ops");
const { createHalBatchTiming, mapWithConcurrency } = require("./holland-america-discovery-timing");

function halExternalKey(cruiseLineId, productKey) {
  const basis = [ADAPTER_ID, cruiseLineId || "", productKey || ""].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function buildHalUpsertCandidate(row, cruiseLine) {
  if (!row?.complete_high_confidence || row.product_type !== "cruise") return null;
  const c = row.candidate || {};
  const productKey = officialProductKey(row.raw);
  if (!productKey || !cruiseLine?.id || !c.destination_id) return null;

  const external_key = halExternalKey(cruiseLine.id, productKey);
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
      hal_product_key: productKey,
      hal_itinerary_id: row.raw?.itinerary_id || null,
      hal_cruise_id: row.raw?.cruise_id || null,
      hal_adapter_id: ADAPTER_ID,
      hal_adapter_version: ADAPTER_VERSION,
      hal_batch_write: true,
      destination_key: row.destination_resolution?.destinationKey || null,
      ship_match_method: row.ship_resolution?.method || null
    }
  };
}

function classifyProposedAction(row, existing) {
  if (row.product_type === "cruisetour") return "cruisetour_skip";
  if (row.product_type === "unknown") return "invalid_skip";
  if (!row.complete_high_confidence) return "incomplete_skip";
  if (!existing) return "insert_active";
  const candidate = buildHalUpsertCandidate(row, { id: existing.cruise_line_id });
  if (!candidate) return "invalid_skip";
  const changed =
    existing.ship_id !== candidate.ship_id ||
    existing.destination_id !== candidate.destination_id ||
    existing.departure_date !== candidate.departure_date ||
    existing.return_date !== candidate.return_date ||
    existing.nights !== candidate.nights ||
    String(existing.departure_port || "") !== String(candidate.departure_port || "") ||
    existing.status !== "active";
  return changed ? "update_existing" : "duplicate_skip";
}

function buildManifestEntry(row, cruiseLine, destinations, existing) {
  const productKey = officialProductKey(row.raw);
  const dest = destinations.find((d) => d.slug === row.destination_resolution?.destinationKey);
  const action = classifyProposedAction(row, existing);
  const candidate = buildHalUpsertCandidate(row, cruiseLine);

  const rollback =
    existing && action === "update_existing"
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
    official_hal_itinerary_id: row.raw?.itinerary_id || null,
    official_hal_cruise_id: row.raw?.cruise_id || null,
    stable_product_identity_key: productKey,
    ship: row.ship_resolution?.ship?.name || row.raw?.ship_name || null,
    departure_date: row.candidate?.departure_date || null,
    return_date: row.candidate?.return_date || null,
    nights: row.candidate?.nights || null,
    departure_port: row.candidate?.departure_port || null,
    arrival_port: row.raw?.arrival_port || null,
    itinerary_summary: row.candidate?.itinerary || row.raw?.itinerary_text || null,
    operational_destination: row.destination_resolution?.destinationKey || null,
    destination_id: dest?.id || row.candidate?.destination_id || null,
    product_type: row.product_type,
    confidence: row.confidence?.outcome || row.confidence?.level || null,
    completeness: row.complete_high_confidence ? "complete_high_confidence" : "incomplete",
    proposed_action: action,
    existing_discovered_cruise_id: existing?.id || null,
    evidence_summary: {
      ship_resolution: row.ship_resolution?.method || null,
      destination_confidence: row.destination_resolution?.confidence || null,
      individual_gate: row.individual_gate?.proven ?? null,
      failure_reasons: row.failure_reasons || []
    },
    expected_before: existing
      ? {
          ship_id: existing.ship_id,
          destination_id: existing.destination_id,
          departure_date: existing.departure_date,
          return_date: existing.return_date,
          nights: existing.nights,
          departure_port: existing.departure_port,
          status: existing.status,
          official_url: existing.official_url
        }
      : null,
    rollback: rollback,
    official_url: row.raw?.official_url || row.candidate?.official_url || null,
    candidate
  };
}

function evaluateAcceptanceGate(manifest, { minComplete = 25 } = {}) {
  const failures = [];
  const products = manifest.products || [];
  const writes = products.filter((p) => ["insert_active", "update_existing"].includes(p.proposed_action));

  if (writes.some((p) => p.product_type !== "cruise")) {
    failures.push("non_cruise_proposed_for_write");
  }
  if (writes.some((p) => !p.stable_product_identity_key)) {
    failures.push("missing_official_product_identity");
  }
  if (writes.some((p) => !p.destination_id)) {
    failures.push("missing_destination_id");
  }
  if (writes.some((p) => p.completeness !== "complete_high_confidence")) {
    failures.push("medium_or_incomplete_confidence_in_write_set");
  }
  if (products.some((p) => p.proposed_action === "insert_active" && /fairbanks/i.test(p.departure_port || ""))) {
    failures.push("fairbanks_cruise_embarkation");
  }
  if (products.some((p) => ["insert_active", "update_existing"].includes(p.proposed_action) && p.product_type === "cruisetour")) {
    failures.push("cruisetour_in_write_set");
  }

  const completeCount = products.filter((p) => p.completeness === "complete_high_confidence" && p.product_type === "cruise").length;
  const requiredWrites = Math.min(minComplete, completeCount);
  if (writes.length < requiredWrites) {
    failures.push(`insufficient_writes_proposed:${writes.length}<${requiredWrites}`);
  }

  const insertKeys = new Set();
  for (const p of writes.filter((w) => w.proposed_action === "insert_active")) {
    if (insertKeys.has(p.stable_product_identity_key)) failures.push("duplicate_insert_identity");
    insertKeys.add(p.stable_product_identity_key);
  }

  return {
    passed: failures.length === 0,
    failures,
    complete_high_confidence_count: completeCount,
    proposed_write_count: writes.length,
    insert_count: writes.filter((p) => p.proposed_action === "insert_active").length,
    update_count: writes.filter((p) => p.proposed_action === "update_existing").length
  };
}

async function indexExistingHalRecords(supabase, cruiseLineId) {
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
  for (const row of rows || []) {
    const pk =
      row.official_sailing_id ||
      row.raw_extract?.hal_product_key ||
      row.raw_extract?.hal_itinerary_id && row.raw_extract?.hal_cruise_id
        ? `${row.raw_extract.hal_itinerary_id}|${row.raw_extract.hal_cruise_id}`
        : null;
    if (pk) byProductKey.set(pk, row);
    if (row.identity_key) byIdentity.set(row.identity_key, row);
    if (row.external_key) byExternal.set(row.external_key, row);
  }
  return { rows: rows || [], byProductKey, byIdentity, byExternal };
}

function findExistingRecord(indexes, row, cruiseLine) {
  const productKey = officialProductKey(row.raw);
  const external_key = halExternalKey(cruiseLine.id, productKey);
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

async function buildHalBatchManifest({ products, cruiseLine, destinations, supabase, runId }) {
  const indexes = supabase ? await indexExistingHalRecords(supabase, cruiseLine.id) : { byProductKey: new Map(), byIdentity: new Map(), byExternal: new Map() };
  const entries = products.map((row) => {
    const existing = findExistingRecord(indexes, row, cruiseLine);
    return buildManifestEntry(row, cruiseLine, destinations, existing);
  });

  const manifest = {
    generated_at: new Date().toISOString(),
    mode: "hal_first_production_batch_manifest",
    run_id: runId || null,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    cruise_line_id: cruiseLine.id,
    writes_performed: false,
    products: entries
  };
  manifest.acceptance_gate = evaluateAcceptanceGate(manifest);
  return manifest;
}

async function bulkVerifyWrittenRecords(supabase, writeDetails) {
  const ids = (writeDetails || []).map((d) => d.discovered_cruise_id).filter(Boolean);
  if (!ids.length || !supabase) return { verified: 0, rows: [] };
  const rows = await supabase(
    `discovered_cruises?id=in.(${ids.join(",")})&select=id,status,official_url,source_url,official_sailing_id,raw_extract,departure_date,return_date,nights,departure_port,destination_id,ship_id`
  );
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  let verified = 0;
  for (const detail of writeDetails) {
    const row = byId.get(detail.discovered_cruise_id);
    if (!row) continue;
    const key = row.raw_extract?.hal_product_key || row.official_sailing_id;
    if (row.status === "active" && row.official_url && key === detail.hal_product_key) verified += 1;
  }
  return { verified, rows: rows || [] };
}

async function applyHalBatchWrites({
  products,
  cruiseLine,
  maxWrites = 40,
  runId,
  supabase,
  writeConcurrency = 5,
  timing = null
}) {
  const stats = {
    inserted: 0,
    updated: 0,
    duplicate_skips: 0,
    incomplete_skips: 0,
    cruisetour_skips: 0,
    invalid_skips: 0,
    failed: 0,
    write_details: []
  };
  const upsertStats = {
    new: 0,
    changed: 0,
    unchanged: 0,
    upserted_active: 0,
    cruises_inserted: 0,
    duplicate_candidates_suppressed: 0
  };
  let writesRemaining = maxWrites;
  const localTiming = timing || createHalBatchTiming();

  localTiming.start("supabase_reads");
  const indexes = supabase ? await indexExistingHalRecords(supabase, cruiseLine.id) : null;
  localTiming.end("supabase_reads");

  const writeQueue = [];
  for (const row of products) {
    if (row.product_type === "cruisetour") {
      stats.cruisetour_skips += 1;
      continue;
    }
    if (row.product_type === "unknown") {
      stats.invalid_skips += 1;
      continue;
    }
    if (!row.complete_high_confidence) {
      stats.incomplete_skips += 1;
      continue;
    }
    if (writesRemaining <= 0) break;

    const candidate = buildHalUpsertCandidate(row, cruiseLine);
    if (!candidate) {
      stats.invalid_skips += 1;
      continue;
    }

    const existing = indexes ? findExistingRecord(indexes, row, cruiseLine) : null;
    writeQueue.push({ row, candidate, existing });
    writesRemaining -= 1;
  }

  localTiming.start("supabase_writes");
  await mapWithConcurrency(writeQueue, writeConcurrency, async ({ row, candidate, existing }) => {
    try {
      const result = await upsertCandidateRecord(candidate, upsertStats, { prevRecord: existing });
      const detail = {
        hal_product_key: officialProductKey(row.raw),
        discovered_cruise_id: result.row?.id || null,
        created: result.created,
        duplicate: result.duplicate,
        status: result.status
      };
      stats.write_details.push(detail);

      if (result.created && result.status === "active") {
        stats.inserted += 1;
      } else if (result.duplicate) {
        stats.duplicate_skips += 1;
      } else if (!result.created && result.status === "active") {
        stats.updated += 1;
      } else if (!result.created) {
        stats.updated += 1;
      }
    } catch (err) {
      stats.failed += 1;
      stats.write_details.push({
        hal_product_key: officialProductKey(row.raw),
        error: err.message || String(err)
      });
    }
  });
  localTiming.end("supabase_writes");

  localTiming.start("verification_reads");
  const verification = await bulkVerifyWrittenRecords(supabase, stats.write_details);
  localTiming.end("verification_reads");

  return {
    run_id: runId || null,
    stats,
    upsert_stats: upsertStats,
    verification,
    timing: localTiming.snapshot()
  };
}

module.exports = {
  halExternalKey,
  buildHalUpsertCandidate,
  classifyProposedAction,
  buildManifestEntry,
  evaluateAcceptanceGate,
  buildHalBatchManifest,
  applyHalBatchWrites,
  bulkVerifyWrittenRecords,
  indexExistingHalRecords,
  findExistingRecord
};
