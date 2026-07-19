#!/usr/bin/env node
/**
 * Dry-run / apply Base44 document metadata sync into booking_documents.
 *
 * Usage:
 *   node scripts/sync-base44-documents.mjs --dry-run
 *   node scripts/sync-base44-documents.mjs --apply
 *
 * Env (never printed):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   BASE44_BOOKING_FUNCTION_URL   (optional — live Base44 refresh)
 *   BASE44_API_KEY               (optional — live Base44 refresh)
 *
 * Default source: base44_booking_cache.raw_payload documents.
 * With --live, re-fetches each booking from Base44 when credentials exist.
 */

import crypto from "node:crypto";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const dryRun = !apply || args.has("--dry-run");
const live = args.has("--live");

function die(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

function env(name) {
  const value = process.env[name];
  if (!value) die(`${name} is required`);
  return value;
}

function normalise(value) {
  return String(value || "").trim();
}

function pickVisibility(doc) {
  // Canonical Base44 field: visible_to_client (whole document).
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
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      if (["true", "yes", "1"].includes(lowered)) return true;
      if (["false", "no", "0"].includes(lowered)) return false;
    }
    if (value === 1) return true;
    if (value === 0) return false;
  }
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
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      if (["true", "yes", "1"].includes(lowered)) return true;
      if (["false", "no", "0"].includes(lowered)) return false;
    }
  }
  return documentVisible;
}

function pickBase44DocumentId(doc) {
  // Canonical Base44 CruiseDocument record ID is `id`.
  for (const value of [doc.id, doc.base44_document_id, doc.document_id, doc._id]) {
    if (value == null || value === "") continue;
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
  ].join("|");
  const hash = crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
  return `base44-hash:${hash}`;
}

function mapDoc(doc, booking) {
  const documentVisible = pickVisibility(doc);
  const noteVisible = pickNoteVisibility(doc, documentVisible);
  const base44DocumentId = pickBase44DocumentId(doc);
  const base44BookingId = normalise(booking.base44_booking_id) || null;
  const bookingReference = normalise(booking.booking_reference).toUpperCase() || null;
  const documentType = normalise(doc.document_type) || "Other";
  const filename = normalise(doc.filename) || null;
  const fileUrl = normalise(doc.file_url || doc.url || doc.file) || null;
  const note = doc.notes == null || doc.notes === "" ? null : String(doc.notes);
  const uploadedAt = doc.uploaded_date || doc.uploaded_at || null;
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
    source_system: "base44",
    sync_key: buildSyncKey({
      base44BookingId,
      bookingReference,
      base44DocumentId,
      fileUrl,
      filename,
      documentType
    }),
    last_synced_at: new Date().toISOString()
  };
}

async function rest(supabaseUrl, serviceKey, path, options = {}) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...(options.headers || {})
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
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
    throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
  }
  return data;
}

async function fetchLiveBooking(bookingReference, bookingId) {
  const base44Url = process.env.BASE44_BOOKING_FUNCTION_URL;
  const base44ApiKey = process.env.BASE44_API_KEY;
  if (!base44Url || !base44ApiKey) return null;
  const payload = bookingId ? { booking_id: bookingId } : { booking_reference: bookingReference };
  const response = await fetch(base44Url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": base44ApiKey
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.booking) return null;
  return data;
}

