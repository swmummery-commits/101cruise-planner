/**
 * Royal Caribbean Group — shared GraphQL cruise search source layer.
 * Celebrity and Royal Caribbean use the same /graph pagination contract.
 * Field contracts must be validated per brand before sharing adapters.
 */

const USER_AGENT = "101cruise-discovery/1.0 (+https://101cruise.com.au)";

const DEFAULT_SEARCH_QUERY = `
query CruisesSearchResults($filters: String, $pagination: CruiseSearchPagination) {
  cruiseSearch(filters: $filters, pagination: $pagination) {
    results {
      total
      cruises {
        id
        productViewLink
        masterSailing {
          itinerary {
            name
            code
            voyageType
            sailingNights
            totalNights
            departurePort { code name }
            destination { code name }
            ship { code name }
            preTour { duration }
            postTour { duration }
          }
        }
        sailings {
          id
          sailDate
          startDate
          endDate
        }
      }
    }
  }
}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRcgSearchPage({
  graphUrl,
  skip = 0,
  count = 25,
  filters = "{}",
  query = DEFAULT_SEARCH_QUERY,
  userAgent = USER_AGENT
} = {}) {
  const response = await fetch(graphUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": userAgent
    },
    body: JSON.stringify({
      query,
      variables: { filters, pagination: { count, skip } }
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) {
    return {
      ok: false,
      error: body.errors?.[0]?.message || `http_${response.status}`,
      cruises: [],
      total: 0,
      skip
    };
  }
  const results = body.data?.cruiseSearch?.results || {};
  return {
    ok: true,
    total: results.total ?? 0,
    cruises: results.cruises || [],
    skip
  };
}

async function fetchRcgInventoryPages({
  graphUrl,
  pageSize = 25,
  maxPages = null,
  maxGroups = null,
  startSkip = 0,
  requestDelayMs = 150,
  filters = "{}",
  query = DEFAULT_SEARCH_QUERY
} = {}) {
  const pageLog = [];
  const groups = [];
  const seenGroupIds = new Set();
  let totalOfficial = 0;
  let page = 0;
  let skip = Math.max(0, Number(startSkip) || 0);

  while (true) {
    if (maxPages != null && page >= maxPages) break;
    const batch = await fetchRcgSearchPage({ graphUrl, skip, count: pageSize, filters, query });
    pageLog.push({
      skip,
      ok: batch.ok,
      returned: batch.cruises?.length || 0,
      total: batch.total
    });
    if (!batch.ok) break;
    totalOfficial = batch.total || totalOfficial;
    for (const doc of batch.cruises || []) {
      if (!doc?.id || seenGroupIds.has(doc.id)) continue;
      seenGroupIds.add(doc.id);
      groups.push(doc);
      if (maxGroups != null && groups.length >= maxGroups) break;
    }
    if (maxGroups != null && groups.length >= maxGroups) break;
    if (skip + pageSize >= totalOfficial || !(batch.cruises?.length)) break;
    skip += pageSize;
    page += 1;
    if (requestDelayMs > 0) await sleep(requestDelayMs);
  }

  return {
    ok: pageLog.some((p) => p.ok),
    total_official: totalOfficial,
    groups,
    page_log: pageLog,
    pagination_requests: pageLog.length,
    start_skip: Math.max(0, Number(startSkip) || 0),
    next_skip: skip + (pageLog.length ? pageSize : 0),
    duplicate_group_ids_suppressed: Math.max(0, pageLog.reduce((n, p) => n + (p.returned || 0), 0) - groups.length)
  };
}

module.exports = {
  USER_AGENT,
  DEFAULT_SEARCH_QUERY,
  fetchRcgSearchPage,
  fetchRcgInventoryPages
};
