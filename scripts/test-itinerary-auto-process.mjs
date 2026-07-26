/**
 * Offline tests for exception-only itinerary auto-processing.
 * Does NOT call OpenAI, does NOT write to Supabase, does NOT alter live itineraries.
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
  fingerprintBookingDocument,
  isBookingConfirmationType
} = require("../netlify/functions/lib/itinerary-document-hash.js");
const {
  validateItineraryForAutoApproval,
  VALIDATION_VERSION
} = require("../netlify/functions/lib/itinerary-validation.js");
const {
  processBookingConfirmation,
  processConfirmationDocuments,
  revalidateStoredItinerary,
  PROCESSING,
  SYSTEM_APPROVER
} = require("../netlify/functions/lib/itinerary-auto-process.js");
const { buildPortIndex } = require("../netlify/functions/lib/customer-port-match.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const EXPLORA_PORTS = [
  {
    id: "p1",
    canonical_name: "Barcelona",
    display_name: "Barcelona",
    city: "Barcelona",
    aliases: [],
    latitude: 41.3584,
    longitude: 2.1686
  },
  {
    id: "p2",
    canonical_name: "Ibiza",
    display_name: "Ibiza",
    city: "Ibiza",
    aliases: [],
    latitude: 38.9067,
    longitude: 1.4206
  },
  {
    id: "p3",
    canonical_name: "La Goulette",
    display_name: "La Goulette",
    city: "La Goulette",
    aliases: ["Tunis/La Goulette", "Tunis (La Goulette)"],
    latitude: 36.8083788,
    longitude: 10.3088217
  },
  {
    id: "p4",
    canonical_name: "Valletta",
    display_name: "Valletta",
    city: "Valletta",
    aliases: ["La Valletta"],
    latitude: 35.8900644,
    longitude: 14.5079974
  },
  {
    id: "p5",
    canonical_name: "Giardini Naxos",
    display_name: "Giardini Naxos",
    city: "Giardini Naxos",
    aliases: ["Giardini-Naxos"],
    latitude: 37.8239012,
    longitude: 15.2718516
  },
  {
    id: "p6",
    canonical_name: "Sorrento",
    display_name: "Sorrento",
    city: "Sorrento",
    aliases: [],
    latitude: 40.6299147,
    longitude: 14.3768019
  },
  {
    id: "p7",
    canonical_name: "Civitavecchia",
    display_name: "Civitavecchia",
    city: "Civitavecchia",
    aliases: ["Civitavecchia (Rome)"],
    latitude: 42.093,
    longitude: 11.79
  }
];

const EXPLORA_SHIPS = [
  { id: "s1", name: "EXPLORA I", cruise_line_name: "Explora Journeys" }
];

const EXPLORA_BOOKING = {
  booking_reference: "10175811",
  base44_booking_id: "b44-10175811",
  cruise_line: "Explora Journeys",
  cruise_ship: "Explora 1",
  departing_date: "2026-09-28",
  arriving_date: "2026-10-05",
  departing_port: "Barcelona",
  arriving_port: "Civitavecchia"
};

const EXPLORA_ITINERARY = {
  cruise_line: "Explora Journeys",
  ship: "Explora 1",
  voyage_name: "Mediterranean",
  embarkation_date: "2026-09-28",
  disembarkation_date: "2026-10-05",
  confidence: 0.95,
  review_notes: [],
  stops: [
    {
      date: "2026-09-28",
      name: "Barcelona",
      entry_type: "embarkation",
      arrival_time: null,
      departure_time: "17:00",
      notes: null,
      confidence: 0.95
    },
    {
      date: "2026-09-29",
      name: "Ibiza",
      entry_type: "port",
      arrival_time: "08:00",
      departure_time: null,
      notes: null,
      confidence: 0.92
    },
    {
      date: "2026-09-30",
      name: "Ibiza",
      entry_type: "port",
      arrival_time: null,
      departure_time: "18:00",
      notes: "Overnight",
      confidence: 0.92
    },
    {
      date: "2026-10-01",
      name: "Tunis/La Goulette",
      entry_type: "port",
      arrival_time: "08:00",
      departure_time: "18:00",
      notes: null,
      confidence: 0.9
    },
    {
      date: "2026-10-02",
      name: "La Valletta",
      entry_type: "port",
      arrival_time: "08:00",
      departure_time: "18:00",
      notes: null,
      confidence: 0.9
    },
    {
      date: "2026-10-03",
      name: "Giardini Naxos",
      entry_type: "port",
      arrival_time: "08:00",
      departure_time: "18:00",
      notes: null,
      confidence: 0.88
    },
    {
      date: "2026-10-04",
      name: "Sorrento",
      entry_type: "port",
      arrival_time: "08:00",
      departure_time: "18:00",
      notes: null,
      confidence: 0.9
    },
    {
      date: "2026-10-05",
      name: "Civitavecchia (Rome)",
      entry_type: "disembarkation",
      arrival_time: "07:00",
      departure_time: null,
      notes: null,
      confidence: 0.95
    }
  ]
};

const portsIndex = buildPortIndex(EXPLORA_PORTS);

function makeRestStore(seed = {}) {
  const state = {
    cruise_itineraries: seed.itinerary ? [structuredClone(seed.itinerary)] : [],
    booking_documents: seed.documents ? seed.documents.map((d) => structuredClone(d)) : [],
    cruise_itinerary_versions: [],
    writes: 0
  };

  async function rest(path, options = {}) {
    state.writes += 1;
    const method = String(options.method || "GET").toUpperCase();
    if (path.startsWith("cruise_itineraries?") && method === "GET") {
      const m = path.match(/booking_id=eq\.([^&]+)/);
      const id = decodeURIComponent(m?.[1] || "");
      return state.cruise_itineraries.filter((r) => r.booking_id === id).slice(0, 1);
    }
    if (path.startsWith("cruise_itineraries?on_conflict") && method === "POST") {
      const payload = JSON.parse(options.body);
      const idx = state.cruise_itineraries.findIndex((r) => r.booking_id === payload.booking_id);
      if (idx >= 0) state.cruise_itineraries[idx] = { ...state.cruise_itineraries[idx], ...payload };
      else state.cruise_itineraries.push(payload);
      const row = state.cruise_itineraries.find((r) => r.booking_id === payload.booking_id);
      return [row];
    }
    if (path.startsWith("cruise_itineraries?booking_id=") && method === "PATCH") {
      const m = path.match(/booking_id=eq\.([^&]+)/);
      const id = decodeURIComponent(m?.[1] || "");
      const payload = JSON.parse(options.body);
      const idx = state.cruise_itineraries.findIndex((r) => r.booking_id === id);
      if (idx < 0) return [];
      state.cruise_itineraries[idx] = { ...state.cruise_itineraries[idx], ...payload };
      return [state.cruise_itineraries[idx]];
    }
    if (path.startsWith("booking_documents?") && method === "GET") {
      const m = path.match(/id=eq\.([^&]+)/);
      const id = decodeURIComponent(m?.[1] || "");
      return state.booking_documents.filter((r) => String(r.id) === id).slice(0, 1);
    }
    if (path.startsWith("booking_documents?") && method === "PATCH") {
      const m = path.match(/id=eq\.([^&]+)/);
      const id = decodeURIComponent(m?.[1] || "");
      const payload = JSON.parse(options.body);
      const idx = state.booking_documents.findIndex((r) => String(r.id) === id);
      if (idx < 0) return [];
      state.booking_documents[idx] = { ...state.booking_documents[idx], ...payload };
      return [state.booking_documents[idx]];
    }
    if (path.startsWith("cruise_itinerary_versions") && method === "POST") {
      const payload = JSON.parse(options.body);
      state.cruise_itinerary_versions.push(payload);
      return [payload];
    }
    if (path.startsWith("ci_cruise_ships") || path.startsWith("ports?")) return [];
    return [];
  }

  return { rest, state };
}

/* --- Fingerprints / confirmation type --- */
const docA = {
  id: "doc-1",
  document_type: "Booking Confirmation",
  filename: "conf.pdf",
  file_url: "https://example.com/a.pdf",
  uploaded_at: "2026-07-01T00:00:00Z"
};
const docA2 = { ...docA };
const docChanged = { ...docA, file_url: "https://example.com/b.pdf" };
assert(isBookingConfirmationType(docA.document_type), "confirmation type");
assert(!isBookingConfirmationType("Travel Insurance"), "non confirmation");
assert(fingerprintBookingDocument(docA) === fingerprintBookingDocument(docA2), "stable hash");
assert(fingerprintBookingDocument(docA) !== fingerprintBookingDocument(docChanged), "changed doc new hash");

