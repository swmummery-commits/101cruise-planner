/**
 * Admin-only signed uploads for Cruise Lines/Ships media.
 * Buckets: cruise-line-logos, ship-images
 *
 * Actions:
 *   create_upload  → { bucket, storage_path, upload_url, token, public_url }
 *   (client uploads via supabase.storage.uploadToSignedUrl)
 */

const crypto = require('crypto');

const BUCKETS = {
  logo: {
    id: 'cruise-line-logos',
    maxBytes: 2 * 1024 * 1024,
    types: new Set(['image/png', 'image/svg+xml', 'image/webp', 'image/jpeg', 'image/jpg'])
  },
  ship: {
    id: 'ship-images',
    maxBytes: 8 * 1024 * 1024,
    types: new Set(['image/png', 'image/webp', 'image/jpeg', 'image/jpg'])
  }
};

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

async function requireAdmin(event) {
  const { url, key } = config();
  const token = String(event.headers.authorization || event.headers.Authorization || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (!token) {
    const error = new Error('Admin authentication is required');
    error.statusCode = 401;
    throw error;
  }

  const userResponse = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` }
  });
  const user = await userResponse.json().catch(() => null);
  if (!userResponse.ok || !user?.id) {
    const error = new Error('Admin session is invalid or has expired');
    error.statusCode = 401;
    throw error;
  }

  const profileResponse = await fetch(
    `${url}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=is_admin&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  const profiles = await profileResponse.json().catch(() => []);
  if (!profileResponse.ok || profiles?.[0]?.is_admin !== true) {
    const error = new Error('This account does not have admin access');
    error.statusCode = 403;
    throw error;
  }
  return user;
}

async function storage(path, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${url}/storage/v1/${path}`, {
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
    throw new Error(data?.message || data?.error || `Storage HTTP ${response.status}`);
  }
  return data;
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

function publicObjectUrl(bucket, storagePath) {
  const { url } = config();
  return `${url}/storage/v1/object/public/${bucket}/${storagePath.split('/').map(encodeURIComponent).join('/')}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(204, {});
  if (event.httpMethod !== 'POST') return jsonResponse(405, { success: false, error: 'Method not allowed' });

  try {
    await requireAdmin(event);
    const body = JSON.parse(event.body || '{}');
    const action = String(body.action || 'create_upload');

    if (action !== 'create_upload') {
      return jsonResponse(400, { success: false, error: 'Unknown action' });
    }

    const kind = body.kind === 'ship' ? 'ship' : 'logo';
    const conf = BUCKETS[kind];
    const filename = String(body.filename || '').trim();
    const mimeType = String(body.mime_type || body.contentType || '').trim().toLowerCase();
    const sizeBytes = Number(body.size_bytes || 0);
    const recordId = String(body.record_id || 'new').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'new';

    if (!filename) return jsonResponse(400, { success: false, error: 'filename is required' });
    if (!conf.types.has(mimeType)) {
      return jsonResponse(400, {
        success: false,
        error: `Unsupported file type. Allowed: ${[...conf.types].join(', ')}`
      });
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return jsonResponse(400, { success: false, error: 'size_bytes is required' });
    }
    if (sizeBytes > conf.maxBytes) {
      return jsonResponse(400, {
        success: false,
        error: `File too large. Maximum is ${Math.round(conf.maxBytes / (1024 * 1024))} MB`
      });
    }

    const stamp = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    const storagePath = `${recordId}/${stamp}-${rand}-${safeFilename(filename)}`;

    const signed = await storage(`object/upload/sign/${conf.id}/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST',
      body: JSON.stringify({})
    });

    const token = signed?.token || signed?.signedToken;
    if (!token) throw new Error('Storage did not return an upload token');

    return jsonResponse(200, {
      success: true,
      bucket: conf.id,
      storage_path: storagePath,
      token,
      public_url: publicObjectUrl(conf.id, storagePath)
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return jsonResponse(status, {
      success: false,
      error: error.message || 'Upload preparation failed'
    });
  }
};
