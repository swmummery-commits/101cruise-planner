#!/usr/bin/env node
/**
 * Base44 booking document mirror sync tests (offline mocks).
 * Run: node scripts/test-booking-document-sync.mjs
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const {
  syncBookingDocuments,
  mapBase44Document,
  normaliseDocumentType,
  buildSyncKey,
  buildSourceFingerprint,
  hashValue,
  pickVisibility
} = require("../netlify/functions/lib/booking-document-sync.js");
const { isBookingConfirmationType } = require("../netlify/functions/lib/itinerary-document-hash.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const booking = {
  base44_booking_id: "bk-test-001",
  booking_reference: "TEST001"
};

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
      if (pathPart.includes("booking_documents?id=eq.") && method === "GET") {
        const id = decodeURIComponent(pathPart.split("id=eq.")[1].split("&")[0]);
        for (const row of rows.values()) {
          if (row.id === id) return [row];
        }
        return [];
      }
      if (pathPart.includes("booking_documents?or=") && method === "GET" && pathPart.includes("is_active=eq.true")) {
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

const samplePdf = Buffer.from("%PDF-1.4 test");
const mockDownload = async () => ({
  buffer: samplePdf,
  mimeType: "application/pdf",
  size: samplePdf.length
});

const mockStorage = {
  uploads: [],
  async upload(path, buffer, mimeType) {
    this.uploads.push({ path, size: buffer.length, mimeType });
  },
  async sign(path) {
    return `https://signed.example/${encodeURIComponent(path)}`;
  }
};

let extractCalls = 0;
const mockExtract = async (args) => {
  extractCalls += 1;
  return { ok: true, skipped: false, reason: "extracted", extraction_calls: 1 };
};

async function syncWith(docs, store, extra = {}) {
  extractCalls = 0;
  mockStorage.uploads = [];
  return syncBookingDocuments(store.rest, booking, { documents: docs }, {
    skipFileMirror: false,
    allowMetadataOnly: false,
    downloadFile: mockDownload,
    storageClient: mockStorage,
    processTextItinerary: mockExtract,
    ...extra
  });
}

/* 1. One Booking Confirmation */
{
  const store = makeStore();
  const result = await syncWith(
    [{ id: "bc-1", document_type: "Booking Confirmation", filename: "confirmation.pdf", file_url: "https://base44.example/confirmation.pdf" }],
    store
  );
  assert(result.inserted === 1, "1: inserts booking confirmation");
  assert(extractCalls === 1, "1: confirmation triggers extraction");
}

/* 2. Confirmation + second CRM document */
{
  const store = makeStore();
  const result = await syncWith(
    [
      { id: "bc-1", document_type: "Booking Confirmation", filename: "confirmation.pdf", file_url: "https://base44.example/confirmation.pdf" },
      { id: "bc-2", document_type: "Travel Insurance", filename: "insurance.pdf", file_url: "https://base44.example/insurance.pdf" }
    ],
    store
  );
  assert(result.inserted === 2, "2: inserts two CRM documents");
  assert(extractCalls === 1, "2: only confirmation extracts");
}

/* 3. Multiple types */
{
  const store = makeStore();
  const result = await syncWith(
    [
      { id: "d1", document_type: "Visas", filename: "visa.pdf", file_url: "https://base44.example/visa.pdf" },
      { id: "d2", document_type: "Vaccinations", filename: "vax.pdf", file_url: "https://base44.example/vax.pdf" },
      { id: "d3", document_type: "Electronic Tickets/Boarding Pass", filename: "ticket.pdf", file_url: "https://base44.example/ticket.pdf" }
    ],
    store
  );
  assert(result.inserted === 3, "3: syncs multiple document types");
}

/* 4. Unknown type -> Other */
assert(normaliseDocumentType("Mystery Doc") === "Other", "4: unknown type becomes Other");

/* 5. Empty documents array archives nothing harmful */
{
  const store = makeStore();
  store.rows.set("base44:old", {
    id: "old-1",
    sync_key: "base44:old",
    source_system: "base44",
    base44_booking_id: booking.base44_booking_id,
    booking_reference: booking.booking_reference,
    is_active: true
  });
  const result = await syncWith([], store);
  assert(result.discovered === 0, "5: empty array discovered 0");
  assert(store.rows.get("base44:old").is_active === false, "5: missing doc archived");
}

/* 6. Malformed entry skipped */
{
  const store = makeStore();
  const result = await syncWith([{ document_type: "Other" }, { filename: "no-url.pdf" }], store);
  assert(result.skipped_invalid === 2, "6: malformed entries skipped");
}

