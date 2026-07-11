const { fetchBase44Booking } = require('./booking-service');

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

async function requireAdmin(event) {
  const { supabaseUrl, serviceKey } = config();
  const token = String(event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    const error = new Error('Admin authentication is required');
    error.statusCode = 401;
    throw error;
  }

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` }
  });
  const user = await userResponse.json().catch(() => null);
  if (!userResponse.ok || !user?.id) {
    const error = new Error('Admin session is invalid or has expired');
    error.statusCode = 401;
    throw error;
  }

  const profileResponse = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=is_admin&limit=1`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  });
  const profiles = await profileResponse.json().catch(() => []);
  if (!profileResponse.ok || profiles?.[0]?.is_admin !== true) {
    const error = new Error('This account does not have admin access');
    error.statusCode = 403;
    throw error;
  }
  return user;
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

function pickConfirmation(booking) {
  const documents = Array.isArray(booking?.documents) ? booking.documents : [];
  const matches = documents.filter(document => isBookingConfirmation(document) && document.file_url);
  matches.sort((a, b) => String(b.uploaded_date || '').localeCompare(String(a.uploaded_date || '')));
  return matches[0] || null;
}

const itinerarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cruise_line: { type: ['string', 'null'] },
    ship: { type: ['string', 'null'] },
    voyage_name: { type: ['string', 'null'] },
    embarkation_date: { type: ['string', 'null'], description: 'ISO date YYYY-MM-DD' },
    disembarkation_date: { type: ['string', 'null'], description: 'ISO date YYYY-MM-DD' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    review_notes: { type: 'array', items: { type: 'string' } },
    stops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
          name: { type: 'string' },
          entry_type: { type: 'string', enum: ['embarkation', 'port', 'sea_day', 'scenic_cruising', 'disembarkation'] },
          arrival_time: { type: ['string', 'null'], description: '24-hour HH:MM or null' },
          departure_time: { type: ['string', 'null'], description: '24-hour HH:MM or null' },
          notes: { type: ['string', 'null'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['date', 'name', 'entry_type', 'arrival_time', 'departure_time', 'notes', 'confidence']
      }
    }
  },
  required: ['cruise_line', 'ship', 'voyage_name', 'embarkation_date', 'disembarkation_date', 'confidence', 'review_notes', 'stops']
};

function extractOutputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return '';
}

async function extractWithOpenAI(booking, document) {
  const { openaiKey } = config();
  if (!openaiKey) {
    const error = new Error('OPENAI_API_KEY has not been added to Netlify environment variables');
    error.statusCode = 503;
    throw error;
  }

  const lowerUrl = String(document.file_url).toLowerCase();
  const isImage = /\.(png|jpe?g|webp)(\?|$)/i.test(lowerUrl);
  const fileContent = isImage
    ? { type: 'input_image', image_url: document.file_url, detail: 'high' }
    : { type: 'input_file', file_url: document.file_url, detail: 'high' };

  const prompt = `Extract only the cruise itinerary from this cruise booking confirmation.\n\nKnown Base44 booking facts for validation:\n- Cruise line: ${booking.cruise_line || 'unknown'}\n- Ship: ${booking.cruise_ship || 'unknown'}\n- Embarkation: ${booking.departing_date || 'unknown'} from ${booking.departing_port || 'unknown'}\n- Disembarkation: ${booking.arriving_date || 'unknown'} at ${booking.arriving_port || 'unknown'}\n\nRules:\n- Return every genuine cruise itinerary day in chronological order.\n- Ignore transfer rows such as “No Transfer To Ship” and “No Transfer From Ship”.\n- Keep scenic cruising locations as entry_type scenic_cruising.\n- Use sea_day only for At Sea entries.\n- Infer a missing year from the confirmed embarkation/disembarkation dates.\n- Preserve repeated dates if they represent genuine itinerary entries.\n- Do not invent ports or times. Use null when a time is not supplied.\n- Flag uncertainty in review_notes and per-stop confidence.\n- The official PDF remains the source of truth; this output must be reviewed by an administrator.`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: process.env.OPENAI_ITINERARY_MODEL || 'gpt-5.5',
      store: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, fileContent] }],
      text: {
        format: {
          type: 'json_schema',
          name: 'cruise_itinerary',
          strict: true,
          schema: itinerarySchema
        }
      }
    })
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `Itinerary extraction failed (HTTP ${response.status})`);
  const text = extractOutputText(data);
  if (!text) throw new Error('The extraction service returned no itinerary data');
  return JSON.parse(text);
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

    if (event.httpMethod === 'GET') {
      if (!bookingIdInput) return jsonResponse(400, { success: false, error: 'Booking ID is required' });
      return jsonResponse(200, { success: true, itinerary: await getExisting(bookingIdInput) });
    }

    if (event.httpMethod === 'POST') {
      const { booking } = await fetchBase44Booking({ booking_reference: bookingReference, booking_id: bookingIdInput });
      const bookingId = booking.base44_booking_id;
      if (!bookingId) return jsonResponse(400, { success: false, error: 'Base44 booking ID is missing' });
      const document = pickConfirmation(booking);
      if (!document) return jsonResponse(404, { success: false, error: 'No Booking Confirmation document was found for this booking' });

      const extracted = await extractWithOpenAI(booking, document);
      const payload = {
        booking_id: bookingId,
        booking_reference: booking.booking_reference || bookingReference || null,
        source_filename: document.filename || null,
        source_url: document.file_url,
        source_uploaded_date: document.uploaded_date || null,
        status: 'review_required',
        itinerary_data: extracted,
        extraction_confidence: extracted.confidence,
        extracted_at: new Date().toISOString(),
        extracted_by: user.id,
        approved_at: null,
        approved_by: null
      };
      const rows = await rest('cruise_itineraries?on_conflict=booking_id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: JSON.stringify(payload)
      });
      return jsonResponse(200, { success: true, itinerary: rows?.[0] || payload });
    }

    if (event.httpMethod === 'PATCH') {
      if (!bookingIdInput) return jsonResponse(400, { success: false, error: 'Booking ID is required' });
      const itineraryData = body.itinerary_data;
      if (!itineraryData || !Array.isArray(itineraryData.stops)) return jsonResponse(400, { success: false, error: 'Valid itinerary data is required' });
      const approve = body.status === 'approved';
      const payload = {
        itinerary_data: itineraryData,
        extraction_confidence: Number(itineraryData.confidence || 0),
        status: approve ? 'approved' : 'review_required',
        updated_at: new Date().toISOString(),
        ...(approve ? { approved_at: new Date().toISOString(), approved_by: user.id } : { approved_at: null, approved_by: null })
      };
      const rows = await rest(`cruise_itineraries?booking_id=eq.${encodeURIComponent(bookingIdInput)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      return jsonResponse(200, { success: true, itinerary: rows?.[0] || null });
    }

    return jsonResponse(405, { success: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('Admin itinerary error', error);
    return jsonResponse(error.statusCode || 500, { success: false, error: error.message || 'Unable to process itinerary' });
  }
};
