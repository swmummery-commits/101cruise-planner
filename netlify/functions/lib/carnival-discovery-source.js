/**
 * Carnival Cruise Line — official AU cruise-search API source (read-only).
 *
 * GET https://www.carnival.com.au/cruisesearch/api/search
 *
 * Not HAL/Seabourn Solr — uses pageNumber/pagesize and results.itineraries[].
 */

const DEFAULT_USER_AGENT = "101cruise-discovery/1.0 (+https://101cruise.com.au)";
const DEFAULT_BASE_URL = "https://www.carnival.com.au";
const DEFAULT_SEARCH_PATH = "/cruisesearch/api/search";
const DEFAULT_LOCALITY = "7";
const DEFAULT_CURRENCY = "AUD";
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_API_CALLS = 12;
const DEFAULT_SORT = "fromprice";

const SOURCE_ID = "ccl_cruisesearch_api";
const ADAPTER_ID = "carnival-cruise-line";
const ADAPTER_VERSION = "2026-08-15.ccl1";

const SOURCE_CONTRACT = Object.freeze({
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  structured_source: SOURCE_ID,
  primary_endpoint: `${DEFAULT_BASE_URL}${DEFAULT_SEARCH_PATH}`,
  host: DEFAULT_BASE_URL,
  method: "GET",
  pagination: "1-based pageNumber/pagesize; results.totalResults/currentPage/lastPage; stop at lastPage or empty page",
  locale: "en-AU official host; locality=7 currency=AUD",
  authentication_required: false,
  cookies_required: false,
  response_format: "JSON — results.itineraries[] with nested sailings[]",
  public_website_intended: true,
  official_identity_formula: "{sailingId} primary; composite {itineraryCode}|{shipCode}|{departureDate}",
  query_parameters: {
    pageNumber: "1-based page index",
    pagesize: "Itineraries per page (200 recommended)",
    sort: "fromprice default",
    numadults: "Guest count (default 2)",
    locality: "7 = Australia",
    currency: "AUD"
  }
});

const fetchCache = new Map();

function buildSearchUrl({
  baseUrl = DEFAULT_BASE_URL,
  path = DEFAULT_SEARCH_PATH,
  pageNumber = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  sort = DEFAULT_SORT,
  numAdults = 2,
  locality = DEFAULT_LOCALITY,
  currency = DEFAULT_CURRENCY,
  extraParams = {}
} = {}) {
  const url = new URL(path, baseUrl);
  url.searchParams.set("pageNumber", String(pageNumber));
  url.searchParams.set("pagesize", String(pageSize));
  url.searchParams.set("sort", sort);
  url.searchParams.set("numadults", String(numAdults));
  url.searchParams.set("locality", String(locality));
  url.searchParams.set("currency", currency);
  for (const [key, value] of Object.entries(extraParams || {})) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function itineraryPageSignature(itineraries) {
  return (itineraries || [])
    .map((row) => String(row?.id || row?.code || "").trim())
    .filter(Boolean)
    .join("|");
}

function validateSearchPayload(data) {
  if (!data || typeof data !== "object") return { ok: false, reason: "catalogue_not_object" };
  if (!data.results || typeof data.results !== "object") return { ok: false, reason: "missing_results" };
  if (!Array.isArray(data.results.itineraries)) return { ok: false, reason: "missing_itineraries_array" };
  return { ok: true };
}

async function fetchCarnivalSearchPage(options = {}) {
  const {
    pageNumber = 1,
    pageSize = DEFAULT_PAGE_SIZE,
    fetchImpl = globalThis.fetch,
    cache = fetchCache,
    baseUrl = DEFAULT_BASE_URL,
    extraParams = {}
  } = options;

  const url = buildSearchUrl({ baseUrl, pageNumber, pageSize, extraParams });
  if (cache?.has(url)) return cache.get(url);

  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": DEFAULT_USER_AGENT
    }
  });

  if (!response.ok) {
    const err = {
      ok: false,
      status: response.status,
      url,
      error: `HTTP ${response.status}`,
      pageNumber,
      docs: [],
      results: null
    };
    cache?.set(url, err);
    return err;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    const err = {
      ok: false,
      status: response.status,
      url,
      error: "invalid_json",
      pageNumber,
      docs: [],
      results: null
    };
    cache?.set(url, err);
    return err;
  }

  const validation = validateSearchPayload(data);
  if (!validation.ok) {
    const err = {
      ok: false,
      status: response.status,
      url,
      error: validation.reason,
      pageNumber,
      docs: [],
      results: data?.results || null
    };
    cache?.set(url, err);
    return err;
  }

  const result = {
    ok: true,
    status: response.status,
    url,
    pageNumber,
    data,
    results: data.results,
    filters: data.filters || null,
    source: data.source || null,
    itineraries: data.results.itineraries || [],
    totalResults: Number(data.results.totalResults) || 0,
    currentPage: Number(data.results.currentPage) || pageNumber,
    lastPage: Number(data.results.lastPage) || pageNumber
  };
  cache?.set(url, result);
  return result;
}