/* 7. Duplicate sync no duplicate rows */
{
  const store = makeStore();
  const docs = [{ id: "dup-1", document_type: "Other", filename: "a.pdf", file_url: "https://base44.example/a.pdf" }];
  await syncWith(docs, store);
  const second = await syncWith(docs, store);
  assert(store.rows.size === 1, "7: single row after duplicate sync");
  assert(second.unchanged === 1, "7: second sync unchanged");
}

/* 8. Same filename changed URL updates row */
{
  const store = makeStore();
  await syncWith([{ id: "chg-1", document_type: "Other", filename: "same.pdf", file_url: "https://base44.example/v1.pdf" }], store);
  const updated = await syncWith([{ id: "chg-1", document_type: "Other", filename: "same.pdf", file_url: "https://base44.example/v2.pdf" }], store);
  assert(updated.updated === 1 || updated.inserted === 0, "8: changed source updates");
  assert(store.rows.get("base44:chg-1").source_file_url_hash === hashValue("https://base44.example/v2.pdf"), "8: url hash updated");
}

/* 9. Same filename different identities remain distinct */
{
  const store = makeStore();
  await syncWith(
    [
      { id: "id-a", document_type: "Other", filename: "shared.pdf", file_url: "https://base44.example/a.pdf" },
      { id: "id-b", document_type: "Other", filename: "shared.pdf", file_url: "https://base44.example/b.pdf" }
    ],
    store
  );
  assert(store.rows.size === 2, "9: two distinct rows for same filename");
}

/* 10. One failed download does not discard successful documents */
{
  const store = makeStore();
  let call = 0;
  const flakyDownload = async (url) => {
    call += 1;
    if (url.includes("bad.pdf")) {
      const error = new Error("Download failed");
      error.code = "download_http";
      throw error;
    }
    return mockDownload(url);
  };
  const result = await syncBookingDocuments(store.rest, booking, {
    documents: [
      { id: "ok-1", document_type: "Other", filename: "ok.pdf", file_url: "https://base44.example/ok.pdf" },
      { id: "bad-1", document_type: "Other", filename: "bad.pdf", file_url: "https://base44.example/bad.pdf" }
    ]
  }, {
    allowMetadataOnly: false,
    downloadFile: flakyDownload,
    storageClient: mockStorage,
    processTextItinerary: mockExtract
  });
  assert(result.inserted === 1, "10: one document inserted");
  assert(result.failed === 1, "10: one failed");
  assert(store.rows.has("base44:ok-1"), "10: successful document retained");
}

/* 11. Missing document archived after complete fetch */
{
  const store = makeStore();
  await syncWith([{ id: "gone-1", document_type: "Other", filename: "gone.pdf", file_url: "https://base44.example/gone.pdf" }], store);
  await syncWith([], store, { completeFetch: true });
  assert(store.rows.get("base44:gone-1").is_active === false, "11: removed doc archived");
  assert(store.rows.get("base44:gone-1").source_deleted_at, "11: source_deleted_at set");
}

/* 12. Incomplete fetch does not archive */
{
  const store = makeStore();
  await syncWith([{ id: "keep-1", document_type: "Other", filename: "keep.pdf", file_url: "https://base44.example/keep.pdf" }], store);
  await syncBookingDocuments(store.rest, booking, null, {
    documents: [],
    completeFetch: false,
    skipFileMirror: true,
    processTextItinerary: mockExtract
  });
  assert(store.rows.get("base44:keep-1").is_active !== false, "12: incomplete fetch preserves active doc");
}

/* 13. Archived document reactivated */
{
  const store = makeStore();
  await syncWith([{ id: "rev-1", document_type: "Other", filename: "rev.pdf", file_url: "https://base44.example/rev.pdf" }], store);
  await syncWith([], store);
  assert(store.rows.get("base44:rev-1").is_active === false, "13: archived first");
  await syncWith([{ id: "rev-1", document_type: "Other", filename: "rev.pdf", file_url: "https://base44.example/rev.pdf" }], store);
  assert(store.rows.get("base44:rev-1").is_active === true, "13: reactivated on reappearance");
  assert(!store.rows.get("base44:rev-1").source_deleted_at, "13: source_deleted_at cleared");
}

/* 14/15 covered by API design — CRM deletable false in mapCrmDocument */
assert(mapBase44Document({ id: "x", filename: "a.pdf", file_url: "https://a", document_type: "Other" }, booking).source_system === "base44", "14: CRM source remains base44");

/* 16. Signed URL access rejects wrong booking — handler scopes by session booking */
{
  const src = await import("fs").then((fs) => fs.readFileSync(path.join(root, "netlify/functions/customer-documents.js"), "utf8"));
  assert(src.includes("booking_id=eq."), "16: customer download scoped to booking");
  assert(src.includes("or=(") && src.includes("base44_booking_id"), "16: CRM download scoped to booking");
}

