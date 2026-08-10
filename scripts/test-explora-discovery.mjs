#!/usr/bin/env node
/**
 * Explora Journeys discovery tests (offline unit tests + optional live source probe).
 *   npm run test:explora-discovery
 *   EXPLORA_LIVE_PROBE=true npm run test:explora-discovery
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const source = require(path.join(root, "netlify/functions/lib/explora-discovery-source"));
const adapter = require(path.join(root, "netlify/functions/lib/explora-discovery-adapter"));
const writes = require(path.join(root, "netlify/functions/lib/explora-discovery-writes"));
const mode = require(path.join(root, "netlify/functions/lib/explora-discovery-mode"));
const maintenance = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const runner = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner"));
const inventory = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { OPERATIONAL_DESTINATION_CATALOGUE } = require(path.join(
  root,
  "netlify/functions/lib/destination-classification"
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

/* ------------------------------------------------------------------ fixtures */

/** Static identity used by the pure parsing tests (date irrelevant to parsing). */
const MIAMI_JOURNEY_URL =
  "https://explorajourneys.com/int/en/destinations-globe/car/journeys/miasju-08-v12?id-journey=EX20260212MIASJU";

/**
 * Confidence scoring reads the real clock, so normalisation fixtures are pinned to a rolling
 * future departure rather than a hard-coded date that would rot.
 */
const TODAY = new Date().toISOString().slice(0, 10);
const CAR_DEPARTURE = source.addDaysIso(TODAY, 180);
const CAR_RETURN = source.addDaysIso(CAR_DEPARTURE, 8);
const CAR_JOURNEY_ID = `EX${CAR_DEPARTURE.replace(/-/g, "")}MIASJU`;
const CAR_JOURNEY_URL = `https://explorajourneys.com/int/en/destinations-globe/car/journeys/miasju-08-v12?id-journey=${CAR_JOURNEY_ID}`;
const MED_DEPARTURE = source.addDaysIso(TODAY, 260);
const MED_RETURN = source.addDaysIso(MED_DEPARTURE, 14);
const MED_JOURNEY_ID = `EP${MED_DEPARTURE.replace(/-/g, "")}BCNBCN`;
const MED_JOURNEY_URL = `https://explorajourneys.com/int/en/destinations-globe/med/journeys/bcnbcn-14-v10?id-journey=${MED_JOURNEY_ID}`;

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${CAR_JOURNEY_URL}</loc><lastmod>2026-02-05</lastmod></url>
<url><loc>${MED_JOURNEY_URL}</loc><lastmod>2026-02-05</lastmod></url>
<url><loc>${CAR_JOURNEY_URL}</loc><lastmod>2026-02-05</lastmod></url>
<url><loc>https://explorajourneys.com/int/en/destinations-globe/car/journeys/hotel-stay</loc><lastmod>2026-02-05</lastmod></url>
</urlset>`;

function detailHtml({
  name = "A Journey from Sparkling Cityscapes to Tranquil Island Escapes",
  ship = "EXPLORA I",
  nights = 8,
  departure = CAR_DEPARTURE,
  arrival = CAR_RETURN,
  ports = [
    "Miami, United States",
    "Puerto Plata, Dominican Republic, Dominican Republic",
    "Bridgetown, Barbados",
    "San Juan, Puerto Rico"
  ],
  includeTrip = true
} = {}) {
  const trip = {
    "@type": "Trip",
    name,
    description: "Slip into a journey of shimmering waters.",
    departureTime: departure,
    arrivalTime: arrival,
    itinerary: ports.map((p) => ({ "@type": "Place", name: p }))
  };
  const graph = [{ "@type": "Product", name: `${name} – ${CAR_JOURNEY_ID}`, image: "https://dm.example/x.webp" }];
  if (includeTrip) graph.push(trip);
  return `<html><head>
