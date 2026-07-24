/**
 * Sprint 16A — idempotent canonical inventory writer (DEV SQLite).
 * Never stores provider prices. Preserves source lineage.
 */

const crypto = require("crypto");
const { uuidFromSeed, fingerprintPayload } = require("./dev-db");
const { stripProviderPrices, assertNoPrices } = require("./strip-prices");
const { buildCanonicalSailing } = require("./build-canonical-sailing");
const { buildSailingKey } = require("./dedupe-canonical");
const { normaliseName, normaliseShipName } = require("../enrichment/match-entities");
const { buildMatchKey } = require("./apply-dev-schema");

function nowIso() {
  return new Date().toISOString();
}

function loadResolverCaches(db) {
  const lines = db.prepare(`SELECT id, legacy_base44_id, name FROM ci_cruise_lines`).all();
  const ships = db
    .prepare(`SELECT id, cruise_line_id, legacy_base44_id, name FROM ci_cruise_ships`)
    .all();
  const ports = db
    .prepare(
      `SELECT id, canonical_name, display_name, city, country, country_code, match_key, aliases, latitude, longitude FROM ports`
    )
    .all()
    .map((p) => ({
      ...p,
      aliases: (() => {
        try {
          return JSON.parse(p.aliases || "[]");
        } catch {
          return [];
        }
      })()
    }));

  const lineByLegacy = new Map(lines.map((l) => [l.legacy_base44_id, l]));
  const lineByName = new Map(lines.map((l) => [normaliseName(l.name), l]));
  const shipsByLine = new Map();
  for (const s of ships) {
    if (!shipsByLine.has(s.cruise_line_id)) shipsByLine.set(s.cruise_line_id, []);
    shipsByLine.get(s.cruise_line_id).push(s);
  }

  return { lines, ships, ports, lineByLegacy, lineByName, shipsByLine };
}

function resolveLineId(sailing, cache) {
  if (sailing.cruiseLine?.id && cache.lineByLegacy.has(sailing.cruiseLine.id)) {
    return cache.lineByLegacy.get(sailing.cruiseLine.id).id;
  }
  const byName = cache.lineByName.get(normaliseName(sailing.cruiseLine?.canonicalName || sailing.cruiseLine?.providerName));
  return byName ? byName.id : null;
}

function resolveShipId(sailing, lineId, cache) {
  if (!lineId) return null;
  const needle = normaliseShipName(sailing.ship?.canonicalName || sailing.ship?.providerName);
  const pool = cache.shipsByLine.get(lineId) || [];
  const hits = pool.filter((s) => normaliseShipName(s.name) === needle);
  if (hits.length === 1) return hits[0].id;
  if (sailing.ship?.id) {
    const byLegacy = pool.find((s) => s.legacy_base44_id === sailing.ship.id);
    if (byLegacy) return byLegacy.id;
  }
  return null;
}

function resolvePortId(portRef, providerName, cache) {
  if (portRef?.portId) {
    // CSV matcher ids like port-csv-N — map via canonical name if needed
    const byCsv = cache.ports.find((p) => p.id === portRef.portId);
    if (byCsv) return byCsv.id;
  }
  if (portRef?.canonicalName) {
    const n = normaliseName(portRef.canonicalName);
    const hits = cache.ports.filter(
      (p) => normaliseName(p.canonical_name) === n || normaliseName(p.city) === n
    );
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1 && providerName) {
      // prefer country hint from provider string
      const countryHint = String(providerName).split(",").pop();
      const aligned = hits.filter(
        (p) =>
          normaliseName(p.country) === normaliseName(countryHint) ||
          normaliseName(p.country_code) === normaliseName(countryHint)
      );
      if (aligned.length === 1) return aligned[0].id;
    }
  }
  return null;
}

function resolveItineraryPortId(stop, cache) {
  if (stop.type === "sea") return null;
  if (stop.portId) {
    const direct = cache.ports.find((p) => p.id === stop.portId);
    if (direct) return direct.id;
  }
  if (stop.canonicalPortName) {
    const n = normaliseName(stop.canonicalPortName);
    const hits = cache.ports.filter((p) => normaliseName(p.canonical_name) === n);
    if (hits.length === 1) return hits[0].id;
  }
  // Fall back to match_key from provider description + inferred country
  if (stop.providerPortName && stop.canonicalPortName) {
    // try aliases
    const needle = normaliseName(stop.providerPortName);
    for (const p of cache.ports) {
      const aliases = [p.canonical_name, p.display_name, p.city, ...(p.aliases || [])].map(normaliseName);
      if (aliases.includes(needle) || aliases.includes(normaliseName(stop.canonicalPortName))) {
        return p.id;
      }
    }
  }
  return null;
}

