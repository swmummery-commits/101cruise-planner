/**
 * Exception-only Booking Confirmation itinerary processing.
 *
 * Sequential workflow (not atomic):
 * 1. fingerprint + idempotency / lock
 * 2. extract once via shared OpenAI helper (or reuse stored JSON)
 * 3. validate
 * 4. persist approved | review_required with audit fields
 *
 * Never called from customer page loads.
 */

"use strict";

const {
  fingerprintBookingDocument,
  isBookingConfirmationType
} = require("./itinerary-document-hash");
const { extractItineraryWithOpenAI } = require("./itinerary-extract");
const {
  VALIDATION_VERSION,
  validateItineraryForAutoApproval
} = require("./itinerary-validation");
const { buildPortIndex } = require("./customer-port-match");
const {
  EXCEPTION_KINDS,
  upsertItineraryException,
  resolveItineraryExceptionsForBooking,
  customerNamesFromBooking
} = require("./itinerary-exceptions");
const { notifyItineraryException } = require("./itinerary-notify");

/**
 * Text-only system actor label for audit fields that accept free text
 * (e.g. itinerary_exceptions.resolved_by). Do NOT write this into
 * cruise_itineraries.approved_by / extracted_by — those columns are uuid
 * (auth.users ids). Automated rows use approval_method = 'automated' and
 * approved_by / extracted_by = NULL instead of inventing a fake user.
 */
const SYSTEM_APPROVER = "system:itinerary-auto-approve";
const LOCK_TTL_MS = 5 * 60 * 1000;

function isSystemActor(actorId) {
  return actorId == null || actorId === "" || actorId === SYSTEM_APPROVER;
}

/** Return a uuid-safe actor for approved_by / extracted_by, else null. */
function uuidActorOrNull(actorId) {
  return isSystemActor(actorId) ? null : actorId;
}

const PROCESSING = Object.freeze({
  AWAITING: "awaiting_extraction",
  PROCESSING: "processing",
  APPROVED_AUTO: "approved_automatically",
  REVIEW: "review_required",
  APPROVED_MANUAL: "approved_manually",
  FAILED: "failed",
  SUPERSEDED: "superseded"
});

function nowIso() {
  return new Date().toISOString();
}

async function raiseExceptionAndNotify(rest, payload) {
  try {
    const upserted = await upsertItineraryException(rest, payload);
    let notifyResult = null;
    try {
      notifyResult = await notifyItineraryException(rest, upserted);
    } catch (notifyError) {
      console.warn("[itinerary-auto-process] notify failed (queue retained)", notifyError.message || notifyError);
      notifyResult = { sent: false, error: notifyError.message || String(notifyError), exception_still_open: true };
    }
    return { upserted, notifyResult };
  } catch (error) {
    console.warn("[itinerary-auto-process] exception upsert failed", error.message || error);
    return { upserted: null, notifyResult: null, error: error.message || String(error) };
  }
}

function assertProductionUrl(supabaseUrl) {
  if (/vkheexbapykcdfbqcach/i.test(String(supabaseUrl || ""))) {
    const error = new Error("REFUSED: DEV Supabase project URL detected");
    error.statusCode = 500;
    throw error;
  }
}

async function loadCatalogue(rest) {
  const [shipRows, ports] = await Promise.all([
    rest(
      "ci_cruise_ships?select=id,name,active,ci_cruise_lines(id,name)&active=eq.true&limit=5000",
      { method: "GET" }
    ).catch(() => []),
    rest(
      "ports?select=id,canonical_name,display_name,city,country,aliases,latitude,longitude&latitude=not.is.null&longitude=not.is.null&limit=5000",
      { method: "GET" }
    ).catch(() => [])
  ]);
  const ships = (Array.isArray(shipRows) ? shipRows : []).map((row) => ({
    id: row.id,
    name: row.name,
    cruise_line_name: row.ci_cruise_lines?.name || row.cruise_line_name || null
  }));
  return {
    ships,
    portsIndex: buildPortIndex(Array.isArray(ports) ? ports : [])
  };
}

async function getItineraryByBookingId(rest, bookingId) {
  const rows = await rest(
    `cruise_itineraries?booking_id=eq.${encodeURIComponent(bookingId)}&select=*&limit=1`,
    { method: "GET" }
  );
  return rows?.[0] || null;
}

