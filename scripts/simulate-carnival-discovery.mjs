#!/usr/bin/env node
/**
 * Carnival Cruise Line read-only inventory simulation (Prompt 2).
 *
 *   npm run simulate:carnival-discovery
 *   node scripts/simulate-carnival-discovery.mjs --today=2026-08-15
 *
 * Structurally read-only — no write helpers are invoked.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/carnival-discovery-adapter"));
const source = require(path.join(root, "netlify/functions/lib/carnival-discovery-source"));
const { evaluateMaintenanceQualityGate } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

const REPORT_DIR = path.join(root, "reports");
const LINE_SLUG = "carnival-cruise-line";

function parseArgs(argv) {
  const args = { today: null, report: null, maxApiCalls: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--today=")) args.today = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--report=")) args.report = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--max-api-calls=")) args.maxApiCalls = Number(arg.split("=")[1]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const today = args.today || perthCalendarDate();

  adapter.clearCclFetchCache();
  source.clearCarnivalFetchCache();

  const rest = createSupabaseRest(root);
  const supabase = async (query) => rest.get(query);

  const line = (await supabase(`ci_cruise_lines?slug=eq.${LINE_SLUG}&select=id,name,slug,website_url,cruise_search_url&limit=1`))?.[0];
  if (!line) throw new Error(`Cruise line not found: ${LINE_SLUG}`);

  const [ships, shipAliases, destRows] = await Promise.all([
    supabase(
      `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id,active&order=name.asc`
    ),
    supabase(`cruise_ship_aliases?cruise_line_id=eq.${line.id}&select=id,ship_id,raw_alias,normalised_alias`),
    supabase("destinations?select=id,name,slug,status")
  ]);
  const destinations = adapter.catalogueDestinations(destRows || []);

  process.stderr.write("Fetching official Carnival AU cruisesearch API (read-only)…\n");

  const simulation = await adapter.simulateCclDiscovery({
    cruiseLine: line,
    ships: ships || [],
    shipAliases: shipAliases || [],
    destinations,
    today,
    maxApiCalls: args.maxApiCalls || source.DEFAULT_MAX_API_CALLS
  });

  const qualityGate = evaluateMaintenanceQualityGate({
    lineSlug: LINE_SLUG,
    metrics: simulation.quality_gate_metrics,
    previousEligible: null,
    manifest: { products: [] },
    dryRun: true
  });

  const qualityGateReport = {
    ship_resolution: simulation.quality_gate_metrics.ship_resolution_pct >= 98 ? "PASS" : "FAIL",
    port_resolution: simulation.quality_gate_metrics.departure_port_resolution_pct >= 95 ? "PASS" : "FAIL",
    destination_resolution: simulation.quality_gate_metrics.destination_resolution_pct >= 90 ? "PASS" : "FAIL",
    identity_integrity: simulation.quality_gate_metrics.identity_coverage_pct >= 100 ? "PASS" : "FAIL",
    duplicate_official_identities:
      (simulation.quality_gate_metrics.duplicate_official_identities || 0) === 0 ? "PASS" : "FAIL",
    malformed_record_safeguards:
      simulation.integrity.missing_sailing_ids === 0 &&
      simulation.integrity.identity_collisions === 0
        ? "PASS"
        : "FAIL",
    validation_result:
      (simulation.validation_failures?.reference_ready_not_discovery_ready || 0) === 0
        ? "PASS"
        : "FAIL",
    overall_passed: qualityGate.passed,
    failures: qualityGate.failures
  };

  const report = {
    mode: simulation.mode,
    writes_performed: false,
    read_only: true,
    generated_at: startedAt,
    as_of_date: today,
    source: {
      source_id: source.SOURCE_ID,
      host: simulation.fetch_result.host,
      endpoint: simulation.fetch_result.endpoint,
      requested_page_size: simulation.fetch_result.page_size,
      api_calls: simulation.fetch_result.api_calls,
      total_results_initial: simulation.fetch_result.initial_total_results,
      total_results_final: simulation.fetch_result.final_total_results,
      total_results_drift: simulation.fetch_result.total_results_drift,
      groups_received: simulation.fetch_result.raw_group_count,
      unique_groups: simulation.fetch_result.unique_group_count,
      duplicate_groups: simulation.fetch_result.duplicate_group_count,
      source_warnings: simulation.fetch_result.source_warnings,
      pagination: simulation.fetch_result.pagination
    },
    sailing_expansion: simulation.expansion,
    date_eligibility: simulation.eligibility,
    ships: simulation.ships,
    ports: simulation.ports,
    destinations: simulation.destinations,
    candidate_integrity: simulation.integrity,
    readiness_funnel: simulation.readiness_funnel,
    validation_failures: simulation.validation_failures,
    overall: simulation.overall,
    quality_gate: qualityGateReport,
    quality_gate_metrics: simulation.quality_gate_metrics,
    remediation_rankings: simulation.remediation_rankings,
    trust_decision:
      "ccl_cruisesearch_api registered in carnival-structured-source-trust.js; simulation resolves references without requiring structured trust for read-only mode."
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = args.report || `carnival-discovery-simulation-${startedAt.replace(/[:.]/g, "-")}.json`;
  const reportPath = path.join(REPORT_DIR, filename);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const summary = {
    report_path: reportPath,
    as_of: today,
    groups: report.source.unique_groups,
    raw_expanded_sailings: report.sailing_expansion.raw_expanded_sailings,
    unique_sailing_ids: report.sailing_expansion.unique_sailing_ids,
    eligible_22_plus: report.readiness_funnel?.cutoff_eligible ?? null,
    reference_ready: report.readiness_funnel?.all_required_references_resolved ?? null,
    validation_ready: report.readiness_funnel?.validation_passed ?? null,
    discovery_ready: report.readiness_funnel?.discovery_ready ?? null,
    within_21_day: report.date_eligibility.within_21_day_exclusions,
    ship_resolution_pct: Number(report.ships.resolution_percentage.toFixed(2)),
    port_resolution_pct: Number(report.ports.resolution_percentage.toFixed(2)),
    destination_resolution_pct: Number(report.destinations.resolution_percentage.toFixed(2)),
    quality_gate_passed: qualityGateReport.overall_passed
  };

  console.log(JSON.stringify(summary, null, 2));
  console.log("Full report:", reportPath);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
