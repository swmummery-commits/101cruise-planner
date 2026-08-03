#!/usr/bin/env node
/**
 * Read-only Celebrity Cruises official source probe.
 *   node scripts/probe-celebrity-discovery.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { probeCelebrityInventory } = require(path.join(root, "netlify/functions/lib/celebrity-discovery-source"));
const { simulateProbeProducts } = require(path.join(root, "netlify/functions/lib/discovery-source-simulation"));
const { catalogueDestinations } = require(path.join(root, "netlify/functions/lib/holland-america-discovery-adapter"));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

async function headCount(table, query = "") {
  const https = require("https");
  const { getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
  const { url, key } = getSupabaseConfig(root);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${table}?select=id${query ? `&${query}` : ""}`);
    https
      .request(
        u,
        { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } },
        (res) => {
          const range = res.headers["content-range"] || "";
          const m = range.match(/\/(\d+)/);
          resolve(m ? Number(m[1]) : 0);
        }
      )
      .on("error", reject)
      .end();
  });
}

async function main() {
  const sb = createSupabaseRest(root);
  const lines = await sb.get(
    "ci_cruise_lines?slug=eq.celebrity-cruises&select=id,name,slug,website_url&limit=1"
  );
  const line = lines?.[0];
  if (!line) throw new Error("Celebrity Cruises line not found");

  const countsBefore = {
    discovered_cruises: await headCount("discovered_cruises"),
    line_active: await headCount(
      "discovered_cruises",
      `cruise_line_id=eq.${encodeURIComponent(line.id)}&status=eq.active`
    )
  };

  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id`
  );
  const destRows = await sb.get(
    "destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled"
  );

  const probe = await probeCelebrityInventory({ maxPages: 4, pageSize: 25, maxProducts: 100 });
  const simulation = simulateProbeProducts({
    products: probe.products,
    cruiseLine: line,
    ships: ships || [],
    destinations: catalogueDestinations(destRows || [])
  });

  const countsAfter = {
    discovered_cruises: await headCount("discovered_cruises"),
    line_active: await headCount(
      "discovered_cruises",
      `cruise_line_id=eq.${encodeURIComponent(line.id)}&status=eq.active`
    )
  };

  console.log(
    JSON.stringify(
      {
        phase: "celebrity_readonly_probe",
        read_only: true,
        source: probe.source,
        total_official: probe.total_official,
        page_log: probe.page_log,
        sample_stats: probe.stats,
        simulation,
        counts_before: countsBefore,
        counts_after: countsAfter,
        database_unchanged: JSON.stringify(countsBefore) === JSON.stringify(countsAfter)
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
