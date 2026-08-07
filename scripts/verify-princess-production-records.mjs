#!/usr/bin/env node
/**
 * Verify Princess production records + Cruise Finder visibility.
 *
 *   node scripts/verify-princess-production-records.mjs
 *   node scripts/verify-princess-production-records.mjs --expected-active=120
 *   node scripts/verify-princess-production-records.mjs --expected-active=120 --expected-snapshot-id=<id>
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createSupabaseRest, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { publicBookingMinimumDepartureDate, perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const siteUrl = String(
  process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app"
).replace(/\/$/, "");

function parseArgs(argv) {
  const out = { expectedActive: null, expectedSnapshotId: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--expected-active=")) out.expectedActive = Number(arg.split("=")[1]);
    if (arg.startsWith("--expected-snapshot-id=")) {
      out.expectedSnapshotId = String(arg.split("=")[1]).trim();
    }
  }
  return out;
}

function loadEnv() {
  try {
    const dotenv = require("dotenv");
    dotenv.config({ path: path.join(root, ".env") });
    dotenv.config({ path: path.join(root, ".env.local") });
  } catch {
    /* optional */
  }
}

loadEnv();

async function searchCurrentCruises(body) {
  const response = await fetch(`${siteUrl}/.netlify/functions/search-current-cruises`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { ok: false, rawPreview: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const minDep = publicBookingMinimumDepartureDate(perthCalendarDate());
  const rows = await sb.get(
    `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active&select=id,cruise_line_id,ship_id,destination_id,departure_date,departure_port,official_url,official_sailing_id,raw_extract&order=departure_date.asc`
  );
  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${PRINCESS_LINE_ID}&select=id,name,official_line_ship_id`
  );
  const shipById = Object.fromEntries(ships.map((s) => [s.id, s]));
  const ecr = rows.filter((r) => String(r.official_sailing_id || "").startsWith("ECR12A|CB|"));
  const issues = [];

  const expectedActive = args.expectedActive != null ? args.expectedActive : null;
  const delta = expectedActive != null ? rows.length - expectedActive : null;

  if (expectedActive != null && rows.length !== expectedActive) {
    issues.push({ issue: "active_count", expected: expectedActive, actual: rows.length, delta });
  }
  if (ecr.length) issues.push({ issue: "rolled_back_ecr12a_present", count: ecr.length });

  const identities = new Set();
  for (const row of rows) {
    if (!row.cruise_line_id) issues.push({ id: row.id, issue: "null_cruise_line_id" });
    if (row.cruise_line_id !== PRINCESS_LINE_ID) issues.push({ id: row.id, issue: "wrong_line" });
    if (!row.official_sailing_id) issues.push({ id: row.id, issue: "missing_identity" });
    if (identities.has(row.official_sailing_id)) {
      issues.push({ id: row.id, issue: "duplicate_identity", sid: row.official_sailing_id });
    }
    identities.add(row.official_sailing_id);
    if (String(row.departure_date).slice(0, 10) < minDep) {
      issues.push({ id: row.id, issue: "inside_cutoff", departure_date: row.departure_date });
    }
    const ship = shipById[row.ship_id];
    if (!ship?.official_line_ship_id) issues.push({ id: row.id, issue: "missing_official_line_ship_id" });
    if (!row.official_url || !String(row.official_url).includes("princess.com")) {
      issues.push({ id: row.id, issue: "invalid_official_url" });
    }
  }

  const finderChecks = [];
  const scenarios = [
    { label: "alaska-princess", body: { destination: "alaska", cruiseLines: ["Princess"] } },
    {
      label: "royal-princess",
      body: { destination: "alaska", cruiseLines: ["Princess"] },
      shipMatch: /royal princess/i
    },
    {
      label: "coral-princess",
      body: { destination: "alaska", cruiseLines: ["Princess"] },
      shipMatch: /coral princess/i
    },
    {
      label: "grand-princess",
      body: { destination: "alaska", cruiseLines: ["Princess"] },
      shipMatch: /grand princess/i
    },
    { label: "seattle", body: { destination: "alaska", cruiseLines: ["Princess"], departure: "seattle" } },
    { label: "vancouver", body: { destination: "alaska", cruiseLines: ["Princess"], departure: "vancouver" } },
    {
      label: "sept-2026",
      body: {
        destination: "alaska",
        cruiseLines: ["Princess"],
        timingMode: "month",
        month: 9,
        year: 2026
      }
    }
  ];

  for (const scenario of scenarios) {
    const result = await searchCurrentCruises(scenario.body);
    const sailings = [
      ...(result.body?.results || []),
      ...(result.body?.alsoWorthConsidering || []),
      ...(result.body?.otherResults || [])
    ];
    const princessHits = sailings.filter((s) => /princess/i.test(String(s.cruiseLine || "")));
    const matched = scenario.shipMatch
      ? princessHits.filter((s) => scenario.shipMatch.test(String(s.ship || "")))
      : princessHits;
    finderChecks.push({
      scenario: scenario.label,
      status: result.status,
      ok: result.body?.ok === true,
      search_failed: result.body?.error === "search_failed" || result.body?.ok === false,
      total: sailings.length,
      princess_hits: matched.length,
      sample: matched.slice(0, 2).map((s) => ({
        ship: s.ship,
        departure: s.departureDate,
        port: s.departurePort
      }))
    });
    if (result.body?.error === "search_failed") {
      issues.push({ issue: "cruise_finder_search_failed", scenario: scenario.label });
    }
    if (scenario.label !== "alaska-princess" && matched.length === 0 && result.body?.ok === true) {
      issues.push({ issue: "expected_princess_hits_missing", scenario: scenario.label });
    }
  }

  const halProbe = await searchCurrentCruises({
    destination: "alaska",
    cruiseLines: ["Holland America"]
  });
  const celProbe = await searchCurrentCruises({
    destination: "caribbean",
    cruiseLines: ["Celebrity"]
  });

  const halSailings = halProbe.body?.results || [];
  const celSailings = celProbe.body?.results || [];

  const report = {
    db_verification: {
      expected_active: expectedActive,
      actual_active: rows.length,
      delta,
      expected_snapshot_id: args.expectedSnapshotId || null,
      min_departure: minDep,
      ecr12a_remaining: ecr.length,
      issues
    },
    cruise_finder: finderChecks,
    hal_available: halSailings.length > 0,
    celebrity_available: celSailings.length > 0,
    ok:
      issues.length === 0 &&
      (expectedActive == null || rows.length === expectedActive) &&
      finderChecks.some((c) => c.scenario === "alaska-princess" && c.princess_hits > 0)
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
