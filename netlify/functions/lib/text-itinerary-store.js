/**
 * Persistence for text-only itineraries.
 * Prefers booking_text_itineraries; falls back to cruise_itineraries when the
 * dedicated table is not yet migrated (does not approve map itineraries).
 */

"use strict";

const { assessTextItineraryCompleteness } = require("./text-itinerary-completeness");

function normaliseStops(rawStops) {
  const { normaliseTextItineraryStops } = require("./text-itinerary-process");
  return normaliseTextItineraryStops(rawStops);
}

function isMissingRelation(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("booking_text_itineraries") &&
    (message.includes("does not exist") ||
      message.includes("could not find") ||
      message.includes("404") ||
      message.includes("pgrst205"))
  );
}

async function getDedicatedRow(rest, bookingId, bookingRef) {
  if (bookingId) {
    const rows = await rest(
      `booking_text_itineraries?booking_id=eq.${encodeURIComponent(bookingId)}&select=*&limit=1`,
      { method: "GET" }
    );
    if (Array.isArray(rows) && rows[0]) return rows[0];
  }
  if (bookingRef) {
    const rows = await rest(
      `booking_text_itineraries?booking_reference=eq.${encodeURIComponent(bookingRef)}&select=*&limit=1`,
      { method: "GET" }
    );
    if (Array.isArray(rows) && rows[0]) return rows[0];
  }
  return null;
}

async function getLegacyCruiseItineraryRow(rest, bookingId, bookingRef) {
  if (bookingId) {
    const rows = await rest(
      `cruise_itineraries?booking_id=eq.${encodeURIComponent(bookingId)}&select=*&limit=1`,
      { method: "GET" }
    );
    if (Array.isArray(rows) && rows[0]) return rows[0];
  }
  if (bookingRef) {
    const rows = await rest(
      `cruise_itineraries?booking_reference=eq.${encodeURIComponent(bookingRef)}&select=*&limit=1`,
      { method: "GET" }
    );
    if (Array.isArray(rows) && rows[0]) return rows[0];
  }
  return null;
}

function legacyRowToTextResult(row, booking = {}) {
  if (!row) return null;
  const data = row.itinerary_data || {};
  const rawStops = Array.isArray(data.stops) ? data.stops : [];
  const stops =
    data.mode === "text_only" || data.text_only === true
      ? Array.isArray(data.text_stops)
        ? data.text_stops
        : normaliseStops(rawStops)
      : normaliseStops(rawStops);

  if (!stops.length) return null;

  // Never treat embarkation/disembarkation-only legacy rows as a usable text itinerary.
  if (!assessTextItineraryCompleteness(stops, booking).complete) {
    return null;
  }

  return {
    source: "cruise_itineraries",
    status: "ready",
    document_fingerprint: row.source_document_hash || data.document_fingerprint || null,
    itinerary: {
      cruise_line: data.cruise_line || null,
      ship: data.ship || null,
      voyage_name: data.voyage_name || null,
      embarkation_date: data.embarkation_date || null,
      disembarkation_date: data.disembarkation_date || null,
      stops
    }
  };
}

async function readTextItinerary(rest, { bookingId, bookingRef, booking = null }) {
  try {
    const dedicated = await getDedicatedRow(rest, bookingId, bookingRef);
    if (dedicated) {
      const status = String(dedicated.extraction_status || "").toLowerCase();
      const stops = Array.isArray(dedicated.itinerary_json?.stops)
        ? dedicated.itinerary_json.stops
        : [];
      if (
        status === "ready" &&
        stops.length &&
        assessTextItineraryCompleteness(stops, booking || {}).complete
      ) {
        return {
          source: "booking_text_itineraries",
          status: "ready",
          document_fingerprint: dedicated.document_fingerprint || null,
          itinerary: {
            cruise_line: dedicated.itinerary_json?.cruise_line || null,
            ship: dedicated.itinerary_json?.ship || null,
            voyage_name: dedicated.itinerary_json?.voyage_name || null,
            embarkation_date: dedicated.itinerary_json?.embarkation_date || null,
            disembarkation_date: dedicated.itinerary_json?.disembarkation_date || null,
            stops
          }
        };
      }
      // Incomplete "ready" rows are treated as unavailable for customer display.
      if (status === "ready" && stops.length) {
        return {
          source: "booking_text_itineraries",
          status: "failed",
          document_fingerprint: dedicated.document_fingerprint || null,
          itinerary: null
        };
      }
      return {
        source: "booking_text_itineraries",
        status: status || null,
        document_fingerprint: dedicated.document_fingerprint || null,
        itinerary: null
      };
    }
  } catch (error) {
    if (!isMissingRelation(error)) throw error;
  }

  const legacy = await getLegacyCruiseItineraryRow(rest, bookingId, bookingRef);
  return legacyRowToTextResult(legacy, booking || {});
}

async function writeTextItinerary(rest, payload) {
  const body = {
    booking_id: payload.booking_id,
    booking_reference: payload.booking_reference || null,
    source_document_id: payload.source_document_id || null,
    document_fingerprint: payload.document_fingerprint || null,
    itinerary_json: payload.itinerary_json || { stops: [] },
    extraction_status: payload.extraction_status || "pending",
    extraction_error: payload.extraction_error || null,
    extracted_at: payload.extracted_at || null,
    extraction_model: payload.extraction_model || null,
    extraction_token_usage: payload.extraction_token_usage || null,
    updated_at: payload.updated_at || new Date().toISOString()
  };

  try {
    const rows = await rest("booking_text_itineraries?on_conflict=booking_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(body)
    });
    return {
      source: "booking_text_itineraries",
      row: Array.isArray(rows) ? rows[0] || null : rows
    };
  } catch (error) {
    if (!isMissingRelation(error)) throw error;
  }

  // Fallback: store text itinerary on cruise_itineraries without approving maps.
  const existing = await getLegacyCruiseItineraryRow(rest, payload.booking_id, payload.booking_reference);
  const prevData = existing?.itinerary_data && typeof existing.itinerary_data === "object"
    ? existing.itinerary_data
    : {};
  const itineraryJson = payload.itinerary_json || { stops: [] };
  const nextData = {
    ...prevData,
    ...itineraryJson,
    mode: "text_only",
    text_only: true,
    text_stops: Array.isArray(itineraryJson.stops) ? itineraryJson.stops : [],
    document_fingerprint: payload.document_fingerprint || null
  };

  const upsert = {
    booking_id: payload.booking_id,
    booking_reference: payload.booking_reference || null,
    itinerary_data: nextData,
    source_document_id: payload.source_document_id || existing?.source_document_id || null,
    source_document_hash: payload.document_fingerprint || existing?.source_document_hash || null,
    processing_status:
      payload.extraction_status === "ready"
        ? "text_ready"
        : payload.extraction_status === "failed"
          ? "failed"
          : payload.extraction_status || "processing",
    // Keep non-approved for map paths.
    status: existing?.status === "approved" ? existing.status : "text_only",
    extracted_at: payload.extracted_at || existing?.extracted_at || null,
    extraction_model: payload.extraction_model || existing?.extraction_model || null,
    extraction_token_usage: payload.extraction_token_usage || existing?.extraction_token_usage || null,
    updated_at: payload.updated_at || new Date().toISOString()
  };

  const rows = await rest("cruise_itineraries?on_conflict=booking_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(upsert)
  });

  return {
    source: "cruise_itineraries",
    row: Array.isArray(rows) ? rows[0] || null : rows
  };
}

module.exports = {
  readTextItinerary,
  writeTextItinerary,
  isMissingRelation,
  legacyRowToTextResult
};
