/**
 * Disney Cruise Line — official Product Availability VAS source (read-only).
 *
 * POST https://disneycruise.disney.go.com/dcl-apps-productavail-vas/authz/private
 * GET  https://disneycruise.disney.go.com/dcl-apps-productavail-vas/quick-quote-filter-options/
 * POST https://disneycruise.disney.go.com/dcl-apps-productavail-vas/available-products/
 * POST https://disneycruise.disney.go.com/dcl-apps-productavail-vas/available-sailings/
 *
 * This module performs ZERO database writes.
 */

const {
  partitionByPublicBookingCutoff,
  publicBookingCutoffDate,
  publicBookingMinimumDepartureDate,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require("./public-discovered-cruise-inventory");
const { perthCalendarDate } = require("./cruise-discovery-maintenance");

const ADAPTER_ID = "disney";
const ADAPTER_VERSION = "2026-08-15.dcl1";
const USER_AGENT = "101cruise-discovery/1.0 (+https://101cruise.com.au)";
const SITE_ORIGIN = "https://disneycruise.disney.go.com";
const VAS_BASE = `${SITE_ORIGIN}/dcl-apps-productavail-vas`;
const DEFAULT_LOCALE = "en-au";
const DEFAULT_CURRENCY = "AUD";
const DEFAULT_STORE_ID = "DCL";
const DEFAULT_LANGUAGE = "en";

const SOURCE_CONTRACT = {
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  cruise_line: "Disney Cruise Line",
  hostname: "disneycruise.disney.go.com",
  base_path: "/dcl-apps-productavail-vas/",
  endpoint_type: "structured_json_rest",
  auth_endpoint: `${VAS_BASE}/authz/private`,
  filters_endpoint: `${VAS_BASE}/quick-quote-filter-options/`,
  products_endpoint: `${VAS_BASE}/available-products/`,
  sailings_endpoint: `${VAS_BASE}/available-sailings/`,
  method: "POST (catalogue) + GET (filters)",
  locale: "en-au / AUD / storeId DCL",
  authentication_required: true,
  authentication_notes: "POST authz/private with {} sets HttpOnly __pa cookie; no user credentials",
  browser_session_required: false,
  cookies_required: true,
  response_format:
    "JSON — product templates with itineraries[]; individual sailings via available-sailings expansion",
  pagination:
    "available-products pageNumber (5 products/page); broken for unfiltered catalogue — use faceted filter unions",
  filter_parameter_format: "filters[] must use filterValue (e.g. DM;filterType=ship), not filter option id",
  official_identity_formula: "{sailingId}|{YYYY-MM-DD}",
  official_identity_source: "available-sailings[].sailingId + sailDateFrom",
  writes: false
};

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_REQUEST_DELAY_MS = 120;
const DEFAULT_MAX_PRODUCT_PAGES = 50;
const DEFAULT_MAX_API_CALLS = 600;
const DEFAULT_PARTY_MIX = Object.freeze([
  {
    number: 1,
    adultCount: 2,
    childCount: 0,
    nonAdultAges: [],
    partyMixId: "0",
    accessible: false,
    isDefault: false,
    stateroomInfo: {}
  }
]);

const PRODUCT_HARVEST_PAIRS = Object.freeze([
  ["date", "night"],
  ["date", "ship"]
]);
const PRODUCT_HARVEST_SINGLETON_TYPES = Object.freeze(["theme", "new-itineraries", "privateIsland"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normaliseIsoDate(raw) {
  const s = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function officialProductKey(sailingId, sailDateFrom) {
  const sid = String(sailingId || "").trim().toUpperCase();
  const dep = normaliseIsoDate(sailDateFrom);
  if (!sid || !dep) return null;
  return `${sid}|${dep}`;
}

function officialProductKeyFromRaw(raw) {
  return officialProductKey(raw?.sailingId, raw?.sailDateFrom);
}

function readResponseSetCookies(response) {
  if (typeof response?.headers?.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const combined = response?.headers?.get?.("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[A-Za-z0-9_.-]+=)/).map((part) => part.trim()).filter(Boolean);
}

function mergeCookieJar(jar, setCookieHeaders = []) {
  const next = { ...(jar || {}) };
  for (const header of setCookieHeaders) {
    const pair = String(header || "").split(";")[0].trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    if (/^Max-Age=0$/i.test(String(header).split(";")[1]?.trim()) || /expires=Thu, 01 Jan 1970/i.test(header)) {
      delete next[name];
    } else {
      next[name] = value;
    }
  }
  return next;
}

function cookieHeaderFromJar(jar) {
  return Object.entries(jar || {})
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function defaultRequestBody(overrides = {}) {
  return {
    affiliations: [],
    currency: DEFAULT_CURRENCY,
    language: DEFAULT_LANGUAGE,
    storeId: DEFAULT_STORE_ID,
    partyMix: DEFAULT_PARTY_MIX,
    ...overrides
  };
}

function buildDefaultHeaders(cookieJar, extra = {}) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Accept-Language": DEFAULT_LOCALE,
    "User-Agent": USER_AGENT,
    Referer: `${SITE_ORIGIN}/${DEFAULT_LOCALE}/cruises-destinations/`,
    ...(cookieHeaderFromJar(cookieJar) ? { Cookie: cookieHeaderFromJar(cookieJar) } : {}),
    ...extra
  };
}

async function disneyFetchJson(url, { method = "GET", body = null, cookieJar = {}, headers = {}, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer =
      controller && timeoutMs
        ? setTimeout(() => {
            controller.abort();
          }, timeoutMs)
        : null;

    try {
      const response = await fetchImpl(url, {
        method,
        headers: buildDefaultHeaders(cookieJar, headers),
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller?.signal
      });

      const setCookie = readResponseSetCookies(response);
      const nextJar = mergeCookieJar(cookieJar, setCookie);
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (error) {
          throw new Error(`Invalid JSON from ${url}: ${error.message}`);
        }
      }

      if (!response.ok) {
        const retryable = response.status === 429 || response.status === 503;
        if (retryable && attempt < attempts) {
          lastError = new Error(`HTTP ${response.status} for ${url}`);
          await sleep(800 * attempt);
          continue;
        }
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return {
        ok: true,
        url,
        status: response.status,
        payload,
        cookieJar: nextJar,
        bytes: text.length
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts && (error.retryable || /abort|timeout|fetch failed/i.test(error.message))) {
        await sleep(800 * attempt);
        continue;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}

async function authenticateDisneySession(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    cookieJar = {},
    requestDelayMs = DEFAULT_REQUEST_DELAY_MS
  } = options;
  const result = await disneyFetchJson(`${VAS_BASE}/authz/private`, {
    method: "POST",
    body: {},
    cookieJar,
    fetchImpl
  });
  if (requestDelayMs) await sleep(requestDelayMs);
  return {
    cookieJar: result.cookieJar,
    authenticated_at: new Date().toISOString()
  };
}

function indexFilterOptions(rawFilters = {}) {
  const byType = {};
  const byId = {};
  for (const [id, meta] of Object.entries(rawFilters || {})) {
    if (!meta || typeof meta !== "object") continue;
    const type = String(meta.type || "").trim();
    const filterValue = String(meta.filterValue || id).trim();
    const entry = {
      id,
      type,
      filterValue,
      name: meta.name || null
    };
    byId[id] = entry;
    if (!byType[type]) byType[type] = [];
    byType[type].push(entry);
  }
  return { byType, byId, filter_count: Object.keys(byId).length };
}

async function fetchDisneyFilterOptions(options = {}) {
  const { fetchImpl = globalThis.fetch, cookieJar = {}, requestDelayMs = DEFAULT_REQUEST_DELAY_MS } = options;
  let jar = { ...cookieJar };
  if (!cookieHeaderFromJar(jar)) {
    const auth = await authenticateDisneySession({ fetchImpl, cookieJar: jar, requestDelayMs });
    jar = auth.cookieJar;
  }
  const result = await disneyFetchJson(`${VAS_BASE}/quick-quote-filter-options/`, {
    method: "GET",
    cookieJar: jar,
    fetchImpl
  });
  const indexed = indexFilterOptions(result.payload);
  return {
    ...result,
    filters: result.payload,
    ...indexed
  };
}

function productPageSignature(products = []) {
  return (products || []).map((p) => String(p?.productId || "")).join("|");
}

function parseAvailableProductsResponse(payload = {}) {
  return {
    products: Array.isArray(payload.products) ? payload.products : [],
    totalAvailableCruises: Number(payload.totalAvailableCruises) || 0,
    totalPages: Number(payload.totalPages) || 0,
    pageNumber: Number(payload.pageNumber) || 0
  };
}

async function fetchDisneyAvailableProductsPage(filters, pageNumber = 0, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    cookieJar = {},
    requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
    bodyOverrides = {}
  } = options;
  if (requestDelayMs) await sleep(requestDelayMs);
  const result = await disneyFetchJson(`${VAS_BASE}/available-products/`, {
    method: "POST",
    body: defaultRequestBody({
      filters: Array.isArray(filters) ? filters : [],
      pageNumber,
      ...bodyOverrides
    }),
    cookieJar,
    fetchImpl
  });
  const parsed = parseAvailableProductsResponse(result.payload);
  return {
    ...result,
    ...parsed
  };
}

async function paginateDisneyProductsForFilters(filters, options = {}) {
  const {
    maxPages = DEFAULT_MAX_PRODUCT_PAGES,
    maxApiCalls = DEFAULT_MAX_API_CALLS,
    fetchImpl = globalThis.fetch,
    cookieJar: initialJar = {},
    requestDelayMs = DEFAULT_REQUEST_DELAY_MS
  } = options;

  let cookieJar = { ...initialJar };
  const pages = [];
  const productsById = new Map();
  let pageNumber = 0;
  let apiCalls = 0;
  let repeatedPages = 0;
  let zeroProgressPages = 0;
  let lastSignature = null;
  let lastResponse = null;

  while (pageNumber < maxPages && apiCalls < maxApiCalls) {
    const batch = await fetchDisneyAvailableProductsPage(filters, pageNumber, {
      fetchImpl,
      cookieJar,
      requestDelayMs
    });
    cookieJar = batch.cookieJar || cookieJar;
    apiCalls += 1;
    lastResponse = batch;
    const signature = productPageSignature(batch.products);
    pages.push({
      filters,
      pageNumber,
      products_returned: batch.products.length,
      totalPages: batch.totalPages,
      totalAvailableCruises: batch.totalAvailableCruises,
      signature
    });

    if (!batch.products.length) break;

    if (signature && signature === lastSignature) {
      repeatedPages += 1;
      break;
    }
    lastSignature = signature;

    const before = productsById.size;
    for (const product of batch.products) {
      if (product?.productId) productsById.set(product.productId, product);
    }
    if (productsById.size <= before) {
      zeroProgressPages += 1;
      break;
    }

    pageNumber += 1;
    const totalPages = batch.totalPages || 1;
    if (pageNumber >= totalPages) break;
  }

  return {
    filters,
    pages,
    products: [...productsById.values()],
    repeated_pages: repeatedPages,
    zero_progress_pages: zeroProgressPages,
    exhausted: repeatedPages === 0 && zeroProgressPages === 0,
    last_total_available_cruises: lastResponse?.totalAvailableCruises || 0,
    apiCalls,
    cookieJar
  };
}

function buildProductHarvestPlans(filterIndex = {}) {
  const byType = filterIndex.byType || {};
  const plans = [];

  for (const [leftType, rightType] of PRODUCT_HARVEST_PAIRS) {
    const left = byType[leftType] || [];
    const right = byType[rightType] || [];
    for (const a of left) {
      for (const b of right) {
        plans.push({
          strategy: `${leftType}_x_${rightType}`,
          filters: [a.filterValue, b.filterValue]
        });
      }
    }
  }

  for (const type of PRODUCT_HARVEST_SINGLETON_TYPES) {
    for (const entry of byType[type] || []) {
      plans.push({
        strategy: `singleton_${type}`,
        filters: [entry.filterValue]
      });
    }
  }

  return plans;
}

async function harvestDisneyProductCatalogue(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    cookieJar: initialJar = {},
    requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
    maxApiCalls = DEFAULT_MAX_API_CALLS,
    maxPagesPerPlan = DEFAULT_MAX_PRODUCT_PAGES,
    filterOptions = null
  } = options;

  let cookieJar = { ...initialJar };
  if (!cookieHeaderFromJar(cookieJar)) {
    const auth = await authenticateDisneySession({ fetchImpl, cookieJar, requestDelayMs });
    cookieJar = auth.cookieJar;
  }

  const filtersResult =
    filterOptions ||
    (await fetchDisneyFilterOptions({ fetchImpl, cookieJar, requestDelayMs }));
  cookieJar = filtersResult.cookieJar || cookieJar;

  const plans = buildProductHarvestPlans(filtersResult);
  const productsById = new Map();
  const planSummaries = [];
  let apiCalls = 0;
  let repeatedPages = 0;
  let zeroProgressPages = 0;
  let advertisedTotals = [];

  for (const plan of plans) {
    if (apiCalls >= maxApiCalls) break;
    const remainingCalls = Math.max(0, maxApiCalls - apiCalls);
    if (remainingCalls <= 0) break;
    const batch = await paginateDisneyProductsForFilters(plan.filters, {
      fetchImpl,
      cookieJar,
      requestDelayMs,
      maxPages: maxPagesPerPlan,
      maxApiCalls: remainingCalls
    });
    cookieJar = batch.cookieJar || cookieJar;
    apiCalls += batch.apiCalls;
    repeatedPages += batch.repeated_pages;
    zeroProgressPages += batch.zero_progress_pages;
    if (batch.last_total_available_cruises) advertisedTotals.push(batch.last_total_available_cruises);

    const before = productsById.size;
    for (const product of batch.products) {
      if (product?.productId) productsById.set(product.productId, product);
    }

    planSummaries.push({
      strategy: plan.strategy,
      filters: plan.filters,
      pages_fetched: batch.pages.length,
      products_returned: batch.products.length,
      unique_products_added: productsById.size - before,
      repeated_pages: batch.repeated_pages,
      zero_progress_pages: batch.zero_progress_pages
    });
  }

  return {
    cookieJar,
    filter_count: filtersResult.filter_count,
    harvest_plans: planSummaries.length,
    products: [...productsById.values()],
    unique_product_templates: productsById.size,
    api_calls: apiCalls,
    repeated_pages: repeatedPages,
    zero_progress_pages: zeroProgressPages,
    source_advertised_totals_sample: advertisedTotals.slice(0, 5),
    monthly_advertised_sum_hint:
      "Sum of per-month totalAvailableCruises across date facets equals catalogue-wide advertised total (651 at probe time)"
  };
}

async function fetchDisneyAvailableSailings(productId, itineraryId = "", options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    cookieJar = {},
    requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
    filters = []
  } = options;
  if (requestDelayMs) await sleep(requestDelayMs);
  const result = await disneyFetchJson(`${VAS_BASE}/available-sailings/`, {
    method: "POST",
    body: defaultRequestBody({
      filters,
      productId,
      itineraryId: itineraryId ?? ""
    }),
    cookieJar,
    fetchImpl
  });
  const sailings = Array.isArray(result.payload?.sailings) ? result.payload.sailings : [];
  return {
    ...result,
    productId,
    itineraryId,
    sailings,
    errorCode: result.payload?.errorCode || null
  };
}

function parseRawSailing(raw, context = {}) {
  if (!raw || typeof raw !== "object") return null;
  const departure_date = normaliseIsoDate(raw.sailDateFrom);
  const return_date = normaliseIsoDate(raw.sailDateTo);
  const sailing_id = String(raw.sailingId || "").trim().toUpperCase() || null;
  if (!sailing_id || !departure_date) return null;

  const ship = raw.ship || {};
  return {
    official_product_key: officialProductKey(sailing_id, departure_date),
    sailing_id,
    package_id: raw.packageId != null ? String(raw.packageId) : null,
    package_code: String(raw.packageCode || "").trim().toUpperCase() || null,
    product_id: String(context.productId || raw.productId || "").trim() || null,
    itinerary_id: context.itineraryId != null ? String(context.itineraryId) : String(raw.itineraryId ?? ""),
    product_name: context.productName || null,
    departure_date,
    return_date,
    nights: Number(raw.numberOfNights) || null,
    destination_code: String(raw.destination || "").trim().toUpperCase() || null,
    geo_area: String(raw.geoArea || "").trim().toUpperCase() || null,
    ship_name: String(ship.name || "").trim() || null,
    ship_code: String(ship.seawareId || "").trim().toUpperCase() || null,
    ship_entity_id: String(ship.id || "").trim() || null,
    has_availability: raw.hasAvailability !== false,
    blocked_from_booking: Boolean(raw.blockedFromBooking),
    is_early_booking: Boolean(raw.isEarlyBooking),
    raw
  };
}

function expandProductTemplates(products = []) {
  const itineraryTargets = [];
  for (const product of products || []) {
    const productId = String(product?.productId || "").trim();
    const productName = product?.productName || product?.productDisplayName || null;
    const itineraries = Array.isArray(product?.itineraries) ? product.itineraries : [];
    for (const itinerary of itineraries) {
      itineraryTargets.push({
        productId,
        productName,
        itineraryId: itinerary?.itineraryId ?? "",
        numberOfSailings: Number(itinerary?.numberOfSailings) || 0,
        embeddedSampleCount: Array.isArray(itinerary?.sailings) ? itinerary.sailings.length : 0
      });
    }
  }
  return itineraryTargets;
}

async function expandDisneySailingCatalogue(products, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    cookieJar = {},
    requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
    maxApiCalls = DEFAULT_MAX_API_CALLS
  } = options;

  const targets = expandProductTemplates(products);
  const rawRows = [];
  const byIdentity = new Map();
  let apiCalls = 0;
  let expansionErrors = 0;
  let malformedRows = 0;
  let exactDuplicateRows = 0;

  for (const target of targets) {
    if (apiCalls >= maxApiCalls) break;
    let batch;
    try {
      batch = await fetchDisneyAvailableSailings(target.productId, target.itineraryId, {
        fetchImpl,
        cookieJar,
        requestDelayMs
      });
    } catch (_error) {
      expansionErrors += 1;
      continue;
    }
    apiCalls += 1;
    if (batch.errorCode) {
      expansionErrors += 1;
      continue;
    }

    for (const raw of batch.sailings) {
      rawRows.push(raw);
      const parsed = parseRawSailing(raw, target);
      if (!parsed) {
        malformedRows += 1;
        continue;
      }
      const key = parsed.official_product_key;
      if (byIdentity.has(key)) {
        exactDuplicateRows += 1;
        continue;
      }
      byIdentity.set(key, parsed);
    }
  }

  return {
    itinerary_targets: targets.length,
    api_calls: apiCalls,
    raw_rows: rawRows.length,
    malformed_rows: malformedRows,
    exact_duplicate_rows: exactDuplicateRows,
    expansion_errors: expansionErrors,
    unique_sailings: [...byIdentity.values()],
    identity_collisions: countIdentityCollisions([...byIdentity.values()])
  };
}

function countIdentityCollisions(sailings = []) {
  const counts = new Map();
  for (const sailing of sailings) {
    const key = sailing?.official_product_key;
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let collisions = 0;
  for (const count of counts.values()) {
    if (count > 1) collisions += 1;
  }
  return collisions;
}

function summariseInventory(sailings = [], { perthToday = perthCalendarDate() } = {}) {
  const items = sailings.map((s) => ({ departure_date: s.departure_date, status: "active" }));
  const partition = partitionByPublicBookingCutoff(items, (item) => item.departure_date, perthToday);

  const shipCounts = {};
  let pastDepartures = 0;
  let futureTotal = 0;
  for (const sailing of sailings) {
    const name = sailing.ship_name || "UNKNOWN";
    shipCounts[name] = (shipCounts[name] || 0) + 1;
    const dep = sailing.departure_date;
    if (!dep) continue;
    if (dep < perthToday) pastDepartures += 1;
    else futureTotal += 1;
  }

  const futureDates = sailings
    .map((s) => s.departure_date)
    .filter((d) => d && d >= perthToday)
    .sort();

  return {
    perth_today: perthToday,
    public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    public_booking_cutoff_date: publicBookingCutoffDate(perthToday),
    public_booking_minimum_departure_date: publicBookingMinimumDepartureDate(perthToday),
    future_total: futureTotal,
    within_21_day_cutoff: partition.withinCutoff.length,
    publicly_eligible_total: partition.publiclyEligible.filter(
      (item) => item.departure_date && item.departure_date >= perthToday
    ).length,
    past_departures: pastDepartures,
    earliest_departure: futureDates[0] || null,
    latest_departure: futureDates[futureDates.length - 1] || null,
    ship_counts: shipCounts
  };
}

function buildSourceAccounting({ harvest, expansion, monthlyAdvertisedSum = null, perthToday = perthCalendarDate() }) {
  const unique = expansion.unique_sailings.length;
  const identityCoverage =
    unique === 0
      ? 0
      : Math.round(
          (expansion.unique_sailings.filter((s) => s.official_product_key).length / unique) * 10000
        ) / 100;

  const reconcilesAgainstMonthlySum =
    monthlyAdvertisedSum == null ? null : unique === Number(monthlyAdvertisedSum);

  return {
    product_templates_discovered: harvest.unique_product_templates,
    product_harvest_api_calls: harvest.api_calls,
    product_harvest_repeated_pages: harvest.repeated_pages,
    product_harvest_zero_progress_pages: harvest.zero_progress_pages,
    itinerary_expansion_targets: expansion.itinerary_targets,
    sailing_expansion_api_calls: expansion.api_calls,
    raw_sailing_rows: expansion.raw_rows,
    malformed_rows: expansion.malformed_rows,
    exact_duplicate_rows: expansion.exact_duplicate_rows,
    expansion_errors: expansion.expansion_errors,
    unique_individual_sailings: unique,
    identity_coverage_pct: identityCoverage,
    duplicate_official_identities: expansion.identity_collisions,
    monthly_advertised_sum: monthlyAdvertisedSum,
    reconciles_with_monthly_advertised_sum: reconcilesAgainstMonthlySum,
    perth_today: perthToday,
    notes: [
      "available-products pagination repeats for unfiltered requests — faceted union required",
      "filters must use filterValue tokens (ship codes), not option entity ids",
      "totalAvailableCruises on unfiltered page is sailing-count metadata, not unique product templates"
    ]
  };
}

async function probeDisneyInventory(options = {}) {
  const startedAt = new Date().toISOString();
  const perthToday = options.perthToday || perthCalendarDate();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const requestDelayMs = options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;

  const auth = await authenticateDisneySession({ fetchImpl, requestDelayMs });
  const filters = await fetchDisneyFilterOptions({
    fetchImpl,
    cookieJar: auth.cookieJar,
    requestDelayMs
  });

  const dateFacetTotals = [];
  for (const entry of filters.byType.date || []) {
    const page = await fetchDisneyAvailableProductsPage([entry.filterValue], 0, {
      fetchImpl,
      cookieJar: filters.cookieJar,
      requestDelayMs
    });
    dateFacetTotals.push({
      month: entry.name || entry.filterValue,
      totalAvailableCruises: page.totalAvailableCruises
    });
  }
  const monthlyAdvertisedSum = dateFacetTotals.reduce((sum, row) => sum + (row.totalAvailableCruises || 0), 0);

  const harvest = await harvestDisneyProductCatalogue({
    fetchImpl,
    cookieJar: filters.cookieJar,
    requestDelayMs,
    filterOptions: filters,
    maxApiCalls: options.maxApiCalls
  });

  const expansion = await expandDisneySailingCatalogue(harvest.products, {
    fetchImpl,
    cookieJar: harvest.cookieJar,
    requestDelayMs,
    maxApiCalls: options.maxApiCalls
  });

  const inventory = summariseInventory(expansion.unique_sailings, { perthToday });
  const sourceAccounting = buildSourceAccounting({
    harvest,
    expansion,
    monthlyAdvertisedSum,
    perthToday
  });

  return {
    phase: 1,
    read_only: true,
    writes: 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    source_contract: SOURCE_CONTRACT,
    date_facet_advertised_totals: dateFacetTotals,
    monthly_advertised_sum: monthlyAdvertisedSum,
    harvest,
    expansion,
    sailings: expansion.unique_sailings,
    inventory,
    source_accounting: sourceAccounting,
    identity: {
      strategy: SOURCE_CONTRACT.official_identity_formula,
      coverage_pct: sourceAccounting.identity_coverage_pct,
      collisions: sourceAccounting.duplicate_official_identities
    }
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  USER_AGENT,
  SITE_ORIGIN,
  VAS_BASE,
  SOURCE_CONTRACT,
  DEFAULT_PARTY_MIX,
  PRODUCT_HARVEST_PAIRS,
  PRODUCT_HARVEST_SINGLETON_TYPES,
  normaliseIsoDate,
  officialProductKey,
  officialProductKeyFromRaw,
  parseRawSailing,
  parseAvailableProductsResponse,
  productPageSignature,
  indexFilterOptions,
  buildProductHarvestPlans,
  expandProductTemplates,
  countIdentityCollisions,
  summariseInventory,
  buildSourceAccounting,
  authenticateDisneySession,
  fetchDisneyFilterOptions,
  fetchDisneyAvailableProductsPage,
  paginateDisneyProductsForFilters,
  harvestDisneyProductCatalogue,
  fetchDisneyAvailableSailings,
  expandDisneySailingCatalogue,
  probeDisneyInventory
};
