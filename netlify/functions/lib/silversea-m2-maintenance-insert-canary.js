/**
 * Silversea M2 — controlled weekly-maintenance INSERT canary (exactly WH281005017).
 */

const crypto = require("crypto");
const {
  officialProductKey,
  LINE_SLUG,
  ADAPTER_ID,
  ADAPTER_VERSION
} = require("./silversea-discovery-adapter");
const {
  classifyExclusiveBucket,
  isClassic,
  isExpedition
} = require("./silversea-controlled-batch");
const { isComboSegmentProduct } = require("./silversea-expedition-eligibility");
const {
  buildSilverseaUpsertCandidate,
  indexExistingSilverseaRecords
} = require("./silversea-discovery-writes");
const {
  buildSilverseaWeeklyMaintenanceProposal,
  compareSemanticRawExtract
} = require("./silversea-weekly-maintenance-proposal");
const {
  MAINTENANCE_CLASSIFICATION,
  assessSourcePopulationAnomaly,
  snapshotFingerprint
} = require("./silversea-weekly-maintenance-policy");
const {
  classifySilverseaOfficialInventory,
  isClassicStoredOfficialRow,
  isExpeditionStoredOfficialRow
} = require("./silversea-classic-itinerary-ports-backfill");
const {
  snapshotProtectionRows,
  verifyProtectionSnapshots,
  portsArrayEqual,
  normalizeStoredPorts
} = require("./silversea-expedition-itinerary-ports-backfill");
const {
  buildDiscoveredCruiseUpsertPayload,
  cruiseIdentityKey,
  normalizeItineraryPortsForDb,
  upsertCandidateRecord
} = require("./cruise-discovery-ops");
const { validateCruise } = require("./cruise-discovery");
const {
  buildControlledBatchMarker,
  buildPreWriteRollbackManifest,
  buildAuthoritativeVerificationResult
} = require("./cruise-discovery-controlled-production-run");

const CANARY_OFFICIAL_ID = "WH281005017";
const M2_FIXTURE_REL = "scripts/fixtures/silversea/m2-maintenance-insert-canary-WH281005017.json";
const M2_OPERATION = "silversea_m2_maintenance_insert_canary";
const M2_APPLY_CONFIRMATION_TOKEN = "SILVERSEA-M2-MAINTENANCE-INSERT-CANARY";
const EXPECTED_INSERTS = 1;

function stableJson(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(stableJson);
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableJson(value[key]);
  return out;
}

function hashFixtureContent(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(stableJson(obj))).digest("hex");
}

function findNormalisedProduct(simulation, officialId = CANARY_OFFICIAL_ID) {
  const key = String(officialId).toUpperCase();
  return (simulation?.products || []).find(
    (p) => String(p.official_sailing_id || "").toUpperCase() === key
  ) || null;
}

function buildM2ControlledBatchMarker(runId) {
  return buildControlledBatchMarker({
    line: "silversea",
    productType: "classic",
    phase: "M2",
    runId,
    fixture: M2_FIXTURE_REL
  });
}

function enrichCandidateForM2(candidate, runId) {
  const marker = buildM2ControlledBatchMarker(runId);
  return {
    ...candidate,
    raw_extract: {
      ...(candidate.raw_extract || {}),
      silversea_maintenance_insert_canary: true,
      silversea_m2_phase: "M2",
      controlled_batch: marker
    }
  };
}

function buildM2InsertPayload(candidate) {
  const identity_key =
    candidate.identity_key ||
    cruiseIdentityKey({
      cruiseLineId: candidate.cruise_line_id,
      shipId: candidate.ship_id,
      departureDate: candidate.departure_date,
      officialUrl: candidate.official_url,
      nights: candidate.nights,
      returnDate: candidate.return_date,
      officialSailingId: candidate.official_sailing_id
    });
  const mergedDeparture = {
    departure_port: candidate.departure_port,
    departure_port_meta: candidate.departure_port_meta || candidate.raw_extract?.departure_port_meta || null,
    blocked: false,
    reason: "new"
  };
  const reasons = validateCruise({
    ...candidate,
    departure_port: mergedDeparture.departure_port,
    departure_port_meta: mergedDeparture.departure_port_meta
  });
  const now = new Date().toISOString();
  return buildDiscoveredCruiseUpsertPayload(candidate, mergedDeparture, {
    identity_key,
    status: candidate.status || "active",
    reasons,
    now,
    includeItineraryPorts: true
  });
}

