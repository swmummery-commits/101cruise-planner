#!/usr/bin/env node
/**
 * Carnival Cruise Line read-only discovery tests (Prompt 2).
 * Run: npm run test:carnival-discovery
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const fixture = require(path.join(root, "scripts/fixtures/carnival/search-response-page.json"));
const source = require(path.join(root, "netlify/functions/lib/carnival-discovery-source"));
const ccl = require(path.join(root, "netlify/functions/lib/carnival-discovery-adapter"));
const {
  daysUntilDeparture,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

const cclLine = { id: "ccl-line", name: "Carnival Cruise Line", slug: "carnival-cruise-line" };
const cclShips = [
  { id: "s-conquest", name: "Conquest", cruise_line_id: "ccl-line", official_line_ship_id: "CQ" },
  { id: "s-mardi", name: "Mardi Gras", cruise_line_id: "ccl-line", official_line_ship_id: "MD" },
  { id: "s-splendor", name: "Splendor", cruise_line_id: "ccl-line", official_line_ship_id: "SL" },
  { id: "s-adventure", name: "Adventure", cruise_line_id: "ccl-line", official_line_ship_id: "AQ" }
];
const shipAliases = [
  { ship_id: "s-conquest", raw_alias: "Carnival Conquest", normalised_alias: "carnival conquest" },
  { ship_id: "s-adventure", raw_alias: "Carnival Adventure", normalised_alias: "carnival adventure" },
  { ship_id: "s-splendor", raw_alias: "Carnival Splendor", normalised_alias: "carnival splendor" }
];
const destinations = ccl.catalogueDestinations([]);
const ctx = { cruiseLine: cclLine, ships: cclShips, shipAliases, destinations, today: "2026-08-15" };

assert(source.SOURCE_ID === "ccl_cruisesearch_api", "source id");
assert(source.DEFAULT_PAGE_SIZE === 200, "default page size");

const expanded = ccl.expandItineraryGroupsToRawSailings(fixture.results.itineraries);
assert(expanded.expansion.raw_expanded_sailings === 8, "expands every sailings[] entry");
assert(expanded.products.length === 8, "eight raw sailings before dedupe");
assert(expanded.expansion.lead_sailing_only_groups === 1, "lead-only group counted");

const deduped = ccl.dedupeExpandedSailings(expanded.products);
assert(deduped.products.length === 7, "removes exact duplicate sailingId");
assert(deduped.duplicate_rows_removed === 1, "one duplicate row removed");

const nights = ccl.deriveNightsFromCclDuration({ dur: 3, roundtrip: true });
assert(nights.nights === 2, "roundtrip dur 3 -> 2 nights");

const nightsOneWay = ccl.deriveNightsFromCclDuration({ dur: 10, roundtrip: false });
assert(nightsOneWay.nights === 10, "one-way dur 10 -> 10 nights");

assert(ccl.officialProductKey({ itinerary_code: "BAW", ship_code: "CQ", departure_date: "2026-09-06" }) === "BAW|CQ|2026-09-06", "composite key");

const normalised = deduped.products.map((raw) => ccl.normaliseCclSailing(raw, ctx));
const conquest = normalised.find((row) => row.raw.ship_name === "Carnival Conquest");
const breeze = normalised.find((row) => row.raw.ship_name === "Carnival Breeze");
const mardi = normalised.find((row) => row.raw.ship_name === "Mardi Gras");
const getaway = normalised.find((row) => row.raw.region_name === "Getaway");

assert(conquest?.ship_resolution?.resolved === true, "Carnival Conquest alias resolves");
assert(
  ["stored_alias", "official_line_ship_id"].includes(conquest?.ship_resolution?.method),
  "conquest via alias or official code"
);
assert(mardi?.ship_resolution?.resolved === true, "Mardi Gras exact name resolves");
assert(breeze?.ship_resolution?.resolved !== true, "missing DB ship remains unresolved");
assert(getaway?.destination_resolution?.status !== "resolved", "Getaway remains unresolved");

const hkg = normalised.find((row) => row.raw.departure_port_code === "HKG");
assert(hkg?.candidate?.departure_port_meta?.status === "resolved", "whitespace-normalised Hong Kong resolves");

const miami = normalised.find((row) => row.raw.departure_port_code === "MIA");
assert(miami?.candidate?.departure_port_meta?.status === "resolved", "Miami resolves");

const soldOut = normalised.find((row) => row.raw.sailing_id === "55001");
assert(soldOut?.availability?.excluded_for_availability === false, "sold-out cabins do not cancel sailing");

const bawCodes = normalised.filter((row) => row.raw.itinerary_code === "BAW");
const bavCodes = normalised.filter((row) => row.raw.itinerary_code === "BAV");
assert(bawCodes.length >= 1 && bavCodes.length >= 1, "different itinerary codes preserved");

assert(daysUntilDeparture("2026-09-05", "2026-08-15") === 21, "21-day boundary");
assert(daysUntilDeparture("2026-09-06", "2026-08-15") === 22, "22-day boundary");

const boundary21 = ccl.normaliseCclSailing(
  {
    ...deduped.products[0],
    sailing_id: "cutoff21",
    official_sailing_id: "cutoff21",
    departure_date: "2026-09-05",
    arrival_date: "2026-09-08",
    nights: 2
  },
  ctx
);
const boundary22 = ccl.normaliseCclSailing(
  {
    ...deduped.products[0],
    sailing_id: "cutoff22",
    official_sailing_id: "cutoff22",
    departure_date: "2026-09-06",
    arrival_date: "2026-09-09",
    nights: 2
  },
  ctx
);
const ev21 = ccl.evaluateSailingEligibility(boundary21, ctx.today);
const ev22 = ccl.evaluateSailingEligibility(boundary22, ctx.today);
assert(ev21.cutoff.within_21 === true, "21 days excluded");
assert(ev22.cutoff.outside_cutoff === true, "22 days eligible cutoff");

(async () => {
  source.clearCarnivalFetchCache();
  let pageCalls = 0;
  const pages = [
    { ...fixture, results: { ...fixture.results, currentPage: 1, lastPage: 2, itineraries: fixture.results.itineraries.slice(0, 4) } },
    { ...fixture, results: { ...fixture.results, currentPage: 2, lastPage: 2, itineraries: fixture.results.itineraries.slice(4) } },
    { ...fixture, results: { ...fixture.results, currentPage: 3, lastPage: 2, itineraries: [] } }
  ];
  const mockFetch = async (url) => {
    const pageNumber = Number(new URL(url).searchParams.get("pageNumber"));
    pageCalls += 1;
    const body = pages[pageNumber - 1] || pages.at(-1);
    return { ok: true, status: 200, json: async () => body };
  };

  const catalogue = await source.fetchCarnivalCatalogue({
    fetchImpl: mockFetch,
    maxApiCalls: 10,
    pageSize: 200,
    baseUrl: "https://example.test"
  });
  assert(catalogue.pages[0].pageNumber === 1, "page 1 begins correctly");
  assert(catalogue.pages[1].pageNumber === 2, "page 2 increments");
  assert(catalogue.api_calls >= 2, "multiple pages fetched");
  assert(catalogue.pagination.exhausted === true, "empty/beyond lastPage terminates");

  source.clearCarnivalFetchCache();
  let repeatCalls = 0;
  const repeatFetch = async () => {
    repeatCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: {
          totalResults: 10,
          currentPage: repeatCalls,
          lastPage: 5,
          itineraries: fixture.results.itineraries.slice(0, 2)
        }
      })
    };
  };
  const repeated = await source.fetchCarnivalCatalogue({
    fetchImpl: repeatFetch,
    maxApiCalls: 5,
    baseUrl: "https://example.test"
  });
  assert(repeated.error === "repeated_page_signature", "repeated page detected");

  source.clearCarnivalFetchCache();
  let driftCalls = 0;
  const driftFetch = async () => {
    driftCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: {
          totalResults: driftCalls === 1 ? 100 : 120,
          currentPage: driftCalls,
          lastPage: 2,
          itineraries:
            driftCalls === 1
              ? fixture.results.itineraries.slice(0, 3)
              : fixture.results.itineraries.slice(3, 6)
        }
      })
    };
  };
  const drift = await source.fetchCarnivalCatalogue({
    fetchImpl: driftFetch,
    maxApiCalls: 2,
    baseUrl: "https://example.test"
  });
  assert(drift.total_results_drift === true, "total-result drift surfaced");
  assert(drift.source_warnings.some((w) => w.code === "total_results_drift"), "drift warning recorded");

  source.clearCarnivalFetchCache();
  const ceilingFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      results: {
        totalResults: 999,
        currentPage: 1,
        lastPage: 99,
        itineraries: fixture.results.itineraries.slice(0, 1)
      }
    })
  });
  const ceiling = await source.fetchCarnivalCatalogue({
    fetchImpl: ceilingFetch,
    maxApiCalls: 2,
    baseUrl: "https://example.test"
  });
  assert(ceiling.api_calls === 2, "max API call ceiling respected");

  console.log(`carnival-discovery tests passed: ${passed}`);
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
