/**
 * Base44 → booking_documents mirror sync.
 * Downloads CRM documents server-side into private Storage; soft-archives removals.
 */

"use strict";

const crypto = require("crypto");
const {
  fingerprintBookingDocument,
  isBookingConfirmationType
} = require("./itinerary-document-hash");
const { processTextItinerary } = require("./text-itinerary-process");

const BUCKET = "booking-documents";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);

const CUSTOMER_DOCUMENT_TYPES = [
  "Booking Confirmation",
  "Travel Insurance",
  "Visas",
  "Vaccinations",
  "Electronic Tickets/Boarding Pass",
  "Other"
];

function normalise(value) {
  return String(value || "").trim();
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeFilename(value) {
  const original = String(value || "document").trim();
  const dot = original.lastIndexOf(".");
  const ext = dot > 0 ? original.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, "") : "";
  const stem = (dot > 0 ? original.slice(0, dot) : original)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "document";
  return `${stem}${ext}`;
}

function normaliseDocumentType(raw) {
  const value = normalise(raw);
  if (!value) return "Other";
  const lower = value.toLowerCase();
  if (lower.includes("booking confirmation") || lower === "confirmation") return "Booking Confirmation";
  if (lower.includes("insurance")) return "Travel Insurance";
  if (lower.includes("visa")) return "Visas";
  if (lower.includes("vaccin")) return "Vaccinations";
  if (lower.includes("ticket") || lower.includes("boarding")) return "Electronic Tickets/Boarding Pass";
  for (const known of CUSTOMER_DOCUMENT_TYPES) {
    if (known.toLowerCase() === lower) return known;
  }
  return "Other";
}

function pickVisibility() {
  // Base44 booking library documents are customer-facing; CRM has no usable visibility control.
  return true;
}

function pickNoteVisibility(doc) {
  const candidates = [
    doc.note_visible_to_customer,
    doc.notes_visible_to_customer,
    doc.note_visible_to_client,
    doc.notes_visible
  ];
  for (const value of candidates) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      if (["true", "yes", "1"].includes(lowered)) return true;
      if (["false", "no", "0"].includes(lowered)) return false;
    }
  }
  return true;
}

function pickBase44DocumentId(doc) {
  for (const value of [doc.id, doc.base44_document_id, doc.document_id, doc._id]) {
    if (value == null || value === "") continue;
    return String(value);
  }
  return null;
}

function buildSourceFingerprint({ base44DocumentId, base44BookingId, filename, uploadedAt, sourceFileUrlHash }) {
  if (base44DocumentId) return base44DocumentId;
  const material = [
    normalise(base44BookingId).toLowerCase(),
    normalise(filename).toLowerCase(),
    normalise(uploadedAt),
    normalise(sourceFileUrlHash)
  ].join("|");
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
}

function buildSyncKey({ base44DocumentId, base44BookingId, bookingReference, fileUrl, filename, documentType }) {
  if (base44DocumentId) return `base44:${base44DocumentId}`;
  const material = [
    normalise(base44BookingId || bookingReference).toLowerCase(),
    normalise(fileUrl),
    normalise(filename).toLowerCase(),
    normalise(documentType).toLowerCase()
  ].join("|");
  const hash = crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
  return `base44-hash:${hash}`;
}

function buildStoragePath({ base44BookingId, sourceFingerprint, filename }) {
  const folder = normalise(base44BookingId) || "unknown-booking";
  return `${folder}/${sourceFingerprint}/${safeFilename(filename)}`;
}

function guessMimeType(filename, responseHeaders = {}) {
  const header = normalise(responseHeaders["content-type"] || responseHeaders["Content-Type"]).split(";")[0].toLowerCase();
  if (ALLOWED_MIME.has(header)) return header;
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return header || "application/octet-stream";
}

