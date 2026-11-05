/**
 * Admin Featured Cruises — service-role writes after JWT admin check.
 *
 * POST /.netlify/functions/featured-cruises-admin
 * Body:
 *   { action: "save_cruise", id?, cruise: {...}, user_id? }
 *   { action: "replace_pricing", featured_cruise_id, pricing: [...] }
 *   { action: "patch_cruise", id, patch: {...} }
 */

const { requireAdmin } = require("./admin-auth");
const { planPricingReplacement } = require("./lib/pricing-replace-plan");
const { executeCruiseSaveBundle } = require("./lib/cruise-save-bundle");

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

function missingColumnMatch(message, table = "featured_cruises") {
  const match = String(message || "").match(
    new RegExp(`Could not find the '([^']+)' column of '${table}'`, "i")
  );
  return match?.[1] || null;
}

function isMissingClientKeyColumn(error) {
  return missingColumnMatch(error?.message, "featured_cruises") === "editor_client_key";
}

function isDuplicateClientKey(error) {
  const text = String(error?.message || "");
  return /editor_client_key/i.test(text) && /duplicate|unique/i.test(text);
}

async function saveCruiseRow({ id, cruise, userId }) {
  const stripped = [];
  let working = { ...(cruise && typeof cruise === "object" ? cruise : {}) };
  if (userId) working.updated_by = userId;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      if (id) {
        const rows = await supabase(`featured_cruises?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: working,
          prefer: "return=representation"
        });
        const saved = Array.isArray(rows) ? rows[0] : rows;
        if (!saved?.id) throw new Error("Featured cruise update returned no row.");
        return { cruise: saved, stripped };
      }

      const insertPayload = { ...working, created_by: userId || working.created_by || null };
      const rows = await supabase("featured_cruises", {
        method: "POST",
        body: insertPayload,
        prefer: "return=representation"
      });
      const saved = Array.isArray(rows) ? rows[0] : rows;
      if (!saved?.id) throw new Error("Featured cruise insert returned no row.");
      return { cruise: saved, stripped };
    } catch (error) {
      const missing = missingColumnMatch(error.message);
      if (missing && Object.prototype.hasOwnProperty.call(working, missing)) {
        delete working[missing];
        stripped.push(missing);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not save cruise because required database columns are missing.");
}

async function replacePricing({ featuredCruiseId, pricing, preserveExistingIfEmpty = false }) {
  const cruiseId = String(featuredCruiseId || "").trim();
  if (!cruiseId) throw Object.assign(new Error("featured_cruise_id is required."), { statusCode: 400 });

  const existing = await supabase(
    `featured_cruise_pricing?featured_cruise_id=eq.${encodeURIComponent(cruiseId)}&select=id`,
    { method: "GET", prefer: "return=representation" }
  );
  const plan = planPricingReplacement({
    existingIds: Array.isArray(existing) ? existing : [],
    incomingRows: Array.isArray(pricing) ? pricing : [],
    preserveExistingIfEmpty: Boolean(preserveExistingIfEmpty)
  });
  if (plan.mode === "preserve") {
    return { inserted: 0, preserved: true, deleted: 0 };
  }

  const insertPayload = plan.insert.map((row) => ({ ...row, featured_cruise_id: cruiseId }));
  let insertedRows = [];
  if (insertPayload.length) {
    const created = await supabase("featured_cruise_pricing", {
      method: "POST",
      body: insertPayload,
      prefer: "return=representation"
    });
    insertedRows = Array.isArray(created) ? created : created ? [created] : [];
  }

  if (!plan.deleteIds.length) {
    return { inserted: insertPayload.length, preserved: false, deleted: 0 };
  }

  const deleteFilter = plan.deleteIds.map((id) => encodeURIComponent(id)).join(",");
  try {
    await supabase(`featured_cruise_pricing?id=in.(${deleteFilter})`, {
      method: "DELETE",
      prefer: "return=minimal"
    });
  } catch (error) {
    const newIds = insertedRows.map((row) => row?.id).filter(Boolean);
    if (newIds.length) {
      const rollbackFilter = newIds.map((id) => encodeURIComponent(id)).join(",");
      await supabase(`featured_cruise_pricing?id=in.(${rollbackFilter})`, {
        method: "DELETE",
        prefer: "return=minimal"
      }).catch(() => {});
    }
    throw error;
  }

  return { inserted: insertPayload.length, preserved: false, deleted: plan.deleteIds.length };
}

async function withMissingColumnRetry(table, payload, write) {
  let working = { ...(payload || {}) };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await write(working);
    } catch (error) {
      const missing = missingColumnMatch(error.message, table);
      if (missing && Object.prototype.hasOwnProperty.call(working, missing)) {
        delete working[missing];
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not write ${table} because required database columns are missing.`);
}

async function insertRows(table, rows) {
  let working = (rows || []).map((row) => ({ ...row }));
  if (!working.length) return [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const created = await supabase(table, {
        method: "POST",
        body: working,
        prefer: "return=representation"
      });
      return Array.isArray(created) ? created : created ? [created] : [];
    } catch (error) {
      const missing = missingColumnMatch(error.message, table);
      if (!missing) throw error;
      let removed = false;
      working = working.map((row) => {
        if (!Object.prototype.hasOwnProperty.call(row, missing)) return row;
        const copy = { ...row };
        delete copy[missing];
        removed = true;
        return copy;
      });
      if (!removed) throw error;
    }
  }
  throw new Error(`Could not write ${table} because required database columns are missing.`);
}

