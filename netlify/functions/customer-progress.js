const crypto = require('crypto');

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

function verifyToken(token, secret) {
  const [encoded, signature] = String(token || '').split('.');
  if (!encoded || !signature || !secret) return null;
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

    if (body.action === 'load_checklist') {
      const rows = await rest(`customer_checklist_progress?booking_id=eq.${encodeURIComponent(bookingId)}`, { method: 'GET' });
      return jsonResponse(200, { success: true, progress: rows || [] });
    }

    if (body.action === 'save_checklist') {
      const itemId = Number(body.checklist_item_id);
      if (!Number.isInteger(itemId) || itemId <= 0) return jsonResponse(400, { success: false, error: 'Invalid checklist item' });
      const row = {
        booking_id: bookingId,
        checklist_item_id: itemId,
        completed: body.completed === true,
        completed_at: body.completed === true ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      };
      const data = await rest('customer_checklist_progress?on_conflict=booking_id,checklist_item_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row)
      });
      return jsonResponse(200, { success: true, progress: data?.[0] || data });
    }

    return jsonResponse(400, { success: false, error: 'Unsupported action' });
  } catch (error) {
    console.error('Customer progress error', error);
    return jsonResponse(500, { success: false, error: error.message || 'Unexpected server error' });
  }
};
