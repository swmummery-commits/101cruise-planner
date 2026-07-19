/**
 * Booking document library API.
 * - Customer session: list customer-visible booking documents
 * - Admin session: list all + create/update/delete admin-origin documents
 */

const crypto = require('crypto');
const { requireAdmin, getConfig } = require('./admin-auth');

const BUCKET = 'booking-documents';
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
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function verifyCustomerToken(token, secret) {
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
  const { supabaseUrl, serviceKey } = getConfig();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) throw new Error(data?.message || data?.error || `Supabase HTTP ${response.status}`);
  return data;
}

async function storage(path, options = {}) {
  const { supabaseUrl, serviceKey } = getConfig();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${supabaseUrl}/storage/v1/${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
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
  if (!path) return null;
  const signed = await storage(`object/sign/${BUCKET}/${encodeURI(path)}`, {
    method: 'POST',
    body: JSON.stringify({ expiresIn: 3600 })
  });
  const { supabaseUrl } = getConfig();
  const signedPath = signed?.signedURL || signed?.signedUrl || signed?.signed_url;
  if (!signedPath) return null;
  return signedPath.startsWith('http') ? signedPath : `${supabaseUrl}/storage/v1${signedPath}`;
}

function publicDocumentView(row, { includeInternal = false } = {}) {
  const base = {
    id: row.id,
    document_type: row.document_type,
    filename: row.filename,
    file_url: row.file_url,
    note: row.note_visible_to_customer === false ? null : row.note,
    uploaded_at: row.uploaded_at,
    source_system: row.source_system === 'base44' ? '101cruise' : row.source_system,
    document_visible_to_customer: row.document_visible_to_customer
  };
  if (!includeInternal) return base;
  return {
    ...row,
    note_for_customer: row.note_visible_to_customer === false ? null : row.note
  };
}

async function resolveFileUrl(row) {
  if (row.storage_path) {
    try {
      return await signedDownload(row.storage_path);
    } catch {
      return null;
    }
  }
  return row.file_url || null;
}

function getBearer(event) {
  return String(event.headers.authorization || event.headers.Authorization || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {});

  try {
    const body = event.body ? JSON.parse(event.body || '{}') : {};
    const action = body.action || (event.httpMethod === 'GET' ? 'list' : null);
    const bearer = getBearer(event);

    // ---- Customer path ----
    const customerSession = verifyCustomerToken(bearer, process.env.CUSTOMER_SESSION_SECRET || '');
    if (customerSession && (!action || action === 'list')) {
      const bookingId = String(customerSession.booking_id || '');
      const bookingRef = String(customerSession.booking_reference || '').toUpperCase();
      const filters = [];
      if (bookingRef) filters.push(`booking_reference.eq.${encodeURIComponent(bookingRef)}`);
      if (bookingId) filters.push(`base44_booking_id.eq.${encodeURIComponent(bookingId)}`);
      if (!filters.length) return jsonResponse(400, { success: false, error: 'Booking context is missing.' });

      const rows = await rest(
        `booking_documents?or=(${filters.join(',')})&document_visible_to_customer=eq.true&order=uploaded_at.desc`,
        { method: 'GET' }
      );

      const documents = await Promise.all(
        (rows || []).map(async (row) => {
          const fileUrl = await resolveFileUrl(row);
          return {
            ...publicDocumentView(row),
            file_url: fileUrl,
            file_unavailable: !fileUrl
          };
        })
      );

      return jsonResponse(200, { success: true, documents });
    }

    // ---- Admin path ----
    const adminUser = await requireAdmin(event);

    if (action === 'list' || event.httpMethod === 'GET') {
      const bookingReference = String(body.booking_reference || event.queryStringParameters?.booking_reference || '')
        .trim()
        .toUpperCase();
      const bookingId = String(body.base44_booking_id || event.queryStringParameters?.booking_id || '').trim();
      const filters = [];
      if (bookingReference) filters.push(`booking_reference.eq.${encodeURIComponent(bookingReference)}`);
      if (bookingId) filters.push(`base44_booking_id.eq.${encodeURIComponent(bookingId)}`);
      if (!filters.length) return jsonResponse(400, { success: false, error: 'booking_reference or booking_id is required' });

      const rows = await rest(`booking_documents?or=(${filters.join(',')})&order=uploaded_at.desc`, { method: 'GET' });
      const documents = await Promise.all(
        (rows || []).map(async (row) => ({
          ...publicDocumentView(row, { includeInternal: true }),
          file_url: await resolveFileUrl(row),
          editable: row.source_system === 'admin'
        }))
      );
      return jsonResponse(200, { success: true, documents });
    }

    if (action === 'create_upload') {
      const bookingReference = String(body.booking_reference || '').trim().toUpperCase();
      const bookingId = String(body.base44_booking_id || '').trim();
      const filename = String(body.filename || '').trim();
      const documentType = String(body.document_type || '').trim() || 'Other';
      const mimeType = String(body.mime_type || '').trim().toLowerCase();
      const sizeBytes = Number(body.size_bytes || 0);
      if (!bookingReference && !bookingId) return jsonResponse(400, { success: false, error: 'Booking reference is required.' });
      if (!filename) return jsonResponse(400, { success: false, error: 'Filename is required.' });
      if (!ALLOWED_TYPES.has(mimeType)) return jsonResponse(400, { success: false, error: 'Please upload a PDF, JPG, PNG, DOC or DOCX file.' });
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_FILE_SIZE) {
        return jsonResponse(400, { success: false, error: 'The file must be no larger than 10 MB.' });
      }

      const documentId = crypto.randomUUID();
      const folder = bookingId || bookingReference;
      const storagePath = `${folder}/${documentId}-${safeFilename(filename)}`;
      const signed = await storage(`object/upload/sign/${BUCKET}/${encodeURI(storagePath)}`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      const { supabaseUrl } = getConfig();
      const signedPath = signed?.url || signed?.signedURL || signed?.signedUrl || signed?.signed_url;
      if (!signedPath) throw new Error('Could not create the secure upload link');
      const uploadUrl = signedPath.startsWith('http') ? signedPath : `${supabaseUrl}/storage/v1${signedPath}`;

      return jsonResponse(200, {
        success: true,
        upload: {
          id: documentId,
          storage_path: storagePath,
          upload_url: uploadUrl,
          token: signed?.token || null,
          booking_reference: bookingReference || null,
          base44_booking_id: bookingId || null,
          document_type: documentType
        }
      });
    }

    if (action === 'complete_upload') {
      const bookingReference = String(body.booking_reference || '').trim().toUpperCase() || null;
      const bookingId = String(body.base44_booking_id || '').trim() || null;
      const syncKey = `admin:${body.id || crypto.randomUUID()}`;
      const row = {
        id: String(body.id || crypto.randomUUID()),
        booking_reference: bookingReference,
        base44_booking_id: bookingId,
        base44_document_id: null,
        document_type: String(body.document_type || 'Other').trim() || 'Other',
        filename: String(body.filename || '').trim() || null,
        file_url: null,
        storage_path: String(body.storage_path || '').trim() || null,
        note: String(body.note || body.notes || '').trim() || null,
        note_visible_to_customer: body.note_visible_to_customer !== false,
        document_visible_to_customer: body.document_visible_to_customer !== false,
        uploaded_at: new Date().toISOString(),
        uploaded_by: adminUser.email || adminUser.id,
        source_system: 'admin',
        sync_key: syncKey,
        last_synced_at: null
      };
      if (!row.storage_path || !row.filename) return jsonResponse(400, { success: false, error: 'Upload details are incomplete.' });
      const data = await rest('booking_documents', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row)
      });
      return jsonResponse(200, { success: true, document: data?.[0] || data });
    }

    if (action === 'update') {
      const id = String(body.id || '').trim();
      if (!id) return jsonResponse(400, { success: false, error: 'Document id is required.' });
      const existingRows = await rest(`booking_documents?id=eq.${encodeURIComponent(id)}&limit=1`, { method: 'GET' });
      const existing = existingRows?.[0];
      if (!existing) return jsonResponse(404, { success: false, error: 'Document not found.' });
      if (existing.source_system !== 'admin') {
        return jsonResponse(403, { success: false, error: 'Base44 documents are managed in Base44 and cannot be edited here.' });
      }
      const patch = {
        document_type: body.document_type != null ? String(body.document_type).trim() || existing.document_type : existing.document_type,
        note: body.note != null || body.notes != null ? String(body.note || body.notes || '').trim() || null : existing.note,
        note_visible_to_customer:
          body.note_visible_to_customer != null ? Boolean(body.note_visible_to_customer) : existing.note_visible_to_customer,
        document_visible_to_customer:
          body.document_visible_to_customer != null
            ? Boolean(body.document_visible_to_customer)
            : existing.document_visible_to_customer
      };
      const data = await rest(`booking_documents?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch)
      });
      return jsonResponse(200, { success: true, document: data?.[0] || data });
    }

    if (action === 'delete') {
      const id = String(body.id || '').trim();
      if (!id) return jsonResponse(400, { success: false, error: 'Document id is required.' });
      const existingRows = await rest(`booking_documents?id=eq.${encodeURIComponent(id)}&limit=1`, { method: 'GET' });
      const existing = existingRows?.[0];
      if (!existing) return jsonResponse(404, { success: false, error: 'Document not found.' });
      if (existing.source_system !== 'admin') {
        return jsonResponse(403, { success: false, error: 'Base44 documents are managed in Base44 and cannot be deleted here.' });
      }
      if (existing.storage_path) {
        try {
          await storage(`object/${BUCKET}/${encodeURI(existing.storage_path)}`, { method: 'DELETE' });
        } catch (storageError) {
          console.warn('Could not delete storage object', storageError.message || storageError);
        }
      }
      await rest(`booking_documents?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      return jsonResponse(200, { success: true });
    }

    return jsonResponse(400, { success: false, error: 'Unsupported action' });
  } catch (error) {
    console.error('Booking documents error', error);
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || 'Unexpected server error'
    });
  }
};
