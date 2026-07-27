/**
 * Conflict-skip text itinerary extraction + completeness tests (offline).
 * Run: node scripts/test-text-itinerary-conflict-extract.mjs
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const { syncBookingDocuments } = require("../netlify/functions/document-sync.js");
const {
  processTextItinerary,
  normaliseTextItineraryStops
} = require("../netlify/functions/lib/text-itinerary-process.js");
const {
  assessTextItineraryCompleteness,
  resolveCruiseNights,
  INCOMPLETE_EXTRACTION_ERROR
} = require("../netlify/functions/lib/text-itinerary-completeness.js");
const { fingerprintBookingDocument } = require("../netlify/functions/lib/itinerary-document-hash.js");
const { legacyRowToTextResult } = require("../netlify/functions/lib/text-itinerary-store.js");
const {
  processBookingConfirmation,
  processConfirmationDocuments
} = require("../netlify/functions/lib/itinerary-auto-process.js");
const {
  normaliseBookingFinancials,
  formatFinancialUsd,
  buildFinancialDisplayRows
} = require("../js/booking-financials.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sixNightBooking = {
  base44_booking_id: "booking-cd5",
  booking_reference: "CD5Q25",
  departing_date: "2026-12-13",
  arriving_date: "2026-12-19",
  cruise_duration: 6
};

assert(resolveCruiseNights(sixNightBooking) === 6, "six nights from dates/duration");

const twoStopEmbarkDisembark = normaliseTextItineraryStops([
  {
    date: "2026-12-13",
    name: "Sydney",
    entry_type: "embarkation",
    arrival_time: null,
    departure_time: "16:00",
    notes: null,
    confidence: 1
  },
  {
    date: "2026-12-19",
    name: "Sydney",
    entry_type: "disembarkation",
    arrival_time: "07:00",
    departure_time: null,
    notes: null,
    confidence: 1
  }
]);

const incomplete = assessTextItineraryCompleteness(twoStopEmbarkDisembark, sixNightBooking);
assert(incomplete.complete === false, "two rows incomplete for six-night cruise");
assert(
  incomplete.reason === "incomplete_day_by_day_coverage",
  "incomplete reason for two-row result"
);

const completeStops = normaliseTextItineraryStops([
  {
    date: "2026-12-13",
    name: "Sydney",
    entry_type: "embarkation",
    arrival_time: null,
    departure_time: "16:00",
    notes: null,
    confidence: 1
  },
  {
    date: "2026-12-14",
    name: "At Sea",
    entry_type: "sea_day",
    arrival_time: null,
    departure_time: null,
    notes: null,
    confidence: 1
  },
  {
    date: "2026-12-15",
    name: "Hobart",
    entry_type: "port",
    arrival_time: "08:00",
    departure_time: "18:00",
    notes: null,
    confidence: 1
  },
  {
    date: "2026-12-16",
    name: "At Sea",
    entry_type: "sea_day",
    arrival_time: null,
    departure_time: null,
    notes: null,
    confidence: 1
  },
  {
    date: "2026-12-17",
    name: "Melbourne",
    entry_type: "port",
    arrival_time: "08:00",
    departure_time: "17:00",
    notes: null,
    confidence: 1
  },
  {
    date: "2026-12-18",
    name: "At Sea",
    entry_type: "sea_day",
    arrival_time: null,
    departure_time: null,
    notes: null,
    confidence: 1
  },
  {
    date: "2026-12-19",
    name: "Sydney",
    entry_type: "disembarkation",
    arrival_time: "07:00",
    departure_time: null,
    notes: null,
    confidence: 1
  }
]);

const complete = assessTextItineraryCompleteness(completeStops, sixNightBooking);
assert(complete.complete === true, "complete day-by-day itinerary accepted");
assert(completeStops.length >= 6, "complete itinerary has intermediate days");

/* Legacy two-stop cruise_itineraries must not count as usable text itinerary */
const legacyRejected = legacyRowToTextResult(
  {
    processing_status: "review_required",
    status: "review_required",
    source_document_hash: "abc",
    itinerary_data: {
      stops: [
        { date: "2026-12-13", name: "Sydney", entry_type: "embarkation" },
        { date: "2026-12-19", name: "Sydney", entry_type: "disembarkation" }
      ]
    }
  },
  sixNightBooking
);
assert(legacyRejected === null, "legacy two-stop row rejected");

