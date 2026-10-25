/**
 * Admin helper — resolve missing canonical port coordinates via Nominatim.
 *
 * POST /.netlify/functions/geocode-ports
 * Body:
 *   { port_ids: string[] }
 *   { featured_cruise_id: string }
 *   { all_missing: true, limit?: number, offset?: number }
 *
 * High-confidence matches are persisted to public.ports.
 * Ambiguous / suspicious ports are returned for review rather than guessed.
 * Rate-limited (~1 req/sec) to respect public Nominatim usage policy.
 */

const { requireAdmin } = require("./admin-auth");

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "101cruise-admin/1.1 (port geocoding; paul@101cruise.com.au)";
const MAX_PORTS = 40;

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
  if (options.body !== undefined && options.body !== null) headers["Content-Type"] = "application/json";
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
    const detail = (data && (data.message || data.error || data.hint)) || text || `Supabase HTTP ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function aliases(port) {
  return Array.isArray(port?.aliases) ? port.aliases.map((v) => String(v || "").trim()).filter(Boolean) : [];
}

function isSuspiciousPort(port) {
  const name = String(port?.canonical_name || port?.city || "").trim();
  if (!name) return "missing_name";
  if (name.length < 3) return "name_too_short";
  if (/\b(charter flight|flight to|airport transfer|at sea|sea day)\b/i.test(name)) return "non_port_text";
  if (!String(port?.country || "").trim() && name.length < 5) return "insufficient_location_context";
  return null;
}

function queryCandidates(port) {
  const country = String(port.country || "").trim();
  const names = [
    port.city,
    port.canonical_name,
    port.display_name,
    ...aliases(port)
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  const unique = [];
  for (const name of names) {
    const candidate = country && !norm(name).includes(norm(country)) ? `${name}, ${country}` : name;
    if (candidate && !unique.some((v) => norm(v) === norm(candidate))) unique.push(candidate);
  }
  return unique.slice(0, 5);
}

const COUNTRY_CODE_BY_NAME = {
  australia: "au",
  chile: "cl",
  "cook islands": "ck",
  "dominican republic": "do",
  "faroe islands": "fo",
  france: "fr",
  greece: "gr",
  indonesia: "id",
  ireland: "ie",
  japan: "jp",
  "new zealand": "nz",
  norway: "no",
  philippines: "ph",
  samoa: "ws",
  spain: "es",
  "united kingdom": "gb",
  "united states": "us",
  vietnam: "vn",
  hawaii: "us"
};

function countryCode(port) {
  const stored = String(port?.country_code || "").trim().toLowerCase();
  const inferred = COUNTRY_CODE_BY_NAME[norm(port?.country)] || "";
  // A stale importer code must not override an explicit country name.
  if (inferred && stored && inferred !== stored) return inferred;
  if (inferred) return inferred;
  return /^[a-z]{2}$/.test(stored) ? stored : "";
}

function candidateScore(port, hit, query) {
  const expectedCountry = norm(port.country);
  const expectedCode = countryCode(port);
  const hitAddress = hit?.address || {};
  const hitCountry = norm(hitAddress.country);
  const hitCode = String(hitAddress.country_code || "").toLowerCase();
  if (expectedCode && hitCode && expectedCode !== hitCode) return -1000;
  if (expectedCountry && hitCountry && expectedCountry !== hitCountry) {
    const equivalents = {
      "united states": ["usa", "united states of america", "hawaii"],
      hawaii: ["united states", "united states of america", "usa"],
      "united kingdom": ["uk", "great britain", "scotland", "england", "wales", "northern ireland"],
      scotland: ["united kingdom", "uk", "great britain"],
      england: ["united kingdom", "uk", "great britain"],
      "faroe islands": ["faroes"],
      "cook islands": ["cook islands"]
    };
    const allowed = equivalents[expectedCountry] || [];
    if (!allowed.includes(hitCountry)) return -1000;
  }

  const display = norm(hit.display_name);
  const names = [port.canonical_name, port.city, port.display_name, ...aliases(port)].map(norm).filter(Boolean);
  let score = 0;
  if (expectedCode && hitCode === expectedCode) score += 40;
  else if (expectedCountry && hitCountry === expectedCountry) score += 35;
  if (names.some((n) => display.includes(n))) score += 35;
  if (norm(query) && display.includes(norm(query).split(" ").slice(0, 2).join(" "))) score += 10;
  const type = norm(hit.type);
  const category = norm(hit.category);
  if (/harbour|port|pier|terminal|marina|ferry/.test(`${type} ${category}`)) score += 8;
  const importance = Number(hit.importance);
  if (Number.isFinite(importance)) score += Math.min(7, Math.max(0, importance * 10));
  return score;
}

async function geocodeQuery(port, query) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "1");
  const cc = countryCode(port);
  if (cc) url.searchParams.set("countrycodes", cc);

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT }
  });
  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
  const rows = await response.json();
  const candidates = (Array.isArray(rows) ? rows : [])
    .map((hit) => {
      const latitude = Number(hit.lat);
      const longitude = Number(hit.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return {
        latitude,
        longitude,
        display_name: hit.display_name || query,
        address: hit.address || {},
        category: hit.category || "",
        type: hit.type || "",
        importance: Number(hit.importance) || 0,
        score: candidateScore(port, hit, query)
      };
    })
    .filter(Boolean)
    .filter((hit) => hit.score > -1000)
    .sort((a, b) => b.score - a.score);
  return candidates;
}

async function resolvePort(port, { requestIndex = 0 } = {}) {
  const suspicious = isSuspiciousPort(port);
  if (suspicious) {
    return { ok: false, error: "needs_review", reason: suspicious };
  }

  const queries = queryCandidates(port);
  if (!queries.length) return { ok: false, error: "empty_query" };

  let best = null;
  let attempted = 0;
  for (const query of queries) {
    if (requestIndex > 0 || attempted > 0) await sleep(1100);
    attempted += 1;
    const hits = await geocodeQuery(port, query);
    const top = hits[0];
    if (top && (!best || top.score > best.score)) best = { ...top, query };
    if (best && best.score >= 70) break;
  }

  if (!best) return { ok: false, error: "no_match", queries };
  if (best.score < 55) {
    return {
      ok: false,
      error: "needs_review",
      reason: "low_confidence",
      candidate: best,
      queries
    };
  }
  return { ok: true, ...best };
}

async function idsForFeaturedCruise(featuredCruiseId) {
  const rows = await supabase(
    `featured_cruise_itinerary_stops?featured_cruise_id=eq.${encodeURIComponent(featuredCruiseId)}&select=port_id&port_id=not.is.null&order=display_order.asc`
  );
  return [...new Set((rows || []).map((row) => String(row.port_id || "").trim()).filter(Boolean))];
}

async function idsForAllMissing(limit, offset) {
  const rows = await supabase(
    `ports?or=(latitude.is.null,longitude.is.null)&select=id&order=canonical_name.asc&limit=${limit}&offset=${offset}`
  );
  return (rows || []).map((row) => row.id).filter(Boolean);
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

  try {
    let ids = Array.isArray(body.port_ids)
      ? [...new Set(body.port_ids.map((id) => String(id || "").trim()).filter(Boolean))]
      : [];

    const featuredCruiseId = String(body.featured_cruise_id || "").trim();
    if (!ids.length && featuredCruiseId) ids = await idsForFeaturedCruise(featuredCruiseId);

    if (!ids.length && body.all_missing === true) {
      const limit = Math.min(MAX_PORTS, Math.max(1, Number(body.limit) || MAX_PORTS));
      const offset = Math.max(0, Number(body.offset) || 0);
      ids = await idsForAllMissing(limit, offset);
    }

    if (!ids.length) {
      return jsonResponse(200, { ok: true, updated: 0, failed: 0, unresolved: 0, results: [] });
    }
    if (ids.length > MAX_PORTS) {
      return jsonResponse(400, {
        ok: false,
        error: "too_many_ports",
        message: `Geocode at most ${MAX_PORTS} ports per request.`
      });
    }

    const filter = ids.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
    const rows = await supabase(
      `ports?id=in.(${filter})&select=id,canonical_name,display_name,city,country,country_code,region,aliases,status,latitude,longitude`
    );
    const byId = new Map((rows || []).map((row) => [row.id, row]));
    const results = [];
    let requestIndex = 0;

    for (const id of ids) {
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

      try {
        const hit = await resolvePort(port, { requestIndex });
        requestIndex += 1;
        if (!hit.ok) {
          results.push({
            id,
            canonical_name: port.canonical_name,
            country: port.country,
            ...hit
          });
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
          query: hit.query,
          confidence_score: hit.score,
          geocode_label: hit.display_name,
          port: row || null
        });
      } catch (error) {
        results.push({
          id,
          canonical_name: port.canonical_name,
          ok: false,
          error: "geocode_failed",
          message: String(error.message || error).slice(0, 200)
        });
      }
    }

    const updated = results.filter((r) => r.ok && !r.skipped).length;
    const failed = results.filter((r) => r.error === "geocode_failed").length;
    const unresolved = results.filter((r) => !r.ok && r.error !== "geocode_failed").length;
    return jsonResponse(200, {
      ok: failed === 0,
      featured_cruise_id: featuredCruiseId || null,
      updated,
      failed,
      unresolved,
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
