const { fetchBase44Booking, cacheBookingInSupabase, syncDocumentsForBooking } = require('./booking-service');
const { requireAdmin } = require('./admin-auth');

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

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {});
  if (event.httpMethod !== 'POST') return jsonResponse(405, { success: false, error: 'Method not allowed' });

  try {
    await requireAdmin(event);

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

    let documentSync = null;
    try {
      documentSync = await syncDocumentsForBooking(booking, source);
    } catch (syncError) {
      console.warn('Booking document sync failed', syncError);
      documentSync = { errors: [syncError.message || String(syncError)] };
    }

    return jsonResponse(200, {
      success: true,
      booking,
      cache_id: cached?.id || null,
      documents: source?.documents || booking.documents || null,
      document_sync: documentSync
        ? {
            found: documentSync.found,
            upserted: documentSync.upserted,
            skipped_conflict: documentSync.skipped_conflict,
            skipped_other_source: documentSync.skipped_other_source,
            error_count: (documentSync.errors || []).length
          }
        : null
    });
  } catch (error) {
    console.error('Get booking error', error);
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || 'Unable to retrieve booking'
    });
  }
};
