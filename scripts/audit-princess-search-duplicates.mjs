#!/usr/bin/env node
/**
 * Read-only Princess / shared public-search duplicate audit.
 * Run: node scripts/audit-princess-search-duplicates.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { perthCalendarDate, publicBookingMinimumDepartureDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

const SITE_URL = String(process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app").replace(
  /\/$/,
  ""
);

function auditKey(s) {
  return `${s.cruiseLine}|${s.ship}|${s.departureDateIso}|${s.departurePort}`.toLowerCase();
}

function canonicalKey(s) {
  return `${s.cruiseLine}|${s.ship}|${s.departureDateIso}`.toLowerCase();
}

function officialKey(s) {
  return String(s.officialSailingId || s.official_sailing_id || "").toLowerCase();
}

async function searchProduction(body) {
  const response = await fetch(`${SITE_URL}/.netlify/functions/search-current-cruises`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  const sailings = [...(parsed.results || []), ...(parsed.alsoWorthConsidering || []), ...(parsed.otherResults || [])];
  return { status: response.status, body: parsed, sailings };
}

function groupByKey(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

async function fetchPrincessAlaskaDb(sb) {
  const dest = await sb("destinations?slug=eq.alaska&select=id,name,slug&limit=1");
  const destinationId = dest?.[0]?.id;
  const princessLine = await sb("ci_cruise_lines?name=ilike.*Princess*&select=id,name&limit=5");
  const lineId = princessLine?.find((l) => /princess/i.test(l.name) && !/seabourn/i.test(l.name))?.id;
  const perthToday = perthCalendarDate();
  const minDeparture = publicBookingMinimumDepartureDate(perthToday);

  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await sb(
      `discovered_cruises?destination_id=eq.${encodeURIComponent(destinationId)}` +
        `&cruise_line_id=eq.${encodeURIComponent(lineId)}` +
        `&status=eq.active` +
        `&departure_date=gte.${minDeparture}` +
        `&select=id,official_sailing_id,external_key,cruise_line_id,ship_id,departure_date,return_date,nights,departure_port,itinerary,status,source_url,official_url` +
        `&order=departure_date.asc&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }

  const shipIds = [...new Set(rows.map((r) => r.ship_id).filter(Boolean))];
  const shipNames = new Map();
  if (shipIds.length) {
    const ships = await sb(`ci_cruise_ships?id=in.(${shipIds.join(",")})&select=id,name`);
    for (const s of ships || []) shipNames.set(s.id, s.name);
  }

  return {
    destinationId,
    lineId,
    rows: rows.map((r) => ({ ...r, ship_name: shipNames.get(r.ship_id) || null }))
  };
}

function classifyDbGroup(group) {
  const officialIds = new Set(group.map((r) => r.official_sailing_id).filter(Boolean));
  const externalKeys = new Set(group.map((r) => r.external_key).filter(Boolean));
  const dbIds = new Set(group.map((r) => r.id));
  if (group.length <= 1) return { classification: "SINGLE", officialIds: [...officialIds], dbIds: [...dbIds] };
  if (officialIds.size === 1 && group.length > 1) {
    return { classification: "TRUE_DB_DUPLICATE", officialIds: [...officialIds], dbIds: [...dbIds], externalKeys: [...externalKeys] };
  }
  if (externalKeys.size === 1 && group.length > 1) {
    return { classification: "TRUE_DB_DUPLICATE", officialIds: [...officialIds], dbIds: [...dbIds], externalKeys: [...externalKeys] };
  }
  return {
    classification: "DISTINCT_VALID_VOYAGES",
    officialIds: [...officialIds],
    dbIds: [...dbIds],
    externalKeys: [...externalKeys],
    nights: group.map((r) => r.nights),
    itineraries: group.map((r) => r.itinerary)
  };
}

async function auditScenario(label, body, lineFilter, sb) {
  const result = await searchProduction(body);
  const hits = result.sailings.filter((s) =>
    lineFilter ? new RegExp(lineFilter, "i").test(String(s.cruiseLine || "")) : true
  );

  const byAuditKey = groupByKey(hits, auditKey);
  const duplicateGroups = [...byAuditKey.entries()].filter(([, items]) => items.length > 1);

  const byCanonical = groupByKey(hits, canonicalKey);
  const canonicalCollisions = [...byCanonical.entries()].filter(([, items]) => items.length > 1);

  return {
    label,
    http_status: result.status,
    ok: result.body?.ok === true,
    total_sailings: result.sailings.length,
    filtered_hits: hits.length,
    catalogue_status: result.body?.catalogueStatus,
    total_in_catalogue: result.body?.totalInCatalogue,
    matched_count: result.body?.matchedCount,
    apparent_duplicate_groups_audit_key: duplicateGroups.length,
    apparent_duplicate_rows_audit_key: duplicateGroups.reduce((n, [, g]) => n + g.length - 1, 0),
    canonical_collision_groups: canonicalCollisions.length,
    duplicate_groups: duplicateGroups.map(([key, items]) => ({
      audit_key: key,
      count: items.length,
      items: items.map((s) => ({
        cruiseLine: s.cruiseLine,
        ship: s.ship,
        departureDate: s.departureDate,
        departureDateIso: s.departureDateIso,
        departurePort: s.departurePort,
        durationNights: s.durationNights,
        itineraryTitle: s.itineraryTitle,
        sourceUrl: s.sourceUrl
      }))
    })),
    canonical_collisions: canonicalCollisions.map(([key, items]) => ({
      canonical_key: key,
      count: items.length,
      items: items.map((s) => ({
        departurePort: s.departurePort,
        durationNights: s.durationNights,
        itineraryTitle: s.itineraryTitle,
        sourceUrl: s.sourceUrl
      }))
    }))
  };
}

async function main() {
  const sb = createMaintenanceSupabase(root);
  const scenarios = [
    { label: "princess_alaska", body: { destination: "alaska", cruiseLines: ["Princess"] }, filter: "Princess" },
    { label: "princess_caribbean", body: { destination: "caribbean", cruiseLines: ["Princess"] }, filter: "Princess" },
    { label: "ncl_alaska", body: { destination: "alaska", cruiseLines: ["Norwegian"] }, filter: "Norwegian" },
    {
      label: "royal_caribbean_caribbean",
      body: { destination: "caribbean", cruiseLines: ["Royal Caribbean"] },
      filter: "Royal Caribbean"
    }
  ];

  const production = [];
  for (const s of scenarios) {
    production.push(await auditScenario(s.label, s.body, s.filter, sb));
  }

  const db = await fetchPrincessAlaskaDb(sb);
  const dbByOfficial = groupByKey(db.rows, (r) => String(r.official_sailing_id || "").toLowerCase());
  const dbByExternal = groupByKey(db.rows, (r) => String(r.external_key || "").toLowerCase());
  const dbByCanonical = groupByKey(
    db.rows,
    (r) => `${r.ship_name}|${r.departure_date}|${String(r.departure_port || "").toLowerCase()}`
  );

  const trueDbDuplicates = {
    by_official_sailing_id: [...dbByOfficial.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([k, g]) => ({ key: k, count: g.length, ids: g.map((r) => r.id) })),
    by_external_key: [...dbByExternal.entries()]
      .filter(([k, g]) => k && g.length > 1)
      .map(([k, g]) => ({ key: k, count: g.length, ids: g.map((r) => r.id) })),
    by_ship_date_port: [...dbByCanonical.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([k, g]) => ({
        key: k,
        count: g.length,
        classification: classifyDbGroup(g),
        rows: g.map((r) => ({
          id: r.id,
          official_sailing_id: r.official_sailing_id,
          external_key: r.external_key,
          nights: r.nights,
          itinerary: r.itinerary,
          departure_port: r.departure_port
        }))
      }))
  };

  const princessAlaska = production.find((p) => p.label === "princess_alaska");
  const dbAuditGroups = [];
  for (const group of princessAlaska?.duplicate_groups || []) {
    for (const item of group.items) {
      const matches = db.rows.filter(
        (r) =>
          r.ship_name === item.ship &&
          r.departure_date === item.departureDateIso &&
          String(r.departure_port || "").toLowerCase() === String(item.departurePort || "").toLowerCase()
      );
      dbAuditGroups.push({
        audit_key: group.audit_key,
        public_items: group.items.length,
        db_matches: matches.length,
        classification: classifyDbGroup(matches.length ? matches : [{ id: "none" }]),
        db_rows: matches
      });
    }
    break;
  }

  const uniqueDbAudit = [];
  const seen = new Set();
  for (const group of princessAlaska?.duplicate_groups || []) {
    const first = group.items[0];
    const matchKey = `${first.ship}|${first.departureDateIso}|${first.departurePort}`.toLowerCase();
    if (seen.has(matchKey)) continue;
    seen.add(matchKey);
    const matches = db.rows.filter(
      (r) =>
        r.ship_name === first.ship &&
        r.departure_date === first.departureDateIso &&
        String(r.departure_port || "").toLowerCase() === String(first.departurePort || "").toLowerCase()
    );
    uniqueDbAudit.push({
      audit_key: group.audit_key,
      public_count: group.count,
      db_match_count: matches.length,
      ...classifyDbGroup(matches)
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    site_url: SITE_URL,
    production,
    princess_alaska_db: {
      active_rows: db.rows.length,
      true_db_duplicate_groups: trueDbDuplicates,
      apparent_public_group_db_audit: uniqueDbAudit
    }
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
