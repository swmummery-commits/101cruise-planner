/**
 * Admin cruise line feature catalogue — list / create / update / delete / reorder.
 *
 * POST /.netlify/functions/cruise-line-features
 */
const { requireAdmin } = require("./admin-auth");

const SELECT =
  "id,cruise_line_id,feature_type,name,normalized_name,description,icon_key,display_order,is_active,created_at,updated_at";
const FEATURE_TYPES = new Set(["exclusive_area", "specialty_feature"]);

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
  if (!url || !key) throw new Error("Supabase credentials are missing.");
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

function sanitizeFeatureFields(raw, { requireLine = true, requireType = true } = {}) {
  const body = raw && typeof raw === "object" ? raw : {};
  const cruise_line_id = trimName(body.cruise_line_id);
  const feature_type = trimName(body.feature_type);
  const name = trimName(body.name);
  if (requireLine && !cruise_line_id) badRequest("Cruise line id is required.");
  if (requireType && !FEATURE_TYPES.has(feature_type)) {
    badRequest("Feature type must be exclusive_area or specialty_feature.");
  }
  if (!name) badRequest("Feature name is required.");
  return {
    cruise_line_id: cruise_line_id || undefined,
    feature_type: feature_type || undefined,
    name,
    normalized_name: normalizeName(name),
    description: trimName(body.description) || null,
    icon_key: trimName(body.icon_key) || "sparkles",
    is_active: body.is_active !== false
  };
}

async function listFeaturesForLine(cruiseLineId) {
  const lineId = trimName(cruiseLineId);
  if (!lineId) badRequest("Cruise line id is required.");
  const rows = await supabase(
    `ci_cruise_line_features?select=${encodeURIComponent(SELECT)}&cruise_line_id=eq.${encodeURIComponent(lineId)}&order=display_order.asc,name.asc&limit=2000`
  );
  return Array.isArray(rows) ? rows : [];
}

async function findById(id) {
  const featureId = trimName(id);
  if (!featureId) return null;
  const rows = await supabase(
    `ci_cruise_line_features?select=${encodeURIComponent(SELECT)}&id=eq.${encodeURIComponent(featureId)}&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function findDuplicate(cruiseLineId, featureType, normalizedName, excludeId) {
  const lineId = trimName(cruiseLineId);
  const type = trimName(featureType);
  const key = normalizeName(normalizedName);
  if (!lineId || !type || !key) return null;
  const rows = await supabase(
    `ci_cruise_line_features?select=${encodeURIComponent(SELECT)}&cruise_line_id=eq.${encodeURIComponent(lineId)}&feature_type=eq.${encodeURIComponent(type)}&normalized_name=eq.${encodeURIComponent(key)}&limit=1`
  );
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row) return null;
  if (excludeId && row.id === excludeId) return null;
  return row;
}

async function nextDisplayOrderForType(cruiseLineId, featureType) {
  const rows = await listFeaturesForLine(cruiseLineId);
  const sameType = rows.filter((row) => row.feature_type === featureType);
  if (!sameType.length) return 10;
  const max = sameType.reduce(
    (acc, row) => Math.max(acc, parseDisplayOrder(row.display_order, 0)),
    0
  );
  return max + 10;
}

async function createFeature(raw) {
  const fields = sanitizeFeatureFields(raw);
  const duplicate = await findDuplicate(fields.cruise_line_id, fields.feature_type, fields.normalized_name);
  if (duplicate) badRequest("A feature with this name already exists for this line and type.");
  const payload = {
    ...fields,
    display_order: await nextDisplayOrderForType(fields.cruise_line_id, fields.feature_type),
    updated_at: new Date().toISOString()
  };
  try {
    const rows = await supabase("ci_cruise_line_features", {
      method: "POST",
      prefer: "return=representation",
      body: payload
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row?.id) throw new Error("Feature was not returned after create.");
    return row;
  } catch (error) {
    if (/duplicate|unique/i.test(String(error.message || ""))) {
      badRequest("A feature with this name already exists for this line and type.");
    }
    throw error;
  }
}

async function updateFeature(id, raw) {
  const featureId = trimName(id);
  if (!featureId) badRequest("Feature id is required.");
  const existing = await findById(featureId);
  if (!existing) {
    const err = new Error("Feature not found.");
    err.statusCode = 404;
    err.calm = true;
    throw err;
  }
  const incomingType =
    raw && typeof raw === "object" ? trimName(raw.feature_type) : "";
  const nextType = FEATURE_TYPES.has(incomingType) ? incomingType : existing.feature_type;
  const fields = sanitizeFeatureFields(
    { ...existing, ...(raw && typeof raw === "object" ? raw : {}), feature_type: nextType },
    { requireLine: false, requireType: false }
  );
  const duplicate = await findDuplicate(
    existing.cruise_line_id,
    nextType,
    fields.normalized_name,
    featureId
  );
  if (duplicate) badRequest("A feature with this name already exists for this line and type.");
  const payload = {
    name: fields.name,
    normalized_name: fields.normalized_name,
    description: fields.description,
    icon_key: fields.icon_key,
    is_active: fields.is_active,
    updated_at: new Date().toISOString()
  };
  if (nextType !== existing.feature_type) {
    payload.feature_type = nextType;
  }
  try {
    const rows = await supabase(`ci_cruise_line_features?id=eq.${encodeURIComponent(featureId)}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: payload
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row?.id) throw new Error("Feature was not returned after update.");
    return row;
  } catch (error) {
    if (/duplicate|unique/i.test(String(error.message || ""))) {
      badRequest("A feature with this name already exists for this line and type.");
    }
    throw error;
  }
}

