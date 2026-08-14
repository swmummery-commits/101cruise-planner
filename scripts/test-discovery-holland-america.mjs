#!/usr/bin/env node
/**
 * Holland America Line Discovery adapter — hardened tests.
 * Run: npm run test:discovery-holland-america
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const fixture = require(path.join(root, "scripts/fixtures/holland-america/search-response-page.json"));
const hardening = require(path.join(root, "scripts/fixtures/holland-america/hardening-fixtures.json"));
const hal = require(path.join(root, "netlify/functions/lib/holland-america-discovery-adapter"));
const batch = require(path.join(root, "netlify/functions/lib/holland-america-discovery-batch"));
const mode = require(path.join(root, "netlify/functions/lib/holland-america-discovery-mode"));
const { resolveAdapter } = require(path.join(root, "netlify/functions/lib/cruise-discovery-adapters"));
const { resolveOperationalDestination } = require(path.join(root, "netlify/functions/lib/discovery-destination-resolver"));
const { AUTO_ALIAS_WRITES_ENABLED } = require(path.join(root, "netlify/functions/lib/discovery-ship-resolver"));
const { loadPortsCatalogue } = require(path.join(root, "netlify/functions/lib/discovery-departure-port"));
const { OPERATIONAL_DESTINATION_CATALOGUE } = require(path.join(root, "netlify/functions/lib/destination-classification"));

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  passed += 1;
}

const halLine = { id: "hal-line", name: "Holland America Line", slug: "holland-america-line" };
const halShips = [
  { id: "s-zaandam", name: "ms Zaandam", cruise_line_id: "hal-line" },
  { id: "s-eurodam", name: "ms Eurodam", cruise_line_id: "hal-line" },
  { id: "s-rotterdam", name: "ms Rotterdam", cruise_line_id: "hal-line" },
  { id: "s-nieuw", name: "ms Nieuw Statendam", cruise_line_id: "hal-line" },
  { id: "s-west", name: "ms Westerdam", cruise_line_id: "hal-line" }
];
const destinations = OPERATIONAL_DESTINATION_CATALOGUE.map((c) => ({
  id: null,
  name: c.name,
  slug: c.slug,
  status: c.public_status,
  classification_enabled: c.classification_enabled
}));
const ctx = { cruiseLine: halLine, ships: halShips, destinations, today: "2026-08-02" };

assert(hal.parseHalDelimited("Zaandam#@#AA").name === "Zaandam", "delimited parse");
assert(hal.buildOfficialUrl("/find-a-cruise/a6g07c/x656").includes("/en/au/find-a-cruise/a6g07c/x656"), "official url");

const docs = fixture.response.docs;
const parsed = docs.map((d) => hal.parseRawVoyageFromDoc(d)).filter(Boolean);
assert(parsed.length === 4, "parses fixture docs");
assert(parsed[0].cruise_id === "X656", "voyage id preserved");
assert(hal.officialProductKey(parsed[0]) === "A6G07C|X656", "official product key");

const future = parsed.filter((p) => p.departure_date >= "2026-01-01");
const deduped = new Map();
for (const raw of future) deduped.set(hal.officialProductKey(raw), raw);
assert(deduped.size === 2, "duplicate voyage collapses");

const sanDiegoPort = hal.resolveHalDeparturePort({
  departure_port: "San Diego, California, US",
  departure_port_code: "SAN"
});
assert(sanDiegoPort.status === "resolved" && sanDiegoPort.canonicalPortName === "San Diego", "San Diego port resolves");

const ports = loadPortsCatalogue();
const portNames = ports.map((p) => p.canonical_name);
assert(portNames.filter((n) => n === "Rotterdam").length === 1, "single Rotterdam canonical");
assert(portNames.filter((n) => n === "San Diego").length === 1, "single San Diego canonical");
assert(portNames.filter((n) => n === "Lisbon").length === 1, "single Lisbon canonical");
assert(!portNames.includes("Fairbanks"), "Fairbanks not added as cruise port");

const hardDocs = hardening.response.docs;
const crossingRaw = hal.parseRawVoyageFromDoc(hardDocs[0]);
const cruisetourRaw = hal.parseRawVoyageFromDoc(hardDocs[1]);
const europeRaw = hal.parseRawVoyageFromDoc(hardDocs[2]);

const crossingNorm = hal.normaliseHalVoyage(crossingRaw, ctx);
assert(crossingNorm.destination_resolution.destinationKey === "transpacific", "North Pacific crossing → Transpacific");
assert(crossingNorm.product_type === "cruise", "crossing remains cruise product");

const asiaCodeOnly = hal.resolveHalDestinationHints({
  destination_codes: ["O"],
  destination_labels: ["ASIA"],
  title: "7-Day Japan Explorer",
  itinerary_text: "Tokyo, Yokohama, Osaka",
  departure_port: "Tokyo, Japan",
  arrival_port: "Tokyo, Japan"
});
assert(!asiaCodeOnly.crossing, "regional Asia without crossing evidence");

const vancouverOnly = resolveOperationalDestination({
  title: "Departs Vancouver",
  departurePort: "Vancouver",
  destinations
});
assert(vancouverOnly.destinationKey !== "transpacific" || vancouverOnly.status !== "resolved", "Vancouver alone not Transpacific");

const cruisetourNorm = hal.normaliseHalVoyage(cruisetourRaw, ctx);
assert(cruisetourNorm.product_type === "cruisetour", "HAL cruisetour detected");
assert(!cruisetourNorm.projected_activation, "cruisetour not activated");
assert(cruisetourNorm.failure_reasons.includes("cruisetour_excluded"), "cruisetour excluded reason");
assert(cruisetourNorm.candidate.departure_port === "Vancouver", "cruisetour does not map Fairbanks to Whittier");

const europeNorm = hal.normaliseHalVoyage(europeRaw, ctx);
assert(
  europeNorm.destination_resolution.destinationKey === "norwegian-fjords",
  "Europe northern + Iceland → Norwegian Fjords"
);

const alaskaNorm = hal.normaliseHalVoyage(parsed[0], ctx);
assert(alaskaNorm.ship_resolution.resolved, "HAL ship resolves");
assert(alaskaNorm.destination_resolution.destinationKey === "alaska", "Alaska from itinerary");

const msVariant = hal.normaliseHalVoyage({ ...parsed[0], ship_name: "MS Zaandam" }, ctx);
assert(msVariant.ship_resolution.resolved, "MS prefix resolves");

const crossLine = hal.normaliseHalVoyage(parsed[0], {
  ...ctx,
  ships: [{ id: "x", name: "Celebrity Beyond", cruise_line_id: "other" }]
});
assert(!crossLine.ship_resolution.resolved, "cross-line ship rejected");

const carib = hal.normaliseHalVoyage(parsed[1], ctx);
assert(carib.destination_resolution.destinationKey === "caribbean", "Caribbean itinerary");

const pastNorm = hal.normaliseHalVoyage(parsed[2], ctx);
assert(pastNorm.failure_reasons.includes("past_departure"), "past sailing rejected");

const collectorA = hal.parseRawVoyageFromDoc({
  cruiseId: "W728",
  itineraryId: "A7N07C",
  departDate: "2027-05-09T00:00:00Z",
  shipName: "Westerdam#@#WE",
  embarkPortName: "Vancouver, B.C., CA#@#YVR"
});
const collectorB = hal.parseRawVoyageFromDoc({
  cruiseId: "W728",
  itineraryId: "A7N07CDAC",
  tourId: "T7ADAC",
  cruiseType: "SEA_FIRST",
  departDate: "2027-05-09T00:00:00Z",
  shipName: "Westerdam#@#WE",
  embarkPortName: "Vancouver, B.C., CA#@#YVR"
});
assert(hal.officialProductKey(collectorA) !== hal.officialProductKey(collectorB), "collector/component stay separate");

assert(mode.resolveHalDiscoveryMode("simulation").writes_allowed === false, "simulation cannot write");
assert(mode.resolveHalDiscoveryMode("production_read_only").writes_allowed === false, "production_read_only cannot write");
assert(mode.resolveHalDiscoveryMode(undefined).writes_allowed === false, "missing mode cannot write");
assert(mode.resolveHalDiscoveryMode("bogus").writes_allowed === false, "invalid mode cannot write");
assert(mode.resolveHalDiscoveryMode("production_write").writes_allowed === false, "production_write blocked by flag");

let writeBlocked = false;
try {
  mode.assertHalWritesAllowed(mode.resolveHalDiscoveryMode("production_write"));
} catch (e) {
  writeBlocked = e.code === "hal_discovery_write_forbidden";
}
assert(writeBlocked, "assertHalWritesAllowed blocks write");

const lock1 = batch.acquireRunLock("run-a");
const lock2 = batch.acquireRunLock("run-a");
assert(lock1.acquired && !lock2.acquired, "overlapping HAL runs blocked");
batch.releaseRunLock("run-a");

const batchResult = await batch.runHalDiscoveryBatch({
  mode: "simulation",
  runId: "test-batch-1",
  cursorStart: 0,
  maxPages: 1,
  maxCandidates: 5,
  ...ctx
});
assert(batchResult.ok, "batch executes");
assert(batchResult.writes_performed === false, "batch simulation no writes");
assert(batchResult.cursor.next_start >= 0, "batch cursor produced");
batch.releaseRunLock("test-batch-1");

const batchAgain = await batch.runHalDiscoveryBatch({
  mode: "simulation",
  runId: "test-batch-2",
  cursorStart: batchResult.cursor.next_start,
  maxPages: 1,
  maxCandidates: 5,
  ...ctx
});
assert(batchAgain.ok, "batch resume cursor works");

const adapter = resolveAdapter({ name: "Holland America Line" });
assert(adapter.id === "holland-america", "adapter registered");
assert(AUTO_ALIAS_WRITES_ENABLED === false, "auto alias disabled");
assert(resolveAdapter({ name: "P&O Cruises Australia" }).id === "generic", "P&O excluded");

const panamaAntarcticaLabelRaw = {
  cruise_id: "O718",
  itinerary_id: "S7S16A",
  title: "16-DAY INCA & PANAMA CANAL DISCOVERY: LIMA OVERNIGHT",
  itinerary_text:
    "San Antonio (Santiago), Chile, Cruising Panama Canal, Days At Sea, General San Martin (Pisco), Peru, Manta, Ecuador, Enter Panama Canal Balboa, Fuerte Amador, Panama, Fort Lauderdale, Florida, US",
  destination_codes: ["S"],
  destination_labels: ["SOUTH AMERICA & ANTARCTICA"],
  region_codes: ["SS"],
  region_labels: ["South America"],
  departure_port: "San Antonio (Santiago), Chile",
  ship_name: "Oosterdam",
  ship_code: "OS",
  departure_date: "2027-03-24",
  return_date: "2027-04-09",
  nights: 16
};
const panamaHints = hal.resolveHalDestinationHints(panamaAntarcticaLabelRaw);
assert(panamaHints.preferredSlug === "panama-canal", "HAL South America label without Antarctic route → Panama Canal");
const panamaNorm = hal.normaliseHalVoyage(panamaAntarcticaLabelRaw, {
  ...ctx,
  ships: [{ id: "s-oosterdam", name: "ms Oosterdam", cruise_line_id: "hal-line" }]
});
assert(
  panamaNorm.destination_resolution.destinationKey === "panama-canal",
  "HAL Panama Canal sailing not tagged Antarctica"
);

const antarcticaRaw = {
  cruise_id: "I810",
  itinerary_id: "X810",
  title: "22-DAY SOUTH AMERICA & ANTARCTICA",
  itinerary_text:
    "Cruising Chilean Fjords, Cape Horn and Drake Passage, Antarctic Experience, Buenos Aires, Argentina, Montevideo, Uruguay",
  destination_codes: ["S"],
  destination_labels: ["SOUTH AMERICA & ANTARCTICA"],
  region_codes: ["SN"],
  region_labels: ["South America/Antarctica"],
  departure_port: "Buenos Aires, Argentina",
  ship_name: "Westerdam",
  ship_code: "WE",
  departure_date: "2027-01-10",
  return_date: "2027-02-01",
  nights: 22
};
const antarcticaHints = hal.resolveHalDestinationHints(antarcticaRaw);
assert(antarcticaHints.preferredSlug === "antarctica", "HAL Antarctic route keeps Antarctica");
const antarcticaNorm = hal.normaliseHalVoyage(antarcticaRaw, ctx);
assert(antarcticaNorm.destination_resolution.destinationKey === "antarctica", "HAL Antarctic sailing stays Antarctica");

console.log(`test-discovery-holland-america: ${passed} passed`);
