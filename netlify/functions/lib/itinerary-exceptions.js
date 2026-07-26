/**
 * Persistent Needs Attention queue for itinerary exceptions.
 * Viewing never clears; resolve/dismiss/supersede only.
 */

"use strict";

const crypto = require("crypto");
const path = require("path");
const {
  buildItineraryStatusView,
  EFFECTIVE,
  AWAITING_STALE_MS,
  LOCK_TTL_MS
} = require(path.join(__dirname, "../../../js/itinerary-processing-status.js"));

const EXCEPTION_KINDS = Object.freeze({
  REVIEW_REQUIRED: "review_required",
  FAILED: "failed",
  REPLACEMENT_CONFLICT: "replacement_conflict",
  AWAITING_STALE: "awaiting_extraction_stale",
  APPROVED_INVALIDATED: "approved_invalidated"
});

const OPEN_STATUSES = Object.freeze(["open"]);
const STALE_EXTRACTION_MS = AWAITING_STALE_MS;

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

function isDocumentProcessingStalled(doc, now = Date.now(), staleMs = STALE_EXTRACTION_MS) {
  const status = String(doc?.itinerary_processing_status || "").trim();
  const lockUntil = doc?.itinerary_process_lock_until
    ? new Date(doc.itinerary_process_lock_until).getTime()
    : 0;
  if (status === "processing") {
    // Active lock = still processing; do not flag from Base44 uploaded_at.
    if (lockUntil > now) return false;
    return true;
  }
  if (status === "awaiting_extraction") {
    const started =
      (doc.updated_at && new Date(doc.updated_at).getTime()) ||
      (doc.created_at && new Date(doc.created_at).getTime()) ||
      0;
    if (!started) return false;
    return now - started > staleMs;
  }
  return false;
}

/**
 * Scan booking_documents for stalled awaiting/processing confirmations.
 * Uses lock/updated timing — not Base44 uploaded_at (which can be days old).
 */
async function scanStaleExtractionExceptions(rest, options = {}) {
  const staleMs = options.staleMs || STALE_EXTRACTION_MS;
  const now = Date.now();
  const rows = await rest(
    `booking_documents?document_type=ilike.*Booking Confirmation*&itinerary_processing_status=in.(awaiting_extraction,processing)&select=id,booking_reference,base44_booking_id,filename,document_type,itinerary_processing_status,itinerary_process_lock_until,itinerary_last_processed_at,uploaded_at,created_at,updated_at,content_fingerprint&limit=100`,
    { method: "GET" }
  ).catch(() => []);

  const results = [];
  for (const doc of Array.isArray(rows) ? rows : []) {
    if (!isDocumentProcessingStalled(doc, now, staleMs)) continue;
    // eslint-disable-next-line no-await-in-loop
    const upserted = await upsertItineraryException(rest, {
      booking_id: doc.base44_booking_id || doc.booking_reference || doc.id,
      booking_reference: doc.booking_reference,
      source_filename: doc.filename,
      source_document_id: doc.id,
      source_document_hash: doc.content_fingerprint,
      exception_kind: EXCEPTION_KINDS.AWAITING_STALE,
      concise_reason: "automatic itinerary extraction stalled",
      reason_codes: ["processing_stalled"],
      validation_failures: [
        {
          code: "processing_stalled",
          message:
            "Automatic itinerary extraction did not complete. Review the error or retry extraction."
        }
      ]
    });
    results.push(upserted);
  }
  return results;
}

function publicExceptionView(row, enrich = {}) {
  if (!row) return null;
  const waiting = awaitingMs(row.first_flagged_at);
  const statusView = buildItineraryStatusView({
    document: enrich.document || {
      id: row.source_document_id,
      filename: row.source_filename,
      content_fingerprint: row.source_document_hash,
      itinerary_processing_status:
        row.exception_kind === EXCEPTION_KINDS.AWAITING_STALE
          ? "processing"
          : row.exception_kind === EXCEPTION_KINDS.FAILED
            ? "failed"
            : row.exception_kind === EXCEPTION_KINDS.REVIEW_REQUIRED
              ? "review_required"
              : null,
      itinerary_process_lock_until: enrich.document?.itinerary_process_lock_until || null,
      itinerary_last_processed_at: enrich.document?.itinerary_last_processed_at || null,
      updated_at: row.updated_at,
      created_at: row.created_at
    },
    itinerary: enrich.itinerary || null,
    exception: row
  });
  return {
    id: row.id,
    booking_id: row.booking_id,
    booking_reference: row.booking_reference,
    customer_names: row.customer_names,
    cruise_line: row.cruise_line,
    ship_name: row.ship_name,
    departure_date: row.departure_date,
    source_filename: row.source_filename,
    source_document_id: row.source_document_id || null,
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
    last_email_status: row.last_email_status || null,
    effective_status: statusView.key,
    effective_status_label: statusView.label,
    effective_status_tone: statusView.tone,
    action_message: statusView.action_message,
    timing_lines: statusView.timing_lines,
    can_retry: statusView.can_retry,
    status_details: statusView.details
  };
}

module.exports = {
  EXCEPTION_KINDS,
  OPEN_STATUSES,
  STALE_EXTRACTION_MS,
  LOCK_TTL_MS,
  EFFECTIVE,
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
  isDocumentProcessingStalled,
  publicExceptionView,
  formatAwaiting,
  awaitingMs,
  buildItineraryStatusView
};
