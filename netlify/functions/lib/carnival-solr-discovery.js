/**
 * Shared Carnival Corp Solr-style cruise search helpers (HAL, Seabourn, etc.).
 * Read-only fetch/pagination utilities — no inventory writes.
 */

const DEFAULT_USER_AGENT = "101cruise-discovery/1.0 (+https://101cruise.com.au)";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_API_CALLS = 250;

function parseCarnivalDelimited(value) {
  const text = String(value || "").trim();
  if (!text || text === "#@#") return { name: null, code: null };
  const [name, code] = text.split("#@#");
  return { name: (name || text).trim(), code: code?.trim() || null };
}

function parseCarnivalDate(iso) {
  if (!iso) return null;
  const d = String(iso).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function parsePortList(values, { excludeScenic = true } = {}) {
  return (values || [])
    .map((v) => parseCarnivalDelimited(v).name)
    .filter(Boolean)
    .filter((p) => !excludeScenic || !/^scenic cruising/i.test(p));
}

function pickLocaleField(doc, base, localePrefix = "en_us") {
  const key = `${localePrefix}_${base}`;
  if (Array.isArray(doc[key]) && doc[key].length) return doc[key];
  if (Array.isArray(doc[base]) && doc[base].length) return doc[base];
  const plain = String(base).replace(/_ss$/, "");
  if (plain !== base && Array.isArray(doc[plain]) && doc[plain].length) return doc[plain];
  if (doc[base] != null && !String(base).endsWith("_ss")) return doc[base];
  return null;
}

function buildCatalogueSearchUrl(endpoint, { query = "*", filterQuery = null, sort = null, start = 0, size = DEFAULT_PAGE_SIZE } = {}) {
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  if (filterQuery) url.searchParams.set("fq", filterQuery);
  if (sort) url.searchParams.set("sort", sort);
  url.searchParams.set("start", String(start));
  url.searchParams.set("size", String(size));
  return url.toString();
}

async function fetchCarnivalSearchPage(
  { endpoint, headers = {}, query = "*", filterQuery = null, sort = null },
  { start = 0, size = DEFAULT_PAGE_SIZE, fetchImpl = globalThis.fetch, cache = null } = {}
) {
  const url = buildCatalogueSearchUrl(endpoint, { query, filterQuery, sort, start, size });
  if (cache?.has(url)) return cache.get(url);

  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": DEFAULT_USER_AGENT,
      ...headers
    }
  });

  if (!response.ok) {
    const err = {
      ok: false,
      status: response.status,
      url,
      error: `HTTP ${response.status}`,
      docs: [],
      numFound: 0,
      start
    };
    cache?.set(url, err);
    return err;
  }

  const data = await response.json();
  const result = {
    ok: true,
    status: response.status,
    url,
    docs: data?.response?.docs || [],
    numFound: Number(data?.response?.numFound) || 0,
    start: Number(data?.response?.start ?? start)
  };
  cache?.set(url, result);
  return result;
}

function solrRowKey(doc) {
  const id = String(doc?.id || "").trim();
  if (id) return id;
  const cruiseId = String(doc?.cruiseId || "").trim();
  const itineraryId = String(doc?.itineraryId || "").trim();
  if (cruiseId && itineraryId) return `${cruiseId}|${itineraryId}`;
  return null;
}

/**
 * Paginate a Carnival Solr catalogue with defensive guards.
 */
async function fetchCarnivalCatalogue(
  searchConfig,
  {
    pageSize = DEFAULT_PAGE_SIZE,
    maxApiCalls = DEFAULT_MAX_API_CALLS,
    fetchImpl = globalThis.fetch,
    cache = null,
    isValidDoc = (doc) => Boolean(doc?.cruiseId && doc?.departDate),
    getProductKey = null
  } = {}
) {
  const requestedSize = Math.min(100, Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE));
  const limit = Math.max(1, Number(maxApiCalls) || DEFAULT_MAX_API_CALLS);

  const pages = [];
  const rawRows = [];
  const bySolrId = new Map();
  const byProductKey = new Map();
  let numFound = 0;
  let start = 0;
  let apiCalls = 0;
  let malformedDocs = 0;
  let exactSolrDuplicates = 0;
  let zeroProgressPages = 0;
  let repeatedPageSignatures = 0;
  let previousPageSignature = null;

  while (apiCalls < limit) {
    const batch = await fetchCarnivalSearchPage(searchConfig, {
      start,
      size: requestedSize,
      fetchImpl,
      cache
    });
    apiCalls += 1;
    const docs = batch.docs || [];
    pages.push({
      start,
      ok: batch.ok,
      docs_returned: docs.length,
      num_found: batch.numFound,
      url: batch.url
    });

    if (!batch.ok) break;
    numFound = batch.numFound || numFound;
    if (!docs.length) break;

    const pageSignature = docs.map((d) => solrRowKey(d) || JSON.stringify(d?.cruiseId || "")).join("|");
    if (previousPageSignature && pageSignature === previousPageSignature) {
      repeatedPageSignatures += 1;
      break;
    }
    previousPageSignature = pageSignature;

    const startBefore = start;
    start += docs.length;
    if (start <= startBefore) {
      zeroProgressPages += 1;
      break;
    }

    for (const doc of docs) {
      rawRows.push(doc);
      if (!isValidDoc(doc)) {
        malformedDocs += 1;
        continue;
      }
      const rowKey = solrRowKey(doc);
      if (rowKey && bySolrId.has(rowKey)) {
        exactSolrDuplicates += 1;
        continue;
      }
      if (rowKey) bySolrId.set(rowKey, doc);
      if (typeof getProductKey === "function") {
        const productKey = getProductKey(doc);
        if (productKey && !byProductKey.has(productKey)) byProductKey.set(productKey, doc);
      }
    }

    if (start >= numFound) break;
  }

  const uniqueDocs = getProductKey ? [...byProductKey.values()] : [...bySolrId.values()];

  return {
    numFound,
    raw_rows_fetched: rawRows.length,
    unique_solr_rows: bySolrId.size,
    exact_solr_duplicate_rows_removed: exactSolrDuplicates,
    unique_products: uniqueDocs.length,
    docs: uniqueDocs,
    raw_docs: rawRows,
    api_calls: apiCalls,
    pages,
    pagination: {
      requested_page_size: requestedSize,
      observed_docs_per_page: pages.map((p) => p.docs_returned),
      zero_progress_pages: zeroProgressPages,
      repeated_page_signatures: repeatedPageSignatures,
      exhausted: start >= numFound || !pages.at(-1)?.docs_returned
    },
    ingestion_audit: {
      malformed_docs: malformedDocs,
      exact_solr_duplicate_rows_removed: exactSolrDuplicates
    }
  };
}

function clearFetchCache(cache) {
  cache?.clear?.();
}

module.exports = {
  DEFAULT_USER_AGENT,
  DEFAULT_PAGE_SIZE,
  DEFAULT_MAX_API_CALLS,
  parseCarnivalDelimited,
  parseCarnivalDate,
  parsePortList,
  pickLocaleField,
  buildCatalogueSearchUrl,
  fetchCarnivalSearchPage,
  fetchCarnivalCatalogue,
  solrRowKey,
  clearFetchCache
};
