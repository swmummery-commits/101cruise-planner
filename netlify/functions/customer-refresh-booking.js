/**
 * Authenticated Client Portal: refresh active booking from CRM.
 * POST /.netlify/functions/customer-refresh-booking
 */
"use strict";

const { fetchBase44Booking, cacheBookingInSupabase, syncDocumentsForBooking } = require("./booking-service");
const { jsonResponse, requireCustomerSession } = require("./lib/customer-session-auth");

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

    const bookingReference = String(session.booking_reference || "").trim().toUpperCase();
    const bookingId = String(session.booking_id || "").trim();
    if (!bookingReference && !bookingId) {
      return jsonResponse(400, { success: false, error: "Booking session is missing booking identity." });
    }

    let booking;
    let source;
    try {
      ({ booking, source } = await fetchBase44Booking({
        booking_reference: bookingReference,
        booking_id: bookingId
      }));
    } catch (lookupError) {
      console.warn("Customer booking refresh failed", {
        bookingReference,
        message: lookupError.message || lookupError
      });
      return jsonResponse(502, { success: false, error: "We could not refresh your booking just now." });
    }

    await cacheBookingInSupabase(booking);
    try {
      await syncDocumentsForBooking(booking, source);
    } catch (syncError) {
      console.warn("Customer refresh document sync failed", syncError);
    }

    return jsonResponse(200, { success: true, booking });
  } catch (error) {
    console.error("Customer refresh booking error", error);
    return jsonResponse(500, { success: false, error: error.message || "Unexpected server error" });
  }
};
