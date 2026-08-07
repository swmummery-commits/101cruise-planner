const {
  resolveCustomerBooking,
  cacheBookingInSupabase,
  BASE44_FETCH_TIMEOUT_MS
} = require('./booking-service');
const { createSessionToken, jsonResponse: authJsonResponse } = require('./lib/customer-session-auth');

function jsonResponse(statusCode, body) {
  return authJsonResponse(statusCode, body, 'POST, OPTIONS');
}

function normalise(value) {
  return String(value || '').trim().toUpperCase();
}

function createTimer() {
  const started = Date.now();
  const stages = [];
  return {
    mark(stage) {
      stages.push({ stage, elapsed_ms: Date.now() - started });
    },
    finish(extra = {}) {
      console.log(
        JSON.stringify({
          event: 'customer_access_timings',
          ...extra,
          stages,
          total_ms: Date.now() - started
        })
      );
    }
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {});
  if (event.httpMethod !== 'POST') return jsonResponse(405, { success: false, error: 'Method not allowed' });

  const timer = createTimer();
  let bookingReference = '';

  try {
    const body = JSON.parse(event.body || '{}');
    bookingReference = normalise(body.booking_reference);
    const surname = normalise(body.surname);
    timer.mark('request_validated');

    if (!bookingReference || !surname) {
      return jsonResponse(400, { success: false, error: 'Booking number and lead traveller surname are required.' });
    }

    const sessionSecret = process.env.CUSTOMER_SESSION_SECRET;
    if (!sessionSecret) return jsonResponse(500, { success: false, error: 'Customer access is not fully configured.' });

    let resolved;
    try {
      resolved = await resolveCustomerBooking({ booking_reference: bookingReference, surname });
    } catch (lookupError) {
      timer.mark('booking_resolve_failed');
      timer.finish({
        booking_reference: bookingReference,
        outcome: lookupError.code || 'lookup_failed',
        base44_timeout_ms: BASE44_FETCH_TIMEOUT_MS
      });

      if (lookupError.code === 'surname_mismatch') {
        return jsonResponse(401, { success: false, error: 'We could not match those booking details.' });
      }
      if (lookupError.code === 'base44_timeout') {
        return jsonResponse(503, {
          success: false,
          error: lookupError.message || 'The booking service is taking longer than expected. Please try again.',
          retryable: true
        });
      }

      console.warn('Customer booking lookup failed', lookupError.code || lookupError.message || lookupError);
      return jsonResponse(401, { success: false, error: 'We could not match those booking details.' });
    }

    timer.mark('booking_resolved');
    const { booking, bookingSource, cacheFallback } = resolved;

    let cached = null;
    if (bookingSource === 'live') {
      cached = await cacheBookingInSupabase(booking);
      timer.mark('cache_updated');
    } else {
      timer.mark('cache_reused');
    }

    const bookingId = String(booking.base44_booking_id || cached?.base44_booking_id || booking.booking_reference);
    const token = createSessionToken(
      { booking_id: bookingId, booking_reference: booking.booking_reference, exp: Date.now() + 12 * 60 * 60 * 1000 },
      sessionSecret
    );
    timer.mark('session_created');

    timer.finish({
      booking_reference: bookingReference,
      outcome: 'success',
      booking_source: bookingSource,
      cache_fallback: cacheFallback,
      base44_timeout_ms: BASE44_FETCH_TIMEOUT_MS
    });

    return jsonResponse(200, { success: true, token, booking });
  } catch (error) {
    timer.mark('error');
    timer.finish({
      booking_reference: bookingReference || undefined,
      outcome: 'error'
    });
    console.error('Customer access error', error);
    return jsonResponse(500, { success: false, error: 'We could not open My Cruise just now. Please try again.' });
  }
};
