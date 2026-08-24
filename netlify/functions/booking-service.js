const { syncBookingDocuments } = require('./document-sync');
const { canonicalCruiseLineDisplayName } = require('./lib/resolve-cruise-ship');
const { applyBookingFinance } = require('../../base44/bookingFinance');

const BASE44_FETCH_TIMEOUT_MS = Number(process.env.BASE44_FETCH_TIMEOUT_MS || 8000);
const CACHE_FRESH_MS = Number(process.env.BOOKING_CACHE_FRESH_MS || 24 * 60 * 60 * 1000);
const CACHE_STALE_ACCEPTABLE_MS = Number(process.env.BOOKING_CACHE_STALE_MS || 7 * 24 * 60 * 60 * 1000);
const BASE44_PREVIEW_FUNCTIONS_VERSION = 'preview';
const OBC_CONTRACT_FIELDS = Object.freeze([
  'on_board_credit_usd',
  'on_board_credit_1_currency',
  'on_board_credit_2_amount',
  'on_board_credit_2_currency',
  'on_board_credits'
]);

function normalise(value) {
  return String(value || '').trim();
}

function normaliseRef(value) {
  return normalise(value).toUpperCase();
}

function normaliseSurname(value) {
  return normaliseRef(value);
}

function canonicaliseBookingCruiseLine(booking) {
  if (!booking || typeof booking !== 'object') return booking;
  const next = { ...booking };
  const line = canonicalCruiseLineDisplayName(next.cruise_line);
  if (line) next.cruise_line = line;
  return next;
}

/**
 * Detect whether the Base44 response is using the OBC-aware booking contract.
 * Presence matters, not value: a current response legitimately contains null
 * OBC amounts for bookings with no credit, whereas the older published
 * function omitted all of these keys entirely.
 */
function bookingHasObcContract(booking) {
  if (!booking || typeof booking !== 'object') return false;
  return OBC_CONTRACT_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(booking, key));
}

/**
 * Merge only the OBC transport contract from a supplemental booking response.
 * Never allow preview/draft passenger, itinerary, document or finance fields
 * to replace the published booking payload.
 */
function mergeObcContractFields(primaryBooking, supplementalBooking) {
  const merged = { ...(primaryBooking || {}) };
  if (!supplementalBooking || typeof supplementalBooking !== 'object') return merged;
  for (const key of OBC_CONTRACT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(supplementalBooking, key)) {
      merged[key] = supplementalBooking[key];
    }
  }
  return merged;
}

/**
 * Apply shared finance + OBC helpers to a Base44 booking payload before cache/use.
 * Rebuilds on_board_credits from the four raw OBC fields when the array is
 * missing (cached/legacy payloads). Does not write back to CruiseBooking.
 */
