#!/usr/bin/env node
/**
 * Read-only Royal Caribbean International catalogue probe.
 *
 *   node scripts/probe-royal-caribbean-discovery.mjs
 *
 * Enumerates the public GraphQL catalogue, samples itinerary pages,
 * and optionally compares against existing 101cruise inventory (GET only).
 * Never writes to Supabase.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const source = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-source"));

const OUTPUT = path.join(root, "reports/royal-caribbean-prompt1-discovery.json");
const USER_AGENT = source.USER_AGENT;

function loadEnv() {
  try {
    const envPath = path.join(root, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    /* optional */
  }
}

async function fetchItineraryPage(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
      },
      redirect: "follow"
    });
    const html = await res.text();
    const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || null;
    const description =
      html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/content=["']([^"']+)["']\s+name=["']description["']/i)?.[1] ||
      null;
    return {
      ok: res.status === 200,
      status: res.status,
      ms: Date.now() - started,
      title,
      description,
      bytes: html.length
    };
  } catch (error) {
    return { ok: false, status: 0, error: error.message, ms: Date.now() - started };
  }
}

function pickSamples(products) {
  const byKey = new Map();
  const add = (p, reason) => {
    if (!p?.official_sailing_id || byKey.has(p.official_sailing_id)) return;
    byKey.set(p.official_sailing_id, { ...p, sample_reason: reason });
  };
  const sorted = [...products].sort((a, b) => String(a.departure_date).localeCompare(String(b.departure_date)));
  add(sorted.find((p) => p.nights <= 4), "short_cruise");
  add(sorted.find((p) => p.nights >= 7 && p.nights <= 10), "week_cruise");
  add(sorted.find((p) => p.nights >= 12), "long_cruise");
  const dests = new Set();
  for (const p of sorted) {
    if (p.destination_code && !dests.has(p.destination_code) && dests.size < 3) {
      dests.add(p.destination_code);
      add(p, `destination_${p.destination_code}`);
    }
  }
  const ships = new Set();
  for (const p of sorted) {
    if (p.ship_code && !ships.has(p.ship_code) && ships.size < 4) {
      ships.add(p.ship_code);
      add(p, `ship_${p.ship_code}`);
    }
  }
  add(sorted.find((p) => p.round_trip === false), "one_way");
  return [...byKey.values()].slice(0, 8);
}

function portsFromDescription(description) {
  if (!description) return [];
  const visits = description.match(/visits\s+(.+?)\.\s+Explore/i)?.[1];
  if (!visits) return [];
  return visits.split(";").map((s) => s.trim()).filter(Boolean);
}

async function inspectDatabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, reason: "supabase_env_missing" };
  }
  const { createSupabaseRest, exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
  const sb = createSupabaseRest(root);

  const lines = await sb.get(
    "ci_cruise_lines?select=id,name,slug,website_url,active&or=(slug.ilike.*royal*caribbean*,name.ilike.*royal*caribbean*)&order=name.asc"
  );
  const primary =
    (lines || []).find((l) => l.slug === "royal-caribbean-international") ||
    (lines || []).find((l) => /royal caribbean international/i.test(l.name)) ||
    (lines || [])[0] ||
    null;
  if (!primary) return { ok: true, lines: lines || [], primary: null, active_count: 0 };

  const ships = await sb.fetchAll(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(primary.id)}&select=id,name,active,official_line_ship_id&order=name.asc`
  );
  const aliases = await sb
    .get(
      `cruise_ship_aliases?cruise_line_id=eq.${encodeURIComponent(primary.id)}&select=id,ship_id,raw_alias,normalised_alias,active&limit=500`
    )
    .catch(() => []);

  const activeCount = await exactCountSupabase(
    root,
    "discovered_cruises",
    `cruise_line_id=eq.${encodeURIComponent(primary.id)}&status=eq.active`
  );
  const allStatusCount = await exactCountSupabase(
    root,
    "discovered_cruises",
    `cruise_line_id=eq.${encodeURIComponent(primary.id)}`
  );

  const active = await sb.fetchAll(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(primary.id)}&status=eq.active&select=id,ship_id,departure_date,return_date,nights,departure_port,itinerary,official_url,official_sailing_id,status&order=departure_date.asc`
  );

  const dates = (active || []).map((r) => r.departure_date).filter(Boolean).sort();
  const dbShips = new Map();
  for (const ship of ships || []) dbShips.set(ship.id, ship);
  const represented = new Map();
  const ports = new Map();
  for (const row of active || []) {
    const ship = dbShips.get(row.ship_id);
    const name = ship?.name || "(unmatched ship)";
    represented.set(name, (represented.get(name) || 0) + 1);
    const port = String(row.departure_port || "").trim() || "(blank)";
    ports.set(port, (ports.get(port) || 0) + 1);
  }

  return {
    ok: true,
    read_only: true,
    method: "GET",
    lines: (lines || []).map((l) => ({ id: l.id, name: l.name, slug: l.slug, active: l.active })),
    primary_line: { id: primary.id, name: primary.name, slug: primary.slug },
    active_count: activeCount.count,
    all_status_count: allStatusCount.count,
    earliest_active_departure: dates[0] || null,
    latest_active_departure: dates[dates.length - 1] || null,
    ships: (ships || []).map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
      official_line_ship_id: s.official_line_ship_id
    })),
    ships_represented_in_active_inventory: [...represented.entries()].map(([name, count]) => ({ name, count })),
    departure_ports_in_active_inventory: [...ports.entries()].map(([name, count]) => ({ name, count })),
    ship_alias_count: (aliases || []).length,
    ship_aliases: (aliases || []).slice(0, 50)
  };
}

