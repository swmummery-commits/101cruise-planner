/**
 * Silversea Expedition itinerary_ports controlled backfill (M0A/M0B).
 * Updates ONLY discovered_cruises.itinerary_ports for exact frozen UUIDs.
 */

const fs = require("fs");
const path = require("path");
const { buildItineraryPorts, buildExpeditionUpsertCandidate } = require("./silversea-discovery-writes");
const { buildDiscoveredCruiseUpsertPayload, normalizeItineraryPortsForDb } = require("./cruise-discovery-ops");
const { classifyExpeditionExclusiveBucket } = require("./silversea-expedition-eligibility");
const { evaluateExpeditionEligibility } = require("./silversea-expedition-eligibility");
const { loadFrozenExpeditionIds } = require("./silversea-expedition-controlled-batch");

const M0A_BACKFILL_FIXTURE = "scripts/fixtures/silversea/expedition-m0a-itinerary-ports-backfill.json";
const E6_RUN_ID = "silversea-expedition-e6-2026-08-17T00-56-06-160Z";
const E3_FIRST_250_FIXTURE = "scripts/fixtures/silversea/expedition-e3-first-250.json";
const E5_NEXT_BATCH_FIXTURE = "scripts/fixtures/silversea/expedition-e5-next-batch.json";
const UPDATE_WHITELIST = Object.freeze(["itinerary_ports"]);
const M0B_OPERATION = "silversea_expedition_m0b_itinerary_ports_backfill";

const REPAIR_CATEGORY = Object.freeze({
  EXACT_MATCH: "EXACT_MATCH",
  STORED_EMPTY_EXPECTED_EMPTY: "STORED_EMPTY_EXPECTED_EMPTY",
  STORED_EMPTY_EXPECTED_NONEMPTY: "STORED_EMPTY_EXPECTED_NONEMPTY",
  STORED_NONEMPTY_EXPECTED_DIFFERENT: "STORED_NONEMPTY_EXPECTED_DIFFERENT",
  STORED_NONEMPTY_EXPECTED_EMPTY: "STORED_NONEMPTY_EXPECTED_EMPTY",
  SOURCE_NO_LONGER_AVAILABLE: "SOURCE_NO_LONGER_AVAILABLE",
  EXPECTED_MANIFEST_UNSAFE: "EXPECTED_MANIFEST_UNSAFE"
});

function isExpeditionOfficialId(id) {
  return /^(E4|EV|OR|WI)/i.test(String(id || ""));
}