function storageCanonicalKey({ cruiseLineId, shipId, departureDate, nights, departurePortId }) {
  const line = cruiseLineId || "line?";
  const ship = shipId || "ship?";
  const date = departureDate || "date?";
  const n = nights != null ? String(nights) : "n?";
  const port = departurePortId || "p?";
  return [line, ship, date, n, port].join("|");
}

function priceSafeFingerprint(rawRow) {
  const { cleaned } = stripProviderPrices(rawRow || {});
  return fingerprintPayload(cleaned);
}

/**
 * Write one canonical sailing + itinerary + source lineage.
 * @returns {{ action: 'created'|'updated'|'unchanged'|'rejected', sailingId?: string, reason?: string }}
 */
function writeCanonicalSailing(db, sailing, rawProviderRow, caches) {
  assertNoPrices(sailing);

  const cruiseLineId = resolveLineId(sailing, caches);
  const shipId = resolveShipId(sailing, cruiseLineId, caches);
  const departurePortId = resolvePortId(sailing.departurePort, sailing.itinerary?.[0]?.providerPortName, caches);
  const arrivalPortId = resolvePortId(
    sailing.arrivalPort,
    sailing.itinerary?.[sailing.itinerary.length - 1]?.providerPortName,
    caches
  );

  if (!cruiseLineId) {
    return { action: "rejected", reason: "unmatched_cruise_line", detail: sailing.cruiseLine?.providerName };
  }
  if (!shipId) {
    return { action: "rejected", reason: "unmatched_ship", detail: sailing.ship?.providerName };
  }

  const canonicalKey = storageCanonicalKey({
    cruiseLineId,
    shipId,
    departureDate: sailing.departureDate,
    nights: sailing.nights,
    departurePortId
  });

  const fingerprint = priceSafeFingerprint(rawProviderRow);
  const ts = nowIso();

  const existing = db
    .prepare(`SELECT id, route_object_eligible FROM cruise_sailings WHERE canonical_key = ?`)
    .get(canonicalKey);

  const sourceExisting = db
    .prepare(
      `SELECT id, cruise_sailing_id, raw_fingerprint FROM cruise_sailing_sources
       WHERE provider = ? AND provider_cruise_id = ?`
    )
    .get(sailing.provider, sailing.providerCruiseId);

  let sailingId = existing?.id || sourceExisting?.cruise_sailing_id || crypto.randomUUID();
  let action = "created";

  if (existing) {
    sailingId = existing.id;
    const fpSame = sourceExisting && sourceExisting.raw_fingerprint === fingerprint;
    if (fpSame) {
      db.prepare(
        `UPDATE cruise_sailings SET last_seen_at = ?, updated_at = ? WHERE id = ?`
      ).run(ts, ts, sailingId);
      db.prepare(
        `UPDATE cruise_sailing_sources SET last_seen_at = ?, updated_at = ?, active = 1 WHERE id = ?`
      ).run(ts, ts, sourceExisting.id);
      return { action: "unchanged", sailingId, canonicalKey };
    }
    action = "updated";
  } else if (sourceExisting) {
    // Provider id exists under different canonical key — update that sailing
    sailingId = sourceExisting.cruise_sailing_id;
    action = sourceExisting.raw_fingerprint === fingerprint ? "unchanged" : "updated";
    if (action === "unchanged") {
      db.prepare(`UPDATE cruise_sailings SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(
        ts,
        ts,
        sailingId
      );
      db.prepare(
        `UPDATE cruise_sailing_sources SET last_seen_at = ?, updated_at = ? WHERE id = ?`
      ).run(ts, ts, sourceExisting.id);
      return { action: "unchanged", sailingId, canonicalKey };
    }
  }

  db.prepare(
    `
    INSERT INTO cruise_sailings (
      id, canonical_key, cruise_line_id, ship_id, title, departure_date, return_date, nights,
      departure_port_id, arrival_port_id, destinations, route_object_eligible, active, status,
      first_discovered_at, last_seen_at, created_at, updated_at
    ) VALUES (
      @id, @canonical_key, @cruise_line_id, @ship_id, @title, @departure_date, @return_date, @nights,
      @departure_port_id, @arrival_port_id, @destinations, @route_object_eligible, 1, 'active',
      @first_discovered_at, @last_seen_at, @created_at, @updated_at
    )
    ON CONFLICT(canonical_key) DO UPDATE SET
      title=excluded.title,
      return_date=excluded.return_date,
      nights=excluded.nights,
      departure_port_id=excluded.departure_port_id,
      arrival_port_id=excluded.arrival_port_id,
      destinations=excluded.destinations,
      route_object_eligible=excluded.route_object_eligible,
      last_seen_at=excluded.last_seen_at,
      updated_at=excluded.updated_at,
      active=1,
      status='active'
  `
  ).run({
    id: sailingId,
    canonical_key: canonicalKey,
    cruise_line_id: cruiseLineId,
    ship_id: shipId,
    title: sailing.title || null,
    departure_date: sailing.departureDate,
    return_date: sailing.returnDate || null,
    nights: sailing.nights,
    departure_port_id: departurePortId,
    arrival_port_id: arrivalPortId,
    destinations: JSON.stringify(sailing.destinations || []),
    route_object_eligible: sailing.routeObjectEligible ? 1 : 0,
    first_discovered_at: ts,
    last_seen_at: ts,
    created_at: ts,
    updated_at: ts
  });

  // Replace itinerary on create/update
  db.prepare(`DELETE FROM cruise_sailing_itinerary WHERE cruise_sailing_id = ?`).run(sailingId);
  const insertStop = db.prepare(`
    INSERT INTO cruise_sailing_itinerary (
      id, cruise_sailing_id, day_number, itinerary_date, type, port_id,
      provider_description, canonical_name, latitude, longitude, sequence, created_at, updated_at
    ) VALUES (
      @id, @cruise_sailing_id, @day_number, @itinerary_date, @type, @port_id,
      @provider_description, @canonical_name, @latitude, @longitude, @sequence, @created_at, @updated_at
    )
  `);

  (sailing.itinerary || []).forEach((stop, index) => {
    const portId = resolveItineraryPortId(stop, caches);
    insertStop.run({
      id: crypto.randomUUID(),
      cruise_sailing_id: sailingId,
      day_number: stop.dayNumber,
      itinerary_date: stop.date,
      type: stop.type,
      port_id: portId,
      provider_description: stop.providerPortName,
      canonical_name: stop.canonicalPortName,
      latitude: stop.latitude,
      longitude: stop.longitude,
      sequence: index + 1,
      created_at: ts,
      updated_at: ts
    });
  });

  db.prepare(
    `
    INSERT INTO cruise_sailing_sources (
      id, cruise_sailing_id, provider, provider_cruise_id, provider_itinerary_id, source_url,
      provider_updated_at, first_seen_at, last_seen_at, raw_fingerprint, active, created_at, updated_at
    ) VALUES (
      @id, @cruise_sailing_id, @provider, @provider_cruise_id, @provider_itinerary_id, @source_url,
      @provider_updated_at, @first_seen_at, @last_seen_at, @raw_fingerprint, 1, @created_at, @updated_at
    )
    ON CONFLICT(provider, provider_cruise_id) DO UPDATE SET
      cruise_sailing_id=excluded.cruise_sailing_id,
      provider_itinerary_id=excluded.provider_itinerary_id,
      source_url=excluded.source_url,
      provider_updated_at=excluded.provider_updated_at,
      last_seen_at=excluded.last_seen_at,
      raw_fingerprint=excluded.raw_fingerprint,
      active=1,
      updated_at=excluded.updated_at
  `
  ).run({
    id: sourceExisting?.id || crypto.randomUUID(),
    cruise_sailing_id: sailingId,
    provider: sailing.provider,
    provider_cruise_id: sailing.providerCruiseId,
    provider_itinerary_id: sailing.providerItineraryId || null,
    source_url: sailing.sourceUrl || null,
    provider_updated_at: sailing.providerUpdatedAt || null,
    first_seen_at: ts,
    last_seen_at: ts,
    raw_fingerprint: fingerprint,
    created_at: ts,
    updated_at: ts
  });

  return { action, sailingId, canonicalKey, routeObjectEligible: Boolean(sailing.routeObjectEligible) };
}

/**
 * Import many provider rows through catalogues → canonical → writer.
 */
function importProviderRows(db, rows, catalogues, options = {}) {
  const caches = loadResolverCaches(db);
  const stats = {
    records_received: rows.length,
    records_created: 0,
    records_updated: 0,
    records_unchanged: 0,
    records_rejected: 0,
    duplicates_prevented: 0,
    unmatched_ports: new Set(),
    unmatched_ships: new Set(),
    unmatched_lines: new Set(),
    route_eligible_stored: 0,
    errors: []
  };

  const seenProviderIds = new Set();
  const seenKeys = new Set();

  const runId = options.runId || crypto.randomUUID();
  const started = nowIso();
  db.prepare(
    `INSERT INTO cruise_import_runs (
      id, provider, started_at, status, records_received, request_count, errors, created_at
    ) VALUES (?, ?, ?, 'running', ?, ?, '[]', ?)`
  ).run(runId, options.provider || "track-cruises", started, rows.length, options.requestCount || 0, started);

  for (const row of rows) {
    try {
      const { cleaned } = stripProviderPrices(row);
      if (cleaned.cruise_id != null) {
        const pid = String(cleaned.cruise_id);
        if (seenProviderIds.has(pid)) {
          stats.duplicates_prevented += 1;
          continue;
        }
        seenProviderIds.add(pid);
      }

      const sailing = buildCanonicalSailing(cleaned, catalogues);
      for (const stop of sailing.itinerary || []) {
        if (
          (stop.type === "embarkation" || stop.type === "port" || stop.type === "disembarkation") &&
          stop.matchStatus === "NOT_FOUND" &&
          stop.providerPortName
        ) {
          stats.unmatched_ports.add(stop.providerPortName);
        }
      }

      const result = writeCanonicalSailing(db, sailing, cleaned, caches);
      if (result.action === "rejected") {
        stats.records_rejected += 1;
        if (result.reason === "unmatched_ship") stats.unmatched_ships.add(result.detail || "");
        if (result.reason === "unmatched_cruise_line") stats.unmatched_lines.add(result.detail || "");
        continue;
      }
      if (result.canonicalKey) {
        if (seenKeys.has(result.canonicalKey) && result.action === "created") {
          stats.duplicates_prevented += 1;
        }
        seenKeys.add(result.canonicalKey);
      }
      stats[`records_${result.action}`] += 1;
      if (result.routeObjectEligible) stats.route_eligible_stored += 1;
      else {
        // re-read stored flag
        const rowDb = db
          .prepare(`SELECT route_object_eligible FROM cruise_sailings WHERE id = ?`)
          .get(result.sailingId);
        if (rowDb?.route_object_eligible) stats.route_eligible_stored += 1;
      }
    } catch (error) {
      stats.records_rejected += 1;
      stats.errors.push(String(error.message || error));
    }
  }

  const completed = nowIso();
  db.prepare(
    `UPDATE cruise_import_runs SET
      completed_at = ?, status = ?, records_received = ?, records_created = ?,
      records_updated = ?, records_unchanged = ?, records_rejected = ?, errors = ?, request_count = ?
     WHERE id = ?`
  ).run(
    completed,
    stats.errors.length ? "completed_with_errors" : "completed",
    stats.records_received,
    stats.records_created,
    stats.records_updated,
    stats.records_unchanged,
    stats.records_rejected,
    JSON.stringify(stats.errors.slice(0, 50)),
    options.requestCount || 0,
    runId
  );

  return {
    runId,
    ...stats,
    unmatched_ports: [...stats.unmatched_ports].filter(Boolean).sort(),
    unmatched_ships: [...stats.unmatched_ships].filter(Boolean).sort(),
    unmatched_lines: [...stats.unmatched_lines].filter(Boolean).sort()
  };
}

function getDbStatistics(db) {
  const count = (sql) => db.prepare(sql).get().n;
  return {
    ports: count(`SELECT COUNT(*) AS n FROM ports`),
    cruise_lines: count(`SELECT COUNT(*) AS n FROM ci_cruise_lines`),
    cruise_ships: count(`SELECT COUNT(*) AS n FROM ci_cruise_ships`),
    cruise_sailings: count(`SELECT COUNT(*) AS n FROM cruise_sailings`),
    itinerary_stops: count(`SELECT COUNT(*) AS n FROM cruise_sailing_itinerary`),
    sources: count(`SELECT COUNT(*) AS n FROM cruise_sailing_sources`),
    import_runs: count(`SELECT COUNT(*) AS n FROM cruise_import_runs`),
    route_object_eligible: count(
      `SELECT COUNT(*) AS n FROM cruise_sailings WHERE route_object_eligible = 1`
    ),
    distinct_canonical_keys: count(`SELECT COUNT(DISTINCT canonical_key) AS n FROM cruise_sailings`),
    migrations: db.prepare(`SELECT name, applied_at FROM schema_migrations ORDER BY applied_at`).all()
  };
}

module.exports = {
  loadResolverCaches,
  writeCanonicalSailing,
  importProviderRows,
  getDbStatistics,
  storageCanonicalKey,
  priceSafeFingerprint,
  resolveLineId,
  resolveShipId
};