/* --- Validation: 10175811 fixture passes --- */
const valid = validateItineraryForAutoApproval({
  itinerary: EXPLORA_ITINERARY,
  booking: EXPLORA_BOOKING,
  ships: EXPLORA_SHIPS,
  portsIndex
});
assert(valid.ok === true, "10175811 fixture auto-approves");
assert(valid.diagnostics.unique_plotted_ports === 7, "seven unique plotted ports");
assert(valid.validation_version === VALIDATION_VERSION, "validation version set");

/* Overnight Ibiza retained in stops, collapsed for plotting */
assert(EXPLORA_ITINERARY.stops.filter((s) => /ibiza/i.test(s.name)).length === 2, "overnight rows retained");

/* Sea day without coords passes */
const withSea = structuredClone(EXPLORA_ITINERARY);
withSea.stops.splice(3, 0, {
  date: "2026-10-01",
  name: "At Sea",
  entry_type: "sea_day",
  arrival_time: null,
  departure_time: null,
  notes: null,
  confidence: 0.99
});
// Adjust following dates would break chronology — instead insert sea between embark and ibiza with date 09-29 morning is wrong.
// Use a dedicated mini itinerary:
const seaItin = {
  cruise_line: "Explora Journeys",
  ship: "EXPLORA I",
  embarkation_date: "2026-09-28",
  disembarkation_date: "2026-10-01",
  confidence: 0.95,
  review_notes: [],
  stops: [
    {
      date: "2026-09-28",
      name: "Barcelona",
      entry_type: "embarkation",
      arrival_time: null,
      departure_time: "17:00",
      notes: null,
      confidence: 0.95
    },
    {
      date: "2026-09-29",
      name: "At Sea",
      entry_type: "sea_day",
      arrival_time: null,
      departure_time: null,
      notes: null,
      confidence: 0.99
    },
    {
      date: "2026-10-01",
      name: "Civitavecchia (Rome)",
      entry_type: "disembarkation",
      arrival_time: "07:00",
      departure_time: null,
      notes: null,
      confidence: 0.95
    }
  ]
};
const seaBooking = {
  ...EXPLORA_BOOKING,
  departing_date: "2026-09-28",
  arriving_date: "2026-10-01"
};
assert(
  validateItineraryForAutoApproval({
    itinerary: seaItin,
    booking: seaBooking,
    ships: EXPLORA_SHIPS,
    portsIndex
  }).ok,
  "sea days pass without coordinates"
);

