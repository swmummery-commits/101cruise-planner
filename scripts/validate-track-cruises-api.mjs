#!/usr/bin/env node
/**
 * Sprint 15A — Track.cruises live / fixture validation (local POC only).
 *
 * Usage:
 *   node scripts/validate-track-cruises-api.mjs --live
 *   node scripts/validate-track-cruises-api.mjs --fixtures
 *
 * HOLD DEPLOY. No Supabase writes. No Engine V2 activation. Max 5 live calls.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const NODE = process.execPath;

const { loadTrackCruisesCredentials, credentialStatusLine } = require(
  path.join(root, "scripts/lib/track-cruises/env.js")
);
const { createTrackCruisesClient } = require(
  path.join(root, "scripts/lib/track-cruises/client.js")
);
const { TrackCruisesRequestGuard, DEFAULT_MAX_LIVE_CALLS } = require(
  path.join(root, "scripts/lib/track-cruises/request-guard.js")
);
const {
  classifyFields,
  inspectPortsListStructure,
  mapTrackCruiseToCandidateRaw,
  redactForFixture
} = require(path.join(root, "scripts/lib/track-cruises/map-to-candidate.js"));
const { normaliseCruiseResult } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/normalise-cruise-result.js")
);
const { enrichCandidate, loadLocalCatalogues } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/enrichment/match-entities.js")
);

const FIXTURE_DIR = path.join(root, "tmp/track-cruises-validation");
const INSPECT_FIELDS = [
  "cruise_id",
  "itinerary_id",
  "title",
  "company",
  "ship_name",
  "departure_date",
  "duration",
  "locale",
  "ports_list",
  "destinations",
  "currency",
  "price",
  "cabin_prices_per_person"
];

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=");
      flags[k] = v == null ? true : v;
    }
  }
  return flags;
}

function ensureFixtureDir() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
}

function writeJson(fileName, data) {
  ensureFixtureDir();
  const target = path.join(FIXTURE_DIR, fileName);
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return target;
}

function pickCruiseId(listBody) {
  const rows = Array.isArray(listBody?.data)
    ? listBody.data
    : Array.isArray(listBody)
      ? listBody
      : [];
  for (const row of rows) {
    if (row && row.cruise_id != null && String(row.cruise_id).trim()) {
      return String(row.cruise_id);
    }
  }
  return null;
}

function unwrapCruise(detailBody) {
  if (!detailBody) return null;
  if (detailBody.data && !Array.isArray(detailBody.data) && typeof detailBody.data === "object") {
    return detailBody.data;
  }
  if (detailBody.cruise_id != null) return detailBody;
  if (Array.isArray(detailBody.data) && detailBody.data[0]) return detailBody.data[0];
  return detailBody;
}

function summariseMatches(enrichment) {
  const portMatches = enrichment.portMatches || [];
  const matched = portMatches.filter((p) => p.status === "MATCHED");
  const alias = matched.filter((p) => p.via === "alias");
  const ambiguous = portMatches.filter((p) => p.status === "AMBIGUOUS");
  const unmatched = portMatches.filter((p) => p.status === "NOT_FOUND");
  const total = portMatches.length || 1;
  return {
    cruiseLine: enrichment.cruiseLineMatch,
    ship: enrichment.shipMatch,
    ports: {
      total: portMatches.length,
      matched: matched.length,
      aliasMatches: alias.length,
      ambiguous: ambiguous.length,
      unmatched: unmatched.length,
      matchPct: Math.round((matched.length / total) * 1000) / 10,
      unmatchedNames: unmatched.map((p) => p.portName),
      ambiguousNames: ambiguous.map((p) => p.portName),
      details: portMatches
    },
    lineMatchPct: enrichment.cruiseLineMatch?.status === "MATCHED" ? 100 : 0,
    shipMatchPct: enrichment.shipMatch?.status === "MATCHED" ? 100 : 0
  };
}

async function runLive() {
  const creds = loadTrackCruisesCredentials(root);
  console.log(credentialStatusLine());
  if (!creds.ok) {
    console.error(creds.error);
    process.exitCode = 1;
    return;
  }
  console.log("✓ RapidAPI key detected");

  const guard = new TrackCruisesRequestGuard({ maxLiveCalls: DEFAULT_MAX_LIVE_CALLS });
  const client = createTrackCruisesClient({
    key: process.env.TRACK_CRUISES_RAPIDAPI_KEY,
    host: creds.host,
    guard
  });

  console.log("\nLive call 1/3: GET /coverage");
  const coverage = await client.getCoverage();
  if (!coverage.ok) {
    writeJson(
      "live-access-error.json",
      redactForFixture({
        endpoint: "/coverage",
        status: coverage.status,
        error: coverage.error,
        body: coverage.body,
        hint:
          coverage.status === 403
            ? "RapidAPI key is present but not subscribed to Cruise Pricing API (cruise-pricing-api1). Subscribe to the Basic plan on RapidAPI, then re-run --live."
            : "Live call failed; see status/error."
      })
    );
    console.error("coverage failed:", coverage.status, coverage.error?.code || coverage.error);
    if (coverage.status === 403) {
      console.error(
        "Action required: subscribe this RapidAPI app to https://rapidapi.com/trackcruises/api/cruise-pricing-api1 (Basic $0), then re-run with --live."
      );
    }
    process.exitCode = 1;
    return;
  }
  writeJson("coverage-redacted.json", redactForFixture(coverage.body));

  console.log("Live call 2/3: GET /cruises?limit=5");
  const list = await client.getCruises({ limit: 5 });
  if (!list.ok) {
    writeJson(
      "live-access-error.json",
      redactForFixture({
        endpoint: "/cruises",
        status: list.status,
        error: list.error,
        body: list.body
      })
    );
    console.error("cruises list failed:", list.status, list.error?.code || list.error);
    process.exitCode = 1;
    return;
  }
  writeJson("cruises-list-redacted.json", redactForFixture(list.body));

  const cruiseId = pickCruiseId(list.body);
  if (!cruiseId) {
    console.error("No cruise_id in list response; cannot call detail.");
    process.exitCode = 1;
    return;
  }

  console.log("Live call 3/3: GET /cruises/{id}");
  const detail = await client.getCruise(cruiseId);
  if (!detail.ok) {
    writeJson(
      "live-access-error.json",
      redactForFixture({
        endpoint: `/cruises/${cruiseId}`,
        status: detail.status,
        error: detail.error,
        body: detail.body
      })
    );
    console.error("cruise detail failed:", detail.status, detail.error?.code || detail.error);
    process.exitCode = 1;
    return;
  }
  writeJson("cruise-detail-redacted.json", redactForFixture(detail.body));

  const listRows = Array.isArray(list.body?.data) ? list.body.data : [];
  const listSample = listRows[0] || null;
  const detailCruise = unwrapCruise(detail.body);

  const listFields = classifyFields(listSample, INSPECT_FIELDS);
  const detailFields = classifyFields(detailCruise, INSPECT_FIELDS);
  const portsStructure = inspectPortsListStructure(detailCruise?.ports_list);
  const mapped = mapTrackCruiseToCandidateRaw(detailCruise);
  const normalised = mapped.candidateRaw
    ? normaliseCruiseResult(mapped.candidateRaw)
    : { ok: false, errors: [{ code: "no_candidate", message: "No candidate." }] };

  const catalogues = loadLocalCatalogues();
  let matchSummary = null;
  if (normalised.ok) {
    matchSummary = summariseMatches(enrichCandidate(normalised.cruise, catalogues));
  }

  const summary = {
    mode: "live",
    liveCallsUsed: guard.liveCalls,
    maxLiveCalls: guard.maxLiveCalls,
    endpoints: ["/coverage", "/cruises?limit=5", `/cruises/${cruiseId}`],
    callLog: guard.log,
    coverageKeys:
      coverage.body && typeof coverage.body === "object" ? Object.keys(coverage.body) : [],
    listCount: listRows.length,
    selectedCruiseId: cruiseId,
    fieldPopulation: { listSample: listFields, detail: detailFields },
    portsListStructure: portsStructure,
    engineV2: {
      mapping: mapped.mapping,
      normaliseOk: normalised.ok,
      normaliseErrors: normalised.ok ? [] : normalised.errors,
      itineraryReliable: mapped.itineraryReliable,
      itineraryStopCount: mapped.candidateRaw?.itinerary?.length || 0,
      routeObjectSuitable: mapped.routeObjectSuitable,
      routeObjectReason: mapped.routeObjectReason,
      candidatePreview: normalised.ok
        ? {
            provider: normalised.cruise.provider,
            providerCruiseId: normalised.cruise.providerCruiseId,
            cruiseLineName: normalised.cruise.cruiseLineName,
            shipName: normalised.cruise.shipName,
            departureDate: normalised.cruise.departureDate,
            returnDate: normalised.cruise.returnDate,
            nights: normalised.cruise.nights,
            departurePortName: normalised.cruise.departurePortName,
            arrivalPortName: normalised.cruise.arrivalPortName,
            itinerary: normalised.cruise.itinerary,
            title: normalised.cruise.title,
            confidence: normalised.cruise.confidence
          }
        : null
    },
    catalogueMatching: matchSummary
  };

  writeJson("validation-summary.json", summary);

  console.log("\n--- Summary (no secrets) ---");
  console.log(`API requests used: ${guard.liveCalls}`);
  console.log(`List rows: ${listRows.length}`);
  console.log(`Selected cruise_id present: yes`);
  console.log(`Normalise ok: ${normalised.ok}`);
  console.log(`Itinerary stops: ${mapped.candidateRaw?.itinerary?.length || 0}`);
  console.log(`Route Object suitable: ${mapped.routeObjectSuitable}`);
  if (matchSummary) {
    console.log(
      `Line: ${matchSummary.cruiseLine.status} | Ship: ${matchSummary.ship.status} | Ports matched: ${matchSummary.ports.matched}/${matchSummary.ports.total} (${matchSummary.ports.matchPct}%)`
    );
  }
  console.log(`Fixtures written under tmp/track-cruises-validation/`);
}

async function runFixtures() {
  ensureFixtureDir();
  const detailPath = path.join(FIXTURE_DIR, "cruise-detail-redacted.json");
  if (!fs.existsSync(detailPath)) {
    console.error("No fixtures found. Run with --live first.");
    process.exitCode = 1;
    return;
  }
  console.log("TRACK_CRUISES_RAPIDAPI_KEY: (fixture mode — live credentials not required)");
  const detailBody = JSON.parse(fs.readFileSync(detailPath, "utf8"));
  const detailCruise = unwrapCruise(detailBody);
  const mapped = mapTrackCruiseToCandidateRaw(detailCruise);
  const normalised = mapped.candidateRaw
    ? normaliseCruiseResult(mapped.candidateRaw)
    : { ok: false, errors: [] };
  const catalogues = loadLocalCatalogues();
  const matchSummary = normalised.ok
    ? summariseMatches(enrichCandidate(normalised.cruise, catalogues))
    : null;

  console.log(`Normalise ok: ${normalised.ok}`);
  console.log(`Itinerary stops: ${mapped.candidateRaw?.itinerary?.length || 0}`);
  console.log(`Route Object suitable: ${mapped.routeObjectSuitable}`);
  if (matchSummary) {
    console.log(
      `Line: ${matchSummary.cruiseLine.status} | Ship: ${matchSummary.ship.status} | Ports: ${matchSummary.ports.matched}/${matchSummary.ports.total}`
    );
  }
}

async function main() {
  const flags = parseArgs(process.argv);
  if (flags.live) {
    await runLive();
    return;
  }
  if (flags.fixtures || flags["fixture-only"]) {
    await runFixtures();
    return;
  }
  console.error(`Usage (node ${NODE}):
  node scripts/validate-track-cruises-api.mjs --live
  node scripts/validate-track-cruises-api.mjs --fixtures

Live mode requires an explicit --live flag and refuses more than ${DEFAULT_MAX_LIVE_CALLS} API calls.`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error.message || error));
  process.exitCode = 1;
});
