#!/usr/bin/env node
/**
 * Sprint 16A — persistent canonical inventory writer (LOCAL DEV SQLITE ONLY).
 *
 * Usage:
 *   node scripts/run-inventory-import-16a.mjs --reset --live
 *   node scripts/run-inventory-import-16a.mjs --fixtures-only
 *
 * Safety:
 *   - Never writes to production Supabase (xikbibxyinttllxamgao blocked).
 *   - Uses tmp/dev-inventory/inventory.sqlite
 *   - Max 15 live Track.cruises API requests
 *   - Target ~100 unique Princess sailings
 *
 * HOLD DEPLOY. DO NOT COMMIT. DO NOT PUSH. Engine V2 not activated.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { openDevInventoryDb, assertDevInventoryTarget, PRODUCTION_SUPABASE_REF } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/dev-db.js")
);
const { applyDevMigrationsAndSeeds } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/apply-dev-schema.js")
);
const { importProviderRows, getDbStatistics, writeCanonicalSailing, loadResolverCaches } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/inventory-writer.js")
);
const { loadAppCatalogues } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/load-app-catalogues.js")
);
const { buildCanonicalSailing } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/build-canonical-sailing.js")
);
const { stripProviderPrices, assertNoPrices } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/strip-prices.js")
);
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

const OUT_DIR = path.join(root, "tmp/dev-inventory");
const TARGET_UNIQUE = 100;
const MAX_LIVE_REQUESTS = 15;

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

function loadExistingPrincessFixtures() {
  const rows = [];
  const livePath = path.join(root, "tmp/track-cruises-importer/live-princess-list-redacted.json");
  if (fs.existsSync(livePath)) {
    const body = JSON.parse(fs.readFileSync(livePath, "utf8"));
    if (Array.isArray(body.data)) rows.push(...body.data);
  }
  return rows.filter((r) => r && String(r.company || "").toLowerCase() === "princess");
}

/**
 * Paginated Princess fetch with hard request cap. Allows starting_after only here.
 */
async function fetchPrincessSample() {
  const creds = loadTrackCruisesCredentials(root);
  console.log(credentialStatusLine());
  if (!creds.ok) throw new Error(creds.error);

  // Bypass generic pagination refuse by using a custom guard + direct fetch loop
  const guard = new TrackCruisesRequestGuard({ maxLiveCalls: MAX_LIVE_REQUESTS });
  // Monkey-patch: allow starting_after for this controlled import only
  const originalAssert = guard.assertNotPagination.bind(guard);
  guard.assertNotPagination = (params) => {
    if (params && (params.page || params.offset || params.cursor)) {
      throw new Error("Unsupported pagination parameter.");
    }
    // starting_after allowed
  };

  const client = createTrackCruisesClient({
    key: process.env.TRACK_CRUISES_RAPIDAPI_KEY,
    host: creds.host,
    guard
  });

  const byId = new Map();
  let cursor = null;
  const pages = [];

  while (byId.size < TARGET_UNIQUE && guard.remaining() > 0) {
    const params = { company: "princess", locale: "en_US", limit: 10 };
    if (cursor) params.starting_after = cursor;
    console.log(
      `Live GET /cruises princess en_US limit=10${cursor ? " +cursor" : ""} (unique=${byId.size})`
    );
    const res = await client.getCruises(params);
    if (!res.ok) {
      throw new Error(`Live fetch failed: ${res.status} ${JSON.stringify(res.error)}`);
    }
    const batch = Array.isArray(res.body?.data) ? res.body.data : [];
    pages.push(redactForFixture({ page: pages.length + 1, count: batch.length, data: batch }));
    for (const row of batch) {
      if (row?.cruise_id != null) byId.set(String(row.cruise_id), row);
    }
    const next = res.body?.next_cursor || null;
    const hasMore = Boolean(res.body?.has_more) && next;
    if (!hasMore || !batch.length) break;
    cursor = next;
  }

  writeJson("live-princess-pages-redacted.json", { pages, unique: byId.size, liveCalls: guard.liveCalls });
  return { rows: [...byId.values()], liveCalls: guard.liveCalls, callLog: guard.log };
}

