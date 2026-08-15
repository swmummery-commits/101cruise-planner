#!/usr/bin/env node
/**
 * Silversea read-only Gatsby catalogue dry-run.
 * Never writes to discovered_cruises.
 *
 *   npm run simulate:silversea-discovery
 *   node scripts/simulate-silversea-discovery.mjs --concurrency=4
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

const REPORT_DIR = path.join(root, "reports");
const LINE_SLUG = adapter.LINE_SLUG;

function parseArgs(argv) {
  const args = {
    concurrency: 4,
    today: null,
    report: null,
    enrich: true,
    maxVoyages: null
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--concurrency=")) args.concurrency = Number(arg.split("=")[1]);
    if (arg.startsWith("--today=")) args.today = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--report=")) args.report = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--max-voyages=")) args.maxVoyages = Number(arg.split("=")[1]);
    if (arg === "--skip-detail") args.enrich = false;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const today = args.today || perthCalendarDate();

  const rest = createSupabaseRest(root);
  const supabase = async (query) => rest.get(query);

  const line = (
    await supabase(`ci_cruise_lines?slug=eq.${LINE_SLUG}&select=id,name,slug,website_url&limit=1`)
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${LINE_SLUG}`);

  const destRows = await loadClassificationDestinations(supabase);
  const destinations = adapter.catalogueDestinations(destRows || []);
  const ships = await supabase(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const existingRows = await supabase(
    `discovered_cruises?cruise_line_id=eq.${line.id}&select=id,status,official_sailing_id,official_url,source_url,departure_date,review_reason`
  );

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    existingRows: existingRows || [],
    today,
    concurrency: args.concurrency,
    enrich: args.enrich,
    maxVoyages: args.maxVoyages
  });

  const stamp = startedAt.replace(/[:.]/g, "-");
  const reportName = args.report || `silversea-phase2-dry-run-${stamp}.json`;
  const reportPath = path.isAbsolute(reportName) ? reportName : path.join(REPORT_DIR, reportName);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const report = {
    generated_at: startedAt,
    finished_at: new Date().toISOString(),
    writes: false,
    weekly_maintenance: "not_enabled",
    production_silversea_inserts: 0,
    production_silversea_updates: 0,
    production_silversea_deletes: 0,
    today,
    line,
    existing_production_rows: (existingRows || []).map((row) => ({
      id: row.id,
      status: row.status,
      official_sailing_id: row.official_sailing_id,
      official_url: row.official_url,
      review_reason: row.review_reason
    })),
    summary: simulation.summary,
    nights_rule: simulation.nights_rule,
    health: simulation.health,
    unresolved_ships: simulation.unresolved_ships,
    unresolved_ports: simulation.unresolved_ports,
    unresolved_destinations: simulation.unresolved_destinations,
    duration_mismatches: simulation.duration_mismatches,
    catalogue_detail_discrepancies: simulation.catalogue_detail_discrepancies,
    observed_ship_prefixes: simulation.observed_ship_prefixes,
    source_contract: simulation.source_contract,
    eligible_complete_sample: (simulation.publicly_eligible || [])
      .filter((n) => n.complete_high_confidence)
      .slice(0, 20)
      .map((n) => ({
        official_sailing_id: n.official_sailing_id,
        ship: n.ship_resolution.ship?.name || n.raw.ship_name,
        departure_date: n.candidate.departure_date,
        return_date: n.candidate.return_date,
        nights: n.candidate.nights,
        embark: n.candidate.departure_port,
        disembark: n.arrival_port_resolution.canonicalPortName || n.raw.arrival_port,
        destination: n.destination_resolution.destinationKey,
        cruise_type: n.raw.cruise_type,
        code_kind: n.raw.code_kind
      }))
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report_path: reportPath, summary: simulation.summary, health: simulation.health }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
