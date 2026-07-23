/**
 * Offline checks for Sprint 13D structured itinerary + Ports matching.
 * Run: node scripts/test-featured-cruise-itinerary.mjs
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sandbox = {
  console,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  Intl,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Math,
  JSON,
  RegExp,
  Error,
  module: { exports: {} },
  exports: {}
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const context = vm.createContext(sandbox);

function load(rel) {
  const code = readFileSync(path.join(root, rel), "utf8");
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInContext(code, context, { filename: rel });
}

load("js/featured-cruise-itinerary.js");
load("js/newsletter-typography.js");
load("js/newsletter-cruise-shared.js");
load("js/newsletter-preview.js");
load("js/newsletter-mailchimp-export.js");

const I = sandbox.FeaturedCruiseItinerary;
const Preview = sandbox.NewsletterPreview;
const Export = sandbox.NewsletterMailchimpExport;

assert(I, "FeaturedCruiseItinerary loaded");

/* ── Normalisation ─────────────────────────────────────────────────────── */

assert(I.normalizePortText("  Piraeus  ") === "piraeus", "trim/lower");
assert(I.normalizePortText("Piraeus!!!") === "piraeus", "punctuation");
assert(I.normalizePortText("Piraeus   (Athens)") === "piraeus (athens)", "spaces + brackets");
assert(I.normalizePortText("São") !== "São", "accents stripped to ascii-ish");
assert(I.normalizePortText("São Tomé").includes("sao"), "accented name normalised");
assert(I.buildMatchKey("Barcelona", "Spain") === "barcelona|spain", "match key");
assert(I.buildMatchKey("Barcelona", " spain ") === "barcelona|spain", "country whitespace");

const parsed = I.parseEnteredPortParts("Athens (Piraeus), Greece");
assert(parsed.nameCore === "Athens", "bracket outer");
assert(parsed.bracketInner === "Piraeus", "bracket inner");
assert(parsed.countryText === "Greece", "country suffix");

/* ── Matching catalogue ────────────────────────────────────────────────── */

const catalogue = [
  {
    id: "p1",
    canonical_name: "Barcelona",
    display_name: "Barcelona, Spain",
    city: "Barcelona",
    country: "Spain",
    aliases: [],
    status: "verified",
    match_key: "barcelona|spain",
    latitude: 41.38,
    longitude: 2.17
  },
  {
    id: "p2",
    canonical_name: "Piraeus",
    display_name: "Piraeus (Athens), Greece",
    city: "Piraeus",
    country: "Greece",
    aliases: ["Athens", "Athens (Piraeus)", "Piraeus Athens"],
    status: "verified",
    match_key: "piraeus|greece",
    latitude: 37.94,
    longitude: 23.64
  },
  {
    id: "p3",
    canonical_name: "Paris",
    display_name: "Paris, France",
    city: "Paris",
    country: "France",
    aliases: [],
    status: "verified",
    match_key: "paris|france",
    latitude: 48.85,
    longitude: 2.35
  },
  {
    id: "p4",
    canonical_name: "Paris",
    display_name: "Paris, Texas",
    city: "Paris",
    country: "United States",
    aliases: [],
    status: "verified",
    match_key: "paris|united states",
    latitude: 33.66,
    longitude: -95.55
  }
];

const exact = I.classifyPortMatches("Barcelona, Spain", "Spain", catalogue);
assert(exact.status === "strong", "exact canonical+country strong");
assert(exact.primary?.id === "p1", "exact primary Barcelona");

const alias = I.classifyPortMatches("Athens (Piraeus), Greece", "Greece", catalogue);
assert(alias.status === "strong" || alias.status === "likely", "alias/bracket match");
assert(alias.primary?.id === "p2", "alias resolves to Piraeus");

const sameName = I.classifyPortMatches("Paris", "", catalogue);
assert(sameName.status === "ambiguous", "same name different countries → ambiguous");
assert(sameName.matches.length >= 2, "both Paris records surfaced");

const none = I.classifyPortMatches("Zzyzx Lagoon", "Atlantis", catalogue);
assert(none.status === "none", "no match");

const search = I.searchPorts("pira", catalogue);
assert(search.length === 1 && search[0].id === "p2", "autocomplete collapses to one Piraeus");
assert(!search.some((p) => p.id !== "p2" && /athens/i.test(p.canonical_name)), "aliases not separate ports");

/* ── Itinerary helpers ─────────────────────────────────────────────────── */

const legacy = I.parseLegacyItinerarySummary(
  "Barcelona, Spain | At Sea | Palermo, Italy | Piraeus (Athens), Greece"
);
assert(legacy.reliable, "legacy parse reliable");
assert(legacy.stops.length === 4, "legacy 4 stops");
assert(legacy.stops[1].stop_type === "at_sea", "At Sea detected");
assert(legacy.stops[0].entered_port_text.includes("Barcelona"), "display wording preserved");

