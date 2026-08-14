#!/usr/bin/env node
/**
 * Regression tests for search-current-cruises / Cruise Finder catalogue path.
 * Reproduces the Phase 13 production failure: missing ports-catalogue.csv in Netlify bundle.
 *
 * Run: npm run test:search-current-cruises
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  categorizeResultsByDeparture,
  FINDER_DEPARTURE_PORTS
} = require(path.join(root, "netlify/functions/lib/cruise-finder-departure-match"));
const { parseCsv } = require(path.join(root, "netlify/functions/lib/cruise-finder-v2/enrichment/match-entities"));
const {
  isCruisePubliclyBookable,
  daysUntilDeparture,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const {
  publicSearchVoyageIdentityKey,
  publicSearchCoarseAuditKey,
  summarisePublicSearchDuplicates
} = require(path.join(root, "netlify/functions/lib/public-search-voyage-identity"));

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

const netlifyToml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
const searchBlock =
  netlifyToml.match(/\[functions\."search-current-cruises"\][\s\S]*?(?=\n\[|$)/)?.[0] || "";
assert(searchBlock.includes("ports-catalogue.csv"), "netlify.toml bundles ports-catalogue for search-current-cruises");
assert(searchBlock.includes("ci-cruise-lines-snapshot.csv"), "netlify.toml bundles cruise lines snapshot");
assert(searchBlock.includes("ci-cruise-ships-snapshot.csv"), "netlify.toml bundles ships snapshot");

const portsCsv = path.join(root, "data/ports/ports-catalogue.csv");
assert(fs.existsSync(portsCsv), "ports-catalogue.csv exists at repo path");
const ports = parseCsv(fs.readFileSync(portsCsv, "utf8"));
assert(ports.length > 100, "ports catalogue loads with substantial row count");

const sampleNclResults = [
  {
    cruiseLine: "Norwegian Cruise Line",
    ship: "Norwegian Jade",
    itineraryTitle: "7-Day Alaska From Vancouver to Whittier",
    departureDate: "7 Sep 2026",
    departureDateIso: "2026-09-07",
    durationNights: 7,
    departurePort: "Vancouver",
    destination: "Alaska",
    sourceUrl: "https://www.ncl.com/example",
    sourceName: "Norwegian Cruise Line"
  },
  {
    cruiseLine: "Norwegian Cruise Line",
    ship: "Norwegian Encore",
    itineraryTitle: "7-Day Alaska Round-trip Seattle",
    departureDate: "6 Sep 2026",
    departureDateIso: "2026-09-06",
    durationNights: 7,
    departurePort: "Seattle",
    destination: "Alaska",
    sourceUrl: "https://www.ncl.com/example2",
    sourceName: "Norwegian Cruise Line"
  }
];

const bucketed = categorizeResultsByDeparture(sampleNclResults, "anywhere", { destinationName: "Alaska" });
assert(Array.isArray(bucketed.results), "categorizeResultsByDeparture returns results array");
assert(
  bucketed.results.length + bucketed.alsoWorthConsidering.length + bucketed.otherResults.length >= 2,
  "departure bucketing preserves NCL sample sailings"
);

const today = "2026-08-14";
assert(
  isCruisePubliclyBookable({ departureDate: "2026-09-05", status: "active", perthToday: today }),
  "22-day boundary eligible"
);
assert(
  !isCruisePubliclyBookable({ departureDate: "2026-09-04", status: "active", perthToday: today }),
  "21-day boundary hidden"
);
assert(
  !isCruisePubliclyBookable({ departureDate: "2026-12-01", status: "match_required", perthToday: today }),
  "match_required not publicly bookable"
);
assert(daysUntilDeparture("2026-09-04", today) === PUBLIC_BOOKING_CUTOFF_DAYS, "21-day cutoff exact boundary");

const dedupeKeys = new Set(
  sampleNclResults.map((r) =>
    [r.cruiseLine, r.ship, r.departureDateIso, r.durationNights, r.departurePort].join("|").toLowerCase()
  )
);
assert(dedupeKeys.size === sampleNclResults.length, "sample results have distinct dedupe keys");

assert(FINDER_DEPARTURE_PORTS.anywhere?.flexible === true, "flexible departure option exists");

const princessNestedAlaska = [
  {
    cruiseLine: "Princess Cruises",
    ship: "Grand Princess",
    itineraryTitle: "Voyage of the Glaciers Grand Adventure",
    departureDate: "5 Sept 2026",
    departureDateIso: "2026-09-05",
    durationNights: 14,
    departurePort: "Vancouver",
    destination: "Alaska",
    sourceUrl: "https://www.princess.com/cruise-search/details?voyagecode=ayr14a&shipcode=ap&saildate=20260905"
  },
  {
    cruiseLine: "Princess Cruises",
    ship: "Grand Princess",
    itineraryTitle: "Voyage of the Glaciers (Northbound)",
    departureDate: "5 Sept 2026",
    departureDateIso: "2026-09-05",
    durationNights: 7,
    departurePort: "Vancouver",
    destination: "Alaska",
    sourceUrl: "https://www.princess.com/cruise-search/details?voyagecode=ang07a&shipcode=ap&saildate=20260905"
  }
];

const princessIdentity = summarisePublicSearchDuplicates(princessNestedAlaska);
assert(
  princessIdentity.duplicateGroups === 0,
  "Princess nested 7-night and 14-night Alaska sailings are distinct voyage identities"
);
assert(
  publicSearchCoarseAuditKey(princessNestedAlaska[0]) === publicSearchCoarseAuditKey(princessNestedAlaska[1]),
  "coarse ship/date/port audit key collides for nested Princess sailings"
);
assert(
  publicSearchVoyageIdentityKey(princessNestedAlaska[0]) !== publicSearchVoyageIdentityKey(princessNestedAlaska[1]),
  "full voyage identity separates nested Princess sailings"
);

const princessBucketed = categorizeResultsByDeparture(princessNestedAlaska, "anywhere", {
  destinationName: "Alaska"
});
assert(
  princessBucketed.results.length === 2,
  "departure bucketing preserves both nested Princess Alaska sailings"
);

const nclIdentity = summarisePublicSearchDuplicates(sampleNclResults);
assert(nclIdentity.duplicateGroups === 0, "NCL Alaska sample sailings remain duplicate-free");

const largePrincessFixture = [];
for (let i = 0; i < 40; i += 1) {
  largePrincessFixture.push({
    cruiseLine: "Princess Cruises",
    ship: `Ship ${i}`,
    departureDateIso: "2026-09-05",
    durationNights: 7,
    departurePort: "Vancouver"
  });
  largePrincessFixture.push({
    cruiseLine: "Princess Cruises",
    ship: `Ship ${i}`,
    departureDateIso: "2026-09-05",
    durationNights: 14,
    departurePort: "Vancouver"
  });
}
const largeSummary = summarisePublicSearchDuplicates(largePrincessFixture);
assert(
  largeSummary.duplicateGroups === 0 && largeSummary.total === 80,
  "volume fixture keeps nested 7/14-night pairs distinct at scale"
);

console.log(`search-current-cruises regression tests: ${passed}/${passed} PASS`);
