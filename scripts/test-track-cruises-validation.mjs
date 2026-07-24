#!/usr/bin/env node
/**
 * Sprint 15A — Track.cruises validation tests (fixture / offline only).
 * Never calls the live RapidAPI.
 *
 * Run: node scripts/test-track-cruises-validation.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { TrackCruisesRequestGuard } = require(
  path.join(root, "scripts/lib/track-cruises/request-guard.js")
);
const { createTrackCruisesClient } = require(
  path.join(root, "scripts/lib/track-cruises/client.js")
);
const { loadTrackCruisesCredentials, credentialStatusLine } = require(
  path.join(root, "scripts/lib/track-cruises/env.js")
);
const {
  classifyFields,
  inspectPortsListStructure,
  mapTrackCruiseToCandidateRaw,
  portsListToItinerary,
  redactForFixture,
  companyDisplayName
} = require(path.join(root, "scripts/lib/track-cruises/map-to-candidate.js"));
const { normaliseCruiseResult } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/normalise-cruise-result.js")
);
const { enrichCandidate, loadLocalCatalogues } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/enrichment/match-entities.js")
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

/** Synthetic sample shaped like documented schema — NOT a live capture. */
const SYNTHETIC_CRUISE = {
  _fixture_note: "SYNTHETIC schema-shaped sample for offline tests. Not live API data.",
  cruise_id: "syn-princess-001",
  itinerary_id: null,
  title: null,
  company: "princess",
  locale: "en_AU",
  ship_name: "Sun Princess",
  departure_date: "2026-09-12T00:00:00.000Z",
  duration: 7,
  price: 1299,
  price_euro: 1100,
  currency: "AUD",
  cabin_prices_per_person: { INTERIOR: 1299, BALCONY: 1899 },
  destinations: ["Mediterranean"],
  ports_list: [
    { port: "Barcelona", day: 1, arrival: null, departure: "2026-09-12T17:00:00.000Z" },
    { port: "Marseille", day: 3, arrival: "2026-09-14T08:00:00.000Z", departure: "2026-09-14T18:00:00.000Z" },
    { port: "Rome (Civitavecchia)", day: 5, arrival: "2026-09-16T07:00:00.000Z", departure: "2026-09-16T19:00:00.000Z" },
    { port: "Barcelona", day: 8, arrival: "2026-09-19T06:00:00.000Z", departure: null }
  ],
  itinerary_url: "https://example.invalid/itinerary/syn-princess-001",
  updated_at: "2026-07-01T00:00:00.000Z"
};

const MALFORMED = { hello: "world", data: "not-an-array" };

async function mockFetchFactory(handler) {
  return async (url, init) => handler(String(url), init || {});
}

