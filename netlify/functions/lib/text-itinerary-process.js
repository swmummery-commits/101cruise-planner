/**
 * Lightweight Booking Confirmation → text itinerary extraction.
 * Stores results in booking_text_itineraries only — never writes cruise_itineraries / map tables.
 */

"use strict";

const {
  fingerprintBookingDocument,
  isBookingConfirmationType
} = require("./itinerary-document-hash");
const { extractItineraryWithOpenAI } = require("./itinerary-extract");

function assertProductionUrl(supabaseUrl) {
  if (/vkheexbapykcdfbqcach/i.test(String(supabaseUrl || ""))) {
    const error = new Error("REFUSED: DEV Supabase project URL detected");
    error.statusCode = 500;
    throw error;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseIsoDate(value) {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayDiff(a, b) {
  const da = parseIsoDate(a);
  const db = parseIsoDate(b);
  if (!da || !db) return null;
  return Math.round((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

function notesSayOvernight(notes) {
  return /\bovernight\b/i.test(String(notes || ""));
}

/**
 * Normalise raw OpenAI stops into lightweight customer-facing shape.
 * @param {object[]} rawStops
 * @returns {object[]}
 */
function normaliseTextItineraryStops(rawStops) {
  const stops = Array.isArray(rawStops) ? rawStops : [];
  const sorted = [...stops].sort((a, b) => {
    const dateCmp = String(a?.date || "").localeCompare(String(b?.date || ""));
    if (dateCmp !== 0) return dateCmp;
    return String(a?.arrival_time || "").localeCompare(String(b?.arrival_time || ""));
  });

  const normalised = sorted.map((stop, index) => {
    const entryType = String(stop?.entry_type || "").toLowerCase();
    const name = String(stop?.name || "").trim();
    const isSeaDay = entryType === "sea_day" || /^at\s+sea$/i.test(name);

    return {
      day: index + 1,
      date: stop?.date || null,
      port_name: name,
      arrival_time: stop?.arrival_time || null,
      departure_time: stop?.departure_time || null,
      overnight: false,
      is_embarkation: entryType === "embarkation",
      is_disembarkation: entryType === "disembarkation",
      is_sea_day: isSeaDay
    };
  });

  for (let i = 0; i < normalised.length; i += 1) {
    const stop = normalised[i];
    const next = normalised[i + 1];
    const rawNotes = sorted[i]?.notes;

    if (notesSayOvernight(rawNotes)) {
      stop.overnight = true;
      continue;
    }
    if (next && stop.date && next.date && stop.date === next.date) {
      stop.overnight = true;
      continue;
    }
    if (next && stop.date && next.date && stop.arrival_time && !stop.departure_time) {
      const diff = dayDiff(stop.date, next.date);
      if (diff === 1) {
        stop.overnight = true;
        continue;
      }
    }
    stop.overnight = false;
  }

  return normalised;
}

/** Format HH:MM for display; returns empty string when absent. */
function formatTextItineraryTime(time) {
  const value = String(time || "").trim();
  if (!value) return "";
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return value;
  const hours = String(Number(match[1])).padStart(2, "0");
  return `${hours}:${match[2]}`;
}

/** Single-line label for a text itinerary stop (pure formatter for UI/tests). */
function formatTextItineraryStopLabel(stop) {
  if (!stop || typeof stop !== "object") return "";
  const day = stop.day != null ? `Day ${stop.day}` : "Day";
  if (stop.is_sea_day) return `${day} — At sea`;

  const port = String(stop.port_name || "").trim() || "Port";
  const parts = [`${day} — ${port}`];
  const arrival = formatTextItineraryTime(stop.arrival_time);
  const departure = formatTextItineraryTime(stop.departure_time);
  if (arrival && departure) parts.push(`${arrival}–${departure}`);
  else if (arrival) parts.push(`arrive ${arrival}`);
  else if (departure) parts.push(`depart ${departure}`);
  if (stop.overnight) parts.push("overnight");
  return parts.join(" · ");
}

function getStore() {
  // Lazy require avoids circular dependency with text-itinerary-store.
  return require("./text-itinerary-store");
}

/**
 * Extract and persist text itinerary for a Booking Confirmation document.
 * @returns {Promise<object>}
 */
async function processTextItinerary(options = {}) {
  const {
    rest,
    booking,
    document,
    supabaseUrl = process.env.SUPABASE_URL,
    fetchImpl,
    openaiKey,
    extractImpl = extractItineraryWithOpenAI
  } = options;

  assertProductionUrl(supabaseUrl);

  if (!isBookingConfirmationType(document?.document_type)) {
    return { ok: false, skipped: true, reason: "not_booking_confirmation", extraction_calls: 0 };
  }

  const bookingId = String(booking?.base44_booking_id || booking?.booking_id || "").trim();
  if (!bookingId) {
    return { ok: false, skipped: true, reason: "missing_booking_id", extraction_calls: 0 };
  }
  if (!document?.file_url) {
    return { ok: false, skipped: true, reason: "missing_file_url", extraction_calls: 0 };
  }

  const fingerprint = fingerprintBookingDocument(document);
  const bookingReference = String(booking?.booking_reference || "").trim().toUpperCase() || null;
  const sourceDocumentId =
    String(document?.id || document?.base44_document_id || "").trim() || null;

  const store = getStore();
  const existingRead = await store.readTextItinerary(rest, {
    bookingId,
    bookingRef: bookingReference
  });
  const existingStops = existingRead?.itinerary?.stops;
  if (
    existingRead?.status === "ready" &&
    existingRead.document_fingerprint === fingerprint &&
    Array.isArray(existingStops) &&
    existingStops.length >= 3
  ) {
    return {
      ok: true,
      skipped: true,
      reason: "unchanged_fingerprint",
      extraction_calls: 0,
      itinerary: existingRead.itinerary,
      stop_count: existingStops.length,
      storage: existingRead.source
    };
  }

  let extraction_calls = 0;

  await store.writeTextItinerary(rest, {
    booking_id: bookingId,
    booking_reference: bookingReference,
    source_document_id: sourceDocumentId,
    document_fingerprint: fingerprint,
    extraction_status: "processing",
    extraction_error: null,
    updated_at: nowIso()
  });

  try {
    extraction_calls = 1;
    const extracted = await extractImpl(booking, document, {
      openaiKey: openaiKey || process.env.OPENAI_API_KEY,
      fetchImpl: fetchImpl || fetch
    });

    const rawItinerary = extracted?.itinerary || {};
    const stops = normaliseTextItineraryStops(rawItinerary.stops);
    const itineraryJson = {
      cruise_line: rawItinerary.cruise_line || null,
      ship: rawItinerary.ship || null,
      voyage_name: rawItinerary.voyage_name || null,
      embarkation_date: rawItinerary.embarkation_date || null,
      disembarkation_date: rawItinerary.disembarkation_date || null,
      stops
    };

    const written = await store.writeTextItinerary(rest, {
      booking_id: bookingId,
      booking_reference: bookingReference,
      source_document_id: sourceDocumentId,
      document_fingerprint: fingerprint,
      itinerary_json: itineraryJson,
      extraction_status: "ready",
      extraction_error: null,
      extracted_at: nowIso(),
      extraction_model: extracted?.model || null,
      extraction_token_usage: extracted?.usage || null,
      updated_at: nowIso()
    });

    return {
      ok: true,
      skipped: false,
      reason: "extracted",
      extraction_calls,
      itinerary: itineraryJson,
      stop_count: stops.length,
      storage: written.source
    };
  } catch (error) {
    try {
      await store.writeTextItinerary(rest, {
        booking_id: bookingId,
        booking_reference: bookingReference,
        source_document_id: sourceDocumentId,
        document_fingerprint: fingerprint,
        extraction_status: "failed",
        extraction_error: error?.message || String(error),
        updated_at: nowIso()
      });
    } catch (persistError) {
      console.warn("[text-itinerary-process] failed status persist error", persistError.message || persistError);
    }

    return {
      ok: false,
      skipped: false,
      reason: "extraction_failed",
      extraction_calls,
      error: error?.message || String(error)
    };
  }
}

module.exports = {
  processTextItinerary,
  normaliseTextItineraryStops,
  formatTextItineraryTime,
  formatTextItineraryStopLabel,
  assertProductionUrl
};
