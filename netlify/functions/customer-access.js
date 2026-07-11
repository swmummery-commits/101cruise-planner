const crypto = require('crypto');

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

async function saveBookingToSupabase(booking) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error('Supabase server save is not configured');

  const payload = {
    base44_booking_id: booking.base44_booking_id || null,
    booking_reference: booking.booking_reference || null,
    passenger1_first_name: booking.passenger1_first_name || null,
    passenger1_last_name: booking.passenger1_last_name || null,
    passenger1_email: booking.passenger1_email || null,
    passenger1_mobile: booking.passenger1_mobile || null,
    passenger2_first_name: booking.passenger2_first_name || null,
    passenger2_last_name: booking.passenger2_last_name || null,
    passenger2_email: booking.passenger2_email || null,
    passenger2_mobile: booking.passenger2_mobile || null,
    cruise_line: booking.cruise_line || null,
    cruise_ship: booking.cruise_ship || null,
    departing_date: booking.departing_date || null,
    arriving_date: booking.arriving_date || null,
    departing_port: booking.departing_port || null,
    arriving_port: booking.arriving_port || null,
    room_number: booking.room_number || null,
    room_type: booking.room_type || null,
    category_class: booking.category_class || null,
    booking_status: booking.booking_status || null,
    raw_payload: booking
  };

  const response = await fetch(`${supabaseUrl}/rest/v1/base44_booking_cache?on_conflict=base44_booking_id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Could not cache booking (HTTP ${response.status})`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {});
  if (event.httpMethod !== 'POST') return jsonResponse(405, { success: false, error: 'Method not allowed' });

  try {
    const body = JSON.parse(event.body || '{}');
    const bookingReference = normalise(body.booking_reference);
    const surname = normalise(body.surname);
    if (!bookingReference || !surname) return jsonResponse(400, { success: false, error: 'Booking number and lead traveller surname are required.' });

    const base44Url = process.env.BASE44_BOOKING_FUNCTION_URL;
    const base44ApiKey = process.env.BASE44_API_KEY;
    const sessionSecret = process.env.CUSTOMER_SESSION_SECRET;
    if (!base44Url || !base44ApiKey || !sessionSecret) return jsonResponse(500, { success: false, error: 'Customer access is not fully configured.' });

    const response = await fetch(base44Url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': base44ApiKey },
      body: JSON.stringify({ booking_reference: bookingReference })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.booking) return jsonResponse(401, { success: false, error: 'We could not match those booking details.' });

    const booking = data.booking;
    if (normalise(booking.passenger1_last_name) !== surname) {
      return jsonResponse(401, { success: false, error: 'We could not match those booking details.' });
    }

    const cached = await saveBookingToSupabase(booking);
    const bookingId = String(booking.base44_booking_id || cached?.base44_booking_id || booking.booking_reference);
    const token = createSessionToken({ booking_id: bookingId, booking_reference: booking.booking_reference, exp: Date.now() + 12 * 60 * 60 * 1000 }, sessionSecret);

    return jsonResponse(200, { success: true, token, booking });
  } catch (error) {
    console.error('Customer access error', error);
    return jsonResponse(500, { success: false, error: error.message || 'Unexpected server error' });
  }
};