/* Conflict-skipped Booking Confirmation still triggers text extraction */
const existingConfirmation = {
  id: "doc-existing-1",
  sync_key: "base44:doc-1",
  source_system: "base44",
  document_type: "Booking Confirmation",
  filename: "confirmation.pdf",
  file_url: "https://example.com/confirmation.pdf",
  updated_at: "2026-07-26T08:05:23.000Z",
  last_synced_at: "2026-07-26T08:04:46.000Z",
  note: "Admin note keep me",
  document_visible_to_customer: true
};

let documentUpserts = 0;
let processCalls = 0;
const processArgs = [];

const conflictRest = async (pathPart, options = {}) => {
  if (pathPart.includes("booking_documents?sync_key=") && (options.method || "GET") === "GET") {
    return [existingConfirmation];
  }
  if (pathPart.includes("booking_documents?on_conflict=sync_key") && options.method === "POST") {
    documentUpserts += 1;
    return [JSON.parse(options.body)];
  }
  return [];
};

const conflictSync = await syncBookingDocuments(
  conflictRest,
  {
    ...sixNightBooking,
    documents: [
      {
        id: "doc-1",
        document_type: "Booking Confirmation",
        filename: "confirmation.pdf",
        file_url: "https://example.com/confirmation.pdf",
        visible_to_client: true
      }
    ]
  },
  null,
  {
    processTextItinerary: async (args) => {
      processCalls += 1;
      processArgs.push(args);
      return { ok: true, skipped: false, reason: "extracted", extraction_calls: 1, stop_count: 7 };
    }
  }
);

assert(conflictSync.skipped_conflict === 1, "conflict counted");
assert(conflictSync.upserted === 0, "document not upserted during conflict");
assert(documentUpserts === 0, "document row not overwritten");
assert(processCalls === 1, "conflict Booking Confirmation triggers extraction");
assert(
  processArgs[0]?.document?.id === existingConfirmation.id,
  "uses existing stored document row"
);
assert(
  processArgs[0]?.document?.note === "Admin note keep me",
  "preserves admin-edited metadata on existing row"
);
assert(
  conflictSync.text_itinerary_process?.[0]?.reason === "extracted",
  "text itinerary process recorded"
);

/* Non-Booking-Confirmation conflicts do not trigger extraction */
processCalls = 0;
documentUpserts = 0;
const insuranceExisting = {
  ...existingConfirmation,
  id: "doc-insurance",
  sync_key: "base44:ins-1",
  document_type: "Travel Insurance",
  filename: "insurance.pdf",
  file_url: "https://example.com/insurance.pdf"
};

const insuranceRest = async (pathPart, options = {}) => {
  if (pathPart.includes("booking_documents?sync_key=") && (options.method || "GET") === "GET") {
    return [insuranceExisting];
  }
  if (pathPart.includes("booking_documents?on_conflict=sync_key") && options.method === "POST") {
    documentUpserts += 1;
    return [JSON.parse(options.body)];
  }
  return [];
};

const insuranceSync = await syncBookingDocuments(
  insuranceRest,
  {
    ...sixNightBooking,
    documents: [
      {
        id: "ins-1",
        document_type: "Travel Insurance",
        filename: "insurance.pdf",
        file_url: "https://example.com/insurance.pdf",
        visible_to_client: true
      }
    ]
  },
  null,
  {
    processTextItinerary: async () => {
      processCalls += 1;
      return { ok: true };
    }
  }
);

