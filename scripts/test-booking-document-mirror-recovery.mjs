#!/usr/bin/env node
/**
 * Recovery, interruption, and listing tests for the booking document mirror.
 * Run: node scripts/test-booking-document-mirror-recovery.mjs
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  syncBookingDocuments,
  shouldExposeMirroredDocument,
  isIncompleteMirror
} = require("../netlify/functions/lib/booking-document-sync.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const booking = {
  base44_booking_id: "6af6c5e56cf7d37b4b0d73cc",
  booking_reference: "10237587"
};

const termsDoc = {
  id: "6af81cb80ebbb46c92e35665",
  document_type: "Signed Terms & Conditions",
  filename: "Signed Terms & Conditions - v1.0.pdf",
  file_url: "https://signwell.example/completed.pdf?signature=secret-token",
  visible_to_client: true
};

const confirmationDoc = {
  id: "confirmation-1",
  document_type: "Booking Confirmation",
  filename: "Booking Confirmation.pdf",
  file_url: "https://files.example/confirmation.pdf?X-Amz-Signature=secret"
};

const samplePdf = Buffer.from("%PDF-1.4 recovery");

function pdfDownload() {
  return {
    buffer: samplePdf,
    mimeType: "application/pdf",
    size: samplePdf.length
  };
}

function makeStore() {
  const rows = new Map();
  return {
    rows,
    rest: async (pathPart, options = {}) => {
      const method = options.method || "GET";
      if (pathPart.includes("booking_documents?sync_key=") && method === "GET") {
        const key = decodeURIComponent(pathPart.split("sync_key=eq.")[1].split("&")[0]);
        const row = rows.get(key);
        return row ? [row] : [];
      }
      if (pathPart.includes("booking_documents?or=") && method === "GET") {
        return [...rows.values()].filter((row) => row.is_active !== false && row.source_system === "base44");
      }
      if (pathPart.includes("booking_documents?on_conflict=sync_key") && method === "POST") {
        const body = JSON.parse(options.body);
        const existing = rows.get(body.sync_key);
        const saved = {
          ...(existing || {}),
          ...body,
          id: existing?.id || `doc-${rows.size + 1}`,
          updated_at: new Date().toISOString()
        };
        rows.set(body.sync_key, saved);
        return [saved];
      }
      if (pathPart.includes("booking_documents?id=eq.") && method === "PATCH") {
        const id = decodeURIComponent(pathPart.split("id=eq.")[1].split("&")[0]);
        const patch = JSON.parse(options.body);
        for (const [key, row] of rows.entries()) {
          if (row.id === id) {
            const next = { ...row, ...patch };
            rows.set(key, next);
            return [next];
          }
        }
        return [];
      }
      return [];
    }
  };
}

function makeStorage() {
  return {
    uploads: [],
    async upload(path, buffer, mimeType) {
      this.uploads.push({ path, size: buffer.length, mimeType });
    },
    async sign(path) {
      return `https://signed.example/${encodeURIComponent(path)}`;
    }
  };
}

function listLikeCustomer(rows) {
  return [...rows.values()].filter((row) => row.is_active !== false && shouldExposeMirroredDocument(row) && row.document_visible_to_customer !== false);
}

function listLikeAdmin(rows) {
  return [...rows.values()].filter((row) => shouldExposeMirroredDocument(row));
}

/* Interrupted after a successful upload and before the publishing metadata write. */
{
  const store = makeStore();
  const storage = makeStorage();
  let publishAttempts = 0;
  const rest = async (pathPart, options = {}) => {
    if (pathPart.includes("on_conflict=sync_key") && options.method === "POST") {
      const body = JSON.parse(options.body);
      if (body.is_active !== false) {
        publishAttempts += 1;
        if (publishAttempts === 1) throw new Error("metadata insert failed after upload");
      }
    }
    return store.rest(pathPart, options);
  };
  const first = await syncBookingDocuments(rest, booking, { documents: [termsDoc] }, {
    downloadFile: async () => pdfDownload(),
    storageClient: storage,
    processTextItinerary: async () => ({ ok: true, skipped: true })
  });
  const pending = [...store.rows.values()][0];
  assert(first.failed === 1, "interrupt: publishing failure is reported");
  assert(first.partial === true, "interrupt: result is partial");
  assert(first.inserted === 0, "interrupt: hidden reservation is not counted as inserted");
  assert(storage.uploads.length === 1, "interrupt: upload completed once");
  assert(store.rows.size === 1, "interrupt: one reserved row");
  assert(pending.is_active === false, "interrupt: reserved row stays inactive");
  assert(isIncompleteMirror(pending), "interrupt: row is an incomplete mirror");
  assert(listLikeCustomer(store.rows).length === 0, "interrupt: customer list hides the file");
  assert(listLikeAdmin(store.rows).length === 0, "interrupt: admin list hides the file");
  assert(!pending.file_url, "interrupt: source URL is not stored on the reservation");

  const second = await syncBookingDocuments(rest, booking, { documents: [termsDoc] }, {
    downloadFile: async () => pdfDownload(),
    storageClient: storage,
    processTextItinerary: async () => ({ ok: true, skipped: true })
  });
  const recovered = [...store.rows.values()][0];
  assert(second.failed === 0, "retry: recovery succeeds");
  assert(second.partial === false, "retry: recovery is complete");
  assert(second.inserted === 1, "retry: first publication counts as one insert");
  assert(store.rows.size === 1, "retry: no duplicate row");
  assert(recovered.id === pending.id, "retry: reuses the reserved row");
  assert(recovered.is_active === true, "retry: row becomes active");
  assert(recovered.document_visible_to_customer === true, "retry: customer visibility restored");
  assert(recovered.storage_path, "retry: storage path recorded");
  assert(!recovered.file_url, "retry: source URL cleared");
  assert(listLikeCustomer(store.rows).length === 1, "retry: customer can list the file");
  assert(listLikeAdmin(store.rows).length === 1, "retry: admin can list the file");
  assert(storage.uploads.length === 2, "retry: second upload reuses the same object key");
  assert(storage.uploads[0].path === storage.uploads[1].path, "retry: storage path is stable");
}

