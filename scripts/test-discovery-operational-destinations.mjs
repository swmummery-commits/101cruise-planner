#!/usr/bin/env node
/**
 * Operational destination classification tests.
 * Run: npm run test:discovery-operational-destinations
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  classificationDestinations,
  publicLivingDestinations,
  isClassificationEnabled,
  isInventoryDestination,
  isPublicLivingDestination
} = require(path.join(root, "netlify/functions/lib/destination-classification"));
const {
  resolveOperationalDestination,
  detectCrossingRoute,
  detectPacificCoastRoute
} = require(path.join(root, "netlify/functions/lib/discovery-destination-resolver"));
const {
  validateCruise,
  buildCandidateFromSource,
  matchEntities,
  extractRawSignals,
  normaliseCandidate,
  pickDestinationFromHits,
  matchDestination
} = require(path.join(root, "netlify/functions/lib/cruise-discovery"));
const { resolveDiscoveryDestinationTargets } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery")
);
const { AUTO_ALIAS_WRITES_ENABLED } = require(
  path.join(root, "netlify/functions/lib/discovery-ship-resolver")
);
const { resolveAdapter } = require(path.join(root, "netlify/functions/lib/cruise-discovery-adapters"));
const {
  publicDestinationsQuery,
  filterPublicDestinations,
  filterInventoryDestination,
  inventoryDestinationBySlugQuery
} = require(path.join(root, "netlify/functions/lib/destination-queries"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const alaska = {
  id: "alaska-id",
  name: "Alaska",
  slug: "alaska",
  status: "published",
  classification_enabled: true
};
const medDraft = {
  id: "med-id",
  name: "Mediterranean",
  slug: "mediterranean",
  status: "draft",
  classification_enabled: true
};
const pacificDraft = {
  id: "pc-id",
  name: "Pacific Coast",
  slug: "pacific-coast",
  status: "draft",
  classification_enabled: true
};
const hiddenEnabled = {
  id: "hidden-id",
  name: "Hidden Region",
  slug: "hidden-region",
  status: "hidden",
  classification_enabled: true
};
const archived = {
  id: "arch-id",
  name: "Old Region",
  slug: "old",
  status: "hidden",
  classification_enabled: false
};
const allDest = [alaska, medDraft, pacificDraft, hiddenEnabled, archived];

assert(classificationDestinations(allDest).length === 3, "internal draft can classify");
assert(publicLivingDestinations(allDest).length === 1, "only published public");
assert(isClassificationEnabled(medDraft), "draft classifiable");
assert(!isClassificationEnabled(hiddenEnabled), "hidden excluded even when enabled flag true");
assert(!isClassificationEnabled(archived), "archived excluded");
assert(isInventoryDestination(medDraft), "draft in inventory");
assert(!isInventoryDestination(hiddenEnabled), "hidden not in inventory");

assert(resolveDiscoveryDestinationTargets(null)[0] === null, "line-wide unfiltered");

const sanDiegoVancouver = resolveOperationalDestination({
  title: "Crystal Serenity | The Americas & Caribbean | San Diego to Vancouver",
  description: "San Diego to Vancouver",
  departurePort: "San Diego",
  arrivalPort: "Vancouver",
  destinations: allDest
});
assert(sanDiegoVancouver.destinationKey === "pacific-coast", "SD-Vancouver is Pacific Coast not Caribbean");
assert(sanDiegoVancouver.destinationKey !== "caribbean", "not Caribbean from marketing label");
assert(sanDiegoVancouver.destinationKey !== "alaska", "SD-Vancouver not Alaska");

const sdv2 = resolveOperationalDestination({
  title: "San Diego to Vancouver",
  departurePort: "San Diego",
  arrivalPort: "Vancouver",
  destinations: allDest
});
assert(sdv2.destinationKey === "pacific-coast", "San Diego to Vancouver Pacific Coast");

assert(
  detectPacificCoastRoute("San Diego to Vancouver", "", "", "San Diego", "Vancouver")?.slug === "pacific-coast",
  "pacific coast detector"
);

const yokohamaSeward = resolveOperationalDestination({
  title: "Transoceanic | Yokohama to Seward",
  departurePort: "Yokohama",
  arrivalPort: "Seward",
  destinations: allDest
});
assert(yokohamaSeward.destinationKey === "transpacific", "Yokohama Seward transpacific");

const sewardTokyoConflict = resolveOperationalDestination({
  title: "Crystal Serenity | Transoceanic | Seward to Tokyo",
  description: "Anchorage Homer Kodiak Tokyo",
  departurePort: "Tokyo",
  arrivalPort: "Tokyo",
  destinations: allDest
});
assert(sewardTokyoConflict.destinationKey === "transpacific", "title route wins over conflicting port");

const vancouverOnly = resolveOperationalDestination({
  title: "Luxury Cruise departing Vancouver",
  departurePort: "Vancouver",
  destinations: allDest
});
assert(vancouverOnly.destinationKey !== "alaska" || vancouverOnly.status !== "resolved", "Vancouver alone not Alaska");

const seattleOnly = resolveOperationalDestination({
  title: "Cruise from Seattle",
  departurePort: "Seattle",
  destinations: allDest
});
assert(seattleOnly.destinationKey !== "alaska" || seattleOnly.status !== "resolved", "Seattle alone not Alaska");

const tokyoOnly = resolveOperationalDestination({
  title: "Embark Tokyo",
  departurePort: "Tokyo",
  destinations: allDest
});
assert(tokyoOnly.destinationKey !== "alaska", "Tokyo alone not Alaska");

const alaskaItin = resolveOperationalDestination({
  title: "Alaska cruise",
  description: "Juneau Ketchikan Sitka Skagway Hubbard Glacier",
  itinerary: "Whittier Juneau Ketchikan Sitka Vancouver",
  destinations: allDest
});
assert(alaskaItin.destinationKey === "alaska", "itinerary majority Alaska");

const structured = resolveOperationalDestination({
  structuredDestination: "Mediterranean Explorer",
  title: "7 night cruise",
  destinations: allDest
});
assert(structured.destinationKey === "mediterranean", "structured destination wins");

const conflict = resolveOperationalDestination({
  title: "Alaska and Japan grand journey",
  description: "Tokyo Yokohama Juneau Ketchikan Sitka",
  itinerary: "Vancouver Ketchikan Sitka Tokyo Yokohama",
  destinations: allDest
});
assert(
  conflict.destinationKey === "transpacific" || conflict.status === "ambiguous",
  "multi-region not forced Alaska"
);

const marketing = buildCandidateFromSource({
  title: "Explore Mediterranean",
  description: "Discover our destination",
  url: "https://line.com/destinations/mediterranean",
  excerpt: "Plan your vacation",
  cruiseLine: { id: "l1", name: "Test" },
  ships: [],
  destinations: allDest,
  preferredDestination: null
});
assert(marketing?.skip === true, "med marketing rejected");

assert(detectCrossingRoute("Transoceanic voyage", "", "", "Yokohama", "Seward")?.slug === "transpacific", "transpacific");
assert(detectCrossingRoute("Transatlantic crossing", "", "", "Southampton", "New York")?.slug === "transatlantic", "transatlantic");
assert(detectCrossingRoute("World Cruise 2027", "", "", "", "")?.slug === "world-cruise", "world cruise");
assert(
  detectCrossingRoute("Grand Journey", "", "", "Hamburg", "New York")?.slug === "transatlantic",
  "europe-na atlantic endpoints"
);
assert(
  detectCrossingRoute("Grand Journey", "", "", "Lisbon", "Copenhagen") == null,
  "europe-europe endpoints are not transatlantic"
);

const explora = resolveOperationalDestination({
  title: "A Grand Journey from Glacier Majesty to Japanese Grace",
  description: "Vancouver Ketchikan Sitka Hubbard Glacier Tokyo",
  departurePort: "Vancouver",
  arrivalPort: "Japanese Grace",
  nights: 16,
  destinations: allDest
});
assert(explora.destinationKey === "transpacific", "Explora grand journey transpacific");

const draftCandidate = {
  ship_id: "s1",
  destination_id: "med-id",
  departure_date: "2027-06-01",
  official_url: "https://line.com/1",
  departure_port: "Barcelona"
};
assert(!validateCruise(draftCandidate).some((r) => /unpublished|published/i.test(r)), "no publish check in validate");

assert(publicDestinationsQuery().includes("status=eq.published"), "public API query published only");
assert(filterPublicDestinations(allDest).length === 1, "public filter");
assert(inventoryDestinationBySlugQuery("mediterranean").includes("slug=ilike"), "inventory slug query");

const invMed = filterInventoryDestination([medDraft]);
assert(invMed?.id === "med-id" && invMed.publicLivingPage === false, "draft cruise inventory allowed");
assert(filterInventoryDestination([hiddenEnabled]) === null, "hidden excluded from inventory");

const searchSrc = require("fs").readFileSync(path.join(root, "netlify/functions/search-current-cruises.js"), "utf8");
assert(
  searchSrc.includes("loadInventoryDestinationBySlug") || searchSrc.includes("filterInventoryDestination"),
  "search uses inventory destination helper"
);
assert(!searchSrc.includes("status=eq.published&select=id,name,slug&limit=1"), "no published-only cruise lookup");

const genSrc = require("fs").readFileSync(path.join(root, "scripts/generate-destination-manifests.mjs"), "utf8");
const simSrc = require("fs").readFileSync(path.join(root, "scripts/simulate-operational-destinations.mjs"), "utf8");
assert(genSrc.includes("writes_performed: false"), "manifest generator no writes");
assert(simSrc.includes("writes_performed: false"), "simulation no writes");
assert(simSrc.includes("individual_pages_fetched"), "simulation follows individual URLs");
assert(simSrc.includes("cachedFetch"), "simulation caches fetches");
assert(simSrc.includes("canonicalUrl"), "simulation dedupes URLs");

assert(resolveAdapter({ name: "P&O Cruises Australia" }).id === "generic", "P&O AU excluded");
assert(AUTO_ALIAS_WRITES_ENABLED === false, "auto alias disabled");

const scopeTest = require("fs").readFileSync(path.join(root, "scripts/test-discovery-destination-scope.mjs"), "utf8");
assert(scopeTest.includes("resolveDiscoveryDestinationTargets"), "scope tests present");

function destFixture(id, name, slug, region) {
  return {
    id,
    name,
    slug,
    primary_region: region,
    classification_enabled: true,
    status: "draft"
  };
}

const matchDests = [
  destFixture("africa-id", "Africa", "africa", "Africa"),
  destFixture("japan-id", "Japan", "japan", "Asia"),
  destFixture("asia-id", "Asia", "asia", "Asia"),
  destFixture("med-id", "Mediterranean", "mediterranean", "Europe"),
  destFixture("aunz-id", "Australia and New Zealand", "australia-new-zealand", "Oceania"),
  destFixture("cne-id", "Canada and New England", "canada-new-england", "North America"),
  destFixture("panama-id", "Panama Canal", "panama-canal", "Central America"),
  destFixture("sa-id", "South America", "south-america", "South America"),
  destFixture("carib-id", "Caribbean", "caribbean", "Caribbean"),
  destFixture("alaska-id", "Alaska", "alaska", "North America"),
  destFixture("sp-id", "South Pacific", "south-pacific", "Oceania"),
  destFixture("ta-id", "Transatlantic", "transatlantic", "Atlantic")
];

function classifyFromSource({ title, description = "", excerpt = "" }) {
  const raw = extractRawSignals({
    title,
    description,
    excerpt,
    url: "https://example.com/cruises/sample"
  });
  const normalised = normaliseCandidate(raw);
  return matchEntities(normalised, {
    cruiseLine: { id: "line-1", name: "Test Line" },
    ships: [],
    destinations: matchDests
  });
}

const japanVsAfrica = classifyFromSource({
  title: "JAPAN INTENSIVE CRUISE: TOKYO, KOBE & NAGASAKI",
  description: "sailing from TOKYO to SEOUL (INCHEON) on Oct 2 2026",
  excerpt: "Destination: AFRICA"
});
assert(japanVsAfrica.matched_destination?.name === "Japan", "title Japan beats conflicting Africa token");
assert(japanVsAfrica.matched_destination?.name !== "Africa", "PR261002-equivalent must not resolve to Africa");

const africaTitle = classifyFromSource({
  title: "AFRICA CRUISE: CAPE TOWN & MOMBASA",
  excerpt: "Destination: AFRICA"
});
assert(africaTitle.matched_destination?.name === "Africa", "known Africa title still resolves to Africa");

const africaLabelOnly = classifyFromSource({
  title: "Safari Voyage from Cape Town",
  excerpt: "Destination: AFRICA"
});
assert(africaLabelOnly.matched_destination?.name === "Africa", "Africa label-only still resolves when title has no dest name");

const medTitle = classifyFromSource({
  title: "MEDITERRANEAN COMBINATION CRUISE: BARCELONA, VENICE & ATHENS"
});
assert(medTitle.matched_destination?.name === "Mediterranean", "Mediterranean title does not regress");

const greeceGtm = classifyFromSource({
  title: "GREECE INTENSIVE CRUISE: SANTORINI, RHODES & MYKONOS",
  excerpt: "Destination: MEDITERRANEAN"
});
assert(greeceGtm.matched_destination?.name === "Mediterranean", "GTM-only Mediterranean still used when title has no dest name");

const medNorthAfrica = classifyFromSource({
  title: "MEDITERRANEAN & NORTH AFRICA COMBINATION CRUISE: LISBON, CASABLANCA & NICE"
});
assert(medNorthAfrica.matched_destination?.name === "Mediterranean", "Med + North Africa title stays Mediterranean");
assert(medNorthAfrica.matched_destination?.name !== "Africa", "North Africa mention must not select Africa");

const aunz = classifyFromSource({
  title: "AUSTRALIA INTENSIVE CRUISE: DARWIN, CAIRNS & SYDNEY",
  excerpt: "Destination: AUSTRALIA & NEW ZEALAND"
});
assert(aunz.matched_destination?.name === "Australia and New Zealand", "Australia and New Zealand does not regress");

const cne = classifyFromSource({
  title: "Canada & New England Cruise: Quebec, Halifax & Martha's Vineyard"
});
assert(cne.matched_destination?.name === "Canada and New England", "Canada and New England does not regress");

const panama = classifyFromSource({
  title: "Quest Debut Panama Canal Holiday & New Year's Eve Cruise"
});
assert(panama.matched_destination?.name === "Panama Canal", "Panama Canal does not regress");

const southAmerica = classifyFromSource({
  title: "CIRCLE SOUTH AMERICA GRAND VOYAGE"
});
assert(southAmerica.matched_destination?.name === "South America", "South America does not regress");

const asia = classifyFromSource({
  title: "EAST ASIA CRUISE: HONG KONG, SHANGHAI & BEIJING",
  excerpt: "Destination: ASIA"
});
assert(asia.matched_destination?.name === "Asia", "Asia does not regress");

const japanOnly = classifyFromSource({
  title: "JAPAN INTENSIVE CRUISE: TOKYO, KOBE & NAGASAKI"
});
assert(japanOnly.matched_destination?.name === "Japan", "Japan title without GTM still resolves to Japan");

const multiHits = matchDestination(
  "JAPAN INTENSIVE CRUISE Destination: AFRICA Japan Tokyo",
  matchDests
);
assert(multiHits.length >= 2, "conflicting blob yields multiple dest hits");
assert(
  pickDestinationFromHits(multiHits, "JAPAN INTENSIVE CRUISE: TOKYO, KOBE & NAGASAKI")?.name === "Japan",
  "pickDestinationFromHits prefers title Japan"
);
assert(
  pickDestinationFromHits(multiHits, "JAPAN INTENSIVE CRUISE: TOKYO, KOBE & NAGASAKI")?.name !== "Africa",
  "pickDestinationFromHits rejects body-only Africa"
);

console.log("test-discovery-operational-destinations: 42 passed");
