/**
 * Princess Cruises — read-only official source probe.
 *
 * Princess uses a Next.js cruise-search SPA (Polar Bear / UBE) backed by book.princess.com
 * services. Public Coveo enterprise search metadata is present on marketing pages.
 * This probe uses official structured voyage pages (JSON-LD) discovered from the
 * public cruise-search entry point until the book API contract is fully mapped.
 */

const { canonicalUrl } = require("./cruise-discovery-structured");
const {
  extractStructuredSailingSources,
  extractStructuredVoyages
} = require("./cruise-discovery-structured");
const { fetchSourceExcerpt } = require("./source-fetch");

const ADAPTER_ID = "princess";
const ADAPTER_VERSION = "2026-08-03.princess1";
const USER_AGENT = "101cruise-discovery/1.0 (+https://101cruise.com.au)";

const SOURCE_CONTRACT = {
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  primary_endpoint_candidates: [
    "https://www.princess.com/cruise-search/ (Next.js UBE SPA — client-side API)",
    "https://book.princess.com/ (booking backend — session/cookie likely required)",
    "Coveo REST (organization: princesscruisesandtoursincproduction140nsebck)"
  ],
  structured_fallback: "Official itinerary pages — JSON-LD TouristTrip / Product",
  pagination: "TBD — book API pagination not yet mapped; probe uses bounded page-link discovery",
  authentication_required: false,
  notes:
    "Unlike HAL Solr, Princess inventory is not exposed via a simple unauthenticated JSON search URL. GraphQL is not used. Coveo tokens are page-scoped."
};

const CRUISETOUR_RE =
  /cruisetour|land\s+and\s+sea|denali|yukon|overland|ultimate\s+alaska|tundra\s+wilderness/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function officialProductKey(voyage) {
  return (
    voyage.official_sailing_id ||
    voyage.external_id ||
    [voyage.itinerary_id, voyage.cruise_id, voyage.departure_date].filter(Boolean).join("|") ||
    voyage.official_url ||
    null
  );
}

function classifyProductType(voyage) {
  const text = [voyage.name, voyage.title, voyage.product_name, voyage.official_url]
    .filter(Boolean)
    .join(" ");
  if (CRUISETOUR_RE.test(text)) return "cruisetour";
  return "cruise";
}

async function fetchPrincessExcerpt(url) {
  return fetchSourceExcerpt(url, {
    timeoutMs: 15000,
    maxExcerptChars: 600000,
    includeHtml: true,
    userAgent: USER_AGENT
  });
}

async function discoverOfficialVoyageUrls({ seedUrl = "https://www.princess.com/cruise-search/", maxLinks = 40 } = {}) {
  const result = await fetchPrincessExcerpt(seedUrl);
  if (!result.ok) {
    return { ok: false, error: result.error || "fetch_failed", urls: [] };
  }
  const structured = extractStructuredSailingSources(result);
  const fromStructured = (structured.links || [])
    .map((l) => l.url || l)
    .filter(Boolean);
  const html = result.html || result.excerpt || "";
  const regexLinks = [];
  const re = /https?:\/\/www\.princess\.com\/[a-z]{2}(?:-[a-z]{2})?\/cruise-search\/details\/[^\s"'<>]+/gi;
  let m;
  while ((m = re.exec(html)) && regexLinks.length < maxLinks) {
    regexLinks.push(canonicalUrl(m[0]));
  }
  const urls = [...new Set([...fromStructured, ...regexLinks])].slice(0, maxLinks);
  return { ok: true, urls, structured_methods: structured.methods || [] };
}

function normalisePrincessVoyage(voyage, sourceUrl) {
  const productType = classifyProductType(voyage);
  return {
    official_product_key: officialProductKey(voyage),
    product_type: productType,
    ship_name: voyage.ship_name || voyage.ship || null,
    departure_port: voyage.departure_port || voyage.departurePort || null,
    departure_date: voyage.departure_date || voyage.startDate || null,
    return_date: voyage.return_date || voyage.endDate || null,
    nights: voyage.nights || voyage.duration_nights || null,
    destination_name: voyage.destination || voyage.region || null,
    official_url: voyage.official_url || sourceUrl,
    itinerary_name: voyage.name || voyage.title || null,
    raw: voyage
  };
}

async function probePrincessInventory({
  seedUrl = "https://www.princess.com/cruise-search/",
  maxLinks = 30,
  maxProducts = 100,
  requestDelayMs = 200,
  today = new Date().toISOString().slice(0, 10)
} = {}) {
  const discovery = await discoverOfficialVoyageUrls({ seedUrl, maxLinks });
  const products = [];
  const pageLog = [{ phase: "link_discovery", ...discovery, count: discovery.urls?.length || 0 }];

  for (const url of discovery.urls || []) {
    const fetched = await fetchPrincessExcerpt(url);
    pageLog.push({ url, ok: fetched.ok, bytes: fetched.bytes || 0 });
    if (!fetched.ok) continue;
    const voyages = extractStructuredVoyages(fetched) || [];
    for (const voyage of voyages) {
      const row = normalisePrincessVoyage(voyage, url);
      if (row.departure_date && row.departure_date < today) continue;
      products.push(row);
      if (products.length >= maxProducts) break;
    }
    if (products.length >= maxProducts) break;
    if (requestDelayMs > 0) await sleep(requestDelayMs);
  }

  const stats = summarisePrincessProducts(products, today);
  return {
    ok: discovery.ok || products.length > 0,
    read_only: true,
    source: SOURCE_CONTRACT,
    page_log: pageLog,
    discovered_urls: discovery.urls?.length || 0,
    products,
    stats,
    investigation: {
      coveo_org: "princesscruisesandtoursincproduction140nsebck",
      spa: "Next.js cruise-search (UBE / Polar Bear)",
      book_backend: "book.princess.com",
      official_api_base: "https://gw.api.princess.com/pcl-web/internal",
      ube_cruises_endpoint: "/ube/v1/cruises (requires productcompany/bookingcompany session headers)",
      ube_auth_endpoint: "/ube/v1.0/auth",
      caps_pricing_endpoint: "/caps/pc/pricing/v1/cruises (pricing only, not inventory listing)",
      graphql_aem: "www.princess.com/graphql/execute.json/princess/ (masterdata, not search)",
      hal_solr_analogy: false,
      static_html_inventory: false,
      preferred_next_step: "Map UBE search request from browser session (Polar Bear SPA)"
    }
  };
}

function summarisePrincessProducts(products, today) {
  const stats = {
    raw_products: products.length,
    genuine_cruises: 0,
    cruisetours: 0,
    with_official_identity: 0,
    future_products: 0,
    malformed: 0
  };
  for (const p of products) {
    if (p.official_product_key) stats.with_official_identity += 1;
    if (p.product_type === "cruise") stats.genuine_cruises += 1;
    if (p.product_type === "cruisetour") stats.cruisetours += 1;
    if (p.departure_date && p.departure_date >= today) stats.future_products += 1;
    if (!p.departure_date || !p.ship_name) stats.malformed += 1;
  }
  return stats;
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  officialProductKey,
  classifyProductType,
  discoverOfficialVoyageUrls,
  normalisePrincessVoyage,
  probePrincessInventory,
  summarisePrincessProducts
};
