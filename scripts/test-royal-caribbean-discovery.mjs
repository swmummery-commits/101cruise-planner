#!/usr/bin/env node
/**
 * Royal Caribbean International discovery tests (offline fixtures).
 *   npm run test:royal-caribbean-discovery
 *
 * Read-only. Does not hit Royal Caribbean or the database unless
 * ROYAL_CARIBBEAN_LIVE_PROBE=true is set.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const source = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-source"));
const inventory = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

const fixture = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/fixtures/royal-caribbean/search-response-page.json"), "utf8")
);

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message || String(error) });
    console.log(`✗ ${name} — ${error.message || error}`);
  }
}

const groups = fixture.data.cruiseSearch.results.cruises;
const expanded = source.expandGraphGroupsToRawSailings(groups, { today: "2026-08-13", futureOnly: false });
const ensenada = expanded.products.find((p) => p.official_sailing_id === "VY03X045_2026-10-05");
const icon = expanded.products.find((p) => p.official_sailing_id === "IC07C001_2026-11-01");

test("1. source contract is read-only GraphQL", () => {
  if (source.SOURCE_CONTRACT.writes !== false) throw new Error("writes must be false");
  if (source.SOURCE_CONTRACT.authentication_required !== false) throw new Error("auth");
  if (!source.GRAPH_URL.includes("royalcaribbean.com/graph")) throw new Error("graph url");
  if (source.CRUISE_LINE_NAME !== "Royal Caribbean International") throw new Error("line name");
});

test("2. pagination total and group count from fixture", () => {
  if (fixture.data.cruiseSearch.results.total !== 2) throw new Error("total");
  if (groups.length !== 2) throw new Error("groups");
});

test("3. voyage identity uses sailing.id packageCode_sailDate", () => {
  if (!ensenada) throw new Error("missing ensenada sailing");
  if (ensenada.official_sailing_id !== "VY03X045_2026-10-05") throw new Error("sailing id");
  if (source.officialProductKey(ensenada) !== "VY03X045_2026-10-05") throw new Error("product key");
  if (source.officialGroupKey(ensenada) !== "VY03LAX-1965471073") throw new Error("group key");
  if (ensenada.itinerary_code !== "VY03X045") throw new Error("package code");
});

test("4. date parsing uses sailDate / endDate ISO dates", () => {
  if (source.isoDate("2026-10-05T00:00:00Z") !== "2026-10-05") throw new Error("iso");
  if (ensenada.departure_date !== "2026-10-05") throw new Error("dep");
  if (ensenada.return_date !== "2026-10-08") throw new Error("ret");
});

test("5. duration extraction prefers sailingNights", () => {
  if (ensenada.nights !== 3) throw new Error("nights");
  if (icon.nights !== 7) throw new Error("icon nights");
});

test("6. itinerary extraction includes ports, sea days, times", () => {
  const ports = ensenada.itinerary_ports.map((p) => p.code).join(",");
  if (ports !== "LAX,ESE,LAX") throw new Error(ports);
  if (ensenada.sea_day_count !== 1) throw new Error(`sea ${ensenada.sea_day_count}`);
  const ensenadaCall = ensenada.itinerary_ports.find((p) => p.code === "ESE");
  if (ensenadaCall.arrival_time !== "08:00:00" || ensenadaCall.departure_time !== "16:00:00") {
    throw new Error("ensenada times");
  }
});

test("7. round-trip vs one-way from first/last port codes", () => {
  if (ensenada.round_trip !== true) throw new Error("ensenada should be round trip");
  if (ensenada.arrival_port_code !== "LAX") throw new Error("arrival");
});

test("8. overnight stays detected from consecutive same-port days", () => {
  if (!icon) throw new Error("missing icon sailing");
  if (icon.overnight_stays.length !== 1) throw new Error(`overnight ${JSON.stringify(icon.overnight_stays)}`);
  if (icon.overnight_stays[0].port_code !== "SJU") throw new Error("sju overnight");
  if (icon.sea_day_count !== 3) throw new Error(`icon sea ${icon.sea_day_count}`);
});

test("9. ship, destination and embarkation fields", () => {
  if (ensenada.ship_name !== "Voyager of the Seas" || ensenada.ship_code !== "VY") throw new Error("ship");
  if (ensenada.departure_port !== "Los Angeles" || ensenada.departure_port_code !== "LAX") throw new Error("port");
  if (ensenada.destination_name !== "Mexico" || ensenada.destination_code !== "MEXCO") throw new Error("dest");
});

test("10. official URL is first-party itinerary link rewritten to the sailing", () => {
  if (!ensenada.official_url.startsWith("https://www.royalcaribbean.com/itinerary/")) throw new Error(ensenada.official_url);
  if (!ensenada.official_url.includes("packageCode=VY03X045")) throw new Error("package");
  if (!ensenada.official_url.includes("sailDate=2026-10-05")) throw new Error("sailDate");
  const second = expanded.products.find((p) => p.official_sailing_id === "VY03X046_2026-12-18");
  if (!second.official_url.includes("packageCode=VY03X046") || !second.official_url.includes("sailDate=2026-12-18")) {
    throw new Error(second.official_url);
  }
});

test("11. ocean cruise classification; cruisetour when land tour present", () => {
  if (ensenada.product_type !== "ocean_cruise") throw new Error(ensenada.product_type);
  const tour = source.classifyProductType({ voyageType: "OCEAN", preTour: { duration: 3 } });
  if (tour.productType !== "ocean_cruisetour") throw new Error(tour.productType);
});

test("12. group expands to unique sailings without duplicates", () => {
  if (expanded.products.length !== 3) throw new Error(`count ${expanded.products.length}`);
  if (expanded.audit.duplicate_sailing_ids !== 0) throw new Error("dupes");
  const ids = expanded.products.map((p) => p.official_sailing_id);
  if (new Set(ids).size !== ids.length) throw new Error("unique");
});

test("13. incomplete records missing required fields are flagged", () => {
  const incompleteDoc = {
    id: "BAD",
    productViewLink: null,
    masterSailing: { itinerary: { name: "Unknown", days: [] } },
    sailings: [{ id: null, sailDate: null }]
  };
  const raw = source.parseRawSailingFromGraph(incompleteDoc, incompleteDoc.sailings[0]);
  const issues = source.completenessIssues(raw);
  for (const needed of ["missing_sailing_id", "missing_ship", "missing_departure_date", "missing_duration", "missing_embarkation_port"]) {
    if (!issues.includes(needed)) throw new Error(`expected ${needed}, got ${issues.join(",")}`);
  }
  if (raw.complete) throw new Error("should be incomplete");
});

test("14. complete fixture sailings pass the source completeness gate", () => {
  if (!ensenada.complete || ensenada.completeness_issues.length) throw new Error("ensenada");
  if (!icon.complete) throw new Error("icon");
});

test("15. 21-day public cutoff partitions near vs eligible sailings", () => {
  const near = { departure_date: "2026-08-20" };
  const eligible = { departure_date: "2026-10-05" };
  const split = inventory.partitionByPublicBookingCutoff(
    [near, eligible],
    (row) => row.departure_date,
    "2026-08-13"
  );
  if (split.withinCutoff.length !== 1) throw new Error("within");
  if (split.publiclyEligible.length !== 1) throw new Error("eligible");
  if (split.publiclyEligible[0].departure_date !== "2026-10-05") throw new Error("date");
});

test("16. future-only expansion skips past sailings", () => {
  const pastDoc = {
    id: "PAST",
    productViewLink: "itinerary/x",
    masterSailing: {
      itinerary: {
        name: "Past",
        code: "XX01X001",
        voyageType: "OCEAN",
        sailingNights: 3,
        departurePort: { code: "MIA", name: "Miami" },
        ship: { code: "IC", name: "Icon of the Seas" },
        days: []
      }
    },
    sailings: [{ id: "XX01X001_2026-01-01", sailDate: "2026-01-01", endDate: "2026-01-04", status: "OPEN" }]
  };
  const result = source.expandGraphGroupsToRawSailings([pastDoc], { today: "2026-08-13", futureOnly: true });
  if (result.products.length !== 0) throw new Error("should skip past");
  if (result.audit.past_sailings_skipped !== 1) throw new Error("past count");
});

test("17. catalogue summary counts unique ships, ports, destinations", () => {
  const stats = source.summariseRoyalCaribbeanSailings(expanded.products, {
    today: "2026-08-13",
    perthToday: "2026-08-13"
  });
  if (stats.unique_voyages !== 3) throw new Error(`voyages ${stats.unique_voyages}`);
  if (stats.unique_ships !== 2) throw new Error(`ships ${stats.unique_ships}`);
  if (!stats.destination_codes.includes("MEXCO") || !stats.destination_codes.includes("CARIB")) {
    throw new Error(String(stats.destination_codes));
  }
  if (stats.complete_records !== 3) throw new Error("complete");
});

test("18. Akamai denial detector", () => {
  if (!source.looksLikeAkamaiDenied(403, "<HTML><HEAD> <TITLE>Access Denied</TITLE>")) throw new Error("403");
  if (source.looksLikeAkamaiDenied(200, '{"data":{}}')) throw new Error("200");
});

test("19. SEARCH_QUERY asks for days and sailing status", () => {
  if (!source.SEARCH_QUERY.includes("days {")) throw new Error("days");
  if (!source.SEARCH_QUERY.includes("status")) throw new Error("status");
  if (!source.SEARCH_QUERY.includes("sailingNights")) throw new Error("nights");
});

const adapter = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-adapter"));
const mapping = require(path.join(root, "netlify/functions/lib/royal-caribbean-destination-mapping"));
const writes = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-writes"));
const mode = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-mode"));
const arithmetic = require(path.join(root, "netlify/functions/lib/royal-caribbean-reconciliation-summary"));
const { resolveShipForLine } = require(path.join(root, "netlify/functions/lib/discovery-ship-resolver"));

const RC_LINE = {
  id: "rc-line-1",
  name: "Royal Caribbean International",
  slug: "royal-caribbean-international"
};
const RC_SHIPS = [
  { id: "ship-vy", name: "Voyager of the Seas", cruise_line_id: "rc-line-1", official_line_ship_id: null },
  { id: "ship-ic", name: "Icon of the Seas", cruise_line_id: "rc-line-1", official_line_ship_id: "IC" }
];
const OTHER_LINE_SHIPS = [
  { id: "ship-cel", name: "Voyager of the Seas", cruise_line_id: "celebrity-line", official_line_ship_id: "VY" }
];
const DESTINATIONS = adapter.catalogueDestinations([]);

function normaliseFixture(raw, extra = {}) {
  return adapter.normaliseRoyalCaribbeanProduct(raw, {
    cruiseLine: RC_LINE,
    ships: RC_SHIPS,
    destinations: DESTINATIONS,
    ...extra
  });
}

test("20. malformed GraphQL bodies are detected", () => {
  const bad = source.inspectRoyalCaribbeanGraphBody({ hello: true });
  if (bad.ok || bad.reason !== "malformed_missing_data") throw new Error(JSON.stringify(bad));
  const errors = source.inspectRoyalCaribbeanGraphBody({ errors: [{ message: "nope" }] });
  if (errors.ok || errors.reason !== "graphql_errors") throw new Error(JSON.stringify(errors));
  const ok = source.inspectRoyalCaribbeanGraphBody(fixture);
  if (!ok.ok) throw new Error(JSON.stringify(ok));
});

test("21. failed pages mark pagination incomplete", () => {
  const result = source.assessRoyalCaribbeanPagination({
    total_official: 100,
    groups: [{ id: "a" }],
    page_log: [
      { skip: 0, ok: true, returned: 50, total: 100 },
      { skip: 50, ok: false, returned: 0, total: 100 }
    ]
  });
  if (!result.incomplete_pagination || result.pages_failed !== 1 || result.pages_successful !== 1) {
    throw new Error(JSON.stringify(result));
  }
});

test("22. duplicate sailing IDs are counted and skipped", () => {
  const dup = source.expandGraphGroupsToRawSailings(
    [
      groups[0],
      {
        ...groups[0],
        id: "OTHER-GROUP",
        sailings: groups[0].sailings
      }
    ],
    { today: "2026-08-13", futureOnly: false }
  );
  if (dup.audit.duplicate_sailing_ids < 1) throw new Error("expected duplicates");
  const ids = dup.products.map((p) => p.official_sailing_id);
  if (new Set(ids).size !== ids.length) throw new Error("expanded set not unique");
});

test("23. group ID is not used as sailing identity", () => {
  if (ensenada.official_sailing_id === ensenada.group_id) throw new Error("group used as identity");
  if (ensenada.official_sailing_id === "VY03LAX-1965471073") throw new Error("group id leaked");
  if (!/^[A-Z0-9]+_\d{4}-\d{2}-\d{2}$/.test(ensenada.official_sailing_id)) throw new Error("formula");
});

test("24. package code is parsed from the individual sailing id", () => {
  const parsed = source.parseSailingId("VY03X046_2026-12-18");
  if (parsed.package_code !== "VY03X046" || parsed.sail_date !== "2026-12-18") throw new Error(JSON.stringify(parsed));
  const second = expanded.products.find((p) => p.official_sailing_id === "VY03X046_2026-12-18");
  if (second.itinerary_code === "VY03X046" || second.official_url.includes("packageCode=VY03X046")) {
    /* itinerary_code may still be group master; URL must be sailing-specific */
  }
  if (!second.official_url.includes("packageCode=VY03X046")) throw new Error(second.official_url);
});