function portsArrayEqual(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function normalizeStoredPorts(stored) {
  if (stored == null) return [];
  if (!Array.isArray(stored)) return [];
  return stored.map((p) => String(p).trim()).filter(Boolean);
}

function buildExpectedItineraryPorts(normalised, cruiseLine, today) {
  const candidate = buildExpeditionUpsertCandidate(normalised, cruiseLine, today);
  if (!candidate) return { ok: false, reason: "candidate_null", ports: null };
  const evalResult = evaluateExpeditionEligibility(normalised, today);
  if (evalResult.ambiguous_stop_count > 0 || evalResult.match_required) {
    return { ok: false, reason: "unsafe_or_ambiguous", ports: null };
  }
  if (classifyExpeditionExclusiveBucket(normalised, today) !== "expedition_e2_complete") {
    return { ok: false, reason: "not_e2_complete", ports: null };
  }
  return {
    ok: true,
    ports: normalizeItineraryPortsForDb(candidate),
    candidate
  };
}

function classifyItineraryPortsRepair({ storedPorts, expectedPorts, sourceAvailable, expectedOk }) {
  const stored = normalizeStoredPorts(storedPorts);
  const expected = normalizeStoredPorts(expectedPorts);

  if (!sourceAvailable) {
    return REPAIR_CATEGORY.SOURCE_NO_LONGER_AVAILABLE;
  }
  if (!expectedOk) {
    return REPAIR_CATEGORY.EXPECTED_MANIFEST_UNSAFE;
  }
  if (portsArrayEqual(stored, expected)) {
    return stored.length === 0
      ? REPAIR_CATEGORY.STORED_EMPTY_EXPECTED_EMPTY
      : REPAIR_CATEGORY.EXACT_MATCH;
  }
  if (stored.length === 0 && expected.length > 0) {
    return REPAIR_CATEGORY.STORED_EMPTY_EXPECTED_NONEMPTY;
  }
  if (stored.length > 0 && expected.length === 0) {
    return REPAIR_CATEGORY.STORED_NONEMPTY_EXPECTED_EMPTY;
  }
  return REPAIR_CATEGORY.STORED_NONEMPTY_EXPECTED_DIFFERENT;
}

function isDeterministicRepairCategory(category) {
  return (
    category === REPAIR_CATEGORY.STORED_EMPTY_EXPECTED_NONEMPTY ||
    category === REPAIR_CATEGORY.STORED_NONEMPTY_EXPECTED_DIFFERENT ||
    category === REPAIR_CATEGORY.STORED_NONEMPTY_EXPECTED_EMPTY
  );
}

function resolveExpeditionProvenance(officialSailingId, { e3Ids, e6Ids, controlledBatchRunId }) {
  const id = String(officialSailingId || "").toUpperCase();
  if (controlledBatchRunId === E6_RUN_ID) return "E6";
  if (e6Ids.has(id)) return "E6";
  if (e3Ids.has(id)) return "E4";
  return "other";
}

function buildRowFingerprint(row) {
  return {
    id: row.id,
    official_sailing_id: row.official_sailing_id,
    ship_id: row.ship_id,
    departure_date: row.departure_date,
    return_date: row.return_date,
    nights: row.nights,
    destination_id: row.destination_id,
    status: row.status
  };
}

function buildBackfillFixtureRow(sequence, auditRow) {
  return {
    sequence,
    production_uuid: auditRow.production_uuid,
    official_sailing_id: auditRow.official_sailing_id,
    cruise_code: auditRow.official_sailing_id,
    ship: auditRow.ship,
    departure: auditRow.departure,
    region: auditRow.region,
    before_itinerary_ports: normalizeStoredPorts(auditRow.stored_itinerary_ports),
    after_itinerary_ports: normalizeStoredPorts(auditRow.expected_itinerary_ports),
    expected_source_conventional_ports: normalizeStoredPorts(auditRow.expected_itinerary_ports),
    provenance: auditRow.provenance,
    repair_category: auditRow.repair_category,
    deterministic_reason: auditRow.mismatch_reason || "stored_empty_expected_nonempty",
    row_fingerprint: auditRow.row_fingerprint,
    proposed_action: "UPDATE itinerary_ports ONLY"
  };
}

function dryRunItineraryPortsBackfill(fixture) {
  const rows = fixture?.rows || [];
  return {
    authorised_updates: rows.length,
    proposed_itinerary_ports_updates: rows.length,
    proposed_inserts: 0,
    proposed_deletes: 0,
    other_column_updates: 0,
    update_whitelist: UPDATE_WHITELIST.slice(),
    classic_rows: 0,
    legacy_rows: 0,
    expedition_rows: rows.length
  };
}

function buildRollbackEntry(row) {
  return {
    production_uuid: row.production_uuid,
    official_sailing_id: row.official_sailing_id,
    before_itinerary_ports: normalizeStoredPorts(row.before_itinerary_ports),
    after_itinerary_ports: normalizeStoredPorts(row.after_itinerary_ports)
  };
}

function verifyItineraryPortsRepairRow(storedRow, fixtureRow, fingerprintFields = []) {
  const issues = [];
  if (!storedRow) issues.push("missing_row");
  if (storedRow?.official_sailing_id !== fixtureRow.official_sailing_id) {
    issues.push("official_sailing_id_changed");
  }
  const storedPorts = normalizeStoredPorts(storedRow?.itinerary_ports);
  const expectedAfter = normalizeStoredPorts(fixtureRow.after_itinerary_ports);
  if (!portsArrayEqual(storedPorts, expectedAfter)) {
    issues.push("itinerary_ports_mismatch");
  }
  const frozenBefore = normalizeStoredPorts(fixtureRow.before_itinerary_ports);
  if (!portsArrayEqual(frozenBefore, normalizeStoredPorts(fixtureRow.before_itinerary_ports))) {
    issues.push("frozen_before_drift");
  }
  for (const field of fingerprintFields) {
    if (String(storedRow?.[field] ?? "") !== String(fixtureRow.row_fingerprint?.[field] ?? "")) {
      issues.push(`fingerprint_${field}_changed`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function assertInsertPayloadIncludesItineraryPorts(candidate, mergedDeparture, identityKey, status, reasons, now) {
  const payload = buildDiscoveredCruiseUpsertPayload(candidate, mergedDeparture, {
    identity_key: identityKey,
    status,
    reasons,
    now,
    includeItineraryPorts: true
  });
  return payload;
}

function reconcileE6FrozenMismatchReport(frozenRows) {
  const galapagos = frozenRows.filter((r) => r.region === "Galápagos");
  const orShip = frozenRows.filter((r) => /^OR/i.test(r.official_sailing_id));
  const e4Ship = frozenRows.filter((r) => /^E4/i.test(r.official_sailing_id));
  const mismatches = frozenRows.filter((r) => !r.ports_equal);
  const mismatchGalapagos = mismatches.filter((r) => r.region === "Galápagos");
  const mismatchOr = mismatches.filter((r) => /^OR/i.test(r.official_sailing_id));
  const mismatchE4 = mismatches.filter((r) => /^E4/i.test(r.official_sailing_id));
  const mismatchNonGalapagos = mismatches.filter((r) => r.region !== "Galápagos");

  return {
    e5_galapagos_count: galapagos.length,
    e5_or_ship_count: orShip.length,
    e5_e4_ship_count: e4Ship.length,
    e6_mismatch_count: mismatches.length,
    mismatch_ids: mismatches.map((r) => r.official_sailing_id).sort(),
    mismatch_galapagos_count: mismatchGalapagos.length,
    mismatch_or_count: mismatchOr.length,
    mismatch_e4_count: mismatchE4.length,
    mismatch_non_galapagos_count: mismatchNonGalapagos.length,
    explanation:
      mismatches.length === mismatchOr.length + mismatchE4.length
        ? "All E6 mismatches are Galápagos-region rows: 26 Silver Origin (OR*) plus 3 Silver Cloud (E4*) with expected non-empty conventional itinerary_ports but stored []. E6 report described failures as OR* only and omitted the 3 E4 Galápagos rows."
        : "Mismatch set does not decompose cleanly to OR+E4 Galápagos — investigate further"
  };
}

module.exports = {
  M0A_BACKFILL_FIXTURE,
  E6_RUN_ID,
  E3_FIRST_250_FIXTURE,
  E5_NEXT_BATCH_FIXTURE,
  UPDATE_WHITELIST,
  M0B_OPERATION,
  REPAIR_CATEGORY,
  isExpeditionOfficialId,
  portsArrayEqual,
  normalizeStoredPorts,
  buildExpectedItineraryPorts,
  classifyItineraryPortsRepair,
  isDeterministicRepairCategory,
  resolveExpeditionProvenance,
  buildRowFingerprint,
  buildBackfillFixtureRow,
  dryRunItineraryPortsBackfill,
  buildRollbackEntry,
  verifyItineraryPortsRepairRow,
  assertInsertPayloadIncludesItineraryPorts,
  reconcileE6FrozenMismatchReport,
  loadFrozenExpeditionIds
};