function mapBase44Document(doc, booking = {}) {
  const documentVisible = pickVisibility(doc);
  const noteVisible = pickNoteVisibility(doc);
  const base44DocumentId = pickBase44DocumentId(doc);
  const base44BookingId = normalise(booking.base44_booking_id) || null;
  const bookingReference = normalise(booking.booking_reference).toUpperCase() || null;
  const originalFilename = normalise(doc.filename) || null;
  const documentType = normaliseDocumentType(doc.document_type);
  const filename = originalFilename;
  const fileUrl = normalise(doc.file_url || doc.url || doc.file) || null;
  const sourceFileUrlHash = fileUrl ? hashValue(fileUrl) : null;
  const note = doc.notes == null || doc.notes === "" ? null : String(doc.notes);
  const uploadedRaw = doc.uploaded_date || doc.uploaded_at || null;
  const uploadedAt = uploadedRaw ? new Date(uploadedRaw).toISOString() : null;
  const sourceFingerprint = buildSourceFingerprint({
    base44DocumentId,
    base44BookingId,
    filename,
    uploadedAt,
    sourceFileUrlHash
  });
  const syncKey = buildSyncKey({
    base44DocumentId,
    base44BookingId,
    bookingReference,
    fileUrl,
    filename,
    documentType
  });
  const now = new Date().toISOString();

  const mapped = {
    booking_reference: bookingReference,
    base44_booking_id: base44BookingId,
    base44_document_id: base44DocumentId,
    source_fingerprint: sourceFingerprint,
    source_file_url_hash: sourceFileUrlHash,
    original_filename: originalFilename,
    document_type: documentType,
    filename,
    file_url: fileUrl,
    storage_bucket: null,
    storage_path: null,
    note,
    note_visible_to_customer: noteVisible,
    document_visible_to_customer: documentVisible,
    uploaded_at: uploadedAt,
    uploaded_by: null,
    source_system: "base44",
    sync_key: syncKey,
    last_synced_at: now,
    last_seen_at: now,
    synced_at: now,
    is_active: true,
    source_deleted_at: null
  };
  mapped.content_fingerprint = fingerprintBookingDocument({
    ...mapped,
    id: base44DocumentId,
    uploaded_date: mapped.uploaded_at
  });
  return mapped;
}

function extractDocumentsFromBookingPayload(booking, source = null) {
  const fromSource = Array.isArray(source?.documents) ? source.documents : null;
  const fromBooking = Array.isArray(booking?.documents) ? booking.documents : null;
  return fromSource || fromBooking || [];
}

function emptySummary() {
  return {
    discovered: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    archived: 0,
    failed: 0,
    skipped_conflict: 0,
    skipped_other_source: 0,
    skipped_invalid: 0,
    found: 0,
    upserted: 0,
    errors: [],
    failed_items: [],
    rows: [],
    text_itinerary_process: [],
    complete_fetch: true,
    interrupted: false,
    partial: false
  };
}

function isIncompleteMirror(row) {
  if (!row || row.source_system !== "base44") return false;
  if (row.storage_path) return false;
  if (row.source_deleted_at) return false;
  if (row.is_active === false) return true;
  return row.document_visible_to_customer === false && row.is_active !== true;
}

function shouldExposeMirroredDocument(row) {
  return Boolean(row) && !isIncompleteMirror(row);
}

function safeLogText(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(?:bearer|apikey|api[_-]?key|service_role|token)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, 300);
}

function logSyncStage(stage, fields = {}) {
  const payload = { event: "booking_document_sync", stage };
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    if (/url|secret|token|authorization|apikey|credential/i.test(key)) continue;
    payload[key] = typeof value === "string" ? safeLogText(value) : value;
  }
  console.info(JSON.stringify(payload));
}

function isSyncInterrupt(error, signal) {
  if (signal?.aborted) return true;
  const name = String(error?.name || "");
  const code = String(error?.code || "");
  return name === "AbortError" || code === "sync_interrupted" || code === "ABORT_ERR";
}

const mirrorLocks = new Map();

function withMirrorLock(key, fn) {
  const previous = mirrorLocks.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tracked = run.finally(() => {
    if (mirrorLocks.get(key) === tracked) mirrorLocks.delete(key);
  });
  mirrorLocks.set(key, tracked);
  return tracked;
}

function isAdminConflict(existing) {
  return (
    existing &&
    existing.updated_at &&
    existing.last_synced_at &&
    new Date(existing.updated_at).getTime() > new Date(existing.last_synced_at).getTime() + 2000
  );
}

function metadataChanged(existing, mapped) {
  return (
    existing.filename !== mapped.filename ||
    existing.original_filename !== mapped.original_filename ||
    existing.document_type !== mapped.document_type ||
    existing.note !== mapped.note ||
    Boolean(existing.note_visible_to_customer) !== Boolean(mapped.note_visible_to_customer) ||
    existing.source_file_url_hash !== mapped.source_file_url_hash
  );
}

