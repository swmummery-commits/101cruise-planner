/**
 * Silversea M3 — controlled weekly-maintenance UPDATE canary (exactly SL270927009).
 */

const crypto = require("crypto");
const {
  buildSilverseaWeeklyMaintenanceProposal,
  diffMaintainableFields,
  buildExpectedMaintenanceSnapshot,
  compareSemanticRawExtract
} = require("./silversea-weekly-maintenance-proposal");
const {
  MAINTENANCE_CLASSIFICATION,
  IMMUTABLE_FIELDS,
  MAINTAINABLE_FIELDS,
  assessSourcePopulationAnomaly,
  snapshotFingerprint,
  evaluateItineraryShrinkGuard,
  evaluateItineraryReorderGuard,
  evaluateItineraryPortsUpdateSafety
} = require("./silversea-weekly-maintenance-policy");
const {
  isClassicStoredOfficialRow,
  isExpeditionStoredOfficialRow,
  isClassicOfficialId
} = require("./silversea-classic-itinerary-ports-backfill");
const {
  snapshotProtectionRows,
  verifyProtectionSnapshots,
  portsArrayEqual,
  normalizeStoredPorts,
  snapshotComparableFields,
  compareNonWhitelistSnapshots
} = require("./silversea-expedition-itinerary-ports-backfill");
const { isClassic, isExpedition } = require("./silversea-controlled-batch");
const { buildPreWriteRollbackManifest } = require("./cruise-discovery-controlled-production-run");
const { LINE_SLUG } = require("./silversea-discovery-adapter");

const CANARY_OFFICIAL_ID = "SL270927009";
const M2_INSERT_CANARY_ID = "WH281005017";
const M1_SOURCE_ABSENCE_ID = "SN280222C25";
const UPDATE_UNSAFE_GUARD_IDS = Object.freeze([
  "WH271121011",
  "WH271202011",
  "WH280329011",
  "WH281126C27",
  "WH281126010"
]);
const M3_FIXTURE_REL = "scripts/fixtures/silversea/m3-maintenance-update-canary-SL270927009.json";
const M3_OPERATION = "silversea_m3_maintenance_update_canary";
const M3_APPLY_CONFIRMATION_TOKEN = "SILVERSEA-M3-MAINTENANCE-UPDATE-CANARY";
const EXPECTED_UPDATES = 1;

function stableJson(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(stableJson);
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableJson(value[key]);
  return out;
}