<meta name="description" content="Journey aboard ${ship} for ${nights} nights sailing from ${ports[0].split(",")[0]}. Departing 12th February 2026."/>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph })}</script>
</head><body></body></html>`;
}

function mockTransport(routes) {
  return async (url) => {
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) return { ok: true, status: 200, text: body };
    }
    return { ok: false, status: 404, text: "" };
  };
}

const LINE = { id: "line-explora", name: "Explora Journeys", slug: "explora-journeys" };
const SHIPS = [
  { id: "ship-ex1", name: "EXPLORA I", cruise_line_id: LINE.id, official_line_ship_id: null },
  { id: "ship-ex2", name: "EXPLORA II", cruise_line_id: LINE.id, official_line_ship_id: null },
  { id: "ship-ex3", name: "EXPLORA III", cruise_line_id: LINE.id, official_line_ship_id: null },
  { id: "ship-ex4", name: "EXPLORA IV", cruise_line_id: LINE.id, official_line_ship_id: null },
  { id: "ship-ex5", name: "EXPLORA V", cruise_line_id: LINE.id, official_line_ship_id: null }
];
const DESTINATIONS = adapter.catalogueDestinations(
  OPERATIONAL_DESTINATION_CATALOGUE.map((entry) => ({
    id: `dest-${entry.slug}`,
    name: entry.name,
    slug: entry.slug,
    status: "published",
    classification_enabled: true
  }))
);

function normaliseFixture(overrides = {}) {
  const sitemapEntry = source.parseSitemapUrl(CAR_JOURNEY_URL, "2026-02-05");
  const detail = source.parseJourneyDetailHtml(detailHtml(overrides.detail || {}));
  const raw = { ...source.buildRawJourney(sitemapEntry, detail), ...(overrides.raw || {}) };
  return adapter.normaliseExploraProduct(raw, {
    cruiseLine: LINE,
    ships: SHIPS,
    destinations: DESTINATIONS,
    ...(overrides.context || {})
  });
}

/* ------------------------------------------------- 1-13: source identity + parsing */

test("1. official identity is the uppercase id-journey value", () => {
  const key = source.officialProductKey({ journey_id: "ex20260212miasju" });
  if (key !== "EX20260212MIASJU") throw new Error(key);
});

test("2. officialProductKey falls back to the official URL query parameter", () => {
  if (source.officialProductKey({ official_url: MIAMI_JOURNEY_URL }) !== "EX20260212MIASJU") {
    throw new Error("url fallback failed");
  }
});

test("3. parseJourneyId decomposes ship, date and port pair", () => {
  const parsed = source.parseJourneyId("EX20260212MIASJU");
  if (!parsed.valid) throw new Error("expected valid");
  if (parsed.ship_code !== "EX") throw new Error(parsed.ship_code);
  if (parsed.departure_date !== "2026-02-12") throw new Error(parsed.departure_date);
  if (parsed.embark_code !== "MIA" || parsed.disembark_code !== "SJU") throw new Error("ports");
  if (parsed.ship_name !== "EXPLORA I") throw new Error(parsed.ship_name);
});

test("4. parseJourneyId accepts the trailing disambiguation digit form", () => {
  const parsed = source.parseJourneyId("EP20260214MIASJ1");
  if (!parsed.valid || parsed.disembark_code !== "SJ1") throw new Error(JSON.stringify(parsed));
});

test("5. parseJourneyId rejects malformed identities", () => {
  for (const bad of ["", "EX2026", "XX20261301MIASJU", "EX2026021MIASJU"]) {
    if (source.parseJourneyId(bad).valid) throw new Error(`accepted ${bad}`);
  }
});

test("6. parseSitemapUrl extracts region, slug and slug nights", () => {
  const entry = source.parseSitemapUrl(MIAMI_JOURNEY_URL, "2026-02-05");
  if (!entry.valid) throw new Error(entry.reason);
  if (entry.region_code !== "car") throw new Error(entry.region_code);
  if (entry.slug !== "miasju-08-v12") throw new Error(entry.slug);
  if (entry.nights_from_slug !== 8) throw new Error(String(entry.nights_from_slug));
  if (entry.lastmod !== "2026-02-05") throw new Error(entry.lastmod);
});

test("7. parseSitemapUrl rejects URLs without id-journey", () => {
  const entry = source.parseSitemapUrl("https://explorajourneys.com/int/en/destinations-globe/car/journeys/foo");
  if (entry.valid || entry.reason !== "missing_id_journey") throw new Error(JSON.stringify(entry));
});

test("8. parseSitemapUrl rejects non-journey catalogue URLs", () => {
  const entry = source.parseSitemapUrl("https://explorajourneys.com/int/en/ships/explora-i?id-journey=EX20260212MIASJU");
  if (entry.valid || entry.reason !== "not_a_journey_url") throw new Error(JSON.stringify(entry));
});

test("9. parseSitemapXml reads loc and lastmod pairs", () => {
  const entries = source.parseSitemapXml(SITEMAP_XML);
  if (entries.length !== 4) throw new Error(String(entries.length));
  if (!entries[0].loc.includes(`id-journey=${CAR_JOURNEY_ID}`)) throw new Error(entries[0].loc);
});

test("10. buildOfficialUrl normalises to the int/en locale", () => {
  const url = source.buildOfficialUrl(
    "https://explorajourneys.com/aus/en/destinations-globe/car/journeys/miasju-08-v12?id-journey=EX20260212MIASJU"
  );
  if (!url.includes("/int/en/")) throw new Error(url);
  if (!url.includes("id-journey=EX20260212MIASJU")) throw new Error(url);
});

test("11. classifyProductType returns ocean_cruise for standard journeys", () => {
  const entry = source.parseSitemapUrl(MIAMI_JOURNEY_URL);
  if (source.classifyProductType(entry) !== "ocean_cruise") throw new Error("expected ocean_cruise");
});

test("12. Extended and Grand journeys remain ocean_cruise", () => {
  for (const title of [
    "An Extended Journey from Northern Spirit to Cultural Riches",
    "A Grand Journey of Lively Culture & Stunning Beaches"
  ]) {
    const raw = { ...source.parseSitemapUrl(MIAMI_JOURNEY_URL), itinerary_name: title };
    if (source.classifyProductType(raw) !== "ocean_cruise") throw new Error(title);
  }
});

test("13. hotel-only / land-only products are classified non_cruise, missing identity non_journey", () => {
  const hotel = { ...source.parseSitemapUrl(MIAMI_JOURNEY_URL), itinerary_name: "Pre-Cruise Stay hotel package" };
  if (source.classifyProductType(hotel) !== "non_cruise") throw new Error("hotel title");
  const landPath = {
    journey_id: "EX20260212MIASJU",
    official_url: "https://explorajourneys.com/int/en/land-programmes/foo?id-journey=EX20260212MIASJU"
  };
  if (source.classifyProductType(landPath) !== "non_cruise") throw new Error("land path");
  if (source.classifyProductType({ official_url: "https://explorajourneys.com/int/en/ships/explora-i" }) !== "non_journey") {
    throw new Error("non_journey");
  }
});

/* --------------------------------------------- 14-22: detail parsing + fetch plumbing */

test("14. parseJourneyDetailHtml reads the schema.org Trip node", () => {
  const detail = source.parseJourneyDetailHtml(detailHtml());
  if (!detail.has_trip_jsonld) throw new Error("missing trip");
  if (detail.departure_date !== CAR_DEPARTURE || detail.return_date !== CAR_RETURN) throw new Error("dates");
  if (detail.itinerary_ports.length !== 4) throw new Error("ports");
  if (detail.departure_port !== "Miami, United States") throw new Error(detail.departure_port);
  if (detail.arrival_port !== "San Juan, Puerto Rico") throw new Error(detail.arrival_port);
});

test("15. parseJourneyDetailHtml reads the ship name from the meta description", () => {
  const detail = source.parseJourneyDetailHtml(detailHtml({ ship: "EXPLORA III" }));
  if (detail.ship_name !== "EXPLORA III") throw new Error(detail.ship_name);
  if (detail.nights_from_meta !== 8) throw new Error(String(detail.nights_from_meta));
});

test("16. nights are derived from the JSON-LD date span", () => {
  if (source.nightsBetweenIso("2026-02-12", "2026-02-20") !== 8) throw new Error("span");
  if (source.nightsBetweenIso("2026-02-20", "2026-02-12") !== null) throw new Error("reverse span accepted");
});

test("17. nights fall back to the slug when JSON-LD is absent", () => {
  const entry = source.parseSitemapUrl(MIAMI_JOURNEY_URL);
  const raw = source.buildRawJourney(entry, null);
  if (raw.nights !== 8) throw new Error(String(raw.nights));
  if (raw.detail_enriched !== false) throw new Error("should not be marked enriched");
});

test("18. return_date is computed when only nights are known", () => {
  const entry = source.parseSitemapUrl(MIAMI_JOURNEY_URL);
  const raw = source.buildRawJourney(entry, null);
  if (raw.return_date !== "2026-02-20") throw new Error(raw.return_date);
});

test("19. buildRawJourney merges sitemap identity with detail-page structure", () => {
  const entry = source.parseSitemapUrl(MIAMI_JOURNEY_URL);
  const raw = source.buildRawJourney(entry, source.parseJourneyDetailHtml(detailHtml()));
  if (raw.official_sailing_id !== "EX20260212MIASJU") throw new Error(raw.official_sailing_id);
  if (raw.ship_code !== "EX" || raw.ship_name !== "EXPLORA I") throw new Error("ship");
  if (raw.region_code !== "car") throw new Error(raw.region_code);
  if (raw.structured_source !== "explora_journey_trip_jsonld") throw new Error(raw.structured_source);
  if (raw.product_type !== "ocean_cruise") throw new Error(raw.product_type);
});

await testAsync("20. fetchJourneySitemap dedupes and reports skipped rows", async () => {
  const result = await source.fetchJourneySitemap({
    transport: mockTransport({ "journey.sitemap.xml": SITEMAP_XML })
  });
  if (!result.ok) throw new Error(result.error);
  if (result.journeys.length !== 2) throw new Error(String(result.journeys.length));
  if (result.audit.duplicate_journey_ids !== 1) throw new Error("dedupe");
  if (result.audit.skip_reasons.missing_id_journey !== 1) throw new Error("skip reasons");
});

await testAsync("21. enrichJourneyFromDetailPage degrades gracefully on fetch failure", async () => {
  const entry = source.parseSitemapUrl(MIAMI_JOURNEY_URL);
  const result = await source.enrichJourneyFromDetailPage(entry, {
    transport: async () => ({ ok: false, status: 503, text: "" }),
    maxAttempts: 1
  });
  if (result.ok) throw new Error("expected failure");
  if (result.raw.detail_enriched !== false) throw new Error("must not claim enrichment");
  if (result.raw.official_sailing_id !== "EX20260212MIASJU") throw new Error("identity lost");
});

await testAsync("22. mapWithConcurrency preserves input order", async () => {
  const out = await source.mapWithConcurrency([5, 1, 3], 8, async (n) => {
    await new Promise((r) => setTimeout(r, n));
    return n;
  });
  if (out.join(",") !== "5,1,3") throw new Error(out.join(","));
});

/* -------------------------------------------------- 23-31: ship / port / destination */

test("23. ship resolves by exact fleet name when official_line_ship_id is null", () => {
  const result = normaliseFixture();
  if (result.candidate.ship_id !== "ship-ex1") throw new Error(JSON.stringify(result.ship_resolution));
  if (result.ship_resolution.method !== "exact_name") throw new Error(result.ship_resolution.method);
});

test("24. ship resolves by official_line_ship_id when the code is seeded", () => {
  const seeded = SHIPS.map((s) => (s.name === "EXPLORA I" ? { ...s, official_line_ship_id: "EX" } : s));
  const result = normaliseFixture({ context: { ships: seeded } });
  if (result.ship_resolution.method !== "official_line_ship_id") throw new Error(result.ship_resolution.method);
});

test("25. ship code map covers EX/EP/EL/EO/EA", () => {
  const expected = { EX: "EXPLORA I", EP: "EXPLORA II", EL: "EXPLORA III", EO: "EXPLORA IV", EA: "EXPLORA V" };
  for (const [code, name] of Object.entries(expected)) {
    if (source.EXPLORA_SHIP_CODE_NAME[code] !== name) throw new Error(`${code} => ${source.EXPLORA_SHIP_CODE_NAME[code]}`);
  }
});

test("26. departure port resolves from the JSON-LD embarkation place", () => {
  const result = normaliseFixture();
  if (result.departure_port_resolution.status !== "resolved") throw new Error("unresolved port");
  if (result.candidate.departure_port !== "Miami") throw new Error(result.candidate.departure_port);
});

test("27. reviewed port aliases rewrite JSON-LD names that miss the catalogue", () => {
  const cases = [
    ["New York City, United States", "NYC", "New York"],
    ["Berlin/Warnemünde, Germany", "WNM", "Warnemunde"],
    ["Bangkok/Laem Chabang, Thailand", "LCH", "Laem Chabang"]
  ];
  for (const [rawPort, embark, expected] of cases) {
    const meta = adapter.resolveExploraDeparturePort({ departure_port: rawPort, embark_code: embark });
    if (meta.status !== "resolved" || meta.canonicalPortName !== expected) {
      throw new Error(`${rawPort} → ${JSON.stringify(meta.canonicalPortName || meta.status)}`);
    }
  }
});

test("28. embark code map is used when the JSON-LD place is unusable", () => {
  const meta = adapter.resolveExploraDeparturePort({ departure_port: null, embark_code: "CVV" });
  if (meta.status !== "resolved" || meta.canonicalPortName !== "Civitavecchia") throw new Error(JSON.stringify(meta));
});

test("29. destination resolves from itinerary port evidence", () => {
  const result = normaliseFixture();
  if (result.destination_resolution.destinationKey !== "caribbean") {
    throw new Error(result.destination_resolution.destinationKey);
  }
  if (result.candidate.destination_id !== "dest-caribbean") throw new Error(result.candidate.destination_id);
});

test("30. region code provides the destination fallback only when ports are inconclusive", () => {
  const hints = adapter.resolveExploraDestinationHints({ region_code: "med" });
  if (hints.fallbackSlug !== "mediterranean") throw new Error(hints.fallbackSlug);
  // Official PAC region maps to approved pacific-coast taxonomy; soa/api/tra stay null.
  if (adapter.resolveExploraDestinationHints({ region_code: "pac" }).fallbackSlug !== "pacific-coast") {
    throw new Error("pac fallback");
  }
  for (const region of ["soa", "api", "tra"]) {
    if (adapter.resolveExploraDestinationHints({ region_code: region }).fallbackSlug !== null) {
      throw new Error(`${region} must not force a destination`);
    }
  }
  if (adapter.resolveExploraDestinationHints({ region_code: "ice" }).fallbackSlug !== "northern-europe") {
    throw new Error("ice fallback");
  }
});

test("31. every region fallback slug exists in OPERATIONAL_DESTINATION_CATALOGUE", () => {
  const slugs = new Set(OPERATIONAL_DESTINATION_CATALOGUE.map((d) => d.slug));
  for (const [region, slug] of Object.entries(adapter.EXPLORA_REGION_DESTINATION_SLUG)) {
    if (slug && !slugs.has(slug)) throw new Error(`${region} → ${slug} not in catalogue`);
  }
});

/* ------------------------------------------------------ 32-37: completeness + gating */

test("32. complete_high_confidence passes for a fully resolved journey", () => {
  const result = normaliseFixture();
  if (!result.complete_high_confidence) throw new Error(result.failure_reasons.join(","));
});

test("33. reviewed Red Sea embarkation ports resolve from catalogue aliases/codes", () => {
  const cases = [
    ["Jeddah, Saudi Arabia", "JED", "Jeddah"],
    ["Safaga, Egypt", "SGA", "Safaga"],
    ["Hamburg, Germany", "HAM", "Hamburg"],
    ["Panama City (Amador), Panama", "PAC", "Panama City"]
  ];
  for (const [rawPort, embark, expected] of cases) {
    const meta = adapter.resolveExploraDeparturePort({ departure_port: rawPort, embark_code: embark });
    if (meta.status !== "resolved" || meta.canonicalPortName !== expected) {
      throw new Error(`${rawPort} → ${JSON.stringify(meta.canonicalPortName || meta.status)}`);
    }
  }
});

test("33b. unresolved departure port blocks completeness", () => {
  const result = normaliseFixture({
    detail: { ports: ["Unknownportville, Atlantis"] },
    raw: { embark_code: "ZZZ", disembark_code: "YYY", departure_port: "Unknownportville, Atlantis" }
  });
  if (result.complete_high_confidence) throw new Error("should not be complete");
  if (!result.failure_reasons.includes("missing_departure_port")) throw new Error(result.failure_reasons.join(","));
});

test("34. a destination with no catalogue row blocks completeness", () => {
  const result = normaliseFixture({ context: { destinations: [] } });
  if (result.complete_high_confidence) throw new Error("should not be complete");
  if (result.candidate.destination_id) throw new Error("destination_id must stay null");
  const blocked = result.failure_reasons.some((r) =>
    ["destination_unresolved", "destination_ambiguous", "destination_missing_catalogue_id"].includes(r)
  );
  if (!blocked) throw new Error(result.failure_reasons.join(","));
});

test("35. unknown ship blocks completeness", () => {
  const result = normaliseFixture({ context: { ships: [] } });
  if (result.complete_high_confidence) throw new Error("should not be complete");
  if (!result.failure_reasons.includes("unknown_ship")) throw new Error(result.failure_reasons.join(","));
});

test("35b. missing detail enrichment blocks completeness", () => {
  const result = normaliseFixture({ raw: { detail_enriched: false } });
  if (result.complete_high_confidence) throw new Error("unenriched journeys must not be complete");
  if (!result.failure_reasons.includes("detail_page_not_enriched")) throw new Error(result.failure_reasons.join(","));
});

test("36. eligibility helper accepts ocean_cruise and rejects land products", () => {
  if (!adapter.isEligibleExploraCruise("ocean_cruise")) throw new Error("ocean_cruise");
  if (!adapter.isEligibleExploraCruise("cruise")) throw new Error("cruise");
  if (adapter.isEligibleExploraCruise("non_cruise")) throw new Error("non_cruise");
  if (!adapter.isExploraNonCruise("non_journey")) throw new Error("non_journey");
});

test("37. 21-day public booking cutoff excludes near departures", () => {
  const { withinCutoff, publiclyEligible } = inventory.partitionByPublicBookingCutoff(
    [{ departure_date: "2026-08-20" }, { departure_date: "2026-09-30" }],
    (row) => row.departure_date,
    "2026-08-10"
  );
  if (withinCutoff.length !== 1 || publiclyEligible.length !== 1) throw new Error("cutoff partition");
});

/* ------------------------------------------------------------- 38-45: mode + writes */

test("38. Explora production writes default to disabled", () => {
  if (mode.EXPLORA_DISCOVERY_WRITE_ENABLED) throw new Error("write flag enabled by default");
  const gate = mode.resolveExploraDiscoveryMode("production_write");
  if (gate.writes_allowed) throw new Error("production_write allowed");
  if (gate.reason !== "production_write_flag_disabled") throw new Error(gate.reason);
});

test("39. weekly_maintenance mode is blocked while the reconciliation flag is off", () => {
  const gate = mode.resolveExploraDiscoveryMode("weekly_maintenance");
  if (gate.writes_allowed) throw new Error("weekly writes allowed");
  if (gate.reason !== "explora_weekly_reconciliation_disabled") throw new Error(gate.reason);
  let threw = false;
  try {
    mode.assertExploraWritesAllowed(gate);
  } catch (error) {
    threw = error.code === "explora_discovery_write_forbidden";
  }
  if (!threw) throw new Error("assert did not throw");
});

test("40. Explora weekly reconciliation flag defaults false with its own run type", () => {
  if (maintenance.isExploraWeeklyReconciliationEnabled()) throw new Error("flag enabled");
  if (maintenance.EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE !== "explora_weekly_maintenance") throw new Error("run type");
  if (maintenance.MAINTENANCE_SCHEDULES.explora_weekly.schedule_registered !== false) {
    throw new Error("Explora schedule must stay unregistered");
  }
});

test("41. upsert candidate carries raw_extract.explora_sailing_id", () => {
  const row = normaliseFixture();
  const candidate = writes.buildExploraUpsertCandidate(row, { id: "line-explora" });
  if (!candidate) throw new Error("candidate not built");
  if (candidate.official_sailing_id !== CAR_JOURNEY_ID) throw new Error(candidate.official_sailing_id);
  if (candidate.raw_extract.explora_sailing_id !== CAR_JOURNEY_ID) throw new Error("raw_extract identity");
  if (candidate.raw_extract.explora_adapter_id !== "explora") throw new Error("adapter id");
  if (candidate.status !== "active") throw new Error(candidate.status);
});

test("42. incomplete rows never produce a write candidate", () => {
  const row = normaliseFixture({ context: { ships: [] } });
  if (writes.buildExploraUpsertCandidate(row, { id: "line-explora" }) !== null) throw new Error("candidate built");
});

test("43. proposed action classification covers insert, duplicate and update", () => {
  const row = normaliseFixture();
  const candidate = writes.buildExploraUpsertCandidate(row, { id: "line-explora" });
  if (writes.classifyProposedAction(row, null) !== "insert_active") throw new Error("insert");

  const existing = {
    id: "row-1",
    cruise_line_id: "line-explora",
    official_sailing_id: CAR_JOURNEY_ID,
    ship_id: candidate.ship_id,
    destination_id: candidate.destination_id,
    departure_date: candidate.departure_date,
    return_date: candidate.return_date,
    nights: candidate.nights,
    departure_port: candidate.departure_port,
    itinerary: candidate.itinerary,
    official_url: candidate.official_url,
    status: "active"
  };
  if (writes.classifyProposedAction(row, existing) !== "duplicate_skip") throw new Error("duplicate");
  if (writes.classifyProposedAction(row, { ...existing, nights: 99 }) !== "update_exact_legacy_match") {
    throw new Error("update");
  }
});

await testAsync("44. manifest build is read-only and marks writes_performed false", async () => {
  const row = normaliseFixture();
  const manifest = await writes.buildExploraBatchManifest({
    products: [row],
    cruiseLine: LINE,
    destinations: DESTINATIONS,
    supabase: null,
    runId: "test-run"
  });
  if (manifest.writes_performed !== false) throw new Error("writes_performed");
  if (manifest.products[0].proposed_action !== "insert_active") throw new Error(manifest.products[0].proposed_action);
  if (manifest.products[0].stable_identity_key !== CAR_JOURNEY_ID) throw new Error("identity key");
  if (manifest.adapter_id !== "explora") throw new Error(manifest.adapter_id);
});

await testAsync("45. applyExploraBatchWrites performs no writes when performWrites is false", async () => {
  const row = normaliseFixture();
  const result = await writes.applyExploraBatchWrites({
    products: [row, normaliseFixture({ context: { ships: [] } })],
    cruiseLine: LINE,
    maxWrites: 10,
    runId: "test-run",
    supabase: null,
    performWrites: false
  });
  if (result.stats.inserted !== 0 || result.stats.updated !== 0) throw new Error("writes performed");
  if (result.stats.incomplete_skips !== 1) throw new Error(String(result.stats.incomplete_skips));
});

await testAsync("46. findSourceAbsentActive recognises raw_extract.explora_sailing_id", async () => {
  const rows = [
    { id: "a", official_sailing_id: null, departure_date: "2027-01-01", raw_extract: { explora_sailing_id: "EX20270101MIASJU" } },
    { id: "b", official_sailing_id: "EX20270201MIASJU", departure_date: "2027-02-01", raw_extract: {} }
  ];
  let served = false;
  const supabase = async () => {
    if (served) return [];
    served = true;
    return rows;
  };
  const absent = await runner.findSourceAbsentActive({
    supabase,
    cruiseLineId: "line-explora",
    eligibleKeys: new Set(["EX20270201MIASJU"]),
    today: "2026-08-10",
    officialProductKeyFn: (raw) => adapter.officialProductKey(raw)
  });
  if (absent.length !== 1) throw new Error(JSON.stringify(absent));
  if (absent[0].official_sailing_id !== "EX20270101MIASJU") throw new Error(absent[0].official_sailing_id);
});

test("47. Explora weekly write cap is separate from the Princess cap", () => {
  if (runner.MAX_WEEKLY_WRITES !== 30) throw new Error("Princess cap changed");
  if (runner.EXPLORA_MAX_WEEKLY_WRITES !== 25) throw new Error(String(runner.EXPLORA_MAX_WEEKLY_WRITES));
  if (runner.MAX_WRITES_PER_BATCH !== 100) throw new Error("batch cap changed");
});

await testAsync("48. simulateExploraInventory runs end-to-end against mocked transport", async () => {
  const simulation = await adapter.simulateExploraInventory({
    cruiseLine: LINE,
    ships: SHIPS,
    destinations: DESTINATIONS,
    today: TODAY,
    transport: mockTransport({
      "journey.sitemap.xml": SITEMAP_XML,
      "miasju-08-v12": detailHtml(),
      "bcnbcn-14-v10": detailHtml({
        name: "An Extended Journey into Riviera Romance",
        ship: "EXPLORA II",
        nights: 14,
        departure: MED_DEPARTURE,
        arrival: MED_RETURN,
        ports: ["Barcelona, Spain", "Palma de Mallorca, Spain", "Naples, Italy", "Barcelona, Spain"]
      })
    })
  });
  if (!simulation.ok) throw new Error("simulation failed");
  if (simulation.raw_journey_count !== 2) throw new Error(String(simulation.raw_journey_count));
  if (simulation.metrics.complete_high_confidence !== 2) {
    throw new Error(JSON.stringify(simulation.metrics.failure_counts));
  }
  if (simulation.metrics.ship_resolution_pct !== 100) throw new Error("ship pct");
  if (simulation.metrics.identity_coverage_pct !== 100) throw new Error("identity pct");
  const keys = simulation.products.map((p) => p.official_sailing_id).sort();
  if (keys.join(",") !== [CAR_JOURNEY_ID, MED_JOURNEY_ID].sort().join(",")) throw new Error(keys.join(","));
});

await testAsync("49. legacy rows without official_sailing_id match on the journey id in their URL", async () => {
  const row = normaliseFixture();
  const legacy = {
    id: "legacy-1",
    cruise_line_id: LINE.id,
    official_sailing_id: null,
    official_url: `https://explorajourneys.com/us/en/destinations-globe/car/journeys/miasju-08-v12?id-journey=${CAR_JOURNEY_ID.toLowerCase()}`,
    status: "active",
    raw_extract: { title: "legacy discovery row" }
  };
  if (writes.existingRecordKey(legacy) !== CAR_JOURNEY_ID) throw new Error("legacy key not recovered");

  let served = false;
  const supabase = async () => {
    if (served) return [];
    served = true;
    return [legacy];
  };
  const manifest = await writes.buildExploraBatchManifest({
    products: [row],
    cruiseLine: LINE,
    destinations: DESTINATIONS,
    supabase,
    runId: "legacy-match"
  });
  if (manifest.products[0].existing_record_match !== "legacy-1") throw new Error("legacy row not matched");
  if (manifest.products[0].proposed_action !== "update_exact_legacy_match") {
    throw new Error(manifest.products[0].proposed_action);
  }
});