async function findCruiseByClientKey(clientSaveKey) {
  const key = String(clientSaveKey || "").trim();
  if (!key) return null;
  try {
    const rows = await supabase(
      `featured_cruises?editor_client_key=eq.${encodeURIComponent(key)}&select=*&limit=1`,
      { method: "GET" }
    );
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    if (isMissingClientKeyColumn(error)) return null;
    throw error;
  }
}

function bundleIo() {
  return {
    findCruiseByClientKey,
    getCruise: async (id) => {
      const rows = await supabase(`featured_cruises?id=eq.${encodeURIComponent(id)}&select=*`, {
        method: "GET"
      });
      return Array.isArray(rows) ? rows[0] || null : null;
    },
    saveCruise: async ({ id, cruise, userId, clientSaveKey }) => {
      const body = { ...(cruise || {}) };
      if (clientSaveKey) body.editor_client_key = clientSaveKey;
      try {
        const result = await saveCruiseRow({ id: id || null, cruise: body, userId });
        return { row: result.cruise, created: !id, stripped: result.stripped || [] };
      } catch (error) {
        if (!id && clientSaveKey && isDuplicateClientKey(error)) {
          const existing = await findCruiseByClientKey(clientSaveKey);
          if (existing?.id) {
            const result = await saveCruiseRow({ id: existing.id, cruise: body, userId });
            return { row: result.cruise, created: false, stripped: result.stripped || [] };
          }
        }
        if (!id && clientSaveKey && isMissingClientKeyColumn(error)) {
          delete body.editor_client_key;
          const result = await saveCruiseRow({ id: null, cruise: body, userId });
          return { row: result.cruise, created: true, stripped: result.stripped || [] };
        }
        throw error;
      }
    },
    updateCruise: async (id, patch) => {
      const result = await saveCruiseRow({ id, cruise: patch, userId: null });
      return result.cruise;
    },
    deleteCruise: async (id) => {
      await supabase(`featured_cruises?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        prefer: "return=minimal"
      });
    },
    listPricing: async (cruiseId) => {
      const rows = await supabase(
        `featured_cruise_pricing?featured_cruise_id=eq.${encodeURIComponent(cruiseId)}&select=*&order=display_order.asc`,
        { method: "GET" }
      );
      return Array.isArray(rows) ? rows : [];
    },
    insertPricing: async (rows) => insertRows("featured_cruise_pricing", rows),
    updatePricing: async (id, patch) => {
      return withMissingColumnRetry("featured_cruise_pricing", patch, async (body) => {
        const rows = await supabase(`featured_cruise_pricing?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          body,
          prefer: "return=representation"
        });
        return Array.isArray(rows) ? rows[0] : rows;
      });
    },
    deletePricing: async (ids) => {
      const list = (ids || []).filter(Boolean);
      if (!list.length) return;
      const filter = list.map((id) => encodeURIComponent(id)).join(",");
      await supabase(`featured_cruise_pricing?id=in.(${filter})`, {
        method: "DELETE",
        prefer: "return=minimal"
      });
    },
    listStops: async (cruiseId) => {
      const rows = await supabase(
        `featured_cruise_itinerary_stops?featured_cruise_id=eq.${encodeURIComponent(cruiseId)}&select=*&order=display_order.asc`,
        { method: "GET" }
      );
      return Array.isArray(rows) ? rows : [];
    },
    insertStops: async (rows) => insertRows("featured_cruise_itinerary_stops", rows),
    deleteStops: async (ids) => {
      const list = (ids || []).filter(Boolean);
      if (!list.length) return;
      const filter = list.map((id) => encodeURIComponent(id)).join(",");
      await supabase(`featured_cruise_itinerary_stops?id=in.(${filter})`, {
        method: "DELETE",
        prefer: "return=minimal"
      });
    }
  };
}

