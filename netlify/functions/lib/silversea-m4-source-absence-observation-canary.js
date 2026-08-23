/**
 * Silversea M4 — controlled source-absence observation canary (exactly SN280222C25).
 */

const {
  OBSERVATION_TYPE_SOURCE_ABSENT,
  OBSERVATION_STATUS_OBSERVING,
  SOURCE_ABSENCE_FIXTURE_ID,
  QUARANTINE_THRESHOLD,
  observationPeriodKey,
  buildSourceSnapshotFingerprint,
  isOfficialIdInSource,
  classifySourceAbsenceCandidate,
  computeExpectedAdvancement,
  loadObservationState,
  deriveQuarantineProposal,
  advanceSourceAbsenceObservation,
  hashFixtureContent
} = require("./silversea-source-absence-observation");
const {
  MAINTENANCE_CLASSIFICATION,
  assessSourcePopulationAnomaly,
  snapshotFingerprint
} = require("./silversea-weekly-maintenance-policy");
const {
  snapshotProtectionRows,
  verifyProtectionSnapshots,
  snapshotComparableFields
} = require("./silversea-expedition-itinerary-ports-backfill");
const { M2_INSERT_CANARY_ID } = require("./silversea-m3-maintenance-update-canary");

const CANARY_OFFICIAL_ID = SOURCE_ABSENCE_FIXTURE_ID;
const OTHER_SOURCE_ABSENCE_ID = "DA280115C21";
const M3_UPDATE_CANARY_ID = "SL270927009";
const M4_FIXTURE_REL = "scripts/fixtures/silversea/m4-source-absence-observation-canary-SN280222C25.json";
const M4_OPERATION = "silversea_m4_source_absence_observation_canary";
const M4_APPLY_CONFIRMATION_TOKEN = "SILVERSEA-M4-SOURCE-ABSENCE-OBSERVATION-CANARY";

function assignPersistedFixtureHash(fixture) {
  const persisted = JSON.parse(
    JSON.stringify({
      official_sailing_id: fixture.official_sailing_id,
      production_uuid: fixture.production_uuid,
      source_snapshot_fingerprint: fixture.source_snapshot_fingerprint,
      observation_period_key: fixture.observation_period_key,
      prior_count: fixture.prior_count,
      expected_new_count: fixture.expected_new_count
    })
  );
  fixture.fixture_hash = hashFixtureContent(persisted);
  return fixture;
}

