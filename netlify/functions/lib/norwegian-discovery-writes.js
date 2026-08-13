/**
 * Norwegian Cruise Line controlled-batch manifest + production writes.
 * Phase 4/6 inserts use match_required (non-public review state).
 */

const crypto = require("crypto");
const source = require("./norwegian-discovery-source");
const {
  officialProductKey,
  norwegianExternalKey,
  ADAPTER_ID,
  ADAPTER_VERSION,
  normaliseNorwegianSailing,
  classifyNorwegianItinerary
} = require("./norwegian-discovery-adapter");
const { cruiseIdentityKey, upsertCandidateRecord } = require("./cruise-discovery-ops");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");
const { PUBLIC_BOOKING_CUTOFF_DAYS, daysUntilDeparture } = require("./public-discovered-cruise-inventory");
const {
  resolveNorwegianDestinationAssignment,
  auditNorwegianDestinationCodes,
  NCL_DESTINATION_CODE_SLUG
} = require("./norwegian-destination-mapping");

const NCL_LINE_ID = "c5f5361f-ebe5-4ff4-babe-7eb07f609bae";

function computeReturnDate(departureDate, nights) {
  if (!departureDate || !nights) return null;
  const dt = new Date(`${departureDate}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + Number(nights));
  return dt.toISOString().slice(0, 10);
}

function buildNorwegianUpsertCandidate(normalised, cruiseLine, options = {}) {
  if (!normalised?.complete_eligible) return null;
  const raw = normalised.raw || {};
  const productKey = normalised.official_sailing_id || officialProductKey(raw);
  if (!productKey || !cruiseLine?.id) return null;

  const shipId = normalised.ship_resolution?.ship?.id || null;
  const portMeta = normalised.departure_port_meta || {};
  const departurePort = portMeta.canonicalPortName || null;
  const officialUrl = raw.schedule_url || source.buildScheduleUrl(raw.itinerary_code);
  const nights = Number(raw.duration) || null;

  const external_key = norwegianExternalKey(cruiseLine.id, productKey);
  const identity_key = cruiseIdentityKey({
    cruiseLineId: cruiseLine.id,
    shipId,
    departureDate: raw.departure_date,
    officialUrl,
    nights,
    returnDate: computeReturnDate(raw.departure_date, nights),
    officialSailingId: productKey
  });

  return {
    cruise_line_id: cruiseLine.id,
    ship_id: shipId,
    destination_id: options.destination_id ?? normalised.destination_id ?? null,
    departure_date: raw.departure_date,
    return_date: computeReturnDate(raw.departure_date, nights),
    nights,
    departure_port: departurePort,
    departure_port_meta: portMeta,
    itinerary: raw.itinerary_code || null,
    official_url: officialUrl,
    source_url: officialUrl,
    external_key,
    identity_key,
    official_sailing_id: productKey,
    match_confidence: "medium",
    status: options.phase?.includes("controlled") || options.controlledBatch ? "match_required" : undefined,
    raw_extract: {
      ncl_itinerary_code: raw.itinerary_code,
      ncl_ship_code: raw.ship_code,
      ncl_embark_port_code: raw.port_of_departure_code,
      ncl_destination_codes: raw.destination_codes || [],
      ncl_adapter_id: ADAPTER_ID,
      ncl_adapter_version: ADAPTER_VERSION,
      ncl_controlled_batch: true,
      ncl_phase: options.phase || "phase4_controlled_import",
      departure_port_meta: portMeta,
      source_timestamp: raw.source_timestamp || null
    }
  };
}

function classifyProposedAction(normalised, existing) {
  if (normalised.itinerary_classification?.category === "cruisetour_package") return "cruisetour_skip";
  if (normalised.itinerary_classification?.category === "ambiguous") return "ambiguous_skip";
  if (!normalised.complete_eligible) return "incomplete_skip";
  if (existing?.official_sailing_id || existing?.external_key) return "duplicate_skip";
  if (existing && !existing.official_sailing_id && isLegacyGenericRow(existing)) return "legacy_isolated_skip";
  return "insert_match_required";
}

function isLegacyGenericRow(row) {
  const url = String(row?.official_url || "");
  if (!row?.official_sailing_id && !row?.departure_date) return true;
  if (/blog|\/destinations\/|\/vacations\?/i.test(url)) return true;
  return false;
}

function buildManifestEntry(normalised, cruiseLine, existing, batchPosition, options = {}) {
  const raw = normalised.raw || {};
  const destinationAssignment = options.destinations?.length
    ? resolveNorwegianDestinationAssignment({
        destination_codes: raw.destination_codes || [],
        dbRow: {
          departure_port: normalised.departure_port_meta?.canonicalPortName || null,
          nights: raw.duration,
          itinerary: raw.itinerary_code
        },
        destinations: options.destinations
      })
    : null;

  const unknownCodes = (destinationAssignment?.destination_codes || []).filter(
    (code) => !(code in NCL_DESTINATION_CODE_SLUG) && !["EXTRAORDINARY_JOURNEYS", "WEEKEND"].includes(code)
  );

  const candidate = buildNorwegianUpsertCandidate(normalised, cruiseLine, {
    phase: options.phase,
    destination_id: destinationAssignment?.destination_id || null,
    controlledBatch: true
  });
  if (destinationAssignment?.destination_id && candidate) {
    candidate.destination_id = destinationAssignment.destination_id;
  }
  const action = classifyProposedAction(normalised, existing);

  return {
    batch_position: batchPosition,
    itinerary_code: raw.itinerary_code,
    departure_date: raw.departure_date,
    official_sailing_id: normalised.official_sailing_id,
    external_key: candidate?.external_key || norwegianExternalKey(cruiseLine.id, normalised.official_sailing_id),
    ship_code: raw.ship_code,
    resolved_ship_id: candidate?.ship_id || null,
    resolved_ship_name: normalised.ship_resolution?.ship?.name || null,
    embark_port_code: raw.port_of_departure_code,
    resolved_departure_port: candidate?.departure_port || null,
    resolved_departure_port_id: normalised.departure_port_meta?.canonicalPortId || null,
    duration: raw.duration,
    destination_codes: raw.destination_codes || [],
    proposed_canonical_destination: destinationAssignment?.proposed_slug || null,
    resolved_destination_id: destinationAssignment?.destination_id || null,
    resolved_destination_name: destinationAssignment?.destination_name || null,
    destination_assignment_method: destinationAssignment?.method || null,
    unknown_destination_codes: unknownCodes,
    source_url: candidate?.official_url || raw.schedule_url,
    proposed_action: action,
    proposed_status: "match_required",
    existing_record_id: existing?.id || null,
    candidate
  };
}

function evaluateDryRunGate(manifest, options = {}) {
  const expectedCount = options.expectedCount ?? 25;
  const requireDestination = options.requireDestination === true;
  const failures = [];
  const entries = manifest.entries || [];
  const writes = entries.filter((e) => e.proposed_action === "insert_match_required");

  if (entries.length !== expectedCount) failures.push(`expected_${expectedCount}_entries:${entries.length}`);
  if (writes.length !== expectedCount) failures.push(`expected_${expectedCount}_inserts:${writes.length}`);
  if (entries.some((e) => e.proposed_action !== "insert_match_required")) {
    failures.push("non_insert_actions_present");
  }
  if (writes.some((e) => !e.official_sailing_id || !e.external_key)) failures.push("missing_identity");
  if (writes.some((e) => !e.resolved_ship_id)) failures.push("unresolved_ship");
  if (writes.some((e) => !e.resolved_departure_port)) failures.push("unresolved_port");
  if (requireDestination && writes.some((e) => !e.resolved_destination_id)) {
    failures.push("unresolved_destination");
  }
  if (requireDestination && writes.some((e) => !e.candidate?.destination_id)) {
    failures.push("null_candidate_destination_id");
  }
  if (writes.some((e) => (e.unknown_destination_codes || []).length)) {
    failures.push("unknown_ncl_destination_code");
  }
  if (new Set(writes.map((w) => w.official_sailing_id)).size !== writes.length) {
    failures.push("duplicate_official_sailing_id_in_manifest");
  }
  if (new Set(writes.map((w) => w.external_key)).size !== writes.length) {
    failures.push("duplicate_external_key_in_manifest");
  }

  return {
    passed: failures.length === 0,
    failures,
    proposed_inserts: writes.length,
    proposed_updates: 0,
    proposed_deletes: 0,
    expected_count: expectedCount
  };
}

async function indexExistingNorwegianRecords(supabase, cruiseLineId) {
  const select =
    "id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,itinerary_ports,status,official_url,source_url,external_key,identity_key,official_sailing_id,raw_extract";
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
  const byOfficial = new Map();
  const byExternal = new Map();
  for (const row of rows || []) {
    if (row.official_sailing_id) byOfficial.set(row.official_sailing_id, row);
    if (row.external_key) byExternal.set(row.external_key, row);
  }
  return { rows: rows || [], byOfficial, byExternal };
}

function findExistingRecord(indexes, normalised) {
  const key = normalised.official_sailing_id;
  return indexes.byOfficial.get(key) || indexes.byExternal.get(normalised.external_key) || null;
}

async function buildManifestFromEntries({
  entries,
  cruiseLine,
  supabase,
  batchId,
  sourceTimestamp,
  mode = "norwegian_phase4_controlled_batch",
  phase = "phase4_controlled_import",
  expectedCount = 25,
  requireDestination = false
}) {
  const indexes = supabase ? await indexExistingNorwegianRecords(supabase, cruiseLine.id) : { byOfficial: new Map(), byExternal: new Map() };
  const destinations = supabase
    ? await supabase("destinations?select=id,name,slug,status,classification_enabled&order=slug.asc")
    : [];
  const manifestEntries = entries.map((normalised, index) => {
    const existing = findExistingRecord(indexes, normalised);
    return buildManifestEntry(normalised, cruiseLine, existing, index + 1, {
      destinations: destinations || [],
      phase
    });
  });

  const manifest = {
    batch_id: batchId,
    generated_at: new Date().toISOString(),
    mode,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    cruise_line_id: cruiseLine.id,
    source_timestamp: sourceTimestamp,
    writes_performed: false,
    destination_code_audit: auditNorwegianDestinationCodes(
      manifestEntries.map((entry) => ({ destination_codes: entry.destination_codes }))
    ),
    entries: manifestEntries
  };
  manifest.dry_run_gate = evaluateDryRunGate(manifest, { expectedCount, requireDestination });
  return manifest;
}

async function applyManifestWrites({ manifest, cruiseLine, supabase, maxWrites = 25, runId, requireDestination = false }) {
  const stats = {
    attempted: 0,
    inserted: 0,
    duplicate_skips: 0,
    failed: 0,
    write_details: [],
    inserted_ids: []
  };
  const upsertStats = { new: 0, changed: 0, unchanged: 0, upserted_review: 0 };
  const indexes = await indexExistingNorwegianRecords(supabase, cruiseLine.id);

  for (const entry of manifest.entries || []) {
    if (entry.proposed_action !== "insert_match_required") {
      stats.duplicate_skips += 1;
      continue;
    }
    if (stats.inserted >= maxWrites) break;

    stats.attempted += 1;
    const normalised = {
      complete_eligible: true,
      official_sailing_id: entry.official_sailing_id,
      external_key: entry.external_key,
      ship_resolution: { ship: { id: entry.resolved_ship_id, name: entry.resolved_ship_name } },
      departure_port_meta: {
        canonicalPortName: entry.resolved_departure_port,
        canonicalPortId: entry.resolved_departure_port_id
      },
      raw: {
        itinerary_code: entry.itinerary_code,
        departure_date: entry.departure_date,
        duration: entry.duration,
        ship_code: entry.ship_code,
        port_of_departure_code: entry.embark_port_code,
        destination_codes: entry.destination_codes,
        schedule_url: entry.source_url
      }
    };

    const candidate = entry.candidate || buildNorwegianUpsertCandidate(normalised, cruiseLine);
    if (!candidate) {
      stats.failed += 1;
      continue;
    }
    if (entry.resolved_destination_id) candidate.destination_id = entry.resolved_destination_id;
    candidate.status = "match_required";

    if (requireDestination && !candidate.destination_id) {
      stats.failed += 1;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "blocked_null_destination_id",
        resolved_destination_id: entry.resolved_destination_id || null,
        candidate_destination_id: entry.candidate?.destination_id || null
      });
      continue;
    }

    const existing = findExistingRecord(indexes, { official_sailing_id: entry.official_sailing_id, external_key: entry.external_key });
    if (existing && !isLegacyGenericRow(existing)) {
      stats.duplicate_skips += 1;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "duplicate_skip",
        discovered_cruise_id: existing.id
      });
      continue;
    }

    try {
      const result = await upsertCandidateRecord(candidate, upsertStats, {
        prevRecord: null,
        matchPolicy: "official_sailing_id_only"
      });
      const row = result.row;
      const okStatus = row?.status === "match_required";
      if (result.created && okStatus) {
        stats.inserted += 1;
        stats.inserted_ids.push(row.id);
        if (row.official_sailing_id) indexes.byOfficial.set(row.official_sailing_id, row);
        if (row.external_key) indexes.byExternal.set(row.external_key, row);
      } else if (result.duplicate || !result.created) {
        stats.duplicate_skips += 1;
      } else {
        stats.failed += 1;
      }
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        external_key: entry.external_key,
        discovered_cruise_id: row?.id || null,
        created: result.created,
        status: row?.status || result.status,
        result_action: result.created ? "inserted" : result.duplicate ? "duplicate_skip" : "failed",
        rollback_snapshot: row ? snapshotRecordForRollback(row) : null
      });
    } catch (error) {
      stats.failed += 1;
      stats.write_details.push({
        official_sailing_id: entry.official_sailing_id,
        result_action: "failed",
        error: error.message || String(error)
      });
    }
  }

  return {
    run_id: runId,
    stats,
    upsert_stats: upsertStats
  };
}

async function rollbackInsertedRows(supabase, insertedIds = []) {
  const rolledBack = [];
  for (const id of insertedIds) {
    await supabase(`discovered_cruises?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" }
    });
    rolledBack.push(id);
  }
  return { rolled_back_count: rolledBack.length, rolled_back_ids: rolledBack };
}

