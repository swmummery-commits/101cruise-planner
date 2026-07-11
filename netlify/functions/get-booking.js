const { fetchBase44Booking, cacheBookingInSupabase } = require('./booking-service');

function sanitiseRawResponse(value) {
  const blockedKeys = new Set([
    'api_key', 'apikey', 'apiKey', 'authorization', 'Authorization',
    'token', 'access_token', 'refresh_token', 'secret', 'password'
  ]);

  function walk(input, seen = new WeakSet()) {
    if (input === null || input === undefined) return input;
    if (typeof input !== 'object') return input;
    if (seen.has(input)) return '[Circular]';
    seen.add(input);

    if (Array.isArray(input)) return input.map(item => walk(item, seen));

    const output = {};
    for (const [key, item] of Object.entries(input)) {
      if (blockedKeys.has(key) || /(^|_)(secret|password|token|api[_-]?key)$/i.test(key)) {
        output[key] = '[REDACTED]';
      } else {
        output[key] = walk(item, seen);
      }
    }
    return output;
  }

  return walk(value);
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {});
  if (event.httpMethod !== 'POST') return jsonResponse(405, { success: false, error: 'Method not allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const { booking, source } = await fetchBase44Booking({
      booking_reference: body.booking_reference,
      booking_id: body.booking_id
    });

    let cached = null;
    try {
      cached = await cacheBookingInSupabase(booking);
    } catch (cacheError) {
      console.warn('Booking retrieved but cache update failed', cacheError);
    }

    return jsonResponse(200, {
      success: true,
      booking,
      cache_id: cached?.id || null,
      documents: source?.documents || booking.documents || null,
      raw_booking_response: sanitiseRawResponse(source)
    });
  } catch (error) {
    console.error('Get booking error', error);
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || 'Unable to retrieve booking'
    });
  }
};
