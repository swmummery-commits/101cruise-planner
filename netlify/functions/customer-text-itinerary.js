/**
 * Customer-facing text-only cruise itinerary for My Cruise dashboard.
 * GET/POST with customer session Bearer token.
 * No port matching, coordinates, or journey map building.
 */

const crypto = require("crypto");
const { readTextItinerary } = require("./lib/text-itinerary-store");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function verifyToken(token, secret) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature || !secret) return null;
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server access is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

async function rest(path, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error((data && data.message) || `Supabase HTTP ${response.status}`);
  }
  return data;
}

function calmReasonForStatus(status) {
  switch (String(status || "").toLowerCase()) {
    case "pending":
      return "itinerary_preparing";
    case "processing":
      return "itinerary_processing";
    case "failed":
      return "itinerary_unavailable";
    default:
      return "no_text_itinerary";
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const secret = process.env.CUSTOMER_SESSION_SECRET || "";
    const auth = String(event.headers?.authorization || event.headers?.Authorization || "");
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const session = verifyToken(bearer, secret);
    if (!session) {
      return jsonResponse(401, { success: false, error: "unauthorized", reason: "invalid_session" });
    }

    const bookingId = String(session.booking_id || "").trim();
    const bookingRef = String(session.booking_reference || "").trim().toUpperCase();
    if (!bookingId && !bookingRef) {
      return jsonResponse(200, {
        success: true,
        itinerary: null,
        status: null,
        reason: "missing_booking_identity"
      });
    }

    // Load light booking facts for completeness checks (no passenger PII returned).
    let booking = { base44_booking_id: bookingId, booking_reference: bookingRef };
    try {
      const cacheQuery = bookingRef
        ? `base44_booking_cache?booking_reference=eq.${encodeURIComponent(bookingRef)}&select=booking_reference,base44_booking_id,departing_date,arriving_date,raw_payload&limit=1`
        : `base44_booking_cache?base44_booking_id=eq.${encodeURIComponent(bookingId)}&select=booking_reference,base44_booking_id,departing_date,arriving_date,raw_payload&limit=1`;
      const cacheRows = await rest(cacheQuery, { method: "GET" });
      const cache = Array.isArray(cacheRows) ? cacheRows[0] : null;
      if (cache) {
        const payload = cache.raw_payload && typeof cache.raw_payload === "object" ? cache.raw_payload : {};
        booking = {
          ...booking,
          departing_date: cache.departing_date || payload.departing_date || null,
          arriving_date: cache.arriving_date || payload.arriving_date || null,
          cruise_duration: payload.cruise_duration || null,
          nights: payload.nights || null
        };
      }
    } catch (cacheError) {
      console.warn("customer-text-itinerary cache lookup failed", cacheError.message || cacheError);
    }

    const read = await readTextItinerary(rest, { bookingId, bookingRef, booking });
    if (!read || !read.itinerary?.stops?.length) {
      return jsonResponse(200, {
        success: true,
        itinerary: null,
        status: read?.status || null,
        reason: calmReasonForStatus(read?.status)
      });
    }

    return jsonResponse(200, {
      success: true,
      itinerary: read.itinerary,
      status: "ready",
      reason: "ok",
      source: read.source || null
    });
  } catch (error) {
    console.error("customer-text-itinerary error", error);
    return jsonResponse(500, {
      success: false,
      error: "server_error",
      reason: "server_error"
    });
  }
};
