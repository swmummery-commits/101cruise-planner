/**
 * Authenticated My Cruise users claiming an invitation booking.
 * Uses service role → Base44; does not require Admin.
 */

const { fetchBase44Booking, cacheBookingInSupabase, syncDocumentsForBooking } = require('./booking-service');

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function config() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error('Supabase server configuration is missing');
  return { supabaseUrl: supabaseUrl.replace(/\/$/, ''), serviceKey };
}

async function requireSignedInUser(event) {
  const { supabaseUrl, serviceKey } = config();
  const token = String(event.headers.authorization || event.headers.Authorization || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (!token) {
    const error = new Error('Sign in is required to claim this booking');
    error.statusCode = 401;
    throw error;
  }
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` }
  });
  const user = await userResponse.json().catch(() => null);
  if (!userResponse.ok || !user?.id) {
    const error = new Error('Your session has expired. Please sign in again.');
    error.statusCode = 401;
    throw error;
  }
  return user;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {});
  if (event.httpMethod !== 'POST') return jsonResponse(405, { success: false, error: 'Method not allowed' });

  try {
    await requireSignedInUser(event);
    const body = JSON.parse(event.body || '{}');
    const bookingId = String(body.booking_id || '').trim();
    if (!bookingId) return jsonResponse(400, { success: false, error: 'Booking ID is required' });

    const { booking, source } = await fetchBase44Booking({ booking_id: bookingId });
    let cached = null;
    try {
      cached = await cacheBookingInSupabase(booking);
    } catch (cacheError) {
      console.warn('Invitation booking cache failed', cacheError);
    }
    try {
      await syncDocumentsForBooking(booking, source);
    } catch (syncError) {
      console.warn('Invitation document sync failed', syncError);
    }

    return jsonResponse(200, {
      success: true,
      booking,
      cache_id: cached?.id || null,
      documents: source?.documents || booking.documents || null
    });
  } catch (error) {
    console.error('Claim invitation booking error', error);
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || 'Unable to retrieve booking'
    });
  }
};
