/**
 * Silversea Classic itinerary_ports controlled backfill (M0C/M0D).
 * Updates ONLY discovered_cruises.itinerary_ports for exact frozen Classic UUIDs.
 */

const { buildSilverseaUpsertCandidate, buildItineraryPorts } = require("./silversea-discovery-writes");
const { buildDiscoveredCruiseUpsertPayload, normalizeItineraryPortsForDb } = require("./cruise-discovery-ops");
const { hasUnresolvedActualItineraryPort, isClassic, loadFrozenOfficialSailingIds } = require("./silversea-controlled-batch");
const { partitionByPublicBookingCutoff } = require("./public-discovered-cruise-inventory");
const crypto = require("crypto");
const {
  isExpeditionOfficialId,
  portsArrayEqual,
  normalizeStoredPorts,
  REPAIR_CATEGORY,
  classifyItineraryPortsRepair,
  isDeterministicRepairCategory,
  buildRowFingerprint,
  FINGERPRINT_FIELDS,
  NON_WHITELIST_COMPARE_FIELDS,
  UPDATE_WHITELIST,
  verifyItineraryPortsRepairRow,
  applyItineraryPortsRepairBatch,
  buildM0bRollbackManifest
} = require("./silversea-expedition-itinerary-ports-backfill");

const M0C_BACKFILL_FIXTURE = "scripts/fixtures/silversea/classic-m0c-itinerary-ports-backfill.json";
const M0D1_BACKFILL_FIXTURE = "scripts/fixtures/silversea/classic-m0d1-itinerary-ports-backfill.json";
const M0D_BATCH_SIZES = Object.freeze([200, 200, 199]);
const M0D1_OPERATION = "silversea_classic_m0d1_itinerary_ports_backfill";
const M0D1_APPLY_CONFIRMATION_TOKEN = "SILVERSEA-CLASSIC-M0D1-ITINERARY-PORTS-BACKFILL";
const M0D_OPERATION = "silversea_classic_m0d_itinerary_ports_backfill";
const M0D_APPLY_CONFIRMATION_TOKEN = "SILVERSEA-CLASSIC-M0D-ITINERARY-PORTS-BACKFILL";

const CLASSIC_AUDIT_CATEGORY = Object.freeze({
  ...REPAIR_CATEGORY,
  SOURCE_ABSENT_RECONSTRUCTABLE: "SOURCE_ABSENT_RECONSTRUCTABLE",
  SOURCE_ABSENT_NOT_SAFE_TO_REPAIR: "SOURCE_ABSENT_NOT_SAFE_TO_REPAIR",
  EXPECTED_MANIFEST_AMBIGUOUS: "EXPECTED_MANIFEST_AMBIGUOUS",
  CRUISE_TYPE_CHANGED: "CRUISE_TYPE_CHANGED",
  IDENTITY_CONFLICT: "IDENTITY_CONFLICT",
  OTHER_CONFLICT: "OTHER_CONFLICT"
});

const SOURCE_RECONCILE_STATUS = Object.freeze({
  CURRENT_SOURCE_MATCH: "CURRENT_SOURCE_MATCH",
  SOURCE_ABSENT: "SOURCE_ABSENT",
  CRUISE_TYPE_CHANGED: "CRUISE_TYPE_CHANGED",
  IDENTITY_CONFLICT: "IDENTITY_CONFLICT",
  SOURCE_UNSAFE: "SOURCE_UNSAFE"
});

const CLASSIC_ITINERARY_PORTS_CONTRACT = Object.freeze({
  description:
    "Classic discovered_cruises.itinerary_ports stores resolved conventional port names for consumer-facing itinerary display.",
  source: "buildItineraryPorts() via buildSilverseaUpsertCandidate()",
  includes: [
    "embark conventional port when resolved",
    "intermediate conventional port calls",
    "disembark conventional port when resolved",
    "duplicate consecutive calls preserved from source order",
    "overnight port calls preserved as separate stops when source provides them"
  ],
  excludes: [
    "sea days",
    "scenic cruising stops",
    "expedition landing/anchorage/inland semantics",
    "unresolved source port stops"
  ],
  empty_array_legitimate_when: "no resolved conventional port stops in source itinerary",
  eligibility_rules_changed: false
});

function isClassicOfficialId(id) {
  return Boolean(id) && !isExpeditionOfficialId(id);
}

function isClassicProductionRow(row) {
  return row?.status === "active" && row?.official_sailing_id && isClassicOfficialId(row.official_sailing_id);
}