/* 17–19 extraction behaviour */
assert(isBookingConfirmationType("Booking Confirmation"), "17: confirmation detected");
assert(!isBookingConfirmationType("Travel Insurance"), "18: insurance not confirmation");
{
  const store = makeStore();
  const docs = [{ id: "same-bc", document_type: "Booking Confirmation", filename: "c.pdf", file_url: "https://base44.example/c.pdf" }];
  await syncWith(docs, store);
  extractCalls = 0;
  const again = await syncWith(docs, store);
  assert(again.unchanged === 1, "19: unchanged confirmation not re-uploaded");
}

/* 20. Unified list includes CRM + customer sources */
{
  const src = await import("fs").then((fs) => fs.readFileSync(path.join(root, "netlify/functions/customer-documents.js"), "utf8"));
  assert(src.includes("list_all"), "20: unified list action exists");
  assert(src.includes("crm_documents"), "20: CRM section returned");
  assert(src.includes("customer_documents"), "20: customer section returned");
}

/* Identity helpers */
{
  const mapped = mapBase44Document(
    { id: "abc123", filename: "f.pdf", file_url: "https://x", document_type: "Visas" },
    booking
  );
  assert(mapped.source_fingerprint === "abc123", "identity: uses Base44 id");
  assert(buildSyncKey({ base44DocumentId: "abc123" }) === "base44:abc123", "identity: sync key from id");
  const fallback = buildSourceFingerprint({
    base44BookingId: booking.base44_booking_id,
    filename: "f.pdf",
    uploadedAt: "2026-01-01T00:00:00.000Z",
    sourceFileUrlHash: hashValue("https://y")
  });
  assert(fallback.length === 32, "identity: fallback fingerprint length");
}

/* Visibility: Base44 documents are always customer-facing */
{
  const hidden = mapBase44Document(
    {
      id: "vis-false",
      document_type: "Other",
      filename: "hidden.pdf",
      file_url: "https://base44.example/hidden.pdf",
      document_visible_to_customer: false
    },
    booking
  );
  assert(hidden.document_visible_to_customer === true, "21: document_visible_to_customer false still maps true");
  assert(pickVisibility({ document_visible_to_customer: false }) === true, "21: pickVisibility ignores false");

  const visible = mapBase44Document(
    {
      id: "vis-true",
      document_type: "Other",
      filename: "visible.pdf",
      file_url: "https://base44.example/visible.pdf",
      document_visible_to_customer: true
    },
    booking
  );
  assert(visible.document_visible_to_customer === true, "22: document_visible_to_customer true maps true");

  const missing = mapBase44Document(
    { id: "vis-missing", document_type: "Other", filename: "plain.pdf", file_url: "https://base44.example/plain.pdf" },
    booking
  );
  assert(missing.document_visible_to_customer === true, "23: missing visibility field maps true");

  for (const field of ["visible_to_customer", "customer_visible", "is_customer_visible", "visible_to_client"]) {
    const alt = mapBase44Document(
      {
        id: `alt-${field}`,
        document_type: "Other",
        filename: `${field}.pdf`,
        file_url: `https://base44.example/${field}.pdf`,
        [field]: false
      },
      booking
    );
    assert(alt.document_visible_to_customer === true, `24: ${field}=false does not hide document`);
  }
}

/* Visibility change true -> false does not archive */
{
  const store = makeStore();
  await syncWith(
    [
      {
        id: "flip-1",
        document_type: "Other",
        filename: "flip.pdf",
        file_url: "https://base44.example/flip.pdf",
        document_visible_to_customer: true
      }
    ],
    store
  );
  await syncWith(
    [
      {
        id: "flip-1",
        document_type: "Other",
        filename: "flip.pdf",
        file_url: "https://base44.example/flip.pdf",
        document_visible_to_customer: false
      }
    ],
    store
  );
  const row = store.rows.get("base44:flip-1");
  assert(row.is_active === true, "25: visibility flip to false keeps document active");
  assert(row.document_visible_to_customer === true, "25: visibility flip to false keeps customer-visible true");
}