function needsFileMirror(existing, mapped) {
  if (!mapped.file_url) return false;
  if (!existing?.storage_path) return true;
  if (existing.source_file_url_hash !== mapped.source_file_url_hash) return true;
  if (!existing.content_hash) return true;
  return metadataChanged(existing, mapped);
}

async function defaultDownloadFile(url, fetchImpl = fetch, context = {}) {
  const headers = {};
  const apiKey = process.env.BASE44_API_KEY;
  if (apiKey) headers["x-api-key"] = apiKey;
  const response = await fetchImpl(url, {
    headers,
    redirect: "follow",
    signal: context.signal
  });
  if (!response.ok) {
    const error = new Error(`Download failed (HTTP ${response.status})`);
    error.code = "download_http";
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType = guessMimeType(url, Object.fromEntries(response.headers.entries()));
  return { buffer, mimeType, size: buffer.length };
}

function createDefaultStorageClient(supabaseUrl, serviceKey) {
  const base = `${String(supabaseUrl || "").replace(/\/$/, "")}/storage/v1`;
  return {
    async upload(path, buffer, mimeType, context = {}) {
      const response = await fetch(`${base}/object/${BUCKET}/${encodeURI(path)}`, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": mimeType || "application/octet-stream",
          "x-upsert": "true"
        },
        body: buffer,
        signal: context.signal
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!response.ok) {
        throw new Error(data?.message || data?.error || `Storage upload HTTP ${response.status}`);
      }
      return data;
    },
    async sign(path, expiresIn = 3600) {
      const response = await fetch(`${base}/object/sign/${BUCKET}/${encodeURI(path)}`, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ expiresIn })
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(data?.message || data?.error || `Storage sign HTTP ${response.status}`);
      }
      const signedPath = data?.signedURL || data?.signedUrl || data?.signed_url;
      if (!signedPath) return null;
      return signedPath.startsWith("http") ? signedPath : `${base.replace("/storage/v1", "")}/storage/v1${signedPath}`;
    }
  };
}

async function resolveDocumentFileUrl(document, storageClient) {
  if (document?.storage_path && storageClient?.sign) {
    try {
      const signed = await storageClient.sign(document.storage_path);
      if (signed) return signed;
    } catch (error) {
      console.warn("[booking-document-sync] storage sign failed", error.message || error);
    }
  }
  return document?.file_url || null;
}

async function maybeProcessTextItinerary({
  rest,
  booking,
  document,
  syncKey,
  filename,
  result,
  processTextItineraryImpl,
  storageClient
}) {
  if (!document || !isBookingConfirmationType(document.document_type)) {
    return;
  }
  const fileUrl = await resolveDocumentFileUrl(document, storageClient);
  if (!fileUrl) return;
  try {
    const tiResult = await processTextItineraryImpl({
      rest,
      booking,
      document: { ...document, file_url: fileUrl },
      supabaseUrl: process.env.SUPABASE_URL,
      openaiKey: process.env.OPENAI_API_KEY
    });
    result.text_itinerary_process.push({
      sync_key: syncKey,
      filename,
      ...tiResult
    });
  } catch (tiError) {
    console.warn("[booking-document-sync] text itinerary process failed", tiError.message || tiError);
    result.text_itinerary_process.push({
      sync_key: syncKey,
      filename,
      ok: false,
      reason: "process_error",
      error: tiError.message || String(tiError)
    });
  }
}

function stripMirrorFields(row, mirrorSchema) {
  if (mirrorSchema) return row;
  const legacy = { ...row };
  delete legacy.source_fingerprint;
  delete legacy.source_file_url_hash;
  delete legacy.original_filename;
  delete legacy.storage_bucket;
  delete legacy.mime_type;
  delete legacy.file_size;
  delete legacy.content_hash;
  delete legacy.last_seen_at;
  delete legacy.synced_at;
  delete legacy.is_active;
  delete legacy.source_deleted_at;
  return legacy;
}

async function detectMirrorSchema(rest) {
  try {
    await rest("booking_documents?select=source_fingerprint,is_active&limit=0", { method: "GET" });
    return true;
  } catch {
    return false;
  }
}

