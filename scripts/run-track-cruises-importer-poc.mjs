#!/usr/bin/env node
/**
 * Sprint 15B — Track.cruises → canonical inventory importer POC.
 *
 * Usage:
 *   node scripts/run-track-cruises-importer-poc.mjs --fixtures
 *   node scripts/run-track-cruises-importer-poc.mjs --live
 *
 * --live: max 10 API requests, Princess preferred, no pagination, no Supabase writes.
 * HOLD DEPLOY. No prices retained.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { loadTrackCruisesCredentials, credentialStatusLine } = require(
  path.join(root, "scripts/lib/track-cruises/env.js")
);
const { createTrackCruisesClient } = require(
  path.join(root, "scripts/lib/track-cruises/client.js")
);
const { TrackCruisesRequestGuard } = require(
  path.join(root, "scripts/lib/track-cruises/request-guard.js")
);
const { redactForFixture } = require(
  path.join(root, "scripts/lib/track-cruises/map-to-candidate.js")
);
const { loadAppCatalogues } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/load-app-catalogues.js")
);
const { TrackCruisesProvider } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/providers/track-cruises-provider.js")
);
const { assertNoPrices } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/strip-prices.js")
);

const OUT_DIR = path.join(root, "tmp/track-cruises-importer");
const VALIDATION_DIR = path.join(root, "tmp/track-cruises-validation");

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

function writeJson(name, data) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
  return p;
}

function loadFixtureRows() {
  const rows = [];
  const listPath = path.join(VALIDATION_DIR, "cruises-list-redacted.json");
  const detailPath = path.join(VALIDATION_DIR, "cruise-detail-redacted.json");
  if (fs.existsSync(listPath)) {
    const body = JSON.parse(fs.readFileSync(listPath, "utf8"));
    if (Array.isArray(body.data)) rows.push(...body.data);
  }
  if (fs.existsSync(detailPath)) {
    const body = JSON.parse(fs.readFileSync(detailPath, "utf8"));
    const cruise = body.data && !Array.isArray(body.data) ? body.data : body;
    if (cruise?.cruise_id) rows.push(cruise);
  }
  return rows.filter((r) => r && r.cruise_id != null && !r._fixture_note);
}

async function fetchLivePrincessSample() {
  const creds = loadTrackCruisesCredentials(root);
  console.log(credentialStatusLine());
  if (!creds.ok) throw new Error(creds.error);
  console.log("✓ RapidAPI key detected");

  const guard = new TrackCruisesRequestGuard({ maxLiveCalls: 10 });
  const client = createTrackCruisesClient({
    key: process.env.TRACK_CRUISES_RAPIDAPI_KEY,
    host: creds.host,
    guard
  });

  // One request: Princess, single locale, limit 10 — no pagination.
  console.log("Live: GET /cruises?company=princess&locale=en_US&limit=10");
  const list = await client.getCruises({
    company: "princess",
    locale: "en_US",
    limit: 10
  });
  if (!list.ok) {
    throw new Error(`Live list failed: ${list.status} ${JSON.stringify(list.error)}`);
  }

  writeJson("live-princess-list-redacted.json", redactForFixture(list.body));
  const rows = Array.isArray(list.body?.data) ? list.body.data : [];
  console.log(`Live rows returned: ${rows.length}; API calls used: ${guard.liveCalls}`);
  return { rows, liveCalls: guard.liveCalls, callLog: guard.log };
}

function summarise(sailings, duplicates, meta) {
  const n = sailings.length || 1;
  const lineMatched = sailings.filter((s) => s.matchSummary.cruiseLineMatched).length;
  const shipMatched = sailings.filter((s) => s.matchSummary.shipMatched).length;
  const routeEligible = sailings.filter((s) => s.routeObjectEligible).length;

  let ordinaryTotal = 0;
  let ordinaryMatched = 0;
  let aliasMatched = 0;
  let scenic = 0;
  let sea = 0;
  const unmatchedPorts = new Set();
  const unmatchedShips = new Set();

  for (const s of sailings) {
    ordinaryTotal += s.matchSummary.totalMatchablePorts;
    ordinaryMatched += s.matchSummary.matchedPorts;
    aliasMatched += s.matchSummary.aliasMatchedPorts;
    scenic += s.matchSummary.scenicCruisingStops;
    sea += s.matchSummary.seaDays;
    if (!s.matchSummary.shipMatched) {
      unmatchedShips.add(s.ship.providerName || "(missing)");
    }
    for (const stop of s.itinerary || []) {
      if (
        (stop.type === "embarkation" || stop.type === "port" || stop.type === "disembarkation") &&
        stop.matchStatus === "NOT_FOUND" &&
        stop.providerPortName
      ) {
        unmatchedPorts.add(stop.providerPortName);
      }
    }
  }

  return {
    meta,
    sampleSize: sailings.length,
    duplicatesCollapsed: duplicates.length,
    cruiseLineMatchRate: Math.round((lineMatched / n) * 1000) / 10,
    shipMatchRate: Math.round((shipMatched / n) * 1000) / 10,
    ordinaryPortMatchRate:
      ordinaryTotal === 0 ? 0 : Math.round((ordinaryMatched / ordinaryTotal) * 1000) / 10,
    aliasMatchCount: aliasMatched,
    scenicCruisingStops: scenic,
    seaDays: sea,
    routeObjectEligibilityRate: Math.round((routeEligible / n) * 1000) / 10,
    unmatchedShips: [...unmatchedShips],
    unmatchedPorts: [...unmatchedPorts],
    perCruise: sailings.map((s) => ({
      providerCruiseId: s.providerCruiseId,
      providerItineraryId: s.providerItineraryId,
      title: s.title,
      ship: s.ship.providerName,
      lineMatch: s.cruiseLine.matchStatus,
      shipMatch: s.ship.matchStatus,
      itinerarySize: s.itinerary.length,
      ordinaryPorts: s.matchSummary.ordinaryPortStops,
      scenic: s.matchSummary.scenicCruisingStops,
      sea: s.matchSummary.seaDays,
      matchedPorts: s.matchSummary.matchedPorts,
      aliasMatchedPorts: s.matchSummary.aliasMatchedPorts,
      ambiguousPorts: s.matchSummary.ambiguousPorts,
      unmatchedPorts: s.matchSummary.unmatchedPorts,
      returnDate: s.returnDate,
      dateConsistencyOk: s.dateConsistency?.ok,
      routeObjectEligible: s.routeObjectEligible,
      sailingKey: s.sailingKey
    }))
  };
}

async function main() {
  const flags = parseArgs(process.argv);
  const catalogues = loadAppCatalogues({ root });
  console.log(
    `Catalogues loaded: ${catalogues.meta.lineCount} lines, ${catalogues.meta.shipCount} ships, ${catalogues.meta.portCount} ports`
  );

  let rows = [];
  let liveCalls = 0;
  let callLog = [];

  if (flags.live) {
    const live = await fetchLivePrincessSample();
    rows = live.rows;
    liveCalls = live.liveCalls;
    callLog = live.callLog;
    // Prefer live sample only (avoid mixing older multi-locale fixture rows).
  } else {
    // Prefer dedicated live Princess capture when present; else validation fixtures.
    const liveCapture = path.join(OUT_DIR, "live-princess-list-redacted.json");
    if (fs.existsSync(liveCapture)) {
      const body = JSON.parse(fs.readFileSync(liveCapture, "utf8"));
      rows = Array.isArray(body.data) ? body.data : [];
    } else {
      rows = loadFixtureRows();
    }
    if (!rows.length) {
      console.error("No fixture rows. Run with --live first.");
      process.exitCode = 1;
      return;
    }
  }

  // Cap unique import consideration at 10 provider cruise_ids after locale collapse intent
  const provider = new TrackCruisesProvider({ catalogues, rows });
  const imported = provider.importRows(rows, catalogues);

  for (const s of imported.sailings) {
    const check = assertNoPrices(s);
    if (!check.ok) throw new Error(`Price leak: ${check.violations.join(",")}`);
  }

  // Keep at most 10 unique sailings for POC output
  const sailings = imported.sailings.slice(0, 10);
  const summary = summarise(sailings, imported.duplicates, {
    liveCalls,
    callLog,
    rawRows: rows.length,
    catalogues: catalogues.meta
  });

  writeJson("canonical-sailings.json", sailings.map((s) => {
    const { _routePreview, _removedPriceFields, _locale, ...rest } = s;
    return { ...rest, localeObserved: _locale || null, removedPriceFields: _removedPriceFields || [] };
  }));
  writeJson("import-summary.json", summary);
  writeJson("proposed-port-aliases.json", catalogues.proposedPortAliases);
  writeJson("duplicates.json", imported.duplicates);

  console.log("\n--- Import summary ---");
  console.log(JSON.stringify({
    liveCalls,
    rawRows: rows.length,
    uniqueSailings: sailings.length,
    duplicatesCollapsed: imported.duplicates.length,
    cruiseLineMatchRate: summary.cruiseLineMatchRate,
    shipMatchRate: summary.shipMatchRate,
    ordinaryPortMatchRate: summary.ordinaryPortMatchRate,
    routeObjectEligibilityRate: summary.routeObjectEligibilityRate,
    unmatchedShips: summary.unmatchedShips,
    unmatchedPorts: summary.unmatchedPorts
  }, null, 2));
  console.log(`Output: ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(String(error.stack || error));
  process.exitCode = 1;
});