function buildM2CanaryFixture({
  runId,
  simulation,
  normalised,
  cruiseLine,
  productionBefore,
  sourceHealth,
  classificationRecord
}) {
  const candidateBase = buildSilverseaUpsertCandidate(normalised, cruiseLine);
  if (!candidateBase) throw new Error("m2_candidate_build_failed");
  const candidate = enrichCandidateForM2(candidateBase, runId);
  const insertPayload = buildM2InsertPayload(candidate);
  const itinerary_ports = normalizeStoredPorts(insertPayload.itinerary_ports || candidate.itinerary_ports);
  const fixture = {
    phase: "M2",
    official_sailing_id: CANARY_OFFICIAL_ID,
    source_snapshot_fingerprint: snapshotFingerprint({
      health: simulation.health,
      summary: simulation.summary,
      fetched_at: simulation.fetch_result?.fetched_at || null
    }),
    source_snapshot_timestamp: simulation.fetch_result?.fetched_at || new Date().toISOString(),
    source_health: sourceHealth,
    product_type: "classic",
    special_product_deferred: false,
    classification: classificationRecord?.classification || MAINTENANCE_CLASSIFICATION.INSERT_ELIGIBLE,
    eligibility_reasons: classificationRecord?.reason_codes || [],
    production_before: productionBefore,
    candidate,
    insert_payload: insertPayload,
    itinerary_ports,
    itinerary_ports_count: itinerary_ports.length,
    controlled_batch: candidate.raw_extract.controlled_batch,
    fixture_hash: null
  };
  fixture.fixture_hash = hashFixtureContent({
    official_sailing_id: fixture.official_sailing_id,
    candidate: fixture.candidate,
    insert_payload: fixture.insert_payload,
    itinerary_ports: fixture.itinerary_ports,
    source_snapshot_fingerprint: fixture.source_snapshot_fingerprint
  });
  return fixture;
}

async function validateM2Preflight({
  sb,
  adapter,
  simulation,
  productionIndex,
  cruiseLine,
  today,
  loadClassificationDestinations,
  perthCalendarDate
}) {
  const failures = [];
  const officialId = CANARY_OFFICIAL_ID;
  const sourceHealthy = simulation?.ok === true && simulation?.health?.ok === true;
  const populationGuard = assessSourcePopulationAnomaly(simulation?.summary || {});

  if (!sourceHealthy) failures.push("source_health_failed");
  if (!populationGuard.ok) failures.push(...populationGuard.issues);

  const normalised = findNormalisedProduct(simulation, officialId);
  if (!normalised) failures.push("candidate_absent_from_source");

  const inProduction = productionIndex.byOfficialId.has(officialId);
  if (inProduction) failures.push("candidate_already_in_production");

  let proposalRecord = null;
  if (sourceHealthy) {
    const proposal = buildSilverseaWeeklyMaintenanceProposal({
      simulation,
      productionIndex,
      cruiseLine,
      today
    });
    proposalRecord = proposal.records.find(
      (r) => String(r.official_sailing_id).toUpperCase() === officialId
    );
    if (!proposalRecord || proposalRecord.classification !== MAINTENANCE_CLASSIFICATION.INSERT_ELIGIBLE) {
      failures.push(`classification_${proposalRecord?.classification || "missing"}`);
    }
  }

  if (normalised) {
    const raw = normalised.raw || {};
    if (!isClassic(raw)) failures.push("not_classic");
    if (isExpedition(raw)) failures.push("is_expedition");
    if (raw.deferred_special_voyage || isComboSegmentProduct(raw)) failures.push("deferred_special");
    const bucket = classifyExclusiveBucket(normalised, today, productionIndex.byOfficialId);
    if (bucket !== "classic_production_eligible") failures.push(`bucket_${bucket}`);
  }

  let candidate = null;
  let insertPayload = null;
  let itinerary_ports = [];
  if (normalised && failures.length === 0) {
    candidate = buildSilverseaUpsertCandidate(normalised, cruiseLine);
    if (!candidate) failures.push("candidate_null");
    else {
      insertPayload = buildM2InsertPayload(candidate);
      itinerary_ports = normalizeStoredPorts(insertPayload.itinerary_ports);
      if (!Array.isArray(insertPayload.itinerary_ports)) failures.push("insert_payload_missing_ports");
      if (itinerary_ports.length === 0) failures.push("itinerary_ports_empty");
    }
  }

  const inventory = classifySilverseaOfficialInventory(productionIndex.rows);

  return {
    ok: failures.length === 0,
    failures,
    sourceHealthy,
    populationGuard,
    normalised,
    proposalRecord,
    candidate,
    insertPayload,
    itinerary_ports,
    inventory,
    summary: simulation?.summary || null,
    health: simulation?.health || null
  };
}

