/**
 * Database-backed maintenance job locks (serverless-safe mutual exclusion).
 */

const LOCK_TABLE = "cruise_discovery_maintenance_locks";

const DEFAULT_LEASE_SECONDS = {
  "holland-america-line:weekly": 900,
  "celebrity-cruises:weekly": 900,
  "princess-cruises:weekly": 900,
  "explora-journeys:weekly": 900,
  "seabourn-cruise-line:weekly": 900,
  "royal-caribbean-international:weekly": 900,
  "norwegian-cruise-line:weekly": 900,
  "carnival-cruise-line:weekly": 900,
  "disney-cruise-line:weekly": 1800,
  "azamara:weekly": 900,
  "controlled_production_import:global": 1800,
  daily_expiry: 300
};

function weeklyLockKey(lineSlug) {
  return `${lineSlug}:weekly`;
}

function dailyExpiryLockKey() {
  return "daily_expiry";
}

async function acquireLockViaRunningRun(supabase, params) {
  const runTypeByLock = {
    "holland-america-line:weekly": "hal_weekly_maintenance",
    "celebrity-cruises:weekly": "celebrity_weekly_maintenance",
    "princess-cruises:weekly": "princess_weekly_maintenance",
    "explora-journeys:weekly": "explora_weekly_maintenance",
    "seabourn-cruise-line:weekly": "seabourn_weekly_maintenance",
    "royal-caribbean-international:weekly": "royal_caribbean_weekly_maintenance",
    "norwegian-cruise-line:weekly": "norwegian_weekly_maintenance",
    "carnival-cruise-line:weekly": "carnival_weekly_maintenance",
    "disney-cruise-line:weekly": "disney_weekly_maintenance",
    "azamara:weekly": "azamara_weekly_maintenance",
    daily_expiry: "daily_expiry_maintenance"
  };
  const runType = runTypeByLock[params.lockKey];
  if (!runType) return { acquired: false, reason: "unknown_lock_key" };

  const leaseSeconds = Number(params.leaseSeconds) || DEFAULT_LEASE_SECONDS[params.lockKey] || 900;
  const cutoff = new Date(Date.now() - leaseSeconds * 1000).toISOString();
  const scopeFilter =
    params.lockKey === "daily_expiry" ? "scope=eq.full" : "scope=eq.cruise_line";
  const runs = await supabase(
    `cruise_discovery_runs?${scopeFilter}&status=eq.running&started_at=gte.${encodeURIComponent(cutoff)}&select=id,stats,started_at&order=started_at.desc&limit=10`
  ).catch(() => []);

  const active = (runs || []).find((r) => r.stats?.run_type === runType);
  if (active && active.stats?.run_id !== params.runId) {
    return {
      acquired: false,
      reason: "maintenance_lock_held",
      lock_key: params.lockKey,
      owner_id: active.stats?.run_id || active.id,
      expires_at: new Date(new Date(active.started_at).getTime() + leaseSeconds * 1000).toISOString(),
      worker_state: "already_running",
      lock_backend: "running_run_fallback"
    };
  }

  return {
    acquired: true,
    lock_key: params.lockKey,
    owner_id: params.ownerId,
    worker_state: "running",
    lock_backend: "running_run_fallback"
  };
}

async function callAcquireRpc(supabase, params) {
  try {
    const result = await supabase("rpc/acquire_cruise_discovery_maintenance_lock", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        p_lock_key: params.lockKey,
        p_owner_id: params.ownerId,
        p_run_id: params.runId || null,
        p_run_record_id: params.runRecordId || null,
        p_lease_seconds: params.leaseSeconds
      }
    });
    if (result && typeof result.acquired === "boolean") return result;
    if (Array.isArray(result) && result[0]) return result[0];
    return result;
  } catch (error) {
    if (/function.*does not exist|schema cache|42883/i.test(String(error.message || ""))) {
      return null;
    }
    throw error;
  }
}