const PHASE3_EMBARK_SLOTS = [
  { code: "TAR", label: "Tarragona" },
  { code: "RAV", label: "Ravenna" },
  { code: "VCE", label: "Trieste" },
  { code: "SAI", label: "San Antonio Chile" },
  { code: "INC", label: "Incheon" },
  { code: "JAX", label: "Jacksonville" },
  { code: "PHL", label: "Philadelphia" }
];

const CONTROL_EMBARK_SLOTS = ["MIA", "SOU", "SEA", "BCN", "SJU", "PCV", "YOK", "CIV", "PIR"];

const PHASE6_EXTRA_EMBARK_SLOTS = [
  { code: "PWM", label: "Portland Maine" },
  { code: "POP", label: "Puerto Plata" },
  { code: "MLA", label: "Valletta" },
  { code: "LAX", label: "Los Angeles" },
  { code: "HNL", label: "Honolulu" },
  { code: "SIN", label: "Singapore" },
  { code: "SYD", label: "Sydney" }
];

const PHASE6_REGION_SLOTS = [
  { codes: ["CARIBBEAN", "BAHAMAS", "BERMUDA"], reason: "caribbean_bahamas_bermuda" },
  { codes: ["ALASKA"], reason: "alaska" },
  { codes: ["HAWAII"], reason: "hawaii" },
  { codes: ["MEDITERRANEAN", "GREEK_ISLES"], reason: "mediterranean_greek" },
  { codes: ["NORTHERN_EUROPE"], reason: "northern_europe" },
  { codes: ["CANADA_NEW_ENGL"], reason: "canada_new_england" },
  { codes: ["ASIA"], reason: "asia" },
  { codes: ["AFRICA"], reason: "africa" },
  { codes: ["SOUTH_AMERICA"], reason: "south_america" },
  { codes: ["TRANSATLANTIC"], reason: "transatlantic" },
  { codes: ["MEXICAN_RIVIERA"], reason: "mexican_riviera" },
  { codes: ["PANAMA_CANAL"], reason: "panama_canal" },
  { codes: ["AUSTRALIA", "AUSTRALIA_NEW_ZEALAND", "SOUTH_PACIFIC"], reason: "pacific" }
];

