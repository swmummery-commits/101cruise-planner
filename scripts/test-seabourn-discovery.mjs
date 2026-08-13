#!/usr/bin/env node
/**
 * Seabourn read-only discovery tests (Prompt 2).
 * Run: npm run test:seabourn-discovery
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const fixture = require(path.join(root, "scripts/fixtures/seabourn/search-response-page.json"));
const carnival = require(path.join(root, "netlify/functions/lib/carnival-solr-discovery"));
const source = require(path.join(root, "netlify/functions/lib/seabourn-discovery-source"));
const sbn = require(path.join(root, "netlify/functions/lib/seabourn-discovery-adapter"));
const hal = require(path.join(root, "netlify/functions/lib/holland-america-discovery-adapter"));
const {
  daysUntilDeparture,
  PUBLIC_BOOKING_CUTOFF_DAYS,
  PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE
} = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

const sbnLine = { id: "sbn-line", name: "Seabourn Cruise Line", slug: "seabourn-cruise-line" };
const sbnShips = [
  { id: "s-encore", name: "Encore", cruise_line_id: "sbn-line" },
  { id: "s-quest", name: "Quest", cruise_line_id: "sbn-line" },
  { id: "s-ovation", name: "Ovation", cruise_line_id: "sbn-line" },
  { id: "s-pursuit", name: "Pursuit", cruise_line_id: "sbn-line" },
  { id: "s-venture", name: "Venture", cruise_line_id: "sbn-line" }
];
const destinations = sbn.catalogueDestinations([]);
const ctx = { cruiseLine: sbnLine, ships: sbnShips, destinations, today: "2026-08-13" };

assert(carnival.parseCarnivalDelimited("Seabourn Encore#@#SE").name === "Seabourn Encore", "delimited ship parse");
assert(carnival.parseCarnivalDelimited("Juneau, Alaska, US#@#JNU").code === "JNU", "delimited port parse");
assert(sbn.parseSeabournDelimited("Seabourn Encore#@#SE").code === "SE", "adapter delimited alias");

const validDocs = fixture.response.docs.filter((d) => d.cruiseId && d.departDate);
const parsed = validDocs.map((d) => sbn.parseRawVoyageFromDoc(d)).filter(Boolean);
assert(parsed.length === 5, "parses valid fixture docs");
assert(parsed[0].cruise_id === "7655", "cruise id preserved");
assert(sbn.officialProductKey(parsed[0]) === "A6S07G|7655", "official product key order");

const dedup = carnival.fetchCarnivalCatalogue.length > 0;
assert(typeof source.officialProductKeyFromDoc(validDocs[0]) === "string", "source product key helper");

(async () => {
  let pageCalls = 0;
  const pages = [
    { response: { numFound: 25, start: 0, docs: fixture.response.docs.slice(0, 4) } },
    { response: { numFound: 25, start: 4, docs: fixture.response.docs.slice(4, 6) } },
    { response: { numFound: 25, start: 6, docs: [] } }
  ];
  const mockFetch = async () => {
    const body = pages[pageCalls] || pages.at(-1);
    pageCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => body
    };
  };

  const catalogue = await carnival.fetchCarnivalCatalogue(
    {
      endpoint: "https://example.test/search/sbncruisesearch",
      query: "*:*",
      filterQuery: "type:cruise"
    },
    {
      fetchImpl: mockFetch,
      maxApiCalls: 10,
      getProductKey: source.officialProductKeyFromDoc,
      isValidDoc: (d) => Boolean(d?.cruiseId && d?.departDate)
    }
  );

  assert(catalogue.raw_rows_fetched === 6, "pagination raw count");
  assert(catalogue.exact_solr_duplicate_rows_removed === 1, "exact solr duplicate removed");
  assert(catalogue.unique_products === 4, "unique products after dedupe");
  assert(catalogue.pagination.exhausted === true, "pagination exhausted");

  const overlapDocs = parsed.filter((p) => p.departure_date === "2026-08-16");
  assert(overlapDocs.length === 2, "overlap sample count");
  assert(sbn.officialProductKey(overlapDocs[0]) !== sbn.officialProductKey(overlapDocs[1]), "overlap products distinct");

  const scenic = sbn.classifyPortEntry("Cruising Stephens Passage#@#496");
  assert(scenic.kind === "scenic_or_transit", "scenic port classified");

  const alaska = sbn.normaliseSeabournVoyage(parsed[0], ctx);
  assert(alaska.ship_resolution.resolved, "Seabourn Encore resolves to Encore");
  assert(alaska.destination_resolution.destinationKey === "alaska", "Alaska destination");

  const expedition = sbn.normaliseSeabournVoyage(parsed.find((p) => p.tour_id), ctx);
  assert(expedition.product_type === "cruisetour", "tour id => cruisetour");

  const identity = sbn.analyseIdentity(parsed.map((raw) => ({ raw, product_type: "ocean" })));
  assert(identity.unique_official_product_key === 4, "identity unique official keys");
  assert(identity.official_key_collisions.length === 0, "no official key collisions in fixture");

  const today = "2026-08-13";
  assert(daysUntilDeparture("2026-09-04", today) === 22, "22 days away");
  assert(daysUntilDeparture("2026-09-04", today) >= PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE, "22 days eligible boundary");
  assert(daysUntilDeparture("2026-09-03", today) === 21, "21 days away");
  assert(daysUntilDeparture("2026-09-03", today) <= PUBLIC_BOOKING_CUTOFF_DAYS, "21 days excluded");
  assert(daysUntilDeparture("2026-08-14", today) === 1, "tomorrow excluded");
  assert(daysUntilDeparture("2026-08-12", today) === -1, "past departure");

  const eligibilityRows = parsed.map((raw) =>
    sbn.normaliseSeabournVoyage(raw, { ...ctx, today, productMeta: sbn.classifySeabournProductType(raw) })
  );
  const eligibility = sbn.buildEligibilitySummary(eligibilityRows, today);
  assert(eligibility.within_21_day_exclusions >= 1, "2026-08-14 inside 21-day window");
  assert(eligibility.arithmetic.reconciles === true, "eligibility arithmetic reconciles");

  const diagnostic = sbn.buildDateDiagnostic(parsed, today);
  assert(diagnostic.departing_before_or_on_cutoff >= 1, "date diagnostic finds within-cutoff departures");
  assert(diagnostic.earliest_departure === "2026-08-14", "earliest departure");

  assert(hal.parseHalDelimited("Zaandam#@#AA").name === "Zaandam", "HAL regression delimited parse");

  console.log(`Seabourn discovery tests passed (${passed})`);
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
