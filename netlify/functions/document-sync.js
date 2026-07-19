/**
 * Base44 → booking_documents sync helpers.
 * Idempotent via sync_key / base44_document_id.
 * Never overwrites admin-origin or customer-origin rows.
 */

const crypto = require('crypto');

function normalise(value) {
  return String(value || '').trim();
}

function pickVisibility(doc) {
  // Canonical Base44 CruiseDocument field: visible_to_client (whole document).
  const candidates = [
    doc.visible_to_client,
    doc.document_visible_to_customer,
    doc.visible_to_customer,
    doc.is_visible_to_client,
    doc.show_on_website,
    doc.customer_visible,
    doc.visible_on_101cruise,
    doc.visible_to_client_on_website,
    doc.visible_to_client_on_101cruise_website
  ];
  for (const value of candidates) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (['true', 'yes', '1'].includes(lowered)) return true;
      if (['false', 'no', '0'].includes(lowered)) return false;
    }
    if (value === 1) return true;
    if (value === 0) return false;
  }
  // Preserve current My Cruise behaviour when Base44 omits the checkbox field.
  return true;
}

function pickNoteVisibility(doc, documentVisible) {
  const candidates = [
    doc.note_visible_to_customer,
    doc.notes_visible_to_customer,
    doc.note_visible_to_client,
    doc.notes_visible
  ];
  for (const value of candidates) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (['true', 'yes', '1'].includes(lowered)) return true;
      if (['false', 'no', '0'].includes(lowered)) return false;
    }
  }
  // No separate note-visibility field observed: note follows document visibility.
  return documentVisible;
}

function pickBase44DocumentId(doc) {
  // Canonical Base44 CruiseDocument record ID is `id`.
  const candidates = [doc.id, doc.base44_document_id, doc.document_id, doc._id];
  for (const value of candidates) {
    if (value == null || value === '') continue;
    return String(value);
  }
  return null;
}

function buildSyncKey({ base44BookingId, bookingReference, base44DocumentId, fileUrl, filename, documentType }) {
  if (base44DocumentId) return `base44:${base44DocumentId}`;
  const material = [
    normalise(base44BookingId || bookingReference).toLowerCase(),
    normalise(fileUrl),
    normalise(filename).toLowerCase(),
    normalise(documentType).toLowerCase()
  ].join('|');
  const hash = crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
  return `base44-hash:${hash}`;
}

function mapBase44Document(doc, booking = {}) {
  const documentVisible = pickVisibility(doc);
  const noteVisible = pickNoteVisibility(doc, documentVisible);
  const base44DocumentId = pickBase44DocumentId(doc);
  const base44BookingId = normalise(booking.base44_booking_id) || null;
  const bookingReference = normalise(booking.booking_reference).toUpperCase() || null;
  const documentType = normalise(doc.document_type) || 'Other';
  const filename = normalise(doc.filename) || null;
  const fileUrl = normalise(doc.file_url || doc.url || doc.file) || null;
  const note = doc.notes == null || doc.notes === '' ? null : String(doc.notes);
  const uploadedAt = doc.uploaded_date || doc.uploaded_at || null;
  const syncKey = buildSyncKey({
    base44BookingId,
    bookingReference,
    base44DocumentId,
    fileUrl,
    filename,
    documentType
  });

  return {
    booking_reference: bookingReference,
    base44_booking_id: base44BookingId,
    base44_document_id: base44DocumentId,
    document_type: documentType,
    filename,
    file_url: fileUrl,
    storage_path: null,
    note,
    note_visible_to_customer: noteVisible,
    document_visible_to_customer: documentVisible,
    uploaded_at: uploadedAt ? new Date(uploadedAt).toISOString() : null,
    uploaded_by: null,
    source_system: 'base44',
    sync_key: syncKey,
    last_synced_at: new Date().toISOString()
  };
}

function extractDocumentsFromBookingPayload(booking, source = null) {
  const fromSource = Array.isArray(source?.documents) ? source.documents : null;
  const fromBooking = Array.isArray(booking?.documents) ? booking.documents : null;
  return fromSource || fromBooking || [];
}

/**
 * Upsert Base44 documents. Skips keys owned by admin/customer.
 * When an existing Base44 row was updated after last_synced_at (Admin edit),
 * skip overwrite — deliberate conflict rule.
 */
async function syncBookingDocuments(rest, booking, source = null) {
  const rawDocs = extractDocumentsFromBookingPayload(booking, source);
  const mapped = rawDocs.map((doc) => mapBase44Document(doc, booking)).filter((row) => row.sync_key);
  if (!mapped.length) {
    return {
      found: 0,
      upserted: 0,
      skipped_conflict: 0,
      skipped_other_source: 0,
      errors: [],
      rows: []
    };
  }

  const result = {
    found: mapped.length,
    upserted: 0,
    skipped_conflict: 0,
    skipped_other_source: 0,
    errors: [],
    rows: []
  };

  for (const row of mapped) {
    try {
      const existingRows = await rest(
        `booking_documents?sync_key=eq.${encodeURIComponent(row.sync_key)}&select=*&limit=1`,
        { method: 'GET' }
      );
      const existing = Array.isArray(existingRows) ? existingRows[0] : null;

      if (existing && existing.source_system && existing.source_system !== 'base44') {
        result.skipped_other_source += 1;
        continue;
      }

      if (
        existing &&
        existing.updated_at &&
        existing.last_synced_at &&
        new Date(existing.updated_at).getTime() > new Date(existing.last_synced_at).getTime() + 2000
      ) {
        // Admin (or other) edited this synced row after the last Base44 sync.
        result.skipped_conflict += 1;
        continue;
      }

      const data = await rest('booking_documents?on_conflict=sync_key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row)
      });
      const saved = Array.isArray(data) ? data[0] : data;
      if (saved) result.rows.push(saved);
      result.upserted += 1;
    } catch (error) {
      result.errors.push({
        sync_key: row.sync_key,
        filename: row.filename,
        message: error.message || String(error)
      });
    }
  }

  return result;
}

module.exports = {
  mapBase44Document,
  extractDocumentsFromBookingPayload,
  syncBookingDocuments,
  pickVisibility,
  pickBase44DocumentId,
  buildSyncKey
};
