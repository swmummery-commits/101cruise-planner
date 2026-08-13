#!/usr/bin/env node
/**
 * Norwegian read-only discovery tests (Phase 2).
 * Run: npm run test:norwegian-discovery
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const browseFixture = require(path.join(root, "scripts/fixtures/norwegian/browse-itineraries-v1.json"));
const filtersFixture = require(path.join(root, "scripts/fixtures/norwegian/browse-filters-v1.json"));
const completeFixture = require(path.join(root, "scripts/fixtures/norwegian/complete-itinerary-getaway.json"));
const source = require(path.join(root, "netlify/functions/lib/norwegian-discovery-source"));
const ncl = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));
const embarkPorts = require(path.join(root, "netlify/functions/lib/norwegian-embark-port-mappings"));
const { resetPortsCache } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));
const {
  daysUntilDeparture,
  PUBLIC_BOOKING_CUTOFF_DAYS,
  PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE
} = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

const nclLine = {
  id: "c5f5361f-ebe5-4ff4-babe-7eb07f609bae",
  name: "Norwegian Cruise Line",
  slug: "norwegian-cruise-line"
};

const nclShips = Object.entries(ncl.NCL_SHIP_CODE_TO_NAME).map(([code, name], index) => ({
  id: `ship-${index}`,
  name,
  cruise_line_id: nclLine.id,
  official_line_ship_id: null
}));

const ctx = { cruiseLine: nclLine, ships: nclShips, today: "2026-08-13" };

assert(Array.isArray(browseFixture), "browse fixture is array");
assert(browseFixture.length >= 5, "browse fixture has sample itineraries");

const expanded = source.expandBrowseCatalogue(browseFixture);
assert(expanded.sailings.length === 9, "sailingDates[] expansion count");
assert(
  expanded.sailings.some((s) => s.official_product_key === "GETAWAY2MIANPIMIA|2026-08-09"),
  "epoch ms sailing date normalised"
);

const classification = ncl.analyseItineraryClassification(browseFixture);
assert(classification.counts.ocean === 4, "ocean itinerary count in fixture");
assert(classification.counts.cruisetour_package === 2, "cruisetour/package count in fixture");
assert(classification.counts.ambiguous === 1, "ambiguous count for missing ship code record");
assert(classification.validation.fail_closed === true, "ambiguous fixture triggers fail-closed");

const safeClassification = ncl.analyseItineraryClassification(browseFixture.filter((r) => r.shipCode));
assert(safeClassification.validation.safe_to_apply_exclusion_rule === true, "classification safe when shipCode present");

const getawayOcean = browseFixture.find((r) => r.codes[0] === "GETAWAY2MIANPIMIA");
assert(ncl.classifyNorwegianItinerary(getawayOcean).category === "ocean", "Getaway classified ocean");
const cruisetour = browseFixture.find((r) => /CRUISETOUR/.test(r.codes[0]));
assert(ncl.classifyNorwegianItinerary(cruisetour).category === "cruisetour_package", "CRUISETOUR excluded");
const nbTour = browseFixture.find((r) => r.codes[0].startsWith("NB"));
assert(ncl.classifyNorwegianItinerary(nbTour).category === "cruisetour_package", "NB prefix excluded");

const shipMappings = ncl.buildShipMappings(filtersFixture, nclShips);
assert(shipMappings.resolved_count === 4, "known ships mapped");
assert(shipMappings.unresolved_count === 1, "unknown ship unresolved");
const prideMapping = shipMappings.mappings.find((m) => m.source_ship_code === "PRIDE_AMER");
assert(prideMapping?.db_ship_name === "Pride of America", "PRIDE_AMER maps to Pride of America");

const rawSailing = expanded.sailings.find((s) => s.itinerary_code === "GETAWAY2MIANPIMIA");
const normalised = ncl.normaliseNorwegianSailing(rawSailing, ctx);
assert(normalised.ship_resolution.resolved, "Getaway ship resolves");
assert(normalised.official_sailing_id.includes("|"), "official sailing id uses itinerary|date");
assert(
  normalised.external_key === ncl.norwegianExternalKey(nclLine.id, normalised.official_sailing_id),
  "deterministic external key"
);

const identityRows = expanded.sailings
  .filter((s) => ncl.classifyNorwegianItinerary(s.raw_itinerary).category === "ocean")
  .map((raw) => ncl.normaliseNorwegianSailing(raw, ctx));
const identity = ncl.analyseIdentity(identityRows);
assert(identity.official_key_collisions.length === 0, "no identity collisions in ocean fixture sailings");

const sameAgain = ncl.officialProductKey(rawSailing);
assert(sameAgain === normalised.official_sailing_id, "same voyage remains same ID");
const differentDate = source.officialProductKey("GETAWAY2MIANPIMIA", "2027-04-10");
assert(differentDate !== sameAgain, "different dates produce different voyage IDs");

assert(daysUntilDeparture("2026-09-04", ctx.today) === 22, "22 days away eligible");
assert(daysUntilDeparture("2026-09-04", ctx.today) >= PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE, "boundary eligible");
assert(daysUntilDeparture("2026-09-03", ctx.today) === 21, "21 days away");
assert(daysUntilDeparture("2026-09-03", ctx.today) <= PUBLIC_BOOKING_CUTOFF_DAYS, "21 days excluded");

const eligibilityRows = expanded.sailings.map((raw) => ncl.normaliseNorwegianSailing(raw, ctx));
const eligibility = ncl.buildEligibilitySummary(eligibilityRows, ctx.today);
assert(eligibility.arithmetic.reconciles === true, "eligibility arithmetic reconciles");

const htmlFixture = `<div data-recently-viewed-cruise='${JSON.stringify(completeFixture).replace(/'/g, "&#39;")}'></div>`;
const extracted = ncl.extractCompleteItineraryFromHtml(htmlFixture);
assert(extracted.ok === true, "completeItinerary extracted from HTML attribute");
const parsed = ncl.parseEnrichedItinerary(extracted.completeItinerary);
assert(parsed.title.includes("Bahamas"), "enrichment title parsed");
assert(parsed.ordered_port_count === 4, "ordered ports parsed");
assert(parsed.package_id === "PKG123", "packageId captured as supporting metadata");
assert(parsed.sail_id === "SAIL456", "sailId captured as supporting metadata");

const missingJson = ncl.extractCompleteItineraryFromHtml("<html><body>No data</body></html>");
assert(missingJson.ok === false, "missing enrichment handled");

resetPortsCache();

const tarPort = ncl.resolveNorwegianDeparturePort({ port_of_departure_code: "TAR" });
assert(tarPort.canonicalPortName === "Tarragona", "Tarragona remains distinct from Barcelona");
const ravPort = ncl.resolveNorwegianDeparturePort({ port_of_departure_code: "RAV" });
assert(ravPort.canonicalPortName === "Ravenna", "Ravenna remains distinct from Venice");
const triestePort = ncl.resolveNorwegianDeparturePort({ port_of_departure_code: "VCE" });
assert(triestePort.canonicalPortName === "Trieste", "Trieste remains distinct from Venice");
const sanAntonioPort = ncl.resolveNorwegianDeparturePort({ port_of_departure_code: "SAI" });
assert(sanAntonioPort.canonicalPortName === "San Antonio", "San Antonio does not resolve to Valparaiso");
const incheonPort = ncl.resolveNorwegianDeparturePort({ port_of_departure_code: "INC" });
assert(incheonPort.canonicalPortName === "Incheon", "Incheon represents Seoul (Incheon)");
const southamptonPort = ncl.resolveNorwegianDeparturePort({ port_of_departure_code: "SOU" });
assert(southamptonPort.canonicalPortName === "Southampton", "London (Southampton) resolves to Southampton");
const pcvPort = ncl.resolveNorwegianDeparturePort({ port_of_departure_code: "PCV" });
assert(pcvPort.canonicalPortName === "Port Canaveral", "Port Canaveral marketing alias");

const gsc = ncl.analysePortResolutionSamples(["Great Stirrup Cay, Bahamas"]).results[0];
assert(gsc.canonical_port_name === "Great Stirrup Cay", "Great Stirrup Cay canonical port exists");
assert(gsc.canonical_port_name !== "Perfect Day at CocoCay", "Great Stirrup Cay distinct from CocoCay");

const embarkAudit = ncl.auditEmbarkPortCatalogue();
assert(embarkAudit.length === 40, "complete embark port audit count");
assert(embarkAudit.every((row) => row.classification), "every embark port classified");
assert(embarkAudit.every((row) => row.code_resolution_canonical_name), "every embark port resolves via code map");

const prideShipCtx = {
  ...ctx,
  ships: nclShips.map((ship) =>
    ship.name === "Pride of America" ? { ...ship, official_line_ship_id: "PRIDE_AMER" } : ship
  )
};
const prideNorm = ncl.normaliseNorwegianSailing(
  {
    itinerary_code: "PRIDE_AMER7HNLOGGITOKOANWKHNL",
    ship_code: "PRIDE_AMER",
    departure_date: "2027-01-01",
    port_of_departure_code: "HNL",
    raw_itinerary: {
      codes: ["PRIDE_AMER7HNLOGGITOKOANWKHNL"],
      shipCode: "PRIDE_AMER",
      portOfDepartureCode: "HNL",
      duration: 7,
      destinationCodes: ["HAWAII"],
      sailingDates: [1796001600000]
    }
  },
  prideShipCtx
);
assert(prideNorm.ship_resolution.method === "official_line_ship_id", "PRIDE_AMER resolves via official_line_ship_id");

assert(new Set(Object.keys(ncl.NCL_SHIP_CODE_TO_NAME)).size === 22, "all 22 NCL ship IDs unique");

(async () => {
  let browseCalls = 0;
  const mockFetch = async (url) => {
    if (String(url).includes("/itineraries")) {
      browseCalls += 1;
      if (browseCalls > 1) {
        return { ok: false, status: 500, text: async () => "fail" };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(browseFixture)
      };
    }
    if (String(url).includes("/filters")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(filtersFixture)
      };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  await source.fetchNorwegianBrowseCatalogue({ fetchImpl: mockFetch, attempts: 1 });
  let failed = false;
  try {
    await source.fetchNorwegianBrowseCatalogue({ fetchImpl: mockFetch, attempts: 1 });
  } catch {
    failed = true;
  }
  assert(failed, "malformed/HTTP failure surfaces");

  const unknownShipRaw = {
    itinerary_code: "UNKNOWN7MIABPIMIA",
    ship_code: "NOT_A_SHIP",
    departure_date: "2027-01-01",
    port_of_departure_code: "MIA",
    raw_itinerary: {
      codes: ["UNKNOWN7MIABPIMIA"],
      shipCode: "NOT_A_SHIP",
      portOfDepartureCode: "MIA",
      duration: 7,
      destinationCodes: ["CARIBBEAN"],
      sailingDates: [1796001600000]
    }
  };
  const unknownNorm = ncl.normaliseNorwegianSailing(unknownShipRaw, ctx);
  assert(unknownNorm.ship_resolution.resolved === false, "unknown ship fails closed");
  assert(unknownNorm.failure_reasons.includes("unresolved_ship"), "unknown ship reason recorded");

  const simulation = await ncl.simulateNorwegianDiscovery({
    cruiseLine: nclLine,
    ships: nclShips,
    today: ctx.today,
    fetchImpl: async (url) => {
      if (String(url).includes("/itineraries")) {
        return { ok: true, status: 200, text: async () => JSON.stringify(browseFixture) };
      }
      if (String(url).includes("/filters")) {
        return { ok: true, status: 200, text: async () => JSON.stringify(filtersFixture) };
      }
      if (String(url).includes("/schedule")) {
        return {
          ok: true,
          status: 200,
          text: async () => htmlFixture
        };
      }
      throw new Error(`Unexpected ${url}`);
    },
    runEnrichment: true,
    enrichmentCodes: ["GETAWAY2MIANPIMIA"]
  });

  assert(simulation.writes_performed === false, "simulation produces zero production writes");
  assert(simulation.read_only === true, "simulation read-only flag");
  assert(simulation.enrichment.length === 1, "controlled enrichment sample only");
  assert(simulation.enrichment[0].parsed.ordered_port_count === 4, "enrichment sample parsed");

  console.log(`Norwegian discovery tests passed (${passed})`);
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
