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
const catalogue = require("./disney-discovery-catalogue");

const ADAPTER_ID = "disney";
const ADAPTER_VERSION = "2026-08-15.dcl2a";
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
const DEFAULT_MAX_API_CALLS = 2000;
const PHASE2_MAX_API_CALLS = 2500;
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
  return catalogue.productPageSignature(products);
}

function productPageStructuralSignature(products = []) {
  return catalogue.productPageStructuralSignature(products);
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
    requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
    losslessCatalogue = null,
    lastWriteWins = null,
    strategy = null
  } = options;

  let cookieJar = { ...initialJar };
  const pages = [];
  const productsById = new Map();
  let pageNumber = 0;
  let apiCalls = 0;
  let repeatedPages = 0;
  let trueRepeatedPages = 0;
  let zeroProgressPages = 0;
  let zeroStructuralProgressPages = 0;
  let structurallyNewPages = 0;
  let lastSignature = null;
  let lastStructuralSignature = null;
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
    const structuralSignature = productPageStructuralSignature(batch.products);
    pages.push({
      filters,
      pageNumber,
      products_returned: batch.products.length,
      totalPages: batch.totalPages,
      totalAvailableCruises: batch.totalAvailableCruises,
      signature,
      structural_signature: catalogue.hashSignature(structuralSignature)
    });

    if (!batch.products.length) break;

    if (structuralSignature && structuralSignature === lastStructuralSignature) {
      trueRepeatedPages += 1;
      repeatedPages += 1;
      break;
    }
    if (signature && signature === lastSignature && !losslessCatalogue) {
      repeatedPages += 1;
      break;
    }
    lastSignature = signature;
    lastStructuralSignature = structuralSignature;

    let structuralAdded = 0;
    const beforeIds = productsById.size;
    for (const product of batch.products) {
      if (lastWriteWins && product?.productId) {
        lastWriteWins.set(String(product.productId), product);
      }
      if (losslessCatalogue) {
        const result = losslessCatalogue.ingest(product, { filters, strategy });
        structuralAdded += result.newStructuralKeys;
      } else if (product?.productId) {
        productsById.set(product.productId, product);
      }
    }

    if (losslessCatalogue) {
      if (structuralAdded === 0) {
        zeroStructuralProgressPages += 1;
        break;
      }
      structurallyNewPages += 1;
    } else if (productsById.size <= beforeIds) {
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
    products: losslessCatalogue ? losslessCatalogue.toProductsArray() : [...productsById.values()],
    repeated_pages: repeatedPages,
    true_repeated_pages: trueRepeatedPages,
    zero_progress_pages: zeroProgressPages,
    zero_structural_progress_pages: zeroStructuralProgressPages,
    structurally_new_pages: structurallyNewPages,
    exhausted: repeatedPages === 0 && zeroProgressPages === 0 && zeroStructuralProgressPages === 0,
    last_total_available_cruises: lastResponse?.totalAvailableCruises || 0,
    apiCalls,
    cookieJar
  };
}

