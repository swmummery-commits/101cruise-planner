/**
 * Admin Ports catalogue access via service role.
 * Avoids browser → ports RLS failures when matching / creating provisional ports.
 *
 * POST /.netlify/functions/ports-catalogue
 * Body:
 *   { action: "list" }
 *   { action: "create_provisional", port: { ... } }
 *   { action: "create", port: { ... } }
 *   { action: "update", id, port: { ... } }
 *   { action: "delete", id }
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
  "id,canonical_name,display_name,city,country,country_code,region,latitude,longitude,aliases,status,match_key,source,source_url,source_featured_cruise_id,verified_at,created_at,updated_at";

const ALLOWED_STATUS = new Set(["verified", "provisional", "needs_review"]);

function stripDiacritics(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizePortText(value) {
  let text = stripDiacritics(value);
  text = text.toLowerCase();
  text = text.replace(/[’']/g, "");
  text = text.replace(/&/g, " and ");
  text = text.replace(/[./\\_+]+/g, " ");
  text = text.replace(/[^\w\s(),-]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function buildMatchKey(canonicalName, country) {
  const name = normalizePortText(canonicalName);
  const ctry = normalizePortText(country);
  if (!name) return "";
  return ctry ? `${name}|${ctry}` : `${name}|`;
}

function parseAliases(raw) {
  if (Array.isArray(raw)) {
    return raw.map((a) => String(a || "").trim()).filter(Boolean);
  }
  return String(raw || "")
    .split(/[|,]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

function parseCoord(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.calm = true;
  throw err;
}

async function listPorts() {
  const rows = await supabase(
    `ports?select=${encodeURIComponent(PORT_SELECT)}&order=canonical_name.asc&limit=2000`
  );
  return Array.isArray(rows) ? rows : [];
}

function sanitizeProvisional(bodyPort) {
  const raw = bodyPort && typeof bodyPort === "object" ? bodyPort : {};
  const canonical = String(raw.canonical_name || "").trim();
  if (!canonical) badRequest("canonical_name is required");
  const country = String(raw.country || "").trim() || null;
  const matchKey = String(raw.match_key || "").trim() || buildMatchKey(canonical, country || "");
  const featuredId = String(raw.source_featured_cruise_id || "").trim() || null;
  return {
    canonical_name: canonical,
    display_name: String(raw.display_name || canonical).trim() || canonical,
    city: String(raw.city || canonical).trim() || canonical,
    country,
    aliases: parseAliases(raw.aliases),
    status: "provisional",
    source: String(raw.source || "featured_cruise_itinerary").trim() || "featured_cruise_itinerary",
    source_featured_cruise_id: featuredId,
    match_key: matchKey || null,
    latitude: null,
    longitude: null
  };
}

function sanitizePortFields(bodyPort, { requireCanonical = true } = {}) {
  const raw = bodyPort && typeof bodyPort === "object" ? bodyPort : {};
  const canonical = String(raw.canonical_name || "").trim();
  if (requireCanonical && !canonical) badRequest("Canonical name is required.");

  const country = String(raw.country || "").trim() || null;
  const statusRaw = String(raw.status || "provisional").trim();
  if (!ALLOWED_STATUS.has(statusRaw)) badRequest("Status must be verified, provisional, or needs_review.");

  const latitude = parseCoord(raw.latitude);
  const longitude = parseCoord(raw.longitude);
  if (latitude != null && (latitude < -90 || latitude > 90)) badRequest("Latitude must be between -90 and 90.");
  if (longitude != null && (longitude < -180 || longitude > 180)) {
    badRequest("Longitude must be between -180 and 180.");
  }

  const displayName = String(raw.display_name || "").trim() || canonical || null;
  const city = String(raw.city || "").trim() || null;
  const countryCode = String(raw.country_code || "")
    .trim()
    .toUpperCase()
    .slice(0, 3) || null;
  const region = String(raw.region || "").trim() || null;
  const source = String(raw.source || "admin").trim() || "admin";
  const sourceUrl = String(raw.source_url || "").trim() || null;
  const aliases = parseAliases(raw.aliases);
  const matchKey = buildMatchKey(canonical || displayName || "", country || "");

  const payload = {
    canonical_name: canonical,
    display_name: displayName,
    city,
    country,
    country_code: countryCode,
    region,
    latitude,
    longitude,
    aliases,
    status: statusRaw,
    source,
    source_url: sourceUrl,
    match_key: matchKey || null
  };

  if (statusRaw === "verified") {
    payload.verified_at = new Date().toISOString();
  }

  return payload;
}

async function findByMatchKey(matchKey) {
  if (!matchKey) return null;
  const rows = await supabase(
    `ports?select=${encodeURIComponent(PORT_SELECT)}&match_key=eq.${encodeURIComponent(matchKey)}&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function findById(id) {
  const rows = await supabase(
    `ports?select=${encodeURIComponent(PORT_SELECT)}&id=eq.${encodeURIComponent(id)}&limit=1`
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

async function createPort(bodyPort) {
  const payload = sanitizePortFields(bodyPort, { requireCanonical: true });
  if (payload.match_key) {
    const existing = await findByMatchKey(payload.match_key);
    if (existing) {
      badRequest(
        `A port with the same match key already exists (“${existing.display_name || existing.canonical_name}”).`
      );
    }
  }
  try {
    const rows = await supabase("ports", {
      method: "POST",
      prefer: "return=representation",
      body: payload
    });
    const port = Array.isArray(rows) ? rows[0] : rows;
    if (!port?.id) throw new Error("Port was not returned after create.");
    return port;
  } catch (error) {
    if (/duplicate|unique/i.test(String(error.message || ""))) {
      badRequest("A port with that name/country already exists.");
    }
    throw error;
  }
}

async function updatePort(id, bodyPort) {
  const portId = String(id || "").trim();
  if (!portId) badRequest("Port id is required.");
  const existing = await findById(portId);
  if (!existing) {
    const err = new Error("Port not found.");
    err.statusCode = 404;
    err.calm = true;
    throw err;
  }

  const payload = sanitizePortFields(
    {
      ...existing,
      ...(bodyPort && typeof bodyPort === "object" ? bodyPort : {})
    },
    { requireCanonical: true }
  );

  // Keep verified_at if already verified and status stays verified.
  if (payload.status === "verified" && existing.verified_at && existing.status === "verified") {
    payload.verified_at = existing.verified_at;
  }
  if (payload.status !== "verified") {
    payload.verified_at = null;
  }

  if (payload.match_key) {
    const clash = await findByMatchKey(payload.match_key);
    if (clash && clash.id !== portId) {
      badRequest(
        `Another port already uses that name/country (“${clash.display_name || clash.canonical_name}”).`
      );
    }
  }

  try {
    const rows = await supabase(`ports?id=eq.${encodeURIComponent(portId)}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: payload
    });
    const port = Array.isArray(rows) ? rows[0] : rows;
    if (!port?.id) throw new Error("Port was not returned after update.");
    return port;
  } catch (error) {
    if (/duplicate|unique/i.test(String(error.message || ""))) {
      badRequest("A port with that name/country already exists.");
    }
    throw error;
  }
}

async function deletePort(id) {
  const portId = String(id || "").trim();
  if (!portId) badRequest("Port id is required.");
  const existing = await findById(portId);
  if (!existing) {
    const err = new Error("Port not found.");
    err.statusCode = 404;
    err.calm = true;
    throw err;
  }
  await supabase(`ports?id=eq.${encodeURIComponent(portId)}`, {
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

    if (action === "create") {
      const port = await createPort(body.port);
      return jsonResponse(200, { success: true, port, created: true });
    }

    if (action === "update") {
      const port = await updatePort(body.id, body.port);
      return jsonResponse(200, { success: true, port });
    }

    if (action === "delete") {
      const port = await deletePort(body.id);
      return jsonResponse(200, {
        success: true,
        deleted: true,
        id: port.id,
        name: port.display_name || port.canonical_name
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
