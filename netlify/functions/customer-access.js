const { resolveCustomerBooking } = require('./customer-booking-access-service');
const {
  cacheBookingInSupabase,
  BASE44_FETCH_TIMEOUT_MS
} = require('./booking-service');
const { mintBookingSessionToken, jsonResponse: authJsonResponse } = require('./lib/customer-session-auth');

const CACHE_WRITE_BUDGET_MS = 1200;

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

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label || 'Operation'} timed out`);
      error.code = 'operation_timeout';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
      return jsonResponse(400, { success: false, error: 'Booking number and traveller surname are required.' });
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

    // Authentication is the critical path. Do not download documents, parse PDFs,
    // call OpenAI, or perform any other heavy work before returning the session.
    // Document mirroring is handled by the Documents flow instead.
    const token = mintBookingSessionToken(booking, sessionSecret);
    timer.mark('session_created');

    // The cache improves resilience but must never prevent a valid customer from
    // opening My Cruise. Keep the write on a short budget and continue on failure.
    if (bookingSource === 'live') {
      try {
        await withTimeout(cacheBookingInSupabase(booking), CACHE_WRITE_BUDGET_MS, 'Booking cache update');
        timer.mark('cache_updated');
      } catch (cacheError) {
        console.warn('Customer access cache update skipped', cacheError?.message || cacheError);
        timer.mark('cache_update_skipped');
      }
    } else {
      timer.mark('cache_reused');
    }

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
