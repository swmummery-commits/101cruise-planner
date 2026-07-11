const crypto = require('crypto');
const { fetchBase44Booking, cacheBookingInSupabase } = require('./booking-service');

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

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function createSessionToken(payload, secret) {
  const encoded = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function normalise(value) {
  return String(value || '').trim().toUpperCase();
}


exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {});
  if (event.httpMethod !== 'POST') return jsonResponse(405, { success: false, error: 'Method not allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const bookingReference = normalise(body.booking_reference);
    const surname = normalise(body.surname);
    if (!bookingReference || !surname) return jsonResponse(400, { success: false, error: 'Booking number and lead traveller surname are required.' });

    const sessionSecret = process.env.CUSTOMER_SESSION_SECRET;
    if (!sessionSecret) return jsonResponse(500, { success: false, error: 'Customer access is not fully configured.' });

    let booking;
    try {
      ({ booking } = await fetchBase44Booking({ booking_reference: bookingReference }));
    } catch (lookupError) {
      console.warn('Customer booking lookup failed', lookupError);
      return jsonResponse(401, { success: false, error: 'We could not match those booking details.' });
    }
    if (normalise(booking.passenger1_last_name) !== surname) {
      return jsonResponse(401, { success: false, error: 'We could not match those booking details.' });
    }

    const cached = await cacheBookingInSupabase(booking);
    const bookingId = String(booking.base44_booking_id || cached?.base44_booking_id || booking.booking_reference);
    const token = createSessionToken({ booking_id: bookingId, booking_reference: booking.booking_reference, exp: Date.now() + 12 * 60 * 60 * 1000 }, sessionSecret);

    return jsonResponse(200, { success: true, token, booking });
  } catch (error) {
    console.error('Customer access error', error);
    return jsonResponse(500, { success: false, error: error.message || 'Unexpected server error' });
  }
};
