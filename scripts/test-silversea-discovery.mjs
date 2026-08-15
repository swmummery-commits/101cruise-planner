#!/usr/bin/env node
/**
 * Silversea Gatsby discovery tests (offline).
 *   npm run test:silversea-discovery
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const source = require(path.join(root, "netlify/functions/lib/silversea-discovery-source"));
const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { OPERATIONAL_DESTINATION_CATALOGUE } = require(path.join(
  root,
  "netlify/functions/lib/destination-classification"
));
const { PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

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

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message || String(error) });
    console.log(`✗ ${name} — ${error.message || error}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const CATALOGUE = JSON.parse(
  fs.readFileSync(path.join(root, "scripts/fixtures/silversea/catalogue-sample.json"), "utf8")
);

const LINE = { id: "line-silversea", name: "Silversea Cruises", slug: "silversea-cruises" };
const SHIPS = [
  "Silver Ray",
  "Silver Cloud",
  "Silver Moon",
  "Silver Shadow",
  "Silver Spirit",
  "Silver Muse"
].map((name, i) => ({ id: `ship-${i}`, name, cruise_line_id: LINE.id, official_line_ship_id: null }));

const DESTINATIONS = adapter.catalogueDestinations(
  OPERATIONAL_DESTINATION_CATALOGUE.map((entry) => ({
    id: `dest-${entry.slug}`,
    name: entry.name,
    slug: entry.slug,
    status: "published",
    classification_enabled: true
  }))
);

function voyageDetail({
  cruiseCode,
  ship,
  departureDate,
  arrivalDate,
  days,
  cruiseType = "Classic",
  dest = "MEDITERRANEAN",
  embark = "Monte Carlo",
  disembark = "Barcelona",
  embarkCode = "MCMON",
  disembarkCode = "ESBCN",
  itinerary = []
}) {
  return JSON.stringify({
    result: {
      data: {
        cruise: {
          data: {
            cruiseCode,
            cruiseType,
            departureDate,
            arrivalDate,
            days,
            cruiseGroup: "Test",
            departurePort: { name: { localized: embark }, data: { code: embarkCode } },
            arrivalPort: { name: { localized: disembark }, data: { code: disembarkCode } },
            destination: {
              name: { localized: dest, en: dest },
              destinationId: 1,
              destinationWebCode: "destination-1"
            },
            ship: { name: ship },
            itinerary,
            preHotel: [],
            postHotel: [],
            preLandProgrammes: [],
            postLandProgrammes: []
          }
        }
      }
    }
  });
}

function classicItinerary() {
  return [
    { dayNumber: 1, date: "2026-08-15", isOvernight: false, port: { name: { localized: "Monte Carlo" }, data: { code: "MCMON" } } },
    { dayNumber: 2, date: "2026-08-16", isOvernight: false, port: { name: { localized: "Saint Tropez" } } },
    { dayNumber: 3, date: "2026-08-17", isOvernight: false, port: { name: { localized: "Day at sea" } } },
    { dayNumber: 6, date: "2026-08-20", isOvernight: true, port: { name: { localized: "Palma de Mallorca" } } },
    { dayNumber: 7, date: "2026-08-21", isOvernight: false, port: { name: { localized: "Palma de Mallorca" } } },
    { dayNumber: 10, date: "2026-08-24", isOvernight: false, port: { name: { localized: "Barcelona" }, data: { code: "ESBCN" } } }
  ];
}

function galapagosItinerary() {
  return [
    { dayNumber: 1, date: "2028-01-01", isOvernight: false, port: { name: { localized: "San Cristóbal, Galapagos" } } },
    { dayNumber: 1, date: "2028-01-01", isOvernight: false, port: { name: { localized: "Kicker Rock" } } },
    { dayNumber: 2, date: "2028-01-02", isOvernight: false, port: { name: { localized: "North Seymour" } } },
    { dayNumber: 8, date: "2028-01-08", isOvernight: false, port: { name: { localized: "San Cristóbal, Galapagos" } } }
  ];
}

function mockTransport(routes) {
  return async (url) => {
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) return { ok: true, status: 200, text: typeof body === "string" ? body : JSON.stringify(body) };
    }
    return { ok: false, status: 404, text: "" };
  };
}

function nodeByCode(code) {
  return CATALOGUE.result.data.cruises.nodes.find((n) => n.cruiseCode === code);
}

function rawFromNode(code, detail = null) {
  const raw = source.parseCatalogueNode(nodeByCode(code));
  return detail ? source.applyVoyageDetail(raw, detail.result.data.cruise) : raw;
}

/* ------------------------------------------------------------------ identity */