function productHasDestinationCode(product, codes = []) {
  const dest = (product.raw?.destination_codes || []).map((code) => String(code).toUpperCase());
  return codes.some((code) => dest.includes(String(code).toUpperCase()));
}

function selectControlledBatchProducts(normalisedProducts, { maxWrites = 25 } = {}) {
  const eligible = normalisedProducts
    .filter((p) => p.complete_eligible && p.itinerary_classification?.category === "ocean")
    .sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id)));

  const selected = [];
  const selectedIds = new Set();
  const shipCodes = new Set();

  function pickFirst(matchFn, reason) {
    if (selected.length >= maxWrites) return false;
    for (const p of eligible) {
      if (selectedIds.has(p.official_sailing_id)) continue;
      if (matchFn(p)) {
        selected.push({ ...p, selection_reason: reason });
        selectedIds.add(p.official_sailing_id);
        if (p.raw?.ship_code) shipCodes.add(String(p.raw.ship_code).toUpperCase());
        return true;
      }
    }
    return false;
  }

  for (const slot of PHASE3_EMBARK_SLOTS) {
    pickFirst((p) => String(p.raw?.port_of_departure_code || "").toUpperCase() === slot.code, `phase3_${slot.code}`);
  }

  pickFirst((p) => Number(p.raw?.duration) <= 4, "short_cruise");
  pickFirst((p) => Number(p.raw?.duration) === 7, "seven_night");
  pickFirst((p) => Number(p.raw?.duration) >= 11, "long_cruise");
  pickFirst((p) => String(p.raw?.ship_code || "").toUpperCase() === "PRIDE_AMER", "hawaii_pride_america");

  for (const code of CONTROL_EMBARK_SLOTS) {
    pickFirst((p) => String(p.raw?.port_of_departure_code || "").toUpperCase() === code, `control_${code}`);
  }

  const remaining = eligible.filter((p) => !selectedIds.has(p.official_sailing_id));
  const ordered = remaining
    .map((p) => {
      const ship = String(p.raw?.ship_code || "").toUpperCase();
      const port = String(p.raw?.port_of_departure_code || "").toUpperCase();
      const usedPorts = new Set(selected.map((s) => String(s.raw?.port_of_departure_code || "").toUpperCase()));
      const score = (shipCodes.has(ship) ? 0 : 4) + (usedPorts.has(port) ? 0 : 1);
      return { p, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score || String(a.p.official_sailing_id).localeCompare(String(b.p.official_sailing_id))
    );

  for (const { p } of ordered) {
    if (selected.length >= maxWrites) break;
    selected.push({ ...p, selection_reason: "diversity_fill" });
    selectedIds.add(p.official_sailing_id);
    if (p.raw?.ship_code) shipCodes.add(String(p.raw.ship_code).toUpperCase());
  }

  return selected
    .slice(0, maxWrites)
    .sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id)));
}

