#!/usr/bin/env node
/**
 * Read-only Princess Cruises official source probe.
 *   node scripts/probe-princess-discovery.mjs
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { probePrincessInventory } = require(path.join(root, "netlify/functions/lib/princess-discovery-source"));
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
  const countsBefore = {
    discovered_cruises: await headCount("discovered_cruises"),
    hal_active: await headCount(
      "discovered_cruises",
      "cruise_line_id=eq.a8d0e678-0cb2-4ea7-ad73-251f0eb36ea2&status=eq.active"
    )
  };

  const lines = await sb.get(
    "ci_cruise_lines?slug=eq.princess-cruises&select=id,name,slug,website_url,cruise_search_url&limit=1"
  );
  const line = lines?.[0];
  if (!line) throw new Error("Princess Cruises line not found");

  const ships = await sb.get(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id`
  );
  const destRows = await sb.get(
    "destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled"
  );

  const probe = await probePrincessInventory({
    seedUrl: line.cruise_search_url || line.website_url || "https://www.princess.com/cruise-search/",
    maxLinks: 30,
    maxProducts: 100
  });
  const simulation = simulateProbeProducts({
    products: probe.products,
    cruiseLine: line,
    ships: ships || [],
    destinations: catalogueDestinations(destRows || [])
  });

  const countsAfter = {
    discovered_cruises: await headCount("discovered_cruises"),
    hal_active: await headCount(
      "discovered_cruises",
      "cruise_line_id=eq.a8d0e678-0cb2-4ea7-ad73-251f0eb36ea2&status=eq.active"
    )
  };

  console.log(
    JSON.stringify(
      {
        phase: "princess_readonly_probe",
        read_only: true,
        source: probe.source,
        investigation: probe.investigation,
        discovered_urls: probe.discovered_urls,
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