/* Concurrent syncs converge on one visible row. */
{
  const store = makeStore();
  const storage = makeStorage();
  const options = {
    downloadFile: async () => pdfDownload(),
    storageClient: storage,
    processTextItinerary: async () => ({ ok: true, skipped: true })
  };
  const [left, right] = await Promise.all([
    syncBookingDocuments(store.rest, booking, { documents: [termsDoc] }, options),
    syncBookingDocuments(store.rest, booking, { documents: [termsDoc] }, options)
  ]);
  assert(store.rows.size === 1, "concurrent: one row");
  const row = [...store.rows.values()][0];
  assert(row.is_active === true, "concurrent: row is active");
  assert(shouldExposeMirroredDocument(row), "concurrent: row is listable");
  assert((left.inserted + right.inserted) === 1, "concurrent: only one insert");
  assert((left.failed + right.failed) === 0, "concurrent: neither sync fails");
}

/* A different worker can publish between the lookup and reservation. */
{
  const store = makeStore();
  const storage = makeStorage();
  let raced = false;
  const options = {
    downloadFile: async () => pdfDownload(),
    storageClient: storage,
    processTextItinerary: async () => ({ ok: true, skipped: true })
  };
  const source = { documents: [termsDoc] };
  await syncBookingDocuments(store.rest, booking, source, options);
  const published = [...store.rows.values()][0];

  const result = await syncBookingDocuments(async (endpoint, request) => {
    if (!raced && endpoint.startsWith("booking_documents?sync_key=")) {
      raced = true;
      return [];
    }
    if (endpoint.includes("on_conflict=sync_key") && JSON.parse(request.body).is_active === false) {
      assert(request.headers.Prefer.includes("resolution=ignore-duplicates"),
        "reservation: a late reservation must never overwrite a published row");
      return [];
    }
    return store.rest(endpoint, request);
  }, booking, source, options);

  assert(raced && result.unchanged === 1, "reservation: sync reuses the other worker's publication");
  assert(store.rows.get(published.sync_key).id === published.id, "reservation: published row is preserved");
  assert(storage.uploads.length === 1, "reservation: published file is not uploaded again");
}

