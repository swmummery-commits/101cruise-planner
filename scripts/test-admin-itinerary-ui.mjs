/**
 * Offline checks for Admin Booking Documents itinerary wiring.
 * Run: node scripts/test-admin-itinerary-ui.mjs
 * Does not call OpenAI or write to the database.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const adminSrc = readFileSync(path.join(root, "js/admin.js"), "utf8");

const {
  isBookingConfirmation,
  pickConfirmation,
  pickConfirmationById
} = require("../netlify/functions/admin-itinerary.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(adminSrc.includes('id: "booking-documents"'), "Booking Documents tab registered");
assert(adminSrc.includes("renderBookingDocumentsPanel"), "Booking Documents panel renderer exists");
assert(adminSrc.includes("Extract itinerary"), "Extract itinerary action present on documents");
assert(adminSrc.includes("Approve itinerary") || adminSrc.includes("Approve Itinerary") || adminSrc.includes("saveItineraryReview(true)"), "Approve action present");
assert(
  /Customer Experience[\s\S]*booking-documents/.test(adminSrc) ||
    adminSrc.includes('{ id: "booking-documents", label: "Booking Documents" }'),
  "Booking Documents lives under Customer Experience nav"
);

assert(!/ADMIN_MAIN_TABS[\s\S]*id:\s*"crm-sync"/.test(adminSrc), "CRM Sync main tab was not restored");
assert(adminSrc.includes("Emergency CRM recovery"), "Emergency recovery remains import-only");
assert(
  /function renderCrmSyncPanel[\s\S]*Open in Booking Documents/.test(adminSrc),
  "Emergency recovery points to Booking Documents"
);
assert(
  !/function renderCrmSyncPanel[\s\S]*Extract Booking Confirmation/.test(adminSrc),
  "Extract action removed from emergency CRM recovery panel"
);

assert(adminSrc.includes("document_id: selectedItineraryDocumentId"), "extract posts selected document id");
assert(adminSrc.includes("isAdminBookingConfirmation"), "UI restricts extract to booking confirmations");

assert(isBookingConfirmation({ document_type: "Booking Confirmation" }), "confirmation type accepted");
assert(!isBookingConfirmation({ document_type: "Travel Insurance" }), "non-confirmation rejected");
assert(
  pickConfirmation([
    { document_type: "Travel Insurance", file_url: "https://example.com/a.pdf" },
    { document_type: "Booking Confirmation", file_url: "https://example.com/b.pdf", uploaded_at: "2026-07-01" }
  ])?.file_url === "https://example.com/b.pdf",
  "pickConfirmation selects booking confirmation only"
);

let threw = false;
try {
  pickConfirmationById(
    [{ id: "1", document_type: "Travel Insurance", file_url: "https://example.com/a.pdf" }],
    "1"
  );
} catch (error) {
  threw = /Booking Confirmation/i.test(error.message);
}
assert(threw, "pickConfirmationById refuses non-confirmation documents");

assert(
  pickConfirmationById(
    [{ id: "doc-1", document_type: "Booking Confirmation", file_url: "https://example.com/c.pdf" }],
    "doc-1"
  )?.id === "doc-1",
  "pickConfirmationById accepts confirmation id"
);

console.log("test-admin-itinerary-ui: ok");