async function deleteFeature(id) {
  const featureId = trimName(id);
  if (!featureId) badRequest("Feature id is required.");
  const existing = await findById(featureId);
  if (!existing) {
    const err = new Error("Feature not found.");
    err.statusCode = 404;
    err.calm = true;
    throw err;
  }
  await supabase(`ci_cruise_line_features?id=eq.${encodeURIComponent(featureId)}`, {
    method: "DELETE",
    prefer: "return=minimal"
  });
  return existing;
}

async function reorderFeatures(cruiseLineId, featureType, orderedIds) {
  const lineId = trimName(cruiseLineId);
  const type = trimName(featureType);
  if (!lineId) badRequest("Cruise line id is required.");
  if (!FEATURE_TYPES.has(type)) badRequest("Feature type must be exclusive_area or specialty_feature.");

  const ids = Array.isArray(orderedIds)
    ? orderedIds.map((id) => trimName(id)).filter(Boolean)
    : [];
  if (!ids.length) badRequest("Reorder requires at least one feature.");
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) badRequest("Reorder list contains duplicate ids.");
    seen.add(id);
  }

  const existing = (await listFeaturesForLine(lineId)).filter((row) => row.feature_type === type);
  const existingIds = new Set(existing.map((row) => row.id));
  if (ids.length !== existing.length) {
    badRequest("Reorder must include every feature of this type for the line.");
  }
  for (const id of ids) {
    if (!existingIds.has(id)) badRequest("Reorder includes an unknown feature.");
  }

  const updates = ids.map((id, index) =>
    supabase(`ci_cruise_line_features?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        display_order: (index + 1) * 10,
        updated_at: new Date().toISOString()
      }
    })
  );
  await Promise.all(updates);
  return listFeaturesForLine(lineId);
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, "POST, OPTIONS");
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "METHOD_NOT_ALLOWED" }, "POST, OPTIONS");
  }

  try {
    await requireAdmin(event);
  } catch (error) {
    return jsonResponse(error.statusCode || 401, {
      success: false,
      error: error.code || "UNAUTHORIZED",
      detail: error.message
    }, "POST, OPTIONS");
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_error) {
    return jsonResponse(400, { success: false, error: "INVALID_JSON" }, "POST, OPTIONS");
  }

  const action = trimName(body.action);
  try {
    if (action === "list") {
      const features = await listFeaturesForLine(body.cruise_line_id);
      return jsonResponse(200, { success: true, features }, "POST, OPTIONS");
    }
    if (action === "create") {
      const feature = await createFeature(body.feature || {});
      return jsonResponse(200, { success: true, feature }, "POST, OPTIONS");
    }
    if (action === "update") {
      const feature = await updateFeature(body.id, body.feature || {});
      return jsonResponse(200, { success: true, feature }, "POST, OPTIONS");
    }
    if (action === "delete") {
      const feature = await deleteFeature(body.id);
      return jsonResponse(200, { success: true, feature }, "POST, OPTIONS");
    }
    if (action === "reorder") {
      const features = await reorderFeatures(body.cruise_line_id, body.feature_type, body.ordered_ids);
      return jsonResponse(200, { success: true, features }, "POST, OPTIONS");
    }
    return jsonResponse(400, { success: false, error: "UNKNOWN_ACTION" }, "POST, OPTIONS");
  } catch (error) {
    const status = error.statusCode || 500;
    return jsonResponse(status, {
      success: false,
      error: error.calm ? "REQUEST_FAILED" : "SERVER_ERROR",
      detail: String(error.message || error)
    }, "POST, OPTIONS");
  }
};
