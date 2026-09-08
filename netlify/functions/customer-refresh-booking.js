/**
 * Authenticated Client Portal: refresh active booking from CRM.
 * POST /.netlify/functions/customer-refresh-booking
 */
"use strict";

const { fetchBase44Booking, cacheBookingInSupabase } = require("./booking-service");
const { jsonResponse, requireCustomerSession } = require("./lib/customer-session-auth");

const CACHE_WRITE_BUDGET_MS = 1200;

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label || "Operation"} timed out`);
      error.code = "operation_timeout";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

    const bookingReference = String(session.booking_reference || "").trim().toUpperCase();
    const bookingId = String(session.booking_id || "").trim();
    if (!bookingReference && !bookingId) {
      return jsonResponse(400, { success: false, error: "Booking session is missing booking identity." });
    }

    let booking;
    try {
      ({ booking } = await fetchBase44Booking({
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

    // Session restore is part of the customer's critical path. Document downloads,
    // PDF processing and itinerary extraction belong to the Documents workflow,
    // not page startup. Cache refresh is useful but must not block the dashboard.
    try {
      await withTimeout(cacheBookingInSupabase(booking), CACHE_WRITE_BUDGET_MS, "Booking cache update");
    } catch (cacheError) {
      console.warn("Customer booking refresh cache update skipped", cacheError?.message || cacheError);
    }

    return jsonResponse(200, { success: true, booking });
  } catch (error) {
    console.error("Customer refresh booking error", error);
    return jsonResponse(500, { success: false, error: error.message || "Unexpected server error" });
  }
};
