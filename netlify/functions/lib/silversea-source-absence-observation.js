/**
 * Silversea source-absence observation state — policy, idempotency, and persistence helpers.
 * M4+: observation counts live outside discovered_cruises.
 */

const crypto = require("crypto");
const {
  SOURCE_ABSENCE_POLICY,
  SOURCE_ABSENCE_FIXTURE_ID,
  MAINTENANCE_CLASSIFICATION,
  snapshotFingerprint
} = require("./silversea-weekly-maintenance-policy");
const { classifyProductionOnly } = require("./silversea-weekly-maintenance-proposal");
const { shouldRemoveFromPublicInventory, daysUntilDeparture, PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE } = require("./public-discovered-cruise-inventory");

const OBSERVATION_TYPE_SOURCE_ABSENT = "SOURCE_ABSENT";
const OBSERVATION_STATUS_OBSERVING = "OBSERVING";
const OBSERVATION_STATUS_RESOLVED = "RESOLVED";
const OBSERVATION_TABLE = "cruise_source_observation_state";
const QUARANTINE_THRESHOLD = SOURCE_ABSENCE_POLICY.required_consecutive_healthy_absences;

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

/** ISO week key for weekly observation cadence (Perth calendar date input). */
function observationPeriodKey(perthDate) {
  const date = new Date(`${perthDate}T12:00:00`);
  const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function buildSourceSnapshotFingerprint(simulation) {
  return snapshotFingerprint({
    health: simulation.health,
    summary: simulation.summary,
    fetched_at: simulation.fetch_result?.fetched_at || null
  });
}

function isOfficialIdInSource(simulation, officialId) {
  const target = String(officialId || "").toUpperCase();
  return (simulation?.products || []).some(
    (p) => String(p.official_sailing_id || p.raw?.silversea_cruise_code || "").toUpperCase() === target
  );
}

function classifyCutoffSeparate(productionRow, today) {
  const withinCutoff = shouldRemoveFromPublicInventory({
    departureDate: productionRow.departure_date,
    status: productionRow.status,
    perthToday: today
  });
  const days = productionRow.departure_date ? daysUntilDeparture(productionRow.departure_date, today) : null;
  return {
    within_cutoff: withinCutoff,
    days_until_departure: days,
    within_21_day_cutoff: days != null && days < PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE,
    lifecycle_status: productionRow.status
  };
}

function deriveQuarantineProposal(count) {
  if (count >= QUARANTINE_THRESHOLD) {
    return {
      eligible: true,
      proposal: "QUARANTINE_REVIEW_REQUIRED",
      execute: false
    };
  }
  return {
    eligible: false,
    proposal: null,
    execute: false
  };
}

function computeExpectedAdvancement({ existingState, sourceSnapshotHash, observationPeriodKey: periodKey, sourceHealthy }) {
  if (!sourceHealthy) {
    return {
      ok: false,
      reason: "unhealthy_source",
      prior_count: existingState?.consecutive_healthy_absence_count || 0,
      new_count: existingState?.consecutive_healthy_absence_count || 0,
      write_action: "none"
    };
  }

  const prior = existingState?.consecutive_healthy_absence_count || 0;

  if (!existingState) {
    return {
      ok: true,
      prior_count: 0,
      new_count: 1,
      write_action: "insert",
      quarantine_eligible: false
    };
  }

  if (existingState.last_counted_snapshot_hash === sourceSnapshotHash) {
    return {
      ok: true,
      prior_count: prior,
      new_count: prior,
      write_action: "none",
      reason: "snapshot_already_counted",
      idempotent: true
    };
  }

  if (
    existingState.status === OBSERVATION_STATUS_OBSERVING &&
    existingState.last_observation_period_key === periodKey &&
    prior > 0
  ) {
    return {
      ok: true,
      prior_count: prior,
      new_count: prior,
      write_action: "none",
      reason: "observation_period_already_counted",
      idempotent: true
    };
  }

  const newCount =
    existingState.status === OBSERVATION_STATUS_RESOLVED || prior === 0 ? 1 : prior + 1;

  return {
    ok: true,
    prior_count: prior,
    new_count: newCount,
    write_action: "update",
    quarantine_eligible: newCount >= QUARANTINE_THRESHOLD
  };
}

async function loadObservationState(supabase, { cruiseLineId, officialSailingId, observationType = OBSERVATION_TYPE_SOURCE_ABSENT }) {
  try {
    const rows =
      (await supabase(
        `${OBSERVATION_TABLE}?cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}&official_sailing_id=eq.${encodeURIComponent(
          String(officialSailingId).toUpperCase()
        )}&observation_type=eq.${encodeURIComponent(observationType)}&select=*&limit=1`
      )) || [];
    return rows[0] || null;
  } catch (err) {
    if (err?.statusCode === 404 || /could not find the table/i.test(String(err?.message || ""))) {
      return null;
    }
    throw err;
  }
}

async function observationRpc(supabase, rpcName, body) {
  return supabase(`rpc/${rpcName}`, { method: "POST", body });
}

async function verifyObservationSchemaReady(supabase) {
  try {
    await supabase(`${OBSERVATION_TABLE}?select=id&limit=0`);
    const probe = await observationRpc(supabase, "advance_cruise_source_absence_observation", {
      p_cruise_line_id: "00000000-0000-0000-0000-000000000000",
      p_official_sailing_id: "__schema_probe__",
      p_source_health: "unhealthy"
    });
    return { ok: true, table: OBSERVATION_TABLE, rpc: true, probe };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
}

async function advanceSourceAbsenceObservation(supabase, params) {
  return observationRpc(supabase, "advance_cruise_source_absence_observation", {
    p_cruise_line_id: params.cruiseLineId,
    p_official_sailing_id: params.officialSailingId,
    p_production_cruise_uuid: params.productionUuid || null,
    p_observation_type: params.observationType || OBSERVATION_TYPE_SOURCE_ABSENT,
    p_source_snapshot_hash: params.sourceSnapshotHash,
    p_source_health: params.sourceHealth || "healthy",
    p_observation_period_key: params.observationPeriodKey,
    p_run_id: params.runId || null,
    p_reason_code: params.reasonCode || "healthy_source_miss",
    p_metadata: params.metadata || {}
  });
}

async function resolveSourceAbsenceObservation(supabase, params) {
  return observationRpc(supabase, "resolve_cruise_source_absence_observation", {
    p_cruise_line_id: params.cruiseLineId,
    p_official_sailing_id: params.officialSailingId,
    p_observation_type: params.observationType || OBSERVATION_TYPE_SOURCE_ABSENT,
    p_run_id: params.runId || null,
    p_metadata: params.metadata || {},
    p_source_present: params.sourcePresent !== false
  });
}

function classifySourceAbsenceCandidate({ productionRow, simulation, today, previousObservations = {} }) {
  const officialId = String(productionRow?.official_sailing_id || "").toUpperCase();
  const inSource = isOfficialIdInSource(simulation, officialId);
  const sourceHealthy = simulation?.health?.ok === true;
  const cutoff = classifyCutoffSeparate(productionRow, today);

  if (inSource) {
    return {
      official_sailing_id: officialId,
      source_present: true,
      classification: null,
      source_absent: false,
      cutoff
    };
  }

  const m1Record = classifyProductionOnly({
    productionRow,
    today,
    sourceHealthy,
    previousObservations
  });

  return {
    official_sailing_id: officialId,
    source_present: false,
    source_absent: true,
    classification: m1Record?.classification || MAINTENANCE_CLASSIFICATION.SOURCE_ABSENT_OBSERVATION,
    m1_record: m1Record,
    cutoff,
    secondary_product_context: m1Record?.secondary_reason || null
  };
}

module.exports = {
  OBSERVATION_TYPE_SOURCE_ABSENT,
  OBSERVATION_STATUS_OBSERVING,
  OBSERVATION_STATUS_RESOLVED,
  OBSERVATION_TABLE,
  QUARANTINE_THRESHOLD,
  SOURCE_ABSENCE_FIXTURE_ID,
  observationPeriodKey,
  buildSourceSnapshotFingerprint,
  isOfficialIdInSource,
  classifyCutoffSeparate,
  deriveQuarantineProposal,
  computeExpectedAdvancement,
  loadObservationState,
  verifyObservationSchemaReady,
  advanceSourceAbsenceObservation,
  resolveSourceAbsenceObservation,
  classifySourceAbsenceCandidate,
  hashFixtureContent,
  stableJson
};