async function archiveItineraryVersion(rest, row, reason) {
  if (!row) return null;
  const payload = {
    booking_id: row.booking_id,
    booking_reference: row.booking_reference || null,
    snapshot: row,
    source_document_id: row.source_document_id || null,
    source_document_hash: row.source_document_hash || null,
    status: row.status || null,
    processing_status: row.processing_status || null,
    supersession_reason: reason || null,
    created_at: nowIso()
  };
  try {
    const rows = await rest("cruise_itinerary_versions", {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify(payload)
    });
    return rows?.[0] || payload;
  } catch (error) {
    console.warn("[itinerary-auto-process] version archive failed", error.message || error);
    return null;
  }
}

async function claimDocumentProcessing(rest, document, fingerprint) {
  const id = String(document.id || "").trim();
  if (!id) return { claimed: true, reason: "no_document_row_id" };

  const rows = await rest(
    `booking_documents?id=eq.${encodeURIComponent(id)}&select=id,itinerary_processing_status,itinerary_last_processed_hash,itinerary_process_lock_until,content_fingerprint`,
    { method: "GET" }
  );
  const existing = rows?.[0];
  if (!existing) return { claimed: true, reason: "document_not_in_booking_documents" };

  if (
    existing.itinerary_last_processed_hash === fingerprint &&
    ["approved_automatically", "approved_manually", "review_required", "superseded"].includes(
      String(existing.itinerary_processing_status || "")
    )
  ) {
    return { claimed: false, reason: "already_processed_same_hash", existing };
  }

  const lockUntil = existing.itinerary_process_lock_until
    ? new Date(existing.itinerary_process_lock_until).getTime()
    : 0;
  if (
    String(existing.itinerary_processing_status) === PROCESSING.PROCESSING &&
    lockUntil > Date.now()
  ) {
    return { claimed: false, reason: "locked_by_concurrent_process", existing };
  }

  const patch = {
    content_fingerprint: fingerprint,
    itinerary_processing_status: PROCESSING.PROCESSING,
    itinerary_process_lock_until: new Date(Date.now() + LOCK_TTL_MS).toISOString()
  };
  const updated = await rest(
    `booking_documents?id=eq.${encodeURIComponent(id)}&or=(itinerary_processing_status.is.null,itinerary_processing_status.neq.processing,itinerary_process_lock_until.lt.${encodeURIComponent(nowIso())})`,
    {
      method: "PATCH",
      prefer: "return=representation",
      body: JSON.stringify(patch)
    }
  );
  if (!Array.isArray(updated) || updated.length !== 1) {
    // Fallback unconditional patch when filter unsupported — re-read
    const again = await rest(
      `booking_documents?id=eq.${encodeURIComponent(id)}&select=itinerary_processing_status,itinerary_last_processed_hash,itinerary_process_lock_until`,
      { method: "GET" }
    );
    const row = again?.[0];
    if (
      row &&
      String(row.itinerary_processing_status) === PROCESSING.PROCESSING &&
      row.itinerary_process_lock_until &&
      new Date(row.itinerary_process_lock_until).getTime() > Date.now() &&
      row.itinerary_last_processed_hash !== fingerprint
    ) {
      return { claimed: false, reason: "locked_by_concurrent_process", existing: row };
    }
    await rest(`booking_documents?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }
  return { claimed: true, reason: "claimed" };
}

async function markDocumentProcessed(rest, document, fingerprint, processingStatus) {
  const id = String(document?.id || "").trim();
  if (!id) return;
  await rest(`booking_documents?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      content_fingerprint: fingerprint,
      itinerary_last_processed_hash: fingerprint,
      itinerary_last_processed_at: nowIso(),
      itinerary_processing_status: processingStatus,
      itinerary_process_lock_until: null
    })
  });
}

/**
 * Core processor. Pass extractImpl for tests (no OpenAI).
 */
