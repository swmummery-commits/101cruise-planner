#!/usr/bin/env node
/**
 * Disney Phase 2C — legacy reconciliation + pre-production dry run.
 *
 *   npm run simulate:disney-phase2c
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

const REPORT_PATH = path.join(root, "reports/disney-phase2c-preproduction-reconciliation.json");
const DISNEY_LINE_SLUG = "disney-cruise-line";

function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
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

  const existingRows = await supabase(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,status,ship_id,departure_date,return_date,nights,departure_port,destination_id,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract,created_at,updated_at&order=created_at.asc`
  );

  console.error("Running Disney Phase 2C reconciliation dry-run (read-only)…");

  const simulation = await adapter.simulateDisneyDiscovery({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today,
    existingRows: existingRows || [],
    supabaseQuery: supabase
  });

  const manifest1 = simulation.write_manifest;
  const manifest2 = adapter.buildProposedWriteManifest(
    simulation.products,
    existingRows || [],
    line,
    simulation.legacy_audit
  );
  const deterministic =
    manifest2.summary.insert_active === manifest1.summary.insert_active &&
    manifest2.summary.update_exact_legacy_match === manifest1.summary.update_exact_legacy_match &&
    manifest2.summary.duplicate_skip === manifest1.summary.duplicate_skip;

  const halloweenRows = simulation.products.filter((r) => r.raw?.product_id === "7_mexican_riviera_halloween");

  const endSha = gitSha();
  const report = {
    phase: "2C",
    repository_start_sha: startSha,
    repository_end_sha: endSha,
    discovered_cruises_writes: 0,
    discovered_cruises_mutations: 0,
    source_snapshot: {
      unique_sailings: simulation.source_unique_sailings,
      identity_collisions: simulation.quality_gate.duplicate_official_identities,
      complete: simulation.quality_gate.source_complete
    },
    legacy_rows: {
      ...simulation.legacy_audit,
      rows: simulation.legacy_audit.rows.map((row) => {
        const existing = (existingRows || []).find((r) => r.id === row.existing_id);
        return { ...row, existing_status: existing?.status || null, existing_url: existing?.official_url || null };
      })
    },
    embark_fix: {
      affected_product: "7_mexican_riviera_halloween",
      affected_sailings: halloweenRows.length,
      exact_titles: [...new Set(halloweenRows.map((r) => r.raw?.product_name).filter(Boolean))],
      proven_embark_port: halloweenRows[0]?.candidate?.departure_port || null,
      parser_change: "parseDisneyProductTitleEndpoints matches ' Cruise from <port>' after themed segments",
      resolved_after_fix: halloweenRows.every((r) => r.candidate?.departure_port_meta?.status === "resolved")
    },
    port_reference_remediation: {
      castaway_cay: { source: "Disney Castaway Cay", action: "canonical_port_create_castaway_cay" },
      lookout_cay: { source: "Disney Lookout Cay at Lighthouse Point", action: "canonical_port_create_lookout_cay" },
      progreso: { source: "Progreso, Mexico", action: "canonical_port_create_progreso" },
      catalina: { source: "Catalina Island, California", action: "canonical_port_create_catalina_island" },
      portland_stonehenge: { source: "Portland (Stonehenge), England", action: "alias_to_portland_england" },
      panama_canal: { source: "Panama Canal", action: "classify_scenic_non_port" },
      chania: { source: "Chania, Greece", action: "canonical_port_create_chania" },
      mutations_performed: "see apply-disney-port-reference-data.mjs manifest"
    },
    resolution_after_remediation: {
      ship_pct: simulation.quality_gate.ship_resolution_pct,
      embark_pct: simulation.port_analysis?.embarkation?.sailing_resolution_pct,
      arrival_pct: simulation.port_analysis?.arrival?.arrival_resolved_count
        ? Math.round((simulation.port_analysis.arrival.arrival_resolved_count / simulation.source_unique_sailings) * 10000) / 100
        : 0,
      itinerary_physical_port_pct: simulation.port_analysis?.itinerary_ports?.physical_port_resolution_pct,
      destination_pct: simulation.destination_analysis?.destination_resolution_pct,
      duration_pct: simulation.quality_gate.duration_validation_pct
    },
    eligibility_waterfall: simulation.eligibility,
    production_manifest: {
      ...manifest1.summary,
      deterministic
    },
    duplicate_safety: simulation.duplicate_safety,
    first_controlled_batch: simulation.first_controlled_batch,
    quality_gate: {
      passed: false,
      ready_for_first_controlled_batch: false,
      failures: []
    },
    blockers: [],
    recommendation: ""
  };

  const failures = [];
  if (simulation.quality_gate.embarkation_resolution_pct < 99.69) failures.push("embarkation_below_phase2b_baseline");
  if (simulation.quality_gate.ship_resolution_pct < 100) failures.push("ship_resolution");
  if (simulation.quality_gate.destination_resolution_pct < 100) failures.push("destination_resolution");
  if (!simulation.quality_gate.eligibility_arithmetic_pass) failures.push("eligibility_arithmetic");
  if (!deterministic) failures.push("manifest_not_deterministic");
  if (!simulation.duplicate_safety.passed) failures.push("duplicate_safety");
  if (!simulation.legacy_audit.safe) failures.push("legacy_ambiguity");
  if (simulation.first_controlled_batch.size > 20) failures.push("first_batch_over_20");

  report.quality_gate.failures = failures;
  report.quality_gate.passed = failures.length === 0;
  report.quality_gate.ready_for_first_controlled_batch =
    report.quality_gate.passed && simulation.quality_gate.ready_for_first_controlled_import;
  report.blockers = failures;
  report.recommendation = report.quality_gate.ready_for_first_controlled_batch
    ? "Ready to execute first controlled INSERT-only batch of 20 Disney sailings"
    : "Resolve blockers before first controlled import";

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${REPORT_PATH}`);
  console.log(
    JSON.stringify(
      {
        unique_sailings: report.source_snapshot.unique_sailings,
        embark_pct: report.resolution_after_remediation.embark_pct,
        inserts: report.production_manifest.insert_active,
        legacy_updates: report.production_manifest.update_exact_legacy_match,
        duplicate_safety: report.duplicate_safety.passed,
        quality_gate: report.quality_gate.passed
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("Disney Phase 2C simulation failed:", error);
  process.exit(1);
});