test("1. cruiseCode becomes official_sailing_id", () => {
  const parsed = source.parseCruiseCode("mo271210c26");
  assert(parsed.valid, "valid");
  assert(parsed.cruise_code === "MO271210C26", parsed.cruise_code);
  const raw = source.parseCatalogueNode(nodeByCode("MO271210C26"));
  assert(source.officialProductKey(raw) === "MO271210C26", source.officialProductKey(raw));
});

test("2. Classic numeric voyage keeps distinct official id", () => {
  const raw = source.parseCatalogueNode(nodeByCode("RA260815009"));
  assert(raw.code_kind === "numeric", raw.code_kind);
  assert(raw.official_sailing_id === "RA260815009", raw.official_sailing_id);
});

test("3. Expedition voyage is parsed from catalogue", () => {
  const raw = source.parseCatalogueNode(nodeByCode("E4260820017"));
  assert(raw.ship_name === "Silver Cloud", JSON.stringify(raw.ship_name));
  assert(raw.code_kind === "numeric", raw.code_kind);
  assert(raw.destination_name === "KIMBERLEY", raw.destination_name);
});

test("4. C combination voyage is a separate official product", () => {
  const raw = source.parseCatalogueNode(nodeByCode("MO271210C26"));
  assert(raw.code_kind === "combination", raw.code_kind);
  assert(raw.official_sailing_id === "MO271210C26", raw.official_sailing_id);
});

test("5. S segment voyage is a separate official product", () => {
  const raw = source.parseCatalogueNode(nodeByCode("SS260818S06"));
  assert(raw.code_kind === "segment", raw.code_kind);
  assert(raw.official_sailing_id === "SS260818S06", raw.official_sailing_id);
});

test("6. same ship/date with multiple cruiseCodes stay distinct", () => {
  const a = source.parseCatalogueNode(nodeByCode("SS260818S06"));
  const b = source.parseCatalogueNode(nodeByCode("SS260818012"));
  assert(a.departure_date === b.departure_date, "same date");
  assert(a.ship_name === b.ship_name, "same ship");
  assert(a.official_sailing_id !== b.official_sailing_id, "ids must differ");
  assert(a.official_sailing_id === "SS260818S06", a.official_sailing_id);
  assert(b.official_sailing_id === "SS260818012", b.official_sailing_id);
});

test("7. URL is not used as primary identity", () => {
  const raw = source.parseCatalogueNode(nodeByCode("RA260815009"));
  raw.official_url = "https://www.silversea.com/other-path.html";
  assert(source.officialProductKey(raw) === "RA260815009", "code wins over url");
});

test("8. invalid/missing cruiseCode is rejected", () => {
  const missing = source.parseCruiseCode("");
  const bad = source.parseCruiseCode("NOT-A-CODE");
  assert(!missing.valid && missing.reason === "missing_cruise_code", missing.reason);
  assert(!bad.valid && bad.reason === "unparseable_cruise_code", bad.reason);
});

test("9. whitespace ship name is trimmed", () => {
  assert(source.trimShipName("Silver Cloud ") === "Silver Cloud", "trim");
  const raw = source.parseCatalogueNode(nodeByCode("E4260820017"));
  assert(raw.ship_name === "Silver Cloud", raw.ship_name);
});

test("10. specialVoyages are deferred, not deleted", () => {
  const parsed = source.parseCataloguePayload(CATALOGUE);
  assert(parsed.special_voyages.length === 1, String(parsed.special_voyages.length));
  assert(parsed.special_voyages[0].deferred_special_voyage === true, "deferred");
  assert(parsed.special_voyages[0].cruise_code === "SL260918050", parsed.special_voyages[0].cruise_code);
  assert(parsed.products.every((p) => p.cruise_code !== "SL260918050"), "not in main inventory");
});

