/**
 * Princess Mac harvest request queue (hybrid architecture).
 * Stores no service-role secrets. Client IDs/cookies never persisted.
 */

const crypto = require("crypto");
const { evaluatePrincessSourceWorkerHealth } = require("./princess-source-worker-watch");

const TABLE = "princess_harvest_requests";
const QUEUED = "queued";
const CLAIMED = "claimed";
const RUNNING = "running";
const COMPLETED = "completed";
const FAILED = "failed";
const TIMED_OUT = "timed_out";

function newId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function createMemoryPrincessHarvestStore(seed = []) {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]));

  function duplicate(periodKey, dispatchId, exceptId = null) {
    return [...rows.values()].find(
      (row) =>
        row.period_key === periodKey &&
        row.dispatch_id === dispatchId &&
        row.id !== exceptId
    );
  }

  return {
    kind: "memory",
    rows,
    async insert(row) {
      if (duplicate(row.period_key, row.dispatch_id)) {
        const err = new Error("duplicate_harvest_request");
        err.code = "23505";
        throw err;
      }
      rows.set(row.id, { ...row });
      return rows.get(row.id);
    },
    async getById(id) {
      return rows.get(id) || null;
    },
    async findOpenByPeriod(periodKey, dispatchId) {
      return (
        [...rows.values()].find(
          (row) =>
            row.period_key === periodKey &&
            row.dispatch_id === dispatchId &&
            (row.status === QUEUED || row.status === CLAIMED || row.status === RUNNING)
        ) || null
      );
    },
    async claimOne(workerId, nowIso) {
      const queued = [...rows.values()]
        .filter((row) => row.status === QUEUED)
        .sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)));
      const row = queued[0];
      if (!row) return null;
      row.status = CLAIMED;
      row.claimed_at = nowIso;
      row.worker_id = workerId;
      row.last_heartbeat_at = nowIso;
      return row;
    },
    async update(id, patch) {
      const current = rows.get(id);
      if (!current) return null;
      Object.assign(current, patch);
      return current;
    }
  };
}

const HARVEST_RUN_TYPE = "princess_mac_harvest";

function harvestFromRunRow(row) {
  if (!row) return null;
  const stats = row.stats || {};
  return {
    id: row.id,
    period_key: stats.period_key,
    run_record_id: stats.maintenance_run_record_id || row.id,
    dispatch_id: stats.dispatch_id,
    requested_at: stats.requested_at || row.started_at,
    claimed_at: stats.claimed_at || null,
    worker_id: stats.worker_id || null,
    started_at: stats.harvest_started_at || null,
    finished_at: stats.harvest_finished_at || row.finished_at || null,
    last_heartbeat_at: stats.last_heartbeat_at || null,
    status: stats.harvest_status || QUEUED,
    dry_run: stats.dry_run !== false,
    source_snapshot_hash: stats.source_snapshot_hash || null,
    eligible_count: stats.eligible_count ?? null,
    error_code: stats.error_code || null,
    error_detail_sanitized: stats.error_detail_sanitized || null,
    source_freeze: stats.source_freeze || null
  };
}