function selectPhase6BatchProducts(normalisedProducts, { maxWrites = 50, excludeOfficialIds = new Set(), minDistinctShips = 15 } = {}) {
  const eligible = normalisedProducts
    .filter(
      (p) =>
        p.complete_eligible &&
        p.itinerary_classification?.category === "ocean" &&
        !excludeOfficialIds.has(p.official_sailing_id)
    )
    .sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id)));

  const selected = [];
  const selectedIds = new Set();
  const shipCodes = new Set();
  const usedRegions = new Set();

  function pickFirst(matchFn, reason) {
    if (selected.length >= maxWrites) return false;
    for (const p of eligible) {
      if (selectedIds.has(p.official_sailing_id)) continue;
      if (matchFn(p)) {
        selected.push({ ...p, selection_reason: reason });
        selectedIds.add(p.official_sailing_id);
        if (p.raw?.ship_code) shipCodes.add(String(p.raw.ship_code).toUpperCase());
        return true;
      }
    }
    return false;
  }

  for (const slot of [...PHASE3_EMBARK_SLOTS, ...PHASE6_EXTRA_EMBARK_SLOTS]) {
    pickFirst((p) => String(p.raw?.port_of_departure_code || "").toUpperCase() === slot.code, `embark_${slot.code}`);
  }

  for (const slot of PHASE6_REGION_SLOTS) {
    pickFirst((p) => {
      if (usedRegions.has(slot.reason)) return false;
      if (!productHasDestinationCode(p, slot.codes)) return false;
      usedRegions.add(slot.reason);
      return true;
    }, slot.reason);
  }

  pickFirst((p) => Number(p.raw?.duration) <= 4, "short_cruise");
  pickFirst((p) => Number(p.raw?.duration) === 7, "seven_night");
  pickFirst((p) => Number(p.raw?.duration) >= 10 && Number(p.raw?.duration) <= 14, "ten_to_fourteen_night");
  pickFirst((p) => Number(p.raw?.duration) >= 15, "long_cruise");
  pickFirst((p) => String(p.raw?.ship_code || "").toUpperCase() === "PRIDE_AMER", "hawaii_pride_america");

  for (const code of CONTROL_EMBARK_SLOTS) {
    pickFirst((p) => String(p.raw?.port_of_departure_code || "").toUpperCase() === code, `control_${code}`);
  }

  const remaining = eligible.filter((p) => !selectedIds.has(p.official_sailing_id));
  const ordered = remaining
    .map((p) => {
      const ship = String(p.raw?.ship_code || "").toUpperCase();
      const port = String(p.raw?.port_of_departure_code || "").toUpperCase();
      const usedPorts = new Set(selected.map((s) => String(s.raw?.port_of_departure_code || "").toUpperCase()));
      const needShips = shipCodes.size < minDistinctShips;
      const score =
        (needShips && !shipCodes.has(ship) ? 8 : shipCodes.has(ship) ? 0 : 4) + (usedPorts.has(port) ? 0 : 1);
      return { p, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score || String(a.p.official_sailing_id).localeCompare(String(b.p.official_sailing_id))
    );

  for (const { p } of ordered) {
    if (selected.length >= maxWrites) break;
    selected.push({ ...p, selection_reason: "diversity_fill" });
    selectedIds.add(p.official_sailing_id);
    if (p.raw?.ship_code) shipCodes.add(String(p.raw.ship_code).toUpperCase());
  }

  if (shipCodes.size < minDistinctShips) {
    const swapCandidates = eligible.filter((p) => !selectedIds.has(p.official_sailing_id));
    for (let index = selected.length - 1; index >= 0 && shipCodes.size < minDistinctShips; index -= 1) {
      const current = selected[index];
      if (current.selection_reason !== "diversity_fill") continue;
      const replacement = swapCandidates.find((p) => {
        const ship = String(p.raw?.ship_code || "").toUpperCase();
        return ship && !shipCodes.has(ship);
      });
      if (!replacement) continue;
      selectedIds.delete(current.official_sailing_id);
      selected[index] = { ...replacement, selection_reason: "ship_diversity_swap" };
      selectedIds.add(replacement.official_sailing_id);
      shipCodes.add(String(replacement.raw.ship_code).toUpperCase());
    }
  }

  return {
    selected: selected
      .slice(0, maxWrites)
      .sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id))),
    distinct_ships: shipCodes.size,
    ship_codes: [...shipCodes].sort()
  };
}

