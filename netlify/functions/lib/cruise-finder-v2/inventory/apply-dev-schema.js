/**
 * Apply canonical inventory schema + seed ports/lines/ships into local DEV SQLite.
 * Mirrors supabase/migrations/20260735 + ports catalogue — development only.
 */

const fs = require("fs");
const path = require("path");
const { uuidFromSeed } = require("./dev-db");
const { parseCsv, normaliseName } = require("../enrichment/match-entities");

function applyInventorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ci_cruise_lines (
      id TEXT PRIMARY KEY,
      legacy_base44_id TEXT UNIQUE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS ci_cruise_ships (
      id TEXT PRIMARY KEY,
      cruise_line_id TEXT NOT NULL REFERENCES ci_cruise_lines(id),
      legacy_base44_id TEXT UNIQUE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS ports (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      display_name TEXT,
      city TEXT,
      country TEXT,
      country_code TEXT,
      region TEXT,
      latitude REAL,
      longitude REAL,
      aliases TEXT NOT NULL DEFAULT '[]',
      match_key TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'verified',
      source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cruise_sailings (
      id TEXT PRIMARY KEY,
      canonical_key TEXT NOT NULL UNIQUE,
      cruise_line_id TEXT REFERENCES ci_cruise_lines(id),
      ship_id TEXT REFERENCES ci_cruise_ships(id),
      title TEXT,
      departure_date TEXT NOT NULL,
      return_date TEXT,
      nights INTEGER,
      departure_port_id TEXT REFERENCES ports(id),
      arrival_port_id TEXT REFERENCES ports(id),
      destinations TEXT NOT NULL DEFAULT '[]',
      route_object_eligible INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      first_discovered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      retired_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cruise_sailing_itinerary (
      id TEXT PRIMARY KEY,
      cruise_sailing_id TEXT NOT NULL REFERENCES cruise_sailings(id) ON DELETE CASCADE,
      day_number INTEGER,
      itinerary_date TEXT,
      type TEXT NOT NULL,
      port_id TEXT REFERENCES ports(id),
      provider_description TEXT,
      canonical_name TEXT,
      latitude REAL,
      longitude REAL,
      sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (cruise_sailing_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS cruise_sailing_sources (
      id TEXT PRIMARY KEY,
      cruise_sailing_id TEXT NOT NULL REFERENCES cruise_sailings(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_cruise_id TEXT NOT NULL,
      provider_itinerary_id TEXT,
      source_url TEXT,
      provider_updated_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      raw_fingerprint TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (provider, provider_cruise_id)
    );

    CREATE TABLE IF NOT EXISTS cruise_import_runs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      records_received INTEGER NOT NULL DEFAULT 0,
      records_created INTEGER NOT NULL DEFAULT 0,
      records_updated INTEGER NOT NULL DEFAULT 0,
      records_unchanged INTEGER NOT NULL DEFAULT 0,
      records_rejected INTEGER NOT NULL DEFAULT 0,
      errors TEXT NOT NULL DEFAULT '[]',
      request_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS cruise_sailings_departure_date_idx ON cruise_sailings(departure_date);
    CREATE INDEX IF NOT EXISTS cruise_sailings_line_ship_idx ON cruise_sailings(cruise_line_id, ship_id);
    CREATE INDEX IF NOT EXISTS ports_match_key_idx ON ports(match_key);
  `);
}

function buildMatchKey(canonicalName, country) {
  const name = normaliseName(canonicalName);
  const ctry = normaliseName(country);
  return ctry ? `${name}|${ctry}` : `${name}|`;
}

function seedPortsFromCsv(db, csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const upsert = db.prepare(`
    INSERT INTO ports (
      id, canonical_name, display_name, city, country, country_code, region,
      latitude, longitude, aliases, match_key, status, source, created_at, updated_at
    ) VALUES (
      @id, @canonical_name, @display_name, @city, @country, @country_code, @region,
      @latitude, @longitude, @aliases, @match_key, @status, @source, @created_at, @updated_at
    )
    ON CONFLICT(match_key) DO UPDATE SET
      display_name=excluded.display_name,
      city=excluded.city,
      country_code=excluded.country_code,
      region=excluded.region,
      latitude=COALESCE(excluded.latitude, ports.latitude),
      longitude=COALESCE(excluded.longitude, ports.longitude),
      aliases=excluded.aliases,
      status=excluded.status,
      source=excluded.source,
      updated_at=excluded.updated_at
  `);

  const now = new Date().toISOString();
  let n = 0;
  for (const row of rows) {
    const canonical_name = String(row.canonical_name || "").trim();
    if (!canonical_name) continue;
    const country = String(row.country || "").trim();
    const match_key = buildMatchKey(canonical_name, country);
    const aliases = String(row.aliases || "")
      .split("|")
      .map((a) => a.trim())
      .filter(Boolean);
    const lat = row.latitude === "" || row.latitude == null ? null : Number(row.latitude);
    const lon = row.longitude === "" || row.longitude == null ? null : Number(row.longitude);
    upsert.run({
      id: uuidFromSeed(`port:${match_key}`),
      canonical_name,
      display_name: String(row.display_name || canonical_name).trim(),
      city: String(row.city || "").trim() || null,
      country: country || null,
      country_code: String(row.country_code || "").trim() || null,
      region: String(row.region || "").trim() || null,
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lon) ? lon : null,
      aliases: JSON.stringify(aliases),
      match_key,
      status: "verified",
      source: "seed:ports_catalogue_16a",
      created_at: now,
      updated_at: now
    });
    n += 1;
  }
  return n;
}

function seedLinesAndShipsFromExport(db, root) {
  const linesPath = path.join(root, "import-data/CruiseLine_export.csv");
  const shipsPath = path.join(root, "import-data/CruiseShip_export.csv");
  const lines = parseCsv(fs.readFileSync(linesPath, "utf8"));
  const ships = parseCsv(fs.readFileSync(shipsPath, "utf8"));

  const upsertLine = db.prepare(`
    INSERT INTO ci_cruise_lines (id, legacy_base44_id, name, active)
    VALUES (@id, @legacy_base44_id, @name, 1)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, legacy_base44_id=excluded.legacy_base44_id
  `);
  const upsertShip = db.prepare(`
    INSERT INTO ci_cruise_ships (id, cruise_line_id, legacy_base44_id, name, active)
    VALUES (@id, @cruise_line_id, @legacy_base44_id, @name, 1)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, cruise_line_id=excluded.cruise_line_id
  `);

  let lineCount = 0;
  const legacyToUuid = new Map();
  for (const row of lines) {
    const legacy = String(row.id || "").trim();
    const name = String(row.name || "").trim();
    if (!legacy || !name) continue;
    const id = uuidFromSeed(`line:${legacy}`);
    legacyToUuid.set(legacy, id);
    upsertLine.run({ id, legacy_base44_id: legacy, name });
    lineCount += 1;
  }

  let shipCount = 0;
  for (const row of ships) {
    const legacy = String(row.id || "").trim();
    const name = String(row.name || "").trim();
    const lineLegacy = String(row.cruise_line_id || "").trim();
    const cruise_line_id = legacyToUuid.get(lineLegacy);
    if (!legacy || !name || !cruise_line_id) continue;
    upsertShip.run({
      id: uuidFromSeed(`ship:${legacy}`),
      cruise_line_id,
      legacy_base44_id: legacy,
      name
    });
    shipCount += 1;
  }

  return { lineCount, shipCount };
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ root: string }} options
 */
function applyDevMigrationsAndSeeds(db, options) {
  const root = options.root;
  applyInventorySchema(db);
  const portsCsv = path.join(root, "data/ports/ports-catalogue.csv");
  const portCount = seedPortsFromCsv(db, portsCsv);
  const { lineCount, shipCount } = seedLinesAndShipsFromExport(db, root);

  // Migration status markers (local)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const mark = db.prepare(
    `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET applied_at=excluded.applied_at`
  );
  const now = new Date().toISOString();
  mark.run("20260735_cruise_canonical_inventory.sql", now);
  mark.run("20260736_ports_catalogue_expansion_draft.sql", now);
  mark.run("sqlite-dev-adapter-16a", now);

  return {
    migrationsApplied: [
      "20260735_cruise_canonical_inventory.sql",
      "20260736_ports_catalogue_expansion_draft.sql",
      "sqlite-dev-adapter-16a"
    ],
    portCount,
    lineCount,
    shipCount,
    target: "sqlite-dev",
    productionTouched: false
  };
}

module.exports = {
  applyInventorySchema,
  seedPortsFromCsv,
  seedLinesAndShipsFromExport,
  applyDevMigrationsAndSeeds,
  buildMatchKey
};
