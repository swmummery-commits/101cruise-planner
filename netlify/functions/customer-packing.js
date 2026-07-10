const crypto = require('crypto');

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

function verifyToken(token, secret) {
  const [encoded, signature] = String(token || '').split('.');
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

async function rest(path, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase server access is not configured');
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}`, ...(options.headers || {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || `Supabase HTTP ${response.status}`);
  return data;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {});
  if (event.httpMethod !== 'POST') return jsonResponse(405, { success: false, error: 'Method not allowed' });
  try {
    const auth = event.headers.authorization || event.headers.Authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const session = verifyToken(token, process.env.CUSTOMER_SESSION_SECRET || '');
    if (!session) return jsonResponse(401, { success: false, error: 'Your booking session has expired. Please access My Cruise again.' });
    const body = JSON.parse(event.body || '{}');
    const bookingId = session.booking_id;
    const action = body.action;

    if (action === 'load') {
      const [profiles, state, preferences] = await Promise.all([
        rest(`customer_packing_profiles?booking_id=eq.${encodeURIComponent(bookingId)}&order=display_order.asc`, { method: 'GET' }),
        rest(`customer_packing_state?booking_id=eq.${encodeURIComponent(bookingId)}`, { method: 'GET' }),
        rest(`customer_packing_preferences?booking_id=eq.${encodeURIComponent(bookingId)}&limit=1`, { method: 'GET' })
      ]);
      return jsonResponse(200, { success: true, profiles, state, preferences: preferences?.[0] || null });
    }

    if (action === 'save_profiles') {
      const rows = (body.profiles || []).map(row => ({ ...row, booking_id: bookingId, updated_at: new Date().toISOString() }));
      const data = await rest('customer_packing_profiles?on_conflict=booking_id,profile_key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(rows) });
      return jsonResponse(200, { success: true, profiles: data });
    }

    if (action === 'save_state') {
      const row = { ...body.state, booking_id: bookingId, updated_at: new Date().toISOString() };
      const data = await rest('customer_packing_state?on_conflict=booking_id,profile_key,item_key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(row) });
      return jsonResponse(200, { success: true, state: data?.[0] || data });
    }

    if (action === 'save_preferences') {
      const row = { ...body.preferences, booking_id: bookingId, updated_at: new Date().toISOString() };
      const data = await rest('customer_packing_preferences?on_conflict=booking_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(row) });
      return jsonResponse(200, { success: true, preferences: data?.[0] || data });
    }

    if (action === 'reset_profile') {
      await rest(`customer_packing_state?booking_id=eq.${encodeURIComponent(bookingId)}&profile_key=eq.${encodeURIComponent(body.profile_key)}`, { method: 'DELETE' });
      return jsonResponse(200, { success: true });
    }

    return jsonResponse(400, { success: false, error: 'Unsupported action' });
  } catch (error) {
    console.error('Customer packing error', error);
    return jsonResponse(500, { success: false, error: error.message || 'Unexpected server error' });
  }
};