async function processBookingConfirmation(options = {}) {
  const {
    rest,
    booking,
    document,
    actorId = SYSTEM_APPROVER,
    supabaseUrl = process.env.SUPABASE_URL,
    allowOpenAI = true,
    forceReextract = false,
    revalidateOnly = false,
    extractImpl = extractItineraryWithOpenAI,
    ships = null,
    portsIndex = null,
    dryRun = false
  } = options;

  assertProductionUrl(supabaseUrl);

  if (!booking?.base44_booking_id) {
    return { ok: false, skipped: true, reason: "missing_booking_id" };
  }
  if (!isBookingConfirmationType(document?.document_type)) {
    return { ok: false, skipped: true, reason: "not_booking_confirmation" };
  }
  if (!document?.file_url && !revalidateOnly) {
    return { ok: false, skipped: true, reason: "missing_file_url" };
  }

  const fingerprint = fingerprintBookingDocument(document);
  const bookingId = String(booking.base44_booking_id);
  const existing = await getItineraryByBookingId(rest, bookingId);

  // Idempotency: same hash already processed
  if (
    !forceReextract &&
    !revalidateOnly &&
    existing &&
    existing.source_document_hash === fingerprint &&
    ["approved", "review_required"].includes(String(existing.status))
  ) {
    return {
      ok: true,
      skipped: true,
      reason: "unchanged_document_already_processed",
      itinerary: existing,
      extraction_calls: 0,
      from_stored_extraction: true
    };
  }

  if (dryRun) {
    return { ok: true, dry_run: true, fingerprint, would_process: true };
  }

  if (!revalidateOnly) {
    const claim = await claimDocumentProcessing(rest, document, fingerprint);
    if (
      !claim.claimed &&
      claim.reason !== "no_document_row_id" &&
      claim.reason !== "document_not_in_booking_documents"
    ) {
      return { ok: true, skipped: true, reason: claim.reason, itinerary: existing };
    }
  }

  let catalogue = { ships: ships || [], portsIndex };
  if (!portsIndex || !ships) {
    const loaded = await loadCatalogue(rest);
    catalogue = {
      ships: ships || loaded.ships,
      portsIndex: portsIndex || loaded.portsIndex
    };
  }

  let itineraryData = null;
  let extractionMeta = {
    extraction_calls: 0,
    extraction_model: null,
    extraction_token_usage: null,
    extraction_estimated_cost_usd: null,
    from_stored_extraction: false
  };

  if (revalidateOnly) {
    if (!existing?.itinerary_data) {
      await markDocumentProcessed(rest, document, fingerprint, PROCESSING.FAILED);
      return { ok: false, reason: "no_stored_extraction", extraction_calls: 0 };
    }
    itineraryData = existing.itinerary_data;
    extractionMeta.from_stored_extraction = true;
    extractionMeta.extraction_calls = 0;
    extractionMeta.extraction_model = existing.extraction_model || null;
    extractionMeta.extraction_token_usage = existing.extraction_token_usage || null;
    extractionMeta.extraction_estimated_cost_usd = existing.extraction_estimated_cost_usd ?? null;
  } else {
    if (!allowOpenAI) {
      await markDocumentProcessed(rest, document, fingerprint, PROCESSING.FAILED);
      await raiseExceptionAndNotify(rest, {
        booking_id: bookingId,
        booking_reference: booking.booking_reference,
        booking,
        customer_names: customerNamesFromBooking(booking),
        source_filename: document.filename,
        source_document_id: document.id || document.base44_document_id,
        source_document_hash: fingerprint,
        exception_kind: EXCEPTION_KINDS.FAILED,
        concise_reason: "extraction failed",
        reason_codes: ["openai_disabled"],
        validation_failures: [{ code: "openai_disabled", message: "OpenAI extraction was unavailable" }]
      });
      return { ok: false, reason: "openai_disabled", extraction_calls: 0 };
    }
    const extracted = await extractImpl(booking, document, {});
    itineraryData = extracted.itinerary;
    extractionMeta = {
      extraction_calls: 1,
      extraction_model: extracted.model || null,
      extraction_token_usage: extracted.usage || null,
      extraction_estimated_cost_usd: extracted.estimated_cost_usd ?? null,
      from_stored_extraction: false
    };
  }

  const validation = validateItineraryForAutoApproval({
    itinerary: itineraryData,
    booking,
    bookingReference: booking.booking_reference,
    ships: catalogue.ships,
    portsIndex: catalogue.portsIndex,
    existingItinerary: existing,
    sourceDocumentHash: fingerprint,
    sourceDocumentId: document.id || document.base44_document_id || null
  });

  const isReplacement =
    existing &&
    String(existing.status) === "approved" &&
    existing.source_document_hash &&
    existing.source_document_hash !== fingerprint;

  // Replacement: do not silently overwrite approved until new extract validates.
  if (isReplacement && !validation.ok) {
    const pendingPayload = {
      pending_itinerary_data: itineraryData,
      pending_source_document_id: document.id || document.base44_document_id || null,
      pending_source_document_hash: fingerprint,
      pending_validation_result: {
        ok: false,
        summary: validation.summary,
        failures: validation.failures,
        validation_version: validation.validation_version,
        diagnostics: validation.diagnostics
      },
      pending_extracted_at: nowIso(),
      processing_status: PROCESSING.REVIEW,
      validation_result: {
        ok: false,
        summary: "confirmation changed after approval",
        failures: [
          {
            code: "confirmation_changed_after_approval",
            message: "confirmation changed after approval",
            details: { new_failures: validation.failures }
          },
          ...validation.failures
        ],
        validation_version: validation.validation_version
      },
      updated_at: nowIso(),
      ...extractionMetaFields(extractionMeta, existing)
    };
    const rows = await rest(`cruise_itineraries?booking_id=eq.${encodeURIComponent(bookingId)}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: JSON.stringify(pendingPayload)
    });
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error("Itinerary pending update did not return exactly one row");
    }
    const reread = await getItineraryByBookingId(rest, bookingId);
    await markDocumentProcessed(rest, document, fingerprint, PROCESSING.REVIEW);
    await raiseExceptionAndNotify(rest, {
      booking_id: bookingId,
      booking_reference: booking.booking_reference,
      booking,
      customer_names: customerNamesFromBooking(booking),
      source_filename: document.filename,
      source_document_id: document.id || document.base44_document_id,
      source_document_hash: fingerprint,
      exception_kind: EXCEPTION_KINDS.REPLACEMENT_CONFLICT,
      concise_reason: "confirmation changed after approval",
      reason_codes: ["confirmation_changed_after_approval", ...(validation.failures || []).map((f) => f.code)],
      validation_failures: [
        {
          code: "confirmation_changed_after_approval",
          message: "confirmation changed after approval"
        },
        ...(validation.failures || [])
      ]
    });
    return {
      ok: true,
      auto_approved: false,
      reason: "replacement_requires_review",
      itinerary: reread,
      validation,
      ...extractionMeta
    };
  }

  if (isReplacement && validation.ok) {
    await archiveItineraryVersion(rest, existing, "replaced_by_new_confirmation");
  }

  const approve = validation.ok;
  const payload = {
    booking_id: bookingId,
    booking_reference: booking.booking_reference || null,
    source_filename: document.filename || null,
    source_url: document.file_url || existing?.source_url || null,
    source_uploaded_date: document.uploaded_at || document.uploaded_date || null,
    source_document_id: document.id || document.base44_document_id || null,
    source_document_hash: fingerprint,
    status: approve ? "approved" : "review_required",
    processing_status: approve ? PROCESSING.APPROVED_AUTO : PROCESSING.REVIEW,
    approval_method: approve ? "automated" : null,
    validation_version: VALIDATION_VERSION,
    validation_result: {
      ok: validation.ok,
      summary: validation.summary,
      failures: validation.failures,
      diagnostics: validation.diagnostics,
      validation_version: validation.validation_version
    },
    itinerary_data: itineraryData,
    extraction_confidence: Number(itineraryData.confidence || 0),
    extracted_at: revalidateOnly ? existing.extracted_at || nowIso() : nowIso(),
    extracted_by: revalidateOnly
      ? existing.extracted_by || uuidActorOrNull(actorId)
      : uuidActorOrNull(actorId),
    approved_at: approve ? nowIso() : null,
    // Human auth uuid when manual; NULL for automation (see SYSTEM_APPROVER docs).
    approved_by: approve ? uuidActorOrNull(actorId) : null,
    pending_itinerary_data: null,
    pending_source_document_id: null,
    pending_source_document_hash: null,
    pending_validation_result: null,
    pending_extracted_at: null,
    updated_at: nowIso(),
    extraction_model: extractionMeta.extraction_model,
    extraction_token_usage: extractionMeta.extraction_token_usage,
    extraction_estimated_cost_usd: extractionMeta.extraction_estimated_cost_usd,
    extraction_call_count: Number(existing?.extraction_call_count || 0) + Number(extractionMeta.extraction_calls || 0)
  };

  if (isReplacement && approve && existing) {
    // Prior row archived; mark processing lineage
    payload.supersedes_document_hash = existing.source_document_hash;
  }

  const rows = await rest("cruise_itineraries?on_conflict=booking_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: JSON.stringify(payload)
  });
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("Itinerary upsert did not return exactly one row");
  }
  const reread = await getItineraryByBookingId(rest, bookingId);
  if (!reread || reread.source_document_hash !== fingerprint) {
    throw new Error("Itinerary re-read failed verification after write");
  }

  await markDocumentProcessed(
    rest,
    document,
    fingerprint,
    approve ? PROCESSING.APPROVED_AUTO : PROCESSING.REVIEW
  );

  if (approve) {
    await resolveItineraryExceptionsForBooking(rest, bookingId, "approved", SYSTEM_APPROVER).catch((error) => {
      console.warn("[itinerary-auto-process] resolve exceptions failed", error.message || error);
    });
  } else {
    const kind =
      revalidateOnly && existing && String(existing.status) === "approved"
        ? EXCEPTION_KINDS.APPROVED_INVALIDATED
        : EXCEPTION_KINDS.REVIEW_REQUIRED;
    await raiseExceptionAndNotify(rest, {
      booking_id: bookingId,
      booking_reference: booking.booking_reference,
      booking,
      customer_names: customerNamesFromBooking(booking),
      source_filename: document.filename || existing?.source_filename,
      source_document_id: document.id || document.base44_document_id,
      source_document_hash: fingerprint,
      exception_kind: kind,
      concise_reason: validation.summary || "review required",
      reason_codes: (validation.failures || []).map((f) => f.code),
      validation_failures: validation.failures || []
    });
  }

  return {
    ok: true,
    auto_approved: approve,
    reason: approve ? "validated_auto_approved" : "validation_failed_review_required",
    itinerary: reread,
    validation,
    ...extractionMeta
  };
}

function extractionMetaFields(extractionMeta, existing) {
  return {
    extraction_model: extractionMeta.extraction_model || existing?.extraction_model || null,
    extraction_token_usage: extractionMeta.extraction_token_usage || existing?.extraction_token_usage || null,
    extraction_estimated_cost_usd:
      extractionMeta.extraction_estimated_cost_usd ?? existing?.extraction_estimated_cost_usd ?? null,
    extraction_call_count:
      Number(existing?.extraction_call_count || 0) + Number(extractionMeta.extraction_calls || 0)
  };
}

/**
 * Revalidate stored itinerary_data without OpenAI.
 */
async function revalidateStoredItinerary(options = {}) {
  return processBookingConfirmation({
    ...options,
    revalidateOnly: true,
    allowOpenAI: false,
    forceReextract: false
  });
}

/**
 * After document sync/upload — process confirmation candidates (admin paths only).
 */
async function processConfirmationDocuments(options = {}) {
  const { rest, booking, documents, ...restOptions } = options;
  const list = (Array.isArray(documents) ? documents : []).filter(
    (doc) => isBookingConfirmationType(doc.document_type) && (doc.file_url || restOptions.revalidateOnly)
  );
  const results = [];
  for (const document of list) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await processBookingConfirmation({
        rest,
        booking,
        document,
        ...restOptions
      });
      results.push({ document_id: document.id || document.base44_document_id || null, ...result });
    } catch (error) {
      console.error("[itinerary-auto-process] document failed", error);
      results.push({
        document_id: document.id || document.base44_document_id || null,
        ok: false,
        reason: "failed",
        error: error.message || String(error)
      });
      try {
        // eslint-disable-next-line no-await-in-loop
        await markDocumentProcessed(
          rest,
          document,
          fingerprintBookingDocument(document),
          PROCESSING.FAILED
        );
        // eslint-disable-next-line no-await-in-loop
        await raiseExceptionAndNotify(rest, {
          booking_id: booking.base44_booking_id || booking.booking_reference,
          booking_reference: booking.booking_reference,
          booking,
          customer_names: customerNamesFromBooking(booking),
          source_filename: document.filename,
          source_document_id: document.id || document.base44_document_id,
          source_document_hash: fingerprintBookingDocument(document),
          exception_kind: EXCEPTION_KINDS.FAILED,
          concise_reason: "extraction failed",
          reason_codes: ["extraction_failed"],
          validation_failures: [
            { code: "extraction_failed", message: error.message || String(error) }
          ]
        });
      } catch (_e) {
        /* ignore */
      }
    }
  }
  return results;
}

function displayProcessingStatus(row) {
  if (!row) return PROCESSING.AWAITING;
  if (row.processing_status) return row.processing_status;
  if (String(row.status) === "approved") {
    return row.approval_method === "automated" ? PROCESSING.APPROVED_AUTO : PROCESSING.APPROVED_MANUAL;
  }
  if (String(row.status) === "review_required") return PROCESSING.REVIEW;
  return PROCESSING.AWAITING;
}

module.exports = {
  SYSTEM_APPROVER,
  PROCESSING,
  VALIDATION_VERSION,
  processBookingConfirmation,
  processConfirmationDocuments,
  revalidateStoredItinerary,
  displayProcessingStatus,
  fingerprintBookingDocument,
  isBookingConfirmationType,
  claimDocumentProcessing,
  loadCatalogue
};
