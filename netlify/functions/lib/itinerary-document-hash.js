/**
 * Stable fingerprints for Booking Confirmation documents.
 * Used for one-shot extraction idempotency — not cryptographic content hashing of PDF bytes
 * (file bytes are not always available server-side); identity is material document metadata.
 */

"use strict";

const crypto = require("crypto");

function normalise(value) {
  return String(value == null ? "" : value).trim();
}

/**
 * Stable document fingerprint for extraction idempotency.
 * Changes when the confirmation file identity changes (url, storage path, upload time, id).
 */
function fingerprintBookingDocument(document) {
  const material = [
    normalise(document?.id),
    normalise(document?.base44_document_id),
    normalise(document?.sync_key),
    normalise(document?.file_url),
    normalise(document?.storage_path),
    normalise(document?.filename).toLowerCase(),
    normalise(document?.document_type).toLowerCase(),
    normalise(document?.uploaded_at || document?.uploaded_date)
  ].join("|");
  return crypto.createHash("sha256").update(material).digest("hex");
}

function isBookingConfirmationType(documentType) {
  return String(documentType || "")
    .toLowerCase()
    .includes("booking confirmation");
}

module.exports = {
  fingerprintBookingDocument,
  isBookingConfirmationType
};
