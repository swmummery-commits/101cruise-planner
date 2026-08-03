/**
 * Celebrity Cruises — read-only official source probe.
 * Primary: RCG GraphQL at https://www.celebritycruises.com/graph
 */

const ADAPTER_ID = "celebrity";
const ADAPTER_VERSION = "2026-08-03.celebrity1";
const GRAPH_URL = "https://www.celebritycruises.com/graph";
const USER_AGENT = "101cruise-discovery/1.0 (+https://101cruise.com.au)";

const SOURCE_CONTRACT = {
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  primary_endpoint: GRAPH_URL,
  method: "POST",
  query_name: "CruisesSearchResults",
  pagination: "CruiseSearchPagination { count, skip }",
  authentication_required: false,
  shared_with: ["Royal Caribbean International uses same /graph pattern"],
  response_format: "GraphQL JSON — cruiseSearch.results.cruises[]"
};

const SEARCH_QUERY = `
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
  return new Promise((r) => setTimeout(r, ms));
}

function officialProductKey(cruise) {
  const sailing = cruise?.sailings?.[0];
  return sailing?.id || cruise?.id || null;
}

function classifyProductType(cruise) {
  const itin = cruise?.masterSailing?.itinerary;
  if (!itin) return "unknown";
  if (itin.preTour?.duration || itin.postTour?.duration) return "cruisetour";
  if (String(itin.voyageType || "").toUpperCase() === "RIVER") return "river";
  return "cruise";
}

function parseCelebrityCruise(doc, today) {
  const itin = doc?.masterSailing?.itinerary || {};
  const futureSailings = (doc.sailings || []).filter((s) => s.sailDate && s.sailDate >= today);
  const sailing = futureSailings[0] || doc.sailings?.[0] || null;
  const productType = classifyProductType(doc);
  const link = doc.productViewLink
    ? `https://www.celebritycruises.com/${String(doc.productViewLink).replace(/^\//, "")}`
    : null;

  return {
    official_product_key: officialProductKey({ ...doc, sailings: futureSailings.length ? futureSailings : doc.sailings }),
    group_id: doc.id,
    itinerary_code: itin.code || null,
    itinerary_name: itin.name || null,
    product_type: productType,
    ship_name: itin.ship?.name || null,
    ship_code: itin.ship?.code || null,
    departure_port: itin.departurePort?.name || null,
    departure_port_code: itin.departurePort?.code || null,
    destination_code: itin.destination?.code || null,
    destination_name: itin.destination?.name || null,
    nights: itin.sailingNights ?? itin.totalNights ?? null,
    departure_date: sailing?.sailDate || sailing?.startDate || null,
    return_date: sailing?.endDate || null,
    official_url: link,
    future_sailing_count: futureSailings.length,
    total_sailing_count: (doc.sailings || []).length,
    raw: doc
  };
}

async function fetchCelebritySearchPage({ skip = 0, count = 25, filters = "{}" } = {}) {
  const response = await fetch(GRAPH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT
    },
    body: JSON.stringify({
      query: SEARCH_QUERY,
      variables: { filters, pagination: { count, skip } }
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) {
    return {
      ok: false,
      error: body.errors?.[0]?.message || `http_${response.status}`,
      cruises: [],
      total: 0
    };
  }
  const results = body.data?.cruiseSearch?.results || {};
  return {
    ok: true,
    total: results.total ?? 0,
    cruises: results.cruises || []
  };
}

async function probeCelebrityInventory({
  maxPages = 4,
  pageSize = 25,
  maxProducts = 100,
  requestDelayMs = 150,
  today = new Date().toISOString().slice(0, 10)
} = {}) {
  const pageLog = [];
  const products = [];
  const seen = new Set();
  let totalOfficial = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const skip = page * pageSize;
    const batch = await fetchCelebritySearchPage({ skip, count: pageSize });
    pageLog.push({ skip, ok: batch.ok, returned: batch.cruises?.length || 0, total: batch.total });
    if (!batch.ok) break;
    totalOfficial = batch.total || totalOfficial;
    for (const doc of batch.cruises || []) {
      const row = parseCelebrityCruise(doc, today);
      const key = row.official_product_key || row.group_id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      products.push(row);
      if (products.length >= maxProducts) break;
    }
    if (products.length >= maxProducts || skip + pageSize >= totalOfficial) break;
    if (requestDelayMs > 0) await sleep(requestDelayMs);
  }

  const stats = summariseCelebrityProducts(products, today);
  return {
    ok: true,
    read_only: true,
    source: SOURCE_CONTRACT,
    page_log: pageLog,
    total_official: totalOfficial,
    products,
    stats
  };
}

function summariseCelebrityProducts(products, today) {
  const stats = {
    raw_products: products.length,
    genuine_cruises: 0,
    cruisetours: 0,
    river_products: 0,
    unknown_type: 0,
    with_official_identity: 0,
    future_products: 0,
    past_only: 0,
    duplicate_groups: 0
  };
  for (const p of products) {
    if (p.official_product_key || p.group_id) stats.with_official_identity += 1;
    if (p.product_type === "cruise") stats.genuine_cruises += 1;
    else if (p.product_type === "cruisetour") stats.cruisetours += 1;
    else if (p.product_type === "river") stats.river_products += 1;
    else stats.unknown_type += 1;
    if (p.departure_date && p.departure_date >= today) stats.future_products += 1;
    else if (p.future_sailing_count === 0) stats.past_only += 1;
  }
  return stats;
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  GRAPH_URL,
  SEARCH_QUERY,
  fetchCelebritySearchPage,
  parseCelebrityCruise,
  classifyProductType,
  officialProductKey,
  probeCelebrityInventory,
  summariseCelebrityProducts
};
