/**
 * Princess source-worker availability for hybrid Mac harvest.
 * A late or missing harvest is SOURCE_WORKER_NOT_STARTED, not an
 * indefinite scheduled inventory failure.
 */

const STALE_SOURCE_WORKER = "STALE_SOURCE_WORKER";
const SOURCE_WORKER_NOT_STARTED = "source_worker_not_started";
const SOURCE_WORKER_NOT_STARTED_TERMINAL = "SOURCE_WORKER_NOT_STARTED";
const DEFAULT_GRACE_MS = 20 * 60 * 1000;
const DEFAULT_STALE_MS = 15 * 60 * 1000;

function evaluatePrincessSourceWorkerStart({
  expectedStartMs,
  harvestStartedMs = null,
  nowMs = Date.now(),
  graceMs = DEFAULT_GRACE_MS
} = {}) {
  const expected = Number(expectedStartMs);
  if (!Number.isFinite(expected)) {
    return { ok: false, status: SOURCE_WORKER_NOT_STARTED, reason: "expected_start_missing" };
  }
  if (harvestStartedMs != null) {
    return {
      ok: true,
      status: "started",
      delay_ms: Number(harvestStartedMs) - expected,
      grace_ms: graceMs
    };
  }
  if (Number(nowMs) - expected >= Number(graceMs)) {
    return {
      ok: false,
      status: SOURCE_WORKER_NOT_STARTED,
      reason: SOURCE_WORKER_NOT_STARTED,
      delay_ms: Number(nowMs) - expected,
      grace_ms: graceMs
    };
  }
  return {
    ok: true,
    status: "awaiting_worker",
    delay_ms: Number(nowMs) - expected,
    grace_ms: graceMs
  };
}

function buildPrincessScheduleObservability({
  expectedSlotIso,
  githubEventCreatedAt = null,
  runnerJobStartedAt = null,
  maintenanceStartedAt = null
} = {}) {
  const expectedMs = expectedSlotIso ? Date.parse(expectedSlotIso) : NaN;
  const eventMs = githubEventCreatedAt ? Date.parse(githubEventCreatedAt) : NaN;
  const runnerMs = runnerJobStartedAt ? Date.parse(runnerJobStartedAt) : NaN;
  const maintenanceMs = maintenanceStartedAt ? Date.parse(maintenanceStartedAt) : NaN;
  const delayFromExpected = (value) =>
    Number.isFinite(expectedMs) && Number.isFinite(value) ? Math.round((value - expectedMs) / 60000) : null;
  return {
    expected_schedule_time: expectedSlotIso || null,
    github_event_creation_time: githubEventCreatedAt || null,
    runner_job_start_time: runnerJobStartedAt || null,
    maintenance_start_time: maintenanceStartedAt || null,
    github_event_delay_minutes: delayFromExpected(eventMs),
    runner_start_delay_minutes: delayFromExpected(runnerMs),
    maintenance_start_delay_minutes: delayFromExpected(maintenanceMs),
    severity: "WARN",
    inventory_failure: false
  };
}

function evaluatePrincessSourceWorkerHealth({
  expectedStartMs,
  harvestStartedMs = null,
  harvestFinishedMs = null,
  lastHeartbeatMs = null,
  nowMs = Date.now(),
  graceMs = DEFAULT_GRACE_MS,
  staleMs = DEFAULT_STALE_MS
} = {}) {
  const start = evaluatePrincessSourceWorkerStart({
    expectedStartMs,
    harvestStartedMs,
    nowMs,
    graceMs
  });
  if (harvestFinishedMs != null) {
    return {
      ok: true,
      status: "completed",
      delay_ms: Number(harvestFinishedMs) - Number(expectedStartMs),
      grace_ms: graceMs
    };
  }
  if (harvestStartedMs != null) {
    const lastSeen = lastHeartbeatMs != null ? Number(lastHeartbeatMs) : Number(harvestStartedMs);
    if (Number(nowMs) - lastSeen >= Number(staleMs)) {
      return {
        ok: false,
        status: STALE_SOURCE_WORKER,
        reason: STALE_SOURCE_WORKER,
        delay_ms: Number(nowMs) - lastSeen,
        stale_ms: staleMs
      };
    }
    return {
      ok: true,
      status: "running",
      delay_ms: Number(nowMs) - Number(harvestStartedMs),
      stale_ms: staleMs
    };
  }
  return start;
}

module.exports = {
  SOURCE_WORKER_NOT_STARTED,
  SOURCE_WORKER_NOT_STARTED_TERMINAL,
  STALE_SOURCE_WORKER,
  DEFAULT_GRACE_MS,
  DEFAULT_STALE_MS,
  evaluatePrincessSourceWorkerStart,
  evaluatePrincessSourceWorkerHealth,
  buildPrincessScheduleObservability
};