async function main() {
  await test("credentials status line never includes key material", () => {
    const prev = process.env.TRACK_CRUISES_RAPIDAPI_KEY;
    process.env.TRACK_CRUISES_RAPIDAPI_KEY = "test-key-should-never-appear-in-status";
    const line = credentialStatusLine();
    assert(line === "TRACK_CRUISES_RAPIDAPI_KEY: configured", "configured line");
    assert(!line.includes("test-key"), "no key leak");
    if (prev == null) delete process.env.TRACK_CRUISES_RAPIDAPI_KEY;
    else process.env.TRACK_CRUISES_RAPIDAPI_KEY = prev;
  });

  await test("missing credentials reported", () => {
    const prevKey = process.env.TRACK_CRUISES_RAPIDAPI_KEY;
    const prevHost = process.env.TRACK_CRUISES_RAPIDAPI_HOST;
    delete process.env.TRACK_CRUISES_RAPIDAPI_KEY;
    delete process.env.TRACK_CRUISES_RAPIDAPI_HOST;
    // Point at empty temp env by using a fake root with no .env
    const emptyRoot = path.join(root, "tmp/track-cruises-validation/_empty_env_root");
    fs.mkdirSync(emptyRoot, { recursive: true });
    const out = loadTrackCruisesCredentials(emptyRoot);
    assert(out.ok === false, "should fail");
    if (prevKey != null) process.env.TRACK_CRUISES_RAPIDAPI_KEY = prevKey;
    if (prevHost != null) process.env.TRACK_CRUISES_RAPIDAPI_HOST = prevHost;
  });

  await test("request guard caps live calls at 5", () => {
    const guard = new TrackCruisesRequestGuard({ maxLiveCalls: 5 });
    for (let i = 0; i < 5; i += 1) guard.record("/x", true);
    let threw = false;
    try {
      guard.assertLiveAllowed("sixth");
    } catch {
      threw = true;
    }
    assert(threw, "sixth call must be refused");
  });

  await test("request guard refuses pagination", () => {
    const guard = new TrackCruisesRequestGuard();
    let threw = false;
    try {
      guard.assertNotPagination({ starting_after: "abc" });
    } catch {
      threw = true;
    }
    assert(threw, "pagination refused");
  });

  await test("request guard refuses bulk limit", () => {
    const guard = new TrackCruisesRequestGuard();
    let threw = false;
    try {
      guard.assertNotBulk({ limit: 50 });
    } catch {
      threw = true;
    }
    assert(threw, "bulk refused");
  });

  await test("client maps 401", async () => {
    const fetchImpl = await mockFetchFactory(async () => ({
      status: 401,
      text: async () => JSON.stringify({ title: "Unauthorized" })
    }));
    const client = createTrackCruisesClient({
      key: "dummy",
      host: "example.invalid",
      fetchImpl,
      guard: new TrackCruisesRequestGuard({ maxLiveCalls: 5 })
    });
    const res = await client.getCoverage();
    assert(res.ok === false && res.status === 401, "401");
    assert(res.error.code === "unauthorized", "code");
  });

  await test("client maps 429", async () => {
    const fetchImpl = await mockFetchFactory(async () => ({
      status: 429,
      text: async () => JSON.stringify({ message: "Too many requests" })
    }));
    const client = createTrackCruisesClient({
      key: "dummy",
      host: "example.invalid",
      fetchImpl,
      guard: new TrackCruisesRequestGuard({ maxLiveCalls: 5 })
    });
    const res = await client.getCruises({ limit: 1 });
    assert(res.ok === false && res.status === 429, "429");
    assert(res.error.code === "rate_limited", "code");
  });

  await test("malformed provider response classified", () => {
    const fields = classifyFields(MALFORMED, ["cruise_id", "ports_list"]);
    assert(fields.cruise_id === "Missing", "cruise_id missing");
    assert(fields.ports_list === "Missing", "ports_list missing");
  });

  await test("ports_list structure inspection", () => {
    const info = inspectPortsListStructure(SYNTHETIC_CRUISE.ports_list);
    assert(info.isArray && info.length === 4, "length");
    assert(info.keysObserved.includes("port"), "port key");
    assert(info.keysObserved.includes("day"), "day key");
    assert(info.latitude === false, "no lat");
    assert(info.longitude === false, "no lon");
    assert(info.portIds === false, "no port ids");
  });

  await test("itinerary extraction from ports_list", () => {
    const stops = portsListToItinerary(SYNTHETIC_CRUISE.ports_list);
    assert(stops.length === 4, "4 stops");
    assert(stops[0].type === "embarkation", "embark");
    assert(stops[stops.length - 1].type === "disembarkation", "disembark");
    assert(stops[1].portName === "Marseille", "mid port");
  });

  await test("null-field handling in mapper", () => {
    const mapped = mapTrackCruiseToCandidateRaw(SYNTHETIC_CRUISE);
    assert(mapped.mapping.returnedNull.includes("itinerary_id"), "itinerary_id null");
    assert(mapped.mapping.returnedNull.includes("title"), "title null");
    assert(mapped.candidateRaw.title.includes("Princess"), "synthesised title");
    assert(!("price" in mapped.candidateRaw), "price stripped");
  });

  await test("normalisation into Engine V2 candidate contract", () => {
    const mapped = mapTrackCruiseToCandidateRaw(SYNTHETIC_CRUISE);
    const out = normaliseCruiseResult(mapped.candidateRaw);
    assert(out.ok, JSON.stringify(out.errors || []));
    assert(out.cruise.provider === "track-cruises", "provider");
    assert(out.cruise.nights === 7, "nights");
    assert(out.cruise.departurePortName === "Barcelona", "dep port");
    assert(out.cruise.returnDate === "2026-09-19", "return derived");
  });

  await test("prices forbidden if leaked into candidate", () => {
    const mapped = mapTrackCruiseToCandidateRaw(SYNTHETIC_CRUISE);
    const leaked = { ...mapped.candidateRaw, price: 100 };
    const out = normaliseCruiseResult(leaked);
    assert(out.ok === false, "must reject prices");
    assert(out.errors.some((e) => e.code === "prices_forbidden"), "prices_forbidden");
  });

  await test("cruise-line / ship / port matching against catalogues", () => {
    const mapped = mapTrackCruiseToCandidateRaw(SYNTHETIC_CRUISE);
    const out = normaliseCruiseResult(mapped.candidateRaw);
    assert(out.ok, "normalise");
    const catalogues = loadLocalCatalogues();
    const enrichment = enrichCandidate(out.cruise, catalogues);
    assert(enrichment.cruiseLineMatch.status === "MATCHED", "line matched");
    assert(companyDisplayName("princess") === "Princess Cruises", "display map");
    // Sun Princess may or may not be in the tiny snapshot — record status only
    assert(["MATCHED", "NOT_FOUND", "AMBIGUOUS"].includes(enrichment.shipMatch.status), "ship status");
    assert(enrichment.portMatches.length >= 1, "ports checked");
  });

  await test("redact strips auth-shaped keys", () => {
    const red = redactForFixture({
      data: [{ cruise_id: "x" }],
      headers: { "X-RapidAPI-Key": "SECRET" },
      api_key: "SECRET"
    });
    assert(red.headers === "[REDACTED]", "headers");
    assert(red.api_key === "[REDACTED]", "api_key");
    assert(red.data[0].cruise_id === "x", "cruise kept");
  });

  await test("route object suitability is false without coordinates", () => {
    const mapped = mapTrackCruiseToCandidateRaw(SYNTHETIC_CRUISE);
    assert(mapped.routeObjectSuitable === false, "not suitable");
    assert(/latitude|longitude|coordinate/i.test(mapped.routeObjectReason), "reason");
  });

  // Persist synthetic fixtures for offline --fixtures mode (clearly marked).
  const fixtureDir = path.join(root, "tmp/track-cruises-validation");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const coverageSynth = {
    _fixture_note: "SYNTHETIC — live /coverage was not captured (RapidAPI 403 not subscribed).",
    live_capture_status: "failed",
    live_error: "403 You are not subscribed to this API."
  };
  fs.writeFileSync(
    path.join(fixtureDir, "coverage-redacted.json"),
    `${JSON.stringify(coverageSynth, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(fixtureDir, "cruises-list-redacted.json"),
    `${JSON.stringify(
      {
        _fixture_note: "SYNTHETIC schema-shaped sample — NOT live API data.",
        data: [SYNTHETIC_CRUISE],
        has_more: false,
        next_cursor: null
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    path.join(fixtureDir, "cruise-detail-redacted.json"),
    `${JSON.stringify(
      {
        _fixture_note: "SYNTHETIC schema-shaped sample — NOT live API data.",
        data: SYNTHETIC_CRUISE
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    path.join(fixtureDir, "live-access-error.json"),
    `${JSON.stringify(
      {
        status: 403,
        message: "You are not subscribed to this API.",
        note: "Valid RapidAPI key shape accepted (not 401 invalid key), but no active subscription to cruise-pricing-api1."
      },
      null,
      2
    )}\n`
  );

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error.message || error));
  process.exitCode = 1;
});