const pasted = I.buildStopsFromPortList(
  "Barcelona, Spain | Palma de Mallorca, Spain | Lisbon, Portugal"
);
assert(pasted.portCount === 3, "paste list counts 3 ports");
assert(pasted.stops[0].stop_type === "embarkation", "first paste stop is embarkation");
assert(pasted.stops[1].stop_type === "port_call", "middle paste stop is port call");
assert(pasted.stops[2].stop_type === "disembarkation", "last paste stop is disembarkation");
assert(pasted.stops[0].entered_country_text === "Spain", "country parsed from paste");
assert(
  pasted.stops.every((s) => s.day_number === "" || s.day_number == null),
  "paste does not invent sailing day numbers"
);

const knownSparse = I.applyKnownDayNumbers(pasted.stops, 7, { forceClearMiddle: true });
assert(knownSparse[0].day_number === 1, "embark is Day 1");
assert(knownSparse[1].day_number === "" || knownSparse[1].day_number == null, "middle day blank when sea days possible");
assert(knownSparse[2].day_number === 8, "disembark is nights+1");

const packedList = I.buildStopsFromPortList(
  "A, Spain | B, Spain | C, Spain | D, Spain | E, Spain | F, Spain | G, Spain | H, Spain"
);
const knownPacked = I.applyKnownDayNumbers(packedList.stops, 7, { forceClearMiddle: true });
assert(knownPacked.length === 8, "8 ports for 7-night packed cruise");
assert(
  knownPacked.every((s, i) => Number(s.day_number) === i + 1),
  "full-packed itinerary gets sequential days when ports === nights+1"
);

const invented = I.applyKnownDayNumbers(
  [
    I.blankStop(1, { stop_type: "embarkation", day_number: 1, entered_port_text: "A, Spain" }),
    I.blankStop(2, { stop_type: "port_call", day_number: 2, entered_port_text: "B, Spain" }),
    I.blankStop(3, { stop_type: "disembarkation", day_number: 3, entered_port_text: "C, Spain" })
  ],
  7,
  { forceClearMiddle: false }
);
assert(invented[1].day_number === "" || invented[1].day_number == null, "clears day===stop-order inventions");
assert(invented[2].day_number === 8, "reconcile sets disembark to nights+1");

const ordered = I.normalizeStopOrder([
  I.blankStop(9, { entered_port_text: "A", stop_type: "port_call" }),
  I.blankStop(2, { entered_port_text: "B", stop_type: "port_call" })
]);
assert(ordered[0].display_order === 1 && ordered[1].display_order === 2, "order normalised 1..n");

const withSea = [
  I.blankStop(1, {
    stop_type: "embarkation",
    port_id: "p1",
    port: catalogue[0],
    entered_port_text: "Barcelona, Spain"
  }),
  I.blankStop(2, { stop_type: "at_sea", notes: "Rest day" }),
  I.blankStop(3, {
    stop_type: "port_call",
    port_id: "p2",
    port: catalogue[1],
    entered_port_text: "Piraeus (Athens), Greece"
  })
];

const joined = I.buildPortsJoinedFromStops(withSea);
assert(joined.includes("Barcelona"), "ports joined includes embarkation");
assert(!/At Sea/i.test(joined), "At Sea excluded from ports joined");
assert(joined.includes("Piraeus (Athens), Greece"), "display wording kept");

const sig1 = I.buildRouteSignature(withSea);
const sigSeaNote = I.buildRouteSignature([
  withSea[0],
  { ...withSea[1], notes: "Different note" },
  withSea[2]
]);
assert(sig1 === sigSeaNote, "At Sea note change does not change signature");

const sigTime = I.buildRouteSignature([
  { ...withSea[0], arrival_time: "08:00" },
  withSea[1],
  { ...withSea[2], departure_time: "17:00" }
]);
assert(sig1 === sigTime, "time change does not change signature");

const reordered = [withSea[0], withSea[2], withSea[1]];
const sig2 = I.buildRouteSignature(I.normalizeStopOrder(reordered));
assert(sig1 !== sig2, "port order change changes signature");

const replaced = [
  withSea[0],
  withSea[1],
  { ...withSea[2], port_id: "p3", port: catalogue[2], entered_port_text: "Paris, France" }
];
assert(I.buildRouteSignature(withSea) !== I.buildRouteSignature(replaced), "port replacement changes signature");

const statusStale = I.nextRouteMapStatus({
  previousStatus: "manual",
  previousSignature: sig1,
  nextSignature: sig2,
  hasMap: true
});
assert(statusStale === "needs_regeneration", "order change → needs_regeneration");

const statusKeepMap = I.nextRouteMapStatus({
  previousStatus: "needs_regeneration",
  previousSignature: sig2,
  nextSignature: sig2,
  hasMap: true
});
assert(statusKeepMap === "needs_regeneration", "stale retained until regenerated");