function applySafeBookingFinance(booking) {
  if (!booking || typeof booking !== 'object') return booking;
  const next = applyBookingFinance(booking);
  const meta = next._meta || null;
  delete next._meta;
  delete next._finance_meta;
  if (meta) {
    next.finance_derivation_notes = Object.keys(meta).filter((key) => meta[key]);
  }
  return next;
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

async function requestBase44Booking({
  base44Url,
  base44ApiKey,
  payload,
  timeoutMs = 0,
  fetchImpl = fetch,
  functionsVersion = ''
}) {
  const effectiveTimeout = timeoutMs > 0 ? timeoutMs : 0;
  const controller = effectiveTimeout ? new AbortController() : null;
  const timer =
    controller &&
    setTimeout(() => {
      controller.abort();
    }, effectiveTimeout);

  try {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': base44ApiKey
    };
    if (functionsVersion) headers['Base44-Functions-Version'] = functionsVersion;

    const response = await fetchImpl(base44Url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller?.signal
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

    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Base44 booking request timed out');
      timeoutError.code = 'base44_timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchBase44Booking({ booking_reference, booking_id, timeoutMs = 0, fetchImpl = fetch } = {}) {
  const reference = normaliseRef(booking_reference);
  const id = normalise(booking_id);
  if (!reference && !id) throw new Error('Booking reference or booking ID is required');

  const { base44Url, base44ApiKey } = getConfig();
  const payload = id ? { booking_id: id } : { booking_reference: reference };
  const data = await requestBase44Booking({
    base44Url,
    base44ApiKey,
    payload,
    timeoutMs,
    fetchImpl
  });

  let sourceBooking = data.booking;

  // Temporary compatibility bridge: the Base44 editor/preview function has the
  // OBC transport fields, while the older published function can omit them.
  // Pull preview only when the published response lacks the OBC contract, then
  // copy ONLY those five OBC fields. This prevents unrelated draft CRM changes
  // from leaking into My Cruise. Once the published function includes the OBC
  // keys (even as null/[]), this second request stops automatically.
  if (!bookingHasObcContract(sourceBooking)) {
    try {
      const previewData = await requestBase44Booking({
        base44Url,
        base44ApiKey,
        payload,
        timeoutMs,
        fetchImpl,
        functionsVersion: BASE44_PREVIEW_FUNCTIONS_VERSION
      });
      if (bookingHasObcContract(previewData.booking)) {
        sourceBooking = mergeObcContractFields(sourceBooking, previewData.booking);
        console.log(
          JSON.stringify({
            event: 'base44_obc_preview_bridge',
            booking_reference: reference || undefined,
            booking_id: id || undefined,
            outcome: 'merged'
          })
        );
      }
    } catch (previewError) {
      // OBC enrichment must never block access to an otherwise valid booking.
      console.warn('Base44 OBC preview bridge unavailable', previewError?.message || previewError);
    }
  }

  const booking = applySafeBookingFinance(canonicaliseBookingCruiseLine(sourceBooking));
  return { booking, source: { ...data, booking } };
}

async function readBookingCache({ booking_reference, booking_id, rest = supabaseRest } = {}) {
  if (!getSupabaseConfig()) return null;
  const reference = normaliseRef(booking_reference);
  const id = normalise(booking_id);
  if (!reference && !id) return null;

  const select =
    'base44_booking_id,booking_reference,passenger1_last_name,last_synced_at,updated_at,raw_payload';
  const path = reference
    ? `base44_booking_cache?booking_reference=eq.${encodeURIComponent(reference)}&select=${select}&limit=1`
    : `base44_booking_cache?base44_booking_id=eq.${encodeURIComponent(id)}&select=${select}&limit=1`;

  const rows = await rest(path, { method: 'GET' });
  return Array.isArray(rows) ? rows[0] || null : null;
}

function cacheAgeMs(cacheRow) {
  const stamp = cacheRow?.last_synced_at || cacheRow?.updated_at;
  if (!stamp) return Number.POSITIVE_INFINITY;
  const age = Date.now() - new Date(stamp).getTime();
  return Number.isFinite(age) ? age : Number.POSITIVE_INFINITY;
}

function classifyBookingCache(cacheRow) {
  if (!cacheRow?.raw_payload || typeof cacheRow.raw_payload !== 'object') {
    return { usable: false, freshness: 'unusable' };
  }
  const ageMs = cacheAgeMs(cacheRow);
  if (ageMs <= CACHE_FRESH_MS) return { usable: true, freshness: 'fresh', ageMs };
  if (ageMs <= CACHE_STALE_ACCEPTABLE_MS) return { usable: true, freshness: 'stale_acceptable', ageMs };
  return { usable: true, freshness: 'stale', ageMs };
}

function bookingFromCacheRow(cacheRow) {
  return applySafeBookingFinance(canonicaliseBookingCruiseLine({ ...cacheRow.raw_payload }));
}

function sourceFromBooking(booking) {
  return {
    booking,
    documents: Array.isArray(booking?.documents) ? booking.documents : []
  };
}

async function resolveCustomerBooking(
  { booking_reference, surname },
  { rest = supabaseRest, fetchImpl = fetch, timeoutMs = BASE44_FETCH_TIMEOUT_MS } = {}
) {
  const reference = normaliseRef(booking_reference);
  const surnameNorm = normaliseSurname(surname);
  if (!reference || !surnameNorm) {
    const error = new Error('Booking number and lead traveller surname are required.');
    error.code = 'invalid_request';
    throw error;
  }

  const cacheRow = await readBookingCache({ booking_reference: reference, rest });
  const cacheInfo = classifyBookingCache(cacheRow);

  if (cacheRow && normaliseSurname(cacheRow.passenger1_last_name) !== surnameNorm) {
    const error = new Error('We could not match those booking details.');
    error.code = 'surname_mismatch';
    throw error;
  }

  let booking;
  let source;
  let bookingSource = 'live';
  let cacheFallback = false;

  try {
    ({ booking, source } = await fetchBase44Booking({
      booking_reference: reference,
      timeoutMs,
      fetchImpl
    }));
  } catch (fetchError) {
    if (cacheInfo.usable && cacheRow) {
      booking = bookingFromCacheRow(cacheRow);
      source = sourceFromBooking(booking);
      bookingSource = 'cache';
      cacheFallback = true;
    } else if (fetchError.code === 'base44_timeout') {
      const error = new Error('The booking service is taking longer than expected. Please try again.');
      error.code = 'base44_timeout';
      error.httpStatus = 503;
      throw error;
    } else {
      throw fetchError;
    }
  }

  if (normaliseSurname(booking.passenger1_last_name) !== surnameNorm) {
    const error = new Error('We could not match those booking details.');
    error.code = 'surname_mismatch';
    throw error;
  }

  return {
    booking,
    source,
    bookingSource,
    cacheFallback,
    cacheFreshness: cacheInfo.freshness,
    cacheRow
  };
}

async function cacheBookingInSupabase(booking) {
  if (!getSupabaseConfig()) return null;
  booking = applySafeBookingFinance(canonicaliseBookingCruiseLine(booking));

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

async function syncDocumentsForBooking(booking, source = null, options = {}) {
  if (!getSupabaseConfig()) {
    return { found: 0, upserted: 0, skipped_conflict: 0, skipped_other_source: 0, errors: ['Supabase not configured'], rows: [] };
  }
  try {
    return await syncBookingDocuments(supabaseRest, booking, source, options);
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
  BASE44_FETCH_TIMEOUT_MS,
  CACHE_FRESH_MS,
  CACHE_STALE_ACCEPTABLE_MS,
  BASE44_PREVIEW_FUNCTIONS_VERSION,
  OBC_CONTRACT_FIELDS,
  fetchBase44Booking,
  readBookingCache,
  classifyBookingCache,
  resolveCustomerBooking,
  bookingFromCacheRow,
  sourceFromBooking,
  cacheBookingInSupabase,
  syncDocumentsForBooking,
  supabaseRest,
  canonicaliseBookingCruiseLine,
  applySafeBookingFinance,
  bookingHasObcContract,
  mergeObcContractFields
};