function createRunsBackedPrincessHarvestStore(supabase, cruiseLineId) {
  async function loadPrincessLineId() {
    if (cruiseLineId) return cruiseLineId;
    const lines = await supabase("ci_cruise_lines?slug=eq.princess-cruises&select=id&limit=1");
    return lines?.[0]?.id || null;
  }

  return {
    kind: "cruise_discovery_runs",
    async insert(row) {
      const lineId = await loadPrincessLineId();
      const inserted = await supabase("cruise_discovery_runs", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: {
          scope: "cruise_line",
          cruise_line_id: lineId,
          destination_id: null,
          status: "running",
          started_at: row.requested_at,
          stats: {
            run_type: HARVEST_RUN_TYPE,
            run_id: `harvest:${row.period_key}:${row.dispatch_id}`,
            trigger_type: "mac_harvest_request",
            harvest_queue: true,
            harvest_status: QUEUED,
            period_key: row.period_key,
            dispatch_id: row.dispatch_id,
            maintenance_run_record_id: row.run_record_id || null,
            requested_at: row.requested_at,
            dry_run: row.dry_run !== false
          }
        }
      });
      return harvestFromRunRow(Array.isArray(inserted) ? inserted[0] : inserted);
    },
    async getById(id) {
      const rows = await supabase(`cruise_discovery_runs?id=eq.${encodeURIComponent(id)}&select=id,stats,started_at,finished_at,status&limit=1`);
      return harvestFromRunRow(Array.isArray(rows) ? rows[0] : rows);
    },
    async findOpenByPeriod(periodKey, dispatchId) {
      const rows = await supabase(
        `cruise_discovery_runs?stats->>run_type=eq.${HARVEST_RUN_TYPE}&stats->>period_key=eq.${encodeURIComponent(
          periodKey
        )}&stats->>dispatch_id=eq.${encodeURIComponent(dispatchId)}&stats->>harvest_status=in.(queued,claimed,running)&select=id,stats,started_at,finished_at,status&limit=1`
      );
      return harvestFromRunRow(Array.isArray(rows) ? rows[0] : rows);
    },
    async claimOne(workerId, nowIso) {
      const rows = await supabase(
        `cruise_discovery_runs?stats->>run_type=eq.${HARVEST_RUN_TYPE}&stats->>harvest_status=eq.queued&order=started_at.asc&select=id,stats,started_at,finished_at,status&limit=1`
      );
      const current = Array.isArray(rows) ? rows[0] : rows;
      if (!current) return null;
      const stats = { ...(current.stats || {}), harvest_status: CLAIMED, claimed_at: nowIso, worker_id: workerId, last_heartbeat_at: nowIso };
      const updated = await supabase(
        `cruise_discovery_runs?id=eq.${encodeURIComponent(current.id)}&stats->>harvest_status=eq.queued`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: { stats }
        }
      );
      const row = Array.isArray(updated) ? updated[0] : updated;
      return harvestFromRunRow(row);
    },
    async update(id, patch) {
      const currentRows = await supabase(`cruise_discovery_runs?id=eq.${encodeURIComponent(id)}&select=id,stats,started_at,finished_at,status&limit=1`);
      const current = Array.isArray(currentRows) ? currentRows[0] : currentRows;
      if (!current) return null;
      const stats = { ...(current.stats || {}) };
      if (patch.status) stats.harvest_status = patch.status;
      if (patch.claimed_at) stats.claimed_at = patch.claimed_at;
      if (patch.worker_id) stats.worker_id = patch.worker_id;
      if (patch.started_at) stats.harvest_started_at = patch.started_at;
      if (patch.finished_at) stats.harvest_finished_at = patch.finished_at;
      if (patch.last_heartbeat_at) stats.last_heartbeat_at = patch.last_heartbeat_at;
      if (patch.source_snapshot_hash !== undefined) stats.source_snapshot_hash = patch.source_snapshot_hash;
      if (patch.eligible_count !== undefined) stats.eligible_count = patch.eligible_count;
      if (patch.error_code !== undefined) stats.error_code = patch.error_code;
      if (patch.error_detail_sanitized !== undefined) stats.error_detail_sanitized = patch.error_detail_sanitized;
      if (patch.source_freeze !== undefined) stats.source_freeze = patch.source_freeze;
      if (patch.dry_run !== undefined) stats.dry_run = patch.dry_run;
      const finished = patch.status === COMPLETED || patch.status === FAILED || patch.status === TIMED_OUT;
      const updated = await supabase(`cruise_discovery_runs?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: {
          stats,
          ...(finished ? { status: patch.status === COMPLETED ? "completed" : "failed", finished_at: patch.finished_at || new Date().toISOString() } : {})
        }
      });
      return harvestFromRunRow(Array.isArray(updated) ? updated[0] : updated);
    }
  };
}

async function resolvePrincessHarvestStore(supabase) {
  try {
    await supabase("princess_harvest_requests?select=id&limit=1");
    return createSupabasePrincessHarvestStore(supabase);
  } catch (_error) {
    return createRunsBackedPrincessHarvestStore(supabase);
  }
}

function createSupabasePrincessHarvestStore(supabase) {
  return {
    kind: "supabase",
    async insert(row) {
      const inserted = await supabase(TABLE, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: row
      });
      return Array.isArray(inserted) ? inserted[0] : inserted;
    },
    async getById(id) {
      const rows = await supabase(
        `${TABLE}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
      );
      return Array.isArray(rows) ? rows[0] || null : rows;
    },
    async findOpenByPeriod(periodKey, dispatchId) {
      const rows = await supabase(
        `${TABLE}?period_key=eq.${encodeURIComponent(periodKey)}&dispatch_id=eq.${encodeURIComponent(
          dispatchId
        )}&status=in.(queued,claimed,running)&select=*&limit=1`
      );
      return Array.isArray(rows) ? rows[0] || null : rows;
    },
    async claimOne(workerId, nowIso) {
      const claimed = await supabase("rpc/claim_princess_harvest_request", {
        method: "POST",
        body: { p_worker_id: workerId, p_claimed_at: nowIso }
      });
      if (!claimed || (Array.isArray(claimed) && !claimed.length)) return null;
      return Array.isArray(claimed) ? claimed[0] : claimed;
    },
    async update(id, patch) {
      const updated = await supabase(`${TABLE}?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: patch
      });
      return Array.isArray(updated) ? updated[0] : updated;
    }
  };
}

async function enqueuePrincessHarvestRequest(store, input = {}) {
  const periodKey = String(input.period_key || "").trim();
  const dispatchId = String(input.dispatch_id || "").trim();
  if (!periodKey || !dispatchId) {
    throw new Error("harvest_request_requires_period_and_dispatch");
  }
  const existing = await store.findOpenByPeriod(periodKey, dispatchId);
  if (existing) {
    return { created: false, duplicate: true, request: existing };
  }
  const now = input.requested_at || new Date().toISOString();
  const row = {
    id: input.id || newId(),
    period_key: periodKey,
    run_record_id: input.run_record_id || null,
    dispatch_id: dispatchId,
    requested_at: now,
    claimed_at: null,
    worker_id: null,
    started_at: null,
    finished_at: null,
    last_heartbeat_at: null,
    status: QUEUED,
    dry_run: input.dry_run !== false,
    source_snapshot_hash: null,
    eligible_count: null,
    error_code: null,
    error_detail_sanitized: null,
    source_freeze: null
  };
  try {
    const request = await store.insert(row);
    return { created: true, duplicate: false, request };
  } catch (error) {
    if (error.code === "23505" || /duplicate/i.test(error.message || "")) {
      const again = await store.findOpenByPeriod(periodKey, dispatchId);
      return { created: false, duplicate: true, request: again };
    }
    throw error;
  }
}

async function claimPrincessHarvestRequest(store, { workerId, now = new Date() } = {}) {
  if (!workerId) throw new Error("harvest_claim_requires_worker_id");
  return store.claimOne(workerId, now.toISOString());
}

async function heartbeatPrincessHarvestRequest(store, id, { now = new Date(), status = RUNNING } = {}) {
  return store.update(id, {
    status,
    last_heartbeat_at: now.toISOString()
  });
}

async function startPrincessHarvestRequest(store, id, { now = new Date() } = {}) {
  return store.update(id, {
    status: RUNNING,
    started_at: now.toISOString(),
    last_heartbeat_at: now.toISOString()
  });
}

async function completePrincessHarvestRequest(store, id, payload = {}) {
  return store.update(id, {
    status: COMPLETED,
    finished_at: payload.finished_at || new Date().toISOString(),
    last_heartbeat_at: payload.finished_at || new Date().toISOString(),
    source_snapshot_hash: payload.source_snapshot_hash || null,
    eligible_count: payload.eligible_count ?? null,
    source_freeze: payload.source_freeze || null,
    error_code: null,
    error_detail_sanitized: null
  });
}

async function failPrincessHarvestRequest(store, id, { errorCode, errorDetail, status = FAILED } = {}) {
  return store.update(id, {
    status,
    finished_at: new Date().toISOString(),
    error_code: errorCode || "HARVEST_FAILED",
    error_detail_sanitized: String(errorDetail || "").slice(0, 400)
  });
}

function evaluateHarvestWait(request, { expectedStartMs, nowMs = Date.now(), graceMs, staleMs } = {}) {
  if (!request) {
    return { ok: false, status: "SOURCE_WORKER_NOT_STARTED", reason: "request_missing" };
  }
  if (request.status === COMPLETED) {
    return { ok: true, status: "completed", request };
  }
  if (request.status === FAILED || request.status === TIMED_OUT) {
    return { ok: false, status: request.status, request };
  }
  const health = evaluatePrincessSourceWorkerHealth({
    expectedStartMs: expectedStartMs || Date.parse(request.requested_at),
    harvestStartedMs: request.started_at ? Date.parse(request.started_at) : request.claimed_at ? Date.parse(request.claimed_at) : null,
    harvestFinishedMs: request.finished_at ? Date.parse(request.finished_at) : null,
    lastHeartbeatMs: request.last_heartbeat_at ? Date.parse(request.last_heartbeat_at) : null,
    nowMs,
    graceMs,
    staleMs
  });
  if (!health.ok && health.status === "source_worker_not_started") {
    return { ...health, status: "SOURCE_WORKER_NOT_STARTED", request };
  }
  return { ...health, request };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPrincessHarvest(
  store,
  requestId,
  {
    expectedStartMs,
    graceMs = 20 * 60 * 1000,
    staleMs = 15 * 60 * 1000,
    pollMs = 5000,
    nowFn = Date.now
  } = {}
) {
  while (true) {
    const request = await store.getById(requestId);
    const verdict = evaluateHarvestWait(request, {
      expectedStartMs,
      nowMs: nowFn(),
      graceMs,
      staleMs
    });
    if (verdict.status === "completed" || request?.status === COMPLETED) {
      return { ...verdict, status: "completed", ok: true, request };
    }
    if (
      verdict.status === "SOURCE_WORKER_NOT_STARTED" ||
      verdict.status === "STALE_SOURCE_WORKER" ||
      request?.status === FAILED ||
      request?.status === TIMED_OUT
    ) {
      if (request && (request.status === QUEUED || request.status === CLAIMED || request.status === RUNNING)) {
        await failPrincessHarvestRequest(store, requestId, {
          errorCode: verdict.status,
          status: TIMED_OUT,
          errorDetail: verdict.reason || verdict.status
        });
      }
      return verdict;
    }
    await sleep(pollMs);
  }
}

function countSchedulerOwners({ githubHasCron, netlifyHasCron }) {
  return [githubHasCron && "github", netlifyHasCron && "netlify"].filter(Boolean);
}

module.exports = {
  TABLE,
  HARVEST_RUN_TYPE,
  QUEUED,
  CLAIMED,
  RUNNING,
  COMPLETED,
  FAILED,
  TIMED_OUT,
  createMemoryPrincessHarvestStore,
  createSupabasePrincessHarvestStore,
  createRunsBackedPrincessHarvestStore,
  resolvePrincessHarvestStore,
  enqueuePrincessHarvestRequest,
  claimPrincessHarvestRequest,
  heartbeatPrincessHarvestRequest,
  startPrincessHarvestRequest,
  completePrincessHarvestRequest,
  failPrincessHarvestRequest,
  evaluateHarvestWait,
  waitForPrincessHarvest,
  countSchedulerOwners
};