function hashFixtureContent(obj) {
  const normalized = JSON.parse(JSON.stringify(stableJson(obj)));
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function assignPersistedFixtureHash(fixture) {
  const persisted = JSON.parse(
    JSON.stringify({
      official_sailing_id: fixture.official_sailing_id,
      production_uuid: fixture.production_uuid,
      update_allowlist: fixture.update_allowlist,
      before: fixture.before,
      after: fixture.after,
      immutable_fingerprint: fixture.immutable_fingerprint,
      source_snapshot_fingerprint: fixture.source_snapshot_fingerprint
    })
  );
  fixture.fixture_hash = hashFixtureContent(persisted);
  return fixture;
}

function buildImmutableFingerprint(row) {
  const out = {};
  for (const field of IMMUTABLE_FIELDS) out[field] = row?.[field] ?? null;
  return out;
}

function findProposalRecord(proposal, officialId = CANARY_OFFICIAL_ID) {
  return (proposal?.records || []).find(
    (r) => String(r.official_sailing_id).toUpperCase() === String(officialId).toUpperCase()
  );
}

function findNormalisedProduct(simulation, officialId = CANARY_OFFICIAL_ID) {
  return (simulation?.products || []).find(
    (p) => String(p.official_sailing_id || "").toUpperCase() === String(officialId).toUpperCase()
  );
}

function evaluateM3Guards(productionRow, proposalRecord, normalised) {
  const ctx = {
    storedPorts: productionRow?.itinerary_ports,
    expectedPorts: proposalRecord?.after?.itinerary_ports,
    raw: normalised?.raw || {},
    candidate: normalised?.candidate || {},
    productionRow
  };
  const shrink = evaluateItineraryShrinkGuard(ctx);
  const reorder = evaluateItineraryReorderGuard(ctx);
  const portsSafety = evaluateItineraryPortsUpdateSafety(ctx);
  return { shrink, reorder, portsSafety };
}

function buildFieldDiffTable(proposalRecord) {
  return (proposalRecord?.changed_fields || []).map((field) => ({
    field,
    before: proposalRecord?.before?.[field] ?? null,
    after: proposalRecord?.after?.[field] ?? null,
    maintainable: MAINTAINABLE_FIELDS.includes(field),
    deterministic: proposalRecord?.classification === MAINTENANCE_CLASSIFICATION.UPDATE_ELIGIBLE
  }));
}

async function validateM3Preflight({
  simulation,
  productionIndex,
  cruiseLine,
  today,
  fixture = null
}) {
  const failures = [];
  const officialId = CANARY_OFFICIAL_ID;
  const sourceHealthy = simulation?.ok === true && simulation?.health?.ok === true;
  const populationGuard = assessSourcePopulationAnomaly(simulation?.summary || {});

  if (!sourceHealthy) failures.push("source_health_failed");
  if (!populationGuard.ok) failures.push(...populationGuard.issues);

  const productionRow = productionIndex.byOfficialId.get(officialId) || null;
  if (!productionRow) failures.push("target_absent_from_production");
  else {
    const dupes = (productionIndex.rows || []).filter(
      (r) => String(r.official_sailing_id).toUpperCase() === officialId
    );
    if (dupes.length !== 1) failures.push(`production_count_${dupes.length}`);
  }

  const normalised = findNormalisedProduct(simulation, officialId);
  if (!normalised) failures.push("target_absent_from_source");

  let proposalRecord = null;
  let guards = null;
  if (sourceHealthy && productionRow) {
    const proposal = buildSilverseaWeeklyMaintenanceProposal({
      simulation,
      productionIndex,
      cruiseLine,
      today
    });
    proposalRecord = findProposalRecord(proposal, officialId);
    if (!proposalRecord) failures.push("proposal_record_missing");
    else if (proposalRecord.classification !== MAINTENANCE_CLASSIFICATION.UPDATE_ELIGIBLE) {
      failures.push(`classification_${proposalRecord.classification}`);
    }
    if (normalised) {
      guards = evaluateM3Guards(productionRow, proposalRecord, normalised);
      if (proposalRecord?.changed_fields?.includes("itinerary_ports")) {
        if (!guards.shrink.pass) failures.push(`shrink_guard_${guards.shrink.reason}`);
        if (!guards.reorder.pass && !guards.reorder.reorder_only) {
          failures.push(`reorder_guard_${guards.reorder.reason}`);
        }
        if (!guards.portsSafety.eligible) failures.push(`ports_safety_${guards.portsSafety.guard}`);
      }
    }
    if (productionRow && normalised) {
      const raw = normalised.raw || {};
      if (!isClassic(raw)) failures.push("not_classic");
      if (isExpedition(raw)) failures.push("is_expedition");
      if (raw.deferred_special_voyage) failures.push("deferred_special");
    }
  }

  const updateAllowlist = proposalRecord?.changed_fields?.slice() || [];
  const immutableIssues = [];
  if (productionRow && proposalRecord) {
    for (const field of IMMUTABLE_FIELDS) {
      if (updateAllowlist.includes(field)) immutableIssues.push(field);
    }
  }

  if (immutableIssues.length) failures.push(`immutable_field_change_${immutableIssues.join(",")}`);

  let fixtureCheck = { ok: true, issues: [] };
  if (fixture && proposalRecord && productionRow) {
    fixtureCheck = verifyFixtureAgainstPreflight(fixture, { proposalRecord, productionRow, guards });
    if (!fixtureCheck.ok) failures.push(...fixtureCheck.issues);
  }

  const inventory = {
    total: productionIndex.rows.length,
    classic_stored: productionIndex.rows.filter(isClassicStoredOfficialRow).length,
    expedition_stored: productionIndex.rows.filter(isExpeditionStoredOfficialRow).length,
    legacy: productionIndex.rows.filter((r) => !r.official_sailing_id).length
  };

  return {
    ok: failures.length === 0,
    failures,
    sourceHealthy,
    populationGuard,
    productionRow,
    normalised,
    proposalRecord,
    guards,
    updateAllowlist,
    fieldDiffTable: proposalRecord ? buildFieldDiffTable(proposalRecord) : [],
    inventory,
    immutableIssues,
    fixtureCheck
  };
}

function verifyFixtureAgainstPreflight(fixture, { proposalRecord, productionRow, guards }) {
  const issues = [];
  if (fixture.official_sailing_id !== CANARY_OFFICIAL_ID) issues.push("wrong_official_id");
  if (fixture.production_uuid !== productionRow.id) issues.push("uuid_mismatch");
  if (fixture.fixture_hash !== hashFixtureContent({
    official_sailing_id: fixture.official_sailing_id,
    production_uuid: fixture.production_uuid,
    update_allowlist: fixture.update_allowlist,
    before: fixture.before,
    after: fixture.after,
    immutable_fingerprint: fixture.immutable_fingerprint,
    source_snapshot_fingerprint: fixture.source_snapshot_fingerprint
  })) {
    issues.push("fixture_hash_mismatch");
  }
  for (const field of fixture.update_allowlist || []) {
    const prodVal = field === "itinerary_ports" ? normalizeStoredPorts(productionRow[field]) : productionRow[field];
    const beforeVal = field === "itinerary_ports" ? normalizeStoredPorts(fixture.before[field]) : fixture.before[field];
    if (JSON.stringify(prodVal) !== JSON.stringify(beforeVal)) issues.push(`frozen_before_mismatch_${field}`);
  }
  const propFields = (proposalRecord.changed_fields || []).slice().sort();
  const fixFields = (fixture.update_allowlist || []).slice().sort();
  if (JSON.stringify(propFields) !== JSON.stringify(fixFields)) issues.push("allowlist_mismatch");
  return { ok: issues.length === 0, issues };
}

function verifyFrozenBeforeMatch(productionRow, fixture) {
  const issues = [];
  if (productionRow.id !== fixture.production_uuid) issues.push("uuid");
  if (String(productionRow.official_sailing_id).toUpperCase() !== CANARY_OFFICIAL_ID) issues.push("official_id");
  for (const field of fixture.update_allowlist || []) {
    const prodVal = field === "itinerary_ports" ? normalizeStoredPorts(productionRow[field]) : productionRow[field];
    const beforeVal = field === "itinerary_ports" ? normalizeStoredPorts(fixture.before[field]) : fixture.before[field];
    if (field === "raw_extract") {
      if (!compareSemanticRawExtract(prodVal, beforeVal)) issues.push("raw_extract_before");
    } else if (JSON.stringify(prodVal) !== JSON.stringify(beforeVal)) {
      issues.push(field);
    }
  }
  const imm = buildImmutableFingerprint(productionRow);
  if (JSON.stringify(imm) !== JSON.stringify(fixture.immutable_fingerprint)) issues.push("immutable_fingerprint");
  return { ok: issues.length === 0, issues };
}

function buildM3CanaryFixture({
  runId,
  simulation,
  productionRow,
  proposalRecord,
  guards,
  cruiseLine,
  productionBefore,
  sourceHealth
}) {
  const updateAllowlist = (proposalRecord.changed_fields || []).slice();
  const before = {};
  const after = {};
  for (const field of updateAllowlist) {
    before[field] = proposalRecord.before[field];
    after[field] = proposalRecord.after[field];
  }
  const fixture = {
    phase: "M3",
    official_sailing_id: CANARY_OFFICIAL_ID,
    production_uuid: productionRow.id,
    source_snapshot_fingerprint: snapshotFingerprint({
      health: simulation.health,
      summary: simulation.summary,
      fetched_at: simulation.fetch_result?.fetched_at || null
    }),
    source_snapshot_timestamp: simulation.fetch_result?.fetched_at || new Date().toISOString(),
    source_health: sourceHealth,
    classification: proposalRecord.classification,
    eligibility_reasons: proposalRecord.reason_codes || [],
    update_allowlist: updateAllowlist,
    before,
    after,
    immutable_fingerprint: buildImmutableFingerprint(productionRow),
    guards: {
      shrink: guards?.shrink || null,
      reorder: guards?.reorder || null,
      ports_safety: guards?.portsSafety || null
    },
    production_before: productionBefore,
    lifecycle_status: productionRow.status,
    fixture_hash: null
  };
  return assignPersistedFixtureHash(fixture);
}

async function applyM3UpdateOnly(supabase, { fixture, runId }) {
  const stats = { attempted: 1, updated: 0, skipped: 0, failed: 0, inserted: 0 };
  const uuid = fixture.production_uuid;
  const officialId = CANARY_OFFICIAL_ID;

  const currentRows = await supabase(
    `discovered_cruises?id=eq.${encodeURIComponent(uuid)}&official_sailing_id=eq.${encodeURIComponent(
      officialId
    )}&select=*&limit=1`
  );
  const current = currentRows?.[0] || null;
  if (!current) {
    return {
      ok: false,
      reason: "target_missing_under_precondition",
      stats: { ...stats, failed: 1 },
      write_details: [{ production_uuid: uuid, official_sailing_id: officialId, result: "missing" }]
    };
  }

  const beforeCheck = verifyFrozenBeforeMatch(current, fixture);
  if (!beforeCheck.ok) {
    return {
      ok: false,
      reason: "frozen_before_mismatch",
      stats: { ...stats, failed: 1, skipped: 1 },
      write_details: [{ production_uuid: uuid, issues: beforeCheck.issues }]
    };
  }

  const beforeSnap = snapshotComparableFields(current);
  const patchBody = {};
  for (const field of fixture.update_allowlist) {
    patchBody[field] =
      field === "itinerary_ports" ? normalizeStoredPorts(fixture.after[field]) : fixture.after[field];
  }

  const patched = await supabase(
    `discovered_cruises?id=eq.${encodeURIComponent(uuid)}&official_sailing_id=eq.${encodeURIComponent(officialId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patchBody)
    }
  );
  const updatedRow = patched?.[0] || null;
  if (!updatedRow) {
    return {
      ok: false,
      reason: "patch_no_row",
      stats: { ...stats, failed: 1 },
      write_details: [{ production_uuid: uuid, result: "patch_no_row" }]
    };
  }

  const allowedChanged = new Set(fixture.update_allowlist);
  const afterSnap = snapshotComparableFields(updatedRow);
  const nonAllowed = [];
  for (const field of [...MAINTAINABLE_FIELDS, "raw_extract"]) {
    if (allowedChanged.has(field)) continue;
    const beforeVal = beforeSnap[field];
    const afterVal = afterSnap[field];
    if (field === "raw_extract") {
      if (!compareSemanticRawExtract(beforeVal, afterVal)) nonAllowed.push(field);
    } else if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      nonAllowed.push(field);
    }
  }
  if (nonAllowed.length) {
    return {
      ok: false,
      reason: "non_allowlist_changed",
      stats: { ...stats, failed: 1 },
      write_details: [{ production_uuid: uuid, changed: nonAllowed }],
      row: updatedRow
    };
  }

  for (const field of fixture.update_allowlist) {
    const expected =
      field === "itinerary_ports" ? normalizeStoredPorts(fixture.after[field]) : fixture.after[field];
    const actual =
      field === "itinerary_ports" ? normalizeStoredPorts(updatedRow[field]) : updatedRow[field];
    if (field === "raw_extract") {
      if (!compareSemanticRawExtract(actual, expected)) {
        return {
          ok: false,
          reason: `after_mismatch_${field}`,
          stats: { ...stats, failed: 1 },
          write_details: [{ production_uuid: uuid, field }],
          row: updatedRow
        };
      }
    } else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return {
        ok: false,
        reason: `after_mismatch_${field}`,
        stats: { ...stats, failed: 1 },
        write_details: [{ production_uuid: uuid, field }],
        row: updatedRow
      };
    }
  }

  stats.updated = 1;
  return {
    ok: true,
    stats,
    write_details: [{ production_uuid: uuid, official_sailing_id: officialId, result: "updated" }],
    row: updatedRow
  };
}

function compareUpdatedRowToFixture(row, fixture) {
  const issues = [];
  for (const field of IMMUTABLE_FIELDS) {
    if (row[field] !== fixture.immutable_fingerprint[field]) issues.push(`immutable_${field}`);
  }
  for (const field of fixture.update_allowlist) {
    const expected =
      field === "itinerary_ports" ? normalizeStoredPorts(fixture.after[field]) : fixture.after[field];
    const actual = field === "itinerary_ports" ? normalizeStoredPorts(row[field]) : row[field];
    if (field === "raw_extract") {
      if (!compareSemanticRawExtract(actual, expected)) issues.push("raw_extract");
    } else if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push(field);
  }
  return { ok: issues.length === 0, issues };
}

async function verifyM3Protection({
  beforeSnapshot,
  afterRows,
  targetOfficialId = CANARY_OFFICIAL_ID,
  targetUuid,
  today,
  unsafeOfficialIds = UPDATE_UNSAFE_GUARD_IDS
}) {
  const targetId = String(targetOfficialId).toUpperCase();
  const beforeOfficial = beforeSnapshot.officialRows || [];
  const afterOfficial = afterRows.filter((r) => r.official_sailing_id);

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

  const m2Before = beforeOfficial.find((r) => String(r.official_sailing_id).toUpperCase() === M2_INSERT_CANARY_ID);
  const m2After = afterOfficial.find((r) => String(r.official_sailing_id).toUpperCase() === M2_INSERT_CANARY_ID);
  const m2Protected =
    !m2Before ||
    verifyProtectionSnapshots(snapshotProtectionRows([m2Before], new Set()), [m2After], new Set(), {
      perthToday: today
    }).ok;

  const unsafeIssues = [];
  for (const unsafeId of unsafeOfficialIds) {
    const b = beforeOfficial.find((r) => String(r.official_sailing_id).toUpperCase() === unsafeId);
    const a = afterOfficial.find((r) => String(r.official_sailing_id).toUpperCase() === unsafeId);
    if (b && a) {
      const check = verifyProtectionSnapshots(snapshotProtectionRows([b], new Set()), [a], new Set(), {
        perthToday: today
      });
      if (!check.ok) unsafeIssues.push({ official_sailing_id: unsafeId, issues: check.issues });
    }
  }

  const legacyOk =
    legacyBefore.length === legacyAfter.length &&
    legacyBefore.every((b) => {
      const a = legacyAfter.find((r) => r.id === b.id);
      return a && verifyProtectionSnapshots(snapshotProtectionRows([b], new Set()), [a], new Set(), { perthToday: today }).ok;
    });

  const duplicateIds = afterOfficial
    .map((r) => String(r.official_sailing_id).toUpperCase())
    .filter((id, i, arr) => arr.indexOf(id) !== i);

  const targetRows = afterOfficial.filter((r) => String(r.official_sailing_id).toUpperCase() === targetId);
  const targetCountOk = targetRows.length === 1 && targetRows[0]?.id === targetUuid;

  return {
    target_count_ok: targetCountOk,
    duplicate_official_ids: duplicateIds,
    classic_protection: classicProtection,
    expedition_protection: expeditionProtection,
    m2_canary_protected: m2Protected,
    unsafe_update_protection: { ok: unsafeIssues.length === 0, issues: unsafeIssues },
    legacy_ok: legacyOk,
    ok:
      targetCountOk &&
      duplicateIds.length === 0 &&
      classicProtection.ok &&
      expeditionProtection.ok &&
      m2Protected &&
      unsafeIssues.length === 0 &&
      legacyOk
  };
}

function proveRepeatUpdateBlocked(productionIndex, fixture) {
  const row = productionIndex.byOfficialId.get(CANARY_OFFICIAL_ID);
  if (!row) return { ok: false, reason: "target_missing" };
  const frozen = verifyFrozenBeforeMatch(row, fixture);
  if (frozen.ok) return { ok: false, reason: "frozen_before_still_matches_would_allow_update" };
  return { ok: true, reason: "frozen_before_or_classification_blocks_repeat" };
}

function buildM3RollbackManifest({ runId, fixture, productionBefore }) {
  return {
    ...buildPreWriteRollbackManifest({
      runId,
      fixturePath: M3_FIXTURE_REL,
      operation: M3_OPERATION,
      lineSlug: LINE_SLUG,
      cruiseLineId: fixture.immutable_fingerprint?.cruise_line_id || null,
      officialSailingIds: [CANARY_OFFICIAL_ID],
      expectedInserts: 0,
      expectedUpdates: EXPECTED_UPDATES,
      writeCeiling: 1,
      productionBefore,
      sourceSnapshot: {
        fingerprint: fixture.source_snapshot_fingerprint,
        timestamp: fixture.source_snapshot_timestamp
      }
    }),
    expected_updates: EXPECTED_UPDATES,
    rollback_entries: [
      {
        production_uuid: fixture.production_uuid,
        official_sailing_id: CANARY_OFFICIAL_ID,
        before: fixture.before,
        after: fixture.after,
        update_allowlist: fixture.update_allowlist
      }
    ]
  };
}

module.exports = {
  CANARY_OFFICIAL_ID,
  M2_INSERT_CANARY_ID,
  M1_SOURCE_ABSENCE_ID,
  UPDATE_UNSAFE_GUARD_IDS,
  M3_FIXTURE_REL,
  M3_OPERATION,
  M3_APPLY_CONFIRMATION_TOKEN,
  EXPECTED_UPDATES,
  IMMUTABLE_FIELDS,
  MAINTAINABLE_FIELDS,
  hashFixtureContent,
  assignPersistedFixtureHash,
  validateM3Preflight,
  verifyFixtureAgainstPreflight,
  verifyFrozenBeforeMatch,
  buildM3CanaryFixture,
  applyM3UpdateOnly,
  compareUpdatedRowToFixture,
  verifyM3Protection,
  proveRepeatUpdateBlocked,
  buildM3RollbackManifest,
  buildImmutableFingerprint,
  evaluateM3Guards,
  findProposalRecord
};
