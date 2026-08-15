/**
 * Sprint 11D.2 — Per-line discovery adapters.
 * Maintainable adapter framework: URL patterns, sitemap hints, fetch caps.
 *
 * Interface (per adapter):
 *   id, name, matchLine?, acceptedUrlPatterns, excludedUrlPatterns,
 *   maxFetches, sitemapPaths?, discoverUrlPatterns?, braveQueries?
 */

function genericAdapter() {
  return {
    id: "generic",
    name: "Generic",
    sourceType: "generic_fallback",
    acceptedUrlPatterns: [
      /\/itinerar/i,
      /\/sailings?\b/i,
      /\/voyages?\b/i,
      /\/journeys?\b/i,
      /\/find-a-cruise/i,
      /\/cruise-search/i,
      /\/cruise-details/i,
      /\/cruises?\//i,
      /\/booking/i,
      /\/expeditions?\//i
    ],
    excludedUrlPatterns: [
      /\/ships?\//i,
      /\/fleet\//i,
      /\/blog\//i,
      /\/deck-?plans?\//i,
      /\/cabins?\//i,
      /\/about\//i,
      /\/news\//i,
      /\/press\//i
    ],
    sitemapPaths: ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"],
    maxFetches: 15,
    braveQueries: null
  };
}

function celebrityAdapter() {
  return {
    ...genericAdapter(),
    id: "celebrity",
    name: "Celebrity Cruises",
    matchLine: /celebrity/i,
    acceptedUrlPatterns: [
      /\/itinerar/i,
      /\/cruise-deals\//i,
      /\/destinations\/.*\/cruises/i,
      /\/find-a-cruise/i,
      /\/book\//i
    ],
    excludedUrlPatterns: [
      /\/ships\//i,
      /\/the-ships\//i,
      /\/fleet/i,
      /\/onboard\//i,
      /\/suite-class\//i
    ],
    maxFetches: 15,
    braveQueries: ({ host, destName, nextYear }) => [
      `site:${host} inurl:itinerary ${destName} ${nextYear}`,
      `site:${host} "nights" ${destName} cruise -ships -fleet`,
      `site:${host} inurl:find-a-cruise ${destName}`,
      `site:${host} "Departs" ${destName}`
    ]
  };
}

