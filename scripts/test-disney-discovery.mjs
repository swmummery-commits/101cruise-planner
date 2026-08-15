#!/usr/bin/env node
/**
 * Disney Cruise Line read-only source discovery tests (Phase 1).
 * Run: npm run test:disney-discovery
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const filterFixture = require(path.join(root, "scripts/fixtures/disney/filter-options-sample.json"));
const productsPage0 = require(path.join(root, "scripts/fixtures/disney/available-products-page0.json"));
const productsPage1Repeated = require(path.join(root, "scripts/fixtures/disney/available-products-page1-repeated.json"));
const sailingsFixture = require(path.join(root, "scripts/fixtures/disney/available-sailings-sample.json"));
const source = require(path.join(root, "netlify/functions/lib/disney-discovery-source"));
const {
  partitionByPublicBookingCutoff,
  PUBLIC_BOOKING_CUTOFF_DAYS,
  PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE
} = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

assert(source.SOURCE_CONTRACT.writes === false, "source contract declares zero writes");
assert(source.SOURCE_CONTRACT.authentication_required === true, "auth required flag");
assert(/filterValue/.test(source.SOURCE_CONTRACT.filter_parameter_format), "filterValue documented");

const indexed = source.indexFilterOptions(filterFixture);
assert(indexed.filter_count >= 4, "filter fixture indexed");
assert((indexed.byType.ship || []).every((f) => /;filterType=ship$/.test(f.filterValue)), "ship filterValue format");

const plans = source.buildProductHarvestPlans(indexed);
assert(plans.some((p) => p.strategy === "date_x_night"), "date x night harvest plan");
assert(plans.some((p) => p.strategy === "date_x_ship"), "date x ship harvest plan");

const parsedProducts = source.parseAvailableProductsResponse(productsPage0);
assert(parsedProducts.products.length === 1, "products page parser");
assert(parsedProducts.totalAvailableCruises === 651, "advertised total preserved in fixture");

const sig0 = source.productPageSignature(parsedProducts.products);
const sig1 = source.productPageSignature(productsPage1Repeated.products);
assert(sig0 === sig1, "repeated page fixture uses same product signature");

const sailingA = source.parseRawSailing(sailingsFixture.sailings[0], {
  productId: "4_singapore",
  productName: "4-Night Cruise from Singapore",
  itineraryId: ""
});
const sailingB = source.parseRawSailing(sailingsFixture.sailings[1], {
  productId: "4_singapore",
  productName: "4-Night Cruise from Singapore",
  itineraryId: ""
});
assert(sailingA.official_product_key === "DA0071|2026-08-20", "sailing identity from fixture");
assert(sailingB.official_product_key === "DA0072|2026-08-27", "second sailing distinct date");
assert(sailingA.official_product_key !== sailingB.official_product_key, "same itinerary different dates differ");
assert(source.officialProductKey("DA0071", "2026-08-20") === sailingA.official_product_key, "deterministic identity");

const sameAgain = source.parseRawSailing(sailingsFixture.sailings[0], {
  productId: "4_singapore",
  itineraryId: ""
});
assert(sameAgain.official_product_key === sailingA.official_product_key, "identical sailing same identity");

assert(sailingA.ship_code === "DA", "ship code extraction");
assert(sailingA.ship_name === "Disney Adventure", "ship name extraction");
assert(sailingA.departure_date === "2026-08-20", "departure date extraction");
assert(sailingA.return_date === "2026-08-24", "return date extraction");
assert(sailingA.nights === 4, "night count extraction");
assert(sailingA.destination_code === "SINGAPORE", "destination extraction");

const malformed = source.parseRawSailing({ sailingId: "X1" });
assert(malformed === null, "malformed sailing rejected");

const targets = source.expandProductTemplates(parsedProducts.products);
assert(targets.length === 1, "itinerary target expansion");
assert(targets[0].numberOfSailings === 53, "embedded metadata count preserved");

const perthToday = "2026-08-15";
const sampleSailings = [
  { departure_date: "2026-08-20", status: "active" },
  { departure_date: "2026-09-10", status: "active" }
];
const partition = partitionByPublicBookingCutoff(sampleSailings, (item) => item.departure_date, perthToday);
assert(PUBLIC_BOOKING_CUTOFF_DAYS === 21, "shared cutoff constant");
assert(PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE === 22, "shared min days constant");
assert(partition.withinCutoff.length === 1, "within 21-day bucket uses shared helper");
assert(partition.publiclyEligible.length === 1, "publicly eligible bucket uses shared helper");

const summary = source.summariseInventory(
  [
    { departure_date: "2026-08-20", ship_name: "Disney Adventure" },
    { departure_date: "2026-09-10", ship_name: "Disney Adventure" }
  ],
  { perthToday }
);
assert(summary.within_21_day_cutoff === 1, "inventory summary cutoff");
assert(summary.publicly_eligible_total === 1, "inventory summary eligible");

assert(typeof source.probeDisneyInventory === "function", "probe entrypoint exists");
assert(typeof source.harvestDisneyProductCatalogue === "function", "harvest helper exists");
assert(source.applyDisneyBatchWrites == null, "no write export on source");

(async () => {
  let productCalls = 0;
  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};

    if (u.includes("/authz/private")) {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (k) => (String(k).toLowerCase() === "set-cookie" ? "__pa=fixture-token; Path=/" : null),
          getSetCookie: () => ["__pa=fixture-token; Path=/"]
        },
        text: async () => "{}"
      };
    }

    if (u.includes("/quick-quote-filter-options/")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null, getSetCookie: () => [] },
        text: async () => JSON.stringify(filterFixture)
      };
    }

    if (u.includes("/available-products/")) {
      productCalls += 1;
      const payload = body.pageNumber >= 1 ? productsPage1Repeated : productsPage0;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null, getSetCookie: () => [] },
        text: async () => JSON.stringify({ ...payload, pageNumber: body.pageNumber || 0 })
      };
    }

    if (u.includes("/available-sailings/")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null, getSetCookie: () => [] },
        text: async () => JSON.stringify(sailingsFixture)
      };
    }

    throw new Error(`Unexpected fetch ${method} ${u}`);
  };

  const paginated = await source.paginateDisneyProductsForFilters(["2026-09;filterType=date"], {
    fetchImpl: mockFetch,
    cookieJar: { __pa: "fixture-token" },
    requestDelayMs: 0,
    maxPages: 5
  });
  assert(paginated.products.length === 1, "pagination collects first page products");
  assert(paginated.repeated_pages === 1, "repeated page detected");
  assert(paginated.pages.length === 2, "pagination stopped after repeat");

  const harvest = await source.harvestDisneyProductCatalogue({
    fetchImpl: mockFetch,
    cookieJar: { __pa: "fixture-token" },
    requestDelayMs: 0,
    maxApiCalls: 5,
    filterOptions: indexed
  });
  assert(harvest.products.length >= 1, "harvest returns products from mock");
  assert(harvest.api_calls <= 5, "harvest respects api cap");

  const expansion = await source.expandDisneySailingCatalogue(harvest.products, {
    fetchImpl: mockFetch,
    cookieJar: { __pa: "fixture-token" },
    requestDelayMs: 0,
    maxApiCalls: 5
  });
  assert(expansion.unique_sailings.length === 2, "sailing expansion dedupes fixture sailings");
  assert(expansion.identity_collisions === 0, "zero identity collisions in fixture expansion");

  const accounting = source.buildSourceAccounting({
    harvest,
    expansion,
    monthlyAdvertisedSum: 651,
    perthToday
  });
  assert(accounting.duplicate_official_identities === 0, "accounting collision count");
  assert(accounting.reconciles_with_monthly_advertised_sum === false, "fixture set does not fake reconcile to 651");

  assert(productCalls >= 1, "mock product endpoint called");

  console.log(`PASS ${passed} disney-discovery tests`);
})().catch((error) => {
  console.error(`FAIL after ${passed} assertions:`, error.message);
  process.exit(1);
});
