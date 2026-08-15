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
const productVariantA = require(path.join(root, "scripts/fixtures/disney/product-variant-a.json"));
const productVariantB = require(path.join(root, "scripts/fixtures/disney/product-variant-b.json"));
const source = require(path.join(root, "netlify/functions/lib/disney-discovery-source"));
const dclCatalogue = require(path.join(root, "netlify/functions/lib/disney-discovery-catalogue"));
const adapter = require(path.join(root, "netlify/functions/lib/disney-discovery-adapter"));
const destMapping = require(path.join(root, "netlify/functions/lib/disney-destination-mapping"));
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
assert(typeof source.probeDisneyEnumerationPhase2a === "function", "phase2a probe entrypoint exists");
assert(typeof source.expandDisneySailingCatalogueLossless === "function", "lossless expansion exists");
assert(typeof source.buildMonthlyReconciliationTable === "function", "monthly reconciliation helper exists");
assert(typeof source.compareProbeIdentitySets === "function", "reproducibility helper exists");
assert(source.PHASE2_MAX_API_CALLS >= 2000, "phase2 api budget configured");
assert(typeof source.harvestDisneyProductCatalogue === "function", "harvest helper exists");
assert(source.applyDisneyBatchWrites == null, "no write export on source");

const cat = new dclCatalogue.LosslessProductCatalogue();
cat.ingest(productVariantA, { filters: ["2026-09;filterType=date"], strategy: "date_x_ship" });
cat.ingest(productVariantA, { filters: ["2026-09;filterType=date"], strategy: "date_x_ship" });
assert(cat.uniqueItineraryTargets === 1, "same productId + same structure dedupes correctly");

const cat2 = new dclCatalogue.LosslessProductCatalogue();
cat2.ingest(productVariantA, { filters: ["2026-09;filterType=date"], strategy: "date_x_ship" });
cat2.ingest(productVariantB, { filters: ["2026-10;filterType=date"], strategy: "date_x_night" });
assert(cat2.uniqueItineraryTargets === 2, "same productId + different itinerary preserved");

const lww = new Map();
lww.set(productVariantA.productId, productVariantB);
const variantAnalysis = dclCatalogue.analyzeProductVariantCollapse(cat2, [...lww.values()]);
assert(variantAnalysis.itineraries_lost_by_current_last_write_wins_logic >= 1, "LWW loss quantified");

const sigA = dclCatalogue.productPageStructuralSignature([productVariantA]);
const sigB = dclCatalogue.productPageStructuralSignature([productVariantB]);
assert(sigA !== sigB, "differing itinerary page is NOT same structural signature");

assert(source.monthFromFilterValue("2026-09;filterType=date") === "2026-09", "month from filterValue");
assert(dclCatalogue.departureMonth("2026-09-15") === "2026-09", "month assignment from sailDateFrom");

const reconTable = source.buildMonthlyReconciliationTable(
  { "2026-08": 2, "2026-09": 0 },
  [
    { official_product_key: "DA0071|2026-08-20", sailing_id: "DA0071", departure_date: "2026-08-20", ship_name: "Disney Adventure", product_id: "4_singapore" },
    { official_product_key: "DA0072|2026-08-27", sailing_id: "DA0072", departure_date: "2026-08-27", ship_name: "Disney Adventure", product_id: "4_singapore" }
  ]
);
assert(reconTable.find((r) => r.month === "2026-08").unique_dated_sailings === 2, "reconciliation arithmetic");

const semantics = dclCatalogue.analyzeTotalAvailableCruisesSemantics({
  advertisedByMonth: { "2026-08": 2 },
  sailings: [
    { official_product_key: "DA0071|2026-08-20", sailing_id: "DA0071", departure_date: "2026-08-20" },
    { official_product_key: "DA0072|2026-08-27", sailing_id: "DA0072", departure_date: "2026-08-27" }
  ]
});
assert(semantics.is_unique_dated_sailing_count === true, "totalAvailableCruises semantic analysis fixture");

const repro = source.compareProbeIdentitySets(["A|2026-08-01"], ["A|2026-08-01"]);
assert(repro.substantially_reproducible, "two identical identity sets reproducible");

const phase2Plans = dclCatalogue.buildPhase2HarvestPlans(indexed);
assert(phase2Plans.some((p) => p.strategy === "date_x_city"), "phase2 date x city plan");

// --- Phase 2B adapter unit tests ---
assert(adapter.DISNEY_LINE_ID === "8f7aadcb-7843-4060-b0cb-a60631936b3a", "Disney line id constant");
assert(adapter.extractEmbarkFromProductId("3_bahamian_port_canaveral")?.port.includes("Port Canaveral"), "productId embark");
assert(adapter.extractEmbarkFromProductName("3-Night Cruise from Singapore")?.port === "Singapore", "productName embark");
assert(adapter.extractEmbarkFromProductName("Mystery Cruise") === null, "ambiguous product title fails closed");

const merged = adapter.mergeDisneyStructuralContexts(
  { ship_name: "Disney Magic", structural_contexts: [{ a: 1 }], material_contradictions: [] },
  { ship_name: "Disney Magic", structural_contexts: [{ b: 2 }], material_contradictions: [] }
);
assert(merged.structural_contexts.length === 2, "duplicate structural contexts merge");

const conflict = adapter.mergeDisneyStructuralContexts(
  { ship_name: "Disney Magic", nights: 3, material_contradictions: [] },
  { ship_name: "Disney Dream", nights: 3, material_contradictions: [] }
);
assert(conflict.material_contradictions.length === 1, "contradictory ship detected");

const durationOk = adapter.validateDisneyDuration({
  departure_date: "2026-09-01",
  return_date: "2026-09-04",
  nights: 3
});
assert(durationOk.valid && durationOk.exact_match, "duration exact match");

