/**
 * Text-only itinerary extraction tests (offline, no OpenAI).
 * Run: node scripts/test-text-itinerary.mjs
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);

const {
  processTextItinerary,
  normaliseTextItineraryStops,
  formatTextItineraryTime,
  formatTextItineraryStopLabel
} = require("../netlify/functions/lib/text-itinerary-process.js");
const { fingerprintBookingDocument } = require("../netlify/functions/lib/itinerary-document-hash.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* normaliseTextItineraryStops */
const normalised = normaliseTextItineraryStops([
  {
    date: "2026-03-10",
    name: "Southampton",
    entry_type: "embarkation",
    arrival_time: null,
    departure_time: "16:30",
    notes: null,
    confidence: 1
  },
  {
    date: "2026-03-11",
    name: "At Sea",
    entry_type: "sea_day",
    arrival_time: null,
    departure_time: null,
    notes: null,
    confidence: 1
  },
  {
    date: "2026-03-12",
    name: "Barcelona",
    entry_type: "port",
    arrival_time: "08:00",
    departure_time: null,
    notes: "Overnight in port",
    confidence: 0.9
  },
  {
    date: "2026-03-13",
    name: "Barcelona",
    entry_type: "port",
    arrival_time: null,
    departure_time: "18:00",
    notes: null,
    confidence: 0.9
  }
]);

assert(normalised.length === 4, "four stops");
assert(normalised[0].day === 1 && normalised[3].day === 4, "sequential day numbers");
assert(normalised[0].port_name === "Southampton", "preserves source port name");
assert(normalised[0].is_embarkation === true, "embarkation flag");
assert(normalised[1].is_sea_day === true, "At sea flagged");
assert(normalised[2].overnight === true, "overnight from notes");
assert(normalised[0].arrival_time === null && normalised[0].departure_time === "16:30", "optional times kept");

/* no coordinates on normalised stops */
for (const stop of normalised) {
  assert(!("lat" in stop) && !("lng" in stop) && !("latitude" in stop), "no coordinates");
}

/* shared-date overnight */
const sharedDate = normaliseTextItineraryStops([
  {
    date: "2026-04-01",
    name: "Valletta",
    entry_type: "port",
    arrival_time: "07:00",
    departure_time: null,
    notes: null,
    confidence: 1
  },
  {
    date: "2026-04-01",
    name: "Valletta",
    entry_type: "port",
    arrival_time: null,
    departure_time: "17:00",
    notes: null,
    confidence: 1
  }
]);
assert(sharedDate[0].overnight === true, "shared date implies overnight");

/* format helpers */
assert(formatTextItineraryTime("8:00") === "08:00", "time padded");
assert(formatTextItineraryStopLabel(normalised[1]).includes("At sea"), "sea day label");
assert(formatTextItineraryStopLabel(normalised[2]).includes("Barcelona"), "port label");

/* unchanged fingerprint skips OpenAI */
let extractCalls = 0;
const unchangedDoc = {
  id: "doc-1",
  document_type: "Booking Confirmation",
  file_url: "https://example.com/a.pdf",
  filename: "a.pdf"
};
const unchangedFingerprint = fingerprintBookingDocument(unchangedDoc);

const mockRest = async (pathPart, options = {}) => {
  if (pathPart.includes("booking_text_itineraries?booking_id=") && (options.method || "GET") === "GET") {
    return [
      {
        booking_id: "booking-abc",
        document_fingerprint: unchangedFingerprint,
        extraction_status: "ready",
        itinerary_json: {
          stops: [
            { day: 1, date: "2026-01-01", port_name: "Rome", is_sea_day: false },
            { day: 2, date: "2026-01-02", port_name: "At sea", is_sea_day: true },
            { day: 3, date: "2026-01-03", port_name: "Naples", is_sea_day: false }
          ]
        }
      }
    ];
  }
  if (pathPart.includes("on_conflict=booking_id")) {
    return [{ booking_id: "booking-abc" }];
  }
  return [];
};

const skipped = await processTextItinerary({
  rest: mockRest,
  booking: { base44_booking_id: "booking-abc", booking_reference: "REF1" },
  document: unchangedDoc,
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl: async () => {
    extractCalls += 1;
    throw new Error("OpenAI must not be called");
  }
});

assert(skipped.skipped === true, "skipped unchanged");
assert(skipped.reason === "unchanged_fingerprint", "unchanged reason");
assert(skipped.extraction_calls === 0, "zero extraction calls on skip");
assert(extractCalls === 0, "extractImpl not invoked");

/* failed extraction returns failed without throwing */
extractCalls = 0;
let upsertPayload = null;
const failRest = async (pathPart, options = {}) => {
  if (pathPart.includes("booking_text_itineraries?booking_id=") && (options.method || "GET") === "GET") {
    return [];
  }
  if (pathPart.includes("on_conflict=booking_id") && options.method === "POST") {
    upsertPayload = JSON.parse(options.body);
    return [upsertPayload];
  }
  return [];
};

const failed = await processTextItinerary({
  rest: failRest,
  booking: { base44_booking_id: "booking-fail", booking_reference: "FAIL1" },
  document: {
    id: "doc-2",
    document_type: "Booking Confirmation",
    file_url: "https://example.com/b.pdf"
  },
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl: async () => {
    extractCalls += 1;
    throw new Error("OpenAI quota exceeded");
  }
});

assert(failed.ok === false, "failed ok false");
assert(failed.reason === "extraction_failed", "failed reason");
assert(failed.extraction_calls === 1, "failed still counts extraction call");
assert(extractCalls === 1, "extract attempted once");
assert(upsertPayload?.extraction_status === "failed", "persisted failed status");
assert(/quota exceeded/i.test(upsertPayload?.extraction_error || ""), "stored error message");

/* successful extraction path */
const successRest = async (pathPart, options = {}) => {
  if (pathPart.includes("booking_text_itineraries?booking_id=") && (options.method || "GET") === "GET") {
    return [];
  }
  if (pathPart.includes("on_conflict=booking_id") && options.method === "POST") {
    return [JSON.parse(options.body)];
  }
  return [];
};

const success = await processTextItinerary({
  rest: successRest,
  booking: { base44_booking_id: "booking-ok", booking_reference: "OK1" },
  document: {
    id: "doc-3",
    document_type: "Booking Confirmation",
    file_url: "https://example.com/c.pdf"
  },
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl: async () => ({
    itinerary: {
      cruise_line: "Test Line",
      ship: "Test Ship",
      stops: [
        {
          date: "2026-05-01",
          name: "Miami",
          entry_type: "embarkation",
          arrival_time: null,
          departure_time: "17:00",
          notes: null,
          confidence: 1
        }
      ]
    },
    model: "gpt-test",
    usage: { input_tokens: 10, output_tokens: 20 }
  })
});

assert(success.ok === true, "success ok");
assert(success.reason === "extracted", "extracted reason");
assert(success.stop_count === 1, "one stop stored");
assert(success.itinerary.stops[0].port_name === "Miami", "normalised stop in result");

/* non-confirmation skipped */
const notConfirmation = await processTextItinerary({
  rest: async () => {
    throw new Error("rest must not be called");
  },
  booking: { base44_booking_id: "x" },
  document: { document_type: "Travel Insurance", file_url: "https://example.com/x.pdf" },
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co"
});
assert(notConfirmation.skipped === true, "non-confirmation skipped");
assert(notConfirmation.reason === "not_booking_confirmation", "not confirmation reason");

console.log("test-text-itinerary: ok");