/* Unresolved port blocks */
const unresolved = structuredClone(EXPLORA_ITINERARY);
unresolved.stops[3].name = "Unknown Harbour XYZ";
const badPort = validateItineraryForAutoApproval({
  itinerary: unresolved,
  booking: EXPLORA_BOOKING,
  ships: EXPLORA_SHIPS,
  portsIndex
});
assert(!badPort.ok, "unresolved port blocks");
assert(badPort.failures.some((f) => f.code === "unresolved_port"), "unresolved_port code");
assert(/unresolved port/i.test(badPort.summary), "concise unresolved summary");

/* Ambiguous ship blocks */
const ambShip = validateItineraryForAutoApproval({
  itinerary: { ...EXPLORA_ITINERARY, ship: "Mystery Yacht" },
  booking: EXPLORA_BOOKING,
  ships: EXPLORA_SHIPS,
  portsIndex
});
assert(!ambShip.ok, "unknown ship blocks");
assert(ambShip.failures.some((f) => f.code === "ship_not_found" || f.code === "ambiguous_ship"), "ship failure code");

/* Date mismatch blocks */
const badDates = validateItineraryForAutoApproval({
  itinerary: { ...EXPLORA_ITINERARY, embarkation_date: "2026-09-01" },
  booking: EXPLORA_BOOKING,
  ships: EXPLORA_SHIPS,
  portsIndex
});
assert(!badDates.ok, "date mismatch blocks");
assert(badDates.failures.some((f) => f.code === "embarkation_date_mismatch"), "embark mismatch code");
assert(/dates conflict/i.test(badDates.summary), "dates conflict summary");

/* Low confidence blocks */
const lowConf = validateItineraryForAutoApproval({
  itinerary: { ...EXPLORA_ITINERARY, confidence: 0.7 },
  booking: EXPLORA_BOOKING,
  ships: EXPLORA_SHIPS,
  portsIndex
});
assert(!lowConf.ok, "low overall confidence blocks");
assert(lowConf.failures.some((f) => f.code === "overall_confidence_low"), "confidence code");