const statusMissing = I.nextRouteMapStatus({
  previousStatus: "manual",
  previousSignature: sig1,
  nextSignature: sig1,
  hasMap: false
});
assert(statusMissing === "missing", "no map → missing");

const atSeaRows = I.stopsToDbRows(
  [I.blankStop(1, { stop_type: "at_sea", entered_port_text: "should clear", port_id: "p1" })],
  "cruise-1"
);
assert(atSeaRows[0].port_id == null, "At Sea clears port_id");
assert(atSeaRows[0].entered_port_text == null, "At Sea clears port text");

const provisional = I.provisionalPortPayload({
  enteredPortText: "Bozcaada, Turkey",
  enteredCountryText: "Turkey",
  featuredCruiseId: "c1"
});
assert(provisional.status === "provisional", "provisional status");
assert(provisional.match_key === "bozcaada|turkey", "provisional match key");
assert(provisional.source === "featured_cruise_itinerary", "source context");

const multiDay = [
  I.blankStop(1, { day_number: 3, stop_type: "port_call", entered_port_text: "A, Spain", port_id: "p1", port: catalogue[0] }),
  I.blankStop(2, { day_number: 3, stop_type: "port_call", entered_port_text: "B, Spain", entered_country_text: "Spain" })
];
const validation = I.validateStops(multiDay);
assert(validation.ok, "multiple stops on same day allowed");

const summary = I.summarizePortStatus(withSea);
assert(summary.verified === 2, "two verified mapped ports");
assert(summary.readyForAutoMap === true, "ready when coords present");

const noCoords = I.summarizePortStatus([
  I.blankStop(1, {
    stop_type: "port_call",
    port_id: "x",
    port: { ...catalogue[0], latitude: null, longitude: null, status: "provisional" },
    entered_port_text: "Barcelona, Spain"
  })
]);
assert(noCoords.missingCoordinates === 1, "missing coordinates flagged");
assert(noCoords.readyForAutoMap === false, "not ready without coords");

/* ── Newsletter compatibility ──────────────────────────────────────────── */

const publicHero = "https://example.supabase.co/storage/v1/object/public/cruise-media/hero.jpg";
const publicMap = "https://example.supabase.co/storage/v1/object/public/cruise-media/map.jpg";

const modelFromStops = Preview.buildModel({
  headline: "Test",
  destinationStrip: "A TO B",
  itineraryStops: withSea,
  itinerarySummary: "LEGACY SHOULD BE IGNORED WHEN STOPS PRESENT",
  heroImageUrl: publicHero,
  routeMapUrl: publicMap,
  publicSlug: "test-cruise",
  short_editorial: "Hello",
  nights: 7,
  departureDate: "2027-01-01",
  returnDate: "2027-01-08"
});
assert(modelFromStops.portsJoined.includes("Barcelona"), "preview uses structured stops");
assert(!modelFromStops.portsJoined.includes("LEGACY"), "structured stops preferred over legacy");

const modelLegacy = Preview.buildModel({
  headline: "Test",
  itinerarySummary: "Barcelona, Spain | Istanbul, Turkey",
  heroImageUrl: publicHero,
  routeMapUrl: publicMap,
  publicSlug: "test-cruise",
  short_editorial: "Hello",
  nights: 7,
  departureDate: "2027-01-01",
  returnDate: "2027-01-08"
});
assert(modelLegacy.portsJoined.includes("Istanbul"), "legacy summary fallback works");

const pricingRows = [
  {
    room_label: "Inside",
    brochure_price: 2000,
    cruise_101_price: 1200,
    airline_price: 900,
    display_order: 1
  }
];

const exportOk = Export.generateFromModel(modelFromStops, {
  outputMode: "general",
  templateKey: "classic-editorial",
  pricingRows,
  publicationStatus: "published",
  publicSlug: "test-cruise"
});
assert(exportOk.ok, `classic export still works: ${(exportOk.errors || []).join("; ")}`);
assert(/PORTS OF CALL/i.test(exportOk.html), "ports of call present");
assert(/Barcelona/i.test(exportOk.html), "structured port wording in export");

const greenOk = Export.generateFromModel(modelFromStops, {
  outputMode: "general",
  templateKey: "green-price-cards",
  pricingRows,
  publicationStatus: "published",
  publicSlug: "test-cruise"
});
assert(greenOk.ok, `green export still works: ${(greenOk.errors || []).join("; ")}`);
assert(/cr101-gpc-card/i.test(greenOk.html), "green cards unchanged structurally");

console.log("featured-cruise-itinerary offline checks passed");
console.log({
  signatureSample: sig1,
  portsJoined: joined,
  aliasStatus: alias.status,
  exportBytes: exportOk.html.length
});