assert(insuranceSync.skipped_conflict === 1, "insurance conflict counted");
assert(processCalls === 0, "non-confirmation conflict does not extract");
assert(documentUpserts === 0, "insurance document not overwritten");
assert(
  (insuranceSync.text_itinerary_process || []).length === 0,
  "no text itinerary process for insurance"
);

/* Unchanged fingerprints do not call OpenAI again; ready itinerary prevents extraction */
let extractCalls = 0;
const readyDoc = {
  id: "doc-ready",
  document_type: "Booking Confirmation",
  file_url: "https://example.com/ready.pdf",
  filename: "ready.pdf"
};
const readyFingerprint = fingerprintBookingDocument(readyDoc);

const readyRest = async (pathPart, options = {}) => {
  if (pathPart.includes("booking_text_itineraries?booking_id=") && (options.method || "GET") === "GET") {
    return [
      {
        booking_id: "booking-cd5",
        document_fingerprint: readyFingerprint,
        extraction_status: "ready",
        itinerary_json: { stops: completeStops }
      }
    ];
  }
  if (pathPart.includes("on_conflict=booking_id")) {
    throw new Error("must not rewrite ready itinerary");
  }
  return [];
};

const skippedReady = await processTextItinerary({
  rest: readyRest,
  booking: sixNightBooking,
  document: readyDoc,
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl: async () => {
    extractCalls += 1;
    throw new Error("OpenAI must not be called");
  }
});

assert(skippedReady.skipped === true, "ready complete itinerary skipped");
assert(skippedReady.reason === "unchanged_fingerprint", "unchanged fingerprint reason");
assert(skippedReady.extraction_calls === 0, "zero extraction calls");
assert(extractCalls === 0, "OpenAI not called for ready fingerprint");

/* Incomplete OpenAI result fails calmly — no approval queue */
extractCalls = 0;
const failedPayloads = [];
const incompleteRest = async (pathPart, options = {}) => {
  if (pathPart.includes("booking_text_itineraries?booking_id=") && (options.method || "GET") === "GET") {
    return [];
  }
  if (pathPart.includes("on_conflict=booking_id") && options.method === "POST") {
    const body = JSON.parse(options.body);
    failedPayloads.push(body);
    return [body];
  }
  return [];
};

const incompleteExtract = await processTextItinerary({
  rest: incompleteRest,
  booking: sixNightBooking,
  document: {
    id: "doc-incomplete",
    document_type: "Booking Confirmation",
    file_url: "https://example.com/incomplete.pdf"
  },
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl: async () => {
    extractCalls += 1;
    return {
      itinerary: {
        cruise_line: "Carnival Cruise",
        ship: "Encounter",
        stops: [
          {
            date: "2026-12-13",
            name: "Sydney",
            entry_type: "embarkation",
            arrival_time: null,
            departure_time: "16:00",
            notes: null,
            confidence: 1
          },
          {
            date: "2026-12-19",
            name: "Sydney",
            entry_type: "disembarkation",
            arrival_time: "07:00",
            departure_time: null,
            notes: null,
            confidence: 1
          }
        ]
      },
      model: "gpt-test",
      usage: { input_tokens: 11, output_tokens: 22 }
    };
  }
});

assert(incompleteExtract.ok === false, "incomplete extract not ok");
assert(incompleteExtract.reason === "incomplete_itinerary", "incomplete reason");
assert(extractCalls === 1, "one extract attempt");
const finalFailed = failedPayloads[failedPayloads.length - 1];
assert(finalFailed.extraction_status === "failed", "persisted failed status");
assert(
  finalFailed.extraction_error === INCOMPLETE_EXTRACTION_ERROR,
  "calm internal extraction error"
);
assert(!/openai|stack|exception queue/i.test(finalFailed.extraction_error || ""), "no technical jargon");

