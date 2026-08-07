#!/usr/bin/env node
/**
 * Customer-access performance and critical-path tests (mocked delays).
 * Run: node scripts/test-customer-access-performance.mjs
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

process.env.BASE44_BOOKING_FUNCTION_URL =
  process.env.BASE44_BOOKING_FUNCTION_URL || "https://example.test/booking";
process.env.BASE44_API_KEY = process.env.BASE44_API_KEY || "test-key";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-key";

const {
  resolveCustomerBooking,
  BASE44_FETCH_TIMEOUT_MS
} = require("../netlify/functions/booking-service.js");
const { syncBookingDocuments } = require("../netlify/functions/lib/booking-document-sync.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const PERF_THRESHOLD_MS = 1500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCacheRow(ref, surname, docs = []) {
  return {
    base44_booking_id: `bk-${ref}`,
    booking_reference: ref,
    passenger1_last_name: surname,
    last_synced_at: new Date().toISOString(),
    raw_payload: {
      base44_booking_id: `bk-${ref}`,
      booking_reference: ref,
      passenger1_last_name: surname,
      documents: docs
    }
  };
}

function mockRest(cacheRow) {
  return async (pathPart, options = {}) => {
    if (pathPart.includes("base44_booking_cache") && (options.method || "GET") === "GET") {
      return cacheRow ? [cacheRow] : [];
    }
    return [];
  };
}

function slowBase44Fetch(delayMs, booking) {
  return async (_url, options = {}) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        });
      }
    });
    return {
      ok: true,
      json: async () => ({ booking })
    };
  };
}

function failingBase44Fetch(code = "base44_timeout") {
  return async (_url, options = {}) => {
    await delay(20);
    if (options.signal) {
      const error = new Error("Aborted");
      error.name = "AbortError";
      throw error;
    }
    const error = new Error(code);
    error.code = code;
    throw error;
  };
}

/* 1. Slow Base44 + valid cache → timely login */
{
  const started = Date.now();
  const cache = makeCacheRow("8D8R4W", "TESTNAME");
  const resolved = await resolveCustomerBooking(
    { booking_reference: "8D8R4W", surname: "TESTNAME" },
    {
      rest: mockRest(cache),
      fetchImpl: slowBase44Fetch(5000, {
        ...cache.raw_payload,
        passenger1_last_name: "TESTNAME"
      }),
      timeoutMs: 100
    }
  );
  const elapsed = Date.now() - started;
  assert(elapsed < PERF_THRESHOLD_MS, `1: slow Base44 with cache under ${PERF_THRESHOLD_MS}ms (${elapsed})`);
  assert(resolved.cacheFallback === true, "1: used cache fallback");
  assert(resolved.booking.booking_reference === "8D8R4W", "1: booking resolved");
}

/* 2. Slow Base44 without cache → controlled timeout error */
{
  let caught = null;
  try {
    await resolveCustomerBooking(
      { booking_reference: "NO_CACHE", surname: "TESTNAME" },
      {
        rest: mockRest(null),
        fetchImpl: slowBase44Fetch(5000, {
          booking_reference: "NO_CACHE",
          passenger1_last_name: "TESTNAME"
        }),
        timeoutMs: 100
      }
    );
  } catch (error) {
    caught = error;
  }
  assert(caught?.code === "base44_timeout", "2: timeout error code");
  assert(caught?.httpStatus === 503, "2: controlled 503 mapping");
}

/* 3. Multiple mirrored documents do not delay login (no sync on login path) */
{
  const customerAccess = readFileSync(path.join(root, "netlify/functions/customer-access.js"), "utf8");
  assert(!/syncDocumentsForBooking/.test(customerAccess), "3: login does not call document sync");
  assert(/resolveCustomerBooking/.test(customerAccess), "3: login uses cache-aware resolver");
}

/* 4. Document file downloads not synchronous on login */
{
  const customerAccess = readFileSync(path.join(root, "netlify/functions/customer-access.js"), "utf8");
  assert(!/syncBookingDocuments/.test(customerAccess), "4: login does not invoke sync engine");
  assert(!/downloadFile/.test(customerAccess), "4: login does not download files");
}