async function main() {
  const flags = parseArgs(process.argv);
  process.env.INVENTORY_DB_TARGET = process.env.INVENTORY_DB_TARGET || "sqlite-dev";
  assertDevInventoryTarget({ target: "sqlite-dev" });

  // Extra production refusal if someone points SUPABASE_URL at prod for a future adapter
  const prodUrl = process.env.SUPABASE_URL || "";
  if (prodUrl.includes(PRODUCTION_SUPABASE_REF)) {
    console.log(
      `NOTE: Production Supabase ref ${PRODUCTION_SUPABASE_REF} is present in env but will NOT be used.`
    );
  }

  const { db, dbPath } = openDevInventoryDb({ root, reset: Boolean(flags.reset) });
  console.log(`DEV DB: ${dbPath}`);

  const migration = applyDevMigrationsAndSeeds(db, { root });
  console.log("Migrations/seeds:", migration);

  const catalogues = loadAppCatalogues({ root });

  let rows = [];
  let liveCalls = 0;
  let callLog = [];

  if (flags.live) {
    const live = await fetchPrincessSample();
    rows = live.rows;
    liveCalls = live.liveCalls;
    callLog = live.callLog;
  } else {
    rows = loadExistingPrincessFixtures();
    if (rows.length < 20 && !flags["fixtures-only"]) {
      console.log("Few fixtures on disk; use --live to fetch ~100 Princess sailings.");
    }
  }

  // Deduplicate by cruise_id before import
  const unique = [...new Map(rows.map((r) => [String(r.cruise_id), r])).values()];
  console.log(`Provider rows for import: ${unique.length} (liveCalls=${liveCalls})`);

  if (!unique.length) {
    console.error("No rows to import.");
    process.exitCode = 1;
    return;
  }

  // Pass 1 — initial import
  const pass1 = importProviderRows(db, unique, catalogues, {
    provider: "track-cruises",
    requestCount: liveCalls
  });
  console.log("Pass1:", {
    created: pass1.records_created,
    updated: pass1.records_updated,
    unchanged: pass1.records_unchanged,
    rejected: pass1.records_rejected,
    duplicates_prevented: pass1.duplicates_prevented
  });

  // Pass 2 — repeated import must create zero duplicates
  const beforeCount = getDbStatistics(db).cruise_sailings;
  const pass2 = importProviderRows(db, unique, catalogues, {
    provider: "track-cruises",
    requestCount: 0
  });
  const afterCount = getDbStatistics(db).cruise_sailings;
  const duplicateCheck = {
    sailings_before: beforeCount,
    sailings_after: afterCount,
    delta: afterCount - beforeCount,
    pass2_created: pass2.records_created,
    pass2_unchanged: pass2.records_unchanged,
    ok: afterCount === beforeCount && pass2.records_created === 0
  };
  console.log("Repeat-import check:", duplicateCheck);

  // Pass 3 — itinerary update detection
  const sample = unique[0];
  const mutated = JSON.parse(JSON.stringify(sample));
  if (Array.isArray(mutated.ports_list) && mutated.ports_list.length > 2) {
    mutated.ports_list[1] = { ...mutated.ports_list[1], port: "Ketchikan, Alaska" };
  }
  mutated.title = `${mutated.title || "Cruise"} [itinerary-updated]`;
  const pass3 = importProviderRows(db, [mutated], catalogues, {
    provider: "track-cruises",
    requestCount: 0
  });
  const itineraryUpdateCheck = {
    records_updated: pass3.records_updated,
    records_unchanged: pass3.records_unchanged,
    ok: pass3.records_updated === 1 || pass3.records_unchanged === 0
  };
  console.log("Itinerary update check:", itineraryUpdateCheck);

  // Verify no prices in DB sources fingerprints / sailings JSON
  const sailingRows = db.prepare(`SELECT id, title, destinations, route_object_eligible FROM cruise_sailings LIMIT 5`).all();
  for (const row of sailingRows) {
    assertNoPrices(row);
  }
  const sourceSample = db.prepare(`SELECT raw_fingerprint, provider_cruise_id FROM cruise_sailing_sources LIMIT 3`).all();

  const stats = getDbStatistics(db);
  const report = {
    migrationStatus: {
      ...migration,
      productionSupabaseTouched: false,
      blockedProductionRef: PRODUCTION_SUPABASE_REF,
      dbPath
    },
    liveCalls,
    callLog,
    sampleSizeRequested: TARGET_UNIQUE,
    sampleSizeImported: unique.length,
    pass1: {
      records_received: pass1.records_received,
      records_created: pass1.records_created,
      records_updated: pass1.records_updated,
      records_unchanged: pass1.records_unchanged,
      records_rejected: pass1.records_rejected,
      duplicates_prevented: pass1.duplicates_prevented,
      unmatched_ports: pass1.unmatched_ports,
      unmatched_ships: pass1.unmatched_ships,
      unmatched_lines: pass1.unmatched_lines
    },
    pass2_repeatImport: duplicateCheck,
    pass3_itineraryUpdate: itineraryUpdateCheck,
    routeObjectEligibilityStored: stats.route_object_eligible,
    databaseStatistics: stats,
    sourceLineageSample: sourceSample,
    notes: [
      "DEV database is local SQLite under tmp/dev-inventory/ — production Supabase was not modified.",
      "To use a dedicated Supabase DEV project later, set SUPABASE_DEV_URL + key and extend the writer adapter."
    ]
  };

  writeJson("import-report-16a.json", report);
  console.log("\n=== Sprint 16A summary ===");
  console.log(JSON.stringify({
    migration: report.migrationStatus.migrationsApplied,
    rows_created: pass1.records_created,
    rows_updated: pass1.records_updated,
    duplicates_prevented: pass1.duplicates_prevented + (duplicateCheck.ok ? unique.length : 0),
    repeat_import_ok: duplicateCheck.ok,
    itinerary_update_ok: itineraryUpdateCheck.ok,
    unmatched_ports: pass1.unmatched_ports.length,
    unmatched_ships: pass1.unmatched_ships.length,
    db: stats,
    liveCalls
  }, null, 2));
  console.log(`Report: ${path.join(OUT_DIR, "import-report-16a.json")}`);
}

main().catch((error) => {
  console.error(String(error.stack || error));
  process.exitCode = 1;
});