/* No map processing / no approval queue */
const mapRetired = await processBookingConfirmation({
  rest: async () => {
    throw new Error("map rest must not be called");
  },
  booking: sixNightBooking,
  document: readyDoc,
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co"
});
assert(mapRetired.reason === "itinerary_map_feature_retired", "map processing remains retired");
assert(mapRetired.extraction_calls === 0, "map extraction calls zero");

const batchRetired = await processConfirmationDocuments({
  rest: async () => {
    throw new Error("map batch rest must not be called");
  },
  booking: sixNightBooking,
  documents: [readyDoc],
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co"
});
assert(
  Array.isArray(batchRetired) && batchRetired.every((r) => r.reason === "itinerary_map_feature_retired"),
  "batch map processing retired"
);

const docSyncSrc = readFileSync(path.join(root, "netlify/functions/document-sync.js"), "utf8");
assert(!/confirmation_candidates\.push/.test(docSyncSrc), "sync does not create approval queue");
assert(!/processBookingConfirmation|processConfirmationDocuments/.test(docSyncSrc), "sync never map-processes");
assert(/skipped_conflict/.test(docSyncSrc), "conflict path still present");
assert(/maybeProcessTextItinerary/.test(docSyncSrc), "conflict path can process text itinerary");

const customerSrc = readFileSync(path.join(root, "netlify/functions/customer-text-itinerary.js"), "utf8");
assert(/readTextItinerary/.test(customerSrc), "customer endpoint reads text itinerary");
assert(!/\bgeocode\b/i.test(customerSrc), "customer path has no geocoding");
assert(!/\bapproveItinerary\b|\bapproval_queue\b/i.test(customerSrc), "customer path has no approval queue");
assert(!/processBookingConfirmation|extractItineraryWithOpenAI/.test(customerSrc), "customer path does not extract maps");

const plannerSrc = readFileSync(path.join(root, "js/planner.js"), "utf8");
assert(
  plannerSrc.includes("Your detailed cruise itinerary is available in your Booking Confirmation"),
  "failed/incomplete falls back to Booking Confirmation copy"
);
assert(/customer-text-itinerary/.test(plannerSrc), "Your Journey loads text itinerary");

/* Financial output remains unchanged for CD5Q25 corrected fixture */
const financials = normaliseBookingFinancials({
  booking_reference: "CD5Q25",
  booking_status: "confirmed",
  cruise_price_usd: 1816.86,
  deposit_amount: 349.86,
  deposit_paid_date: "2026-07-25",
  payment_2_amount: 1467,
  payment_2_due_date: "2026-09-13",
  final_payment_due_date_normalised: "2026-09-13",
  amount_received: 349.86,
  balance_owing: 1467,
  payment_status: "partially_paid",
  cruise_deposit: 349.86,
  cruise_payment_2: 1467,
  amount_paid: 1816.86,
  final_payment_due_date: "2026-08-30",
  reminder_final_payment_due: "2026-08-30"
});
assert(financials.cruise_price_amount === 1816.86, "cruise price unchanged");
assert(financials.deposit_paid_amount === 349.86, "deposit paid unchanged");
assert(financials.balance_owing === 1467, "balance owing unchanged");
assert(financials.final_payment_due_date === "2026-09-13", "final payment due unchanged");
assert(
  financials.overall_payment_status_label === "Deposit paid — balance outstanding",
  "payment status label unchanged"
);
const moneyRows = buildFinancialDisplayRows(financials, {
  formatMoney: formatFinancialUsd,
  formatDate: (iso) => iso
});
const byKey = Object.fromEntries(moneyRows.map((row) => [row.key, row]));
assert(String(byKey.cruise_price?.value || "").includes("1,816.86"), "display cruise price");
assert(String(byKey.deposit_paid?.value || "").includes("349.86"), "display deposit");
assert(String(byKey.balance_owing?.value || "").includes("1,467.00"), "display balance");

console.log("test-text-itinerary-conflict-extract: ok");