/* A slow download can be stopped without exposing a file, then recovered. */
{
  const store = makeStore();
  const storage = makeStorage();
  const controller = new AbortController();
  const slowDownload = async (_url, _fetchImpl, context) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1000);
      const abort = () => {
        clearTimeout(timer);
        const error = new Error("download aborted");
        error.name = "AbortError";
        error.code = "sync_interrupted";
        reject(error);
      };
      if (context?.signal?.aborted) abort();
      else context?.signal?.addEventListener("abort", abort, { once: true });
      setTimeout(() => controller.abort(), 25);
    });
    return pdfDownload();
  };
  const stopped = await syncBookingDocuments(store.rest, booking, { documents: [termsDoc] }, {
    signal: controller.signal,
    correlationId: "slow-download",
    downloadFile: slowDownload,
    storageClient: storage,
    processTextItinerary: async () => ({ ok: true, skipped: true })
  });
  assert(stopped.interrupted === true, "slow: sync reports interruption");
  assert(stopped.partial === true, "slow: sync is partial");
  assert(storage.uploads.length === 0, "slow: aborted download does not upload");
  assert(listLikeCustomer(store.rows).length === 0, "slow: customer list stays empty");
  assert(listLikeAdmin(store.rows).length === 0, "slow: admin list stays empty");

  const recovered = await syncBookingDocuments(store.rest, booking, { documents: [termsDoc] }, {
    downloadFile: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return pdfDownload();
    },
    storageClient: storage,
    processTextItinerary: async () => ({ ok: true, skipped: true })
  });
  assert(recovered.partial === false, "slow retry: finished download is a complete sync");
  assert(listLikeCustomer(store.rows).length === 1, "slow retry: customer list shows the file");
  assert(store.rows.size === 1, "slow retry: still one row");
}

/* Itinerary extraction runs only after every mirrored file is durable. */
{
  const store = makeStore();
  const storage = makeStorage();
  let sawBothBeforeExtract = false;
  const result = await syncBookingDocuments(store.rest, booking, {
    documents: [confirmationDoc, termsDoc]
  }, {
    downloadFile: async () => pdfDownload(),
    storageClient: storage,
    processTextItinerary: async () => {
      const rows = [...store.rows.values()];
      sawBothBeforeExtract = rows.length === 2 && rows.every((row) => row.is_active === true && row.storage_path);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true, reason: "extracted" };
    }
  });
  assert(sawBothBeforeExtract, "extraction: both files are stored before extraction starts");
  assert(result.inserted === 2, "extraction: both documents inserted");
  assert(result.text_itinerary_process.length === 1, "extraction: only the confirmation is processed");
  assert(result.partial === false, "extraction: mirror is complete even though extraction ran");
}

/* Stage logs carry a correlation id and omit signed URLs and credentials. */
{
  const store = makeStore();
  const lines = [];
  const original = console.info;
  console.info = (...args) => {
    lines.push(args.map((part) => String(part)).join(" "));
  };
  try {
    await syncBookingDocuments(store.rest, booking, { documents: [termsDoc] }, {
      correlationId: "corr-10237587",
      downloadFile: async () => pdfDownload(),
      storageClient: makeStorage(),
      processTextItinerary: async () => ({ ok: true, skipped: true })
    });
  } finally {
    console.info = original;
  }
  const blob = lines.join("\n");
  assert(lines.length > 0, "logs: stage lines emitted");
  assert(blob.includes("corr-10237587"), "logs: correlation id present");
  assert(blob.includes("6af81cb80ebbb46c92e35665"), "logs: source document id present");
  assert(blob.includes("upload_ok"), "logs: upload stage present");
  assert(blob.includes("metadata_committed"), "logs: metadata stage present");
  assert(!/https?:\/\//i.test(blob), "logs: no download URL");
  assert(!/signature=|x-amz-|api[_-]?key|service_role|bearer /i.test(blob), "logs: no credentials");
}

/* Callers report a partial library instead of a completed refresh. */
{
  const customer = readFileSync(path.join(root, "netlify/functions/customer-documents.js"), "utf8");
  const admin = readFileSync(path.join(root, "js/admin.js"), "utf8");
  const planner = readFileSync(path.join(root, "js/planner.js"), "utf8");
  const bookingDocs = readFileSync(path.join(root, "netlify/functions/booking-documents.js"), "utf8");
  const getBooking = readFileSync(path.join(root, "netlify/functions/get-booking.js"), "utf8");
  assert(!customer.includes("Promise.race"), "customer sync does not abandon the mirror with Promise.race");
  assert(customer.includes("controller.abort()"), "customer sync stops new work with an abort signal");
  assert(customer.includes("sync_status: status"), "customer response uses the computed sync status");
  assert(customer.includes("isIncompleteMirror"), "customer listing hides incomplete mirrors");
  assert(planner.includes("this library may be incomplete"), "customer UI warns when the library is partial");
  assert(admin.includes("not fully refreshed"), "admin UI warns when the mirror is partial");
  assert(admin.includes("incomplete_hidden"), "admin list surfaces hidden in-progress files");
  assert(bookingDocs.includes("isIncompleteMirror"), "admin and customer APIs hide incomplete mirrors");
  assert(getBooking.includes("status: ("), "get-booking returns a partial sync status");
}

console.log("\nBooking document mirror recovery tests passed.\n");
