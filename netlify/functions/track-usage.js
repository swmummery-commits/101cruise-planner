/**
 * Public engagement event ingest.
 *
 * POST /.netlify/functions/track-usage
 *
 * Body: {
 *   session_id, surface, module, event_type,
 *   booking_reference?, user_id?, device_type?, metadata?,
 *   dedupe_page_open?: true
 * }
 *
 * Never accepts packing/budget/checklist/document content.
 * Writes via service role only.
 */

const ALLOWED_SURFACES = new Set(["my_cruise", "public_tools", "admin"]);
const ALLOWED_MODULES = new Set([
  "dashboard",
  "booking",
  "packing",
  "preparation",
  "documents",
  "budget",
  "the_ship",
  "drinks_calculator",
  "public_drinks_calculator"
]);
const ALLOWED_EVENT_TYPES = new Set([
  "page_open",
  "tool_started",
  "tool_completed",
  "save",
  "document_upload",
  "login",
  "logout"
]);
const ALLOWED_DEVICES = new Set(["desktop", "tablet", "mobile", "unknown"]);
const ALLOWED_METADATA_KEYS = new Set([
  "cruise_line",
  "cruise_name",
  "customer_label",
  "line_slug",
  "source"
]);

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
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Supabase server configuration is missing");
  }
  return { supabaseUrl, serviceKey };
}

function cleanText(value, maxLen) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, maxLen);
}

function sanitizeMetadata(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    const value = raw[key];
    if (value == null) continue;
    if (typeof value === "string") {
      const cleaned = cleanText(value, 120);
      if (cleaned) out[key] = cleaned;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

async function rest(path, options = {}) {
  const { supabaseUrl, serviceKey } = config();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Prefer: options.prefer || "return=minimal",
    ...(options.body ? { "Content-Type": "application/json" } : {})
  };
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_error) {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Supabase HTTP ${response.status}`);
  }
  return data;
}

async function alreadyTrackedPageOpen(sessionId, module) {
  const query = new URLSearchParams({
    select: "id",
    session_id: `eq.${sessionId}`,
    module: `eq.${module}`,
    event_type: "eq.page_open",
    limit: "1"
  });
  const rows = await rest(`usage_events?${query.toString()}`, { prefer: "return=representation" });
  return Array.isArray(rows) && rows.length > 0;
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { success: true });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      success: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Use POST to record a usage event."
    });
  }

  let body = null;
  try {
    let raw = event.body || "";
    // sendBeacon may base64-encode the body on some hosts.
    if (event.isBase64Encoded && typeof raw === "string") {
      try {
        raw = Buffer.from(raw, "base64").toString("utf8");
      } catch (_error) {
        /* keep raw */
      }
    }
    body = raw ? JSON.parse(raw) : null;
  } catch (_error) {
    return jsonResponse(400, {
      success: false,
      error: "INVALID_JSON",
      message: "Request body must be valid JSON."
    });
  }

  const sessionId = cleanText(body?.session_id, 80);
  const surface = cleanText(body?.surface, 40);
  const moduleName = cleanText(body?.module, 60);
  const eventType = cleanText(body?.event_type, 40);
  const bookingReference = cleanText(body?.booking_reference, 64);
  const userId = cleanText(body?.user_id, 64);
  const deviceType = cleanText(body?.device_type, 20) || "unknown";
  const metadata = sanitizeMetadata(body?.metadata);
  const dedupePageOpen = body?.dedupe_page_open !== false;

  if (!sessionId || !surface || !moduleName || !eventType) {
    return jsonResponse(400, {
      success: false,
      error: "INVALID_EVENT",
      message: "session_id, surface, module and event_type are required."
    });
  }

  if (!ALLOWED_SURFACES.has(surface) || !ALLOWED_MODULES.has(moduleName) || !ALLOWED_EVENT_TYPES.has(eventType)) {
    return jsonResponse(400, {
      success: false,
      error: "INVALID_EVENT",
      message: "surface, module or event_type is not allowed."
    });
  }

  if (!ALLOWED_DEVICES.has(deviceType)) {
    return jsonResponse(400, {
      success: false,
      error: "INVALID_DEVICE",
      message: "device_type is not allowed."
    });
  }

  try {
    if (eventType === "page_open" && dedupePageOpen) {
      const exists = await alreadyTrackedPageOpen(sessionId, moduleName);
      if (exists) {
        return jsonResponse(200, { success: true, deduped: true });
      }
    }

    await rest("usage_events", {
      method: "POST",
      body: JSON.stringify({
        session_id: sessionId,
        surface,
        module: moduleName,
        event_type: eventType,
        booking_reference: bookingReference,
        user_id: userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null,
        device_type: deviceType,
        metadata
      })
    });

    return jsonResponse(200, { success: true, deduped: false });
  } catch (error) {
    console.error("track-usage error", error);
    return jsonResponse(500, {
      success: false,
      error: "TRACK_FAILED",
      message: "Unable to record usage event."
    });
  }
};
