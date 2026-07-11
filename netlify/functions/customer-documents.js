const crypto = require('crypto');

const BUCKET = 'customer-documents';
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

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

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase server access is not configured');
  return { url: url.replace(/\/$/, ''), key };
}

async function rest(path, options = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || `Supabase HTTP ${response.status}`);
  return data;
}

async function storage(path, options = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/storage/v1/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(data?.message || data?.error || `Storage HTTP ${response.status}`);
  return data;
}

function safeFilename(value) {
  const original = String(value || 'document').trim();
  const dot = original.lastIndexOf('.');
  const ext = dot > 0 ? original.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, '') : '';
  const stem = (dot > 0 ? original.slice(0, dot) : original)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'document';
  return `${stem}${ext}`;
}

async function signedDownload(path) {
  const signed = await storage(`object/sign/${BUCKET}/${encodeURI(path)}`, {
    method: 'POST',
    body: JSON.stringify({ expiresIn: 3600 })
  });
  const { url } = config();
  const signedPath = signed?.signedURL || signed?.signedUrl || signed?.signed_url;
  if (!signedPath) return null;
  return signedPath.startsWith('http') ? signedPath : `${url}/storage/v1${signedPath}`;
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
    const bookingId = String(session.booking_id || '');
    const action = body.action;

    if (action === 'list') {
      const rows = await rest(`customer_documents?booking_id=eq.${encodeURIComponent(bookingId)}&order=uploaded_at.desc`, { method: 'GET' });
      const documents = await Promise.all((rows || []).map(async row => ({
        ...row,
        file_url: await signedDownload(row.storage_path)
      })));
      return jsonResponse(200, { success: true, documents });
    }

    if (action === 'create_upload') {
      const filename = String(body.filename || '').trim();
      const documentType = String(body.document_type || '').trim();
      const mimeType = String(body.mime_type || '').trim().toLowerCase();
      const sizeBytes = Number(body.size_bytes || 0);
      if (!filename || !documentType) return jsonResponse(400, { success: false, error: 'Document type and file are required.' });
      if (!ALLOWED_TYPES.has(mimeType)) return jsonResponse(400, { success: false, error: 'Please upload a PDF, JPG, PNG, DOC or DOCX file.' });
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_FILE_SIZE) return jsonResponse(400, { success: false, error: 'The file must be no larger than 10 MB.' });

      const documentId = crypto.randomUUID();
      const storagePath = `${bookingId}/${documentId}-${safeFilename(filename)}`;
      const signed = await storage(`object/upload/sign/${BUCKET}/${encodeURI(storagePath)}`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      const { url } = config();
      const signedPath = signed?.url || signed?.signedURL || signed?.signedUrl || signed?.signed_url;
      if (!signedPath) throw new Error('Could not create the secure upload link');
      const uploadUrl = signedPath.startsWith('http') ? signedPath : `${url}/storage/v1${signedPath}`;

      return jsonResponse(200, {
        success: true,
        upload: {
          id: documentId,
          storage_path: storagePath,
          upload_url: uploadUrl,
          token: signed?.token || null
        }
      });
    }

    if (action === 'complete_upload') {
      const row = {
        id: String(body.id || ''),
        booking_id: bookingId,
        document_type: String(body.document_type || '').trim(),
        filename: String(body.filename || '').trim(),
        storage_path: String(body.storage_path || '').trim(),
        mime_type: String(body.mime_type || '').trim(),
        size_bytes: Number(body.size_bytes || 0),
        notes: String(body.notes || '').trim() || null,
        uploaded_at: new Date().toISOString()
      };
      if (!row.id || !row.document_type || !row.filename || !row.storage_path) return jsonResponse(400, { success: false, error: 'Upload details are incomplete.' });
      if (!row.storage_path.startsWith(`${bookingId}/`)) return jsonResponse(403, { success: false, error: 'Invalid upload path.' });
      const data = await rest('customer_documents', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row)
      });
      return jsonResponse(200, { success: true, document: data?.[0] || data });
    }

    if (action === 'delete') {
      const id = String(body.id || '');
      const rows = await rest(`customer_documents?id=eq.${encodeURIComponent(id)}&booking_id=eq.${encodeURIComponent(bookingId)}&limit=1`, { method: 'GET' });
      const row = rows?.[0];
      if (!row) return jsonResponse(404, { success: false, error: 'Document not found.' });
      await storage(`object/${BUCKET}/${encodeURI(row.storage_path)}`, { method: 'DELETE' });
      await rest(`customer_documents?id=eq.${encodeURIComponent(id)}&booking_id=eq.${encodeURIComponent(bookingId)}`, { method: 'DELETE' });
      return jsonResponse(200, { success: true });
    }

    return jsonResponse(400, { success: false, error: 'Unsupported action' });
  } catch (error) {
    console.error('Customer documents error', error);
    return jsonResponse(500, { success: false, error: error.message || 'Unexpected server error' });
  }
};
