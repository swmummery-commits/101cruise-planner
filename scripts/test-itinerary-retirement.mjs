/**
 * Offline proofs that journey-map itinerary extraction is retired.
 * Run: node scripts/test-itinerary-retirement.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const planner = readFileSync(path.join(root, "js/planner.js"), "utf8");
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const adminSrc = readFileSync(path.join(root, "js/admin.js"), "utf8");
const getBooking = readFileSync(path.join(root, "netlify/functions/get-booking.js"), "utf8");
const bookingDocs = readFileSync(path.join(root, "netlify/functions/booking-documents.js"), "utf8");
const docSync = readFileSync(path.join(root, "netlify/functions/document-sync.js"), "utf8");
const customerAccess = readFileSync(path.join(root, "netlify/functions/customer-access.js"), "utf8");
const adminItinerary = readFileSync(path.join(root, "netlify/functions/admin-itinerary.js"), "utf8");
const exceptionsApi = readFileSync(path.join(root, "netlify/functions/itinerary-exceptions.js"), "utf8");
const digest = readFileSync(path.join(root, "netlify/functions/itinerary-exceptions-digest.js"), "utf8");
const netlifyToml = readFileSync(path.join(root, "netlify.toml"), "utf8");
const notify = readFileSync(path.join(root, "netlify/functions/lib/itinerary-notify.js"), "utf8");

const {
  processBookingConfirmation,
  processConfirmationDocuments
} = require("../netlify/functions/lib/itinerary-auto-process.js");

/* Dashboard simple summary */
assert(planner.includes("function renderJourneySummary"), "journey summary helper");
assert(planner.includes("renderJourneySummary(mainCruise)"), "dashboard uses summary");
assert(planner.includes("Open Documents →"), "Open Documents CTA");
assert(planner.includes("Your detailed cruise itinerary is available in your Booking Confirmation"), "confirmation note");
assert(!/resolveDashboardJourney\(mainCruise\)/.test(planner), "dashboard does not resolve live journey map");
assert(!/initialiseDashboardRouteMap\(/.test(planner.match(/async function renderDashboard[\s\S]*?^}/m)?.[0] || ""), "dashboard does not init map");
assert(!/Journey map coming soon/.test(planner.match(/function renderJourneySummary[\s\S]*?^}/m)?.[0] || ""), "no coming soon in summary");
assert(!/customer-itinerary/.test(planner.match(/async function renderDashboard[\s\S]*?^}/m)?.[0] || ""), "dashboard path does not call customer-itinerary");

/* Client load path drops map assets */
assert(!indexHtml.includes("topojson-client"), "no topojson on index");
assert(!indexHtml.includes("dashboard-journey-map-geo"), "no geo helper on index");

/* Open Documents uses existing scroll fix */
assert(/function renderDocuments[\s\S]*scheduleScrollPlannerToTop\(\)/.test(planner), "Documents scrolls to top");

/* Auto-process disabled at engine + triggers */
const retired = await processBookingConfirmation({
  rest: async () => {
    throw new Error("rest must not be called");
  },
  booking: { base44_booking_id: "x" },
  document: { document_type: "Booking Confirmation", file_url: "https://example.com/a.pdf" },
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co"
});
assert(retired.reason === "itinerary_map_feature_retired", "engine retired");
assert(retired.extraction_calls === 0, "zero extraction calls");

const batch = await processConfirmationDocuments({
  rest: async () => {
    throw new Error("rest must not be called");
  },
  booking: { base44_booking_id: "x" },
  documents: [{ document_type: "Booking Confirmation", file_url: "https://example.com/a.pdf" }],
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co"
});
assert(Array.isArray(batch) && batch.every((r) => r.reason === "itinerary_map_feature_retired"), "batch retired");

assert(!/processConfirmationDocuments/.test(getBooking), "get-booking does not auto-process");
assert(!/processBookingConfirmation/.test(bookingDocs), "uploads do not auto-process");
assert(!/confirmation_candidates\.push/.test(docSync), "sync does not enqueue candidates");
assert(!/processBookingConfirmation|extractItineraryWithOpenAI/.test(customerAccess), "customer login never extracts");
assert(/never extract/i.test(customerAccess), "customer-access documents no-extract");

assert(/itinerary_map_feature_retired/.test(adminItinerary), "admin-itinerary retired");
assert(/410/.test(adminItinerary), "admin-itinerary returns 410");

/* Admin UI cleaned */
assert(!adminSrc.includes('badgeKey: "itineraryExceptions"'), "no nav badge key");
assert(!/renderItineraryNeedsAttentionQueue\(\)/.test(adminSrc), "queue not rendered");
assert(!/Extract itinerary/.test(adminSrc), "no Extract itinerary control");
assert(!/Retry extraction/.test(adminSrc), "no Retry extraction control");
assert(!/Approve itinerary/.test(adminSrc), "no Approve itinerary control");
assert(!/Revalidate/.test(adminSrc) || !/revalidateBookingItinerary\(\)/.test(adminSrc.match(/function renderCrmDocumentsPanel[\s\S]*?^}/m)?.[0] || "x"), "doc panel has no revalidate");
assert(!/renderItineraryReview\(booking\)/.test(adminSrc), "review panel not in workspace");
assert(/document management|document library|Booking Confirmation PDF/i.test(adminSrc), "docs-only intro copy");

/* Digest / email */
assert(!/\[functions\."itinerary-exceptions-digest"\][\s\S]*schedule\s*=/.test(netlifyToml), "digest schedule removed");
assert(/itinerary_map_feature_retired/.test(digest), "digest stub retired");
assert(!/sendItineraryExceptionDigest/.test(digest), "digest does not send mail");
assert(/itinerary_map_feature_retired/.test(exceptionsApi), "exceptions API retired");
// Notify lib may remain unused — active digest/API must not call Resend.
assert(!/fetch\(["']https:\/\/api\.resend\.com/.test(digest), "digest no Resend");
assert(!/api\.resend\.com/.test(exceptionsApi), "exceptions API no Resend");

/* Docs */
const journeyDoc = readFileSync(path.join(root, "docs/client-portal-itinerary-journey-map.md"), "utf8");
assert(/Retired/i.test(journeyDoc), "journey doc retired");
assert(/excessive ongoing administration/i.test(journeyDoc), "admin burden recorded");

console.log("test-itinerary-retirement: ok");