async function acquireLockViaTable(supabase, params) {
  const now = Date.now();
  const expiresAt = new Date(now + params.leaseSeconds * 1000).toISOString();
  const acquiredAt = new Date(now).toISOString();

  const existing = await supabase(
    `${LOCK_TABLE}?lock_key=eq.${encodeURIComponent(params.lockKey)}&select=*&limit=1`
  ).catch((error) => {
    if (/does not exist|schema cache|PGRST205/i.test(String(error.message || ""))) {
      return null;
    }
    throw error;
  });
  if (existing === null) {
    return acquireLockViaRunningRun(supabase, params);
  }
  const row = existing?.[0] || null;

  if (row && new Date(row.expires_at).getTime() > now && row.owner_id !== params.ownerId) {
    return {
      acquired: false,
      reason: "maintenance_lock_held",
      lock_key: params.lockKey,
      owner_id: row.owner_id,
      expires_at: row.expires_at
    };
  }

  const payload = {
    lock_key: params.lockKey,
    owner_id: params.ownerId,
    run_id: params.runId || null,
    run_record_id: params.runRecordId || null,
    acquired_at: acquiredAt,
    expires_at: expiresAt,
    updated_at: acquiredAt
  };

  if (row) {
    try {
      await supabase(`${LOCK_TABLE}?lock_key=eq.${encodeURIComponent(params.lockKey)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: payload
      });
    } catch (error) {
      if (/does not exist|schema cache|PGRST205/i.test(String(error.message || ""))) {
        return acquireLockViaRunningRun(supabase, params);
      }
      throw error;
    }
  } else {
    try {
      await supabase(LOCK_TABLE, {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: payload
      });
    } catch (error) {
      if (/does not exist|schema cache|PGRST205/i.test(String(error.message || ""))) {
        return acquireLockViaRunningRun(supabase, params);
      }
      throw error;
    }
  }

  return {
    acquired: true,
    lock_key: params.lockKey,
    owner_id: params.ownerId,
    expires_at: expiresAt
  };
}

async function acquireMaintenanceDbLock(supabase, params) {
  const lockKey = String(params.lockKey || "").trim();
  const ownerId = String(params.ownerId || "").trim();
  if (!lockKey || !ownerId) {
    return { acquired: false, reason: "invalid_lock_parameters" };
  }

  const leaseSeconds =
    Number(params.leaseSeconds) ||
    DEFAULT_LEASE_SECONDS[lockKey] ||
    DEFAULT_LEASE_SECONDS["holland-america-line:weekly"];

  const rpc = await callAcquireRpc(supabase, {
    lockKey,
    ownerId,
    runId: params.runId,
    runRecordId: params.runRecordId,
    leaseSeconds
  });
  if (rpc) {
    return {
      acquired: rpc.acquired === true,
      reason: rpc.reason || (rpc.acquired ? null : "maintenance_lock_held"),
      lock_key: rpc.lock_key || lockKey,
      owner_id: rpc.owner_id || ownerId,
      expires_at: rpc.expires_at || null,
      worker_state: rpc.acquired ? "running" : "already_running"
    };
  }

  const table = await acquireLockViaTable(supabase, {
    lockKey,
    ownerId,
    runId: params.runId,
    runRecordId: params.runRecordId,
    leaseSeconds
  });
  return {
    ...table,
    worker_state: table.acquired ? "running" : "already_running"
  };
}

async function releaseMaintenanceDbLock(supabase, { lockKey, ownerId }) {
  const key = String(lockKey || "").trim();
  const owner = String(ownerId || "").trim();
  if (!key || !owner) return false;

  try {
    const released = await supabase("rpc/release_cruise_discovery_maintenance_lock", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: { p_lock_key: key, p_owner_id: owner }
    });
    if (typeof released === "boolean") return released;
    if (released?.release_cruise_discovery_maintenance_lock === false) return false;
    if (released?.release_cruise_discovery_maintenance_lock === true) return true;
  } catch {
    /* fall through to table delete */
  }

  await supabase(
    `${LOCK_TABLE}?lock_key=eq.${encodeURIComponent(key)}&owner_id=eq.${encodeURIComponent(owner)}`,
    { method: "DELETE", headers: { Prefer: "return=minimal" } }
  ).catch(() => null);
  return true;
}

async function verifyMaintenanceLockOwnership(supabase, { lockKey, ownerId }) {
  const status = await loadMaintenanceLockStatus(supabase, lockKey);
  if (!status.held) {
    return { ok: false, reason: "maintenance_lock_not_held", status };
  }
  if (status.owner_id !== ownerId) {
    return {
      ok: false,
      reason: "maintenance_lock_owner_mismatch",
      expected_owner_id: ownerId,
      actual_owner_id: status.owner_id,
      status
    };
  }
  return { ok: true, reason: null, status };
}

async function loadMaintenanceLockStatus(supabase, lockKey) {
  const rows = await supabase(
    `${LOCK_TABLE}?lock_key=eq.${encodeURIComponent(lockKey)}&select=lock_key,owner_id,run_id,run_record_id,acquired_at,expires_at&limit=1`
  ).catch(() => []);
  const row = rows?.[0];
  if (!row) return { held: false, worker_state: "idle" };
  const expired = new Date(row.expires_at).getTime() <= Date.now();
  return {
    held: !expired,
    expired,
    worker_state: expired ? "idle" : "running",
    owner_id: row.owner_id,
    run_id: row.run_id,
    expires_at: row.expires_at
  };
}

module.exports = {
  LOCK_TABLE,
  weeklyLockKey,
  dailyExpiryLockKey,
  DEFAULT_LEASE_SECONDS,
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock,
  verifyMaintenanceLockOwnership,
  loadMaintenanceLockStatus
};