function buildExpectedClassicItineraryPorts(normalised, cruiseLine) {
  if (!normalised) return { ok: false, reason: "source_missing", ports: null };
  if (!isClassic(normalised.raw || {})) {
    return { ok: false, reason: "not_classic_source", ports: null };
  }
  if (hasUnresolvedActualItineraryPort(normalised)) {
    return { ok: false, reason: "unresolved_port", ports: null };
  }
  const candidate = buildSilverseaUpsertCandidate(normalised, cruiseLine);
  if (candidate) {
    return {
      ok: true,
      ports: normalizeStoredPorts(normalizeItineraryPortsForDb(candidate)),
      candidate,
      reconstruction_method: "current_source_candidate"
    };
  }
  if (normalised.complete_high_confidence && !normalised.match_required) {
    const ports = normalizeStoredPorts(buildItineraryPorts(normalised));
    return {
      ok: true,
      ports,
      candidate: null,
      reconstruction_method: "source_itinerary_ports_direct"
    };
  }
  return { ok: false, reason: "candidate_null", ports: null };
}

function buildExpectedPortsFromRawExtract(rawExtract) {
  const stops = rawExtract?.itinerary_stops;
  if (!Array.isArray(stops) || stops.length === 0) {
    return { ok: false, reason: "no_itinerary_stops", ports: null };
  }
  const portStops = stops.filter((s) => s?.kind === "port");
  if (portStops.length === 0) {
    return { ok: true, ports: [], reconstruction_method: "raw_extract_no_conventional_ports" };
  }
  const unresolved = portStops.filter((s) => s.port_resolution?.status !== "resolved");
  if (unresolved.length > 0) {
    return { ok: false, reason: "unresolved_ports_in_raw_extract", ports: null };
  }
  const ports = portStops
    .filter((s) => !s.port_resolution?.expedition_logistics_gateway)
    .filter(
      (s) => !s.expedition_semantic || s.expedition_semantic === "CONVENTIONAL_PORT"
    )
    .map((s) => s.port_resolution?.canonicalPortName)
    .filter(Boolean);
  return {
    ok: true,
    ports: normalizeStoredPorts(ports),
    reconstruction_method: "raw_extract_itinerary_stops"
  };
}

function reconcileClassicSourceStatus(prodRow, source) {
  if (!source) return SOURCE_RECONCILE_STATUS.SOURCE_ABSENT;
  const sourceId = String(source.official_sailing_id || source.raw?.cruise_code || "").toUpperCase();
  const prodId = String(prodRow.official_sailing_id || "").toUpperCase();
  if (sourceId && prodId && sourceId !== prodId) {
    return SOURCE_RECONCILE_STATUS.IDENTITY_CONFLICT;
  }
  if (!isClassic(source.raw || {})) {
    return SOURCE_RECONCILE_STATUS.CRUISE_TYPE_CHANGED;
  }
  return SOURCE_RECONCILE_STATUS.CURRENT_SOURCE_MATCH;
}

function classifyClassicItineraryPortsAudit({
  storedPorts,
  expectedPorts,
  expectedOk,
  sourceReconcileStatus,
  rawExtractReconstructable
}) {
  const stored = normalizeStoredPorts(storedPorts);
  const expected = normalizeStoredPorts(expectedPorts);

  if (sourceReconcileStatus === SOURCE_RECONCILE_STATUS.CRUISE_TYPE_CHANGED) {
    return CLASSIC_AUDIT_CATEGORY.CRUISE_TYPE_CHANGED;
  }
  if (sourceReconcileStatus === SOURCE_RECONCILE_STATUS.IDENTITY_CONFLICT) {
    return CLASSIC_AUDIT_CATEGORY.IDENTITY_CONFLICT;
  }

  if (sourceReconcileStatus === SOURCE_RECONCILE_STATUS.SOURCE_ABSENT) {
    if (rawExtractReconstructable?.ok) {
      if (portsArrayEqual(stored, rawExtractReconstructable.ports)) {
        return stored.length === 0
          ? CLASSIC_AUDIT_CATEGORY.STORED_EMPTY_EXPECTED_EMPTY
          : CLASSIC_AUDIT_CATEGORY.EXACT_MATCH;
      }
      if (stored.length === 0 && rawExtractReconstructable.ports.length > 0) {
        return CLASSIC_AUDIT_CATEGORY.SOURCE_ABSENT_RECONSTRUCTABLE;
      }
      if (stored.length > 0 && rawExtractReconstructable.ports.length > 0 && !portsArrayEqual(stored, rawExtractReconstructable.ports)) {
        return CLASSIC_AUDIT_CATEGORY.STORED_NONEMPTY_EXPECTED_DIFFERENT;
      }
      return CLASSIC_AUDIT_CATEGORY.SOURCE_ABSENT_NOT_SAFE_TO_REPAIR;
    }
    return CLASSIC_AUDIT_CATEGORY.SOURCE_ABSENT_NOT_SAFE_TO_REPAIR;
  }

  if (!expectedOk) {
    return CLASSIC_AUDIT_CATEGORY.EXPECTED_MANIFEST_AMBIGUOUS;
  }

  const base = classifyItineraryPortsRepair({
    storedPorts: stored,
    expectedPorts: expected,
    sourceAvailable: true,
    expectedOk: true
  });
  return base;
}

