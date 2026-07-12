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

function cleanMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function cleanBudget(input = {}) {
  const allowedCategories = new Set(['flights', 'accommodation', 'cars', 'other']);
  const items = Array.isArray(input.items) ? input.items.slice(0, 250).map(item => ({
    id: String(item.id || '').slice(0, 100),
    category: allowedCategories.has(item.category) ? item.category : 'other',
    amount: cleanMoney(item.amount),
    name: String(item.name || '').slice(0, 250),
    airline: String(item.airline || '').slice(0, 250),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')) ? item.date : '',
    from: String(item.from || '').slice(0, 250),
    to: String(item.to || '').slice(0, 250),
    location: String(item.location || '').slice(0, 250),
    return_flight: item.return_flight === true
  })) : [];
  return {
    exchange_rate: cleanMoney(input.exchange_rate) || 1.55,
    food_beverage: cleanMoney(input.food_beverage),
    travel_insurance: cleanMoney(input.travel_insurance),
    excursions: cleanMoney(input.excursions),
    cruise_price_usd: cleanMoney(input.cruise_price_usd),
    items,
    updated_at: new Date().toISOString()
  };
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

    if (body.action === 'load') {
      const rows = await rest(`customer_budgets?booking_id=eq.${encodeURIComponent(bookingId)}&select=budget_data,updated_at&limit=1`, { method: 'GET' });
      const row = rows?.[0];
      return jsonResponse(200, { success: true, budget: row?.budget_data ? { ...row.budget_data, updated_at: row.updated_at } : null });
    }

    if (body.action === 'save') {
      const budget = cleanBudget(body.budget);
      const row = { booking_id: bookingId, budget_data: budget, updated_at: budget.updated_at };
      const data = await rest('customer_budgets?on_conflict=booking_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row)
      });
      return jsonResponse(200, { success: true, budget: data?.[0]?.budget_data || budget });
    }

    return jsonResponse(400, { success: false, error: 'Unsupported action' });
  } catch (error) {
    console.error('Customer budget error', error);
    return jsonResponse(500, { success: false, error: error.message || 'Unexpected server error' });
  }
};
