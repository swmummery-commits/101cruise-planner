#!/usr/bin/env node
/**
 * Sprint 16A — inventory writer tests (SQLite DEV only, zero live API calls).
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { openDevInventoryDb, assertDevInventoryTarget, PRODUCTION_SUPABASE_REF } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/dev-db.js")
);
const { applyDevMigrationsAndSeeds } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/apply-dev-schema.js")
);
const { importProviderRows, getDbStatistics } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/inventory-writer.js")
);
const { loadAppCatalogues } = require(
  path.join(root, "netlify/functions/lib/cruise-finder-v2/inventory/load-app-catalogues.js")
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

const FIXTURE = {
  cruise_id: "1632",
  itinerary_id: "ASG070",
  title: "Inside Passage",
  company: "princess",
  locale: "en_US",
  ship_name: "Royal Princess",
  departure_date: "2026-07-25T00:00:00+00:00",
  duration: 7,
  price: 1199,
  price_euro: 1000,
  currency: "USD",
  cabin_prices_per_person: { INTERIOR: 1199 },
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
  await test("refuses production Supabase target", () => {
    let threw = false;
    try {
      assertDevInventoryTarget({
        target: "sqlite-dev",
        url: `https://${PRODUCTION_SUPABASE_REF}.supabase.co`
      });
    } catch {
      threw = true;
    }
    assert(threw, "must refuse prod URL");
  });

  const dbPath = path.join(root, "tmp/dev-inventory/test-inventory.sqlite");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const { db } = openDevInventoryDb({ root, dbPath, reset: true });
  const migration = applyDevMigrationsAndSeeds(db, { root });
  const catalogues = loadAppCatalogues({ root });

  await test("schema + ports seed applied", () => {
    assert(migration.portCount >= 240, "ports");
    assert(migration.productionTouched === false, "not prod");
    const stats = getDbStatistics(db);
    assert(stats.ports >= 240, "db ports");
    assert(stats.cruise_lines >= 40, "lines");
  });

  await test("idempotent create then unchanged", () => {
    const a = importProviderRows(db, [FIXTURE, { ...FIXTURE, locale: "ja_JP", price: 1 }], catalogues);
    assert(a.records_created === 1, `created ${a.records_created}`);
    assert(a.duplicates_prevented >= 1, "locale dup prevented");
    const b = importProviderRows(db, [FIXTURE], catalogues);
    assert(b.records_created === 0, "no create on repeat");
    assert(b.records_unchanged === 1, "unchanged");
    assert(getDbStatistics(db).cruise_sailings === 1, "one sailing");
  });

  await test("prices never stored", () => {
    const sources = db.prepare(`SELECT * FROM cruise_sailing_sources`).all();
    for (const s of sources) assertNoPrices(s);
    const sailings = db.prepare(`SELECT * FROM cruise_sailings`).all();
    for (const s of sailings) assertNoPrices(s);
  });

  await test("source lineage preserved", () => {
    const src = db
      .prepare(`SELECT provider, provider_cruise_id, provider_itinerary_id, raw_fingerprint FROM cruise_sailing_sources`)
      .get();
    assert(src.provider === "track-cruises", "provider");
    assert(src.provider_cruise_id === "1632", "id");
    assert(src.provider_itinerary_id === "ASG070", "itin");
    assert(src.raw_fingerprint && src.raw_fingerprint.length === 64, "fingerprint");
  });

  await test("route_object_eligible stored", () => {
    const row = db.prepare(`SELECT route_object_eligible FROM cruise_sailings`).get();
    assert(row.route_object_eligible === 1, "eligible flag");
  });

  await test("itinerary update detected", () => {
    const mutated = {
      ...FIXTURE,
      title: "Updated title",
      ports_list: [
        { port: "Seattle, Washington", day: 1 },
        { port: "Ketchikan, Alaska", day: 2 },
        { port: "Skagway, Alaska", day: 3 },
        { port: "Glacier Bay National Park (scenic Cruising), Alaska", day: 4 },
        { port: "Juneau, Alaska", day: 5 },
        { port: "Victoria, Canada", day: 6 },
        { port: "At Sea", day: 7 },
        { port: "Seattle, Washington", day: 8 }
      ]
    };
    const u = importProviderRows(db, [mutated], catalogues);
    assert(u.records_updated === 1, `updated ${u.records_updated}`);
    assert(getDbStatistics(db).cruise_sailings === 1, "still one sailing");
    const title = db.prepare(`SELECT title FROM cruise_sailings`).get().title;
    assert(title === "Updated title", "title updated");
  });

  await test("itinerary rows present", () => {
    const n = getDbStatistics(db).itinerary_stops;
    assert(n === 8, `stops ${n}`);
  });

  db.close();

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