async function archiveMissingDocuments({
  rest,
  booking,
  seenSyncKeys,
  nowIso,
  result,
  mirrorSchema = true
}) {
  if (!mirrorSchema) return;
  const base44BookingId = normalise(booking.base44_booking_id);
  const bookingReference = normalise(booking.booking_reference).toUpperCase();
  const filters = [];
  if (base44BookingId) filters.push(`base44_booking_id.eq.${encodeURIComponent(base44BookingId)}`);
  if (bookingReference) filters.push(`booking_reference.eq.${encodeURIComponent(bookingReference)}`);
  if (!filters.length) return;

  const rows = await rest(
    `booking_documents?or=(${filters.join(",")})&source_system=eq.base44&is_active=eq.true&select=id,sync_key,filename`,
    { method: "GET" }
  );
  for (const row of rows || []) {
    if (!row?.sync_key || seenSyncKeys.has(row.sync_key)) continue;
    await rest(`booking_documents?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        is_active: false,
        source_deleted_at: nowIso,
        last_seen_at: nowIso
      })
    });
    result.archived += 1;
  }
}

/**
 * @param {Function} rest Supabase REST helper
 * @param {object} booking Normalised booking
 * @param {object|null} source Full Base44 payload (optional)
 * @param {object} [options]
 */
async function syncBookingDocuments(rest, booking, source = null, options = {}) {
  const processTextItineraryImpl = options.processTextItinerary || processTextItinerary;
  const downloadFile = options.downloadFile || defaultDownloadFile;
  const fetchImpl = options.fetchImpl || fetch;
  const signal = options.signal || null;
  const correlationId = options.correlationId || null;
  const completeFetch = options.completeFetch !== false;
  const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
  const serviceKey = options.serviceKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const storageClient =
    options.storageClient ||
    (supabaseUrl && serviceKey ? createDefaultStorageClient(supabaseUrl, serviceKey) : null);
  const allowMetadataOnly = options.allowMetadataOnly ?? !storageClient;
  const skipFileMirror = options.skipFileMirror === true;
  const mirrorSchema =
    options.mirrorSchema !== undefined ? options.mirrorSchema : await detectMirrorSchema(rest);

  const rawDocsInput = options.documents ?? extractDocumentsFromBookingPayload(booking, source);
  const rawDocs = Array.isArray(rawDocsInput) ? rawDocsInput : [];
  const result = emptySummary();

  if (!Array.isArray(rawDocsInput)) {
    result.complete_fetch = false;
    return result;
  }

  const mapped = [];
  for (const doc of rawDocs) {
    const row = mapBase44Document(doc, booking);
    if (!row.filename || !row.file_url) {
      result.skipped_invalid += 1;
      continue;
    }
    mapped.push(row);
  }

  result.discovered = mapped.length;
  result.found = mapped.length;
  if (!mapped.length) {
    if (completeFetch) {
      try {
        await archiveMissingDocuments({
          rest,
          booking,
          seenSyncKeys: new Set(),
          nowIso: new Date().toISOString(),
          result,
          mirrorSchema
        });
      } catch (archiveError) {
        console.warn("[booking-document-sync] archive pass failed", archiveError.message || archiveError);
      }
    }
    return result;
  }

  const seenSyncKeys = new Set();
  const nowIso = new Date().toISOString();
  const extractionQueue = [];
  const logContext = {
    correlation_id: correlationId,
    booking_reference: booking?.booking_reference || null,
    base44_booking_id: booking?.base44_booking_id || null
  };

  logSyncStage("sync_start", { ...logContext, discovered: mapped.length });

  function queueExtraction(document, syncKey, filename) {
    extractionQueue.push({ document, syncKey, filename });
  }

  function recordDocumentFailure(row, error) {
    result.failed += 1;
    result.partial = true;
    const interrupted = isSyncInterrupt(error, signal);
    if (interrupted) result.interrupted = true;
    const item = {
      sync_key: row.sync_key,
      filename: row.filename,
      base44_document_id: row.base44_document_id || null,
      message: safeLogText(error.message || error),
      code: interrupted ? "sync_interrupted" : (error.code || "sync_error")
    };
    result.failed_items.push(item);
    result.errors.push(item);
    logSyncStage(interrupted ? "document_interrupted" : "document_failed", {
      ...logContext,
      sync_key: row.sync_key,
      base44_document_id: row.base44_document_id || null,
      filename: row.filename,
      code: item.code,
      message: item.message
    });
    return interrupted ? "stop" : "continue";
  }

  async function reservePendingMirror(row) {
    const pending = stripMirrorFields(
      {
        ...row,
        file_url: null,
        storage_bucket: null,
        storage_path: null,
        mime_type: null,
        file_size: null,
        content_hash: null,
        is_active: false,
        document_visible_to_customer: false,
        source_deleted_at: null,
        last_seen_at: nowIso,
        synced_at: nowIso,
        last_synced_at: nowIso
      },
      mirrorSchema
    );
    const data = await rest("booking_documents?on_conflict=sync_key", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify(pending)
    });
    const saved = Array.isArray(data) ? data[0] : data;
    logSyncStage("metadata_pending", {
      ...logContext,
      sync_key: row.sync_key,
      base44_document_id: row.base44_document_id || null,
      filename: row.filename
    });
    if (saved) return saved;
    const rows = await rest(
      `booking_documents?sync_key=eq.${encodeURIComponent(row.sync_key)}&select=*&limit=1`,
      { method: "GET" }
    );
    if (!rows?.[0]) throw new Error("Document reservation could not be read");
    return rows[0];
  }

  for (const row of mapped) {
    if (signal?.aborted) {
      result.interrupted = true;
      result.partial = true;
      logSyncStage("sync_interrupted", { ...logContext, sync_key: row.sync_key, filename: row.filename });
      break;
    }

    seenSyncKeys.add(row.sync_key);
    const outcome = await withMirrorLock(row.sync_key, async () => {
      let uploadCommitted = false;
      try {
        const existingRows = await rest(
          `booking_documents?sync_key=eq.${encodeURIComponent(row.sync_key)}&select=*&limit=1`,
          { method: "GET" }
        );
        let existing = Array.isArray(existingRows) ? existingRows[0] : null;
        if (!existing && !skipFileMirror && storageClient) {
          existing = await reservePendingMirror(row);
        }
        const wasComplete = Boolean(existing && existing.storage_path && existing.is_active !== false);

        if (existing && existing.source_system && existing.source_system !== "base44") {
          result.skipped_other_source += 1;
          return "continue";
        }

        if (existing && isAdminConflict(existing) && existing.storage_path) {
          result.skipped_conflict += 1;
          queueExtraction(existing, row.sync_key, existing.filename || row.filename);
          return "continue";
        }

        const payload = stripMirrorFields(
          { ...row, last_seen_at: nowIso, synced_at: nowIso, is_active: true, source_deleted_at: null },
          mirrorSchema
        );

        if (existing && !needsFileMirror(existing, row) && !metadataChanged(existing, row)) {
          await rest(`booking_documents?id=eq.${encodeURIComponent(existing.id)}`, {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify(
              stripMirrorFields(
                {
                  last_seen_at: nowIso,
                  last_synced_at: nowIso,
                  is_active: true,
                  source_deleted_at: null,
                  document_visible_to_customer: true
                },
                mirrorSchema
              )
            )
          });
          result.unchanged += 1;
          queueExtraction(
            { ...existing, last_seen_at: nowIso, is_active: true, document_visible_to_customer: true },
            row.sync_key,
            existing.filename || row.filename
          );
          return "continue";
        }

        if (needsFileMirror(existing, row) && !skipFileMirror) {
          if (allowMetadataOnly && !storageClient) {
            payload.file_url = row.file_url;
          } else {
            if (signal?.aborted) {
              const error = new Error("Document sync stopped before the file transfer");
              error.code = "sync_interrupted";
              throw error;
            }
            logSyncStage("download_start", {
              ...logContext,
              sync_key: row.sync_key,
              base44_document_id: row.base44_document_id || null,
              filename: row.filename
            });
            const downloaded = await downloadFile(row.file_url, fetchImpl, { signal, correlationId });
            if (downloaded.size > MAX_FILE_SIZE) {
              throw new Error("File exceeds maximum size (10 MB)");
            }
            const mimeType = downloaded.mimeType || guessMimeType(row.filename);
            if (!ALLOWED_MIME.has(mimeType)) {
              throw new Error(`Unsupported file type (${mimeType})`);
            }
            const contentHash = hashValue(downloaded.buffer);
            const storagePath = buildStoragePath({
              base44BookingId: row.base44_booking_id,
              sourceFingerprint: row.source_fingerprint,
              filename: row.filename
            });
            if (storageClient) {
              if (signal?.aborted) {
                const error = new Error("Document sync stopped before the file upload");
                error.code = "sync_interrupted";
                throw error;
              }
              await storageClient.upload(storagePath, downloaded.buffer, mimeType, { signal });
              uploadCommitted = true;
              payload.storage_bucket = BUCKET;
              payload.storage_path = storagePath;
              payload.mime_type = mimeType;
              payload.file_size = downloaded.size;
              payload.content_hash = contentHash;
              payload.file_url = null;
              logSyncStage("upload_ok", {
                ...logContext,
                sync_key: row.sync_key,
                base44_document_id: row.base44_document_id || null,
                filename: row.filename,
                bytes: downloaded.size
              });
            } else if (!allowMetadataOnly) {
              throw new Error("Storage client unavailable");
            } else {
              payload.file_url = row.file_url;
            }
          }
        } else if (existing) {
          payload.storage_bucket = existing.storage_bucket || payload.storage_bucket;
          payload.storage_path = existing.storage_path || payload.storage_path;
          payload.mime_type = existing.mime_type || payload.mime_type;
          payload.file_size = existing.file_size || payload.file_size;
          payload.content_hash = existing.content_hash || payload.content_hash;
          payload.file_url = existing.storage_path ? null : existing.file_url || row.file_url;
        }

        const published = stripMirrorFields(
          {
            ...payload,
            is_active: true,
            document_visible_to_customer: true,
            source_deleted_at: null
          },
          mirrorSchema
        );
        const data = await rest("booking_documents?on_conflict=sync_key", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify(published)
        });
        const saved = Array.isArray(data) ? data[0] : data;
        if (saved) {
          result.rows.push(saved);
          queueExtraction(saved, row.sync_key, row.filename);
        }
        if (wasComplete) result.updated += 1;
        else result.inserted += 1;
        result.upserted += 1;
        logSyncStage("metadata_committed", {
          ...logContext,
          sync_key: row.sync_key,
          base44_document_id: row.base44_document_id || null,
          filename: row.filename,
          upload_committed: uploadCommitted
        });
        return "continue";
      } catch (error) {
        if (uploadCommitted) {
          logSyncStage("metadata_commit_failed", {
            ...logContext,
            sync_key: row.sync_key,
            base44_document_id: row.base44_document_id || null,
            filename: row.filename,
            message: safeLogText(error.message || error)
          });
        }
        return recordDocumentFailure(row, error);
      }
    });
    if (outcome === "stop") break;
  }

  if (completeFetch && !result.interrupted) {
    try {
      await archiveMissingDocuments({ rest, booking, seenSyncKeys, nowIso, result, mirrorSchema });
    } catch (archiveError) {
      result.partial = true;
      console.warn("[booking-document-sync] archive pass failed", safeLogText(archiveError.message || archiveError));
    }
  } else if (result.interrupted) {
    result.complete_fetch = false;
  }

  if (!result.interrupted) {
    for (const job of extractionQueue) {
      await maybeProcessTextItinerary({
        rest,
        booking,
        document: job.document,
        syncKey: job.syncKey,
        filename: job.filename,
        result,
        processTextItineraryImpl,
        storageClient
      });
    }
  }

  result.partial = Boolean(result.partial || result.interrupted || result.failed > 0);
  logSyncStage("sync_finished", {
    ...logContext,
    discovered: result.discovered,
    inserted: result.inserted,
    updated: result.updated,
    unchanged: result.unchanged,
    failed: result.failed,
    interrupted: result.interrupted,
    partial: result.partial
  });
  return result;
}

module.exports = {
  BUCKET,
  MAX_FILE_SIZE,
  ALLOWED_MIME,
  CUSTOMER_DOCUMENT_TYPES,
  normaliseDocumentType,
  mapBase44Document,
  extractDocumentsFromBookingPayload,
  buildSyncKey,
  buildSourceFingerprint,
  buildStoragePath,
  safeFilename,
  pickVisibility,
  pickBase44DocumentId,
  syncBookingDocuments,
  createDefaultStorageClient,
  resolveDocumentFileUrl,
  hashValue,
  isIncompleteMirror,
  shouldExposeMirroredDocument
};
