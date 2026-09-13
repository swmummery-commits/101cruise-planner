/**
 * Reliable Admin save/publish endpoint for Ship Spotlights.
 * Uses server-side admin auth + service role so publishing is not dependent on
 * browser RLS/session quirks.
 */
const { requireAdmin, getConfig, serviceHeaders } = require('./admin-auth');

function json(statusCode, body) {
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

function slugify(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 80);
}

async function rest(path, { method = 'GET', body = null, prefer = 'return=representation' } = {}) {
  const { supabaseUrl } = getConfig();
  const headers = {
    ...serviceHeaders(),
    Accept: 'application/json',
    Prefer: prefer
  };
  if (body !== null) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = data?.message || data?.error || data?.hint || `HTTP ${response.status}`;
    const error = new Error(detail);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });

  try {
    const user = await requireAdmin(event);
    const body = JSON.parse(event.body || '{}');
    const shipId = String(body.ship_id || '').trim();
    if (!shipId) return json(400, { success: false, error: 'Select a ship first.' });

    const ships = await rest(`ci_cruise_ships?id=eq.${encodeURIComponent(shipId)}&select=id,name,slug,active&limit=1`);
    const ship = Array.isArray(ships) ? ships[0] : null;
    if (!ship?.id || ship.active === false) return json(404, { success: false, error: 'Ship is unavailable.' });

    const publicSlug = slugify(body.public_slug || ship.slug || ship.name);
    if (!publicSlug) return json(400, { success: false, error: 'A public slug is required.' });

    const publicationStatus = body.publication_status === 'published' ? 'published' : 'draft';
    const payload = {
      ship_id: ship.id,
      eyebrow: String(body.eyebrow || 'SHIP SPOTLIGHT').trim() || 'SHIP SPOTLIGHT',
      newsletter_heading: String(body.newsletter_heading || ship.name || '').trim() || ship.name,
      editorial_intro: String(body.editorial_intro || '').trim() || null,
      highlights: [],
      stat_keys: Array.isArray(body.stat_keys) ? body.stat_keys.map(String).filter(Boolean) : [],
      hero_image_url: String(body.hero_image_url || '').trim() || null,
      supporting_image_urls: Array.isArray(body.supporting_image_urls) ? body.supporting_image_urls.map(String).filter(Boolean) : [],
      public_slug: publicSlug,
      publication_status: publicationStatus,
      active: true,
      updated_by: user.id,
      updated_at: new Date().toISOString()
    };

    if (!payload.hero_image_url) return json(400, { success: false, error: 'Choose a hero image before saving.' });

    const existingRows = await rest(`ship_spotlights?ship_id=eq.${encodeURIComponent(ship.id)}&select=id,created_by&limit=1`);
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;
    let saved;
    if (existing?.id) {
      const rows = await rest(`ship_spotlights?id=eq.${encodeURIComponent(existing.id)}`, {
        method: 'PATCH',
        body: payload
      });
      saved = Array.isArray(rows) ? rows[0] : rows;
    } else {
      const rows = await rest('ship_spotlights', {
        method: 'POST',
        body: { ...payload, created_by: user.id }
      });
      saved = Array.isArray(rows) ? rows[0] : rows;
    }

    return json(200, { success: true, spotlight: saved, public_url: `/ships/${publicSlug}` });
  } catch (error) {
    return json(error.statusCode || 500, {
      success: false,
      error: error.message || 'Could not save Ship Spotlight.'
    });
  }
};