test("25. 22 days away is eligible; 21 and 20 are excluded", () => {
  const today = "2026-08-13";
  const split = inventory.partitionByPublicBookingCutoff(
    [
      { departure_date: "2026-09-04" },
      { departure_date: "2026-09-03" },
      { departure_date: "2026-09-02" }
    ],
    (row) => row.departure_date,
    today
  );
  if (split.publiclyEligible.map((r) => r.departure_date).join() !== "2026-09-04") {
    throw new Error(JSON.stringify(split.publiclyEligible));
  }
  if (split.withinCutoff.length !== 2) throw new Error("cutoff");
  if (inventory.publicBookingCutoffDate(today) !== "2026-09-03") throw new Error("cutoff date");
});

test("26. ocean cruisetour is excluded from eligible cruise classification", () => {
  const tour = source.classifyProductType({ voyageType: "OCEAN", preTour: { duration: 2 }, postTour: { duration: 1 } });
  if (tour.productType !== "ocean_cruisetour") throw new Error(tour.productType);
  if (!adapter.isRoyalCaribbeanCruisetour(tour.productType)) throw new Error("helper");
  if (adapter.isEligibleRoyalCaribbeanCruise(tour.productType)) throw new Error("eligible");
});

test("27. exact-name ship resolution stays on the Royal Caribbean line", () => {
  const hit = resolveShipForLine({
    rawShipName: "Voyager of the Seas",
    rawShipCode: "VY",
    cruiseLineId: RC_LINE.id,
    cruiseLineName: RC_LINE.name,
    ships: [...RC_SHIPS, ...OTHER_LINE_SHIPS]
  });
  if (!hit.resolved || hit.ship.id !== "ship-vy" || hit.method !== "exact_name") throw new Error(JSON.stringify(hit));
});

