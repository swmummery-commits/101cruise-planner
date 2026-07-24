#!/usr/bin/env node
/**
 * Sprint 15B — Track.cruises canonical importer tests (offline only).
 * Run: node scripts/test-track-cruises-importer.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { stripProviderPrices, assertNoPrices } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/strip-prices.js")
);
const { classifyPortsList, isSeaDayLabel, isScenicCruisingLabel } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/classify-itinerary.js")
);
const { applyItineraryDates, dateForDay } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/itinerary-dates.js")
);
const { loadAppCatalogues } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/load-app-catalogues.js")
);
const { matchProviderPort } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/match-provider-port.js")
);
const { matchCruiseLineEntity, matchShipEntity } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/match-entities-app.js")
);
const { buildCanonicalSailing } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/build-canonical-sailing.js")
);
const { buildSailingKey, deduplicateCanonicalSailings } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/dedupe-canonical.js")
);
const { evaluateRouteObjectEligibility } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/route-eligibility.js")
);
const { TrackCruisesProvider } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/providers/track-cruises-provider.js")
);

const results = [];
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error.message || error) });
  }
}

const LIVE_FIXTURE = {
  cruise_id: "1632",
  itinerary_id: "ASG070",
  title: "Inside Passage (with Glacier Bay National Park)",
  company: "princess",
  locale: "ja_JP",
  ship_name: "Royal Princess",
  departure_date: "2026-07-25T00:00:00+00:00",
  duration: 7,
  price: 110687,
  price_euro: 597.73,
  currency: "JPY",
  cabin_prices_per_person: { INTERIOR: 110687 },
  destinations: ["Pacific", "Alaska"],
  ports_list: [
    { port: "Seattle, Washington", day: 1 },
    { port: "Juneau, Alaska", day: 2 },
    { port: "Skagway, Alaska", day: 3 },
    { port: "Glacier Bay National Park (scenic Cruising), Alaska", day: 4 },
    { port: "Ketchikan, Alaska", day: 5 },
    { port: "Victoria, Canada", day: 6 },
    { port: "At Sea", day: 7 },
    { port: "Seattle, Washington", day: 8 }
  ],
  itinerary_url: "https://www.princess.com/itinerary-details/?voyageCode=1632",
  updated_at: "2026-07-15T09:40:52.063+00:00"
};

async function main() {
  const catalogues = loadAppCatalogues({ root });

  await test("complete provider row builds canonical sailing", () => {
    const s = buildCanonicalSailing(LIVE_FIXTURE, catalogues);
    assert(s.provider === "track-cruises", "provider");
    assert(s.providerCruiseId === "1632", "id");
    assert(s.providerItineraryId === "ASG070", "itin");
    assert(s.cruiseLine.matchStatus === "MATCHED", "line");
    assert(s.ship.matchStatus === "MATCHED", "ship Royal Princess in app catalogue");
    assert(s.itinerary.length === 8, "stops");
  });

  await test("missing itinerary_id still imports", () => {
    const row = { ...LIVE_FIXTURE, itinerary_id: null };
    const s = buildCanonicalSailing(row, catalogues);
    assert(s.providerItineraryId === "", "empty itin id");
    assert(s.providerCruiseId === "1632", "cruise id kept");
  });

  await test("missing ship_name → NOT_FOUND ship", () => {
    const row = { ...LIVE_FIXTURE, ship_name: null };
    const s = buildCanonicalSailing(row, catalogues);
    assert(s.ship.matchStatus === "NOT_FOUND", "ship missing");
    assert(s.routeObjectEligible === false, "not route eligible");
  });

  await test("null title synthesised", () => {
    const row = { ...LIVE_FIXTURE, title: null };
    const s = buildCanonicalSailing(row, catalogues);
    assert(s.title.includes("Princess"), "synth title");
  });

  await test("price removal", () => {
    const { cleaned, removedFields } = stripProviderPrices(LIVE_FIXTURE);
    assert(!("price" in cleaned), "price gone");
    assert(!("price_euro" in cleaned), "price_euro gone");
    assert(removedFields.includes("price"), "tracked");
  });

  await test("cabin-price removal", () => {
    const { cleaned } = stripProviderPrices(LIVE_FIXTURE);
    assert(!("cabin_prices_per_person" in cleaned), "cabin gone");
    assert(!("currency" in cleaned), "currency gone");
  });

  await test("canonical sailing asserts no prices", () => {
    const s = buildCanonicalSailing(LIVE_FIXTURE, catalogues);
    const check = assertNoPrices(s);
    assert(check.ok, `violations ${check.violations}`);
  });

  await test("locale deduplication", () => {
    const a = buildCanonicalSailing({ ...LIVE_FIXTURE, locale: "ja_JP", price: 1, currency: "JPY" }, catalogues);
    const b = buildCanonicalSailing({ ...LIVE_FIXTURE, locale: "en_US", price: 2, currency: "USD" }, catalogues);
    assert(a.sailingKey === b.sailingKey, "same key");
    const { unique, duplicates } = deduplicateCanonicalSailings([a, b]);
    assert(unique.length === 1, "one sailing");
    assert(duplicates.length === 1, "one dup");
  });

  await test("currency deduplication", () => {
    const a = buildCanonicalSailing({ ...LIVE_FIXTURE, currency: "GBP", price: 924 }, catalogues);
    const b = buildCanonicalSailing({ ...LIVE_FIXTURE, currency: "USD", price: 1199 }, catalogues);
    assert(buildSailingKey(a) === buildSailingKey(b), "key ignores currency");
  });

  await test("At Sea classification", () => {
    assert(isSeaDayLabel("At Sea"), "at sea");
    assert(isSeaDayLabel("Day at Sea"), "day at sea");
    const stops = classifyPortsList([{ port: "At Sea", day: 7 }]);
    assert(stops[0].type === "sea", "type sea");
  });

  await test("scenic-cruising classification", () => {
    assert(isScenicCruisingLabel("Glacier Bay National Park (scenic Cruising), Alaska"), "glacier");
    assert(isScenicCruisingLabel("Hubbard Glacier scenic cruising"), "hubbard");
    const stops = classifyPortsList([
      { port: "Seattle, Washington", day: 1 },
      { port: "Glacier Bay National Park (scenic Cruising), Alaska", day: 2 },
      { port: "Seattle, Washington", day: 3 }
    ]);
    assert(stops[1].type === "scenic_cruising", "scenic");
    assert(stops[0].type === "embarkation", "embark");
    assert(stops[2].type === "disembarkation", "disembark");
  });

  await test("embarkation / disembarkation / round-trip", () => {
    const s = buildCanonicalSailing(LIVE_FIXTURE, catalogues);
    assert(s.itinerary[0].type === "embarkation", "first");
    assert(s.itinerary[s.itinerary.length - 1].type === "disembarkation", "last");
    assert(s.departurePort.portId === s.arrivalPort.portId, "round trip same port id");
  });

  await test("itinerary date calculation", () => {
    assert(dateForDay("2026-07-25", 1) === "2026-07-25", "day1");
    assert(dateForDay("2026-07-25", 8) === "2026-08-01", "day8");
    const s = buildCanonicalSailing(LIVE_FIXTURE, catalogues);
    assert(s.itinerary[0].date === "2026-07-25", "embark date");
    assert(s.returnDate === "2026-08-01", "return from day 8");
  });

  await test("duration/date inconsistency reported", () => {
    const row = { ...LIVE_FIXTURE, duration: 10 };
    const s = buildCanonicalSailing(row, catalogues);
    assert(s.dateConsistency.ok === false, "inconsistent");
    assert(s.dateConsistency.warnings[0].code === "duration_date_inconsistency", "code");
    assert(s.returnDate === "2026-08-01", "prefer itinerary final day");
  });

  await test("exact port matching", () => {
    const m = matchProviderPort("Juneau, Alaska", catalogues.ports, {
      proposedAliases: catalogues.proposedPortAliases
    });
    assert(m.status === "MATCHED" || m.status === "ALIAS_MATCH", `juneau ${m.status}`);
    assert(m.matchedName === "Juneau", "name");
    assert(m.latitude != null, "lat");
  });

  await test("alias / city-country port matching (Victoria, Canada)", () => {
    const m = matchProviderPort("Victoria, Canada", catalogues.ports, {
      proposedAliases: catalogues.proposedPortAliases
    });
    assert(m.status === "MATCHED" || m.status === "ALIAS_MATCH", `victoria ${m.status}`);
    assert(/victoria/i.test(m.matchedName), "victoria canonical");
  });

  await test("unmatched port handling", () => {
    const m = matchProviderPort("Definitely Not A Port XYZ", catalogues.ports);
    assert(m.status === "NOT_FOUND", "not found");
  });

  await test("ambiguous port matching does not silent-pick", () => {
    // Construct two ports with same city-like name if possible — use synthetic catalogue
    const synthetic = [
      {
        id: "a",
        canonical_name: "Springfield",
        display_name: "Springfield, Illinois",
        city: "Springfield",
        country: "United States",
        country_code: "US",
        region: "",
        latitude: 1,
        longitude: 2,
        aliases: [],
        match_key: "springfield|united states"
      },
      {
        id: "b",
        canonical_name: "Springfield",
        display_name: "Springfield, Missouri",
        city: "Springfield",
        country: "United States",
        country_code: "US",
        region: "",
        latitude: 3,
        longitude: 4,
        aliases: [],
        match_key: "springfield|united states|mo"
      }
    ];
    // Force different match_keys but same city match without region
    const m = matchProviderPort("Springfield", synthetic);
    assert(m.status === "AMBIGUOUS", `expected ambiguous got ${m.status}`);
  });

  await test("ship matching scoped to cruise line", () => {
    const line = matchCruiseLineEntity("princess", catalogues.lines);
    assert(line.matchStatus === "MATCHED", "line");
    const ship = matchShipEntity("Royal Princess", line, catalogues.ships);
    assert(ship.matchStatus === "MATCHED", "royal princess");
    assert(ship.canonicalName === "Royal Princess", "name");
  });

  await test("Route Object eligibility", () => {
    const s = buildCanonicalSailing(LIVE_FIXTURE, catalogues);
    const ev = evaluateRouteObjectEligibility(s);
    // Scenic unmatched should not block; ordinary Alaska ports + Seattle should qualify
    assert(typeof ev.routeObjectEligible === "boolean", "bool");
    if (s.matchSummary.unmatchedPorts === 0 && s.ship.matchStatus === "MATCHED") {
      assert(ev.routeObjectEligible === true, "should be eligible when ordinary ports matched");
    }
  });

  await test("repeated import idempotency", () => {
    const provider = new TrackCruisesProvider({
      catalogues,
      rows: [LIVE_FIXTURE, LIVE_FIXTURE, { ...LIVE_FIXTURE, locale: "en_GB", title: "Changed Title" }]
    });
    const once = provider.importRows(provider.rows, catalogues);
    const twice = provider.importRows(provider.rows, catalogues);
    assert(once.sailings.length === 1, "collapse to 1");
    assert(twice.sailings.length === 1, "idempotent count");
    assert(once.sailings[0].sailingKey === twice.sailings[0].sailingKey, "same key");
  });

  await test("provider search returns canonical sailings without live calls", async () => {
    const provider = new TrackCruisesProvider({ catalogues, rows: [LIVE_FIXTURE] });
    const out = await provider.search({});
    assert(out.ok, "ok");
    assert(out.candidates.length === 1, "one");
    assert(assertNoPrices(out.candidates[0]).ok, "no prices");
  });

  // Optional: load redacted live fixture file if present and not synthetic-only
  const detailPath = path.join(root, "tmp/track-cruises-validation/cruise-detail-redacted.json");
  if (fs.existsSync(detailPath)) {
    await test("redacted live fixture imports", () => {
      const body = JSON.parse(fs.readFileSync(detailPath, "utf8"));
      if (body._fixture_note && /SYNTHETIC/i.test(body._fixture_note)) return;
      const cruise = body.data && !Array.isArray(body.data) ? body.data : body;
      if (!cruise?.cruise_id) return;
      const s = buildCanonicalSailing(cruise, catalogues);
      assert(s.providerCruiseId === String(cruise.cruise_id), "id");
      assert(assertNoPrices(s).ok, "no prices from live fixture");
    });
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(String(e.stack || e));
  process.exitCode = 1;
});