function isClassicDeterministicRepairCategory(category) {
  return (
    isDeterministicRepairCategory(category) ||
    category === CLASSIC_AUDIT_CATEGORY.SOURCE_ABSENT_RECONSTRUCTABLE
  );
}

function isClassicDeferredCategory(category) {
  return (
    category === CLASSIC_AUDIT_CATEGORY.SOURCE_ABSENT_NOT_SAFE_TO_REPAIR ||
    category === CLASSIC_AUDIT_CATEGORY.EXPECTED_MANIFEST_AMBIGUOUS ||
    category === CLASSIC_AUDIT_CATEGORY.CRUISE_TYPE_CHANGED ||
    category === CLASSIC_AUDIT_CATEGORY.IDENTITY_CONFLICT ||
    category === CLASSIC_AUDIT_CATEGORY.OTHER_CONFLICT
  );
}

function resolveClassicProvenance(officialSailingId, provenanceSets) {
  const id = String(officialSailingId || "").toUpperCase();
  for (const [phase, idSet] of Object.entries(provenanceSets || {})) {
    if (idSet?.has?.(id)) return phase;
  }
  return "unknown";
}

function loadClassicProvenanceSets(rootDir, fs) {
  const fixtureDir = `${rootDir}/scripts/fixtures/silversea`;
  const sets = {};
  const fixtureFiles = {
    phase4a: "phase4a-frozen-eligible.json",
    phase4b: "phase4b-frozen-eligible.json",
    phase5: "phase5-frozen-25.json"
  };
  for (const [phase, file] of Object.entries(fixtureFiles)) {
    const full = `${fixtureDir}/${file}`;
    if (!fs.existsSync(full)) continue;
    const data = JSON.parse(fs.readFileSync(full, "utf8"));
    sets[phase] = new Set(loadFrozenOfficialSailingIds(data));
  }
  const reportFiles = {
    first_batch_75: "reports/silversea-first-controlled-batch-silversea-first-batch-75-2026-08-15T01-23-28-633Z.json",
    controlled_batch_124: "reports/silversea-first-controlled-batch-silversea-controlled-batch-124-2026-08-15T03-35-12-803Z.json",
    controlled_batch_25: "reports/silversea-first-controlled-batch-silversea-controlled-batch-25-2026-08-15T02-46-45-370Z.json"
  };
  for (const [phase, rel] of Object.entries(reportFiles)) {
    const full = `${rootDir}/${rel}`;
    if (!fs.existsSync(full)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      sets[phase] = new Set(loadFrozenOfficialSailingIds(data));
    } catch {
      /* skip malformed report */
    }
  }
  return sets;
}

function verifyClassicFrozenBeforeMatch(prodRow, fixtureRow) {
  const issues = [];
  if (!prodRow) issues.push("missing_row");
  if (prodRow?.id !== fixtureRow.production_uuid) issues.push("uuid_mismatch");
  if (prodRow?.official_sailing_id !== fixtureRow.official_sailing_id) issues.push("official_id_mismatch");
  if (!portsArrayEqual(prodRow?.itinerary_ports, fixtureRow.before_itinerary_ports)) {
    issues.push("before_itinerary_ports_mismatch");
  }
  for (const field of FINGERPRINT_FIELDS) {
    const expected = fixtureRow.row_fingerprint?.[field];
    if (expected != null && String(prodRow?.[field] ?? "") !== String(expected ?? "")) {
      issues.push(`fingerprint_${field}`);
    }
  }
  if (prodRow && !isClassicOfficialId(prodRow.official_sailing_id)) {
    issues.push("not_classic");
  }
  return { ok: issues.length === 0, issues };
}

