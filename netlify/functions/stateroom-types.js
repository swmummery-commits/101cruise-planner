/**
 * Admin Stateroom Types reference — list / create / update / delete.
 *
 * POST /.netlify/functions/stateroom-types
 * Body:
 *   { action: "list" }
 *   { action: "create", stateroom_type: { name, is_active } }
 *   { action: "update", id, stateroom_type: { name, is_active } }
 *   { action: "reorder", ordered_ids: ["uuid", ...] }
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

function sanitizeNameFields(raw) {
  const body = raw && typeof raw === "object" ? raw : {};
  const name = trimName(body.name);
  if (!name) badRequest("Stateroom type name is required.");
  return {
    name,
    normalized_name: normalizeName(name),
    is_active: body.is_active !== false
  };
}

async function nextDisplayOrderValue() {
  const rows = await listStateroomTypes();
  if (!rows.length) return 10;
  const max = rows.reduce(
    (acc, row) => Math.max(acc, parseDisplayOrder(row?.display_order, 0)),
    0
  );
  return max + 10;
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
  const fields = sanitizeNameFields(raw);
  const duplicate = await findDuplicate(fields.normalized_name);
  if (duplicate) badRequest("A stateroom type with this name already exists.");
  const payload = {
    ...fields,
    display_order: await nextDisplayOrderValue()
  };
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
  const fields = sanitizeNameFields({ ...existing, ...(raw && typeof raw === "object" ? raw : {}) });
  const duplicate = await findDuplicate(fields.normalized_name, typeId);
  if (duplicate) badRequest("A stateroom type with this name already exists.");
  const payload = {
    ...fields,
    display_order: existing.display_order
  };
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

async function reorderStateroomTypes(orderedIds) {
  const ids = Array.isArray(orderedIds)
    ? orderedIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (!ids.length) badRequest("Reorder requires at least one stateroom type.");
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) badRequest("Reorder list contains duplicate ids.");
    seen.add(id);
  }

  const existing = await listStateroomTypes();
  const existingIds = new Set(existing.map((row) => row.id));
  if (ids.length !== existing.length) {
    badRequest("Reorder must include every stateroom type.");
  }
  for (const id of ids) {
    if (!existingIds.has(id)) badRequest("Reorder includes an unknown stateroom type.");
  }

  const updates = ids.map((id, index) =>
    supabase(`stateroom_types?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { display_order: (index + 1) * 10 }
    })
  );
  await Promise.all(updates);
  return listStateroomTypes();
}

async function listLineAllocations() {
  const rows = await supabase(
    "cruise_line_stateroom_types?select=cruise_line_id,stateroom_type_id&limit=5000"
  );
  const allocations = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const lineId = String(row?.cruise_line_id || "").trim();
    const typeId = String(row?.stateroom_type_id || "").trim();
    if (!lineId || !typeId) continue;
    if (!allocations[lineId]) allocations[lineId] = [];
    allocations[lineId].push(typeId);
  }
  return allocations;
}

async function saveLineAllocations(cruiseLineId, stateroomTypeIds) {
  const lineId = String(cruiseLineId || "").trim();
  if (!lineId) badRequest("Cruise line id is required.");

  const lineRows = await supabase(
    `ci_cruise_lines?select=id&id=eq.${encodeURIComponent(lineId)}&limit=1`
  );
  if (!Array.isArray(lineRows) || !lineRows[0]) badRequest("Cruise line not found.");

  const ids = Array.isArray(stateroomTypeIds)
    ? [...new Set(stateroomTypeIds.map((id) => String(id || "").trim()).filter(Boolean))]
    : [];

  if (ids.length) {
    const typeRows = await supabase(
      `stateroom_types?select=id&is_active=eq.true&id=in.(${ids.map(encodeURIComponent).join(",")})`
    );
    const validIds = new Set((Array.isArray(typeRows) ? typeRows : []).map((row) => String(row.id)));
    for (const id of ids) {
      if (!validIds.has(id)) badRequest("One or more selected stateroom types are invalid or inactive.");
    }
  }

  await supabase(`cruise_line_stateroom_types?cruise_line_id=eq.${encodeURIComponent(lineId)}`, {
    method: "DELETE",
    prefer: "return=minimal"
  });

  if (ids.length) {
    await supabase("cruise_line_stateroom_types", {
      method: "POST",
      prefer: "return=minimal",
      body: ids.map((stateroom_type_id) => ({ cruise_line_id: lineId, stateroom_type_id }))
    });
  }

  return listLineAllocations();
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

    if (action === "reorder") {
      const stateroom_types = await reorderStateroomTypes(body.ordered_ids);
      return jsonResponse(200, { success: true, stateroom_types, reordered: true });
    }

    if (action === "list_line_allocations") {
      const allocations = await listLineAllocations();
      return jsonResponse(200, { success: true, allocations });
    }

    if (action === "save_line_allocations") {
      const allocations = await saveLineAllocations(body.cruise_line_id, body.stateroom_type_ids);
      return jsonResponse(200, { success: true, allocations });
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
  sanitizeNameFields,
  isStateroomTypeInUse
};
