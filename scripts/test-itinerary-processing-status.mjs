/**
 * Offline tests for authoritative itinerary-processing status display.
 * Does NOT call OpenAI. Does NOT write to Supabase.
 * Run: node scripts/test-itinerary-processing-status.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const {
  resolveEffectiveItineraryStatus,
  buildItineraryStatusView,
  formatItineraryStatusLabel,
  isRawInternalStatusLabel,
  EFFECTIVE,
  LOCK_TTL_MS
} = require("../js/itinerary-processing-status.js");

const { isDocumentProcessingStalled, publicExceptionView } = require("../netlify/functions/lib/itinerary-exceptions.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const now = Date.parse("2026-07-26T07:00:00.000Z");

/* Active processing within lock window → Processing everywhere */
const activeDoc = {
  filename: "confirm.pdf",
  itinerary_processing_status: "processing",
  itinerary_process_lock_until: new Date(now + 2 * 60 * 1000).toISOString(),
  content_fingerprint: "abc"
};
assert(
  resolveEffectiveItineraryStatus({ document: activeDoc, now }) === EFFECTIVE.PROCESSING,
  "active lock → processing"
);
const activeView = buildItineraryStatusView({ document: activeDoc, now });
assert(activeView.label === "Processing", "active label Processing");
assert(activeView.tone === "info", "active tone info (not red)");
assert(!activeView.can_retry, "active cannot retry");
assert(!/stalled/i.test(activeView.label), "active never stalled");

/* Stale / expired lock → Processing stalled everywhere */
const stalledDoc = {
  id: "00fb3c7b-6d64-4778-b9eb-eebc0ac42445",
  filename: "Final Documents Ruhi Bucknor  21 July 26.pdf",
  itinerary_processing_status: "processing",
  itinerary_process_lock_until: "2026-07-26T06:50:10.746+00:00",
  itinerary_last_processed_at: null,
  itinerary_last_processed_hash: null,
  content_fingerprint: "7315da98afbe115647d4b523d5608a91296625e4230139f82a44b50831550ec2",
  updated_at: "2026-07-26T06:47:04.063044+00:00"
};
assert(
  resolveEffectiveItineraryStatus({ document: stalledDoc, now }) === EFFECTIVE.PROCESSING_STALLED,
  "expired lock → processing_stalled"
);
const stalledView = buildItineraryStatusView({ document: stalledDoc, now });
assert(stalledView.label === "Processing stalled", "stalled label");
assert(stalledView.tone === "danger", "stalled red tone");
assert(stalledView.can_retry, "stalled can retry");
assert(/stalled/i.test(stalledView.action_message), "stalled action message");
assert(stalledView.label !== "Processing", "stalled never shows normal Processing");
assert(!isRawInternalStatusLabel(stalledView.label), "no raw internal label");

/* Exception kind awaiting_extraction_stale maps to Processing stalled */
const exView = buildItineraryStatusView({
  document: stalledDoc,
  exception: {
    exception_kind: "awaiting_extraction_stale",
    concise_reason: "awaiting extraction beyond expected processing period",
    validation_failures: [{ code: "awaiting_extraction_stale", message: "old message" }]
  },
  now
});
assert(exView.key === EFFECTIVE.PROCESSING_STALLED, "exception+doc → stalled");
assert(exView.label === "Processing stalled", "exception label plain English");

const pub = publicExceptionView(
  {
    id: "ex1",
    booking_id: "b1",
    booking_reference: "4118719",
    exception_kind: "awaiting_extraction_stale",
    status: "open",
    concise_reason: "stale",
    source_filename: stalledDoc.filename,
    source_document_id: stalledDoc.id,
    first_flagged_at: "2026-07-26T06:45:40.77+00:00",
    reason_codes: ["awaiting_extraction_stale"],
    validation_failures: []
  },
  { document: stalledDoc, itinerary: null }
);
assert(pub.effective_status_label === "Processing stalled", "public view label");
assert(pub.effective_status_tone === "danger", "public view danger");
assert(pub.can_retry === true, "public view can_retry");
assert(!String(pub.effective_status_label).includes("_"), "no snake_case in label");

/* Failed */
const failedView = buildItineraryStatusView({
  document: { itinerary_processing_status: "failed", filename: "x.pdf" },
  now
});
assert(failedView.label === "Failed", "failed label");
assert(failedView.tone === "danger", "failed danger");
assert(failedView.can_retry, "failed can retry");

/* Review required */
const reviewView = buildItineraryStatusView({
  document: { itinerary_processing_status: "review_required" },
  itinerary: { status: "review_required", processing_status: "review_required" },
  now
});
assert(reviewView.label === "Review required", "review label");
assert(reviewView.tone === "warning", "review amber");

