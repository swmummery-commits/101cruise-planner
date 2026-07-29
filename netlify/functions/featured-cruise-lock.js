/**
 * Exclusive edit locks for Featured Cruises.
 *
 * POST /.netlify/functions/featured-cruise-lock
 * Body:
 *   { action: "acquire"|"heartbeat"|"release"|"status"|"force", featured_cruise_id, lock_token?, force? }
 */

const crypto = require("crypto");
const { requireAdmin, getConfig, serviceHeaders } = require("./admin-auth");

const LOCK_TTL_MS = 3 * 60 * 1000; // 3 minutes
const TABLE = "featured_cruise_edit_locks";

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function displayName(user) {
  const meta = user?.user_metadata || {};
  return (
    String(meta.full_name || meta.name || "").trim() ||
    String(user?.email || "").split("@")[0] ||
    "Another admin"
  );
}

async function supabase(path, options = {}) {
  const { supabaseUrl } = getConfig();
  const headers = {
    ...serviceHeaders(),
    Accept: "application/json",
    Prefer: options.prefer || "return=representation",
    ...(options.headers || {})
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body != null ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const detail =
      (data && (data.message || data.error || data.hint || data.details)) ||
      text ||
      `Supabase HTTP ${response.status}`;
    const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    err.statusCode = response.status;
    err.missingTable = /relation|does not exist|schema cache/i.test(String(detail));
    throw err;
  }
  return data;
}

function publicLock(row) {
  if (!row) return null;
  return {
    featured_cruise_id: row.featured_cruise_id,
    locked_by: row.locked_by,
    locked_by_email: row.locked_by_email || null,
    locked_by_name: row.locked_by_name || null,
    locked_at: row.locked_at,
    expires_at: row.expires_at,
    is_expired: new Date(row.expires_at).getTime() <= Date.now()
  };
}

async function getLock(cruiseId) {
  const rows = await supabase(
    `${TABLE}?featured_cruise_id=eq.${encodeURIComponent(cruiseId)}&select=*&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function freshExpiry() {
  return new Date(Date.now() + LOCK_TTL_MS).toISOString();
}

async function writeLock(cruiseId, user, existingToken) {
  const token = existingToken || crypto.randomUUID();
  const now = new Date().toISOString();
  const payload = {
    featured_cruise_id: cruiseId,
    locked_by: user.id,
    locked_by_email: String(user.email || "").trim().toLowerCase() || null,
    locked_by_name: displayName(user),
    lock_token: token,
    locked_at: now,
    expires_at: freshExpiry(),
    updated_at: now
  };
  const rows = await supabase(TABLE, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: payload
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row;
}

async function deleteLock(cruiseId) {
  await supabase(`${TABLE}?featured_cruise_id=eq.${encodeURIComponent(cruiseId)}`, {
    method: "DELETE",
    prefer: "return=minimal"
  });
}

async function handleAcquire(cruiseId, user, { force = false } = {}) {
  const existing = await getLock(cruiseId);
  const now = Date.now();
  if (existing) {
    const expired = new Date(existing.expires_at).getTime() <= now;
    const mine = existing.locked_by === user.id;
    if (mine) {
      const row = await writeLock(cruiseId, user, existing.lock_token);
      return {
        success: true,
        acquired: true,
        lock_token: row.lock_token,
        lock: publicLock(row),
        renewed: true
      };
    }
    if (!expired && !force) {
      return {
        success: false,
        acquired: false,
        code: "locked",
        error: `${existing.locked_by_name || existing.locked_by_email || "Another admin"} is editing this cruise.`,
        lock: publicLock(existing)
      };
    }
  }

  const row = await writeLock(cruiseId, user, null);
  return {
    success: true,
    acquired: true,
    lock_token: row.lock_token,
    lock: publicLock(row),
    forced: Boolean(force && existing && existing.locked_by !== user.id)
  };
}

async function handleHeartbeat(cruiseId, user, lockToken) {
  const existing = await getLock(cruiseId);
  if (!existing) {
    return { success: false, code: "missing", error: "Edit lock was lost. Re-open the cruise to continue." };
  }
  if (existing.locked_by !== user.id || existing.lock_token !== lockToken) {
    return {
      success: false,
      code: "taken",
      error: `${existing.locked_by_name || "Another admin"} has taken over editing this cruise.`,
      lock: publicLock(existing)
    };
  }
  const now = new Date().toISOString();
  const rows = await supabase(
    `${TABLE}?featured_cruise_id=eq.${encodeURIComponent(cruiseId)}&locked_by=eq.${encodeURIComponent(user.id)}&lock_token=eq.${encodeURIComponent(lockToken)}`,
    {
      method: "PATCH",
      body: { expires_at: freshExpiry(), updated_at: now }
    }
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) {
    return { success: false, code: "taken", error: "Edit lock was lost. Re-open the cruise to continue." };
  }
  return { success: true, lock_token: lockToken, lock: publicLock(row) };
}

async function handleRelease(cruiseId, user, lockToken) {
  const existing = await getLock(cruiseId);
  if (!existing) return { success: true, released: true };
  if (existing.locked_by === user.id && (!lockToken || existing.lock_token === lockToken)) {
    await deleteLock(cruiseId);
    return { success: true, released: true };
  }
  // Someone else's lock — do not clear
  return { success: true, released: false };
}

async function handleStatus(cruiseId, user) {
  const existing = await getLock(cruiseId);
  if (!existing) {
    return { success: true, lock: null, is_holder: false };
  }
  const expired = new Date(existing.expires_at).getTime() <= Date.now();
  return {
    success: true,
    lock: publicLock(existing),
    is_holder: existing.locked_by === user.id && !expired,
    is_expired: expired
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const user = await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").trim();
    const cruiseId = String(body.featured_cruise_id || "").trim();
    if (!cruiseId) {
      return jsonResponse(400, { success: false, error: "featured_cruise_id is required" });
    }
    const lockToken = String(body.lock_token || "").trim() || null;
    const force = Boolean(body.force);

    let result;
    if (action === "acquire") result = await handleAcquire(cruiseId, user, { force });
    else if (action === "force") result = await handleAcquire(cruiseId, user, { force: true });
    else if (action === "heartbeat") result = await handleHeartbeat(cruiseId, user, lockToken);
    else if (action === "release") result = await handleRelease(cruiseId, user, lockToken);
    else if (action === "status") result = await handleStatus(cruiseId, user);
    else return jsonResponse(400, { success: false, error: "Unknown action" });

    const status = result.success === false && result.code === "locked" ? 409 : 200;
    return jsonResponse(status, result);
  } catch (error) {
    if (error.missingTable) {
      return jsonResponse(503, {
        success: false,
        error:
          "Cruise edit locks are not set up yet. Apply supabase/migrations/20260740_featured_cruise_edit_locks.sql in Supabase, then try again."
      });
    }
    const status = Number(error.statusCode) || 500;
    return jsonResponse(status, {
      success: false,
      error:
        status === 401 || status === 403
          ? error.message
          : error.message || "Could not update the edit lock."
    });
  }
};
