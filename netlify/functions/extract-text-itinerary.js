/**
 * One-shot / admin-triggered text itinerary extraction.
 * Uses Netlify OPENAI_API_KEY. Does not modify Booking Confirmation documents.
 *
 * POST { booking_reference: "CD5Q25" }
 * Auth: Admin Bearer (requireAdmin)
 */

const { requireAdmin } = require("./admin-auth");
const { processTextItinerary } = require("./lib/text-itinerary-process");
const {
  fingerprintBookingDocument,
  isBookingConfirmationType
} = require("./lib/itinerary-document-hash");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase server configuration is missing");
  return { supabaseUrl: supabaseUrl.replace(/\/$/, ""), serviceKey };
}

async function rest(path, options = {}) {
  const { supabaseUrl, serviceKey } = getSupabaseConfig();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
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
    throw new Error((data && data.message) || `Supabase HTTP ${response.status}`);
  }
  return data;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, {});
  if (event.httpMethod !== "POST") return jsonResponse(405, { success: false, error: "Method not allowed" });

  try {
    await requireAdmin(event);
    const body = JSON.parse(event.body || "{}");
    const bookingReference = String(body.booking_reference || "")
      .trim()
      .toUpperCase();
    if (!bookingReference) {
      return jsonResponse(400, { success: false, error: "booking_reference is required" });
    }

    const cacheRows = await rest(
      `base44_booking_cache?booking_reference=eq.${encodeURIComponent(bookingReference)}&select=booking_reference,base44_booking_id,raw_payload&limit=1`
    );
    const cache = Array.isArray(cacheRows) ? cacheRows[0] : null;
    if (!cache) {
      return jsonResponse(404, { success: false, error: "Booking cache not found" });
    }

    const booking = {
      ...(cache.raw_payload || {}),
      booking_reference: cache.booking_reference,
      base44_booking_id: cache.base44_booking_id || cache.raw_payload?.base44_booking_id
    };

    const docs = await rest(
      `booking_documents?booking_reference=eq.${encodeURIComponent(bookingReference)}&select=*&order=updated_at.desc&limit=20`
    );
    const confirmation = (Array.isArray(docs) ? docs : []).find((doc) =>
      isBookingConfirmationType(doc.document_type)
    );
    if (!confirmation?.file_url) {
      return jsonResponse(404, { success: false, error: "Booking Confirmation document not found" });
    }

    const result = await processTextItinerary({
      rest,
      booking,
      document: confirmation,
      supabaseUrl: process.env.SUPABASE_URL,
      openaiKey: process.env.OPENAI_API_KEY
    });

    return jsonResponse(200, {
      success: Boolean(result.ok || result.skipped),
      booking_reference: bookingReference,
      fingerprint: fingerprintBookingDocument(confirmation),
      result: {
        ok: result.ok,
        skipped: result.skipped,
        reason: result.reason,
        extraction_calls: result.extraction_calls,
        stop_count: result.stop_count || 0,
        storage: result.storage || null,
        error: result.error || null,
        stops: result.itinerary?.stops || []
      }
    });
  } catch (error) {
    console.error("extract-text-itinerary error", error);
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || "Extraction failed"
    });
  }
};
