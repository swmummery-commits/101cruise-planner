/**
 * Authenticated Client Portal: list securely linked bookings for switch.
 * GET or POST /.netlify/functions/customer-linked-bookings
 *
 * Requires valid customer HMAC session. Never accepts surname search.
 */
"use strict";

const { supabaseRest } = require("./booking-service");
const {
  jsonResponse,
  requireCustomerSession
} = require("./lib/customer-session-auth");
const {
  buildLinkedBookingCards,
  bookingIdentityKey,
  rejectSurnameSearchBody
} = require("./lib/customer-linked-bookings-core");
const { expandTerminalNumeralVariants, normaliseText } = require("./lib/resolve-cruise-ship");

async function loadSessionBookingRow(session) {
  const bookingId = String(session.booking_id || "").trim();
  const bookingRef = String(session.booking_reference || "").trim();
  if (bookingId) {
    const byId = await supabaseRest(
      `base44_booking_cache?base44_booking_id=eq.${encodeURIComponent(bookingId)}&select=base44_booking_id,booking_reference,passenger1_email,passenger1_mobile,cruise_line,cruise_ship,departing_date,arriving_date,departing_port,arriving_port&limit=1`
    );
    if (Array.isArray(byId) && byId[0]) return byId[0];
  }
  if (bookingRef) {
    const byRef = await supabaseRest(
      `base44_booking_cache?booking_reference=eq.${encodeURIComponent(bookingRef)}&select=base44_booking_id,booking_reference,passenger1_email,passenger1_mobile,cruise_line,cruise_ship,departing_date,arriving_date,departing_port,arriving_port&limit=1`
    );
    if (Array.isArray(byRef) && byRef[0]) return byRef[0];
  }
  return {
    base44_booking_id: bookingId || null,
    booking_reference: bookingRef || null,
    passenger1_email: null,
    passenger1_mobile: null
  };
}

async function loadCandidateRows(sessionBooking) {
  const identity = bookingIdentityKey(sessionBooking);
  if (!identity) {
    const id = String(sessionBooking.base44_booking_id || "").trim();
    const ref = String(sessionBooking.booking_reference || "").trim();
    if (id) {
      const rows = await supabaseRest(
        `base44_booking_cache?base44_booking_id=eq.${encodeURIComponent(id)}&select=base44_booking_id,booking_reference,passenger1_email,passenger1_mobile,cruise_line,cruise_ship,departing_date,arriving_date,departing_port,arriving_port&limit=5`
      );
      return Array.isArray(rows) ? rows : [];
    }
    if (ref) {
      const rows = await supabaseRest(
        `base44_booking_cache?booking_reference=eq.${encodeURIComponent(ref)}&select=base44_booking_id,booking_reference,passenger1_email,passenger1_mobile,cruise_line,cruise_ship,departing_date,arriving_date,departing_port,arriving_port&limit=5`
      );
      return Array.isArray(rows) ? rows : [];
    }
    return [sessionBooking];
  }

  const email = String(sessionBooking.passenger1_email || "").trim();
  // Query by email only (indexed-friendly), then enforce email+mobile compound in core filter.
  // Never query by surname / last_name.
  const rows = await supabaseRest(
    `base44_booking_cache?passenger1_email=eq.${encodeURIComponent(email)}&select=base44_booking_id,booking_reference,passenger1_email,passenger1_mobile,cruise_line,cruise_ship,departing_date,arriving_date,departing_port,arriving_port&limit=50`
  );
  return Array.isArray(rows) ? rows : [];
}

async function resolveHeroByShipNames(shipNames) {
  const names = [...new Set((shipNames || []).map((n) => String(n || "").trim()).filter(Boolean))];
  const heroByShip = {};
  if (!names.length) return heroByShip;

  const variants = new Set();
  names.forEach((name) => {
    expandTerminalNumeralVariants(name).forEach((v) => variants.add(v));
    variants.add(normaliseText(name));
  });

  // Pull active ships; match in memory (small catalogue relative to portal traffic).
  let offset = 0;
  const pageSize = 200;
  const matched = new Map();
  while (offset < 800) {
    const rows = await supabaseRest(
      `ci_cruise_ships?select=name,hero_image_url&active=eq.true&order=name.asc&limit=${pageSize}&offset=${offset}`
    );
    const page = Array.isArray(rows) ? rows : [];
    if (!page.length) break;
    for (const row of page) {
      const n = normaliseText(row.name);
      if (!n || !row.hero_image_url) continue;
      if (variants.has(n) || expandTerminalNumeralVariants(row.name).some((v) => variants.has(v))) {
        matched.set(n, row.hero_image_url);
      }
    }
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  for (const name of names) {
    const keys = [normaliseText(name), ...expandTerminalNumeralVariants(name)];
    for (const key of keys) {
      if (matched.has(key)) {
        heroByShip[name] = matched.get(key);
        heroByShip[name.toLowerCase()] = matched.get(key);
        break;
      }
    }
  }
  return heroByShip;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, {});
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "Method not allowed" });
  }

  try {
    const secret = process.env.CUSTOMER_SESSION_SECRET || "";
    if (!secret) {
      return jsonResponse(500, { success: false, error: "Customer access is not fully configured." });
    }

    const session = requireCustomerSession(event, secret);
    if (!session) {
      return jsonResponse(401, {
        success: false,
        error: "Your booking session has expired. Please access My Cruise again."
      });
    }

    let body = {};
    if (event.httpMethod === "POST") {
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        body = {};
      }
      const rejected = rejectSurnameSearchBody(body);
      if (rejected) return jsonResponse(400, { success: false, error: rejected });
    }

    const sessionBooking = await loadSessionBookingRow(session);
    const candidates = await loadCandidateRows(sessionBooking);
    const heroByShip = await resolveHeroByShipNames(candidates.map((r) => r.cruise_ship));
    const bookings = buildLinkedBookingCards(sessionBooking, candidates, { secret, heroByShip });

    const linkedCount = bookings.length;
    const emptyMessage =
      linkedCount <= 1 ? "No other linked cruises are available in this account." : null;

    return jsonResponse(200, {
      success: true,
      bookings,
      linked_count: linkedCount,
      can_switch: linkedCount > 1,
      empty_message: emptyMessage
    });
  } catch (error) {
    console.error("customer-linked-bookings error", error);
    return jsonResponse(500, {
      success: false,
      error: "We couldn’t load your other cruises just now. Please try again."
    });
  }
};