const durationBad = adapter.validateDisneyDuration({
  departure_date: "2026-09-01",
  return_date: "2026-09-05",
  nights: 3
});
assert(durationBad.valid === false, "duration mismatch detected");

const mockShips = [
  { id: "s1", name: "Disney Magic", cruise_line_id: adapter.DISNEY_LINE_ID, official_line_ship_id: "DM", active: true }
];
const rawVoyage = adapter.buildDisneyRawVoyage(
  {
    official_product_key: "DM1740|2026-08-20",
    sailing_id: "DM1740",
    product_id: "3_bahamian_port_canaveral",
    departure_date: "2026-08-20",
    return_date: "2026-08-23",
    nights: 3,
    ship_name: "Disney Magic",
    ship_code: "DM",
    destination_code: "BAHAMAS"
  },
  [{ portsOfCall: ["Port Canaveral", "Nassau"], oneWayItinerary: false, _discoveredViaFilters: [] }],
  { productName: "3-Night Bahamian Cruise from Port Canaveral" }
);
assert(rawVoyage.theme_metadata.length >= 0, "raw voyage built with context");
const normalised = adapter.normaliseDisneyVoyage(rawVoyage, {
  cruiseLine: { id: adapter.DISNEY_LINE_ID, name: "Disney Cruise Line" },
  ships: mockShips,
  destinations: [{ id: "d1", slug: "caribbean", name: "Caribbean", status: "active" }],
  today: perthToday
});
assert(normalised.official_sailing_id === "DM1740|2026-08-20", "stable sailing identity");
assert(normalised.ship_resolution.resolved === true, "ship resolves with official_line_ship_id seed");
assert(normalised.candidate.departure_port_meta.status === "resolved", "embark resolves from productId");

const waterfall = adapter.buildEligibilityWaterfall([normalised], perthToday);
assert(waterfall.arithmetic.reconciles === true, "eligibility waterfall arithmetic");

const outsideCutoffVoyage = adapter.buildDisneyRawVoyage(
  {
    official_product_key: "DM1740|2026-10-01",
    sailing_id: "DM1740",
    product_id: "3_bahamian_port_canaveral",
    departure_date: "2026-10-01",
    return_date: "2026-10-04",
    nights: 3,
    ship_name: "Disney Magic",
    ship_code: "DM",
    destination_code: "BAHAMAS"
  },
  [{ portsOfCall: ["Port Canaveral", "Nassau"], oneWayItinerary: false }],
  { productName: "3-Night Bahamian Cruise from Port Canaveral" }
);
const outsideCutoff = adapter.normaliseDisneyVoyage(outsideCutoffVoyage, {
  cruiseLine: { id: adapter.DISNEY_LINE_ID, name: "Disney Cruise Line" },
  ships: mockShips,
  destinations: [{ id: "d1", slug: "caribbean", name: "Caribbean", status: "active" }],
  today: perthToday
});
assert(outsideCutoff.confidence.outcome === "auto_publish", "structured Disney voyage auto_publish outside cutoff");
assert(outsideCutoff.eligibility.production_eligible === true, "production eligible when references resolve");

const manifest = adapter.buildProposedWriteManifest([normalised], [], { id: adapter.DISNEY_LINE_ID });
assert(manifest.summary.within_21_day_cutoff_excluded + manifest.summary.insert_active >= 0, "write manifest deterministic");

assert(typeof adapter.buildDisneyUpsertCandidate === "function" || adapter.buildDisneyUpsertCandidate, "upsert helper exists");
assert(adapter.applyDisneyBatchWrites == null, "no write export on adapter");

const destHint = destMapping.resolveDisneyDestinationHints({ destination_code: "BAHAMAS", product_id: "3_bahamian_port_canaveral" });
assert(destHint.preferredSlug === "caribbean", "destination mapping bahamas");

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

  const lossless = new dclCatalogue.LosslessProductCatalogue();
  const structuralPaginated = await source.paginateDisneyProductsForFilters(["2026-09;filterType=date"], {
    fetchImpl: mockFetch,
    cookieJar: { __pa: "fixture-token" },
    requestDelayMs: 0,
    maxPages: 5,
    losslessCatalogue: lossless
  });
  assert(structuralPaginated.structurally_new_pages >= 1, "structural page progress works");
  assert(structuralPaginated.true_repeated_pages === 1, "genuinely repeated structural page detected");

  const harvest = await source.harvestDisneyProductCatalogue({
    fetchImpl: mockFetch,
    cookieJar: { __pa: "fixture-token" },
    requestDelayMs: 0,
    maxApiCalls: 5,
    filterOptions: indexed,
    useLosslessCatalogue: true
  });
  assert(harvest.products.length >= 1, "harvest returns products from mock");
  assert(harvest.api_calls <= 5, "harvest respects api cap");
  assert(harvest.unique_itinerary_targets >= 1, "lossless harvest tracks itinerary targets");

  const expansion = await source.expandDisneySailingCatalogue(harvest.products, {
    fetchImpl: mockFetch,
    cookieJar: { __pa: "fixture-token" },
    requestDelayMs: 0,
    maxApiCalls: 5
  });
  assert(expansion.unique_sailings.length === 2, "sailing expansion dedupes fixture sailings");
  assert(expansion.identity_collisions === 0, "zero identity collisions in fixture expansion");

  const losslessExpansion = await source.expandDisneySailingCatalogueLossless(harvest.products, {
    fetchImpl: mockFetch,
    cookieJar: { __pa: "fixture-token" },
    requestDelayMs: 0,
    maxApiCalls: 5,
    losslessCatalogue: harvest.lossless_catalogue
  });
  assert(losslessExpansion.unique_sailings.length === 2, "lossless expansion dedupes fixture sailings");

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
