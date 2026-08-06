/**
 * Celebrity Cruises controlled-batch manifest + production writes.
 * Only complete high-confidence ocean and river cruise products are written as active sailings.
 */

const crypto = require("crypto");
const {
  officialProductKey,
  officialGroupKey,
  ADAPTER_ID,
  ADAPTER_VERSION,
  isEligibleCelebrityCruise,
  isCelebrityCruisetour
} = require("./celebrity-discovery-adapter");
const { cruiseIdentityKey, upsertCandidateRecord } = require("./cruise-discovery-ops");
const { createCelebrityBatchTiming, mapWithConcurrency } = require("./celebrity-discovery-timing");

const RIVER_SHIP_CODES = new Set(["RC", "RS", "RB", "RR", "RW"]);
const HOTEL_ORIGIN_PATTERN = /hotel/i;

function celebrityExternalKey(cruiseLineId, productKey) {
  const basis = [ADAPTER_ID, cruiseLineId || "", productKey || ""].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function buildCelebrityUpsertCandidate(row, cruiseLine) {
  if (!row?.complete_high_confidence || !isEligibleCelebrityCruise(row.product_type)) return null;
  const c = row.candidate || {};
  const productKey = officialProductKey(row.raw);
  if (!productKey || !cruiseLine?.id || !c.destination_id) return null;
  if (HOTEL_ORIGIN_PATTERN.test(String(row.raw?.departure_port || ""))) return null;

  const external_key = celebrityExternalKey(cruiseLine.id, productKey);
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
      celebrity_sailing_id: productKey,
      celebrity_group_id: officialGroupKey(row.raw),
      celebrity_product_type: row.product_type,
      celebrity_adapter_id: ADAPTER_ID,
      celebrity_adapter_version: ADAPTER_VERSION,
      celebrity_batch_write: true,
      destination_key: row.destination_resolution?.destinationKey || null,
      ship_match_method: row.ship_resolution?.method || null,
      river_name: c.raw_extract?.river_name || null,
      river_region: c.raw_extract?.river_region || null
    }
  };
}