/* --- Process pipeline with mocked extract --- */
let extractCalls = 0;
const extractImpl = async () => {
  extractCalls += 1;
  return {
    itinerary: EXPLORA_ITINERARY,
    model: "test-model",
    usage: { input_tokens: 100, output_tokens: 50 },
    estimated_cost_usd: 0.001
  };
};

const store1 = makeRestStore({
  documents: [{ ...docA, itinerary_processing_status: null, itinerary_last_processed_hash: null }]
});
const first = await processBookingConfirmation({
  rest: store1.rest,
  booking: EXPLORA_BOOKING,
  document: docA,
  ships: EXPLORA_SHIPS,
  portsIndex,
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl
});
assert(first.ok && first.auto_approved, "valid itinerary auto-approves");
assert(extractCalls === 1, "one extraction call");
assert(first.itinerary.status === "approved", "status approved");
assert(first.itinerary.approval_method === "automated", "approval_method automated");
assert(first.itinerary.approved_by === null, "system auto-approve uses null approved_by (uuid column)");
assert(first.itinerary.extracted_by === null, "system extract uses null extracted_by (uuid column)");
assert(SYSTEM_APPROVER === "system:itinerary-auto-approve", "text system actor label retained for text audit fields");
assert(first.itinerary.validation_version === VALIDATION_VERSION, "validation version stored");
assert(first.itinerary.source_document_hash, "source hash stored");
assert(first.itinerary.processing_status === PROCESSING.APPROVED_AUTO, "processing status auto");

/* Unchanged document does not extract again */
const second = await processBookingConfirmation({
  rest: store1.rest,
  booking: EXPLORA_BOOKING,
  document: docA,
  ships: EXPLORA_SHIPS,
  portsIndex,
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl
});
assert(second.skipped === true, "unchanged skipped");
assert(extractCalls === 1, "no second OpenAI call");

/* Changed document creates new processing version */
extractCalls = 0;
const store2 = makeRestStore({
  itinerary: first.itinerary,
  documents: [{ ...docChanged, id: "doc-2" }]
});
const replacementExtract = async () => {
  extractCalls += 1;
  return {
    itinerary: EXPLORA_ITINERARY,
    model: "test-model",
    usage: null,
    estimated_cost_usd: null
  };
};
const changed = await processBookingConfirmation({
  rest: store2.rest,
  booking: EXPLORA_BOOKING,
  document: docChanged,
  ships: EXPLORA_SHIPS,
  portsIndex,
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl: replacementExtract
});
assert(extractCalls === 1, "changed doc extracts once");
assert(changed.auto_approved === true, "replacement auto-approves when valid");
assert(store2.state.cruise_itinerary_versions.length === 1, "prior itinerary archived");

/* Unresolved prevents auto-approval */
extractCalls = 0;
const store3 = makeRestStore({ documents: [{ ...docA, id: "doc-3" }] });
const badExtract = async () => {
  extractCalls += 1;
  return { itinerary: unresolved, model: "test-model", usage: null, estimated_cost_usd: null };
};
const blocked = await processBookingConfirmation({
  rest: store3.rest,
  booking: EXPLORA_BOOKING,
  document: { ...docA, id: "doc-3" },
  ships: EXPLORA_SHIPS,
  portsIndex,
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl: badExtract
});
assert(blocked.auto_approved === false, "unresolved not auto-approved");
assert(blocked.itinerary.status === "review_required", "review_required saved");
assert(blocked.validation.failures.some((f) => f.code === "unresolved_port"), "failure recorded");

/* Revalidation uses stored JSON — no OpenAI */
extractCalls = 0;
// Fix ports by swapping itinerary_data to valid via rest state, then revalidate
store3.state.cruise_itineraries[0].itinerary_data = EXPLORA_ITINERARY;
const reval = await revalidateStoredItinerary({
  rest: store3.rest,
  booking: EXPLORA_BOOKING,
  document: { ...docA, id: "doc-3" },
  ships: EXPLORA_SHIPS,
  portsIndex,
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl: badExtract
});
assert(extractCalls === 0, "revalidate makes zero OpenAI calls");
assert(reval.auto_approved === true, "alias/port fix path can approve on revalidate");
assert(reval.from_stored_extraction === true, "from stored extraction");

