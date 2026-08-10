#!/usr/bin/env node
/**
 * Explora Journeys read-only inventory simulation.
 * Never writes to discovered_cruises — it only reads the official catalogue plus reference data.
 *
 *   npm run simulate:explora-discovery
 *   node scripts/simulate-explora-discovery.mjs --max-journeys=50 --concurrency=8
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/explora-discovery-adapter"));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const {
  partitionByPublicBookingCutoff,
  perthCalendarDate
} = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { buildExploraBatchManifest } = require(path.join(
  root,
  "netlify/functions/lib/explora-discovery-writes"
));

const REPORT_DIR = path.join(root, "reports");
const EXPLORA_LINE_SLUG = "explora-journeys";

function parseArgs(argv) {
  const args = { maxJourneys: null, concurrency: 8, today: null, report: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--max-journeys=")) args.maxJourneys = Number(arg.split("=")[1]);
    if (arg.startsWith("--concurrency=")) args.concurrency = Number(arg.split("=")[1]);
    if (arg.startsWith("--today=")) args.today = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--report=")) args.report = String(arg.split("=")[1]).trim();
  }
  return args;
}

function topEntries(counts, limit = 25) {
  return Object.fromEntries(
    Object.entries(counts || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const today = args.today || perthCalendarDate();

  const rest = createSupabaseRest(root);
  const supabase = async (query) => rest.get(query);

  const line = (
    await supabase(`ci_cruise_lines?slug=eq.${EXPLORA_LINE_SLUG}&select=id,name,slug,website_url&limit=1`)
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${EXPLORA_LINE_SLUG}`);

  const destRows = await loadClassificationDestinations(supabase);
  const destinations = adapter.catalogueDestinations(destRows || []);
  const ships = await supabase(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&active=eq.true&select=id,name,cruise_line_id,official_line_ship_id,ship_class`
  );

  const simulation = await adapter.simulateExploraInventory({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today,
    concurrency: args.concurrency,
    maxJourneys: args.maxJourneys
  });

  const { publiclyEligible, withinCutoff } = partitionByPublicBookingCutoff(
    simulation.products || [],
    (p) => p.candidate?.departure_date,
    today
  );
  const eligible = publiclyEligible.filter(
    (p) => p.complete_high_confidence && adapter.isEligibleExploraCruise(p.product_type)
  );

  const manifest = await buildExploraBatchManifest({
    products: publiclyEligible,
    cruiseLine: line,
    destinations,
    supabase,
    runId: `explora-simulate-${startedAt}`
  });

  const proposedInserts = manifest.products.filter((p) => p.proposed_action === "insert_active");
  const proposedUpdates = manifest.products.filter((p) => p.proposed_action === "update_exact_legacy_match");
  const unchanged = manifest.products.filter((p) => p.proposed_action === "duplicate_skip");

  const report = {
    mode: "simulation",
    writes_performed: 0,
    read_only: true,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    today,
    line: { id: line.id, slug: line.slug, name: line.name },
    source_contract: simulation.source_contract,
    source_audit: simulation.source_audit,
    counts: {
      official_sitemap_journeys: simulation.num_found_official,
      future_journeys_fetched: simulation.raw_journey_count,
      ocean_cruises: simulation.metrics.ocean_cruises,
      non_cruise_excluded: simulation.metrics.non_cruise_excluded,
      complete_high_confidence: simulation.metrics.complete_high_confidence,
      within_public_cutoff_excluded: withinCutoff.length,
      publicly_eligible_complete: eligible.length,
      proposed_inserts: proposedInserts.length,
      proposed_updates: proposedUpdates.length,
      recognised_existing_eligible: unchanged.length
    },
    resolution: {
      ship_resolution_pct: simulation.metrics.ship_resolution_pct,
      departure_port_resolution_pct: simulation.metrics.departure_port_resolution_pct,
      destination_resolution_pct: simulation.metrics.destination_resolution_pct,
      identity_coverage_pct: simulation.metrics.identity_coverage_pct
    },
    detail_failures: (() => {
      const failures = simulation.fetch_result?.detail_failures || [];
      const byError = {};
      for (const failure of failures) {
        const key = failure.error || "unknown";
        byError[key] = (byError[key] || 0) + 1;
      }
      return { count: failures.length, by_error: byError, sample: failures.slice(0, 10) };
    })(),
    failure_counts: topEntries(simulation.metrics.failure_counts),
    destination_counts: topEntries(simulation.metrics.destination_counts),
    unresolved: {
      ships: simulation.metrics.unresolved_ships,
      departure_ports: simulation.metrics.unresolved_departure_ports,
      destinations: simulation.metrics.unresolved_destinations
    },
    sample_eligible: eligible.slice(0, 10).map((p) => ({
      official_sailing_id: p.official_sailing_id,
      ship: p.ship_resolution?.ship?.name || null,
      departure_date: p.candidate.departure_date,
      return_date: p.candidate.return_date,
      nights: p.candidate.nights,
      departure_port: p.candidate.departure_port,
      destination: p.destination_resolution?.destinationKey,
      itinerary: p.candidate.itinerary,
      official_url: p.candidate.official_url
    }))
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = args.report || `explora-discovery-simulation-${startedAt.replace(/[:.]/g, "-")}.json`;
  const reportPath = path.join(REPORT_DIR, filename);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  report.report_path = reportPath;

  console.log(JSON.stringify(report, null, 2));
  if (!simulation.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
