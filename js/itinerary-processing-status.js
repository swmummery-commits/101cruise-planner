/**
 * Authoritative itinerary-processing status for Admin UI and Netlify functions.
 * Same resolver must drive Needs Attention, document rows, review panel, and retry.
 *
 * Dual export: CommonJS (Node) + browser global ItineraryProcessingStatus.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ItineraryProcessingStatus = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LOCK_TTL_MS = 5 * 60 * 1000;
  /** Soft ceiling for awaiting_extraction before it is treated as stalled. */
  const AWAITING_STALE_MS = 15 * 60 * 1000;

  const EFFECTIVE = Object.freeze({
    AWAITING: "awaiting_extraction",
    PROCESSING: "processing",
    PROCESSING_STALLED: "processing_stalled",
    REVIEW_REQUIRED: "review_required",
    APPROVED_AUTO: "approved_automatically",
    APPROVED_MANUAL: "approved_manually",
    FAILED: "failed",
    SUPERSEDED: "superseded"
  });

  const LABELS = Object.freeze({
    [EFFECTIVE.AWAITING]: "Awaiting extraction",
    [EFFECTIVE.PROCESSING]: "Processing",
    [EFFECTIVE.PROCESSING_STALLED]: "Processing stalled",
    [EFFECTIVE.REVIEW_REQUIRED]: "Review required",
    [EFFECTIVE.APPROVED_AUTO]: "Approved automatically",
    [EFFECTIVE.APPROVED_MANUAL]: "Approved manually",
    [EFFECTIVE.FAILED]: "Failed",
    [EFFECTIVE.SUPERSEDED]: "Superseded"
  });

  /** Visual tone classes for badges / action notes. */
  const TONES = Object.freeze({
    [EFFECTIVE.AWAITING]: "neutral",
    [EFFECTIVE.PROCESSING]: "info",
    [EFFECTIVE.PROCESSING_STALLED]: "danger",
    [EFFECTIVE.REVIEW_REQUIRED]: "warning",
    [EFFECTIVE.APPROVED_AUTO]: "success",
    [EFFECTIVE.APPROVED_MANUAL]: "success",
    [EFFECTIVE.FAILED]: "danger",
    [EFFECTIVE.SUPERSEDED]: "neutral"
  });

  const ACTION_MESSAGES = Object.freeze({
    [EFFECTIVE.PROCESSING_STALLED]:
      "Automatic extraction has stalled. No itinerary was published. Review the details or retry extraction.",
    [EFFECTIVE.FAILED]:
      "Automatic itinerary extraction failed. Review the error or retry extraction.",
    [EFFECTIVE.REVIEW_REQUIRED]:
      "Extraction finished but needs human review before the Client Portal map can publish.",
    [EFFECTIVE.AWAITING]: "Booking Confirmation is queued for itinerary extraction.",
    [EFFECTIVE.PROCESSING]: "Itinerary extraction is in progress.",
    [EFFECTIVE.APPROVED_AUTO]: "Itinerary approved automatically for the Client Portal map.",
    [EFFECTIVE.APPROVED_MANUAL]: "Itinerary approved manually for the Client Portal map.",
    [EFFECTIVE.SUPERSEDED]: "This itinerary was replaced by a newer confirmation."
  });

  function parseTime(value) {
    if (!value) return null;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  }

  function formatRelativeAgo(ms, now) {
    if (!Number.isFinite(ms)) return null;
    const delta = Math.max(0, now - ms);
    const mins = Math.floor(delta / 60000);
    if (mins < 1) return "just now";
    if (mins === 1) return "1 minute ago";
    if (mins < 60) return `${mins} minutes ago`;
    const hours = Math.floor(mins / 60);
    if (hours === 1) return "1 hour ago";
    if (hours < 48) return `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }

  function formatAdminDateTime(value) {
    const t = parseTime(value);
    if (!t) return null;
    try {
      return new Date(t).toLocaleString("en-AU", {
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      });
    } catch (_e) {
      return new Date(t).toISOString();
    }
  }

  function lockState(document, now) {
    const lockUntilMs = parseTime(document && document.itinerary_process_lock_until);
    if (!lockUntilMs) {
      return { hasLock: false, active: false, expired: false, lockUntilMs: null, startedMs: null };
    }
    const active = lockUntilMs > now;
    const startedMs = lockUntilMs - LOCK_TTL_MS;
    return {
      hasLock: true,
      active,
      expired: !active,
      lockUntilMs,
      startedMs: Number.isFinite(startedMs) ? startedMs : null
    };
  }

  function mapExceptionKind(kind) {
    const key = String(kind || "").trim();
    if (key === "awaiting_extraction_stale" || key === "processing_stalled") {
      return EFFECTIVE.PROCESSING_STALLED;
    }
    if (key === "failed") return EFFECTIVE.FAILED;
    if (key === "review_required" || key === "approved_invalidated") {
      return EFFECTIVE.REVIEW_REQUIRED;
    }
    if (key === "replacement_conflict") return EFFECTIVE.REVIEW_REQUIRED;
    return null;
  }

  function mapStoredProcessing(status, itinerary) {
    const raw = String(status || "").trim();
    if (raw === EFFECTIVE.APPROVED_AUTO) return EFFECTIVE.APPROVED_AUTO;
    if (raw === EFFECTIVE.APPROVED_MANUAL) return EFFECTIVE.APPROVED_MANUAL;
    if (raw === EFFECTIVE.REVIEW_REQUIRED) return EFFECTIVE.REVIEW_REQUIRED;
    if (raw === EFFECTIVE.FAILED) return EFFECTIVE.FAILED;
    if (raw === EFFECTIVE.SUPERSEDED) return EFFECTIVE.SUPERSEDED;
    if (raw === EFFECTIVE.PROCESSING || raw === EFFECTIVE.AWAITING) return raw;
    if (raw === EFFECTIVE.PROCESSING_STALLED) return EFFECTIVE.PROCESSING_STALLED;

    if (itinerary) {
      if (String(itinerary.status) === "approved") {
        return itinerary.approval_method === "automated"
          ? EFFECTIVE.APPROVED_AUTO
          : EFFECTIVE.APPROVED_MANUAL;
      }
      if (String(itinerary.status) === "review_required") return EFFECTIVE.REVIEW_REQUIRED;
      if (itinerary.processing_status) return mapStoredProcessing(itinerary.processing_status, null);
    }
    return null;
  }

  /**
   * Resolve one authoritative effective status for a confirmation + optional itinerary/exception.
   */
  function resolveEffectiveItineraryStatus(input = {}) {
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const document = input.document || null;
    const itinerary = input.itinerary || null;
    const exception = input.exception || null;

    const docStatus = String(
      (document && document.itinerary_processing_status) ||
        (document && document.processing_status) ||
        ""
    ).trim();
    const lock = lockState(document, now);

    // Terminal itinerary outcomes win when present.
    const fromItinerary = mapStoredProcessing(
      itinerary && itinerary.processing_status,
      itinerary
    );
    if (
      fromItinerary &&
      [
        EFFECTIVE.APPROVED_AUTO,
        EFFECTIVE.APPROVED_MANUAL,
        EFFECTIVE.REVIEW_REQUIRED,
        EFFECTIVE.SUPERSEDED
      ].includes(fromItinerary)
    ) {
      return fromItinerary;
    }

    if (docStatus === EFFECTIVE.FAILED || fromItinerary === EFFECTIVE.FAILED) {
      return EFFECTIVE.FAILED;
    }
    if (docStatus === EFFECTIVE.SUPERSEDED) return EFFECTIVE.SUPERSEDED;
    if (docStatus === EFFECTIVE.APPROVED_AUTO) return EFFECTIVE.APPROVED_AUTO;
    if (docStatus === EFFECTIVE.APPROVED_MANUAL) return EFFECTIVE.APPROVED_MANUAL;
    if (docStatus === EFFECTIVE.REVIEW_REQUIRED) return EFFECTIVE.REVIEW_REQUIRED;

    // Active processing lock → still Processing (never stalled while lock alive).
    if (docStatus === EFFECTIVE.PROCESSING && lock.active) {
      return EFFECTIVE.PROCESSING;
    }

    // Expired lock while still marked processing → stalled.
    if (docStatus === EFFECTIVE.PROCESSING && (lock.expired || !lock.hasLock)) {
      return EFFECTIVE.PROCESSING_STALLED;
    }

    if (docStatus === EFFECTIVE.PROCESSING_STALLED) {
      return EFFECTIVE.PROCESSING_STALLED;
    }

    // Awaiting too long without completion.
    if (docStatus === EFFECTIVE.AWAITING || !docStatus) {
      const startedMs =
        parseTime(document && document.itinerary_last_processed_at) ||
        parseTime(document && document.updated_at) ||
        parseTime(document && document.created_at);
      if (startedMs && now - startedMs > AWAITING_STALE_MS) {
        return EFFECTIVE.PROCESSING_STALLED;
      }
      if (!docStatus && exception) {
        const fromEx = mapExceptionKind(exception.exception_kind);
        if (fromEx) return fromEx;
      }
      return docStatus === EFFECTIVE.AWAITING ? EFFECTIVE.AWAITING : EFFECTIVE.AWAITING;
    }

    const fromEx = mapExceptionKind(exception && exception.exception_kind);
    if (fromEx) return fromEx;

    return mapStoredProcessing(docStatus, itinerary) || EFFECTIVE.AWAITING;
  }

  function formatItineraryStatusLabel(key) {
    const k = String(key || "").trim();
    if (LABELS[k]) return LABELS[k];
    // Never surface raw snake_case internals in UI.
    if (!k) return "";
    if (k === "awaiting_extraction_stale") return LABELS[EFFECTIVE.PROCESSING_STALLED];
    return LABELS[k] || "Needs review";
  }

  function itineraryStatusTone(key) {
    return TONES[String(key || "").trim()] || "neutral";
  }

  function itineraryStatusActionMessage(key, options = {}) {
    const k = String(key || "").trim();
    if (k === EFFECTIVE.REVIEW_REQUIRED && options.summary) {
      return String(options.summary);
    }
    if (k === EFFECTIVE.FAILED && options.error) {
      return `Automatic itinerary extraction failed: ${String(options.error).slice(0, 180)}`;
    }
    return ACTION_MESSAGES[k] || "";
  }

  function extractStoredError(document, itinerary, exception) {
    const failures =
      (exception && exception.validation_failures) ||
      (itinerary && itinerary.validation_result && itinerary.validation_result.failures) ||
      [];
    if (Array.isArray(failures) && failures.length) {
      const first = failures[0];
      const msg = String((first && (first.message || first.code)) || "").trim();
      if (msg && !/stack|password|secret|apikey|bearer/i.test(msg)) return msg.slice(0, 220);
    }
    const concise = exception && exception.concise_reason;
    if (concise) return String(concise).slice(0, 220);
    return null;
  }

  /**
   * Full view model used by Admin surfaces.
   */
  function buildItineraryStatusView(input = {}) {
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const document = input.document || null;
    const itinerary = input.itinerary || null;
    const exception = input.exception || null;
    const key = resolveEffectiveItineraryStatus({ document, itinerary, exception, now });
    const lock = lockState(document, now);
    const label = formatItineraryStatusLabel(key);
    const tone = itineraryStatusTone(key);
    const storedError = extractStoredError(document, itinerary, exception);
    const hasItineraryData = Boolean(
      itinerary && itinerary.itinerary_data && Array.isArray(itinerary.itinerary_data.stops)
    );
    const fingerprint =
      (document && (document.content_fingerprint || document.itinerary_last_processed_hash)) ||
      (itinerary && itinerary.source_document_hash) ||
      null;
    const sameHashStored =
      hasItineraryData &&
      fingerprint &&
      itinerary.source_document_hash &&
      String(itinerary.source_document_hash) === String(fingerprint);
    const retryWillCallOpenAI =
      key === EFFECTIVE.PROCESSING_STALLED || key === EFFECTIVE.FAILED
        ? !sameHashStored
        : false;

    const timing = [];
    if (lock.startedMs && (key === EFFECTIVE.PROCESSING || key === EFFECTIVE.PROCESSING_STALLED)) {
      timing.push(`Processing started ${formatRelativeAgo(lock.startedMs, now)}`);
    }
    if (key === EFFECTIVE.PROCESSING_STALLED && lock.lockUntilMs) {
      const stalledFor = Math.max(0, now - lock.lockUntilMs);
      const mins = Math.max(1, Math.round(stalledFor / 60000));
      timing.push(`Stalled after ${Math.round(LOCK_TTL_MS / 60000)} minutes (about ${mins} minute${mins === 1 ? "" : "s"} overdue)`);
    }
    const lastAttempt =
      (document && document.itinerary_last_processed_at) ||
      (lock.startedMs ? new Date(lock.startedMs).toISOString() : null) ||
      (exception && exception.last_flagged_at) ||
      (document && document.updated_at);
    if (lastAttempt) {
      const nice = formatAdminDateTime(lastAttempt);
      if (nice) timing.push(`Last attempted ${nice}`);
    }

    const actionMessage = itineraryStatusActionMessage(key, {
      summary:
        (itinerary && itinerary.validation_result && itinerary.validation_result.summary) ||
        (exception && exception.concise_reason) ||
        null,
      error: storedError
    });

    return {
      key,
      label,
      tone,
      action_message: actionMessage,
      timing_lines: timing,
      can_retry: key === EFFECTIVE.PROCESSING_STALLED || key === EFFECTIVE.FAILED,
      needs_attention:
        key === EFFECTIVE.PROCESSING_STALLED ||
        key === EFFECTIVE.FAILED ||
        key === EFFECTIVE.REVIEW_REQUIRED,
      details: {
        source_filename:
          (document && document.filename) ||
          (exception && exception.source_filename) ||
          (itinerary && itinerary.source_filename) ||
          null,
        last_attempt_at: lastAttempt || null,
        stored_error: storedError,
        has_itinerary_data: hasItineraryData,
        retry_will_call_openai: retryWillCallOpenAI,
        duplicate_cost_risk: retryWillCallOpenAI
          ? "Retry will call OpenAI again because no valid stored extraction exists for this document."
          : hasItineraryData
            ? "Retry can reuse the stored extraction (no OpenAI call)."
            : null,
        lock_active: lock.active,
        lock_expired: lock.expired,
        content_fingerprint: fingerprint,
        extraction_call_count:
          itinerary && itinerary.extraction_call_count != null
            ? Number(itinerary.extraction_call_count)
            : null,
        raw_document_status: docStatusOrNull(document),
        raw_exception_kind: exception ? exception.exception_kind || null : null
      }
    };
  }

  function docStatusOrNull(document) {
    if (!document) return null;
    return document.itinerary_processing_status || document.processing_status || null;
  }

  function isRawInternalStatusLabel(text) {
    const t = String(text || "").trim();
    return /^(awaiting_extraction_stale|processing_locked|review_required|approved_automatically|approved_manually|awaiting_extraction)$/i.test(
      t
    );
  }

  return {
    LOCK_TTL_MS,
    AWAITING_STALE_MS,
    EFFECTIVE,
    LABELS,
    TONES,
    resolveEffectiveItineraryStatus,
    formatItineraryStatusLabel,
    itineraryStatusTone,
    itineraryStatusActionMessage,
    buildItineraryStatusView,
    lockState,
    isRawInternalStatusLabel,
    formatAdminDateTime,
    formatRelativeAgo
  };
});
