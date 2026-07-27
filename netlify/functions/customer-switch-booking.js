/**
 * Authenticated Client Portal: switch active booking within the current session.
 * POST /.netlify/functions/customer-switch-booking
 * Body: { switch_token }
 *
 * Never accepts surname or raw unauthorised booking ids.
 */
"use strict";

const {
  fetchBase44Booking,
  cacheBookingInSupabase,
  syncDocumentsForBooking,
  supabaseRest
} = require("./booking-service");
const {
  jsonResponse,
  requireCustomerSession,
  mintBookingSessionToken
} = require("./lib/customer-session-auth");
const {
  verifySwitchToken,
  bookingsShareSecureIdentity,
  bookingIdentityKey,
  rejectSurnameSearchBody
} = require("./lib/customer-linked-bookings-core");

async function loadCacheRowByBookingId(bookingId) {
  const id = String(bookingId || "").trim();
  if (!id) return null;
  const rows = await supabaseRest(
    `base44_booking_cache?base44_booking_id=eq.${encodeURIComponent(id)}&select=base44_booking_id,booking_reference,passenger1_email,passenger1_mobile&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, {});
  if (event.httpMethod !== "POST") {
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
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    const rejected = rejectSurnameSearchBody(body);
    if (rejected) return jsonResponse(400, { success: false, error: rejected });

    const switchToken = String(body.switch_token || "").trim();
    if (!switchToken) {
      return jsonResponse(400, { success: false, error: "A switch token is required." });
    }

    // Reject raw booking_id switches without a signed token
    if (body.booking_id && !switchToken) {
      return jsonResponse(403, { success: false, error: "Unauthorised booking switch." });
    }

    const switchPayload = verifySwitchToken(switchToken, secret, session.booking_id);
    if (!switchPayload) {
      return jsonResponse(403, {
        success: false,
        error: "That cruise is no longer available to switch to."
      });
    }

    const targetId = String(switchPayload.tid);
    if (targetId === String(session.booking_id)) {
      return jsonResponse(400, { success: false, error: "That cruise is already open." });
    }

    const [sessionRow, targetRow] = await Promise.all([
      loadCacheRowByBookingId(session.booking_id),
      loadCacheRowByBookingId(targetId)
    ]);

    if (!sessionRow || !targetRow) {
      return jsonResponse(403, {
        success: false,
        error: "That cruise is no longer available to switch to."
      });
    }

    // Re-check compound identity at switch time — never trust token alone if linkage changed
    if (!bookingIdentityKey(sessionRow) || !bookingsShareSecureIdentity(sessionRow, targetRow)) {
      return jsonResponse(403, {
        success: false,
        error: "That cruise is no longer available to switch to."
      });
    }

    let booking;
    let source;
    try {
      ({ booking, source } = await fetchBase44Booking({ booking_id: targetId }));
    } catch (lookupError) {
      console.warn("customer-switch-booking Base44 pull failed", lookupError);
      return jsonResponse(502, {
        success: false,
        error: "We couldn’t open that cruise just now. Please try again."
      });
    }

    // Confirm pulled booking still matches the secure identity
    if (!bookingsShareSecureIdentity(sessionRow, booking)) {
      return jsonResponse(403, {
        success: false,
        error: "That cruise is no longer available to switch to."
      });
    }

    await cacheBookingInSupabase(booking);
    try {
      await syncDocumentsForBooking(booking, source);
    } catch (syncError) {
      console.warn("customer-switch-booking document sync failed", syncError);
    }

    const token = mintBookingSessionToken(booking, secret);
    return jsonResponse(200, { success: true, token, booking });
  } catch (error) {
    console.error("customer-switch-booking error", error);
    return jsonResponse(500, {
      success: false,
      error: "We couldn’t switch cruises just now. Please try again."
    });
  }
};
