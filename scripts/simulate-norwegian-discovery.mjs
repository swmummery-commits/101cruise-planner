#!/usr/bin/env node
/**
 * Norwegian read-only inventory simulation (Phase 2).
 *
 *   npm run simulate:norwegian-discovery
 *   node scripts/simulate-norwegian-discovery.mjs --today=2026-08-13 --skip-enrichment
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

const REPORT_DIR = path.join(root, "reports");
const LINE_SLUG = "norwegian-cruise-line";

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

  const rest = createSupabaseRest(root);
  const supabase = async (query) => rest.get(query);

  const line = (await supabase(`ci_cruise_lines?slug=eq.${LINE_SLUG}&select=id,name,slug,website_url,cruise_search_url&limit=1`))?.[0];
  if (!line) throw new Error(`Cruise line not found: ${LINE_SLUG}`);

  const ships = await supabase(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,active,official_line_ship_id&order=name.asc`
  );

  process.stderr.write("Fetching official NCL browse v1 catalogue (read-only)…\n");

  const simulation = await adapter.simulateNorwegianDiscovery({
    cruiseLine: line,
    ships: ships || [],
    today,
    supabaseQuery: supabase,
    runEnrichment: !args.skipEnrichment
  });

  const failureReasonCounts = simulation.products.reduce((acc, row) => {
    for (const reason of row.failure_reasons || []) acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});

  const report = {
    generated_at: startedAt,
    ended_at: new Date().toISOString(),
    mode: "norwegian_read_only_simulation",
    writes_performed: 0,
    read_only: true,
    dry_run_guard: "NO_PRODUCTION_WRITES",
    today,
    line: { id: line.id, slug: line.slug, name: line.name },
    source_contract: simulation.source_contract,
    source_timestamp: simulation.source_timestamp,
    catalogue: {
      browse_record_count: simulation.browse_record_count,
      raw_sailing_count: simulation.raw_sailing_count,
      ocean_sailing_count: simulation.ocean_sailing_count,
      publicly_eligible_ocean_sailings_shared_cutoff: simulation.publicly_eligible_ocean_sailings_shared_cutoff,
      within_cutoff_ocean_sailings_shared_cutoff: simulation.within_cutoff_ocean_sailings_shared_cutoff,
      earliest_departure: simulation.earliest_departure,
      latest_departure: simulation.latest_departure
    },
    classification: simulation.classification,
    eligibility: simulation.eligibility,
    identity_all: simulation.identity_all,
    identity_ocean: simulation.identity_ocean,
    ship_mappings: simulation.ship_mappings,
    port_analysis: simulation.port_analysis,
    embark_port_audit: simulation.embark_port_audit,
    blocked_voyage_analysis: simulation.blocked_voyage_analysis,
    port_of_call_enrichment: simulation.port_of_call_enrichment,
    enrichment: simulation.enrichment,
    production_reconciliation: simulation.production_reconciliation,
    failure_reason_counts: failureReasonCounts
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = args.report || `norwegian-discovery-simulation-${startedAt.replace(/[:.]/g, "-")}.json`;
  const reportPath = path.join(REPORT_DIR, filename);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const summary = {
    report_path: reportPath,
    as_of: today,
    browse_records: report.catalogue.browse_record_count,
    raw_sailings: report.catalogue.raw_sailing_count,
    ocean_sailings: report.catalogue.ocean_sailing_count,
    eligible_ocean: report.eligibility.publicly_eligible_ocean_sailings,
    import_ready_ocean: report.eligibility.import_ready_ocean_sailings,
    within_21_day: report.eligibility.within_21_day_exclusions,
    cruisetour_excluded: report.eligibility.cruisetour_or_package_exclusions,
    ambiguous: report.eligibility.ambiguous_itineraries,
    identity_ocean_collisions: report.identity_ocean.official_key_collisions.length,
    ship_mappings_resolved: report.ship_mappings.resolved_count,
    blocked_publicly_eligible: report.blocked_voyage_analysis?.publicly_eligible_blocked ?? null,
    outstanding_inserts: report.production_reconciliation?.outstanding_eligible_inserts ?? null,
    arithmetic_reconciles: report.eligibility.arithmetic.reconciles
  };

  console.log(JSON.stringify(summary, null, 2));
  console.log("Full report:", reportPath);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
