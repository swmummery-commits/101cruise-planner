/**
 * Persistent Needs Attention queue for itinerary exceptions.
 * Viewing never clears; resolve/dismiss/supersede only.
 */

"use strict";

const crypto = require("crypto");

const EXCEPTION_KINDS = Object.freeze({
  REVIEW_REQUIRED: "review_required",
  FAILED: "failed",
  REPLACEMENT_CONFLICT: "replacement_conflict",
  AWAITING_STALE: "awaiting_extraction_stale",
  APPROVED_INVALIDATED: "approved_invalidated"
});

const OPEN_STATUSES = Object.freeze(["open"]);
const STALE_EXTRACTION_MS = 15 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function fingerprintReasons(codes = [], summary = "") {
  const normalised = [...new Set((codes || []).map((c) => String(c || "").trim()).filter(Boolean))]
    .sort()
    .join("|");
  const material = `${normalised}::${String(summary || "").trim().toLowerCase()}`;
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
}

function customerNamesFromBooking(booking = {}) {
  const p1 = [booking.passenger1_first_name, booking.passenger1_last_name].filter(Boolean).join(" ");
  const p2 = [booking.passenger2_first_name, booking.passenger2_last_name].filter(Boolean).join(" ");
  return [p1, p2].filter(Boolean).join(" · ") || null;
}

function buildAdminReviewPath(bookingReference) {
  const ref = String(bookingReference || "").trim();
  if (!ref) return "/admin.html#booking-documents";
  return `/admin.html#booking-documents?ref=${encodeURIComponent(ref)}`;
}

function awaitingMs(firstFlaggedAt) {
  const t = new Date(firstFlaggedAt || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.max(0, Date.now() - t);
}

function formatAwaiting(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Upsert an open exception. Returns { exception, created, reason_changed, should_notify }.
 */
async function upsertItineraryException(rest, input = {}) {
  const bookingId = String(input.booking_id || "").trim();
  if (!bookingId) throw new Error("booking_id is required for itinerary exception");

  const kind = String(input.exception_kind || EXCEPTION_KINDS.REVIEW_REQUIRED);
  const codes = Array.isArray(input.reason_codes)
    ? input.reason_codes.map((c) => String(c))
    : (input.validation_failures || []).map((f) => f.code).filter(Boolean);
  const summary = String(input.concise_reason || input.summary || "review required");
  const fp = fingerprintReasons(codes, summary);

  const existingRows = await rest(
    `itinerary_exceptions?booking_id=eq.${encodeURIComponent(bookingId)}&exception_kind=eq.${encodeURIComponent(kind)}&status=eq.open&select=*&limit=1`,
    { method: "GET" }
  ).catch(() => []);
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;

  const base = {
    booking_id: bookingId,
    booking_reference: input.booking_reference || null,
    customer_names: input.customer_names || customerNamesFromBooking(input.booking) || null,
    cruise_line: input.cruise_line || input.booking?.cruise_line || null,
    ship_name: input.ship_name || input.booking?.cruise_ship || null,
    departure_date: input.departure_date || input.booking?.departing_date || null,
    source_filename: input.source_filename || null,
    source_document_id: input.source_document_id || null,
    source_document_hash: input.source_document_hash || null,
    exception_kind: kind,
    status: "open",
    concise_reason: summary,
    reason_codes: codes,
    reason_fingerprint: fp,
    validation_failures: input.validation_failures || null,
    last_flagged_at: nowIso(),
    cruise_itinerary_booking_id: bookingId,
    admin_review_path: buildAdminReviewPath(input.booking_reference || input.booking?.booking_reference),
    updated_at: nowIso()
  };

  if (!existing) {
    const payload = {
      ...base,
      first_flagged_at: nowIso(),
      assigned_admin_user_id: input.assigned_admin_user_id || null
    };
    const rows = await rest("itinerary_exceptions", {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify(payload)
    });
    const exception = rows?.[0] || payload;
    return {
      exception,
      created: true,
      reason_changed: true,
      should_notify: true
    };
  }

  const reasonChanged = existing.reason_fingerprint !== fp;
  const patch = {
    ...base,
    first_flagged_at: existing.first_flagged_at,
    assigned_admin_user_id: existing.assigned_admin_user_id
  };
  const rows = await rest(`itinerary_exceptions?id=eq.${encodeURIComponent(existing.id)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: JSON.stringify(patch)
  });
  const exception = rows?.[0] || { ...existing, ...patch };
  return {
    exception,
    created: false,
    reason_changed: reasonChanged,
    should_notify: reasonChanged
  };
}

async function resolveItineraryExceptionsForBooking(rest, bookingId, resolution = "approved", actor = null) {
  const id = String(bookingId || "").trim();
  if (!id) return { updated: 0 };
  const patch = {
    status: resolution === "superseded" ? "superseded" : "resolved",
    resolution: String(resolution || "resolved"),
    resolved_at: nowIso(),
    resolved_by: actor || null,
    updated_at: nowIso()
  };
  const rows = await rest(
    `itinerary_exceptions?booking_id=eq.${encodeURIComponent(id)}&status=eq.open`,
    {
      method: "PATCH",
      prefer: "return=representation",
      body: JSON.stringify(patch)
    }
  ).catch(() => []);
  return { updated: Array.isArray(rows) ? rows.length : 0, rows: rows || [] };
}

async function dismissItineraryException(rest, exceptionId, dismissReason, actor = null) {
  const id = String(exceptionId || "").trim();
  if (!id) throw new Error("exception id required");
  const reason = String(dismissReason || "").trim();
  if (!reason) throw new Error("dismiss reason is required");
  const rows = await rest(`itinerary_exceptions?id=eq.${encodeURIComponent(id)}&status=eq.open`, {
    method: "PATCH",
    prefer: "return=representation",
    body: JSON.stringify({
      status: "dismissed",
      dismiss_reason: reason,
      resolution: "dismissed",
      resolved_at: nowIso(),
      resolved_by: actor || null,
      updated_at: nowIso()
    })
  });
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("Dismiss did not update exactly one open exception");
  }
  return rows[0];
}

async function assignItineraryException(rest, exceptionId, adminUserId) {
  const id = String(exceptionId || "").trim();
  const rows = await rest(`itinerary_exceptions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: JSON.stringify({
      assigned_admin_user_id: adminUserId || null,
      updated_at: nowIso()
    })
  });
  return rows?.[0] || null;
}

async function listOpenItineraryExceptions(rest) {
  const rows = await rest(
    "itinerary_exceptions?status=eq.open&select=*&order=first_flagged_at.asc&limit=200",
    { method: "GET" }
  ).catch(() => []);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const waiting = awaitingMs(row.first_flagged_at);
    return {
      ...row,
      awaiting_ms: waiting,
      awaiting_label: formatAwaiting(waiting)
    };
  });
}

