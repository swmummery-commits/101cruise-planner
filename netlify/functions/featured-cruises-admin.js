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

function missingColumnMatch(message) {
  const match = String(message || "").match(/Could not find the '([^']+)' column of 'featured_cruises'/i);
  return match?.[1] || null;
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

async function replacePricing({ featuredCruiseId, pricing }) {
  const cruiseId = String(featuredCruiseId || "").trim();
  if (!cruiseId) throw Object.assign(new Error("featured_cruise_id is required."), { statusCode: 400 });

  await supabase(`featured_cruise_pricing?featured_cruise_id=eq.${encodeURIComponent(cruiseId)}`, {
    method: "DELETE",
    prefer: "return=minimal"
  });

  const rows = Array.isArray(pricing) ? pricing : [];
  if (!rows.length) return { inserted: 0 };

  const payload = rows.map((row) => {
    const copy = { ...(row && typeof row === "object" ? row : {}) };
    delete copy.id;
    return { ...copy, featured_cruise_id: cruiseId };
  });

  await supabase("featured_cruise_pricing", {
    method: "POST",
    body: payload,
    prefer: "return=minimal"
  });
  return { inserted: payload.length };
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
        pricing: body.pricing
      });
      return jsonResponse(200, { success: true, ...result });
    }

    if (action === "patch_cruise") {
      const result = await patchCruise({ id: body.id, patch: body.patch });
      return jsonResponse(200, { success: true, ...result });
    }

    return jsonResponse(400, { success: false, error: "Unknown action" });
  } catch (error) {
    console.error("featured-cruises-admin error", error);
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || "Could not save featured cruise"
    });
  }
};

module.exports.saveCruiseRow = saveCruiseRow;
module.exports.replacePricing = replacePricing;
module.exports.patchCruise = patchCruise;
