#!/usr/bin/env node
/**
 * Seabourn read-only inventory simulation (Prompt 2 / 2B).
 *
 *   npm run simulate:seabourn-discovery
 *   node scripts/simulate-seabourn-discovery.mjs --today=2026-08-13
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/seabourn-discovery-adapter"));
const source = require(path.join(root, "netlify/functions/lib/seabourn-discovery-source"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

const REPORT_DIR = path.join(root, "reports");
const LINE_SLUG = "seabourn-cruise-line";

function parseArgs(argv) {
  const args = { today: null, report: null, skipEnrichment: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--today=")) args.today = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--report=")) args.report = String(arg.split("=")[1]).trim();
    if (arg === "--skip-enrichment") args.skipEnrichment = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const today = args.today || perthCalendarDate();

  adapter.clearSeabournFetchCache();
  source.clearSeabournFetchCache();

  const rest = createSupabaseRest(root);
  const supabase = async (query) => rest.get(query);

  const line = (await supabase(`ci_cruise_lines?slug=eq.${LINE_SLUG}&select=id,name,slug,website_url,cruise_search_url&limit=1`))?.[0];
  if (!line) throw new Error(`Cruise line not found: ${LINE_SLUG}`);

  const ships = await supabase(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id,active&order=name.asc`
  );
  const destRows = await supabase("destinations?select=id,name,slug,status");
  const destinations = adapter.catalogueDestinations(destRows || []);

  process.stderr.write("Fetching official Seabourn sbncruisesearch API (read-only)…\n");

  const simulation = await adapter.simulateSeabournDiscovery({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today,
    supabaseQuery: supabase,
    runEnrichment: !args.skipEnrichment
  });

  const dateDiagnostic = adapter.buildDateDiagnostic(
    simulation.products.map((p) => ({ departure_date: p.candidate?.departure_date })),
    today
  );

  const shipResolution = (simulation.products || [])
    .reduce((acc, row) => {
      const name = row.raw?.ship_name;
      if (!name || acc.has(name)) return acc;
      acc.set(name, {
        source_ship: name,
        source_code: row.raw?.ship_code,
        db_ship: row.ship_resolution?.ship?.name || null,
        method: row.ship_resolution?.method || row.ship_resolution?.reason || "unresolved",
        resolution_tier: row.ship_resolution?.resolution_tier || row.ship_resolution?.method,
        resolved: row.ship_resolution?.resolved === true,
        fuzzy_dependent: row.ship_resolution?.method === "unique_fuzzy"
      });
      return acc;
    }, new Map());

  const primaryExclusionCounts = simulation.products.reduce((acc, row) => {
    const key = row.eligibility?.primary_exclusion_reason || (row.eligibility?.production_eligible ? "production_eligible" : "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const confidenceOutcomeCounts = simulation.products.reduce((acc, row) => {
    const key = row.confidence?.outcome || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const report = {
    generated_at: startedAt,
    ended_at: new Date().toISOString(),
    mode: "seabourn_read_only_simulation",
    prompt: "2B",
    writes_performed: 0,
    read_only: true,
    dry_run_guard: "NO_PRODUCTION_WRITES",
    today,
    line: { id: line.id, slug: line.slug, name: line.name },
    source_contract: simulation.source_contract,
    date_diagnostic: dateDiagnostic,
    catalogue: {
      endpoint: simulation.source_contract.primary_endpoint,
      num_found: simulation.num_found_official,
      raw_rows_fetched: simulation.raw_rows_fetched,
      exact_solr_duplicates_removed: simulation.exact_solr_duplicates_removed,
      product_key_suppressed_rows: simulation.product_key_suppressed_rows,
      source_row_accounting: simulation.source_row_accounting,
      unique_source_products: simulation.unique_source_products,
      api_calls: simulation.api_calls,
      pagination: simulation.pagination,
      earliest_departure: simulation.earliest_departure,
      latest_departure: simulation.latest_departure,
      source_ships: simulation.source_ships
    },
    eligibility: simulation.eligibility,
    eligibility_by_product_type: simulation.eligibility_by_product_type,
    eligibility_by_ship: simulation.eligibility_by_ship,
    embarkation_ports: simulation.embarkation_ports,
    identity: simulation.identity,
    overlap: simulation.overlap,
    ports: simulation.ports,
    destinations: simulation.destinations,
    ship_resolution: [...shipResolution.values()],
    enrichment: simulation.enrichment,
    itinerary_info_probe: simulation.itinerary_info_probe,
    production_reconciliation: simulation.production_reconciliation,
    primary_exclusion_counts: primaryExclusionCounts,
    confidence_outcome_counts: confidenceOutcomeCounts,
    blocking_vs_non_blocking: {
      blocking: {
        embark_port_unresolved: simulation.eligibility?.waterfall?.required_embark_port_unresolved || 0,
        ship_unresolved: simulation.eligibility?.waterfall?.required_ship_unresolved || 0,
        destination_unresolved: simulation.eligibility?.waterfall?.required_destination_unresolved || 0
      },
      non_blocking: {
        unresolved_itinerary_ports: simulation.ports?.unresolved_probable_physical_ports?.length || 0,
        scenic_or_transit: simulation.ports?.scenic_or_transit?.length || 0,
        enrichment_gaps: "detail pages lack day-level times (see enrichment section)"
      }
    }
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = args.report || `seabourn-discovery-simulation-${startedAt.replace(/[:.]/g, "-")}.json`;
  const reportPath = path.join(REPORT_DIR, filename);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const summary = {
    report_path: reportPath,
    as_of: today,
    num_found: report.catalogue.num_found,
    unique_products: report.catalogue.unique_source_products,
    source_row_reconciles: report.catalogue.source_row_accounting?.reconciles,
    eligible: report.eligibility.eligible_source_products,
    within_21_day: report.eligibility.within_21_day_exclusions,
    outstanding_inserts: report.production_reconciliation?.outstanding_eligible_inserts ?? null,
    waterfall_reconciles: report.eligibility.arithmetic?.reconciles
  };

  console.log(JSON.stringify(summary, null, 2));
  console.log("Full report:", reportPath);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