function revalidateManifestAgainstSource(manifest, sourceByOfficialId, today) {
  const invalid = [];
  for (const entry of manifest.entries || []) {
    const live = sourceByOfficialId.get(entry.official_sailing_id);
    if (!live) {
      invalid.push({ official_sailing_id: entry.official_sailing_id, reason: "missing_from_source" });
      continue;
    }
    const category =
      live.itinerary_classification?.category ||
      classifyNorwegianItinerary(live.raw?.raw_itinerary || live.raw)?.category;
    if (category !== "ocean") {
      invalid.push({ official_sailing_id: entry.official_sailing_id, reason: "not_ocean" });
    }
    if (!live.complete_eligible) {
      invalid.push({ official_sailing_id: entry.official_sailing_id, reason: "not_import_ready" });
    }
    const days = daysUntilDeparture(entry.departure_date, today);
    if (days != null && days <= PUBLIC_BOOKING_CUTOFF_DAYS) {
      invalid.push({ official_sailing_id: entry.official_sailing_id, reason: "within_21_day_cutoff" });
    }
    const liveKey = live.official_sailing_id || officialProductKey(live.raw || live);
    if (liveKey !== entry.official_sailing_id) {
      invalid.push({ official_sailing_id: entry.official_sailing_id, reason: "identity_changed" });
    }
  }
  return { valid: invalid.length === 0, invalid };
}

module.exports = {
  NCL_LINE_ID,
  PHASE3_EMBARK_SLOTS,
  CONTROL_EMBARK_SLOTS,
  PHASE6_EXTRA_EMBARK_SLOTS,
  PHASE6_REGION_SLOTS,
  computeReturnDate,
  buildNorwegianUpsertCandidate,
  buildManifestEntry,
  evaluateDryRunGate,
  buildManifestFromEntries,
  applyManifestWrites,
  rollbackInsertedRows,
  revalidateManifestAgainstSource,
  indexExistingNorwegianRecords,
  selectControlledBatchProducts,
  selectPhase6BatchProducts,
  auditNorwegianDestinationCodes,
  isLegacyGenericRow
};