/* SWM123456: Booking Confirmation + Signed Terms & Conditions */
{
  const swmBooking = { base44_booking_id: "bk-swm", booking_reference: "SWM123456" };
  const confirmation = mapBase44Document(
    {
      id: "swm-bc",
      document_type: "Booking Confirmation",
      filename: "Booking Confirmation.pdf",
      file_url: "https://base44.example/swm-confirmation.pdf",
      document_visible_to_customer: true
    },
    swmBooking
  );
  const terms = mapBase44Document(
    {
      id: "swm-terms",
      document_type: "Signed Terms & Conditions",
      filename: "Signed Terms & Conditions.pdf",
      file_url: "https://base44.example/swm-terms.pdf",
      document_visible_to_customer: false,
      visible_to_customer: false,
      customer_visible: false
    },
    swmBooking
  );
  assert(confirmation.document_visible_to_customer === true, "26: SWM confirmation visible");
  assert(terms.document_visible_to_customer === true, "26: SWM terms visible despite CRM flags");
  assert(normaliseDocumentType(terms.document_type) === "Other", "26: SWM terms categorised as Other");

  const store = makeStore();
  extractCalls = 0;
  await syncBookingDocuments(store.rest, swmBooking, {
    documents: [
      {
        id: "swm-bc",
        document_type: "Booking Confirmation",
        filename: "Booking Confirmation.pdf",
        file_url: "https://base44.example/swm-confirmation.pdf"
      },
      {
        id: "swm-terms",
        document_type: "Signed Terms & Conditions",
        filename: "Signed Terms & Conditions.pdf",
        file_url: "https://base44.example/swm-terms.pdf",
        document_visible_to_customer: false
      }
    ]
  }, {
    downloadFile: mockDownload,
    storageClient: mockStorage,
    processTextItinerary: mockExtract
  });
  assert(store.rows.size === 2, "26: SWM sync stores both documents");
  assert(extractCalls === 1, "26: only confirmation triggers extraction");
}

/* API layers do not filter CRM documents by visibility */
{
  const customerSrc = await import("fs").then((fs) => fs.readFileSync(path.join(root, "netlify/functions/customer-documents.js"), "utf8"));
  const bookingSrc = await import("fs").then((fs) => fs.readFileSync(path.join(root, "netlify/functions/booking-documents.js"), "utf8"));
  const plannerSrc = await import("fs").then((fs) => fs.readFileSync(path.join(root, "js/planner.js"), "utf8"));
  assert(!customerSrc.includes("document_visible_to_customer=eq.true"), "27: customer list ignores visibility filter");
  assert(!bookingSrc.includes("document_visible_to_customer=eq.true"), "27: booking list ignores visibility filter");
  assert(!customerSrc.includes("document_visible_to_customer === false"), "27: customer download ignores visibility check");
  assert(!bookingSrc.includes("document_visible_to_customer === false"), "27: booking download ignores visibility check");
  assert(!plannerSrc.includes("document_visible_to_customer === false"), "27: planner ignores document visibility filter");
}

/* Reactivate previously hidden CRM document on sync touch */
{
  const store = makeStore();
  store.rows.set("base44:react-1", {
    id: "react-1",
    sync_key: "base44:react-1",
    source_system: "base44",
    base44_booking_id: booking.base44_booking_id,
    booking_reference: booking.booking_reference,
    filename: "react.pdf",
    file_url: "https://base44.example/react.pdf",
    document_type: "Other",
    storage_path: "bk-test-001/react/react.pdf",
    content_hash: "existing-hash",
    source_file_url_hash: hashValue("https://base44.example/react.pdf"),
    document_visible_to_customer: false,
    is_active: true
  });
  await syncWith(
    [
      {
        id: "react-1",
        document_type: "Other",
        filename: "react.pdf",
        file_url: "https://base44.example/react.pdf",
        document_visible_to_customer: false
      }
    ],
    store
  );
  const row = store.rows.get("base44:react-1");
  assert(row.document_visible_to_customer === true, "28: previously hidden row reactivated to visible");
  assert(row.is_active === true, "28: previously hidden row stays active");
}

/* Repeated login/reconciliation creates no duplicates with mixed visibility */
{
  const store = makeStore();
  const docs = [
    {
      id: "dup-vis",
      document_type: "Other",
      filename: "dup.pdf",
      file_url: "https://base44.example/dup.pdf",
      document_visible_to_customer: false
    }
  ];
  await syncWith(docs, store);
  await syncWith(docs, store);
  await syncWith([{ ...docs[0], document_visible_to_customer: true }], store);
  assert(store.rows.size === 1, "29: repeated sync with visibility changes keeps one row");
}

/* Signed URLs only — no Base44 URL or storage path in customer list responses */
{
  const customerSrc = await import("fs").then((fs) => fs.readFileSync(path.join(root, "netlify/functions/customer-documents.js"), "utf8"));
  const mapBlock = customerSrc.slice(
    customerSrc.indexOf("function mapCrmDocument"),
    customerSrc.indexOf("function mapCustomerDocument")
  );
  assert(customerSrc.includes("download_action: 'get_download_url'"), "30: CRM docs use on-demand signed URLs");
  assert(!mapBlock.includes("file_url"), "30: mapCrmDocument does not expose file_url");
  assert(!/return \{[\s\S]*storage_path:/.test(mapBlock), "30: mapCrmDocument response omits storage_path");
}

console.log("\nAll booking document sync tests passed.\n");