/* ------------------------------------------------------------------ itinerary */

test("11. multi-call same-day itinerary is preserved", () => {
  const stops = source.parseItineraryStops(galapagosItinerary());
  assert(stops.length === 4, String(stops.length));
  assert(stops[0].day_number === 1 && stops[1].day_number === 1, "same day kept");
  assert(stops[0].port_name !== stops[1].port_name, "distinct calls");
});

test("12. overnight port flag is preserved", () => {
  const stops = source.parseItineraryStops(classicItinerary());
  const overnight = stops.find((s) => s.overnight);
  assert(overnight && overnight.port_name === "Palma de Mallorca", JSON.stringify(overnight));
});

test("13. sea days are classified, not collapsed", () => {
  const stops = source.parseItineraryStops(classicItinerary());
  const sea = stops.find((s) => s.kind === "sea");
  assert(sea && sea.port_name === "Day at sea", JSON.stringify(sea));
  assert(stops.length === 6, "no collapse");
});

/* ------------------------------------------------------------------ duration */

test("14. duration/date mismatch is reported, source days not altered", () => {
  const raw = source.parseCatalogueNode(nodeByCode("MO260903015"));
  assert(raw.source_duration === 15, String(raw.source_duration));
  assert(raw.calculated_nights === 16, String(raw.calculated_nights));
  assert(raw.duration_matches_dates === false, "mismatch flagged");
  const mismatches = source.durationMismatches([raw]);
  assert(mismatches.length === 1 && mismatches[0].cruise_code === "MO260903015", JSON.stringify(mismatches));
});

/* ------------------------------------------------------------------ 21-day */

test("15. 21-day cutoff uses shared eligibility helper", () => {
  const today = "2026-08-15";
  const cutoff = source.addDaysIso(today, PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE);
  const near = adapter.normaliseSilverseaProduct(rawFromNode("RA260815009"), {
    cruiseLine: LINE,
    ships: SHIPS,
    destinations: DESTINATIONS
  });
  const far = adapter.normaliseSilverseaProduct(rawFromNode("MO271210C26"), {
    cruiseLine: LINE,
    ships: SHIPS,
    destinations: DESTINATIONS
  });
  const { publiclyEligible, withinCutoff } = require(path.join(
    root,
    "netlify/functions/lib/public-discovered-cruise-inventory"
  )).partitionByPublicBookingCutoff([near, far], (p) => p.candidate.departure_date, today);
  assert(withinCutoff.some((p) => p.official_sailing_id === "RA260815009"), "near is cutoff");
  assert(publiclyEligible.some((p) => p.official_sailing_id === "MO271210C26"), "far is eligible");
  assert(cutoff === "2026-09-06", cutoff);
});

/* ------------------------------------------------------------------ health / fetch */

test("16. source-health rejects malformed catalogue", () => {
  const parsed = source.parseCataloguePayload({ result: { data: {} } });
  assert(parsed.ok === false, "parse fails");
  const health = source.assessCatalogueHealth({ result: { data: {} } }, parsed);
  assert(health.ok === false, "health fails");
  assert(health.failures.includes("cruise_nodes_missing"), JSON.stringify(health.failures));
});

test("17. source-health accepts fixture catalogue shape", () => {
  const parsed = source.parseCataloguePayload(CATALOGUE);
  const health = source.assessCatalogueHealth(CATALOGUE, parsed);
  assert(parsed.ok, "parsed");
  assert(parsed.audit.unique_codes === 6, String(parsed.audit.unique_codes));
  assert(health.failures.includes("catalogue_count_below_minimum"), "small fixture is below live minimum");
});

await testAsync("18. detail fetch failure is reported and does not write", async () => {
  const raw = source.parseCatalogueNode(nodeByCode("RA260815009"));
  const result = await source.fetchSilverseaVoyageDetail(raw, {
    transport: async () => ({ ok: false, status: 500, text: "" })
  });
  assert(result.ok === false, "failed");
  assert(result.raw.detail_enriched === false, "not enriched");
  assert(String(result.raw.detail_error || result.error).includes("http_500") || result.error, result.error);
});