test("28. official ship code resolution", () => {
  const hit = resolveShipForLine({
    rawShipName: "Unknown Name",
    rawShipCode: "IC",
    cruiseLineId: RC_LINE.id,
    cruiseLineName: RC_LINE.name,
    ships: RC_SHIPS
  });
  if (!hit.resolved || hit.ship.id !== "ship-ic" || hit.method !== "official_line_ship_id") {
    throw new Error(JSON.stringify(hit));
  }
});

test("29. unresolved ship when absent from fleet and no cross-line resolution", () => {
  const missing = resolveShipForLine({
    rawShipName: "Hero of the Seas",
    rawShipCode: "HE",
    cruiseLineId: RC_LINE.id,
    cruiseLineName: RC_LINE.name,
    ships: RC_SHIPS
  });
  if (missing.resolved) throw new Error("hero should be unresolved without fleet record");
  const cross = resolveShipForLine({
    rawShipName: "Voyager of the Seas",
    rawShipCode: "VY",
    cruiseLineId: RC_LINE.id,
    cruiseLineName: RC_LINE.name,
    ships: OTHER_LINE_SHIPS
  });
  if (cross.resolved) throw new Error("cross-line resolved");
});

test("43. Hero of the Seas resolves via Royal Caribbean source code HE", () => {
  const heroShip = {
    id: "ship-he",
    name: "Hero of the Seas",
    cruise_line_id: RC_LINE.id,
    official_line_ship_id: "HE"
  };
  const byCode = resolveShipForLine({
    rawShipName: "Hero of the Seas",
    rawShipCode: "HE",
    cruiseLineId: RC_LINE.id,
    cruiseLineName: RC_LINE.name,
    ships: [...RC_SHIPS, heroShip]
  });
  if (!byCode.resolved || byCode.ship.id !== "ship-he" || byCode.method !== "official_line_ship_id") {
    throw new Error(JSON.stringify(byCode));
  }
  const byName = resolveShipForLine({
    rawShipName: "Hero of the Seas",
    rawShipCode: null,
    cruiseLineId: RC_LINE.id,
    cruiseLineName: RC_LINE.name,
    ships: [...RC_SHIPS, heroShip]
  });
  if (!byName.resolved || byName.ship.id !== "ship-he" || byName.method !== "exact_name") {
    throw new Error(JSON.stringify(byName));
  }
  const wrongLine = resolveShipForLine({
    rawShipName: "Hero of the Seas",
    rawShipCode: "HE",
    cruiseLineId: RC_LINE.id,
    cruiseLineName: RC_LINE.name,
    ships: [{ id: "other-he", name: "Hero of the Seas", cruise_line_id: "other-line", official_line_ship_id: "HE" }]
  });
  if (wrongLine.resolved) throw new Error("cross-line hero match");
});