async function fetchCarnivalCatalogue(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cache = options.useCache === false ? null : fetchCache;
  const pageSize = Math.min(500, Math.max(1, Number(options.pageSize) || DEFAULT_PAGE_SIZE));
  const maxApiCalls = Math.max(1, Number(options.maxApiCalls) || DEFAULT_MAX_API_CALLS);
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const extraParams = options.extraParams || {};
  const fetchedAt = new Date().toISOString();

  const pages = [];
  const groupsById = new Map();
  const rawGroups = [];
  const sourceWarnings = [];
  let initialTotalResults = null;
  let finalTotalResults = null;
  let apiCalls = 0;
  let duplicateGroupRows = 0;
  let repeatedPageSignatures = 0;
  let zeroProgressPages = 0;
  let previousSignature = null;
  let pageNumber = Math.max(1, Number(options.startPage) || 1);
  let lastPage = null;
  let sourceIntegrityError = null;

  while (apiCalls < maxApiCalls) {
    const batch = await fetchCarnivalSearchPage({
      pageNumber,
      pageSize,
      fetchImpl,
      cache,
      baseUrl,
      extraParams
    });
    apiCalls += 1;

    pages.push({
      pageNumber,
      ok: batch.ok,
      url: batch.url,
      itineraries_returned: batch.itineraries?.length || 0,
      totalResults: batch.totalResults,
      currentPage: batch.currentPage,
      lastPage: batch.lastPage,
      source: batch.source
    });

    if (!batch.ok) {
      sourceIntegrityError = batch.error || "fetch_failed";
      break;
    }

    if (initialTotalResults == null) initialTotalResults = batch.totalResults;
    finalTotalResults = batch.totalResults;
    lastPage = batch.lastPage;

    const itineraries = batch.itineraries || [];
    if (!itineraries.length || batch.currentPage > batch.lastPage) {
      break;
    }

    const signature = itineraryPageSignature(itineraries);
    if (previousSignature && signature === previousSignature) {
      repeatedPageSignatures += 1;
      sourceIntegrityError = "repeated_page_signature";
      break;
    }
    previousSignature = signature;

    const idsBefore = groupsById.size;
    for (const group of itineraries) {
      rawGroups.push(group);
      const groupId = String(group?.id || "").trim();
      if (!groupId) continue;
      if (groupsById.has(groupId)) duplicateGroupRows += 1;
      else groupsById.set(groupId, group);
    }

    if (groupsById.size <= idsBefore) {
      zeroProgressPages += 1;
      sourceIntegrityError = "zero_progress_page";
      break;
    }

    if (batch.currentPage >= batch.lastPage) break;
    pageNumber += 1;
  }

  if (
    initialTotalResults != null &&
    finalTotalResults != null &&
    initialTotalResults !== finalTotalResults
  ) {
    sourceWarnings.push({
      code: "total_results_drift",
      initial: initialTotalResults,
      final: finalTotalResults
    });
  }
  if (repeatedPageSignatures) {
    sourceWarnings.push({ code: "repeated_page_signature", count: repeatedPageSignatures });
  }
  if (zeroProgressPages) {
    sourceWarnings.push({ code: "zero_progress_page", count: zeroProgressPages });
  }
  if (duplicateGroupRows) {
    sourceWarnings.push({ code: "duplicate_group_rows", count: duplicateGroupRows });
  }

  const itineraryGroups = [...groupsById.values()];

  return {
    ok: !sourceIntegrityError,
    error: sourceIntegrityError,
    source: SOURCE_ID,
    source_url: buildSearchUrl({ baseUrl, pageSize, pageNumber: 1, extraParams }),
    host: baseUrl,
    endpoint: `${baseUrl}${DEFAULT_SEARCH_PATH}`,
    fetched_at: fetchedAt,
    page_size: pageSize,
    pages_requested: pages.length,
    api_calls: apiCalls,
    initial_total_results: initialTotalResults,
    final_total_results: finalTotalResults,
    total_results_drift:
      initialTotalResults != null &&
      finalTotalResults != null &&
      initialTotalResults !== finalTotalResults,
    raw_group_count: rawGroups.length,
    unique_group_count: itineraryGroups.length,
    duplicate_group_count: duplicateGroupRows,
    source_warnings: sourceWarnings,
    itinerary_groups: itineraryGroups,
    pages,
    pagination: {
      requested_page_size: pageSize,
      observed_pages: pages.map((p) => p.itineraries_returned),
      last_page: lastPage,
      repeated_page_signatures: repeatedPageSignatures,
      zero_progress_pages: zeroProgressPages,
      exhausted:
        pages.at(-1)?.itineraries_returned === 0 ||
        (pages.at(-1)?.currentPage != null &&
          pages.at(-1)?.lastPage != null &&
          pages.at(-1).currentPage >= pages.at(-1).lastPage)
    },
    filters_echo: pages.length ? pages[0] : null
  };
}

function clearCarnivalFetchCache() {
  fetchCache.clear();
}

module.exports = {
  SOURCE_ID,
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  DEFAULT_USER_AGENT,
  DEFAULT_BASE_URL,
  DEFAULT_SEARCH_PATH,
  DEFAULT_LOCALITY,
  DEFAULT_CURRENCY,
  DEFAULT_PAGE_SIZE,
  DEFAULT_MAX_API_CALLS,
  buildSearchUrl,
  itineraryPageSignature,
  validateSearchPayload,
  fetchCarnivalSearchPage,
  fetchCarnivalCatalogue,
  clearCarnivalFetchCache
};