async function main() {
  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");

  console.log("\n=== Base44 → booking_documents sync ===");
  console.log(`Mode: ${apply && !dryRun ? "APPLY" : "DRY-RUN"}`);
  console.log(`Source: ${live ? "live Base44 (+ cache fallback)" : "base44_booking_cache"}`);
  console.log("(Secrets are not printed.)\n");

  let cacheRows = [];
  try {
    cacheRows = await rest(
      supabaseUrl,
      serviceKey,
      "base44_booking_cache?select=base44_booking_id,booking_reference,raw_payload&order=booking_reference.asc",
      { method: "GET" }
    );
  } catch (error) {
    die(`Could not read base44_booking_cache: ${error.message}`);
  }

  const stats = {
    bookings_scanned: 0,
    base44_documents_found: 0,
    matched_to_bookings: 0,
    already_synced: 0,
    require_insert: 0,
    require_update: 0,
    hidden_from_customers: 0,
    with_notes: 0,
    unmatched_bookings: 0,
    inaccessible_files: 0,
    duplicate_or_ambiguous: 0,
    skipped_other_source: 0,
    skipped_conflict: 0,
    applied: 0,
    errors: []
  };

  const syncKeyCounts = new Map();

  for (const cache of cacheRows || []) {
    stats.bookings_scanned += 1;
    let booking = cache.raw_payload || {};
    let documents = Array.isArray(booking.documents) ? booking.documents : [];

    if (live) {
      const liveData = await fetchLiveBooking(cache.booking_reference, cache.base44_booking_id);
      if (liveData?.booking) {
        booking = {
          ...liveData.booking,
          base44_booking_id: liveData.booking.base44_booking_id || cache.base44_booking_id,
          booking_reference: liveData.booking.booking_reference || cache.booking_reference
        };
        documents = Array.isArray(liveData.documents)
          ? liveData.documents
          : Array.isArray(liveData.booking.documents)
            ? liveData.booking.documents
            : documents;
      }
    }

    booking.base44_booking_id = booking.base44_booking_id || cache.base44_booking_id;
    booking.booking_reference = booking.booking_reference || cache.booking_reference;

    if (!documents.length) {
      if (!booking.booking_reference && !booking.base44_booking_id) stats.unmatched_bookings += 1;
      continue;
    }

    stats.matched_to_bookings += 1;

    for (const doc of documents) {
      stats.base44_documents_found += 1;
      const mapped = mapDoc(doc, booking);
      syncKeyCounts.set(mapped.sync_key, (syncKeyCounts.get(mapped.sync_key) || 0) + 1);

      if (!mapped.document_visible_to_customer) stats.hidden_from_customers += 1;
      if (mapped.note) stats.with_notes += 1;
      if (!mapped.file_url) stats.inaccessible_files += 1;

      try {
        const existingRows = await rest(
          supabaseUrl,
          serviceKey,
          `booking_documents?sync_key=eq.${encodeURIComponent(mapped.sync_key)}&select=*&limit=1`,
          { method: "GET" }
        );
        const existing = Array.isArray(existingRows) ? existingRows[0] : null;

        if (existing && existing.source_system && existing.source_system !== "base44") {
          stats.skipped_other_source += 1;
          continue;
        }

        if (
          existing &&
          existing.updated_at &&
          existing.last_synced_at &&
          new Date(existing.updated_at).getTime() > new Date(existing.last_synced_at).getTime() + 2000
        ) {
          stats.skipped_conflict += 1;
          continue;
        }

        if (!existing) {
          stats.require_insert += 1;
        } else {
          stats.already_synced += 1;
          const changed =
            existing.filename !== mapped.filename ||
            existing.file_url !== mapped.file_url ||
            existing.note !== mapped.note ||
            existing.document_type !== mapped.document_type ||
            Boolean(existing.document_visible_to_customer) !== Boolean(mapped.document_visible_to_customer) ||
            Boolean(existing.note_visible_to_customer) !== Boolean(mapped.note_visible_to_customer);
          if (changed) stats.require_update += 1;
        }

        if (apply && !dryRun) {
          await rest(supabaseUrl, serviceKey, "booking_documents?on_conflict=sync_key", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify(mapped)
          });
          stats.applied += 1;
        }
      } catch (error) {
        stats.errors.push({
          booking_reference: booking.booking_reference,
          filename: mapped.filename,
          message: error.message
        });
      }
    }
  }

  for (const count of syncKeyCounts.values()) {
    if (count > 1) stats.duplicate_or_ambiguous += 1;
  }

  console.log("Report");
  console.log("------");
  console.log(`Bookings scanned:              ${stats.bookings_scanned}`);
  console.log(`Base44 documents found:        ${stats.base44_documents_found}`);
  console.log(`Bookings with documents:       ${stats.matched_to_bookings}`);
  console.log(`Already synced:                ${stats.already_synced}`);
  console.log(`Requiring insertion:           ${stats.require_insert}`);
  console.log(`Requiring update:              ${stats.require_update}`);
  console.log(`Hidden from customers:         ${stats.hidden_from_customers}`);
  console.log(`Documents with notes:          ${stats.with_notes}`);
  console.log(`Unmatched / empty bookings:    ${stats.unmatched_bookings}`);
  console.log(`Missing file URL:              ${stats.inaccessible_files}`);
  console.log(`Duplicate/ambiguous sync keys: ${stats.duplicate_or_ambiguous}`);
  console.log(`Skipped (other source):        ${stats.skipped_other_source}`);
  console.log(`Skipped (newer Admin edit):    ${stats.skipped_conflict}`);
  console.log(`Applied this run:              ${stats.applied}`);
  console.log(`Errors:                        ${stats.errors.length}`);

  if (stats.errors.length) {
    console.log("\nFirst errors (max 10):");
    for (const error of stats.errors.slice(0, 10)) {
      console.log(` - [${error.booking_reference || "?"}] ${error.filename || "?"}: ${error.message}`);
    }
  }

  if (!apply || dryRun) {
    console.log("\nDry-run only. Re-run with --apply to write rows.");
  } else {
    console.log("\nApply complete.");
  }
  console.log("");
}

main().catch((error) => die(error.message || String(error)));
