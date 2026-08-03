/**
 * Admin Stateroom Types reference — list / create / update / delete.
 *
 * POST /.netlify/functions/stateroom-types
 * Body:
 *   { action: "list" }
 *   { action: "create", stateroom_type: { name, display_order, is_active } }
 *   { action: "update", id, stateroom_type: { name, display_order, is_active } }
 *   { action: "delete", id }
 *   { action: "check_usage", id }
 */

const { requireAdmin } = require("./admin-auth");

const SELECT =
  "id,name,normalized_name,display_order,is_active,created_at,updated_at";

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

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase credentials are missing.");
  }
  return { url: url.replace(/\/$/, ""), key };
}

async function supabase(restPath, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    Prefer: options.prefer || "return=representation",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${url}/rest/v1/${restPath}`, {
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
    throw err;
  }
  return data;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.calm = true;
  throw err;
}

function trimName(value) {
  return String(value ?? "").trim();
}

function normalizeName(value) {
  return trimName(value).toLowerCase();
}

function parseDisplayOrder(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function sanitizePayload(raw) {
  const body = raw && typeof raw === "object" ? raw : {};
  const name = trimName(body.name);
  if (!name) badRequest("Stateroom type name is required.");
  const displayOrder = parseDisplayOrder(body.display_order, NaN);
  if (!Number.isFinite(displayOrder)) badRequest("Display order must be a whole number.");
  return {
    name,
    normalized_name: normalizeName(name),
    display_order: displayOrder,
    is_active: body.is_active !== false
  };
}

async function listStateroomTypes() {
  const rows = await supabase(
    `stateroom_types?select=${encodeURIComponent(SELECT)}&order=display_order.asc,name.asc&limit=500`
  );
  return Array.isArray(rows) ? rows : [];
}

async function findById(id) {
  const typeId = String(id || "").trim();
  if (!typeId) return null;
  const rows = await supabase(
    `stateroom_types?select=${encodeURIComponent(SELECT)}&id=eq.${encodeURIComponent(typeId)}&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function findDuplicate(normalizedName, excludeId) {
  const key = normalizeName(normalizedName);
  if (!key) return null;
  const rows = await supabase(
    `stateroom_types?select=${encodeURIComponent(SELECT)}&normalized_name=eq.${encodeURIComponent(key)}&limit=1`
  );
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row) return null;
  if (excludeId && row.id === excludeId) return null;
  return row;
}

async function isStateroomTypeInUse(stateroomType) {
  const name = trimName(stateroomType?.name);
  if (!name) return false;
  const rows = await supabase(
    `featured_cruise_pricing?select=id&room_label=ilike.${encodeURIComponent(name)}&limit=1`
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function createStateroomType(raw) {
  const payload = sanitizePayload(raw);
  const duplicate = await findDuplicate(payload.normalized_name);
  if (duplicate) badRequest("A stateroom type with this name already exists.");
  try {
    const rows = await supabase("stateroom_types", {
      method: "POST",
      prefer: "return=representation",
      body: payload
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row?.id) throw new Error("Stateroom type was not returned after create.");
    return row;
  } catch (error) {
    if (/duplicate|unique/i.test(String(error.message || ""))) {
      badRequest("A stateroom type with this name already exists.");
    }
    throw error;
  }
}

async function updateStateroomType(id, raw) {
  const typeId = String(id || "").trim();
  if (!typeId) badRequest("Stateroom type id is required.");
  const existing = await findById(typeId);
  if (!existing) {
    const err = new Error("Stateroom type not found.");
    err.statusCode = 404;
    err.calm = true;
    throw err;
  }
  const payload = sanitizePayload({ ...existing, ...(raw && typeof raw === "object" ? raw : {}) });
  const duplicate = await findDuplicate(payload.normalized_name, typeId);
  if (duplicate) badRequest("A stateroom type with this name already exists.");
  try {
    const rows = await supabase(`stateroom_types?id=eq.${encodeURIComponent(typeId)}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: payload
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row?.id) throw new Error("Stateroom type was not returned after update.");
    return row;
  } catch (error) {
    if (/duplicate|unique/i.test(String(error.message || ""))) {
      badRequest("A stateroom type with this name already exists.");
    }
    throw error;
  }
}

async function deleteStateroomType(id) {
  const typeId = String(id || "").trim();
  if (!typeId) badRequest("Stateroom type id is required.");
  const existing = await findById(typeId);
  if (!existing) {
    const err = new Error("Stateroom type not found.");
    err.statusCode = 404;
    err.calm = true;
    throw err;
  }
  const inUse = await isStateroomTypeInUse(existing);
  if (inUse) {
    badRequest(
      "This stateroom type is already used in cruise pricing and cannot be deleted. You can make it inactive instead."
    );
  }
  await supabase(`stateroom_types?id=eq.${encodeURIComponent(typeId)}`, {
    method: "DELETE",
    prefer: "return=minimal"
  });
  return existing;
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(204, {});
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").trim();

    if (action === "list") {
      const stateroom_types = await listStateroomTypes();
      return jsonResponse(200, { success: true, stateroom_types, count: stateroom_types.length });
    }

    if (action === "create") {
      const stateroom_type = await createStateroomType(body.stateroom_type);
      return jsonResponse(200, { success: true, stateroom_type, created: true });
    }

    if (action === "update") {
      const stateroom_type = await updateStateroomType(body.id, body.stateroom_type);
      return jsonResponse(200, { success: true, stateroom_type });
    }

    if (action === "delete") {
      const stateroom_type = await deleteStateroomType(body.id);
      return jsonResponse(200, { success: true, stateroom_type, deleted: true });
    }

    if (action === "check_usage") {
      const existing = await findById(body.id);
      if (!existing) badRequest("Stateroom type not found.");
      const in_use = await isStateroomTypeInUse(existing);
      return jsonResponse(200, { success: true, in_use });
    }

    return jsonResponse(400, { success: false, error: "Unknown action" });
  } catch (error) {
    const statusCode = error.statusCode || (/calm/.test(String(error.calm)) ? 400 : 500);
    return jsonResponse(statusCode, {
      success: false,
      error: error.message || "Stateroom types request failed."
    });
  }
};

exports.__test__ = {
  trimName,
  normalizeName,
  sanitizePayload,
  isStateroomTypeInUse
};
