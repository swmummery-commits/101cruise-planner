/**
 * Itinerary auto-processing is retired. This suite proves the engine no longer
 * extracts or writes, and that active triggers remain disabled.
 * Run: node scripts/test-itinerary-auto-process.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const {
  processBookingConfirmation,
  processConfirmationDocuments
} = require("../netlify/functions/lib/itinerary-auto-process.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const restBoom = async () => {
  throw new Error("Supabase rest must not be called after itinerary retirement");
};

const retired = await processBookingConfirmation({
  rest: restBoom,
  booking: { base44_booking_id: "booking-1", booking_reference: "4118719" },
  document: {
    id: "doc-1",
    document_type: "Booking Confirmation",
    file_url: "https://example.com/a.pdf",
    filename: "a.pdf"
  },
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl: async () => {
    throw new Error("OpenAI must not be called");
  }
});
assert(retired.skipped === true, "skipped");
assert(retired.reason === "itinerary_map_feature_retired", "retired reason");
assert(retired.extraction_calls === 0, "no extraction calls");

const batch = await processConfirmationDocuments({
  rest: restBoom,
  booking: { base44_booking_id: "booking-1" },
  documents: [
    { id: "doc-1", document_type: "Booking Confirmation", file_url: "https://example.com/a.pdf" },
    { id: "x", document_type: "Travel Insurance", file_url: "https://example.com/x.pdf" }
  ],
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl: async () => {
    throw new Error("OpenAI must not be called");
  }
});
assert(batch.length === 1, "only confirmations considered");
assert(batch[0].reason === "itinerary_map_feature_retired", "batch retired");

const getBooking = readFileSync(path.join(root, "netlify/functions/get-booking.js"), "utf8");
assert(!/processConfirmationDocuments/.test(getBooking), "admin get-booking does not auto-process");

const customerAccess = readFileSync(path.join(root, "netlify/functions/customer-access.js"), "utf8");
assert(!/processConfirmationDocuments|processBookingConfirmation|extractItineraryWithOpenAI/.test(customerAccess), "customer-access has no map extract");
assert(/syncDocumentsForBooking/.test(customerAccess), "customer-access syncs booking documents");

const bookingDocs = readFileSync(path.join(root, "netlify/functions/booking-documents.js"), "utf8");
assert(!/processBookingConfirmation/.test(bookingDocs), "admin uploads do not auto-process");

console.log("test-itinerary-auto-process: ok (retired)");