async function saveBundle(body, user) {
  const result = await executeCruiseSaveBundle({
    io: bundleIo(),
    id: body.id || null,
    cruise: body.cruise,
    pricing: body.pricing,
    stops: body.stops,
    userId: body.user_id || user?.id || null,
    preserveExistingIfEmpty: Boolean(body.preserve_existing_if_empty),
    clientSaveKey: body.client_save_key || null
  });
  return result;
}

async function patchCruise({ id, patch }) {
  const cruiseId = String(id || "").trim();
  if (!cruiseId) throw Object.assign(new Error("id is required."), { statusCode: 400 });
  const rows = await supabase(`featured_cruises?id=eq.${encodeURIComponent(cruiseId)}`, {
    method: "PATCH",
    body: patch && typeof patch === "object" ? patch : {},
    prefer: "return=representation"
  });
  const saved = Array.isArray(rows) ? rows[0] : rows;
  if (!saved?.id) throw new Error("Featured cruise patch returned no row.");
  return { cruise: saved };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, {});
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const user = await requireAdmin(event);
    const body = event.body ? JSON.parse(event.body) : {};
    const action = String(body.action || "").trim();

    if (action === "save_cruise") {
      const result = await saveCruiseRow({
        id: body.id || null,
        cruise: body.cruise,
        userId: body.user_id || user.id || null
      });
      return jsonResponse(200, { success: true, ...result });
    }

    if (action === "replace_pricing") {
      const result = await replacePricing({
        featuredCruiseId: body.featured_cruise_id,
        pricing: body.pricing,
        preserveExistingIfEmpty: Boolean(body.preserve_existing_if_empty)
      });
      return jsonResponse(200, { success: true, ...result });
    }

    if (action === "patch_cruise") {
      const result = await patchCruise({ id: body.id, patch: body.patch });
      return jsonResponse(200, { success: true, ...result });
    }

    if (action === "save_bundle") {
      const result = await saveBundle(body, user);
      return jsonResponse(200, { success: true, ...result });
    }

    return jsonResponse(400, { success: false, error: "Unknown action" });
  } catch (error) {
    console.error("featured-cruises-admin error", error);
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || "Could not save featured cruise",
      failed_step: error.step || null,
      rolled_back: Boolean(error.rolledBack),
      cruise_id: error.cruiseId || null,
      updated_at: error.updatedAt || null
    });
  }
};

module.exports.saveCruiseRow = saveCruiseRow;
module.exports.replacePricing = replacePricing;
module.exports.patchCruise = patchCruise;
module.exports.saveBundle = saveBundle;
