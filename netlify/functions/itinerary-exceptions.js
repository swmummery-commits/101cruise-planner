/**
 * Admin API for itinerary Needs Attention queue.
 * Actions: list, count, dismiss, assign, assignees, scan_stale
 * Viewing never clears exceptions.
 */

const { requireAdmin } = require("./admin-auth");
const {
  listOpenItineraryExceptions,
  countOpenItineraryExceptions,
  dismissItineraryException,
  assignItineraryException,
  scanStaleExtractionExceptions,
  publicExceptionView
} = require("./lib/itinerary-exceptions");
const { notifyItineraryException } = require("./lib/itinerary-notify");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function config() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase server configuration is missing");
  return { supabaseUrl, serviceKey };
}

async function rest(path, options = {}) {
  const { supabaseUrl, serviceKey } = config();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Prefer: options.prefer || "return=representation",
    ...(options.body ? { "Content-Type": "application/json" } : {})
  };
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Supabase request failed (HTTP ${response.status})`);
  }
  return data;
}

async function listAssignableAdmins() {
  const rows = await rest(
    "admin_users?active=eq.true&select=id,email,display_name,notify_itinerary_exceptions&order=display_name.asc.nullslast,email.asc&limit=100",
    { method: "GET" }
  ).catch(() => []);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row.id,
    email: row.email,
    display_name: row.display_name || row.email,
    notify_itinerary_exceptions: Boolean(row.notify_itinerary_exceptions)
  }));
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, {});
  try {
    const user = await requireAdmin(event);
    const body = event.body ? JSON.parse(event.body) : {};
    const action = String(
      body.action || event.queryStringParameters?.action || (event.httpMethod === "GET" ? "list" : "")
    ).trim();

    if (action === "count" || event.queryStringParameters?.count === "1") {
      // Opportunistically scan stale extractions when badge is refreshed.
      await scanStaleExtractionExceptions(rest).catch(() => []);
      const count = await countOpenItineraryExceptions(rest);
      return jsonResponse(200, { success: true, count });
    }

    if (action === "list" || event.httpMethod === "GET") {
      await scanStaleExtractionExceptions(rest).catch(() => []);
      const rows = await listOpenItineraryExceptions(rest);
      const assignees = await listAssignableAdmins();
      const docIds = [
        ...new Set(rows.map((r) => r.source_document_id).filter(Boolean).map(String))
      ];
      const bookingIds = [...new Set(rows.map((r) => r.booking_id).filter(Boolean).map(String))];
      const docsById = {};
      const itinerariesByBooking = {};
      if (docIds.length) {
        const docs = await rest(
          `booking_documents?id=in.(${docIds.map(encodeURIComponent).join(",")})&select=id,filename,content_fingerprint,itinerary_processing_status,itinerary_process_lock_until,itinerary_last_processed_at,itinerary_last_processed_hash,updated_at,created_at`,
          { method: "GET" }
        ).catch(() => []);
        for (const d of Array.isArray(docs) ? docs : []) docsById[String(d.id)] = d;
      }
      if (bookingIds.length) {
        const its = await rest(
          `cruise_itineraries?booking_id=in.(${bookingIds.map(encodeURIComponent).join(",")})&select=booking_id,status,approval_method,processing_status,source_document_hash,source_filename,itinerary_data,validation_result,extraction_call_count,extracted_at,approved_at`,
          { method: "GET" }
        ).catch(() => []);
        for (const row of Array.isArray(its) ? its : []) {
          itinerariesByBooking[String(row.booking_id)] = row;
        }
      }
      return jsonResponse(200, {
        success: true,
        count: rows.length,
        exceptions: rows.map((row) =>
          publicExceptionView(row, {
            document: row.source_document_id ? docsById[String(row.source_document_id)] || null : null,
            itinerary: row.booking_id ? itinerariesByBooking[String(row.booking_id)] || null : null
          })
        ),
        assignees
      });
    }

    if (action === "dismiss") {
      const updated = await dismissItineraryException(
        rest,
        body.exception_id,
        body.dismiss_reason,
        user.id || user.email
      );
      return jsonResponse(200, { success: true, exception: publicExceptionView(updated) });
    }

    if (action === "assign") {
      const updated = await assignItineraryException(rest, body.exception_id, body.admin_user_id || null);
      return jsonResponse(200, { success: true, exception: publicExceptionView(updated) });
    }

    if (action === "assignees") {
      return jsonResponse(200, { success: true, assignees: await listAssignableAdmins() });
    }

    if (action === "scan_stale") {
      const scanned = await scanStaleExtractionExceptions(rest);
      // Notify only newly created / changed stale rows
      for (const item of scanned) {
        if (item.should_notify) {
          // eslint-disable-next-line no-await-in-loop
          await notifyItineraryException(rest, item).catch(() => null);
        }
      }
      const count = await countOpenItineraryExceptions(rest);
      return jsonResponse(200, { success: true, scanned: scanned.length, count });
    }

    return jsonResponse(400, { success: false, error: "Unknown action" });
  } catch (error) {
    console.error("Itinerary exceptions API error", error);
    return jsonResponse(error.statusCode || 500, {
      success: false,
      error: error.message || "Unable to load itinerary exceptions"
    });
  }
};
