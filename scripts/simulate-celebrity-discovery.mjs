#!/usr/bin/env node
/**
 * Full read-only Celebrity Discovery inventory simulation.
 *   node scripts/simulate-celebrity-discovery.mjs
 *   node scripts/simulate-celebrity-discovery.mjs --output=reports/celebrity-readonly-simulation.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const {
  simulateCelebrityInventory,
  auditCelebrityShips,
  auditCelebrityPorts,
  catalogueDestinations
} = require(path.join(root, "netlify/functions/lib/celebrity-discovery-adapter"));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

function parseArgs(argv) {
  const args = { output: path.join(root, "reports/celebrity-readonly-simulation.json") };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length);
  }
  return args;
}

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

async function captureCounts(today, halLineId) {
  return {
    discovered_cruises: await headCount("discovered_cruises"),
    active_cruises: await headCount("discovered_cruises", "status=eq.active"),
    active_future: await headCount(
      "discovered_cruises",
      `status=eq.active&or=(departure_date.is.null,departure_date.gte.${today})`
    ),
    hal_active: await headCount("discovered_cruises", `cruise_line_id=eq.${halLineId}&status=eq.active`),
    pending_review: await headCount("cruise_discovery_review_items", "status=eq.pending"),
    total_review: await headCount("cruise_discovery_review_items"),
    ship_aliases: await headCount("cruise_ship_aliases"),
    destination_aliases: await headCount("cruise_destination_aliases"),
    destinations: await headCount("destinations"),
    destination_ports: await headCount("destination_ports"),
    discovery_runs: await headCount("cruise_discovery_runs")
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createSupabaseRest(root);
  const today = new Date().toISOString().slice(0, 10);

  const line = (
    await sb.get("ci_cruise_lines?slug=eq.celebrity-cruises&select=id,name,slug&limit=1")
  )?.[0];
  const halLine = (
    await sb.get("ci_cruise_lines?slug=eq.holland-america-line&select=id&limit=1")
  )?.[0];
  if (!line) throw new Error("Celebrity Cruises line not found");

  const countsBefore = await captureCounts(today, halLine?.id);

  const [ships, destRows] = await Promise.all([
    sb.get(`ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&active=eq.true&select=id,name,cruise_line_id`),
    sb.get("destinations?classification_enabled=eq.true&select=id,name,slug,status,classification_enabled")
  ]);

  const simulation = await simulateCelebrityInventory({
    cruiseLine: line,
    ships: ships || [],
    destinations: catalogueDestinations(destRows || []),
    today
  });

  const shipAudit = auditCelebrityShips(simulation.products, ships || []);
  const portAudit = auditCelebrityPorts(simulation.products);

  const countsAfter = await captureCounts(today, halLine?.id);

  const report = {
    phase: "celebrity_full_readonly_simulation",
    read_only: true,
    writes_blocked: true,
    generated_at: new Date().toISOString(),
    official_reported_total: simulation.official_reported_total,
    itinerary_groups_fetched: simulation.itinerary_groups_fetched,
    sailing_products_fetched: simulation.sailing_products_fetched,
    pagination_requests: simulation.pagination_requests,
    ingestion_audit: simulation.ingestion_audit,
    sample_stats: simulation.sample_stats,
    cruise_metrics: simulation.cruise_metrics,
    destination_distribution: simulation.destination_distribution,
    ship_distribution: simulation.ship_distribution,
    departure_port_distribution: simulation.departure_port_distribution,
    ship_audit: shipAudit,
    port_audit: portAudit,
    counts_before: countsBefore,
    counts_after: countsAfter,
    database_unchanged: JSON.stringify(countsBefore) === JSON.stringify(countsAfter)
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(report, null, 2));

  console.log(
    JSON.stringify(
      {
        output: args.output,
        sailing_products: simulation.sailing_products_fetched,
        metrics: simulation.cruise_metrics,
        ship_unmatched: shipAudit.unmatched.length,
        ports_unresolved: portAudit.length,
        database_unchanged: report.database_unchanged
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
