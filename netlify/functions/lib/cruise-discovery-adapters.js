/**
 * Sprint 11D.2 — Per-line discovery adapters.
 * Specific adapters refine URL patterns; generic handles everyone else.
 */

function genericAdapter() {
  return {
    id: "generic",
    name: "Generic",
    acceptedUrlPatterns: [
      /\/itinerar/i,
      /\/sailings?\b/i,
      /\/voyages?\b/i,
      /\/find-a-cruise/i,
      /\/cruise-search/i,
      /\/cruise-details/i,
      /\/booking/i
    ],
    excludedUrlPatterns: [
      /\/ships?\//i,
      /\/fleet\//i,
      /\/destinations?\//i,
      /\/blog\//i,
      /\/deck-?plans?\//i,
      /\/cabins?\//i,
      /\/about\//i
    ],
    maxFetches: 8,
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
    maxFetches: 8,
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
    maxFetches: 8,
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
    maxFetches: 8,
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
    maxFetches: 8,
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
    maxFetches: 8,
    braveQueries: ({ host, destName, nextYear }) => [
      `site:${host} inurl:cruise ${destName} ${nextYear}`,
      `site:${host} inurl:itinerary ${destName}`,
      `site:${host} "night" ${destName} cruise -yacht -fleet`,
      `site:${host} "Departs" ${destName}`
    ]
  };
}

const ADAPTERS = [
  celebrityAdapter(),
  royalCaribbeanAdapter(),
  princessAdapter(),
  virginVoyagesAdapter(),
  windstarAdapter()
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
