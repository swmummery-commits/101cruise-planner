/**
 * Offline checks for Admin Booking Documents after itinerary retirement.
 * Run: node scripts/test-admin-itinerary-ui.mjs
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
assert(adminSrc.includes("Refresh documents"), "refresh documents retained");
assert(adminSrc.includes("Upload Admin document") || adminSrc.includes("Upload document"), "upload retained");
assert(!adminSrc.includes("Extract itinerary"), "Extract itinerary removed from active UI");
assert(!adminSrc.includes("Retry extraction"), "Retry extraction removed");
assert(!adminSrc.includes("Approve itinerary"), "Approve itinerary removed");
assert(!/renderItineraryNeedsAttentionQueue\(\)/.test(adminSrc), "Needs Attention queue not rendered");
assert(!adminSrc.includes('badgeKey: "itineraryExceptions"'), "nav badge removed");
assert(!/renderItineraryReview\(booking\)/.test(adminSrc), "itinerary review panel not mounted");
assert(
  /Customer Experience[\s\S]*booking-documents/.test(adminSrc) ||
    adminSrc.includes('{ id: "booking-documents", label: "Booking Documents" }'),
  "Booking Documents lives under Customer Experience nav"
);
assert(!/ADMIN_MAIN_TABS[\s\S]*id:\s*"crm-sync"/.test(adminSrc), "CRM Sync main tab was not restored");

assert(isBookingConfirmation({ document_type: "Booking Confirmation" }), "confirmation type helper retained");
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

console.log("test-admin-itinerary-ui: ok");
