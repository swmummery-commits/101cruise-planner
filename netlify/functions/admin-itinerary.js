const { fetchBase44Booking } = require('./booking-service');
const { requireAdmin } = require('./admin-auth');
const { extractItineraryWithOpenAI } = require('./lib/itinerary-extract');
const {
  processBookingConfirmation,
  revalidateStoredItinerary,
  PROCESSING,
  SYSTEM_APPROVER
} = require('./lib/itinerary-auto-process');
const { fingerprintBookingDocument } = require('./lib/itinerary-document-hash');
const { resolveItineraryExceptionsForBooking } = require('./lib/itinerary-exceptions');
const path = require('path');
const {
  buildItineraryStatusView,
  EFFECTIVE
} = require(path.join(__dirname, '../../js/itinerary-processing-status.js'));

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function config() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error('Supabase server configuration is missing');
  return { supabaseUrl, serviceKey, openaiKey };
}

async function rest(path, options = {}) {
  const { supabaseUrl, serviceKey } = config();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Prefer: options.prefer || 'return=representation',
    ...(options.body ? { 'Content-Type': 'application/json' } : {})
  };
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.error || `Supabase request failed (HTTP ${response.status})`);
  return data;
}

function isBookingConfirmation(document) {
  const type = String(document?.document_type || '').toLowerCase();
  return type.includes('booking confirmation');
}

function pickConfirmation(documents) {
  const list = Array.isArray(documents) ? documents : [];
  const matches = list.filter((document) => isBookingConfirmation(document) && document.file_url);
  matches.sort((a, b) =>
    String(b.uploaded_date || b.uploaded_at || '').localeCompare(String(a.uploaded_date || a.uploaded_at || ''))
  );
  return matches[0] || null;
}

function pickConfirmationById(documents, documentId) {
  const id = String(documentId || '').trim();
  if (!id) return null;
  const hit = (Array.isArray(documents) ? documents : []).find(
    (document) => String(document.id || document.base44_document_id || '') === id
  );
  if (!hit || !hit.file_url) return null;
  if (!isBookingConfirmation(hit)) {
    const error = new Error('Itinerary extraction is only available for Booking Confirmation documents');
    error.statusCode = 400;
    throw error;
  }
  return hit;
}

async function listStoredBookingDocuments(booking) {
  const bookingId = String(booking?.base44_booking_id || '').trim();
  const bookingReference = String(booking?.booking_reference || '').trim();
  const filters = [];
  if (bookingId) filters.push(`base44_booking_id.eq.${encodeURIComponent(bookingId)}`);
  if (bookingReference) filters.push(`booking_reference.eq.${encodeURIComponent(bookingReference)}`);
  if (!filters.length) return [];
  try {
    const rows = await rest(
      `booking_documents?or=(${filters.join(',')})&select=id,base44_booking_id,booking_reference,base44_document_id,document_type,filename,file_url,storage_path,uploaded_at,source_system,sync_key,itinerary_processing_status,itinerary_process_lock_until,itinerary_last_processed_at,content_fingerprint,itinerary_last_processed_hash,updated_at,created_at&order=uploaded_at.desc&limit=100`,
      { method: 'GET' }
    );
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      id: row.id,
      base44_booking_id: row.base44_booking_id || null,
      booking_reference: row.booking_reference || null,
      base44_document_id: row.base44_document_id || null,
      document_type: row.document_type,
      filename: row.filename,
      file_url: row.file_url,
      storage_path: row.storage_path || null,
      uploaded_date: row.uploaded_at || null,
      uploaded_at: row.uploaded_at || null,
      source_system: row.source_system || null,
      sync_key: row.sync_key || null,
      itinerary_processing_status: row.itinerary_processing_status || null,
      itinerary_process_lock_until: row.itinerary_process_lock_until || null,
      itinerary_last_processed_at: row.itinerary_last_processed_at || null,
      content_fingerprint: row.content_fingerprint || null,
      itinerary_last_processed_hash: row.itinerary_last_processed_hash || null,
      updated_at: row.updated_at || null,
      created_at: row.created_at || null
    }));
  } catch (error) {
    console.warn('Stored booking document lookup failed', error.message || error);
    return [];
  }
}

async function resolveConfirmationDocument(booking, documentId) {
  const liveDocs = Array.isArray(booking?.documents) ? booking.documents : [];
  const storedDocs = await listStoredBookingDocuments(booking);
  const combined = [...liveDocs, ...storedDocs];
  if (documentId) return pickConfirmationById(combined, documentId);
  return pickConfirmation(combined);
}

async function getExisting(bookingId) {
  const rows = await rest(`cruise_itineraries?booking_id=eq.${encodeURIComponent(bookingId)}&select=*&limit=1`, { method: 'GET' });
  return rows?.[0] || null;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {});
  try {
    const user = await requireAdmin(event);
    const body = event.body ? JSON.parse(event.body) : {};
    const bookingReference = String(body.booking_reference || event.queryStringParameters?.booking_reference || '').trim();
    const bookingIdInput = String(body.booking_id || event.queryStringParameters?.booking_id || '').trim();
    const action = String(body.action || event.queryStringParameters?.action || '').trim();

    if (event.httpMethod === 'GET') {
      if (!bookingIdInput) return jsonResponse(400, { success: false, error: 'Booking ID is required' });
      return jsonResponse(200, { success: true, itinerary: await getExisting(bookingIdInput) });
    }

    if (event.httpMethod === 'POST' || event.httpMethod === 'PATCH') {
      // Journey-map itinerary extraction retired — never call OpenAI or mutate itineraries.
      return jsonResponse(410, {
        success: false,
        error:
          'Itinerary map extraction has been retired. Detailed itineraries remain in the Booking Confirmation document.',
        reason: 'itinerary_map_feature_retired',
        action: action || (event.httpMethod === 'PATCH' ? 'save' : 'extract')
      });
    }

    return jsonResponse(405, { success: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('Admin itinerary error', error);
    return jsonResponse(error.statusCode || 500, { success: false, error: error.message || 'Unable to process itinerary' });
  }
};

module.exports.isBookingConfirmation = isBookingConfirmation;
module.exports.pickConfirmation = pickConfirmation;
module.exports.pickConfirmationById = pickConfirmationById;
module.exports.fingerprintBookingDocument = fingerprintBookingDocument;
module.exports.SYSTEM_APPROVER = SYSTEM_APPROVER;
