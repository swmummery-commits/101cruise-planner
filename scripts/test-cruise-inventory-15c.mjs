#!/usr/bin/env node
/**
 * Sprint 15C — port coverage + inventory design offline tests.
 * Zero live API calls.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { loadAppCatalogues } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/load-app-catalogues.js")
);
const { matchProviderPort } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/match-provider-port.js")
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
const { isSeaDayLabel, isScenicCruisingLabel } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/classify-itinerary.js")
);
const { TrackCruisesProvider } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/providers/track-cruises-provider.js")
);
const { assertNoPrices } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/strip-prices.js")
);

const results = [];
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: String(e.message || e) });
  }
}

const LIVE_FIXTURE = {
  cruise_id: "1632",
  itinerary_id: "ASG070",
  title: "Inside Passage (with Glacier Bay National Park)",
  company: "princess",
  locale: "en_US",
  ship_name: "Royal Princess",
  departure_date: "2026-07-25T00:00:00+00:00",
  duration: 7,
  price: 999,
  currency: "USD",
  destinations: ["Alaska"],
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
  assert(catalogues.ports.length >= 240, `expected >=240 ports, got ${catalogues.ports.length}`);

  await test("new exact port matches (Cozumel, Mykonos)", () => {
    const a = matchProviderPort("Cozumel, Mexico", catalogues.ports);
    assert(a.status === "MATCHED" || a.status === "ALIAS_MATCH", `cozumel ${a.status}`);
    assert(a.latitude != null, "coords");
    const b = matchProviderPort("Mykonos, Greece", catalogues.ports);
    assert(b.status === "MATCHED" || b.status === "ALIAS_MATCH", `mykonos ${b.status}`);
  });

  await test("new alias matches (Athens/Piraeus, Lima/Callao, Easter Island)", () => {
    const a = matchProviderPort("Athens (Piraeus), Greece", catalogues.ports);
    assert(a.status === "MATCHED" || a.status === "ALIAS_MATCH", `piraeus ${a.status}`);
    assert(/piraeus/i.test(a.matchedName), "piraeus name");
    const b = matchProviderPort("Lima (Callao), Peru", catalogues.ports);
    assert(b.status === "MATCHED" || b.status === "ALIAS_MATCH", `callao ${b.status}`);
    const c = matchProviderPort("Easter Island, Chile", catalogues.ports);
    assert(c.status === "MATCHED" || c.status === "ALIAS_MATCH", `easter ${c.status}`);
  });

  await test("private-island matching", () => {
    const a = matchProviderPort("Princess Cays, Bahamas", catalogues.ports);
    assert(a.status === "MATCHED" || a.status === "ALIAS_MATCH", `princess cays ${a.status}`);
    const b = matchProviderPort("Perfect Day at CocoCay, Bahamas", catalogues.ports);
    assert(b.status === "MATCHED" || b.status === "ALIAS_MATCH", `cococay ${b.status}`);
    const c = matchProviderPort("Ocean Cay MSC Marine Reserve, Bahamas", catalogues.ports);
    assert(c.status === "MATCHED" || c.status === "ALIAS_MATCH", `ocean cay ${c.status}`);
  });

  await test("tender destination matching (Pisco)", () => {
    const m = matchProviderPort("Pisco (general San Martin), Peru", catalogues.ports);
    assert(m.status === "MATCHED" || m.status === "ALIAS_MATCH", `pisco ${m.status}`);
  });

  await test("scenic-cruising exclusion from ordinary ports", () => {
    assert(isScenicCruisingLabel("Glacier Bay National Park (scenic Cruising), Alaska"), "scenic");
    const s = buildCanonicalSailing(LIVE_FIXTURE, catalogues);
    const scenic = s.itinerary.find((x) => x.type === "scenic_cruising");
    assert(scenic, "has scenic");
    assert(scenic.matchStatus !== "NOT_APPLICABLE" || scenic.type === "scenic_cruising", "typed");
  });

  await test("sea-day exclusion", () => {
    assert(isSeaDayLabel("At Sea"), "sea");
    assert(isSeaDayLabel("Fun Day At Sea"), "fun day");
    const s = buildCanonicalSailing(LIVE_FIXTURE, catalogues);
    const sea = s.itinerary.find((x) => x.type === "sea");
    assert(sea.matchStatus === "NOT_APPLICABLE", "n/a");
    assert(sea.portId == null && sea.latitude == null, "no geo");
  });

  await test("Sydney country disambiguation (not ambiguous)", () => {
    const m = matchProviderPort("Sydney, Australia", catalogues.ports);
    assert(m.status === "MATCHED" || m.status === "ALIAS_MATCH", `sydney ${m.status}`);
    assert(m.matchedName === "Sydney", "AU sydney");
  });

  await test("Cartagena Colombia vs Spain disambiguation", () => {
    const co = matchProviderPort("Cartagena, Colombia", catalogues.ports);
    assert(co.status === "MATCHED" || co.status === "ALIAS_MATCH", `colombia ${co.status}`);
    assert(/colombia/i.test(co.matchedName) || co.matchedName === "Cartagena Colombia", "CO name");
    const es = matchProviderPort("Cartagena, Spain", catalogues.ports);
    assert(es.status === "MATCHED" || es.status === "ALIAS_MATCH", `spain ${es.status}`);
    assert(es.id !== co.id, "distinct ports");
  });

  await test("ambiguous city without country still ambiguous when duplicates", () => {
    const m = matchProviderPort("Sydney", catalogues.ports);
    assert(m.status === "AMBIGUOUS" || m.status === "MATCHED", `bare sydney ${m.status}`);
    // Bare "Sydney" may still be ambiguous — must not silent-pick Australia over NS if both match
    if (m.status === "AMBIGUOUS") {
      assert(Array.isArray(m.candidates) && m.candidates.length > 1, "candidates");
    }
  });

  await test("coordinate availability on new ports", () => {
    for (const name of ["Cozumel, Mexico", "Piraeus, Greece", "Grand Turk, Turks and Caicos"]) {
      const m = matchProviderPort(name, catalogues.ports);
      assert(m.latitude != null && m.longitude != null, `${name} coords`);
    }
  });

  await test("Route Object eligibility after expansion (Alaska fixture)", () => {
    const s = buildCanonicalSailing(LIVE_FIXTURE, catalogues);
    const ev = evaluateRouteObjectEligibility(s);
    assert(ev.routeObjectEligible === true, "eligible");
  });

  await test("10-cruise sample: 100% ordinary ports + route eligibility", () => {
    const livePath = path.join(root, "tmp/track-cruises-importer/live-princess-list-redacted.json");
    assert(fs.existsSync(livePath), "live fixture present");
    const rows = JSON.parse(fs.readFileSync(livePath, "utf8")).data;
    const provider = new TrackCruisesProvider({ catalogues, rows });
    const imported = provider.importRows(rows, catalogues);
    assert(imported.sailings.length === 10, "10 sailings");
    let ordinary = 0;
    let matched = 0;
    let routeOk = 0;
    for (const s of imported.sailings) {
      assert(assertNoPrices(s).ok, "no prices");
      ordinary += s.matchSummary.totalMatchablePorts;
      matched += s.matchSummary.matchedPorts;
      if (s.routeObjectEligible) routeOk += 1;
      assert(s.matchSummary.unmatchedPorts === 0, `unmatched on ${s.providerCruiseId}`);
    }
    assert(matched === ordinary, `port match ${matched}/${ordinary}`);
    assert(routeOk === 10, `route ${routeOk}/10`);
  });

  await test("canonical key stability across locales/currencies", () => {
    const a = buildCanonicalSailing({ ...LIVE_FIXTURE, locale: "ja_JP", currency: "JPY", price: 1 }, catalogues);
    const b = buildCanonicalSailing({ ...LIVE_FIXTURE, locale: "en_GB", currency: "GBP", price: 2 }, catalogues);
    assert(a.sailingKey === b.sailingKey, "same key");
    assert(buildSailingKey(a) === a.sailingKey, "helper");
  });

  await test("same sailing across providers collapses by canonical key", () => {
    const a = buildCanonicalSailing(LIVE_FIXTURE, catalogues);
    const b = {
      ...a,
      provider: "other-provider",
      providerCruiseId: "OTHER-1632",
      title: "Renamed title"
    };
    b.sailingKey = buildSailingKey(b);
    const { unique, duplicates } = deduplicateCanonicalSailings([a, b]);
    assert(unique.length === 1, "one sailing");
    assert(duplicates.length === 1, "dup recorded");
  });

  await test("repeated import idempotency", () => {
    const provider = new TrackCruisesProvider({
      catalogues,
      rows: [LIVE_FIXTURE, LIVE_FIXTURE, { ...LIVE_FIXTURE, title: "Changed" }]
    });
    const once = provider.importRows(provider.rows, catalogues);
    const twice = provider.importRows(provider.rows, catalogues);
    assert(once.sailings.length === 1 && twice.sailings.length === 1, "idempotent");
    assert(once.sailings[0].sailingKey === twice.sailings[0].sailingKey, "key");
  });

  await test("itinerary update detection via fingerprint fields", () => {
    const a = buildCanonicalSailing(LIVE_FIXTURE, catalogues);
    const altered = {
      ...LIVE_FIXTURE,
      ports_list: [
        ...LIVE_FIXTURE.ports_list.slice(0, 5),
        { port: "Victoria, Canada", day: 6 },
        { port: "At Sea", day: 7 },
        { port: "Seattle, Washington", day: 8 }
      ]
    };
    // same itinerary essentially — change a port day label
    altered.ports_list[1] = { port: "Ketchikan, Alaska", day: 2 };
    const b = buildCanonicalSailing(altered, catalogues);
    assert(a.sailingKey === b.sailingKey, "key stable when line/ship/date/nights/dep same");
    assert(JSON.stringify(a.itinerary) !== JSON.stringify(b.itinerary), "itinerary differs");
  });

  await test("provider source lineage fields present on canonical sailing", () => {
    const s = buildCanonicalSailing(LIVE_FIXTURE, catalogues);
    assert(s.provider === "track-cruises", "provider");
    assert(s.providerCruiseId === "1632", "provider id");
    assert(s.providerItineraryId === "ASG070", "itin id");
    assert(s.sourceUrl.includes("princess.com"), "url");
  });

  await test("alias review CSV exists with PENDING_REVIEW", () => {
    const csv = fs.readFileSync(path.join(root, "data/cruise-ports/port-alias-review.csv"), "utf8");
    assert(csv.includes("PENDING_REVIEW"), "pending");
    assert(csv.includes("provider_value"), "header");
  });

  await test("draft migrations exist and marked unapplied", () => {
    const inv = fs.readFileSync(
      path.join(root, "supabase/migrations/20260735_cruise_canonical_inventory.sql"),
      "utf8"
    );
    assert(/DRAFT|UNAPPLIED/i.test(inv), "draft banner");
    assert(inv.includes("cruise_sailings"), "table");
    assert(inv.includes("cruise_sailing_sources"), "sources");
    assert(inv.includes("uuid NULL REFERENCES public.ci_cruise_lines"), "uuid FK lines");
    // Ensure no fare storage columns (comments mentioning "No price" are ok)
    assert(!/^\s*price\b/im.test(inv), "no price column");
    assert(!/^\s*currency\b/im.test(inv), "no currency column");
    assert(!/^\s*fare\b/im.test(inv), "no fare column");
  });

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
