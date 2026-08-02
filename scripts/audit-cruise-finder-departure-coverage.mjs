#!/usr/bin/env node
/**
 * Audit discovered_cruises departure_port coverage for Cruise Finder.
 * Run with Supabase env vars for live counts; otherwise prints offline guidance.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/audit-cruise-finder-departure-coverage.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const { summariseDepartureCoverage, loadPortsCatalogue } = require(path.join(
  root,
  "netlify/functions/lib/cruise-finder-departure-match.js"
));

async function supabaseGet(tableQuery) {
  const base = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;

  const url = `${base}/rest/v1/${tableQuery}`;
  const response = await fetch(url, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const ports = loadPortsCatalogue();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("audit-cruise-finder-departure-coverage: offline mode");
    console.log("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for live inventory counts.");
    console.log(`Ports catalogue loaded: ${ports.length} canonical ports`);
    return;
  }

  const rows = await supabaseGet(
    `discovered_cruises?status=eq.active&departure_date=gte.${today}` +
      `&select=id,departure_port,departure_date,destination_id&limit=5000`
  );

  const stats = summariseDepartureCoverage(rows, ports);
  console.log("Cruise Finder departure coverage audit (active sailings, departure_date >= today)");
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