async function countOpenItineraryExceptions(rest) {
  const rows = await listOpenItineraryExceptions(rest);
  return rows.length;
}

/**
 * Scan booking_documents for stale awaiting/processing confirmations.
 */
async function scanStaleExtractionExceptions(rest, options = {}) {
  const staleBefore = new Date(Date.now() - (options.staleMs || STALE_EXTRACTION_MS)).toISOString();
  const rows = await rest(
    `booking_documents?document_type=ilike.*Booking Confirmation*&itinerary_processing_status=in.(awaiting_extraction,processing)&or=(itinerary_last_processed_at.is.null,uploaded_at.lt.${encodeURIComponent(staleBefore)})&select=id,booking_reference,base44_booking_id,filename,document_type,itinerary_processing_status,uploaded_at,content_fingerprint&limit=100`,
    { method: "GET" }
  ).catch(() => []);

  const results = [];
  for (const doc of Array.isArray(rows) ? rows : []) {
    const uploaded = doc.uploaded_at ? new Date(doc.uploaded_at).getTime() : 0;
    if (uploaded && Date.now() - uploaded < (options.staleMs || STALE_EXTRACTION_MS)) continue;
    // eslint-disable-next-line no-await-in-loop
    const upserted = await upsertItineraryException(rest, {
      booking_id: doc.base44_booking_id || doc.booking_reference || doc.id,
      booking_reference: doc.booking_reference,
      source_filename: doc.filename,
      source_document_id: doc.id,
      source_document_hash: doc.content_fingerprint,
      exception_kind: EXCEPTION_KINDS.AWAITING_STALE,
      concise_reason: "awaiting extraction beyond expected processing period",
      reason_codes: ["awaiting_extraction_stale"],
      validation_failures: [
        {
          code: "awaiting_extraction_stale",
          message: "Booking Confirmation has not completed itinerary extraction within the expected period"
        }
      ]
    });
    results.push(upserted);
  }
  return results;
}

function publicExceptionView(row) {
  if (!row) return null;
  const waiting = awaitingMs(row.first_flagged_at);
  return {
    id: row.id,
    booking_id: row.booking_id,
    booking_reference: row.booking_reference,
    customer_names: row.customer_names,
    cruise_line: row.cruise_line,
    ship_name: row.ship_name,
    departure_date: row.departure_date,
    source_filename: row.source_filename,
    exception_kind: row.exception_kind,
    status: row.status,
    concise_reason: row.concise_reason,
    reason_codes: row.reason_codes || [],
    validation_failures: row.validation_failures || [],
    first_flagged_at: row.first_flagged_at,
    awaiting_ms: waiting,
    awaiting_label: formatAwaiting(waiting),
    assigned_admin_user_id: row.assigned_admin_user_id || null,
    admin_review_path: row.admin_review_path || buildAdminReviewPath(row.booking_reference),
    last_email_status: row.last_email_status || null
  };
}

module.exports = {
  EXCEPTION_KINDS,
  OPEN_STATUSES,
  STALE_EXTRACTION_MS,
  fingerprintReasons,
  customerNamesFromBooking,
  buildAdminReviewPath,
  upsertItineraryException,
  resolveItineraryExceptionsForBooking,
  dismissItineraryException,
  assignItineraryException,
  listOpenItineraryExceptions,
  countOpenItineraryExceptions,
  scanStaleExtractionExceptions,
  publicExceptionView,
  formatAwaiting,
  awaitingMs
};