function buildProductHarvestPlans(filterIndex = {}, { phase2 = false } = {}) {
  if (phase2) {
    return catalogue.buildPhase2HarvestPlans(filterIndex);
  }
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
    filterOptions = null,
    phase2 = false,
    useLosslessCatalogue = true
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

  const plans = buildProductHarvestPlans(filtersResult, { phase2 });
  const losslessCatalogue = useLosslessCatalogue ? new catalogue.LosslessProductCatalogue() : null;
  const lastWriteWins = new Map();
  const planSummaries = [];
  let apiCalls = 0;
  let repeatedPages = 0;
  let trueRepeatedPages = 0;
  let zeroProgressPages = 0;
  let zeroStructuralProgressPages = 0;
  let structurallyNewPages = 0;
  let advertisedTotals = [];
  const requestCache = new Map();

  for (const plan of plans) {
    if (apiCalls >= maxApiCalls) break;
    const cacheKey = `${plan.strategy}|${plan.filters.join(",")}`;
    if (requestCache.has(cacheKey)) continue;
    requestCache.set(cacheKey, true);

    const remainingCalls = Math.max(0, maxApiCalls - apiCalls);
    if (remainingCalls <= 0) break;
    const batch = await paginateDisneyProductsForFilters(plan.filters, {
      fetchImpl,
      cookieJar,
      requestDelayMs,
      maxPages: maxPagesPerPlan,
      maxApiCalls: remainingCalls,
      losslessCatalogue,
      lastWriteWins,
      strategy: plan.strategy
    });
    cookieJar = batch.cookieJar || cookieJar;
    apiCalls += batch.apiCalls;
    repeatedPages += batch.repeated_pages;
    trueRepeatedPages += batch.true_repeated_pages || 0;
    zeroProgressPages += batch.zero_progress_pages;
    zeroStructuralProgressPages += batch.zero_structural_progress_pages || 0;
    structurallyNewPages += batch.structurally_new_pages || 0;
    if (batch.last_total_available_cruises) advertisedTotals.push(batch.last_total_available_cruises);

    planSummaries.push({
      strategy: plan.strategy,
      filters: plan.filters,
      pages_fetched: batch.pages.length,
      products_returned: batch.products.length,
      repeated_pages: batch.repeated_pages,
      zero_progress_pages: batch.zero_progress_pages,
      zero_structural_progress_pages: batch.zero_structural_progress_pages || 0,
      structurally_new_pages: batch.structurally_new_pages || 0,
      total_available_cruises: batch.last_total_available_cruises || 0
    });
  }

  const products = losslessCatalogue ? losslessCatalogue.toProductsArray() : [];
  const variantAnalysis = losslessCatalogue
    ? catalogue.analyzeProductVariantCollapse(losslessCatalogue, [...lastWriteWins.values()])
    : null;

  return {
    cookieJar,
    filter_count: filtersResult.filter_count,
    harvest_plans: planSummaries.length,
    harvest_plan_summaries: planSummaries,
    products,
    unique_product_templates: losslessCatalogue ? losslessCatalogue.uniqueProductIds : products.length,
    unique_itinerary_targets: losslessCatalogue ? losslessCatalogue.uniqueItineraryTargets : expandProductTemplates(products).length,
    api_calls: apiCalls,
    repeated_pages: repeatedPages,
    true_repeated_pages: trueRepeatedPages,
    zero_progress_pages: zeroProgressPages,
    zero_structural_progress_pages: zeroStructuralProgressPages,
    structurally_new_pages: structurallyNewPages,
    source_advertised_totals_sample: advertisedTotals.slice(0, 5),
    lossless_catalogue: losslessCatalogue,
    last_write_wins_products: [...lastWriteWins.values()],
    product_variant_analysis: variantAnalysis,
    phase2
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

async function expandDisneySailingCatalogueLossless(targetsOrCatalogue, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    cookieJar = {},
    requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
    maxApiCalls = DEFAULT_MAX_API_CALLS,
    preserveFilterContext = true,
    losslessCatalogue = null
  } = options;

  let targets;
  if (losslessCatalogue && typeof losslessCatalogue.getExpansionTargets === "function") {
    targets = losslessCatalogue.getExpansionTargets();
  } else if (Array.isArray(targetsOrCatalogue) && targetsOrCatalogue[0]?.expansionKey) {
    targets = targetsOrCatalogue;
  } else {
    targets = expandProductTemplates(targetsOrCatalogue).map((t) => ({
      ...t,
      expansionKey: `${t.productId}|${t.itineraryId ?? ""}`,
      discoveredViaFilters: []
    }));
  }

  const rawRows = [];
  const byIdentity = new Map();
  const requestCache = new Map();
  let apiCalls = 0;
  let expansionErrors = 0;
  let malformedRows = 0;
  let exactDuplicateRows = 0;

  for (const target of targets) {
    if (apiCalls >= maxApiCalls) break;

    const filterVariants = [[]];
    if (preserveFilterContext && Array.isArray(target.discoveredViaFilters) && target.discoveredViaFilters.length) {
      filterVariants.push(target.discoveredViaFilters);
    }

    const seenVariants = new Set();
    for (const filters of filterVariants) {
      const variantKey = `${target.productId}|${target.itineraryId ?? ""}|${filters.join("\u0000")}`;
      if (seenVariants.has(variantKey) || requestCache.has(variantKey)) continue;
      seenVariants.add(variantKey);

      let batch;
      try {
        batch = await fetchDisneyAvailableSailings(target.productId, target.itineraryId, {
          fetchImpl,
          cookieJar,
          requestDelayMs,
          filters
        });
      } catch (_error) {
        expansionErrors += 1;
        continue;
      }
      apiCalls += 1;
      requestCache.set(variantKey, true);
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

async function analyzeFilterContextOnSailings(targets = [], options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    cookieJar = {},
    requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
    sampleSize = 24,
    maxApiCalls = 200
  } = options;

  const sample = targets.slice(0, sampleSize);
  const comparisons = [];
  let apiCalls = 0;
  let contextsRevealExtraSailings = 0;

  for (const target of sample) {
    if (apiCalls >= maxApiCalls) break;

    const scenarios = [
      { label: "unfiltered", filters: [] },
      ...(target.discoveredViaFilters?.length
        ? [{ label: "originating_filters", filters: target.discoveredViaFilters }]
        : [])
    ];
    const dateOnly = (target.discoveredViaFilters || []).filter((f) => /;filterType=date$/.test(f));
    const shipOnly = (target.discoveredViaFilters || []).filter((f) => /;filterType=ship$/.test(f));
    if (dateOnly.length) scenarios.push({ label: "date_filter", filters: dateOnly });
    if (shipOnly.length) scenarios.push({ label: "ship_filter", filters: shipOnly });

    const scenarioResults = {};
    for (const scenario of scenarios) {
      if (apiCalls >= maxApiCalls) break;
      const batch = await fetchDisneyAvailableSailings(target.productId, target.itineraryId, {
        fetchImpl,
        cookieJar,
        requestDelayMs,
        filters: scenario.filters
      });
      apiCalls += 1;
      const identities = new Set(
        (batch.sailings || []).map((raw) => officialProductKeyFromRaw(raw)).filter(Boolean)
      );
      scenarioResults[scenario.label] = {
        filters: scenario.filters,
        sailing_count: batch.sailings?.length || 0,
        identities: [...identities]
      };
    }

    const unfiltered = new Set(scenarioResults.unfiltered?.identities || []);
    let extraFromContext = 0;
    for (const [label, result] of Object.entries(scenarioResults)) {
      if (label === "unfiltered") continue;
      for (const id of result.identities) {
        if (!unfiltered.has(id)) extraFromContext += 1;
      }
    }
    if (extraFromContext > 0) contextsRevealExtraSailings += 1;

    comparisons.push({
      productId: target.productId,
      itineraryId: target.itineraryId ?? "",
      expansionKey: target.expansionKey || null,
      scenarios: scenarioResults,
      filter_context_reveals_extra: extraFromContext > 0
    });
  }

  return {
    samples_tested: comparisons.length,
    api_calls: apiCalls,
    contexts_reveal_extra_sailings: contextsRevealExtraSailings,
    filter_context_matters: contextsRevealExtraSailings > 0,
    comparisons: comparisons.slice(0, 12)
  };
}

function monthFromFilterValue(filterValue) {
  const match = String(filterValue || "").match(/^(\d{4}-\d{2});filterType=date$/);
  return match ? match[1] : null;
}

function buildMonthlyReconciliationTable(advertisedByMonth = {}, sailings = []) {
  const byMonth = catalogue.groupSailingsByMonth(sailings);
  const months = new Set([...Object.keys(advertisedByMonth), ...byMonth.keys()]);
  const rows = [];

  for (const month of [...months].sort()) {
    const monthSailings = byMonth.get(month) || [];
    const identities = new Set(monthSailings.map((s) => s.official_product_key).filter(Boolean));
    const advertised = Number(advertisedByMonth[month]) || 0;
    const diff = advertised - identities.size;
    rows.push({
      month,
      advertised_total: advertised,
      unique_dated_sailings: identities.size,
      raw_rows: monthSailings.length,
      difference: diff,
      unique_sailing_ids: [...new Set(monthSailings.map((s) => s.sailing_id).filter(Boolean))],
      ships_seen: [...new Set(monthSailings.map((s) => s.ship_name).filter(Boolean))].sort(),
      product_ids: [...new Set(monthSailings.map((s) => s.product_id).filter(Boolean))].sort(),
      status: diff === 0 ? "reconciled" : diff > 0 ? "under_enumerated_vs_advertised" : "over_enumerated_vs_advertised",
      reconciles: diff === 0
    });
  }

  return rows;
}

function compareProbeIdentitySets(firstRun = [], secondRun = []) {
  const a = new Set(firstRun.map((s) => s.official_product_key || s).filter(Boolean));
  const b = new Set(secondRun.map((s) => s.official_product_key || s).filter(Boolean));
  const onlyFirst = [...a].filter((k) => !b.has(k));
  const onlySecond = [...b].filter((k) => !a.has(k));
  return {
    only_first_run: onlyFirst,
    only_second_run: onlySecond,
    common: [...a].filter((k) => b.has(k)).length,
    count_delta: onlyFirst.length + onlySecond.length,
    substantially_reproducible: onlyFirst.length + onlySecond.length <= 5
  };
}

async function fetchMonthlyAdvertisedTotals(filterOptions, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    cookieJar = {},
    requestDelayMs = DEFAULT_REQUEST_DELAY_MS
  } = options;

  const dateFacetTotals = [];
  const advertisedByMonth = {};
  let apiCalls = 0;

  for (const entry of filterOptions.byType?.date || []) {
    const page = await fetchDisneyAvailableProductsPage([entry.filterValue], 0, {
      fetchImpl,
      cookieJar,
      requestDelayMs
    });
    apiCalls += 1;
    const month = monthFromFilterValue(entry.filterValue) || entry.name || entry.filterValue;
    dateFacetTotals.push({
      month,
      filterValue: entry.filterValue,
      totalAvailableCruises: page.totalAvailableCruises || 0
    });
    advertisedByMonth[month] = page.totalAvailableCruises || 0;
  }

  const monthlyAdvertisedSum = dateFacetTotals.reduce((sum, row) => sum + (row.totalAvailableCruises || 0), 0);
  return { dateFacetTotals, advertisedByMonth, monthlyAdvertisedSum, apiCalls };
}

async function probeDisneyEnumerationPhase2a(options = {}) {
  const startedAt = new Date().toISOString();
  const perthToday = options.perthToday || perthCalendarDate();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const requestDelayMs = options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;
  const maxApiCalls = options.maxApiCalls ?? PHASE2_MAX_API_CALLS;
  const repositoryStartSha = options.repositoryStartSha || null;
  const skipFilterContextAnalysis = options.skipFilterContextAnalysis === true;

  const auth = await authenticateDisneySession({ fetchImpl, requestDelayMs });
  const filters = await fetchDisneyFilterOptions({
    fetchImpl,
    cookieJar: auth.cookieJar,
    requestDelayMs
  });

  const advertised = await fetchMonthlyAdvertisedTotals(filters, {
    fetchImpl,
    cookieJar: filters.cookieJar,
    requestDelayMs
  });

  let apiCalls = advertised.apiCalls;
  const harvest = await harvestDisneyProductCatalogue({
    fetchImpl,
    cookieJar: filters.cookieJar,
    requestDelayMs,
    filterOptions: filters,
    maxApiCalls: maxApiCalls - apiCalls,
    phase2: true,
    useLosslessCatalogue: true
  });
  apiCalls += harvest.api_calls;

  const expansion = await expandDisneySailingCatalogueLossless(harvest.products, {
    fetchImpl,
    cookieJar: harvest.cookieJar,
    requestDelayMs,
    maxApiCalls: maxApiCalls - apiCalls,
    losslessCatalogue: harvest.lossless_catalogue,
    preserveFilterContext: true
  });
  apiCalls += expansion.api_calls;

  const filterContextBudget = Math.min(120, maxApiCalls - apiCalls);
  const filterContext =
    !skipFilterContextAnalysis && filterContextBudget > 0 && harvest.lossless_catalogue
      ? await analyzeFilterContextOnSailings(harvest.lossless_catalogue.getExpansionTargets(), {
          fetchImpl,
          cookieJar: harvest.cookieJar,
          requestDelayMs,
          sampleSize: 24,
          maxApiCalls: filterContextBudget
        })
      : { samples_tested: 0, filter_context_matters: false, api_calls: 0 };
  apiCalls += filterContext.api_calls || 0;

  const inventory = summariseInventory(expansion.unique_sailings, { perthToday });
  const monthlyReconciliation = buildMonthlyReconciliationTable(
    advertised.advertisedByMonth,
    expansion.unique_sailings
  );
  const totalAvailableCruisesSemantics = catalogue.analyzeTotalAvailableCruisesSemantics({
    advertisedByMonth: advertised.advertisedByMonth,
    sailings: expansion.unique_sailings
  });

  const variantAnalysis = harvest.product_variant_analysis || {};
  const identityCoverage =
    expansion.unique_sailings.length === 0
      ? 0
      : Math.round(
          (expansion.unique_sailings.filter((s) => s.official_product_key).length /
            expansion.unique_sailings.length) *
            10000
        ) / 100;

  const pagesFetched = (harvest.harvest_plan_summaries || []).reduce(
    (sum, p) => sum + (p.pages_fetched || 0),
    0
  );

  const qualityGate = {
    source_complete: expansion.expansion_errors === 0 && apiCalls < maxApiCalls,
    accounting_explained: Boolean(totalAvailableCruisesSemantics.conclusion),
    identity_coverage_pct: identityCoverage,
    duplicate_official_identities: expansion.identity_collisions,
    expansion_errors: expansion.expansion_errors,
    ready_for_phase2b:
      expansion.identity_collisions === 0 &&
      identityCoverage === 100 &&
      expansion.expansion_errors === 0 &&
      (variantAnalysis.itinerary_targets_after_fix ?? harvest.unique_itinerary_targets) >=
        (variantAnalysis.itinerary_targets_before_fix ?? 0)
  };

  const blockers = [];
  if (expansion.expansion_errors > 0) blockers.push(`${expansion.expansion_errors} expansion errors`);
  if (expansion.identity_collisions > 0) blockers.push("identity collisions detected");
  if (apiCalls >= maxApiCalls) blockers.push("API call budget exhausted");

  return {
    phase: "2A",
    read_only: true,
    production_writes: 0,
    database_mutations: 0,
    repository_start_sha: repositoryStartSha,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    source_contract: SOURCE_CONTRACT,
    phase1_baseline: {
      unique_sailings: 484,
      advertised_month_sum: advertised.monthlyAdvertisedSum,
      apparent_gap: advertised.monthlyAdvertisedSum - expansion.unique_sailings.length
    },
    product_variant_analysis: {
      unique_product_ids: variantAnalysis.unique_product_ids ?? harvest.unique_product_templates,
      structural_product_variants: variantAnalysis.structural_product_variants ?? harvest.unique_itinerary_targets,
      multi_variant_product_ids: variantAnalysis.product_ids_with_multiple_structural_variants ?? 0,
      duplicate_product_id_occurrences: variantAnalysis.duplicate_product_id_occurrences ?? 0,
      itinerary_targets_before_fix: variantAnalysis.itinerary_targets_before_fix ?? null,
      itinerary_targets_after_fix: variantAnalysis.itinerary_targets_after_fix ?? harvest.unique_itinerary_targets,
      lost_itineraries_recovered: variantAnalysis.lost_itineraries_recovered ?? 0,
      itineraries_lost_by_current_last_write_wins_logic:
        variantAnalysis.itineraries_lost_by_current_last_write_wins_logic ?? 0,
      sailing_capacity_lost_by_current_last_write_wins_logic:
        variantAnalysis.sailing_capacity_lost_by_current_last_write_wins_logic ?? 0
    },
    enumeration: {
      raw_sailing_rows: expansion.raw_rows,
      unique_sailings: expansion.unique_sailings.length,
      identity_collisions: expansion.identity_collisions,
      future_total: inventory.future_total,
      within_21_day_cutoff: inventory.within_21_day_cutoff,
      publicly_eligible_total: inventory.publicly_eligible_total,
      earliest_departure: inventory.earliest_departure,
      latest_departure: inventory.latest_departure,
      ship_counts: inventory.ship_counts,
      itinerary_expansion_targets: expansion.itinerary_targets,
      api_calls_total: apiCalls,
      api_calls_budget: maxApiCalls
    },
    monthly_reconciliation: monthlyReconciliation,
    totalAvailableCruises_semantics: totalAvailableCruisesSemantics,
    filter_context_analysis: filterContext,
    pagination_accounting: {
      pages_fetched: pagesFetched,
      true_repeated_pages: harvest.true_repeated_pages,
      structurally_new_pages: harvest.structurally_new_pages,
      zero_structural_progress_pages: harvest.zero_structural_progress_pages,
      zero_progress_pages: harvest.zero_progress_pages,
      unique_product_ids: harvest.unique_product_templates,
      unique_product_variants: harvest.unique_itinerary_targets,
      unique_itinerary_targets: harvest.unique_itinerary_targets,
      harvest_plans: harvest.harvest_plans
    },
    harvest_plan_summaries: harvest.harvest_plan_summaries,
    date_facet_advertised_totals: advertised.dateFacetTotals,
    monthly_advertised_sum: advertised.monthlyAdvertisedSum,
    sailings: expansion.unique_sailings,
    inventory,
    quality_gate: qualityGate,
    blockers,
    recommendation:
      blockers.length === 0 && qualityGate.ready_for_phase2b
        ? "Proceed to Phase 2B adapter mapping with lossless catalogue architecture"
        : "Resolve blockers before Phase 2B — do not import to production"
  };
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
  PHASE2_MAX_API_CALLS,
  normaliseIsoDate,
  officialProductKey,
  officialProductKeyFromRaw,
  parseRawSailing,
  parseAvailableProductsResponse,
  productPageSignature,
  productPageStructuralSignature,
  indexFilterOptions,
  buildProductHarvestPlans,
  expandProductTemplates,
  countIdentityCollisions,
  summariseInventory,
  buildSourceAccounting,
  monthFromFilterValue,
  buildMonthlyReconciliationTable,
  compareProbeIdentitySets,
  authenticateDisneySession,
  fetchDisneyFilterOptions,
  fetchDisneyAvailableProductsPage,
  fetchMonthlyAdvertisedTotals,
  paginateDisneyProductsForFilters,
  harvestDisneyProductCatalogue,
  fetchDisneyAvailableSailings,
  expandDisneySailingCatalogue,
  expandDisneySailingCatalogueLossless,
  analyzeFilterContextOnSailings,
  probeDisneyInventory,
  probeDisneyEnumerationPhase2a
};
