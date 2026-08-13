/**
 * Seabourn Cruise Line — official Carnival Solr catalogue source (read-only).
 *
 * GET https://www.seabourn.com/search/sbncruisesearch
 */

const carnivalSolr = require("./carnival-solr-discovery");

const ADAPTER_ID = "seabourn";
const ADAPTER_VERSION = "2026-08-13.sbn1";

const SOURCE_CONTRACT = {
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  primary_endpoint: "https://www.seabourn.com/search/sbncruisesearch",
  method: "GET",
  catalogue_query: "*:*",
  filter_query: "type:cruise AND cruiseId:[* TO *]",
  sort: "departDate asc",
  query_parameters: {
    q: "Wildcard catalogue query — default *:*",
    fq: "type:cruise AND cruiseId:[* TO *]",
    sort: "departDate asc",
    size: "Requested page size (API returns ~12 docs/page regardless)",
    start: "Zero-based Solr offset"
  },
  required_headers: {
    Accept: "application/json",
    "User-Agent": carnivalSolr.DEFAULT_USER_AGENT
  },
  pagination:
    "Solr start/size; API returns ~12 docs per request regardless of size param; paginate until start >= numFound",
  locale: "en/au official URLs; Solr docs use en_us locale fields",
  authentication_required: false,
  cookies_required: false,
  response_format: "JSON — response.docs[] cruise records (type=cruise)",
  public_website_intended: true,
  individual_itinerary_url_pattern:
    "https://www.seabourn.com/en/au/find-a-cruise/{itineraryId_lower}/{cruiseId_lower}",
  official_identity_formula: "{itineraryId}|{cruiseId}",
  json_ld_fallback: "TouristTrip schema on individual find-a-cruise pages"
};

const DEFAULT_LOCALE_PATH = "en/au";
const DEFAULT_PAGE_SIZE = carnivalSolr.DEFAULT_PAGE_SIZE;
const DEFAULT_MAX_API_CALLS = carnivalSolr.DEFAULT_MAX_API_CALLS;

const fetchCache = new Map();

function officialProductKeyFromDoc(doc) {
  const itineraryId = String(doc?.itineraryId || "").trim();
  const cruiseId = String(doc?.cruiseId || "").trim();
  if (itineraryId && cruiseId) return `${itineraryId}|${cruiseId}`;
  return [cruiseId, doc?.departDate ? String(doc.departDate).slice(0, 10) : "", doc?.shipId || ""]
    .filter(Boolean)
    .join("|");
}

function getSearchConfig(overrides = {}) {
  return {
    endpoint: overrides.endpoint || SOURCE_CONTRACT.primary_endpoint,
    headers: { ...SOURCE_CONTRACT.required_headers, ...(overrides.headers || {}) },
    query: overrides.query || SOURCE_CONTRACT.catalogue_query,
    filterQuery: overrides.filterQuery || SOURCE_CONTRACT.filter_query,
    sort: overrides.sort || SOURCE_CONTRACT.sort
  };
}

async function fetchSeabournSearchPage(options = {}) {
  const { start = 0, size = DEFAULT_PAGE_SIZE, fetchImpl = globalThis.fetch } = options;
  return fetchCarnivalSearchPage(getSearchConfig(options), {
    start,
    size,
    fetchImpl,
    cache: options.cache ?? fetchCache
  });
}

async function fetchCarnivalSearchPage(config, pageOptions) {
  return carnivalSolr.fetchCarnivalSearchPage(config, pageOptions);
}

async function fetchSeabournCatalogue(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cache = options.useCache === false ? null : fetchCache;
  const result = await carnivalSolr.fetchCarnivalCatalogue(getSearchConfig(options), {
    pageSize: options.pageSize || DEFAULT_PAGE_SIZE,
    maxApiCalls: options.maxApiCalls || DEFAULT_MAX_API_CALLS,
    fetchImpl,
    cache,
    isValidDoc: (doc) => Boolean(doc?.cruiseId && doc?.departDate),
    getProductKey: officialProductKeyFromDoc
  });

  return {
    ...result,
    source: "sbncruisesearch",
    endpoint: SOURCE_CONTRACT.primary_endpoint
  };
}

function clearSeabournFetchCache() {
  carnivalSolr.clearFetchCache(fetchCache);
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  DEFAULT_LOCALE_PATH,
  DEFAULT_PAGE_SIZE,
  DEFAULT_MAX_API_CALLS,
  officialProductKeyFromDoc,
  fetchSeabournSearchPage,
  fetchSeabournCatalogue,
  clearSeabournFetchCache
};
