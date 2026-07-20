/**
 * Admin Media Library API.
 *
 * Actions:
 *   create_upload  → signed upload into cruise-media
 *   create_record  → insert media_library row after upload
 *   update_record  → update metadata / default / active
 *   delete_record  → delete row + storage object (blocked if referenced)
 *   list           → list/filter media (admin)
 */

const crypto = require('crypto');
const { requireAdmin } = require('./admin-auth');

const BUCKET = 'cruise-media';
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/png', 'image/webp', 'image/jpeg', 'image/jpg']);
const MEDIA_TYPES = new Set(['ship', 'destination', 'port', 'route_map', 'general']);

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
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase server access is not configured');
  return { url: url.replace(/\/$/, ''), key };
}

async function supabase(path, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null && !(options.body instanceof Buffer)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  const response = await fetch(`${url}${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const msg = data?.message || data?.error || data?.msg || `HTTP ${response.status}`;
    const err = new Error(msg);
    err.statusCode = response.status;
    throw err;
  }
  return data;
}

async function storage(path, options = {}) {
  return supabase(`/storage/v1/${path}`, options);
}

function safeFilename(value) {
  const original = String(value || 'image').trim();
  const dot = original.lastIndexOf('.');
  const ext = dot > 0 ? original.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, '') : '';
  const stem = (dot > 0 ? original.slice(0, dot) : original)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'image';
  return `${stem}${ext}`;
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'general';
}

function publicObjectUrl(storagePath) {
  const { url } = config();
  return `${url}/storage/v1/object/public/${BUCKET}/${storagePath.split('/').map(encodeURIComponent).join('/')}`;
}

function buildStoragePath(body) {
  const mediaType = MEDIA_TYPES.has(body.media_type) ? body.media_type : 'general';
  const stamp = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  const file = safeFilename(body.filename);
  if (mediaType === 'ship' && body.ship_id) {
    return `ships/${String(body.ship_id).slice(0, 64)}/${stamp}-${rand}-${file}`;
  }
  if (mediaType === 'destination' && body.destination_name) {
    return `destinations/${slugify(body.destination_name)}/${stamp}-${rand}-${file}`;
  }
  if (mediaType === 'port' && body.port_name) {
    return `ports/${slugify(body.port_name)}/${stamp}-${rand}-${file}`;
  }
  if (mediaType === 'route_map') {
    const key = body.featured_cruise_id || body.public_slug || 'general';
    return `route-maps/${slugify(key)}/${stamp}-${rand}-${file}`;
  }
  return `general/${stamp}-${rand}-${file}`;
}

function normalizeTags(raw) {
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 40);
  }
  return String(raw || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 40);
}

async function clearOtherDefaults({ mediaType, shipId, destinationName, keepId }) {
  if (mediaType === 'ship' && shipId) {
    await supabase(
      `/rest/v1/media_library?ship_id=eq.${encodeURIComponent(shipId)}&media_type=eq.ship&is_default=eq.true&id=neq.${encodeURIComponent(keepId)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_default: false })
      }
    );
    return;
  }
  if (mediaType === 'destination' && destinationName) {
    const dest = String(destinationName).trim();
    // Fetch matching defaults then clear — PostgREST lacks lower() filter easily.
    const rows = await supabase(
      `/rest/v1/media_library?media_type=eq.destination&is_default=eq.true&select=id,destination_name`,
      { method: 'GET' }
    );
    const ids = (rows || [])
      .filter((r) => r.id !== keepId && String(r.destination_name || '').trim().toLowerCase() === dest.toLowerCase())
      .map((r) => r.id);
    for (const id of ids) {
      await supabase(`/rest/v1/media_library?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_default: false })
      });
    }
  }
}

async function handleCreateUpload(body) {
  const filename = String(body.filename || '').trim();
  const mimeType = String(body.mime_type || '').trim().toLowerCase();
  const sizeBytes = Number(body.size_bytes || 0);
  if (!filename) throw Object.assign(new Error('filename is required'), { statusCode: 400 });
  if (!ALLOWED_TYPES.has(mimeType)) {
    throw Object.assign(new Error('Unsupported file type. Allowed: JPG, PNG, WebP'), { statusCode: 400 });
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw Object.assign(new Error('size_bytes is required'), { statusCode: 400 });
  }
  if (sizeBytes > MAX_BYTES) {
    throw Object.assign(new Error('File too large. Maximum is 10 MB'), { statusCode: 400 });
  }

  const storagePath = buildStoragePath(body);
  const signed = await storage(
    `object/upload/sign/${BUCKET}/${storagePath.split('/').map(encodeURIComponent).join('/')}`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  const token = signed?.token || signed?.signedToken;
  if (!token) throw new Error('Storage did not return an upload token');

  return {
    success: true,
    bucket: BUCKET,
    storage_path: storagePath,
    token,
    public_url: publicObjectUrl(storagePath)
  };
}

async function handleCreateRecord(body, adminUserId) {
  const title = String(body.title || '').trim();
  if (!title) throw Object.assign(new Error('Title is required'), { statusCode: 400 });
  const mediaType = MEDIA_TYPES.has(body.media_type) ? body.media_type : 'general';
  const storagePath = String(body.storage_path || '').trim();
  const publicUrl = String(body.public_url || '').trim();
  if (!storagePath || !publicUrl) {
    throw Object.assign(new Error('storage_path and public_url are required'), { statusCode: 400 });
  }

  const payload = {
    title,
    alt_text: String(body.alt_text || '').trim() || null,
    media_type: mediaType,
    storage_bucket: BUCKET,
    storage_path: storagePath,
    public_url: publicUrl,
    file_name: String(body.file_name || '').trim() || null,
    mime_type: String(body.mime_type || '').trim() || null,
    width: body.width == null ? null : Number(body.width),
    height: body.height == null ? null : Number(body.height),
    file_size_bytes: body.file_size_bytes == null ? null : Number(body.file_size_bytes),
    cruise_line_id: body.cruise_line_id || null,
    ship_id: body.ship_id || null,
    destination_name: String(body.destination_name || '').trim() || null,
    port_name: String(body.port_name || '').trim() || null,
    tags: normalizeTags(body.tags),
    is_default: Boolean(body.is_default),
    is_active: body.is_active === false ? false : true,
    created_by: adminUserId || null
  };

  const rows = await supabase('/rest/v1/media_library', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload)
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (row?.is_default) {
    await clearOtherDefaults({
      mediaType: row.media_type,
      shipId: row.ship_id,
      destinationName: row.destination_name,
      keepId: row.id
    });
  }
  return { success: true, media: row };
}

async function handleUpdateRecord(body) {
  const id = String(body.id || '').trim();
  if (!id) throw Object.assign(new Error('id is required'), { statusCode: 400 });

  const patch = {};
  if (body.title !== undefined) patch.title = String(body.title || '').trim();
  if (body.alt_text !== undefined) patch.alt_text = String(body.alt_text || '').trim() || null;
  if (body.media_type !== undefined) {
    if (!MEDIA_TYPES.has(body.media_type)) {
      throw Object.assign(new Error('Invalid media_type'), { statusCode: 400 });
    }
    patch.media_type = body.media_type;
  }
  if (body.cruise_line_id !== undefined) patch.cruise_line_id = body.cruise_line_id || null;
  if (body.ship_id !== undefined) patch.ship_id = body.ship_id || null;
  if (body.destination_name !== undefined) {
    patch.destination_name = String(body.destination_name || '').trim() || null;
  }
  if (body.port_name !== undefined) patch.port_name = String(body.port_name || '').trim() || null;
  if (body.tags !== undefined) patch.tags = normalizeTags(body.tags);
  if (body.is_default !== undefined) patch.is_default = Boolean(body.is_default);
  if (body.is_active !== undefined) patch.is_active = Boolean(body.is_active);
  if (body.public_url !== undefined) patch.public_url = String(body.public_url || '').trim();
  if (body.storage_path !== undefined) patch.storage_path = String(body.storage_path || '').trim();
  if (body.file_name !== undefined) patch.file_name = String(body.file_name || '').trim() || null;
  if (body.mime_type !== undefined) patch.mime_type = String(body.mime_type || '').trim() || null;
  if (body.width !== undefined) patch.width = body.width == null ? null : Number(body.width);
  if (body.height !== undefined) patch.height = body.height == null ? null : Number(body.height);
  if (body.file_size_bytes !== undefined) {
    patch.file_size_bytes = body.file_size_bytes == null ? null : Number(body.file_size_bytes);
  }

  if (!Object.keys(patch).length) {
    throw Object.assign(new Error('No fields to update'), { statusCode: 400 });
  }
  if (patch.title !== undefined && !patch.title) {
    throw Object.assign(new Error('Title is required'), { statusCode: 400 });
  }

  const rows = await supabase(`/rest/v1/media_library?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch)
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw Object.assign(new Error('Media not found'), { statusCode: 404 });

  if (row.is_default) {
    await clearOtherDefaults({
      mediaType: row.media_type,
      shipId: row.ship_id,
      destinationName: row.destination_name,
      keepId: row.id
    });
  }
  return { success: true, media: row };
}

async function handleDeleteRecord(body) {
  const id = String(body.id || '').trim();
  if (!id) throw Object.assign(new Error('id is required'), { statusCode: 400 });

  const heroRefs = await supabase(
    `/rest/v1/featured_cruises?hero_media_id=eq.${encodeURIComponent(id)}&select=id,headline&limit=5`,
    { method: 'GET' }
  );
  const mapRefs = await supabase(
    `/rest/v1/featured_cruises?route_map_media_id=eq.${encodeURIComponent(id)}&select=id,headline&limit=5`,
    { method: 'GET' }
  );
  const refs = [...(heroRefs || []), ...(mapRefs || [])];
  if (refs.length) {
    const names = refs.map((r) => r.headline || r.id).slice(0, 3).join(', ');
    throw Object.assign(
      new Error(`This image is used by Featured Cruise(s): ${names}. Remove those references before deleting.`),
      { statusCode: 409 }
    );
  }

  const existing = await supabase(
    `/rest/v1/media_library?id=eq.${encodeURIComponent(id)}&select=id,storage_bucket,storage_path&limit=1`,
    { method: 'GET' }
  );
  const row = Array.isArray(existing) ? existing[0] : null;
  if (!row) throw Object.assign(new Error('Media not found'), { statusCode: 404 });

  await supabase(`/rest/v1/media_library?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' }
  });

  try {
    await storage(`object/${row.storage_bucket || BUCKET}/${String(row.storage_path).split('/').map(encodeURIComponent).join('/')}`, {
      method: 'DELETE'
    });
  } catch (error) {
    console.warn('media-library storage delete skipped', error.message || error);
  }

  return { success: true };
}

async function handleList(body) {
  const params = new URLSearchParams();
  params.set('select', '*,ci_cruise_lines(id,name),ci_cruise_ships(id,name,cruise_line_id)');
  params.set('order', 'updated_at.desc');
  params.set('limit', String(Math.min(Number(body.limit) || 200, 500)));

  if (body.media_type && MEDIA_TYPES.has(body.media_type)) {
    params.set('media_type', `eq.${body.media_type}`);
  }
  if (body.ship_id) params.set('ship_id', `eq.${body.ship_id}`);
  if (body.cruise_line_id) params.set('cruise_line_id', `eq.${body.cruise_line_id}`);
  if (body.is_active === true) params.set('is_active', 'eq.true');
  if (body.is_active === false) params.set('is_active', 'eq.false');

  let rows = await supabase(`/rest/v1/media_library?${params.toString()}`, { method: 'GET' });
  rows = rows || [];

  const q = String(body.q || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((row) => {
      const hay = [
        row.title,
        row.alt_text,
        row.file_name,
        row.destination_name,
        row.port_name,
        row.media_type,
        ...(row.tags || []),
        row.ci_cruise_lines?.name,
        row.ci_cruise_ships?.name
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  if (body.destination_name) {
    const dest = String(body.destination_name).trim().toLowerCase();
    rows = rows.filter((r) => String(r.destination_name || '').trim().toLowerCase() === dest);
  }

  return { success: true, media: rows };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(204, {});
  if (event.httpMethod !== 'POST') return jsonResponse(405, { success: false, error: 'Method not allowed' });

  try {
    const admin = await requireAdmin(event);
    const body = JSON.parse(event.body || '{}');
    const action = String(body.action || '').trim();

    if (action === 'create_upload') return jsonResponse(200, await handleCreateUpload(body));
    if (action === 'create_record') {
      return jsonResponse(200, await handleCreateRecord(body, admin?.id || admin?.user?.id));
    }
    if (action === 'update_record') return jsonResponse(200, await handleUpdateRecord(body));
    if (action === 'delete_record') return jsonResponse(200, await handleDeleteRecord(body));
    if (action === 'list') return jsonResponse(200, await handleList(body));

    return jsonResponse(400, { success: false, error: 'Unknown action' });
  } catch (error) {
    const status = error.statusCode || 500;
    return jsonResponse(status, {
      success: false,
      error: error.message || 'Media library request failed'
    });
  }
};
