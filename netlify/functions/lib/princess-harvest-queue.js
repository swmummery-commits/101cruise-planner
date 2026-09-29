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

function countSchedulerOwners({ githubHasCron, netlifyHasCron }) {
  return [githubHasCron && "github", netlifyHasCron && "netlify"].filter(Boolean);
}

module.exports = {
  TABLE,
  QUEUED,
  CLAIMED,
  RUNNING,
  COMPLETED,
  FAILED,
  TIMED_OUT,
  createMemoryPrincessHarvestStore,
  createSupabasePrincessHarvestStore,
  enqueuePrincessHarvestRequest,
  claimPrincessHarvestRequest,
  heartbeatPrincessHarvestRequest,
  startPrincessHarvestRequest,
  completePrincessHarvestRequest,
  failPrincessHarvestRequest,
  evaluateHarvestWait,
  countSchedulerOwners
};