function classifyProposedAction(row, existing) {
  if (row.product_type === "ocean_cruisetour") return "ocean_cruisetour_skip";
  if (row.product_type === "river_cruisetour") return "river_cruisetour_skip";
  if (row.product_type === "unknown" || row.product_type === "malformed_or_unknown") return "invalid_skip";
  if (!row.complete_high_confidence) return "incomplete_skip";
  if (HOTEL_ORIGIN_PATTERN.test(String(row.raw?.departure_port || ""))) return "invalid_skip";
  if (!existing) return "insert_active";

  const existingKey =
    existing.official_sailing_id ||
    existing.raw_extract?.celebrity_sailing_id ||
    null;
  const productKey = officialProductKey(row.raw);

  if (existingKey && productKey && existingKey === productKey) {
    const candidate = buildCelebrityUpsertCandidate(row, { id: existing.cruise_line_id });
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

  if (existing.status === "active") {
    const candidate = buildCelebrityUpsertCandidate(row, { id: existing.cruise_line_id });
    if (!candidate) return "invalid_skip";
    const changed =
      existing.ship_id !== candidate.ship_id ||
      existing.destination_id !== candidate.destination_id ||
      existing.departure_date !== candidate.departure_date ||
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
  const candidate = buildCelebrityUpsertCandidate(row, cruiseLine);

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
    official_celebrity_sailing_id: productKey,
    official_celebrity_group_id: groupKey,
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
    arrival_port: row.raw?.arrival_port || null,
    destination_id: dest?.id || row.candidate?.destination_id || null,
    destination_name: dest?.name || row.destination_resolution?.destinationKey || null,
    river_name: row.candidate?.raw_extract?.river_name || null,
    pre_tour_duration: row.raw?.pre_tour_duration ?? null,
    post_tour_duration: row.raw?.post_tour_duration ?? null,
    confidence: row.adapter_confidence || null,
    completeness: row.complete_high_confidence ? "complete_high_confidence" : "incomplete",
    existing_record_match: existing?.id || null,
    existing_record_status: existing?.status || null,
    proposed_action: action,
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
    rollback,
    official_url: row.raw?.official_url || row.candidate?.official_url || null,
    candidate
  };
}

function evaluateAcceptanceGate(manifest, { minOcean = 1, minRiver = 1, maxWrites = 40 } = {}) {
  const failures = [];
  const products = manifest.products || [];
  const writes = products.filter((p) => ["insert_active", "update_exact_legacy_match"].includes(p.proposed_action));

  if (writes.some((p) => !isEligibleCelebrityCruise(p.product_type))) {
    failures.push("non_eligible_cruise_proposed_for_write");
  }
  if (writes.some((p) => !p.stable_identity_key)) {
    failures.push("missing_official_product_identity");
  }
  if (writes.some((p) => !p.destination_id)) {
    failures.push("missing_destination_id");
  }
  if (writes.some((p) => p.completeness !== "complete_high_confidence")) {
    failures.push("medium_or_incomplete_confidence_in_write_set");
  }
  if (writes.some((p) => HOTEL_ORIGIN_PATTERN.test(String(p.official_departure_port || "")))) {
    failures.push("hotel_origin_in_write_set");
  }
  if (
    products.some((p) =>
      ["insert_active", "update_exact_legacy_match"].includes(p.proposed_action) &&
      isCelebrityCruisetour(p.product_type)
    )
  ) {
    failures.push("cruisetour_in_write_set");
  }
  if (writes.length > maxWrites) {
    failures.push(`write_count_exceeds_max:${writes.length}>${maxWrites}`);
  }

  const oceanWrites = writes.filter((p) => p.product_type === "ocean_cruise");
  const riverWrites = writes.filter((p) => p.product_type === "river_cruise");
  if (manifest.controlled_batch) {
    if (oceanWrites.length < minOcean) failures.push(`insufficient_ocean_writes:${oceanWrites.length}<${minOcean}`);
    if (riverWrites.length < minRiver) failures.push(`insufficient_river_writes:${riverWrites.length}<${minRiver}`);
  }

  const insertKeys = new Set();
  for (const p of writes.filter((w) => w.proposed_action === "insert_active")) {
    if (insertKeys.has(p.stable_identity_key)) failures.push("duplicate_insert_identity");
    insertKeys.add(p.stable_identity_key);
  }

  return {
    passed: failures.length === 0,
    failures,
    proposed_write_count: writes.length,
    ocean_write_count: oceanWrites.length,
    river_write_count: riverWrites.length,
    insert_count: writes.filter((p) => p.proposed_action === "insert_active").length,
    update_count: writes.filter((p) => p.proposed_action === "update_exact_legacy_match").length
  };
}

function selectControlledBatchProducts(normalisedProducts, { oceanTarget = 20, riverTarget = 20, maxWrites = 40 } = {}) {
  const eligibleOcean = normalisedProducts.filter(
    (p) => p.complete_high_confidence && p.product_type === "ocean_cruise"
  );
  const eligibleRiver = normalisedProducts.filter(
    (p) => p.complete_high_confidence && p.product_type === "river_cruise"
  );

  const selected = [];
  const selectedIds = new Set();

  function pick(list, limit) {
    const destSeen = new Set();
    const shipSeen = new Set();
    const portSeen = new Set();
    const ordered = [];

    for (const p of list) {
      const dest = p.destination_resolution?.destinationKey || "unknown";
      const ship = p.raw?.ship_name || "unknown";
      const port = p.candidate?.departure_port || p.raw?.departure_port || "unknown";
      const score =
        (destSeen.has(dest) ? 0 : 4) + (shipSeen.has(ship) ? 0 : 2) + (portSeen.has(port) ? 0 : 1);
      ordered.push({ p, score });
    }
    ordered.sort((a, b) => b.score - a.score || String(a.p.official_product_key).localeCompare(b.p.official_product_key));

    for (const { p } of ordered) {
      if (selected.length >= maxWrites) break;
      if (selectedIds.has(p.official_product_key)) continue;
      selected.push(p);
      selectedIds.add(p.official_product_key);
      destSeen.add(p.destination_resolution?.destinationKey || "unknown");
      shipSeen.add(p.raw?.ship_name || "unknown");
      portSeen.add(p.candidate?.departure_port || p.raw?.departure_port || "unknown");
      if (selected.filter((s) => s.product_type === p.product_type).length >= limit) break;
    }
  }

  const riverByShip = new Map();
  for (const code of RIVER_SHIP_CODES) {
    riverByShip.set(code, eligibleRiver.filter((p) => String(p.raw?.ship_code || "").toUpperCase() === code));
  }
  for (const [code, list] of riverByShip) {
    if (selected.filter((s) => s.product_type === "river_cruise").length >= riverTarget) break;
    for (const p of list) {
      if (selected.filter((s) => s.product_type === "river_cruise").length >= riverTarget) break;
      if (selectedIds.has(p.official_product_key)) continue;
      selected.push(p);
      selectedIds.add(p.official_product_key);
    }
  }
  if (selected.filter((s) => s.product_type === "river_cruise").length < riverTarget) {
    pick(
      eligibleRiver.filter((p) => !selectedIds.has(p.official_product_key)),
      riverTarget - selected.filter((s) => s.product_type === "river_cruise").length
    );
  }

  pick(
    eligibleOcean.filter((p) => !selectedIds.has(p.official_product_key)),
    oceanTarget - selected.filter((s) => s.product_type === "ocean_cruise").length
  );

  return selected.slice(0, maxWrites);
}

async function indexExistingCelebrityRecords(supabase, cruiseLineId) {
  const rows = await supabase(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,status,official_url,external_key,identity_key,official_sailing_id,raw_extract`
  );
  const byProductKey = new Map();
  const byIdentity = new Map();
  const byExternal = new Map();
  for (const row of rows || []) {
    const pk =
      row.official_sailing_id ||
      row.raw_extract?.celebrity_sailing_id ||
      null;
    if (pk) byProductKey.set(pk, row);
    if (row.identity_key) byIdentity.set(row.identity_key, row);
    if (row.external_key) byExternal.set(row.external_key, row);
  }
  return { rows: rows || [], byProductKey, byIdentity, byExternal };
}

function findExistingRecord(indexes, row, cruiseLine) {
  const productKey = officialProductKey(row.raw);
  const external_key = celebrityExternalKey(cruiseLine.id, productKey);
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

async function buildCelebrityBatchManifest({
  products,
  cruiseLine,
  destinations,
  supabase,
  runId,
  controlledBatch = false,
  controlledSelection = null
}) {
  const indexes = supabase
    ? await indexExistingCelebrityRecords(supabase, cruiseLine.id)
    : { byProductKey: new Map(), byIdentity: new Map(), byExternal: new Map() };

  const sourceProducts = controlledSelection || products;
  const entries = sourceProducts.map((row) => {
    const existing = findExistingRecord(indexes, row, cruiseLine);
    return buildManifestEntry(row, cruiseLine, destinations, existing);
  });

  const manifest = {
    generated_at: new Date().toISOString(),
    mode: controlledBatch ? "celebrity_first_production_batch_manifest" : "celebrity_batch_manifest",
    run_id: runId || null,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    cruise_line_id: cruiseLine.id,
    controlled_batch: Boolean(controlledBatch),
    writes_performed: false,
    products: entries
  };
  manifest.acceptance_gate = evaluateAcceptanceGate(manifest, {
    minOcean: controlledBatch ? 1 : 0,
    minRiver: controlledBatch ? 1 : 0,
    maxWrites: controlledBatch ? 40 : 500
  });
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
    const key = row.raw_extract?.celebrity_sailing_id || row.official_sailing_id;
    const productType = row.raw_extract?.celebrity_product_type;
    if (
      row.status === "active" &&
      row.official_url &&
      key === detail.celebrity_sailing_id &&
      isEligibleCelebrityCruise(productType)
    ) {
      verified += 1;
    }
  }
  return { verified, rows: rows || [] };
}

async function applyCelebrityBatchWrites({
  products,
  cruiseLine,
  maxWrites = 40,
  runId,
  supabase,
  writeConcurrency = 5,
  timing = null,
  controlledSelection = null
}) {
  const stats = {
    inserted: 0,
    updated: 0,
    duplicate_skips: 0,
    incomplete_skips: 0,
    ocean_cruisetour_skips: 0,
    river_cruisetour_skips: 0,
    invalid_skips: 0,
    failed: 0,
    ocean_inserts: 0,
    river_inserts: 0,
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
  const localTiming = timing || createCelebrityBatchTiming();
  const sourceProducts = controlledSelection || products;

  localTiming.start("supabase_reads");
  const indexes = supabase ? await indexExistingCelebrityRecords(supabase, cruiseLine.id) : null;
  localTiming.end("supabase_reads");

  const writeQueue = [];
  for (const row of sourceProducts) {
    if (row.product_type === "ocean_cruisetour") {
      stats.ocean_cruisetour_skips += 1;
      continue;
    }
    if (row.product_type === "river_cruisetour") {
      stats.river_cruisetour_skips += 1;
      continue;
    }
    if (row.product_type === "unknown" || row.product_type === "malformed_or_unknown") {
      stats.invalid_skips += 1;
      continue;
    }
    if (!row.complete_high_confidence) {
      stats.incomplete_skips += 1;
      continue;
    }
    if (writesRemaining <= 0) break;

    const candidate = buildCelebrityUpsertCandidate(row, cruiseLine);
    if (!candidate) {
      stats.invalid_skips += 1;
      continue;
    }

    const existing = indexes ? findExistingRecord(indexes, row, cruiseLine) : null;
    const action = classifyProposedAction(row, existing);
    if (action === "duplicate_skip") {
      stats.duplicate_skips += 1;
      continue;
    }
    if (["ocean_cruisetour_skip", "river_cruisetour_skip", "incomplete_skip", "invalid_skip"].includes(action)) {
      if (action === "ocean_cruisetour_skip") stats.ocean_cruisetour_skips += 1;
      else if (action === "river_cruisetour_skip") stats.river_cruisetour_skips += 1;
      else if (action === "incomplete_skip") stats.incomplete_skips += 1;
      else stats.invalid_skips += 1;
      continue;
    }

    writeQueue.push({ row, candidate, existing, action });
    writesRemaining -= 1;
  }

  localTiming.start("supabase_writes");
  await mapWithConcurrency(writeQueue, writeConcurrency, async ({ row, candidate, existing, action }) => {
    try {
      const result = await upsertCandidateRecord(candidate, upsertStats, { prevRecord: existing });
      const detail = {
        celebrity_sailing_id: officialProductKey(row.raw),
        celebrity_group_id: officialGroupKey(row.raw),
        product_type: row.product_type,
        discovered_cruise_id: result.row?.id || null,
        created: result.created,
        duplicate: result.duplicate,
        status: result.status,
        action
      };
      stats.write_details.push(detail);

      if (result.created && result.status === "active") {
        stats.inserted += 1;
        if (row.product_type === "ocean_cruise") stats.ocean_inserts += 1;
        if (row.product_type === "river_cruise") stats.river_inserts += 1;
        if (indexes && result.row?.id) {
          const pk = officialProductKey(row.raw);
          if (pk) indexes.byProductKey.set(pk, result.row);
          if (result.row.identity_key) indexes.byIdentity.set(result.row.identity_key, result.row);
          if (result.row.external_key) indexes.byExternal.set(result.row.external_key, result.row);
        }
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
        celebrity_sailing_id: officialProductKey(row.raw),
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
  celebrityExternalKey,
  buildCelebrityUpsertCandidate,
  classifyProposedAction,
  buildManifestEntry,
  evaluateAcceptanceGate,
  selectControlledBatchProducts,
  buildCelebrityBatchManifest,
  applyCelebrityBatchWrites,
  bulkVerifyWrittenRecords,
  indexExistingCelebrityRecords,
  findExistingRecord
};