function buildClassicBackfillFixtureRow(sequence, auditRow) {
  return {
    sequence,
    production_uuid: auditRow.production_uuid,
    official_sailing_id: auditRow.official_sailing_id,
    ship: auditRow.ship,
    departure: auditRow.departure,
    destination: auditRow.destination,
    before_itinerary_ports: normalizeStoredPorts(auditRow.stored_itinerary_ports),
    after_itinerary_ports: normalizeStoredPorts(auditRow.expected_itinerary_ports),
    source_evidence_type: auditRow.source_evidence_type,
    source_status: auditRow.source_reconcile_status,
    reconstruction_method: auditRow.reconstruction_method,
    provenance: auditRow.provenance,
    repair_category: auditRow.repair_category,
    deterministic_reason: auditRow.mismatch_reason || "insert_path_omitted_itinerary_ports",
    row_fingerprint: auditRow.row_fingerprint,
    proposed_action: "UPDATE itinerary_ports ONLY"
  };
}

function validateClassicRepairFixture(fixture) {
  const rows = fixture?.rows || [];
  const uuids = rows.map((r) => r.production_uuid);
  const ids = rows.map((r) => r.official_sailing_id);
  const uuidSet = new Set(uuids);
  const idSet = new Set(ids.map((id) => String(id).toUpperCase()));
  const frozen = fixture?.frozen_count ?? rows.length;
  const issues = [];
  if (rows.length !== frozen) issues.push(`rows:${rows.length}!=frozen:${frozen}`);
  if (uuidSet.size !== rows.length) issues.push(`uuid_unique:${uuidSet.size}`);
  if (idSet.size !== rows.length) issues.push(`id_unique:${idSet.size}`);
  for (const row of rows) {
    if (!isClassicOfficialId(row.official_sailing_id)) issues.push(`non_classic:${row.official_sailing_id}`);
    if (isExpeditionOfficialId(row.official_sailing_id)) issues.push(`expedition:${row.official_sailing_id}`);
    if (!Array.isArray(row.before_itinerary_ports)) issues.push(`missing_before:${row.official_sailing_id}`);
    if (!Array.isArray(row.after_itinerary_ports)) issues.push(`missing_after:${row.official_sailing_id}`);
  }
  return {
    ok: issues.length === 0,
    issues,
    row_count: rows.length,
    uuid_unique: uuidSet.size,
    id_unique: idSet.size,
    expedition_rows: rows.filter((r) => isExpeditionOfficialId(r.official_sailing_id)).length,
    legacy_rows: rows.filter((r) => !r.official_sailing_id).length
  };
}

function dryRunClassicItineraryPortsBackfill(fixture) {
  const rows = fixture?.rows || [];
  return {
    authorised_updates: rows.length,
    proposed_itinerary_ports_updates: rows.length,
    proposed_inserts: 0,
    proposed_deletes: 0,
    other_column_updates: 0,
    update_whitelist: UPDATE_WHITELIST.slice(),
    classic_rows: rows.length,
    expedition_rows: 0,
    legacy_rows: 0
  };
}

function buildM0dRollbackManifest(params) {
  return buildM0bRollbackManifest({
    ...params,
    operation: M0D_OPERATION,
    fixturePath: params.fixturePath || M0C_BACKFILL_FIXTURE
  });
}

function assertClassicInsertPayloadIncludesItineraryPorts(candidate, mergedDeparture, identityKey, status, reasons, now) {
  return buildDiscoveredCruiseUpsertPayload(candidate, mergedDeparture, {
    identity_key: identityKey,
    status,
    reasons,
    now,
    includeItineraryPorts: true
  });
}