/* 5. Itinerary extraction does not block login */
{
  const customerAccess = readFileSync(path.join(root, "netlify/functions/customer-access.js"), "utf8");
  assert(!/processTextItinerary/.test(customerAccess), "5: login does not extract itinerary");
  assert(!/extractTextItinerary/.test(customerAccess), "5: login does not call extract endpoint");
}

/* 6. Reconciliation remains scheduled */
{
  const toml = readFileSync(path.join(root, "netlify.toml"), "utf8");
  assert(/\[functions\."reconcile-booking-documents"\]/.test(toml), "6: reconcile function configured");
  assert(/schedule = "0 4 \* \* \*"/.test(toml), "6: daily reconcile at 04:00 UTC");
}

/* 7. Document list/download endpoints unchanged */
{
  const customerDocs = readFileSync(path.join(root, "netlify/functions/customer-documents.js"), "utf8");
  assert(/list_all/.test(customerDocs), "7: unified list preserved");
  assert(/get_download_url/.test(customerDocs), "7: signed download preserved");
}

/* 8. Authentication remains secure */
{
  const cache = makeCacheRow("SECURE1", "SMITH");
  let caught = null;
  try {
    await resolveCustomerBooking(
      { booking_reference: "SECURE1", surname: "WRONG" },
      {
        rest: mockRest(cache),
        fetchImpl: failingBase44Fetch(),
        timeoutMs: 100
      }
    );
  } catch (error) {
    caught = error;
  }
  assert(caught?.code === "surname_mismatch", "8: wrong surname rejected from cache");
}

/* 9. Booking switch does not sync documents */
{
  const switchSrc = readFileSync(path.join(root, "netlify/functions/customer-switch-booking.js"), "utf8");
  assert(!/syncDocumentsForBooking/.test(switchSrc), "9: switch does not sync documents");
  assert(/BASE44_FETCH_TIMEOUT_MS/.test(switchSrc), "9: switch uses bounded Base44 fetch");
}

/* 10. Fixture bookings 8D8R4W and 638334 with cache fallback */
for (const ref of ["8D8R4W", "638334"]) {
  const started = Date.now();
  const cache = makeCacheRow(ref, "FIXTURE", [{ id: "d1" }, { id: "d2" }]);
  const resolved = await resolveCustomerBooking(
    { booking_reference: ref, surname: "FIXTURE" },
    {
      rest: mockRest(cache),
      fetchImpl: slowBase44Fetch(4000, { ...cache.raw_payload, passenger1_last_name: "FIXTURE" }),
      timeoutMs: 80
    }
  );
  const elapsed = Date.now() - started;
  assert(elapsed < PERF_THRESHOLD_MS, `10: ${ref} login under threshold (${elapsed}ms)`);
  assert(resolved.booking.booking_reference === ref, `10: ${ref} booking resolved`);
}

/* Sync engine still available for reconcile/backfill — unchanged behaviour */
{
  const started = Date.now();
  const booking = { base44_booking_id: "bk-perf", booking_reference: "PERF001" };
  const store = {
    rows: new Map(),
    rest: async (pathPart, options = {}) => {
      if (pathPart.includes("booking_documents?sync_key=")) return [];
      if (pathPart.includes("booking_documents?or=") && pathPart.includes("is_active")) return [];
      if (pathPart.includes("booking_documents?select=source_fingerprint")) return [];
      if (pathPart.includes("on_conflict=sync_key") && options.method === "POST") {
        const body = JSON.parse(options.body);
        store.rows.set(body.sync_key, { ...body, id: "doc-1" });
        return [body];
      }
      return [];
    }
  };
  await syncBookingDocuments(
    store.rest,
    booking,
    {
      documents: [
        { id: "d1", document_type: "Other", filename: "a.pdf", file_url: "https://example.com/a.pdf" },
        { id: "d2", document_type: "Other", filename: "b.pdf", file_url: "https://example.com/b.pdf" }
      ]
    },
    {
      skipFileMirror: true,
      processTextItinerary: async () => ({ ok: true, skipped: true })
    }
  );
  assert(Date.now() - started < PERF_THRESHOLD_MS, "sync metadata-only stays fast");
}

console.log("\ntest-customer-access-performance: ok\n");
