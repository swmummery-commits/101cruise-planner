/**
 * Admin helper — geocode Ports rows missing latitude/longitude via Nominatim.
 *
 * POST /.netlify/functions/geocode-ports
 * Body: { port_ids: string[] }
 *
 * Updates public.ports.latitude / longitude when a place match is found.
 * Rate-limited (~1 req/sec) to respect Nominatim usage policy.
 */

const { requireAdmin } = require("./admin-auth");

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "101cruise-admin/1.0 (port geocoding; paul@101cruise.com.au)";

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
      (data && (data.message || data.error || data.hint)) ||
      text ||
      `Supabase HTTP ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildQuery(port) {
  const city = String(port.city || port.canonical_name || port.display_name || "").trim();
  const country = String(port.country || "").trim();
  if (city && country) return `${city}, ${country}`;
  return city || country || String(port.display_name || "").trim();
}

async function geocodePlace(query) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT
    }
  });
  if (!response.ok) {
    throw new Error(`Nominatim HTTP ${response.status}`);
  }
  const rows = await response.json();
  const hit = Array.isArray(rows) ? rows[0] : null;
  if (!hit) return null;
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { latitude: lat, longitude: lng, display_name: hit.display_name || query };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  try {
    await requireAdmin(event);
  } catch (error) {
    return jsonResponse(error.statusCode || 401, {
      ok: false,
      error: error.code || "unauthorized",
      message: error.message || "Admin authentication required."
    });
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid_json" });
  }

  const ids = Array.isArray(body.port_ids)
    ? [...new Set(body.port_ids.map((id) => String(id || "").trim()).filter(Boolean))]
    : [];
  if (!ids.length) {
    return jsonResponse(400, { ok: false, error: "port_ids_required" });
  }
  if (ids.length > 40) {
    return jsonResponse(400, { ok: false, error: "too_many_ports", message: "Geocode at most 40 ports per request." });
  }

  try {
    const filter = ids.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
    const rows = await supabase(
      `ports?id=in.(${filter})&select=id,canonical_name,display_name,city,country,latitude,longitude`
    );
    const byId = new Map((rows || []).map((row) => [row.id, row]));
    const results = [];

    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      const port = byId.get(id);
      if (!port) {
        results.push({ id, ok: false, error: "not_found" });
        continue;
      }
      if (port.latitude != null && port.longitude != null) {
        results.push({
          id,
          ok: true,
          skipped: true,
          latitude: Number(port.latitude),
          longitude: Number(port.longitude)
        });
        continue;
      }

      const query = buildQuery(port);
      if (!query) {
        results.push({ id, ok: false, error: "empty_query" });
        continue;
      }

      try {
        if (i > 0) await sleep(1100);
        const hit = await geocodePlace(query);
        if (!hit) {
          results.push({ id, ok: false, error: "no_match", query });
          continue;
        }
        const updated = await supabase(`ports?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: {
            latitude: hit.latitude,
            longitude: hit.longitude,
            updated_at: new Date().toISOString()
          },
          prefer: "return=representation"
        });
        const row = Array.isArray(updated) ? updated[0] : updated;
        results.push({
          id,
          ok: true,
          latitude: hit.latitude,
          longitude: hit.longitude,
          query,
          geocode_label: hit.display_name,
          port: row || null
        });
      } catch (error) {
        results.push({
          id,
          ok: false,
          error: "geocode_failed",
          message: String(error.message || error).slice(0, 200),
          query
        });
      }
    }

    const updated = results.filter((r) => r.ok && !r.skipped).length;
    const failed = results.filter((r) => !r.ok).length;
    return jsonResponse(200, {
      ok: failed === 0,
      updated,
      failed,
      results
    });
  } catch (error) {
    console.error("geocode-ports error", error.message || error);
    return jsonResponse(500, {
      ok: false,
      error: "geocode_ports_failed",
      message: String(error.message || error).slice(0, 240)
    });
  }
};