test("44. Colón embarkation resolves via adapter alias and ONX code", () => {
  const accented = adapter.classifyItineraryStop({ name: "Colón", code: "ONX" });
  if (accented.classification !== "alias_resolved") throw new Error(JSON.stringify(accented));
  if (accented.canonical_port_name !== "Colón") throw new Error(JSON.stringify(accented));
  const ascii = adapter.classifyItineraryStop({ name: "Colon", code: "ONX" });
  if (ascii.classification !== "alias_resolved") throw new Error(JSON.stringify(ascii));
  if (ascii.canonical_port_name !== "Colón") throw new Error(JSON.stringify(ascii));
  if (ascii.canonical_port_name !== accented.canonical_port_name) throw new Error("duplicate canonical ports");
  const panamaCity = adapter.classifyItineraryStop({ name: "Panama City", code: "PTY" });
  if (panamaCity.canonical_port_name === "Colón") throw new Error("false Panama City match");
});

test("30. ports: exact, alias, unresolved conventional, sea day, scenic", () => {
  const exact = adapter.classifyItineraryStop({ name: "Los Angeles", code: "LAX" });
  if (exact.classification !== "exact_resolved") throw new Error(JSON.stringify(exact));
  const alias = adapter.classifyItineraryStop({ name: "Athens (Piraeus)", code: "PIR" });
  if (!["alias_resolved", "exact_resolved"].includes(alias.classification)) throw new Error(JSON.stringify(alias));
  const unresolved = adapter.classifyItineraryStop({ name: "Fictional Portville", code: "ZZZ" });
  if (unresolved.classification !== "unresolved_conventional") throw new Error(JSON.stringify(unresolved));
  const cape = adapter.classifyItineraryStop({ name: "Cape Liberty (New York)" });
  if (!cape.classification) throw new Error(JSON.stringify(cape));
  const sea = adapter.classifyItineraryStop({ name: "Cruising", code: "CRU", sea_day: true });
  if (sea.classification !== "sea_day") throw new Error(JSON.stringify(sea));
  const scenic = adapter.classifyItineraryStop({ name: "Hubbard Glacier", code: "HGL" });
  if (scenic.classification !== "scenic_cruising") throw new Error(JSON.stringify(scenic));
  const napali = adapter.classifyItineraryStop({ name: "Napali Coast (Cruising)", code: "NCL" });
  if (napali.classification !== "scenic_cruising") throw new Error(JSON.stringify(napali));
});

