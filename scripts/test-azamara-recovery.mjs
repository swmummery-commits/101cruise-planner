#!/usr/bin/env node
/**
 * Azamara phase-4 recovery — route departure parsing and destination inference.
 * Run: node scripts/test-azamara-recovery.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  parseRouteEmbarkPort,
  parseRoutePortPair,
  resolveRawPortText,
  resolveDepartureFromSource
} = require(path.join(root, "netlify/functions/lib/discovery-departure-port.js"));
const {
  buildCandidateFromSource,
  matchDestination,
  pickDestinationFromHits
} = require(path.join(root, "netlify/functions/lib/cruise-discovery.js"));
const {
  AZAMARA_LINE_ID,
  azamaraPreBuildGate,
  azamaraStaleSourceGate,
  enrichStructuredVoyageFromHtml
} = require(path.join(root, "netlify/functions/lib/azamara-discovery-source.js"));
const {
  isAzamaraNonGeographicGtm,
  inferAzamaraDestinationSlug,
  resolveAzamaraDestination,
  sanitiseAzamaraDestinationBlob,
  preferAzamaraDestinationHits
} = require(path.join(root, "netlify/functions/lib/azamara-destination-mapping.js"));
const { OPERATIONAL_DESTINATION_CATALOGUE } = require(path.join(
  root,
  "netlify/functions/lib/destination-classification.js"
));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const azamaraLine = { id: AZAMARA_LINE_ID, name: "Azamara", slug: "azamara" };
const ships = [
  { id: "journey", name: "Journey" },
  { id: "onward", name: "Onward" },
  { id: "pursuit", name: "Pursuit" },
  { id: "quest", name: "Quest" }
];
const destinations = OPERATIONAL_DESTINATION_CATALOGUE.map((d) => ({
  id: d.key,
  name: d.name,
  slug: d.slug,
  primary_region: d.primary_region
}));
const shipAliases = [
  { ship_id: "quest", raw_alias: "Azamara Quest", normalised_alias: "quest" },
  { ship_id: "journey", raw_alias: "Azamara Journey", normalised_alias: "journey" },
  { ship_id: "onward", raw_alias: "Azamara Onward", normalised_alias: "onward" },
  { ship_id: "pursuit", raw_alias: "Azamara Pursuit", normalised_alias: "pursuit" }
];

function buildAzamara(args) {
  return buildCandidateFromSource({
    cruiseLine: azamaraLine,
    ships,
    destinations,
    shipAliases,
    destinationAliases: [],
    ...args
  });
}

// --- Route parser tests ---
assert(parseRouteEmbarkPort("BARCELONA to VENICE (FUSINA)") === "BARCELONA", "Barcelona embark");
assert(parseRouteEmbarkPort("TOKYO to HONG KONG") === "TOKYO", "Tokyo embark");
assert(parseRouteEmbarkPort("SAN JUAN to BRIDGETOWN") === "SAN JUAN", "San Juan embark");
assert(parseRouteEmbarkPort("SAN JUAN to SAN JUAN") === "SAN JUAN", "San Juan roundtrip");
assert(parseRouteEmbarkPort("ROME (CIVITAVECCHIA) to BARCELONA") === "ROME (CIVITAVECCHIA)", "Rome parenthetical");
assert(parseRouteEmbarkPort("SEOUL (INCHEON) to SHANGHAI") === "SEOUL (INCHEON)", "Seoul parenthetical");
assert(parseRouteEmbarkPort("TOKYO to TOKYO") === "TOKYO", "Tokyo roundtrip");

const prose = parseRouteEmbarkPort("Welcome to Rome for a wonderful cruise experience");
assert(prose === "Welcome to Rome for a wonderful cruise experience", "prose not split");

const resolvedBarcelona = resolveRawPortText("BARCELONA to VENICE (FUSINA)");
assert(resolvedBarcelona.status === "resolved", "route resolves Barcelona");
assert(resolvedBarcelona.canonicalPortName === "Barcelona", resolvedBarcelona.canonicalPortName);

const resolvedRome = resolveRawPortText("ROME (CIVITAVECCHIA) to BARCELONA");
assert(resolvedRome.status === "resolved", "route resolves Civitavecchia");
assert(resolvedRome.canonicalPortName === "Civitavecchia", resolvedRome.canonicalPortName);

const resolvedIncheon = resolveRawPortText("SEOUL (INCHEON) to SHANGHAI");
assert(resolvedIncheon.status === "resolved", "route resolves Incheon");
assert(resolvedIncheon.canonicalPortName === "Incheon", resolvedIncheon.canonicalPortName);

const depFromDesc = resolveDepartureFromSource({
  description: "Explore this 11-Night Cruise from BARCELONA to VENICE (FUSINA) on Azamara Quest"
});
assert(depFromDesc.status === "resolved", "description route pair resolves");
assert(depFromDesc.canonicalPortName === "Barcelona", depFromDesc.canonicalPortName);

const {
  stripRoutePairMarketingSuffix,
  applyDiscoveryPortSynonym
} = require(path.join(root, "netlify/functions/lib/discovery-departure-port.js"));

assert(
  parseRoutePortPair("SAN DIEGO TO LONDON GRAND VOYAGE")?.from === "SAN DIEGO" &&
    parseRoutePortPair("SAN DIEGO TO LONDON GRAND VOYAGE")?.to === "LONDON",
  "grand voyage suffix stripped from route pair"
);
assert(stripRoutePairMarketingSuffix("VALPARAISO TO MIAMI GRAND VOYAGE").includes("MIAMI"), "suffix strip");

const resolvedNyc = resolveRawPortText("NEW YORK CITY");
assert(resolvedNyc.status === "resolved", "NEW YORK CITY resolves");
assert(resolvedNyc.canonicalPortName === "New York", resolvedNyc.canonicalPortName);

const resolvedGranCanaria = resolveRawPortText("GRAN CANARIA");
assert(resolvedGranCanaria.status === "resolved", "GRAN CANARIA resolves");
assert(resolvedGranCanaria.canonicalPortName === "Las Palmas", resolvedGranCanaria.canonicalPortName);

assert(applyDiscoveryPortSynonym("NEW YORK CITY") === "New York", "port synonym");

// --- Non-geographic GTM ---
assert(isAzamaraNonGeographicGtm("COMBO"), "COMBO non-geographic");
assert(isAzamaraNonGeographicGtm("GRAND VOYAGE"), "GRAND VOYAGE non-geographic");
assert(!isAzamaraNonGeographicGtm("MEDITERRANEAN"), "Mediterranean is geographic");

const comboBlob = sanitiseAzamaraDestinationBlob({
  title: "ICELAND & CANADA COMBINATION CRUISE",
  description: "Destination: COMBO",
  gtmDestination: "COMBO"
});
assert(!/\bcombo\b/i.test(comboBlob), "COMBO stripped from blob");

const comboHits = matchDestination(`Destination: COMBO\n${comboBlob}`, destinations, []);
assert(!comboHits.some((h) => /combo/i.test(h.dest.name)), "COMBO not a destination hit");

// --- Destination inference fixtures ---
const cases = [
  {
    package: "JR260911-026",
    title: "ICELAND & CANADA COMBINATION CRUISE: REYKJAVIK, QUEBEC & HALIFAX",
    gtm: "COMBO",
    expected: "northern-europe"
  },
  {
    package: "ON261006-042",
    title: "VENICE TO LISBON GRAND VOYAGE",
    gtm: "GRAND VOYAGE",
    expected: "mediterranean"
  },
  {
    package: "QS270105-047",
    title: "SAN FRANCISCO TO SYDNEY GRAND VOYAGE",
    gtm: "GRAND VOYAGE",
    expected: "transpacific"
  },
  {
    package: "PR261002-029",
    title: "ASIA COMBINATION CRUISE: TOKYO, SEOUL & BEIJING",
    gtm: "COMBO",
    routeFrom: "TOKYO",
    routeTo: "HONG KONG",
    expected: "japan"
  },
  {
    package: "PR261002-078",
    title: "JAPAN TO NEW ZEALAND GRAND VOYAGE",
    gtm: "GRAND VOYAGE",
    routeFrom: "TOKYO",
    routeTo: "AUCKLAND",
    expected: "transpacific"
  },
  {
    package: "JR261007-012",
    title: "CANADA & NEW ENGLAND INTENSIVE CRUISE: NEWPORT, HALIFAX, CHARLOTTETOWN",
    gtm: "CANADA",
    expected: "canada-new-england"
  },
  {
    package: "QS270524-035",
    title: "SAN DIEGO TO LONDON GRAND VOYAGE",
    gtm: "GRAND VOYAGE",
    routeFrom: "SAN DIEGO",
    routeTo: "LONDON",
    expected: "transatlantic"
  },
  {
    package: "JR271110-024",
    title: "TURKEY, EGYPT & ITALY COMBINATION CRUISE: EPHESUS, ALEXANDRIA & AMALFI COAST",
    gtm: "COMBO",
    expected: "mediterranean"
  },
  {
    package: "QS280114-010",
    title: "PANAMA, ECUADAOR & PERU CRUISE: PANAMA CITY, MANTA & LIMA (CALLAO)",
    gtm: "SOUTH AMERICA",
    expected: "south-america"
  },
  {
    package: "QS280124-023",
    title: "CHILE, ANTARCTICA & FALKLAND ISLANDS COMBINATION CRUISE: CHILEAN FJORDS, USHUAIA",
    gtm: "COMBO",
    expected: "antarctica"
  },
  {
    package: "ON280301-027",
    title: "AUSTRALIA & ASIA COMBINATION CRUISE: CAIRNS, BALI & HONG KONG",
    gtm: "COMBO",
    expected: "south-pacific"
  },
  {
    package: "QS271227-028",
    title: "CARIBBEAN, CENTRAL AMERICA & PERU COMBINATION CRUISE: ARUBA, MIAMI & PANAMA",
    gtm: "COMBO",
    expected: "caribbean"
  },
  {
    package: "PR270205-048",
    title: "AUSTRALIA TO JAPAN GRAND VOYAGE",
    gtm: "GRAND VOYAGE",
    routeFrom: "AUSTRALIA",
    routeTo: "JAPAN",
    expected: "transpacific"
  }
];

for (const c of cases) {
  const inferred = inferAzamaraDestinationSlug({
    title: c.title,
    gtmDestination: c.gtm,
    routeFrom: c.routeFrom,
    routeTo: c.routeTo
  });
  assert(inferred?.slug === c.expected, `${c.package} expected ${c.expected} got ${inferred?.slug}`);
  const resolved = resolveAzamaraDestination({
    title: c.title,
    description: `Destination: ${c.gtm}`,
    gtmDestination: c.gtm,
    routeFrom: c.routeFrom,
    routeTo: c.routeTo,
    destinations,
    destinationAliases: [],
    matchDestination,
    pickDestinationFromHits
  });
  assert(resolved.destination?.slug === c.expected, `${c.package} resolve ${c.expected} got ${resolved.destination?.slug}`);
}

// --- Japan vs Africa regression ---
const japanBuilt = buildAzamara({
  title: "JAPAN INTENSIVE CRUISE: TOKYO, KOBE & NAGASAKI",
  description: "Explore this Japan Intensive Cruise",
  url: "https://www.azamara.com/cruises/pr261002-014-japan-intensive",
  excerpt: "Destination: AFRICA",
  structuredVoyage: {
    ship_name: "Azamara Pursuit",
    departure_date: "2026-10-02",
    nights: 14,
    package_code: "PR261002-014",
    gtm_destination: "ASIA",
    source: "azamara_gtm"
  },
  html: '<div data-gtm-duration="14-NIGHT CRUISE" data-gtm-destination="ASIA"></div>'
});
assert(!japanBuilt.skip, "Japan cruise builds");
assert(japanBuilt.candidate.matched_destination?.slug === "japan", "Japan wins over Africa vendor token");

// --- Route + destination end-to-end ---
const medBuilt = buildAzamara({
  title: "BEST OF THE MEDITERRANEAN CRUISE: MONTE CARLO, ROME & SORRENTO",
  description: "Explore this 11-Night Cruise from BARCELONA to VENICE (FUSINA)",
  url: "https://www.azamara.com/cruises/qs260913-011",
  excerpt: "Destination: MEDITERRANEAN",
  structuredVoyage: {
    ship_name: "Azamara Quest",
    departure_date: "2026-09-13",
    nights: 11,
    package_code: "QS260913-011",
    gtm_destination: "MEDITERRANEAN",
    source: "azamara_gtm"
  },
  html:
    '<div data-gtm-duration="11-NIGHT CRUISE" data-gtm-package-code="QS260913-011" data-gtm-ship-name="Azamara Quest" data-gtm-destination="MEDITERRANEAN"></div>'
});
assert(!medBuilt.skip, "Mediterranean route cruise builds");
assert(medBuilt.reasons?.length === 0 || medBuilt.status === "active", "Mediterranean active");
assert(medBuilt.candidate.departure_port_meta?.status === "resolved", "departure resolved");
assert(medBuilt.candidate.departure_port === "Barcelona", medBuilt.candidate.departure_port);
assert(medBuilt.candidate.matched_destination?.slug === "mediterranean", "med destination");

const southAmericaBuilt = buildAzamara({
  title: "PANAMA, ECUADAOR & PERU CRUISE: PANAMA CITY, MANTA & LIMA (CALLAO)",
  description:
    "Explore this Panama, Ecuadaor & Peru Cruise: Panama City, Manta & Lima (callao) sailing from PANAMA CITY (FUERTE AMADOR) to VALPARAISO",
  url: "https://www.azamara.com/cruises/qs280114-010",
  excerpt: "Destination: SOUTH AMERICA",
  structuredVoyage: {
    ship_name: "Azamara Quest",
    departure_date: "2028-01-14",
    nights: 10,
    package_code: "QS280114-010",
    gtm_destination: "SOUTH AMERICA",
    source: "azamara_gtm"
  },
  html:
    '<div data-gtm-duration="10-NIGHT CRUISE" data-gtm-package-code="QS280114-010" data-gtm-ship-name="Azamara Quest" data-gtm-destination="SOUTH AMERICA"></div>'
});
assert(!southAmericaBuilt.skip, "South America intensive builds");
assert(southAmericaBuilt.candidate.matched_destination?.slug === "south-america", "South America destination");

const saHits = matchDestination(
  "panama ecuador peru panama city manta lima callao south america",
  destinations,
  []
);
const filteredSaHits = preferAzamaraDestinationHits(
  saHits,
  "PANAMA, ECUADAOR & PERU CRUISE: PANAMA CITY, MANTA & LIMA (CALLAO)",
  "SOUTH AMERICA"
);
assert(
  !filteredSaHits.some((h) => h.dest.slug === "galapagos"),
  "Galapagos spurious hit filtered for South America intensive"
);
assert(
  pickDestinationFromHits(filteredSaHits, southAmericaBuilt.candidate.title)?.slug === "south-america",
  "picker agrees with South America after Galapagos filter"
);

assert(
  !matchDestination(southAmericaBuilt.candidate.matched_destination?.name || "", destinations, []).some(
    (h) => h.dest.slug === "galapagos"
  ) || southAmericaBuilt.candidate.matched_destination?.slug === "south-america",
  "South America not replaced by Galapagos"
);

const nycBuilt = buildAzamara({
  title: "CANADA & NEW ENGLAND INTENSIVE CRUISE: NEWPORT, HALIFAX, CHARLOTTETOWN",
  description: "Explore this cruise sailing from NEW YORK CITY on Oct 7 2026",
  url: "https://www.azamara.com/cruises/jr261007-012",
  excerpt: "Destination: CANADA",
  structuredVoyage: {
    ship_name: "Azamara Journey",
    departure_date: "2026-10-07",
    nights: 12,
    package_code: "JR261007-012",
    gtm_destination: "CANADA",
    source: "azamara_gtm"
  },
  html:
    '<div data-gtm-duration="12-NIGHT CRUISE" data-gtm-package-code="JR261007-012" data-gtm-ship-name="Azamara Journey" data-gtm-destination="CANADA"></div>'
});
assert(!nycBuilt.skip, "New York City embark builds");
assert(nycBuilt.candidate.departure_port === "New York", nycBuilt.candidate.departure_port);

// --- Stale source policy ---
const stale = azamaraStaleSourceGate({
  html: "<html><title>Azamara Cruises | Award-Winning Small Ship Cruise Line</title></html>",
  title: "Azamara Cruises | Award-Winning Small Ship Cruise Line",
  url: "https://www.azamara.com/cruises/pr270408-014-dead"
});
assert(stale?.reason === "source_stale_or_unavailable", "stale homepage rejected");

const staleGate = azamaraPreBuildGate({
  cruiseLine: azamaraLine,
  url: "https://www.azamara.com/cruises/pr270408-014-dead",
  title: "Azamara Cruises | Award-Winning Small Ship Cruise Line",
  description: "",
  structuredVoyage: { package_code: "PR270408-014" },
  html: "<html><title>Azamara Cruises | Award-Winning Small Ship Cruise Line</title></html>"
});
assert(staleGate?.reason === "source_stale_or_unavailable", "pre-build stale gate");

const liveHtml =
  '<div data-gtm-duration="14-NIGHT CRUISE" data-gtm-package-code="PR280428-014" data-gtm-ship-name="Azamara Pursuit" data-gtm-destination="JAPAN" data-gtm-cruise-name="JAPAN INTENSIVE"></div>';
assert(!azamaraStaleSourceGate({ html: liveHtml, title: "JAPAN INTENSIVE" }), "live page not stale");

console.log("test-azamara-recovery — all assertions passed");