function royalCaribbeanAdapter() {
  return {
    ...genericAdapter(),
    id: "royal-caribbean",
    name: "Royal Caribbean",
    matchLine: /royal\s*caribbean/i,
    acceptedUrlPatterns: [
      /\/cruises\//i,
      /\/itinerar/i,
      /\/booking\//i,
      /\/cruise-ships\/.*\/itineraries/i
    ],
    excludedUrlPatterns: [/\/ships\//i, /\/loyalty\//i, /\/content\//i, /\/blog\//i],
    maxFetches: 15,
    braveQueries: ({ host, destName, nextYear }) => [
      `site:${host} inurl:cruises ${destName} ${nextYear}`,
      `site:${host} inurl:itinerary ${destName}`,
      `site:${host} "${destName}" "night" cruise -ships`,
      `site:${host} "Departing" ${destName}`
    ]
  };
}

function princessAdapter() {
  return {
    ...genericAdapter(),
    id: "princess",
    name: "Princess Cruises",
    matchLine: /princess/i,
    acceptedUrlPatterns: [/\/itinerar/i, /\/find-a-cruise/i, /\/cruise-search/i, /\/book\//i],
    excludedUrlPatterns: [/\/ships\//i, /\/onboard-experience\//i, /\/learn\//i],
    maxFetches: 15,
    braveQueries: ({ host, destName, nextYear }) => [
      `site:${host} inurl:itinerary ${destName} ${nextYear}`,
      `site:${host} inurl:find-a-cruise ${destName}`,
      `site:${host} "nights" ${destName} -ships -fleet`,
      `site:${host} "Departs" ${destName} cruise`
    ]
  };
}

function virginVoyagesAdapter() {
  return {
    ...genericAdapter(),
    id: "virgin-voyages",
    name: "Virgin Voyages",
    matchLine: /virgin\s*voyages/i,
    acceptedUrlPatterns: [/\/book\//i, /\/sailings?\//i, /\/voyage/i, /\/itinerar/i, /\/find-a-voyage/i],
    excludedUrlPatterns: [/\/ships\//i, /\/cabins\//i, /\/eateries\//i, /\/experiences\//i],
    maxFetches: 15,
    braveQueries: ({ host, destName, nextYear }) => [
      `site:${host} inurl:book ${destName}`,
      `site:${host} sailing ${destName} ${nextYear}`,
      `site:${host} "nights" ${destName} -ships`,
      `site:${host} "Departs" ${destName}`
    ]
  };
}

function windstarAdapter() {
  return {
    ...genericAdapter(),
    id: "windstar",
    name: "Windstar Cruises",
    matchLine: /windstar/i,
    acceptedUrlPatterns: [/\/cruise\//i, /\/itinerar/i, /\/find-a-cruise/i, /\/voyages?\//i],
    excludedUrlPatterns: [/\/yachts?\//i, /\/ships?\//i, /\/about\//i, /\/blog\//i],
    maxFetches: 15,
    braveQueries: ({ host, destName, nextYear }) => [
      `site:${host} inurl:cruise ${destName} ${nextYear}`,
      `site:${host} inurl:itinerary ${destName}`,
      `site:${host} "night" ${destName} cruise -yacht -fleet`,
      `site:${host} "Departs" ${destName}`
    ]
  };
}

function exploraAdapter() {
  return {
    ...genericAdapter(),
    id: "explora",
    name: "Explora Journeys",
    sourceType: "journey_listing",
    matchLine: /explora/i,
    acceptedUrlPatterns: [/\/journeys?\//i, /\/destinations-globe\//i, /id-journey=/i, /\/cruises?\//i],
    excludedUrlPatterns: [/\/ships?\//i, /\/experiences?\//i, /\/brochure/i, /\/news\//i],
    sitemapPaths: ["/sitemap.xml"],
    maxFetches: 20
  };
}

function cunardAdapter() {
  return {
    ...genericAdapter(),
    id: "cunard",
    name: "Cunard",
    matchLine: /cunard/i,
    acceptedUrlPatterns: [/\/cruise-search/i, /\/find-a-cruise/i, /\/cruises?\//i, /\/itinerar/i],
    excludedUrlPatterns: [/\/ships?\//i, /\/about\//i, /\/news\//i],
    maxFetches: 15
  };
}

function hollandAmericaAdapter() {
  const hal = require("./holland-america-discovery-adapter");
  return {
    ...genericAdapter(),
    id: "holland-america",
    name: "Holland America Line",
    sourceType: "hal_cruise_search_api",
    matchLine: /holland\s*america/i,
    acceptedUrlPatterns: [/\/cruise-search/i, /\/find-a-cruise/i, /\/cruises?\//i, /\/itinerar/i],
    excludedUrlPatterns: [/\/ships?\//i, /\/activities\//i, /\/cruise-destinations\//i, /\/faq\//i],
    maxFetches: 25,
    discoveryModule: hal,
    sourceContract: hal.SOURCE_CONTRACT
  };
}

function carnivalAdapter() {
  const ccl = require("./carnival-discovery-adapter");
  const { SOURCE_ID } = require("./carnival-discovery-source");
  return {
    ...genericAdapter(),
    id: "carnival",
    name: "Carnival Cruise Line",
    sourceType: SOURCE_ID,
    matchLine: /carnival/i,
    acceptedUrlPatterns: [/\/cruise-search/i, /\/find-a-cruise/i, /\/cruises?\//i, /\/itinerar/i],
    excludedUrlPatterns: [/\/ships?\//i, /\/fun-ships\//i, /\/about\//i, /\/news\//i],
    maxFetches: 25,
    discoveryModule: ccl,
    sourceContract: { sourceId: SOURCE_ID, officialIdentityField: "sailing_id" }
  };
}

function atlasAdapter() {
  return {
    ...genericAdapter(),
    id: "atlas",
    name: "Atlas Ocean Voyages",
    sourceType: "expedition_listing",
    matchLine: /atlas/i,
    acceptedUrlPatterns: [/\/expeditions?\//i, /\/voyages?\//i, /\/cruises?\//i, /\/itinerar/i],
    excludedUrlPatterns: [/\/ships?\//i, /\/news\//i, /\/blog\//i],
    maxFetches: 15
  };
}

const ADAPTERS = [
  celebrityAdapter(),
  royalCaribbeanAdapter(),
  princessAdapter(),
  virginVoyagesAdapter(),
  windstarAdapter(),
  exploraAdapter(),
  cunardAdapter(),
  hollandAmericaAdapter(),
  carnivalAdapter(),
  atlasAdapter()
];

function resolveAdapter(cruiseLine) {
  const name = String(cruiseLine?.name || "");
  const slug = String(cruiseLine?.slug || "");
  const host = String(cruiseLine?.website_url || "");
  for (const adapter of ADAPTERS) {
    if (adapter.matchLine?.test(name) || adapter.matchLine?.test(slug) || adapter.matchLine?.test(host)) {
      return adapter;
    }
  }
  return genericAdapter();
}

module.exports = {
  resolveAdapter,
  genericAdapter,
  ADAPTERS
};