await testAsync("19. dry-run simulation performs no writes and keeps distinct codes", async () => {
  const transport = mockTransport({
    "cruise-catalog.html/page-data.json": CATALOGUE,
    "monte-carlo-to-barcelona-ra260815009.html/page-data.json": voyageDetail({
      cruiseCode: "RA260815009",
      ship: "Silver Ray",
      departureDate: "2026-08-15",
      arrivalDate: "2026-08-24",
      days: 9,
      itinerary: classicItinerary()
    }),
    "fremantle-perth-western-australia-to-darwin-e4260820017.html/page-data.json": voyageDetail({
      cruiseCode: "E4260820017",
      ship: "Silver Cloud",
      departureDate: "2026-08-20",
      arrivalDate: "2026-09-06",
      days: 17,
      cruiseType: "Expedition",
      dest: "KIMBERLEY",
      embark: "Fremantle (Perth), Western Australia",
      disembark: "Darwin",
      itinerary: [
        { dayNumber: 1, date: "2026-08-20", port: { name: { localized: "Fremantle (Perth), Western Australia" } } },
        { dayNumber: 18, date: "2026-09-06", port: { name: { localized: "Darwin" } } }
      ]
    }),
    "melbourne-to-auckland-mo271210c26.html/page-data.json": voyageDetail({
      cruiseCode: "MO271210C26",
      ship: "Silver Moon",
      departureDate: "2027-12-10",
      arrivalDate: "2028-01-05",
      days: 26,
      dest: "AUSTRALIA & NEW ZEALAND",
      embark: "Melbourne",
      disembark: "Auckland",
      itinerary: [
        { dayNumber: 1, date: "2027-12-10", port: { name: { localized: "Melbourne" } } },
        { dayNumber: 18, date: "2027-12-27", port: { name: { localized: "Cruising Milford Sound" } } },
        { dayNumber: 27, date: "2028-01-05", port: { name: { localized: "Auckland" } } }
      ]
    }),
    "nice-to-valletta-ss260818s06.html/page-data.json": voyageDetail({
      cruiseCode: "SS260818S06",
      ship: "Silver Shadow",
      departureDate: "2026-08-18",
      arrivalDate: "2026-08-24",
      days: 6,
      embark: "Nice",
      disembark: "Valletta",
      itinerary: [
        { dayNumber: 1, date: "2026-08-18", port: { name: { localized: "Nice" } } },
        { dayNumber: 7, date: "2026-08-24", port: { name: { localized: "Valletta" } } }
      ]
    }),
    "nice-to-nice-ss260818012.html/page-data.json": voyageDetail({
      cruiseCode: "SS260818012",
      ship: "Silver Shadow",
      departureDate: "2026-08-18",
      arrivalDate: "2026-08-30",
      days: 12,
      embark: "Nice",
      disembark: "Nice",
      itinerary: [
        { dayNumber: 1, date: "2026-08-18", port: { name: { localized: "Nice" } } },
        { dayNumber: 13, date: "2026-08-30", port: { name: { localized: "Nice" } } }
      ]
    }),
    "melbourne-to-sydney-mo260903015.html/page-data.json": voyageDetail({
      cruiseCode: "MO260903015",
      ship: "Silver Moon",
      departureDate: "2026-09-03",
      arrivalDate: "2026-09-19",
      days: 15,
      dest: "AUSTRALIA & NEW ZEALAND",
      embark: "Melbourne",
      disembark: "Sydney",
      itinerary: [
        { dayNumber: 1, date: "2026-09-03", port: { name: { localized: "Melbourne" } } },
        { dayNumber: 17, date: "2026-09-19", port: { name: { localized: "Sydney" } } }
      ]
    })
  });

  const sim = await adapter.simulateSilverseaInventory({
    cruiseLine: LINE,
    ships: SHIPS,
    destinations: DESTINATIONS,
    existingRows: [
      {
        id: "legacy-1",
        official_sailing_id: null,
        official_url: "https://www.silversea.com/destinations/alaska-cruise/vancouver-to-seward-anchorage-alaska-wh260709007.html",
        status: "hidden"
      }
    ],
    today: "2026-08-15",
    transport,
    allowUnhealthy: true
  });

  assert(sim.writes === false, "writes flag");
  assert(sim.summary.unique_cruise_codes === 6, String(sim.summary.unique_cruise_codes));
  assert(sim.summary.combination_codes === 1, "C count");
  assert(sim.summary.segment_codes === 1, "S count");
  assert(sim.summary.deferred_special_voyages === 1, "special deferred");
  const ids = sim.products.map((p) => p.official_sailing_id);
  assert(new Set(ids).size === ids.filter(Boolean).length, "no collapsed ids");
  assert(sim.products.every((p) => p.identity_class.class !== "recognised_existing_official_id"), "no official id on legacy");
  assert(!sim.products.some((p) => p.identity_class.class === "possible_legacy_hidden_match"), "fixture codes are not WH260709007");
});