/* Concurrent trigger remains idempotent */
extractCalls = 0;
const store4 = makeRestStore({
  documents: [
    {
      ...docA,
      id: "doc-4",
      itinerary_processing_status: "processing",
      itinerary_process_lock_until: new Date(Date.now() + 60000).toISOString()
    }
  ]
});
const locked = await processBookingConfirmation({
  rest: store4.rest,
  booking: EXPLORA_BOOKING,
  document: { ...docA, id: "doc-4" },
  ships: EXPLORA_SHIPS,
  portsIndex,
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl
});
assert(locked.skipped === true, "locked concurrent process skipped");
assert(extractCalls === 0, "locked path no extract");

/* Batch helper */
extractCalls = 0;
const store5 = makeRestStore({ documents: [{ ...docA, id: "doc-5" }] });
const batch = await processConfirmationDocuments({
  rest: store5.rest,
  booking: EXPLORA_BOOKING,
  documents: [
    { ...docA, id: "doc-5" },
    { id: "x", document_type: "Travel Insurance", file_url: "https://example.com/x.pdf" }
  ],
  ships: EXPLORA_SHIPS,
  portsIndex,
  supabaseUrl: "https://xikbibxyinttllxamgao.supabase.co",
  extractImpl
});
assert(batch.length === 1, "only confirmations processed");
assert(extractCalls === 1, "batch one extract");

/* DEV URL refused */
let refused = false;
try {
  await processBookingConfirmation({
    rest: store5.rest,
    booking: EXPLORA_BOOKING,
    document: docA,
    ships: EXPLORA_SHIPS,
    portsIndex,
    supabaseUrl: "https://vkheexbapykcdfbqcach.supabase.co",
    extractImpl
  });
} catch (error) {
  refused = /DEV/i.test(error.message);
}
assert(refused, "DEV writes refused");

/* Customer page load never extracts — source checks */
const customerAccess = readFileSync(path.join(root, "netlify/functions/customer-access.js"), "utf8");
assert(!/processConfirmationDocuments|processBookingConfirmation|extractItineraryWithOpenAI/.test(customerAccess), "customer-access has no extract");
assert(/never extract/i.test(customerAccess), "customer-access documents no-extract intent");

const getBooking = readFileSync(path.join(root, "netlify/functions/get-booking.js"), "utf8");
assert(/processConfirmationDocuments/.test(getBooking), "admin get-booking triggers auto-process");
assert(/skip_itinerary_auto_process/.test(getBooking), "admin can skip auto-process");

const adminItinerary = readFileSync(path.join(root, "netlify/functions/admin-itinerary.js"), "utf8");
assert(/processBookingConfirmation/.test(adminItinerary), "admin extract uses shared processor");
assert(/action === 'revalidate'/.test(adminItinerary), "revalidate action available");
assert(/approval_method/.test(adminItinerary) && /manual/.test(adminItinerary), "manual approval remains");

const adminSrc = readFileSync(path.join(root, "js/admin.js"), "utf8");
assert(/Approved automatically|approved_automatically/.test(adminSrc), "UI shows auto-approved state");
assert(/Review required|review_required/.test(adminSrc), "UI shows review required");
assert(/revalidateBookingItinerary/.test(adminSrc), "UI revalidate control");
assert(/renderItineraryValidationFailures/.test(adminSrc), "UI shows validation failures");
assert(/Approve itinerary/.test(adminSrc), "manual approve retained");
assert(/Extract itinerary/.test(adminSrc), "manual extract retained");

const migration = readFileSync(
  path.join(root, "supabase/migrations/20260726_itinerary_auto_processing.sql"),
  "utf8"
);
assert(/source_document_hash/.test(migration), "migration adds source hash");
assert(/cruise_itinerary_versions/.test(migration), "migration adds version history");
assert(/approval_method/.test(migration), "migration adds approval_method");
assert(!/au\.user_id/.test(migration), "migration must not use au.user_id");
assert(/au\.auth_user_id\s*=\s*auth\.uid\(\)/.test(migration), "migration RLS uses auth_user_id");
assert(/au\.active\s*=\s*true/.test(migration), "migration RLS uses active");

/* No paid map / no second extract implementation */
const extractLib = readFileSync(path.join(root, "netlify/functions/lib/itinerary-extract.js"), "utf8");
assert(/extractItineraryWithOpenAI/.test(extractLib), "single extract helper");
assert(!/mapbox|google maps/i.test(extractLib), "no mapping APIs in extract");

console.log("test-itinerary-auto-process: ok");