function compareSourceToDatabase(stats, db) {
  if (!db?.ok || !db.primary_line) return { compared: false };
  const sourceShips = new Set((stats.ships || []).map((n) => n.toLowerCase()));
  const dbShips = new Set((db.ships || []).map((s) => String(s.name || "").toLowerCase()));
  const sourceOnly = [...sourceShips].filter((n) => !dbShips.has(n));
  const dbOnly = [...dbShips].filter((n) => !sourceShips.has(n));
  const sourcePorts = new Set((stats.departure_ports || []).map((n) => n.toLowerCase()));
  const dbPorts = new Set((db.departure_ports_in_active_inventory || []).map((p) => p.name.toLowerCase()));
  return {
    compared: true,
    source_unique_ships: stats.unique_ships,
    db_catalogue_ships: db.ships.length,
    db_active_cruises: db.active_count,
    source_future_voyages: stats.future_voyages,
    ships_in_source_missing_from_db_catalogue: sourceOnly,
    ships_in_db_catalogue_missing_from_source: dbOnly,
    likely_port_mismatches: [...dbPorts].filter((p) => p !== "(blank)" && ![...sourcePorts].some((s) => s.includes(p) || p.includes(s))).slice(0, 30)
  };
}

async function main() {
  loadEnv();
  const started = Date.now();
  console.error("Fetching Royal Caribbean GraphQL catalogue (read-only)...");

  const fleet = await source.fetchRoyalCaribbeanFleet();
  const fetched = await source.fetchAllRoyalCaribbeanRawSailings({
    pageSize: 50,
    maxPages: null,
    requestDelayMs: 200,
    futureOnly: false
  });
  const stats = source.summariseRoyalCaribbeanSailings(fetched.raw_sailings, {
    today: fetched.today
  });

  const samples = pickSamples(fetched.raw_sailings.filter((p) => p.complete && p.official_url));
  const websiteChecks = [];
  for (const sample of samples) {
    const page = await fetchItineraryPage(sample.official_url);
    const describedPorts = portsFromDescription(page.description);
    const sourcePorts = (sample.itinerary_ports || []).map((p) => p.name);
    websiteChecks.push({
      official_sailing_id: sample.official_sailing_id,
      sample_reason: sample.sample_reason,
      ship: sample.ship_name,
      departure_date: sample.departure_date,
      nights: sample.nights,
      departure_port: sample.departure_port,
      destination: sample.destination_name,
      destination_code: sample.destination_code,
      round_trip: sample.round_trip,
      itinerary_ports: sourcePorts,
      official_url: sample.official_url,
      website_status: page.status,
      website_title: page.title,
      website_description: page.description,
      website_ports: describedPorts,
      ship_matches_title: page.title ? new RegExp(sample.ship_name.replace(/ of the seas/i, ""), "i").test(page.title) || /royal caribbean/i.test(page.title) : false,
      nights_match_title: page.title ? page.title.toLowerCase().includes(`${sample.nights} night`) : false,
      departure_port_in_title: page.title ? page.title.toLowerCase().includes(String(sample.departure_port || "").toLowerCase()) : false
    });
    await source.sleep(250);
  }

  let database = { ok: false, reason: "not_attempted" };
  try {
    database = await inspectDatabase();
  } catch (error) {
    database = { ok: false, reason: error.message };
  }

  const report = {
    generated_at: new Date().toISOString(),
    read_only: true,
    inventory_writes_performed: false,
    source: source.SOURCE_CONTRACT,
    fetch: {
      ok: fetched.ok,
      total_official_groups: fetched.total_official,
      groups_fetched: fetched.itinerary_groups_fetched,
      pagination_requests: fetched.pagination_requests,
      page_log: fetched.page_log,
      ingestion_audit: fetched.ingestion_audit
    },
    fleet: {
      ok: fleet.ok,
      count: fleet.ships?.length || 0,
      ships: fleet.ships || []
    },
    catalogue: stats,
    samples: websiteChecks,
    database,
    source_vs_database: compareSourceToDatabase(stats, database),
    elapsed_ms: Date.now() - started
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    ok: fetched.ok && stats.unique_voyages > 0,
    output: OUTPUT,
    total_official_groups: fetched.total_official,
    unique_voyages: stats.unique_voyages,
    future_voyages: stats.future_voyages,
    eligible_after_21_days: stats.publicly_eligible_after_21_day_cutoff,
    within_21_days: stats.within_21_day_window,
    earliest: stats.earliest_departure,
    latest: stats.latest_departure,
    ships: stats.unique_ships,
    departure_ports: stats.unique_departure_ports,
    destinations: stats.unique_destinations,
    fleet_ships: fleet.ships?.length || 0,
    db_active: database.active_count ?? null,
    samples: websiteChecks.length,
    elapsed_ms: report.elapsed_ms
  }, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