test("31. destinations: known RCG mapping and unresolved code", () => {
  const mex = mapping.resolveRoyalCaribbeanDestinationHints({ destination_code: "MEXCO", destination_name: "Mexico" });
  if (mex.slug !== "mexican-riviera") throw new Error(JSON.stringify(mex));
  const carib = mapping.resolveRoyalCaribbeanDestinationHints({ destination_code: "CARIB", destination_name: "Caribbean" });
  if (carib.slug !== "caribbean") throw new Error(JSON.stringify(carib));
  const unknown = mapping.resolveRoyalCaribbeanDestinationHints({ destination_code: "ZZZZ", destination_name: "" });
  if (unknown) throw new Error("expected unresolved");
});

test("32. itinerary keeps ordered ports, sea days, overnight, and times", () => {
  if (ensenada.itinerary_ports.map((p) => p.code).join(",") !== "LAX,ESE,LAX") throw new Error("ports");
  if (ensenada.sea_day_count !== 1) throw new Error("sea");
  if (icon.overnight_stays[0].port_code !== "SJU") throw new Error("overnight");
  const call = ensenada.itinerary_ports.find((p) => p.code === "ESE");
  if (call.arrival_time !== "08:00:00" || call.departure_time !== "16:00:00") throw new Error("times");
});

