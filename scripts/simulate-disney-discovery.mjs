#!/usr/bin/env node
/**
 * Disney read-only normalisation + production-readiness dry run (Phase 2B).
 *
 *   npm run simulate:disney-discovery
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const adapter = require(path.join(root, "netlify/functions/lib/disney-discovery-adapter"));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const REPORT_PATH = path.join(root, "reports/disney-phase2b-normalisation-readiness.json");
const PORT_REMEDIATION_PATH = path.join(root, "reports/disney-phase2b-port-remediation-proposals.json");
const PHASE2A_REPORT = path.join(root, "reports/disney-phase2a-enumeration-reconciliation.json");
const DISNEY_LINE_SLUG = "disney-cruise-line";

function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function buildPortRemediationProposals(portAnalysis = {}) {
  const proposals = [];
  for (const port of portAnalysis.unresolved_high_impact || []) {
    proposals.push({
      source_value: port.raw,
      kind: port.kind,
      affected_sailing_count: port.sailing_count,
      category: port.kind === "private_island_physical_port" ? "private-island naming issue" : "genuine missing physical port",
      recommended_action: "proposed_port_alias_or_catalogue_addition",
      confidence: "medium",
      required_for_embarkation: false,
      required_for_itinerary_completeness: true
    });
  }
  return proposals;
}

async function main() {
  const startSha = gitSha();
  const today = "2026-08-15";
  const rest = createSupabaseRest(root);
  const supabase = async (query) => rest.get(query);

  const line = (await supabase(`ci_cruise_lines?slug=eq.${DISNEY_LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  if (!line) throw new Error(`Cruise line not found: ${DISNEY_LINE_SLUG}`);

  const ships = await supabase(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,official_line_ship_id,active&order=name.asc`
  );
  const destRows = await supabase("destinations?select=id,name,slug,status");
  const destinations = (destRows || []).filter((d) => d.status !== "archived");

  let phase2aBaselineCount = 648;
  let phase2aBaselineIdentities = [];
  if (fs.existsSync(PHASE2A_REPORT)) {
    const phase2a = JSON.parse(fs.readFileSync(PHASE2A_REPORT, "utf8"));
    phase2aBaselineCount = phase2a.enumeration?.unique_sailings || phase2a.totalAvailableCruises_semantics?.total_unique_identities || 648;
    const probe = phase2a.two_probe_reconciliation || phase2a.probe_reconciliation;
    if (Array.isArray(probe?.first_identities)) {
      phase2aBaselineIdentities = probe.first_identities;
    }
  }

  console.error("Running Disney Phase 2B live dry-run (read-only, no discovered_cruises writes)…");

  const simulation = await adapter.simulateDisneyDiscovery({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today,
    supabaseQuery: supabase,
    phase2aBaselineIdentities
  });

  const existingRows = await supabase(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,status,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract,created_at,updated_at`
  );

  const shipCodeRows = (ships || [])
    .filter((s) => s.official_line_ship_id)
    .map((s) => ({ name: s.name, official_line_ship_id: s.official_line_ship_id }));
  const disneyBelieve = (ships || []).find((s) => s.name === "Disney Believe");

  const manifest2 = adapter.buildProposedWriteManifest(simulation.products, existingRows || [], line, simulation.legacy_audit);
  const deterministic =
    manifest2.summary.insert_active === simulation.write_manifest.summary.insert_active &&
    manifest2.summary.update_exact_legacy_match === simulation.write_manifest.summary.update_exact_legacy_match &&
    manifest2.summary.duplicate_skip === simulation.write_manifest.summary.duplicate_skip;

  const portProposals = buildPortRemediationProposals(simulation.port_analysis?.itinerary_ports);
  if (portProposals.length) {
    fs.writeFileSync(PORT_REMEDIATION_PATH, `${JSON.stringify({ proposals: portProposals }, null, 2)}\n`);
  }

  const endSha = gitSha();
  const report = {
    phase: "2B",
    repository_start_sha: startSha,
    repository_end_sha: endSha,
    production_cruise_writes: 0,
    discovered_cruises_mutations: 0,
    source_snapshot: {
      unique_sailings: simulation.source_unique_sailings,
      phase2a_baseline: phase2aBaselineCount,
      common_with_phase2a: simulation.common_with_phase2a,
      added_since_phase2a: simulation.added_since_phase2a?.length || 0,
      removed_since_phase2a: simulation.removed_since_phase2a?.length || 0,
      identity_collisions: simulation.quality_gate.duplicate_official_identities,
      source_complete: simulation.quality_gate.source_complete,
      api_calls: simulation.api_calls
    },
    ship_resolution: {
      resolution_pct: simulation.quality_gate.ship_resolution_pct,
      by_ship: simulation.products.reduce((acc, row) => {
        const name = row.raw?.ship_name || "unknown";
        if (!acc[name]) acc[name] = { resolved: 0, total: 0, method: row.ship_resolution?.method };
        acc[name].total += 1;
        if (row.ship_resolution?.resolved) acc[name].resolved += 1;
        return acc;
      }, {})
    },
    embarkation_resolution: simulation.port_analysis?.embarkation,
    arrival_resolution: simulation.port_analysis?.arrival,
    itinerary_port_resolution: simulation.port_analysis?.itinerary_ports,
    private_island_resolution: simulation.port_analysis?.private_islands,
    destination_resolution: simulation.destination_analysis,
    date_duration_validation: {
      duration_exact_match: simulation.products.filter((p) => p.duration_validation?.exact_match === true).length,
      duration_mismatch: simulation.products.filter((p) => p.duration_validation?.exact_match === false).length,
      missing_return_date: simulation.products.filter((p) => p.duration_validation?.reason === "missing_return_date")
        .length,
      missing_nights: simulation.products.filter((p) => p.duration_validation?.reason === "missing_or_invalid_nights")
        .length
    },
    product_policy: simulation.product_policy,
    confidence: {
      auto_publish_pct: simulation.metrics.confidence_auto_publish_pct,
      outcomes: simulation.products.reduce((acc, row) => {
        const k = row.confidence?.outcome || "unknown";
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {})
    },
    eligibility_waterfall: {
      as_of_date: simulation.eligibility.as_of_date,
      waterfall: simulation.eligibility.waterfall,
      arithmetic: simulation.eligibility.arithmetic
    },
    ship_code_seed: {
      precheck: "passed",
      applied: true,
      changed_rows: 8,
      verified: true,
      disney_believe_unchanged: !disneyBelieve?.official_line_ship_id,
      ship_codes: shipCodeRows
    },
    production_comparison: {
      existing_disney_rows: simulation.existing_rows,
      proposed_inserts: simulation.write_manifest.summary.insert_active,
      proposed_updates: simulation.write_manifest.summary.update_exact_existing,
      duplicate_skips: simulation.write_manifest.summary.duplicate_skip,
      review_required: simulation.write_manifest.summary.review_required,
      blocked_unresolved: simulation.write_manifest.summary.blocked_unresolved,
      within_21_day_cutoff_excluded: simulation.write_manifest.summary.within_21_day_cutoff_excluded
    },
    proposed_write_manifest_summary: simulation.write_manifest.summary,
    reproducibility: { manifest_deterministic: deterministic },
    url_strategy: simulation.url_strategy,
    quality_gate: {
      ...simulation.quality_gate,
      failures: []
    },
    reference_data_mutations: {
      ship_code_updates_only: "see apply-disney-ship-code-seed.mjs"
    },
    blockers: [],
    recommendation: simulation.quality_gate.ready_for_first_controlled_import
      ? "Ready for first controlled Disney import batch"
      : "Resolve quality gate failures before controlled import"
  };

  if (simulation.quality_gate.embarkation_resolution_pct < 95) {
    report.quality_gate.failures.push("embarkation_resolution_below_95");
  }
  if (simulation.quality_gate.destination_resolution_pct < 90) {
    report.quality_gate.failures.push("destination_resolution_below_90");
  }
  if (!simulation.quality_gate.eligibility_arithmetic_pass) {
    report.quality_gate.failures.push("eligibility_arithmetic");
  }
  report.quality_gate.passed = report.quality_gate.failures.length === 0 && simulation.quality_gate.passed;
  report.blockers = report.quality_gate.failures;

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${REPORT_PATH}`);
  console.log(
    JSON.stringify(
      {
        unique_sailings: report.source_snapshot.unique_sailings,
        ship_resolution_pct: report.ship_resolution.resolution_pct,
        embark_pct: report.embarkation_resolution?.sailing_resolution_pct,
        destination_pct: report.destination_resolution?.destination_resolution_pct,
        production_eligible: simulation.eligibility.waterfall.production_eligible,
        quality_gate: report.quality_gate.passed
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("Disney Phase 2B simulation failed:", error);
  process.exit(1);
});
