/**
 * Customer-facing approved itinerary for My Cruise dashboard journey map.
 * GET/POST with customer session Bearer token.
 * Returns approved cruise_itineraries only; enriches stops with ports catalogue coordinates when available.
 */

const crypto = require("crypto");
const { buildJourneyFromItinerary } = require("./lib/dashboard-journey");
const {
  matchPortCoordinates,
  buildPortIndex
} = require("./lib/customer-port-match");

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

async function rest(path) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
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

async function loadPortIndex() {
  const rows = await rest(
    "ports?select=id,canonical_name,display_name,city,country,aliases,latitude,longitude&latitude=not.is.null&longitude=not.is.null&limit=5000"
  );
  return buildPortIndex(rows).portsByKey;
}

function enrichStopsWithCoordinates(itineraryData, portsByKey) {
  const stops = Array.isArray(itineraryData?.stops) ? itineraryData.stops : [];
  return {
    ...itineraryData,
    stops: stops.map((stop) => {
      if (
        Number.isFinite(Number(stop.lat)) &&
        Number.isFinite(Number(stop.lng))
      ) {
        return stop;
      }
      if (
        Number.isFinite(Number(stop.latitude)) &&
        Number.isFinite(Number(stop.longitude))
      ) {
        return {
          ...stop,
          lat: Number(stop.latitude),
          lng: Number(stop.longitude)
        };
      }
      const hit = matchPortCoordinates(stop.name, portsByKey);
      if (!hit) return stop;
      return { ...stop, lat: hit.lat, lng: hit.lng };
    })
  };
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
    const bookingRef = String(session.booking_reference || "").trim();
    if (!bookingId && !bookingRef) {
      return jsonResponse(200, {
        success: true,
        journey: null,
        reason: "missing_booking_identity"
      });
    }

    let rows = [];
    if (bookingId) {
      rows = await rest(
        `cruise_itineraries?booking_id=eq.${encodeURIComponent(bookingId)}&select=booking_id,booking_reference,status,itinerary_data&limit=1`
      );
    }
    if ((!rows || !rows.length) && bookingRef) {
      rows = await rest(
        `cruise_itineraries?booking_reference=eq.${encodeURIComponent(bookingRef)}&select=booking_id,booking_reference,status,itinerary_data&limit=1`
      );
    }

    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) {
      return jsonResponse(200, {
        success: true,
        journey: null,
        reason: "no_approved_itinerary",
        diagnostic: { booking_id: bookingId || null, booking_reference: bookingRef || null }
      });
    }

    if (String(row.status || "").toLowerCase() !== "approved") {
      return jsonResponse(200, {
        success: true,
        journey: null,
        reason: "itinerary_not_approved",
        diagnostic: { status: row.status || null }
      });
    }

    const portsByKey = await loadPortIndex();
    const enriched = enrichStopsWithCoordinates(row.itinerary_data || {}, portsByKey);
    const built = buildJourneyFromItinerary(enriched, { source: "approved_itinerary" });

    return jsonResponse(200, {
      success: true,
      journey: built.journey,
      reason: built.reason,
      diagnostic: {
        booking_id: row.booking_id,
        booking_reference: row.booking_reference,
        stop_count: (enriched.stops || []).length,
        geocoded_port_stops: (enriched.stops || []).filter(
          (s) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng))
        ).length
      }
    });
  } catch (error) {
    console.error("customer-itinerary error", error);
    return jsonResponse(500, {
      success: false,
      error: "server_error",
      reason: "server_error"
    });
  }
};