function verifyFixtureAgainstPreflight(fixture, preflight) {
  const issues = [];
  if (fixture.official_sailing_id !== CANARY_OFFICIAL_ID) issues.push("wrong_official_id");
  if (fixture.fixture_hash !== hashFixtureContent({
    official_sailing_id: fixture.official_sailing_id,
    candidate: fixture.candidate,
    insert_payload: fixture.insert_payload,
    itinerary_ports: fixture.itinerary_ports,
    source_snapshot_fingerprint: fixture.source_snapshot_fingerprint
  })) {
    issues.push("fixture_hash_mismatch");
  }
  if (!portsArrayEqual(fixture.itinerary_ports, preflight.itinerary_ports)) issues.push("ports_mismatch");
  return { ok: issues.length === 0, issues };
}

async function applyM2InsertOnly(sb, { candidate, runId }) {
  const stats = { new: 0, upserted_active: 0, cruises_inserted: 0, cruises_updated: 0 };
  const productKey = String(candidate.official_sailing_id).toUpperCase();
  const freshExisting =
    (
      await sb(
        `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
          candidate.cruise_line_id
        )}&official_sailing_id=eq.${encodeURIComponent(productKey)}&select=id,official_sailing_id,status&limit=1`
      )
    )?.[0] || null;
  if (freshExisting?.official_sailing_id) {
    return {
      ok: false,
      reason: "duplicate_before_insert",
      stats: { attempted: 1, inserted: 0, updated: 0, failed: 0, duplicate_skips: 1 },
      write_details: [{ official_sailing_id: productKey, duplicate: true, discovered_cruise_id: freshExisting.id }]
    };
  }

  const result = await upsertCandidateRecord(candidate, stats, {
    matchPolicy: "official_sailing_id_only",
    syncDestinationLinks: false,
    prevRecord: null
  });

  if (!result.created) {
    return {
      ok: false,
      reason: "insert_did_not_create",
      stats: { attempted: 1, inserted: 0, updated: 1, failed: 0 },
      write_details: [{ official_sailing_id: productKey, created: false, discovered_cruise_id: result.row?.id || null }]
    };
  }

  return {
    ok: true,
    stats: { attempted: 1, inserted: 1, updated: 0, failed: 0, duplicate_skips: 0 },
    write_details: [
      {
        official_sailing_id: productKey,
        created: true,
        discovered_cruise_id: result.row?.id || null,
        result_action: "inserted"
      }
    ],
    row: result.row
  };
}

function compareInsertedRowToFixture(row, fixture) {
  const issues = [];
  const expected = fixture.insert_payload;
  const fields = [
    "official_sailing_id",
    "cruise_line_id",
    "ship_id",
    "departure_date",
    "return_date",
    "nights",
    "departure_port",
    "destination_id",
    "official_url",
    "itinerary",
    "status"
  ];
  for (const field of fields) {
    const a = row[field];
    const b = expected[field];
    if (JSON.stringify(a) !== JSON.stringify(b)) issues.push(`field_${field}`);
  }
  if (!portsArrayEqual(row.itinerary_ports, fixture.itinerary_ports)) issues.push("itinerary_ports");
  if (!compareSemanticRawExtract(row.raw_extract, fixture.candidate.raw_extract)) {
    issues.push("raw_extract_business");
  }
  if (String(row.official_sailing_id).toUpperCase() !== CANARY_OFFICIAL_ID) issues.push("official_id");
  return { ok: issues.length === 0, issues };
}

