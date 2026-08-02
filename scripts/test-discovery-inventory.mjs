#!/usr/bin/env node
/**
 * Discovery inventory, source health and extraction tests.
 * Run: node scripts/test-discovery-inventory.mjs
 */

import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  extractStructuredVoyages,
  extractSitemapLocs,
  extractStructuredSailingSources
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-structured"));
const {
  inferRunType,
  inferSourceUrlType,
  classifyLineHealth,
  HEALTH
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-source-health"));
const { resolveAdapter } = require(path.join(root, "netlify/functions/lib/cruise-discovery-adapters"));
const {
  buildCandidateFromSource,
  extractRawSignals
} = require(path.join(root, "netlify/functions/lib/cruise-discovery"));
const { AUTO_ALIAS_WRITES_ENABLED } = require(path.join(root, "netlify/functions/lib/discovery-ship-resolver"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. Full-run versus selected-line metrics
assert(inferRunType({ scope: "cruise_line", stats: {} }) === "discover_selected_cruise_line", "selected line run");
assert(inferRunType({ scope: "full", stats: { triggered_by: "admin" } }) === "run_full_discovery_line", "full line run");
assert(
  inferRunType({ scope: "full", stats: { triggered_by: "selected_line_verification" } }) === "verify_selected_line",
  "verify run"
);

// 2. Zero sailings with successful fetch is not healthy inventory
const zeroSail = classifyLineHealth({
  line: { sold_by_101cruise: true, website_url: "https://x.com", cruise_search_url: "https://x.com/search" },
  lastRun: { status: "completed", stats: { candidates: 0, pages_fetched: 1 } },
  activeFutureCount: 0,
  activeAllCount: 0
});
assert(zeroSail.status === HEALTH.HEALTHY_NO_SAILINGS, "zero sailings classified");

// 3. Misconfigured homepage
const mis = classifyLineHealth({
  line: { sold_by_101cruise: true, website_url: null, cruise_search_url: null },
  lastRun: null,
  activeFutureCount: 0,
  activeAllCount: 0
});
assert(mis.status === HEALTH.MISCONFIGURED, "misconfigured line");

// 4. Sitemap sailing URLs
const sitemapXml = `<?xml version="1.0"?><urlset><loc>https://line.com/cruises/alaska-7-nights</loc><loc>https://line.com/about</loc></urlset>`;
const locs = extractSitemapLocs(sitemapXml, "https://line.com");
assert(locs.includes("https://line.com/cruises/alaska-7-nights"), "sitemap cruise URL");
assert(!locs.some((u) => /about/.test(u)), "sitemap excludes non-cruise");

// 5. JSON-LD voyage extraction
const jsonLdHtml = `<html><script type="application/ld+json">{"@type":"Trip","name":"Alaska Explorer","startDate":"2027-06-01","url":"https://line.com/cruise/1","departureLocation":{"name":"Seattle"}}</script></html>`;
const voyages = extractStructuredVoyages(jsonLdHtml, "https://line.com");
assert(voyages.voyages.length >= 1, "json-ld voyage extracted");
assert(voyages.voyages[0].departure_date === "2027-06-01", "json-ld departure date");

// 6. Embedded application state voyages
const nextHtml = `<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"voyages":[{"startDate":"2027-07-01","name":"Med Cruise","url":"https://line.com/v/1"}]}}}</script></html>`;
const nextV = extractStructuredVoyages(nextHtml, "https://line.com");
assert(nextV.voyages.some((v) => v.departure_date === "2027-07-01"), "next data voyage");

// 7. Static listing links
const listHtml = `<html><a href="https://line.com/cruises/alaska">Alaska</a><a href="https://line.com/about">About</a></html>`;
const structured = extractStructuredSailingSources(listHtml, "https://line.com/search");
assert(structured.sailingUrls.some((u) => /cruises\/alaska/.test(u)), "static listing URL");

// 8. JavaScript-empty diagnosis helper
const emptyHtml = "<html><body><div id=root></div></body></html>";
const emptyStructured = extractStructuredSailingSources(emptyHtml, "https://line.com");
assert(emptyStructured.sailingUrls.length === 0 && !emptyStructured.hasStructured, "js empty html");

// 9. Structured voyage through shared normalisation
const raw = extractRawSignals({
  title: "Alaska",
  description: "",
  url: "https://line.com/c/1",
  excerpt: "",
  cruiseLine: { name: "Test Line" },
  structuredVoyage: {
    departure_date: "2027-08-15",
    departure_port: "Seattle",
    ship_name: "Test Ship",
    source: "json_ld"
  }
});
assert(raw.departure_date_raw === "2027-08-15", "structured date in raw signals");
assert(raw.departure_port_raw === "Seattle", "structured port in raw signals");

// 10. Marketing page auto-reject path still works via buildCandidateFromSource
const reject = buildCandidateFromSource({
  title: "Explore Alaska",
  description: "Discover our destination",
  url: "https://line.com/destinations/alaska",
  excerpt: "Plan your vacation",
  cruiseLine: { id: "l1", name: "Test" },
  ships: [],
  destinations: [],
  preferredDestination: null
});
assert(reject?.skip === true, "marketing page rejected");

// 11. P&O Australia exclusion unchanged (adapter generic ok)
const po = resolveAdapter({ name: "P&O Cruises Australia", slug: "po-au" });
assert(po.id === "generic", "P&O AU uses generic adapter");

// 12. Permanent auto-alias writes disabled
assert(AUTO_ALIAS_WRITES_ENABLED === false, "auto alias writes disabled");

// 13. Source URL type classification
assert(inferSourceUrlType({ cruise_search_url: "https://x.com/find-a-cruise" }) === "search_page", "search page type");
assert(inferSourceUrlType({ website_url: "https://x.com" }) === "homepage", "homepage type");

// 14. Explora adapter exists
const explora = resolveAdapter({ name: "Explora Journeys", slug: "explora" });
assert(explora.id === "explora", "explora adapter");

// 15. Line-wide discovery must not inherit published Living Destination filters
const { buildBraveSailingQueries } = require(path.join(root, "netlify/functions/lib/cruise-discovery-url-score"));
const { resolveDiscoveryDestinationTargets } = require(path.join(root, "netlify/functions/lib/cruise-discovery"));
const lineWideTargets = resolveDiscoveryDestinationTargets(null);
assert(lineWideTargets.length === 1 && lineWideTargets[0] === null, "line-wide uses unfiltered pass");
const destScopedTargets = resolveDiscoveryDestinationTargets({ id: "alaska-id", name: "Alaska" });
assert(destScopedTargets[0]?.name === "Alaska", "destination scope uses selected destination");
const genericQueries = buildBraveSailingQueries({ host: "line.com", destName: "cruise", adapter: null });
const alaskaQueries = buildBraveSailingQueries({ host: "line.com", destName: "Alaska", adapter: null });
assert(!genericQueries.some((q) => /alaska/i.test(q)), "line-wide Brave queries are destination-agnostic");
assert(alaskaQueries.some((q) => /alaska/i.test(q)), "destination-scoped Brave queries mention Alaska");

console.log("test-discovery-inventory: 15 passed");
