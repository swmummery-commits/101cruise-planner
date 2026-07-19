const { syncBookingDocuments } = require('./document-sync');

function normalise(value) {
  return String(value || '').trim();
}

function getConfig() {
  const base44Url = process.env.BASE44_BOOKING_FUNCTION_URL;
  const base44ApiKey = process.env.BASE44_API_KEY;
  if (!base44Url || !base44ApiKey) {
    throw new Error('Base44 booking service is not configured');
  }
  return { base44Url, base44ApiKey };
}

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;
  return { supabaseUrl: supabaseUrl.replace(/\/$/, ''), serviceKey };
}

async function supabaseRest(path, options = {}) {
  const config = getSupabaseConfig();
  if (!config) throw new Error('Supabase server configuration is missing');
  const headers = {
    apikey: config.serviceKey,
    Authorization: `Bearer ${config.serviceKey}`,
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = data?.message || data?.error || text || `Supabase HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function fetchBase44Booking({ booking_reference, booking_id }) {
  const reference = normalise(booking_reference).toUpperCase();
  const id = normalise(booking_id);
  if (!reference && !id) throw new Error('Booking reference or booking ID is required');

  const { base44Url, base44ApiKey } = getConfig();
  const payload = id ? { booking_id: id } : { booking_reference: reference };
  const response = await fetch(base44Url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': base44ApiKey
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error || data?.message || `Base44 booking request failed (HTTP ${response.status})`;
    const error = new Error(message);
    error.statusCode = response.status;
    throw error;
  }

  if (!data?.booking) {
    const error = new Error('Booking was not found');
    error.statusCode = 404;
    throw error;
  }

  return { booking: data.booking, source: data };
}

async function cacheBookingInSupabase(booking) {
  if (!getSupabaseConfig()) return null;

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

  const rows = await supabaseRest('base44_booking_cache?on_conflict=base44_booking_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload)
  });

  return Array.isArray(rows) ? rows[0] || null : rows;
}

async function syncDocumentsForBooking(booking, source = null) {
  if (!getSupabaseConfig()) {
    return { found: 0, upserted: 0, skipped_conflict: 0, skipped_other_source: 0, errors: ['Supabase not configured'], rows: [] };
  }
  try {
    return await syncBookingDocuments(supabaseRest, booking, source);
  } catch (error) {
    // Table may not exist until migration is applied.
    console.warn('Document sync skipped or failed', error.message || error);
    return {
      found: 0,
      upserted: 0,
      skipped_conflict: 0,
      skipped_other_source: 0,
      errors: [error.message || String(error)],
      rows: []
    };
  }
}

module.exports = {
  fetchBase44Booking,
  cacheBookingInSupabase,
  syncDocumentsForBooking,
  supabaseRest
};
