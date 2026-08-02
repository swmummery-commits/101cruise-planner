#!/usr/bin/env node
/**
 * Read-only Holland America Line Discovery simulation.
 *
 *   npm run simulate:discovery-hal
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  simulateHalDiscovery,
  catalogueDestinations,
  clearHalFetchCache,
  SOURCE_CONTRACT
} = require(path.join(root, "netlify/functions/lib/holland-america-discovery-adapter"));

async function main() {
  clearHalFetchCache();
  const sb = createSupabaseRest(root);
  const [lines, ships, destRows] = await Promise.all([
    sb.get("ci_cruise_lines?slug=eq.holland-america-line&select=id,name,slug,website_url,cruise_search_url"),
    sb.get("ci_cruise_ships?active=eq.true&select=id,name,cruise_line_id"),
    sb.get("destinations?select=id,name,slug,status")
  ]);
  const line = lines?.[0];
  if (!line) throw new Error("Holland America Line not found in ci_cruise_lines");

  const lineShips = (ships || []).filter((s) => s.cruise_line_id === line.id);
  const destinations = catalogueDestinations(destRows);

  process.stderr.write("Fetching official HAL cruise search API (read-only)…\n");
  const result = await simulateHalDiscovery({
    cruiseLine: line,
    ships: lineShips,
    destinations
  });

  const report = {
    generated_at: new Date().toISOString(),
    mode: "holland_america_discovery_simulation",
    writes_performed: false,
    source_contract: SOURCE_CONTRACT,
    cruise_line: line.name,
    summary: {
      official_source: SOURCE_CONTRACT.primary_endpoint,
      api_calls: result.api_calls || result.page_log?.length,
      num_found_official: result.num_found_official,
      raw_api_records: result.raw_api_records,
      unique_official_products: result.unique_official_products,
      product_type_cruise: result.product_type_cruise,
      product_type_cruisetour: result.product_type_cruisetour,
      product_type_unknown: result.product_type_unknown,
      genuine_cruise_products: result.genuine_cruise_products,
      complete_high_confidence: result.complete_high_confidence,
      incomplete_cruise: result.incomplete_cruise,
      duplicates_suppressed: result.duplicates_suppressed,
      transpacific_crossing_products: result.transpacific_crossing_products,
      transpacific_resolved_count: result.transpacific_resolved_count,
      ship_match_rate_pct: result.ship_match_rate_pct,
      departure_date_rate_pct: result.departure_date_rate_pct,
      departure_port_rate_pct: result.departure_port_rate_pct,
      destination_resolution_rate_pct: result.destination_resolution_rate_pct,
      projected_activations: result.projected_activations,
      projected_aggregated_maintenance: result.projected_aggregated_maintenance,
      projected_steve_reviews: result.projected_steve_reviews,
      estimated_full_inventory: result.estimated_full_inventory,
      ingestion_audit: result.ingestion_audit,
      acceptance_gate: result.acceptance_gate
    },
    destination_counts: result.destination_counts,
    failure_reason_counts: result.failure_reason_counts,
    unknown_ships: result.unknown_ships,
    examples: result.examples
  };

  const outPath = path.join(root, "reports/holland-america-discovery-simulation.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report.summary, null, 2));
  console.log("Report:", outPath);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