function countByKey(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = keyFn(row) || "unknown";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function sortMasterClassicRows(rows) {
  return rows.slice().sort((a, b) => String(a.official_sailing_id).localeCompare(String(b.official_sailing_id)));
}

function partitionMasterClassicFixture(masterFixture) {
  const sorted = sortMasterClassicRows(masterFixture?.rows || []);
  const total = sorted.length;
  const [m0d1Size, m0d2Size, m0d3Size] = M0D_BATCH_SIZES;
  if (total !== m0d1Size + m0d2Size + m0d3Size) {
    return {
      ok: false,
      reason: `master_count_${total}_expected_${m0d1Size + m0d2Size + m0d3Size}`,
      sorted,
      batches: null
    };
  }
  const m0d1 = sorted.slice(0, m0d1Size);
  const m0d2 = sorted.slice(m0d1Size, m0d1Size + m0d2Size);
  const m0d3 = sorted.slice(m0d1Size + m0d2Size);
  const allIds = sorted.map((r) => String(r.official_sailing_id).toUpperCase());
  const uniqueIds = new Set(allIds);
  return {
    ok: true,
    partition_policy: "official_sailing_id ASC",
    sorted,
    batches: {
      m0d1: { batch_index: 1, count: m0d1.length, rows: m0d1 },
      m0d2: { batch_index: 2, count: m0d2.length, rows: m0d2 },
      m0d3: { batch_index: 3, count: m0d3.length, rows: m0d3 }
    },
    coverage: {
      master_count: total,
      partition_total: m0d1.length + m0d2.length + m0d3.length,
      duplicate_ids: allIds.length - uniqueIds.size,
      missing_ids: 0
    }
  };
}

function validateClassicPartition(partition) {
  const issues = [];
  if (!partition?.ok) issues.push(partition?.reason || "partition_failed");
  const ids1 = new Set((partition?.batches?.m0d1?.rows || []).map((r) => String(r.official_sailing_id).toUpperCase()));
  const ids2 = new Set((partition?.batches?.m0d2?.rows || []).map((r) => String(r.official_sailing_id).toUpperCase()));
  const ids3 = new Set((partition?.batches?.m0d3?.rows || []).map((r) => String(r.official_sailing_id).toUpperCase()));
  if (ids1.size !== 200) issues.push(`m0d1_count:${ids1.size}`);
  if (ids2.size !== 200) issues.push(`m0d2_count:${ids2.size}`);
  if (ids3.size !== 199) issues.push(`m0d3_count:${ids3.size}`);
  for (const id of ids1) {
    if (ids2.has(id) || ids3.has(id)) issues.push(`overlap:${id}`);
  }
  for (const id of ids2) {
    if (ids3.has(id)) issues.push(`overlap:${id}`);
  }
  return { ok: issues.length === 0, issues };
}

function hashFixtureContent(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function buildM0d1BatchFixture(params) {
  const partition = params.partition;
  const rows = (partition?.batches?.m0d1?.rows || []).map((row, i) => ({
    ...row,
    sequence: i + 1,
    proposed_action: "UPDATE itinerary_ports ONLY"
  }));
  return {
    phase: "M0D1",
    mode: M0D1_BACKFILL_FIXTURE,
    generated_at: params.generatedAt || new Date().toISOString(),
    git_sha: params.gitSha || null,
    parent_fixture_path: params.parentFixturePath || M0C_BACKFILL_FIXTURE,
    parent_fixture_sha256: params.parentFixtureSha256 || null,
    batch_index: 1,
    batch_count: 3,
    batch_size: 200,
    total_repair_population: 599,
    partition_policy: partition?.partition_policy || "official_sailing_id ASC",
    frozen_count: rows.length,
    frozen_unique_uuid_count: new Set(rows.map((r) => r.production_uuid)).size,
    frozen_unique_official_id_count: new Set(rows.map((r) => r.official_sailing_id)).size,
    update_whitelist: UPDATE_WHITELIST.slice(),
    rows
  };
}

function computeClassicSourceCutoffCounts(simulation, today) {
  const classicProducts = (simulation?.products || []).filter((p) => isClassic(p.raw || {}));
  const { publiclyEligible, withinCutoff } = partitionByPublicBookingCutoff(
    classicProducts,
    (p) => p.candidate?.departure_date,
    today
  );
  const within = withinCutoff.length;
  const beyond = publiclyEligible.length;
  const total = classicProducts.length;
  return {
    classic_source_total: total,
    classic_within_cutoff: within,
    classic_beyond_cutoff: beyond,
    reconciles: within + beyond === total,
    m0c_1098_count_actually_represented:
      "simulation.summary.eligible_beyond_cutoff — entire catalogue publicly eligible beyond cutoff, not Classic-only",
    m0c_33_count_actually_represented:
      "simulation.summary.within_21_day_cutoff — entire catalogue within cutoff, not Classic-only",
    m0c_classic_cutoff_count_discrepancy_explained: true
  };
}

async function applyClassicItineraryPortsRepairBatch(supabase, fixtureRows, callbacks = {}) {
  return applyItineraryPortsRepairBatch(supabase, fixtureRows, callbacks, {
    verifyBeforeMatch: verifyClassicFrozenBeforeMatch
  });
}

async function verifyClassicRepairBatchResults(supabase, fixtureRows) {
  const checks = [];
  let allOk = true;
  for (const fixtureRow of fixtureRows) {
    const rows = await supabase(
      `discovered_cruises?id=eq.${encodeURIComponent(fixtureRow.production_uuid)}&select=id,official_sailing_id,itinerary_ports,ship_id,departure_date,return_date,nights,destination_id,status,raw_extract,cruise_line_id,departure_port,itinerary,official_url,source_url,external_key,identity_key,match_confidence,review_reason&limit=1`
    );
    const row = rows?.[0] || null;
    const verify = verifyItineraryPortsRepairRow(row, fixtureRow, FINGERPRINT_FIELDS);
    if (!verify.ok) allOk = false;
    checks.push({
      production_uuid: fixtureRow.production_uuid,
      official_sailing_id: fixtureRow.official_sailing_id,
      ...verify
    });
  }
  return {
    ok: allOk && checks.length === fixtureRows.length,
    verified_count: checks.filter((c) => c.ok).length,
    failed_count: checks.filter((c) => !c.ok).length,
    records: checks
  };
}

function auditClassicItineraryPortsPopulation(classicRows, sourceById, line) {
  let exactMatch = 0;
  let remainingRepair = 0;
  let deferred = 0;
  for (const prodRow of classicRows) {
    const source = sourceById.get(String(prodRow.official_sailing_id).toUpperCase()) || null;
    const stored = normalizeStoredPorts(prodRow.itinerary_ports);
    let expected = [];
    let expectedOk = false;
    if (source) {
      const built = buildExpectedClassicItineraryPorts(source, line);
      expectedOk = built.ok;
      expected = built.ok ? built.ports : [];
    }
    const category = classifyClassicItineraryPortsAudit({
      storedPorts: stored,
      expectedPorts: expected,
      expectedOk,
      sourceReconcileStatus: source
        ? SOURCE_RECONCILE_STATUS.CURRENT_SOURCE_MATCH
        : SOURCE_RECONCILE_STATUS.SOURCE_ABSENT,
      rawExtractReconstructable: null
    });
    if (portsArrayEqual(stored, expected) && expectedOk) exactMatch += 1;
    else if (isClassicDeterministicRepairCategory(category)) remainingRepair += 1;
    else if (isClassicDeferredCategory(category)) deferred += 1;
  }
  return {
    total: classicRows.length,
    exact_match: exactMatch,
    remaining_repair_candidates: remainingRepair,
    deferred_unsafe: deferred
  };
}

module.exports = {
  M0C_BACKFILL_FIXTURE,
  M0D1_BACKFILL_FIXTURE,
  M0D_BATCH_SIZES,
  M0D1_OPERATION,
  M0D1_APPLY_CONFIRMATION_TOKEN,
  M0D_OPERATION,
  M0D_APPLY_CONFIRMATION_TOKEN,
  CLASSIC_AUDIT_CATEGORY,
  SOURCE_RECONCILE_STATUS,
  CLASSIC_ITINERARY_PORTS_CONTRACT,
  UPDATE_WHITELIST,
  FINGERPRINT_FIELDS,
  NON_WHITELIST_COMPARE_FIELDS,
  isClassicOfficialId,
  isClassicProductionRow,
  buildExpectedClassicItineraryPorts,
  buildExpectedPortsFromRawExtract,
  reconcileClassicSourceStatus,
  classifyClassicItineraryPortsAudit,
  isClassicDeterministicRepairCategory,
  isClassicDeferredCategory,
  resolveClassicProvenance,
  loadClassicProvenanceSets,
  buildClassicBackfillFixtureRow,
  validateClassicRepairFixture,
  dryRunClassicItineraryPortsBackfill,
  buildM0dRollbackManifest,
  assertClassicInsertPayloadIncludesItineraryPorts,
  verifyClassicFrozenBeforeMatch,
  verifyItineraryPortsRepairRow,
  applyClassicItineraryPortsRepairBatch,
  verifyClassicRepairBatchResults,
  auditClassicItineraryPortsPopulation,
  sortMasterClassicRows,
  partitionMasterClassicFixture,
  validateClassicPartition,
  hashFixtureContent,
  buildM0d1BatchFixture,
  computeClassicSourceCutoffCounts,
  portsArrayEqual,
  normalizeStoredPorts,
  buildRowFingerprint,
  countByKey,
  isExpeditionOfficialId
};