/* Approved automatic vs manual */
assert(
  buildItineraryStatusView({
    itinerary: { status: "approved", approval_method: "automated", processing_status: "approved_automatically" },
    now
  }).label === "Approved automatically",
  "approved auto"
);
assert(
  buildItineraryStatusView({
    itinerary: { status: "approved", approval_method: "manual", processing_status: "approved_manually" },
    now
  }).label === "Approved manually",
  "approved manual"
);

/* Raw internals not displayed */
assert(formatItineraryStatusLabel("awaiting_extraction_stale") === "Processing stalled", "translate stale kind");
assert(formatItineraryStatusLabel("review_required") === "Review required", "translate review_required");
assert(isRawInternalStatusLabel("awaiting_extraction_stale"), "detects raw");
assert(!isRawInternalStatusLabel("Processing stalled"), "plain English ok");

/* Stale scan helper: active lock not stalled; expired lock is */
assert(
  !isDocumentProcessingStalled(
    {
      itinerary_processing_status: "processing",
      itinerary_process_lock_until: new Date(now + 60_000).toISOString()
    },
    now
  ),
  "scan: active lock not stalled"
);
assert(
  isDocumentProcessingStalled(
    {
      itinerary_processing_status: "processing",
      itinerary_process_lock_until: new Date(now - 60_000).toISOString()
    },
    now
  ),
  "scan: expired lock stalled"
);
assert(
  !isDocumentProcessingStalled(
    {
      itinerary_processing_status: "awaiting_extraction",
      updated_at: new Date(now - 60_000).toISOString(),
      uploaded_at: "2026-07-01T00:00:00Z"
    },
    now,
    15 * 60 * 1000
  ),
  "scan: recent awaiting not stalled despite old uploaded_at"
);

/* Retry cost messaging */
assert(stalledView.details.retry_will_call_openai === true, "no stored extract → OpenAI on retry");
assert(/OpenAI/i.test(stalledView.details.duplicate_cost_risk || ""), "cost risk explained");
const reuseView = buildItineraryStatusView({
  document: {
    ...stalledDoc,
    content_fingerprint: "same-hash"
  },
  itinerary: {
    status: "review_required",
    processing_status: "review_required",
    source_document_hash: "same-hash",
    itinerary_data: { stops: [{ port_name: "Barcelona" }] }
  },
  now
});
// Terminal review_required wins when itinerary present
assert(reuseView.key === EFFECTIVE.REVIEW_REQUIRED, "stored review itinerary wins over stalled doc");

/* Booking 4118719 diagnosis snapshot (read-only fixture; not mutated) */
const booking4118719 = {
  document: stalledDoc,
  itinerary: null,
  exception: {
    exception_kind: "awaiting_extraction_stale",
    status: "open",
    source_filename: stalledDoc.filename
  }
};
const liveDiag = buildItineraryStatusView({ ...booking4118719, now });
assert(liveDiag.key === EFFECTIVE.PROCESSING_STALLED, "4118719 diagnosed stalled");
assert(liveDiag.label === "Processing stalled", "4118719 label");
assert(liveDiag.details.has_itinerary_data === false, "4118719 no itinerary data");
assert(LOCK_TTL_MS === 5 * 60 * 1000, "lock ttl 5m");

/* Admin wiring */
const adminSrc = readFileSync(path.join(root, "js/admin.js"), "utf8");
const adminHtml = readFileSync(path.join(root, "admin.html"), "utf8");
assert(adminHtml.includes("itinerary-processing-status.js"), "admin loads shared resolver");
assert(adminSrc.includes("buildAdminItineraryStatusView"), "admin uses shared view builder");
assert(adminSrc.includes("retryItineraryExtraction"), "retry control present");
assert(adminSrc.includes("skip_itinerary_auto_process: true"), "viewing does not auto-extract");
assert(adminSrc.includes("itinerary-status-danger") || adminSrc.includes("itineraryStatusPillClass"), "tone classes used");
assert(adminSrc.includes("effective_status_label"), "queue prefers API effective_status_label");
assert(!adminSrc.includes('String(row.exception_kind || "").replaceAll("_", " ")'), "queue no longer shows raw exception_kind");

const css = readFileSync(path.join(root, "css/admin.css"), "utf8");
assert(css.includes("itinerary-status-danger"), "danger styles");
assert(css.includes("itinerary-status-action-danger"), "red action style");
assert(css.includes("itinerary-status-info"), "processing info style");

const adminItinerary = readFileSync(path.join(root, "netlify/functions/admin-itinerary.js"), "utf8");
assert(/action === ['"]retry_extraction['"]/.test(adminItinerary), "retry_extraction action");
assert(/exception_cleared:\s*false/.test(adminItinerary), "retry does not clear exception");
assert(/itinerary_process_lock_until:\s*null/.test(adminItinerary), "retry clears expired lock only");

console.log("test-itinerary-processing-status: ok");
console.log("  4118719 diagnosis: Processing stalled (expired lock, no itinerary row)");
console.log("  no live writes; no OpenAI calls");