test("33. two sailings in one group get distinct rewritten URLs", () => {
  const first = expanded.products.find((p) => p.official_sailing_id === "VY03X045_2026-10-05");
  const second = expanded.products.find((p) => p.official_sailing_id === "VY03X046_2026-12-18");
  if (first.official_url === second.official_url) throw new Error("shared url");
  if (!first.official_url.includes("sailDate=2026-10-05") || !first.official_url.includes("packageCode=VY03X045")) {
    throw new Error(first.official_url);
  }
  if (!second.official_url.includes("sailDate=2026-12-18") || !second.official_url.includes("packageCode=VY03X046")) {
    throw new Error(second.official_url);
  }
});

test("34. completeness flags each required field individually", () => {
  const base = {
    official_sailing_id: "AA01X001_2026-10-01",
    ship_name: "Icon of the Seas",
    ship_code: "IC",
    departure_date: "2026-10-01",
    nights: 7,
    departure_port: "Miami"
  };
  const cases = [
    ["official_sailing_id", "missing_sailing_id"],
    ["ship_name", "missing_ship"],
    ["departure_date", "missing_departure_date"],
    ["nights", "missing_duration"],
    ["departure_port", "missing_embarkation_port"]
  ];
  for (const [field, reason] of cases) {
    const raw = { ...base };
    if (field === "ship_name") {
      raw.ship_name = null;
      raw.ship_code = null;
    } else if (field === "departure_port") {
      raw.departure_port = null;
      raw.departure_port_code = null;
    } else {
      raw[field] = field === "nights" ? null : null;
    }
    const issues = source.completenessIssues(raw);
    if (!issues.includes(reason)) throw new Error(`${field} => ${issues.join(",")}`);
  }
  if (source.completenessIssues(base).length) throw new Error("complete base");
});

test("35. valid complete fixture records remain complete", () => {
  if (!ensenada.complete || !icon.complete) throw new Error("fixture complete");
});

test("36. same source sailing cannot appear as two proposed inserts", async () => {
  const product = normaliseFixture(ensenada);
  product.complete_high_confidence = true;
  product.time_eligibility = "eligible";
  product.status_class = "open";
  product.candidate.destination_id = "dest-1";
  const manifest = await writes.buildRoyalCaribbeanBatchManifest({
    products: [product, { ...product }],
    cruiseLine: RC_LINE,
    destinations: [{ id: "dest-1", slug: product.destination_resolution?.destinationKey || "mexican-riviera" }],
    supabase: null,
    runId: "test"
  });
  const inserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
  if (inserts.length !== 1) throw new Error(`inserts ${inserts.length}`);
  if (manifest.products.filter((p) => p.proposed_action === "duplicate_skip").length !== 1) {
    throw new Error("second should duplicate_skip");
  }
});