test("20. unresolved destination without fallback is reported", () => {
  const raw = source.parseCatalogueNode({
    cruiseCode: "RA271201009",
    fullPath: "/destinations/transoceanic-cruise/barcelona-to-miami-ra271201009.html",
    data: {
      ship: { name: "Silver Ray" },
      departureDate: "2027-12-01",
      arrivalDate: "2027-12-10",
      days: 9,
      destination: { name: { localized: "TRANSOCEANIC" } },
      departurePort: { name: { localized: "Barcelona" } },
      arrivalPort: { name: { localized: "Miami, FL" } }
    }
  });
  const result = adapter.normaliseSilverseaProduct(raw, {
    cruiseLine: LINE,
    ships: SHIPS,
    destinations: DESTINATIONS
  });
  assert(adapter.destinationFallbackSlug("TRANSOCEANIC") == null, "no speculative fallback");
  if (result.destination_resolution.status === "resolved") {
    assert(result.destination_resolution.destinationKey, "if resolved it came from port evidence");
  } else {
    assert(result.failure_reasons.includes("destination_unresolved") || result.failure_reasons.includes("destination_ambiguous"), JSON.stringify(result.failure_reasons));
  }
});

test("21. unresolved invented port is match_required, not guessed", () => {
  const raw = source.parseCatalogueNode({
    cruiseCode: "RA271201009",
    fullPath: "/destinations/mediterranean-cruise/nowhere-to-nowhere-ra271201009.html",
    data: {
      ship: { name: "Silver Ray" },
      departureDate: "2027-12-01",
      arrivalDate: "2027-12-10",
      days: 9,
      destination: { name: { localized: "MEDITERRANEAN" } },
      departurePort: { name: { localized: "Zzqx Unknown Port 101" } },
      arrivalPort: { name: { localized: "Barcelona" } }
    }
  });
  const result = adapter.normaliseSilverseaProduct(raw, {
    cruiseLine: LINE,
    ships: SHIPS,
    destinations: DESTINATIONS
  });
  assert(result.departure_port_resolution.status !== "resolved", result.departure_port_resolution.status);
  assert(result.match_required === true, "match required");
  assert(result.complete_high_confidence === false, "not complete");
});

test("22. possible legacy hidden match is URL-code association only", () => {
  const raw = source.parseCatalogueNode(nodeByCode("RA260815009"));
  raw.official_sailing_id = "WH260709007";
  raw.cruise_code = "WH260709007";
  const classified = adapter.classifyAgainstExisting(
    { official_sailing_id: "WH260709007" },
    new Map(),
    [
      {
        id: "legacy-hidden",
        official_sailing_id: null,
        official_url:
          "https://www.silversea.com/destinations/alaska-cruise/vancouver-to-seward-anchorage-alaska-wh260709007.html"
      }
    ]
  );
  assert(classified.class === "possible_legacy_hidden_match", classified.class);
  assert(classified.existing_id === "legacy-hidden", classified.existing_id);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.name}: ${f.error}`);
  process.exit(1);
}