async function verifyM2Protection({
  sb,
  lineId,
  beforeSnapshot,
  afterRows,
  targetOfficialId = CANARY_OFFICIAL_ID,
  today
}) {
  const targetId = String(targetOfficialId).toUpperCase();
  const beforeOfficial = beforeSnapshot.officialRows || [];
  const afterOfficial = afterRows.filter((r) => r.official_sailing_id);
  const inserted = afterOfficial.filter((r) => String(r.official_sailing_id).toUpperCase() === targetId);
  const preExistingBefore = beforeOfficial.filter(
    (r) => String(r.official_sailing_id).toUpperCase() !== targetId
  );
  const preExistingAfter = afterOfficial.filter(
    (r) => String(r.official_sailing_id).toUpperCase() !== targetId
  );

  const classicBefore = preExistingBefore.filter(isClassicStoredOfficialRow);
  const classicAfter = preExistingAfter.filter(isClassicStoredOfficialRow);
  const expeditionBefore = beforeOfficial.filter(isExpeditionStoredOfficialRow);
  const expeditionAfter = afterOfficial.filter(isExpeditionStoredOfficialRow);
  const legacyBefore = beforeSnapshot.legacyRows || [];
  const legacyAfter = afterRows.filter((r) => !r.official_sailing_id);

  const classicProtection = verifyProtectionSnapshots(
    snapshotProtectionRows(classicBefore, new Set()),
    classicAfter,
    new Set(),
    { perthToday: today }
  );
  const expeditionProtection = verifyProtectionSnapshots(
    snapshotProtectionRows(expeditionBefore, new Set()),
    expeditionAfter,
    new Set(),
    { perthToday: today }
  );

  const legacyOk =
    legacyBefore.length === legacyAfter.length &&
    legacyBefore.every((b) => {
      const a = legacyAfter.find((r) => r.id === b.id);
      return a && a.status === b.status && a.official_sailing_id === b.official_sailing_id;
    });

  const duplicateIds = afterOfficial
    .map((r) => String(r.official_sailing_id).toUpperCase())
    .filter((id, i, arr) => arr.indexOf(id) !== i);

  return {
    inserted_count: inserted.length,
    duplicate_official_ids: duplicateIds,
    classic_protection: classicProtection,
    expedition_protection: expeditionProtection,
    legacy_ok: legacyOk,
    ok:
      inserted.length === 1 &&
      duplicateIds.length === 0 &&
      classicProtection.ok &&
      expeditionProtection.ok &&
      legacyOk
  };
}

function proveRepeatInsertBlocked(productionIndex) {
  const present = productionIndex.byOfficialId.has(CANARY_OFFICIAL_ID);
  return { ok: present, reason: present ? "production_identity_present_blocks_preflight" : "would_allow" };
}

function buildM2RollbackManifest({ runId, fixture, productionBefore, insertedUuid = null }) {
  return buildPreWriteRollbackManifest({
    runId,
    fixturePath: M2_FIXTURE_REL,
    operation: M2_OPERATION,
    lineSlug: LINE_SLUG,
    cruiseLineId: fixture.candidate.cruise_line_id,
    officialSailingIds: [CANARY_OFFICIAL_ID],
    expectedInserts: EXPECTED_INSERTS,
    expectedUpdates: 0,
    writeCeiling: 1,
    productionBefore,
    sourceSnapshot: {
      fingerprint: fixture.source_snapshot_fingerprint,
      timestamp: fixture.source_snapshot_timestamp
    },
    controlledBatch: fixture.controlled_batch
  });
}

module.exports = {
  CANARY_OFFICIAL_ID,
  M2_FIXTURE_REL,
  M2_OPERATION,
  M2_APPLY_CONFIRMATION_TOKEN,
  EXPECTED_INSERTS,
  ADAPTER_ID,
  ADAPTER_VERSION,
  hashFixtureContent,
  findNormalisedProduct,
  buildM2ControlledBatchMarker,
  enrichCandidateForM2,
  buildM2InsertPayload,
  buildM2CanaryFixture,
  validateM2Preflight,
  verifyFixtureAgainstPreflight,
  applyM2InsertOnly,
  compareInsertedRowToFixture,
  verifyM2Protection,
  proveRepeatInsertBlocked,
  buildM2RollbackManifest,
  buildAuthoritativeVerificationResult
};
