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

const malformedQuoteFixture = `<div data-recently-viewed-cruise="${JSON.stringify({
  completeItinerary: {
    ...completeFixture.completeItinerary,
    marketingCopy: 'Enjoy some "me" time in Mandara Spa®'
  }
})
  .replace(/"/g, "&quot;")}"></div>`;
const malformedExtract = ncl.extractCompleteItineraryFromHtml(malformedQuoteFixture);
assert(malformedExtract.ok === true, "completeItinerary extracted when embedded JSON has unescaped quotes");

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

  const scheduleUrl = (code) =>
    `https://www.ncl.com/au/en/cruises/${code}/schedule?itineraryCode=${code}`;

  const reconciliationEligible = [
    { official_sailing_id: "ACTIVE7MIABPIMIA|2027-01-01" },
    { official_sailing_id: "MATCH7MIABPIMIA|2027-02-01" },
    { official_sailing_id: "HIDDEN7MIABPIMIA|2027-03-01" },
    { official_sailing_id: "MISSING7MIABPIMIA|2027-04-01" }
  ];

  const reconciliationRows = [
    {
      id: "db-active",
      status: "active",
      official_sailing_id: "ACTIVE7MIABPIMIA|2027-01-01",
      external_key: "active-key",
      identity_key: "active-identity",
      itinerary: "ACTIVE7MIABPIMIA",
      departure_date: "2027-01-01",
      official_url: scheduleUrl("ACTIVE7MIABPIMIA")
    },
    {
      id: "db-match",
      status: "match_required",
      official_sailing_id: "MATCH7MIABPIMIA|2027-02-01",
      external_key: "match-key",
      identity_key: "match-identity",
      itinerary: "MATCH7MIABPIMIA",
      departure_date: "2027-02-01",
      official_url: scheduleUrl("MATCH7MIABPIMIA")
    },
    {
      id: "db-hidden",
      status: "hidden",
      official_sailing_id: "HIDDEN7MIABPIMIA|2027-03-01",
      external_key: "hidden-key",
      identity_key: "hidden-identity",
      itinerary: "HIDDEN7MIABPIMIA",
      departure_date: "2027-03-01",
      official_url: scheduleUrl("HIDDEN7MIABPIMIA")
    },
    {
      id: "legacy-generic",
      status: "match_required",
      official_sailing_id: null,
      official_url: "https://www.ncl.com/au/en/travel-blog/2026-alaska-cruises",
      external_key: "legacy-key"
    }
  ];

  const reconciliation = await ncl.reconcileProductionReadOnly({
    cruiseLineId: nclLine.id,
    eligibleProducts: reconciliationEligible,
    supabaseQuery: async () => reconciliationRows,
    today: ctx.today
  });

  assert(reconciliation.recognised_existing_eligible === 3, "active/match_required/hidden genuine rows recognised");
  assert(reconciliation.outstanding_eligible_inserts === 1, "missing source voyage remains outstanding");
  assert(reconciliation.source_recognition.recognised_active === 1, "active recognised separately");
  assert(reconciliation.source_recognition.recognised_match_required === 1, "match_required recognised separately");
  assert(reconciliation.source_recognition.legacy_generic_ignored === 1, "legacy generic row excluded");
  assert(reconciliation.legacy_generic_rows === 1, "legacy generic count isolated");
  assert(reconciliation.genuine_inventory_rows === 3, "genuine inventory excludes legacy generic");
  assert(reconciliation.reconciliation_arithmetic.reconciles === true, "recognition + outstanding arithmetic");

  const duplicateRows = [
    ...reconciliationRows.slice(0, 2),
    {
      id: "db-dup",
      status: "match_required",
      official_sailing_id: "MATCH7MIABPIMIA|2027-02-01",
      external_key: "dup-key",
      identity_key: "dup-identity",
      itinerary: "MATCH7MIABPIMIA",
      departure_date: "2027-02-01",
      official_url: scheduleUrl("MATCH7MIABPIMIA")
    }
  ];
  const duplicateReconciliation = await ncl.reconcileProductionReadOnly({
    cruiseLineId: nclLine.id,
    eligibleProducts: reconciliationEligible.slice(0, 2),
    supabaseQuery: async () => duplicateRows,
    today: ctx.today
  });
  assert(
    duplicateReconciliation.duplicate_diagnostics.duplicate_official_sailing_ids.length === 1,
    "duplicate official sailing ids fail reconciliation"
  );
  assert(duplicateReconciliation.reconciliation_arithmetic.reconciles === false, "duplicate identities break arithmetic");

  assert(ncl.isGenuineInventoryRow(reconciliationRows[1]), "match_required schedule row is genuine");
  assert(!ncl.isGenuineInventoryRow(reconciliationRows[3]), "legacy generic row is not genuine");

  const enrichmentWrites = require(path.join(root, "netlify/functions/lib/norwegian-discovery-enrichment-writes"));
  const htmlFixture = `<div data-recently-viewed-cruise='${JSON.stringify(completeFixture).replace(/'/g, "&#x27;")}'></div>`;
  const extraction = ncl.extractCompleteItineraryFromHtml(htmlFixture);
  assert(extraction.ok, "completeItinerary parser succeeds on fixture");
  const parsedFixture = ncl.parseEnrichedItinerary(extraction.completeItinerary);
  assert(parsedFixture.title.includes("Bahamas"), "title extraction");
  assert(parsedFixture.disembarkation_port.includes("Miami"), "disembark extraction");
  assert(parsedFixture.ordered_ports.length === 4, "ordered port extraction");
  assert(parsedFixture.unsupported_fields.includes("per_port_dates"), "no fabricated dates");

  const dbRow = {
    itinerary: "GETAWAY2MIANPIMIA",
    nights: 2,
    departure_port: "Miami",
    raw_extract: { ncl_itinerary_code: "GETAWAY2MIANPIMIA" },
    status: "match_required"
  };
  const identityOk = enrichmentWrites.validateSchedulePageIdentity(
    dbRow,
    parsedFixture,
    extraction.completeItinerary,
    "GETAWAY2MIANPIMIA"
  );
  assert(identityOk.ok, "page identity matches fixture voyage");
  const mismatch = enrichmentWrites.validateSchedulePageIdentity(
    dbRow,
    parsedFixture,
    { code: "OTHERCODE" },
    "GETAWAY2MIANPIMIA"
  );
  assert(!mismatch.ok, "page identity mismatch detected");

  const resolved = enrichmentWrites.resolveOrderedPorts(extraction.completeItinerary.portsData.portsOfCall);
  assert(resolved.some((p) => p.canonical_port === "Great Stirrup Cay"), "Great Stirrup Cay resolves distinctly");
  const patch = enrichmentWrites.buildEnrichmentPatch(dbRow, {
    parsed: parsedFixture,
    completeItinerary: extraction.completeItinerary,
    resolved_ports: resolved,
    port_summary: enrichmentWrites.summarisePortResolution(resolved),
    outcome: "enrichment_ready",
    extraction_method: extraction.method,
    schedule_url: "https://example.test/schedule"
  });
  assert(!patch.core_identity_changes.length, "enrichment patch does not alter core identity");
  assert(Array.isArray(patch.patch.itinerary_ports), "itinerary_ports proposed");
  assert((patch.patch.raw_extract.ncl_unsupported_fields || []).includes("arrival_times"), "unsupported timing documented");

  const originalSummary = patch.patch.raw_extract.ncl_ordered_ports_summary;
  const reorderedRaw = {
    ...patch.patch.raw_extract,
    ncl_ordered_ports_summary: {
      safe_equivalent: originalSummary.safe_equivalent,
      total: originalSummary.total,
      exact: originalSummary.exact,
      existing_alias: originalSummary.existing_alias,
      unresolved: originalSummary.unresolved,
      ambiguous: originalSummary.ambiguous
    }
  };
  assert(
    enrichmentWrites.enrichmentValuesEqual("raw_extract", patch.patch.raw_extract, reorderedRaw),
    "raw_extract semantic compare ignores key order"
  );
  const fieldChanges = enrichmentWrites.diffPatchProposal(
    { ...dbRow, ...patch.patch },
    patch
  );
  assert(Object.keys(fieldChanges).length === 0, "repeat enrichment does not duplicate itinerary relationships");

  const poc = require(path.join(root, "netlify/functions/lib/norwegian-port-of-call-mappings"));
  const nclDest = require(path.join(root, "netlify/functions/lib/norwegian-destination-mapping"));
  assert(poc.getPortOfCallCanonicalName("PWM") === "Portland Maine", "Portland ME maps to Portland, Maine");
  assert(poc.getPortOfCallCanonicalName("FMH") === "Falmouth Jamaica", "Falmouth JA maps to Falmouth, Jamaica");
  assert(poc.getPortOfCallCanonicalName("SMZ") === "Shimizu", "Mount Fuji/Shimizu maps to Shimizu");
  assert(poc.getPortOfCallCanonicalName("WRF") === "Royal Naval Dockyard", "Royal Naval Dockyard mapped");
  assert(poc.getPortOfCallCanonicalName("BAR") === "Bar", "Bar ME disambiguated to Bar, Montenegro via code");
  assert(poc.getPortOfCallCanonicalName("PSY") === "Stanley", "Stanley Falkland Islands mapped");
  assert(poc.getPortOfCallCanonicalName("BPI") === "Harvest Caye", "Harvest Caye remains distinct");
  assert(poc.getPortOfCallCanonicalName("NPO") === "Newport Rhode Island", "Newport RI mapped distinctly");
  assert(poc.getPortOfCallCanonicalName("VIS") === "Vik Norway", "Vik Norway distinct from Visby");
  assert(poc.getPortOfCallCanonicalName("VBY") === "Visby", "Visby Sweden mapped");
  assert(poc.getPortOfCallCanonicalName("RIX") === "Riga", "Riga Latvia mapped");
  assert(poc.getPortOfCallCanonicalName("LPA") === "Las Palmas", "Las Palmas mapped");
  assert(poc.getPortOfCallCanonicalName("LVN") === "Le Verdon", "Le Verdon distinct from Bordeaux city");
  assert(poc.getPortOfCallCanonicalName("SCT") === "Santa Cruz de Tenerife", "Tenerife distinct from La Palma");

  const phase6aCodes = {
    ACA: "Acapulco",
    PRQ: "Puerto Quetzal",
    PCL: "Puerto Caldera",
    HOR: "Horta",
    LXO: "Leixoes",
    AST: "Astoria Oregon",
    BRI: "Bari",
    KCZ: "Kochi Japan",
    NAH: "Naha",
    NII: "Niigata",
    CMY: "Chan May",
    HAN: "Halong Bay",
    ESS: "Phillip Island",
    DEN: "Denarau",
    SVU: "Savusavu",
    DRA: "Dravuni"
  };
  for (const [code, canonical] of Object.entries(phase6aCodes)) {
    assert(poc.getPortOfCallCanonicalName(code) === canonical, `Phase 6A port ${code} maps to ${canonical}`);
  }

  const simCounts = {
    raw: 2492,
    ocean: 2062,
    cutoff: 45,
    eligible: 2017,
    cruisetours: 430
  };
  assert(simCounts.ocean - simCounts.cutoff === simCounts.eligible, "ocean minus cutoff equals eligible");
  assert(simCounts.raw >= simCounts.ocean, "raw sailings include ocean subset");
  assert(simCounts.cruisetours > 0, "cruisetour count reported separately from eligible ocean");

  const getawayRow = {
    nights: 11,
    raw_extract: { ncl_itinerary_code: "GETAWAY11SOULEHZEEMLYSKJAESAKUISAREY" },
    departure_port: "Southampton"
  };
  const getawayParsed = {
    ok: true,
    title: "7-Day Europe From London To Reykjavik: France, Iceland & Belgium",
    duration: { days: 11, text: "11-day Cruise" }
  };
  const getawayItinerary = { code: "GETAWAY11SOULEHZEEMLYSKJAESAKUISAREY" };
  const getawaySemantic = enrichmentWrites.validateSemanticEnrichment(getawayRow, getawayParsed, getawayItinerary);
  assert(
    getawaySemantic.status === "VERIFIED_WITH_MARKETING_TITLE_DIFFERENCE",
    "Getaway 11-night versus 7-Day title classified as marketing difference"
  );

  const prideTitle = enrichmentWrites.normalizeItineraryTitle(" 7-Day Hawaii Inter-Island from Honolulu ");
  assert(prideTitle === "7-Day Hawaii Inter-Island from Honolulu", "Pride of America whitespace normalised");

  const destPlan = nclDest.resolveSlugFromCodes(["CARIBBEAN", "EXTRAORDINARY_JOURNEYS"]);
  assert(destPlan.slug === "caribbean", "marketing EXTRAORDINARY_JOURNEYS ignored for primary destination");
  const transPlan = nclDest.resolveSlugFromCodes(["EXTRAORDINARY_JOURNEYS", "TRANSATLANTIC"]);
  assert(transPlan.slug === "transatlantic", "TRANSATLANTIC chosen over marketing tag");
  const ausPlan = nclDest.resolveSlugFromCodes(["AUSTRALIA", "EXTRAORDINARY_JOURNEYS"]);
  assert(ausPlan.slug === "australia-new-zealand", "AUSTRALIA maps to australia-new-zealand");
  const pacificCoastalPlan = nclDest.resolveSlugFromCodes(["PACIFIC_COASTAL"]);
  assert(pacificCoastalPlan.slug === "pacific-coast", "PACIFIC_COASTAL maps to pacific-coast");

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
