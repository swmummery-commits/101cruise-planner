/**
 * Daily Base44 booking document reconciliation (Netlify Scheduled Function).
 * Schedule: 04:00 UTC daily
 */

const { fetchBase44Booking, cacheBookingInSupabase, supabaseRest } = require("./booking-service");
const { syncBookingDocuments } = require("./lib/booking-document-sync");

const DEFAULT_BATCH = 20;

function parseBody(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    return {};
  }
}

function cronSecret() {
  return String(process.env.DISCOVERY_CRON_SECRET || process.env.BOOKING_DOCUMENT_RECONCILE_SECRET || "").trim();
}

function isScheduledInvocation(event) {
  const headers = event.headers || {};
  return (
    String(headers["x-netlify-event"] || headers["X-Netlify-Event"] || "").toLowerCase() === "schedule" ||
    String(headers["netlify-scheduled"] || headers["Netlify-Scheduled"] || "").toLowerCase() === "true"
  );
}

function assertReconcileAuth(event) {
  if (isScheduledInvocation(event)) return;
  const expected = cronSecret();
  if (!expected) {
    const error = new Error("Reconciliation secret is not configured");
    error.statusCode = 503;
    throw error;
  }
  const provided = String(
    event.headers?.["x-discovery-cron-secret"] ||
      event.headers?.["X-Discovery-Cron-Secret"] ||
      event.headers?.["x-booking-document-reconcile-secret"] ||
      event.headers?.["X-Booking-Document-Reconcile-Secret"] ||
      ""
  ).trim();
  if (provided !== expected) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

function isEligibleBooking(row) {
  const payload = row.raw_payload || {};
  const status = String(payload.booking_status || row.booking_status || "").toLowerCase();
  if (status.includes("cancel")) return false;

  const departing = payload.departing_date || row.departing_date;
  if (departing) {
    const departDate = new Date(departing);
    if (!Number.isNaN(departDate.getTime())) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      if (departDate >= cutoff) return true;
    }
  }

  const lastSynced = row.last_synced_at ? new Date(row.last_synced_at) : null;
  if (lastSynced && !Number.isNaN(lastSynced.getTime())) {
    const recent = new Date();
    recent.setDate(recent.getDate() - 14);
    if (lastSynced >= recent) return true;
  }

  return Boolean(Array.isArray(payload.documents) && payload.documents.length);
}

exports.handler = async function reconcileBookingDocuments(event) {
  const started = Date.now();
  const body = parseBody(event);
  const batchSize = Math.min(Math.max(Number(body.batch_size || DEFAULT_BATCH), 1), 50);
  const cursor = Math.max(Number(body.cursor || 0), 0);
  const dryRun = body.dry_run === true;

  const totals = {
    success: true,
    dry_run: dryRun,
    cursor,
    batch_size: batchSize,
    bookings_scanned: 0,
    bookings_processed: 0,
    bookings_skipped: 0,
    documents: {
      discovered: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      archived: 0,
      failed: 0
    },
    errors: []
  };

  try {
    assertReconcileAuth(event);
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase server configuration is missing");
    }

    const cacheRows = await supabaseRest(
      `base44_booking_cache?select=base44_booking_id,booking_reference,raw_payload,last_synced_at&order=booking_reference.asc&limit=${batchSize}&offset=${cursor}`,
      { method: "GET" }
    );

    const eligible = (cacheRows || []).filter(isEligibleBooking);
    totals.bookings_scanned = (cacheRows || []).length;

    for (const cacheRow of eligible) {
      totals.bookings_processed += 1;
      const bookingRef = cacheRow.booking_reference;
      const bookingId = cacheRow.base44_booking_id;

      try {
        let booking;
        let source;
        if (process.env.BASE44_BOOKING_FUNCTION_URL && process.env.BASE44_API_KEY) {
          ({ booking, source } = await fetchBase44Booking({
            booking_reference: bookingRef,
            booking_id: bookingId
          }));
          if (!dryRun) await cacheBookingInSupabase(booking);
        } else {
          booking = {
            ...(cacheRow.raw_payload || {}),
            base44_booking_id: bookingId,
            booking_reference: bookingRef
          };
          source = { documents: cacheRow.raw_payload?.documents || [] };
        }

        if (dryRun) {
          const docs = Array.isArray(source?.documents)
            ? source.documents
            : Array.isArray(booking?.documents)
              ? booking.documents
              : [];
          totals.documents.discovered += docs.length;
          continue;
        }

        const syncResult = await syncBookingDocuments(supabaseRest, booking, source, {
          completeFetch: Boolean(source?.documents || booking?.documents)
        });
        totals.documents.discovered += syncResult.discovered || 0;
        totals.documents.inserted += syncResult.inserted || 0;
        totals.documents.updated += syncResult.updated || 0;
        totals.documents.unchanged += syncResult.unchanged || 0;
        totals.documents.archived += syncResult.archived || 0;
        totals.documents.failed += syncResult.failed || 0;
        if (syncResult.errors?.length) {
          totals.errors.push(...syncResult.errors.slice(0, 3).map((entry) => ({
            booking_reference: bookingRef,
            ...entry
          })));
        }
      } catch (bookingError) {
        totals.errors.push({
          booking_reference: bookingRef,
          message: bookingError.message || String(bookingError)
        });
      }
    }

    totals.bookings_skipped = totals.bookings_scanned - totals.bookings_processed;
    totals.next_cursor = cursor + batchSize;
    totals.has_more = (cacheRows || []).length === batchSize;
    totals.elapsed_ms = Date.now() - started;

    return {
      statusCode: 200,
      body: JSON.stringify(totals)
    };
  } catch (error) {
    console.error("reconcile-booking-documents failed", error);
    return {
      statusCode: error.statusCode || 500,
      body: JSON.stringify({
        success: false,
        error: error.message || "Reconciliation failed",
        elapsed_ms: Date.now() - started
      })
    };
  }
};
