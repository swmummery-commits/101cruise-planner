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

async function applyRoyalCaribbeanBatchWrites(options = {}) {
  const modeGate = resolveRoyalCaribbeanDiscoveryMode(options.mode || "simulation");
  assertRoyalCaribbeanWritesAllowed(modeGate);
  const err = new Error("Royal Caribbean production writes are disabled");
  err.code = "royal_caribbean_writes_disabled";
  throw err;
}

module.exports = {
  royalCaribbeanExternalKey,
  isLegacyHtmlDiscoveryRow,
  buildRoyalCaribbeanUpsertCandidate,
  classifyProposedAction,
  indexExistingRoyalCaribbeanRecords,
  buildRoyalCaribbeanBatchManifest,
  applyRoyalCaribbeanBatchWrites
};