async function validateM4Preflight({
  simulation,
  productionIndex,
  cruiseLine,
  today,
  fixture = null,
  existingState = null
}) {
  const failures = [];
  const sourceHealthy = simulation?.health?.ok === true;
  const populationGuard = assessSourcePopulationAnomaly(simulation?.summary || {}, simulation?.health || {});

  if (!sourceHealthy || !populationGuard.ok) failures.push("source_health_failed");

  const row = productionIndex.byOfficialId.get(CANARY_OFFICIAL_ID);
  if (!row) failures.push("target_absent_from_production");
  const dupes = (productionIndex.rows || []).filter(
    (r) => String(r.official_sailing_id).toUpperCase() === CANARY_OFFICIAL_ID
  );
  if (dupes.length !== 1) failures.push("target_production_count_not_one");

  if (isOfficialIdInSource(simulation, CANARY_OFFICIAL_ID)) {
    failures.push("source_present_not_absent");
  }

  const candidate = row
    ? classifySourceAbsenceCandidate({ productionRow: row, simulation, today, previousObservations: {} })
    : null;

  if (candidate && candidate.classification !== MAINTENANCE_CLASSIFICATION.SOURCE_ABSENT_OBSERVATION) {
    failures.push(`classification_${candidate.classification || "unknown"}`);
  }

  const sourceSnapshotHash = buildSourceSnapshotFingerprint(simulation);
  const periodKey = observationPeriodKey(today);
  const advancement = computeExpectedAdvancement({
    existingState,
    sourceSnapshotHash,
    observationPeriodKey: periodKey,
    sourceHealthy
  });

  if (!advancement.ok) failures.push(advancement.reason || "advancement_blocked");
  if (advancement.idempotent && advancement.write_action === "none") {
    failures.push("snapshot_or_period_already_counted");
  }
  if (advancement.write_action === "none" && !advancement.idempotent) {
    failures.push("no_observation_write_planned");
  }

  if (fixture) {
    if (fixture.source_snapshot_fingerprint !== sourceSnapshotHash) {
      failures.push("fixture_source_fingerprint_mismatch");
    }
    if (fixture.expected_new_count !== advancement.new_count) {
      failures.push("fixture_expected_count_mismatch");
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    productionRow: row || null,
    candidate,
    sourceHealthy,
    populationGuard,
    sourceSnapshotHash,
    observationPeriodKey: periodKey,
    advancement,
    existingState
  };
}

function buildM4CanaryFixture({
  runId,
  simulation,
  productionRow,
  preflight,
  cruiseLine,
  productionBefore,
  existingState
}) {
  const fixture = {
    phase: "M4",
    official_sailing_id: CANARY_OFFICIAL_ID,
    production_uuid: productionRow.id,
    cruise_line_id: cruiseLine.id,
    source_snapshot_fingerprint: preflight.sourceSnapshotHash,
    source_snapshot_timestamp: simulation.fetch_result?.fetched_at || new Date().toISOString(),
    source_health: preflight.sourceHealthy ? "PASS" : "FAIL",
    source_presence: "ABSENT",
    observation_type: OBSERVATION_TYPE_SOURCE_ABSENT,
    observation_period_key: preflight.observationPeriodKey,
    lifecycle_status: productionRow.status,
    cutoff: preflight.candidate?.cutoff || null,
    secondary_product_context: preflight.candidate?.secondary_product_context || null,
    prior_count: preflight.advancement.prior_count,
    expected_new_count: preflight.advancement.new_count,
    expected_status: OBSERVATION_STATUS_OBSERVING,
    quarantine_eligible: preflight.advancement.quarantine_eligible === true,
    quarantine_proposal: preflight.advancement.quarantine_eligible ? "QUARANTINE_REVIEW_REQUIRED" : null,
    discovered_cruises_mutations_expected: 0,
    prior_observation_state: existingState,
    production_before: productionBefore,
    run_id: runId,
    fixture_hash: null
  };
  return assignPersistedFixtureHash(fixture);
}

function snapshotCruiseRow(row) {
  if (!row) return null;
  const fields = snapshotComparableFields(row);
  const out = {};
  for (const key of Object.keys(fields)) out[key] = row[key];
  out.id = row.id;
  out.official_sailing_id = row.official_sailing_id;
  out.status = row.status;
  return out;
}

function verifyCruiseRowUnchanged(beforeRow, afterRow) {
  const beforeSnap = snapshotProtectionRows([beforeRow], new Set());
  const check = verifyProtectionSnapshots(beforeSnap, [afterRow], new Set(), { perthToday: "2099-01-01" });
  return { ok: check.ok, issues: check.issues || [] };
}

async function applyM4ObservationOnly(supabase, { fixture, runId, cruiseLineId }) {
  const result = await advanceSourceAbsenceObservation(supabase, {
    cruiseLineId,
    officialSailingId: CANARY_OFFICIAL_ID,
    productionUuid: fixture.production_uuid,
    observationType: OBSERVATION_TYPE_SOURCE_ABSENT,
    sourceSnapshotHash: fixture.source_snapshot_fingerprint,
    sourceHealth: "healthy",
    observationPeriodKey: fixture.observation_period_key,
    runId,
    reasonCode: "healthy_source_miss",
    metadata: {
      phase: "M4",
      fixture_hash: fixture.fixture_hash,
      m4_canary: true
    }
  });

  const advanced = result?.advanced === true;
  return {
    ok: result?.ok === true && advanced,
    idempotent: result?.advanced === false,
    result,
    stats: {
      observation_inserts: result?.action === "inserted" ? 1 : 0,
      observation_updates: result?.action === "updated" ? 1 : 0,
      observation_writes: advanced ? 1 : 0,
      cruise_inserts: 0,
      cruise_updates: 0
    }
  };
}

function compareObservationToFixture(state, fixture) {
  const issues = [];
  if (!state) {
    issues.push("state_missing");
    return { ok: false, issues };
  }
  if (String(state.official_sailing_id).toUpperCase() !== CANARY_OFFICIAL_ID) issues.push("official_id");
  if (state.observation_type !== OBSERVATION_TYPE_SOURCE_ABSENT) issues.push("observation_type");
  if (state.consecutive_healthy_absence_count !== fixture.expected_new_count) {
    issues.push("consecutive_count");
  }
  if (state.last_counted_snapshot_hash !== fixture.source_snapshot_fingerprint) {
    issues.push("snapshot_hash");
  }
  if (state.status !== fixture.expected_status) issues.push("status");
  if (state.resolved_at != null) issues.push("resolved_at_set");
  if (fixture.quarantine_eligible && !deriveQuarantineProposal(state.consecutive_healthy_absence_count).eligible) {
    issues.push("quarantine_eligible");
  }
  if (!fixture.quarantine_eligible && deriveQuarantineProposal(state.consecutive_healthy_absence_count).eligible) {
    issues.push("unexpected_quarantine_eligible");
  }
  return { ok: issues.length === 0, issues };
}

function proveReplayIdempotent(preflight) {
  return {
    ok: preflight.failures?.includes("snapshot_or_period_already_counted") === true,
    reason: "snapshot_or_period_already_counted"
  };
}

module.exports = {
  CANARY_OFFICIAL_ID,
  OTHER_SOURCE_ABSENCE_ID,
  M3_UPDATE_CANARY_ID,
  M2_INSERT_CANARY_ID,
  M4_FIXTURE_REL,
  M4_OPERATION,
  M4_APPLY_CONFIRMATION_TOKEN,
  QUARANTINE_THRESHOLD,
  validateM4Preflight,
  buildM4CanaryFixture,
  applyM4ObservationOnly,
  compareObservationToFixture,
  verifyCruiseRowUnchanged,
  snapshotCruiseRow,
  proveReplayIdempotent,
  assignPersistedFixtureHash
};
