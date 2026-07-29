/**
 * Admin Ports catalogue access via service role.
 * Avoids browser → ports RLS failures when matching / creating provisional ports.
 *
 * POST /.netlify/functions/ports-catalogue
 * Body:
 *   { action: "list" }
 *   { action: "create_provisional", port: { ... } }
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

const PORT_SELECT =
  "id,canonical_name,display_name,city,country,country_code,region,latitude,longitude,aliases,status,match_key,source,source_featured_cruise_id";

async function listPorts() {
  const rows = await supabase(
    `ports?select=${encodeURIComponent(PORT_SELECT)}&order=canonical_name.asc&limit=2000`
  );
  return Array.isArray(rows) ? rows : [];
}

function sanitizeProvisional(bodyPort) {
  const raw = bodyPort && typeof bodyPort === "object" ? bodyPort : {};
  const canonical = String(raw.canonical_name || "").trim();
  if (!canonical) {
    const err = new Error("canonical_name is required");
    err.statusCode = 400;
    err.calm = true;
    throw err;
  }
  const country = String(raw.country || "").trim() || null;
  const matchKey = String(raw.match_key || "").trim() || null;
  const featuredId = String(raw.source_featured_cruise_id || "").trim() || null;
  let aliases = [];
  if (Array.isArray(raw.aliases)) {
    aliases = raw.aliases.map((a) => String(a || "").trim()).filter(Boolean);
  }
  return {
    canonical_name: canonical,
    display_name: String(raw.display_name || canonical).trim() || canonical,
    city: String(raw.city || canonical).trim() || canonical,
    country,
    aliases,
    status: "provisional",
    source: String(raw.source || "featured_cruise_itinerary").trim() || "featured_cruise_itinerary",
    source_featured_cruise_id: featuredId,
    match_key: matchKey,
    latitude: null,
    longitude: null
  };
}

async function findByMatchKey(matchKey) {
  if (!matchKey) return null;
  const rows = await supabase(
    `ports?select=${encodeURIComponent(PORT_SELECT)}&match_key=eq.${encodeURIComponent(matchKey)}&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function createProvisional(bodyPort) {
  const payload = sanitizeProvisional(bodyPort);
  if (payload.match_key) {
    const existing = await findByMatchKey(payload.match_key);
    if (existing) return { port: existing, created: false };
  }
  try {
    const rows = await supabase("ports", {
      method: "POST",
      prefer: "return=representation",
      body: payload
    });
    const port = Array.isArray(rows) ? rows[0] : rows;
    if (!port?.id) {
      throw new Error("Port was not returned after create.");
    }
    return { port, created: true };
  } catch (error) {
    if (/duplicate|unique/i.test(String(error.message || ""))) {
      const existing = await findByMatchKey(payload.match_key);
      if (existing) return { port: existing, created: false };
    }
    throw error;
  }
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
      const ports = await listPorts();
      return jsonResponse(200, {
        success: true,
        ports,
        count: ports.length
      });
    }

    if (action === "create_provisional") {
      const result = await createProvisional(body.port);
      return jsonResponse(200, {
        success: true,
        port: result.port,
        created: result.created
      });
    }

    return jsonResponse(400, { success: false, error: "Unknown action" });
  } catch (error) {
    const status = Number(error.statusCode) || (error.calm ? 400 : 500);
    const message =
      status === 401 || status === 403 || error.calm
        ? error.message || "Not authorised"
        : error.message && !/supabase|http \d+/i.test(error.message)
          ? error.message
          : "Could not access the Ports catalogue. Please try again.";
    return jsonResponse(status, {
      success: false,
      error: message
    });
  }
};