test("37. recognised existing official sailing ID is skipped or updated, never inserted twice", () => {
  const product = normaliseFixture(ensenada);
  product.complete_high_confidence = true;
  product.time_eligibility = "eligible";
  product.status_class = "open";
  product.candidate.destination_id = "dest-1";
  product.candidate.ship_id = "ship-vy";
  const existing = {
    id: "db-1",
    cruise_line_id: RC_LINE.id,
    official_sailing_id: ensenada.official_sailing_id,
    ship_id: "ship-vy",
    destination_id: "dest-1",
    departure_date: ensenada.departure_date,
    return_date: ensenada.return_date,
    nights: ensenada.nights,
    departure_port: product.candidate.departure_port,
    status: "active"
  };
  const skip = writes.classifyProposedAction(product, existing);
  if (skip !== "duplicate_skip") throw new Error(skip);
  const update = writes.classifyProposedAction(product, { ...existing, nights: 99 });
  if (update !== "update_exact_legacy_match") throw new Error(update);
  const legacy = writes.classifyProposedAction(product, { id: "legacy", official_sailing_id: null, raw_extract: {} });
  if (legacy !== "insert_active") throw new Error(legacy);
});

test("38. reconciliation arithmetic balances and a deliberate imbalance fails", () => {
  const ok = arithmetic.buildRoyalCaribbeanReconciliationArithmetic({
    uniqueSailings: 10,
    oceanCruises: 8,
    oceanCruisetours: 2,
    oceanIncomplete: 1,
    oceanEligible: 5,
    oceanWithinCutoff: 2,
    recognisedExistingEligible: 1,
    outstandingEligibleInserts: 4,
    proposedUpdates: 0
  });
  if (!ok.reconciliation_arithmetic_ok) throw new Error(JSON.stringify(ok));
  const bad = arithmetic.buildRoyalCaribbeanReconciliationArithmetic({
    uniqueSailings: 10,
    oceanCruises: 8,
    oceanCruisetours: 1
  });
  if (bad.reconciliation_arithmetic_ok) throw new Error("imbalance should fail");
});

test("39. dry-run health fails when arithmetic does not balance", () => {
  const health = arithmetic.evaluateRoyalCaribbeanDryRunHealth({
    simulation: { ok: true, pagination: { incomplete_pagination: false, pages_failed: 0 }, products: [{ official_sailing_id: "A" }] },
    arithmetic: { reconciliation_arithmetic_ok: false },
    manifest: { products: [] },
    actualWrites: 0
  });
  if (health.passed || !health.failures.includes("reconciliation_arithmetic_failed")) {
    throw new Error(JSON.stringify(health));
  }
});

test("40. write flags default OFF and apply throws", async () => {
  const gate = mode.resolveRoyalCaribbeanDiscoveryMode();
  if (gate.writes_allowed !== false || gate.mode !== "simulation") throw new Error(JSON.stringify(gate));
  if (mode.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED !== false) throw new Error("flag");
  const writeGate = mode.resolveRoyalCaribbeanDiscoveryMode("production_write");
  if (writeGate.writes_allowed !== false) throw new Error("production_write");
  let threw = false;
  try {
    await writes.applyRoyalCaribbeanBatchWrites({ mode: "simulation" });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("apply should throw");
});

test("41. unfamiliar statuses are classified and never auto-deleted", () => {
  const closed = source.classifySailingStatus("CLOSED");
  if (closed.class !== "unfamiliar_status" || closed.public_eligible) throw new Error(JSON.stringify(closed));
  const open = source.classifySailingStatus("OPEN");
  if (open.class !== "open" || !open.public_eligible) throw new Error(JSON.stringify(open));
  const product = normaliseFixture({ ...ensenada, sailing_status: "CLOSED" });
  product.status_class = "unfamiliar_status";
  product.complete_high_confidence = true;
  product.time_eligibility = "eligible";
  if (writes.classifyProposedAction(product, null) !== "unfamiliar_status_skip") throw new Error("status skip");
});

test("42. cruisetours are skipped from proposed inserts", () => {
  const product = normaliseFixture(ensenada);
  product.product_type = "ocean_cruisetour";
  product.complete_high_confidence = true;
  if (writes.classifyProposedAction(product, null) !== "ocean_cruisetour_skip") throw new Error("tour");
});

if (String(process.env.ROYAL_CARIBBEAN_LIVE_PROBE || "").toLowerCase() === "true") {
  const live = await source.probeRoyalCaribbeanSource({ maxPages: 1, pageSize: 2 });
  test("43. live probe returns GraphQL inventory", () => {
    if (!live.ok) throw new Error(live.error || "live failed");
    if (!live.total_official_groups) throw new Error("no total");
    if (!live.sample_sailings.length) throw new Error("no samples");
  });
}

if (failures.length) {
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