/* --------------------------------------------------------------- optional live probe */

if (String(process.env.EXPLORA_LIVE_PROBE || "").toLowerCase() === "true") {
  await testAsync("49. live probe: official sitemap returns parseable journeys", async () => {
    const result = await source.fetchJourneySitemap();
    if (!result.ok) throw new Error(result.error);
    if (result.journeys.length < 100) throw new Error(`only ${result.journeys.length} journeys`);
    const bad = result.journeys.filter((j) => !j.journey_id || !j.departure_date || !j.ship_code);
    if (bad.length) throw new Error(`${bad.length} journeys missing identity fields`);
  });

  await testAsync("50. live probe: a journey detail page exposes Trip JSON-LD", async () => {
    const sitemap = await source.fetchJourneySitemap();
    const future = sitemap.journeys.find((j) => j.departure_date >= new Date().toISOString().slice(0, 10));
    const enriched = await source.enrichJourneyFromDetailPage(future);
    if (!enriched.ok) throw new Error(enriched.error);
    if (!enriched.raw.ship_name) throw new Error("no ship name from meta");
    if (!enriched.raw.departure_port) throw new Error("no embarkation port from JSON-LD");
  });
} else {
  console.log("· live probe skipped (set EXPLORA_LIVE_PROBE=true to enable)");
}

console.log(`\n${passed} tests passed, ${failures.length} failed`);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
