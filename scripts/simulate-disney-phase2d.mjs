#!/usr/bin/env node
/**
 * Disney Phase 2D — endpoint evidence correction + pre-write freeze.
 *
 *   npm run simulate:disney-phase2d
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

const REPORT_PATH = path.join(root, "reports/disney-phase2d-endpoint-prewrite-validation.json");
const PHASE2C_REPORT = path.join(root, "reports/disney-phase2c-preproduction-reconciliation.json");
const PHASE2C_BATCH_HASH = "obsolete-phase2c-no-hash";
const DISNEY_LINE_SLUG = "disney-cruise-line";

function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function loadPhase2cBatchMap() {
  if (!fs.existsSync(PHASE2C_REPORT)) return new Map();
  const phase2c = JSON.parse(fs.readFileSync(PHASE2C_REPORT, "utf8"));
  const map = new Map();
  for (const entry of phase2c.first_controlled_batch?.entries || []) {
    map.set(entry.official_product_key, entry);
  }
  return map;
}

async function main() {
  const startSha = gitSha();
  const today = "2026-08-15";
  const rest = createSupabaseRest(root);
  const supabase = async (query) => rest.get(query);

  const line = (await supabase(`ci_cruise_lines?slug=eq.${DISNEY_LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  const ships = await supabase(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,official_line_ship_id,active&order=name.asc`
  );
  const destinations = (await supabase("destinations?select=id,name,slug,status")).filter((d) => d.status !== "archived");
  const existingRows = await supabase(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,status,ship_id,departure_date,return_date,nights,departure_port,destination_id,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract,created_at,updated_at&order=created_at.asc`
  );

  console.error("Running Disney Phase 2D endpoint validation (read-only)…");

  const simulation = await adapter.simulateDisneyDiscovery({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today,
    existingRows: existingRows || [],
    supabaseQuery: supabase
  });

  const manifest2 = adapter.buildProposedWriteManifest(
    simulation.products,
    existingRows || [],
    line,
    simulation.legacy_audit
  );
  const deterministic =
    JSON.stringify(manifest2.summary) === JSON.stringify(simulation.write_manifest.summary);

  const phase2cMap = loadPhase2cBatchMap();
  const changedRows = [];
  for (const row of simulation.products) {
    const key = row.official_sailing_id;
    const prior = phase2cMap.get(key);
    const depChanged = prior && prior.departure_port !== row.candidate?.departure_port;
    const arrChanged = prior && prior.arrival_port !== row.candidate?.arrival_port;
    const destChanged =
      prior && prior.destination_key && prior.destination_key !== row.candidate?.destination_key;
    if (depChanged || arrChanged || destChanged || (key === "DD1515|2026-09-14" && prior)) {
      changedRows.push({
        official_product_key: key,
        before: prior
          ? {
              departure_port: prior.departure_port,
              arrival_port: prior.arrival_port || null,
              destination_key: prior.destination_key
            }
          : { departure_port: "Fort Lauderdale", note: "phase2c_incorrect_for_dd1515" },
        after: {
          departure_port: row.candidate?.departure_port,
          arrival_port: row.candidate?.arrival_port,
          destination_key: row.candidate?.destination_key
        },
        destination_changed: Boolean(destChanged)
      });
    }
  }

  const dd1515 = simulation.products.find((r) => r.official_sailing_id === "DD1515|2026-09-14");
  const dd1515Evidence = dd1515 ? adapter.collectEndpointEvidence(dd1515.raw, dd1515.candidate.departure_port_meta, dd1515.candidate.arrival_port_meta) : null;

  const endSha = gitSha();
  const report = {
    phase: "2D",
    repository_start_sha: startSha,
    repository_end_sha: endSha,
    discovered_cruises_writes: 0,
    discovered_cruises_mutations: 0,
    source_snapshot: {
      unique_sailings: simulation.source_unique_sailings,
      complete: simulation.quality_gate.source_complete,
      identity_collisions: simulation.quality_gate.duplicate_official_identities
    },
    dd1515_regression: {
      title: dd1515?.raw?.product_name || null,
      prior_departure: "Fort Lauderdale",
      prior_arrival: dd1515?.candidate?.arrival_port || null,
      product_id_evidence: dd1515Evidence?.product_id_embark || null,
      city_filter_evidence: dd1515Evidence?.city_filter_embarks || [],
      corrected_departure: dd1515?.candidate?.departure_port || null,
      corrected_arrival: dd1515?.candidate?.arrival_port || null,
      root_cause: "city_filter tier 2 and product_id slug outranked explicit product title under old lowest-tier selection",
      passed:
        dd1515?.candidate?.departure_port === "Southampton" &&
        dd1515?.candidate?.arrival_port === "Fort Lauderdale" &&
        !(dd1515?.candidate?.departure_port_meta?.unresolved_conflicts || []).length
    },
    endpoint_evidence_audit: {
      explicit_title_embark_count: simulation.endpoint_audit.explicit_title_embark_count,
      explicit_title_arrival_count: simulation.endpoint_audit.explicit_title_arrival_count,
      product_id_evidence_count: simulation.endpoint_audit.product_id_evidence_count,
      city_filter_evidence_count: simulation.endpoint_audit.city_filter_evidence_count,
      any_conflict_count: simulation.endpoint_audit.any_conflict_count,
      conflicts_by_type: simulation.endpoint_audit.conflicts_by_type,
      unresolved_conflicts: simulation.endpoint_audit.unresolved_conflicts,
      conflicting_identities: simulation.endpoint_audit.conflicting_identities
    },
    one_way_audit: simulation.one_way_audit,
    resolution: {
      ship_pct: simulation.quality_gate.ship_resolution_pct,
      embark_pct: simulation.port_analysis?.embarkation?.sailing_resolution_pct,
      arrival_pct: simulation.port_analysis?.arrival?.arrival_resolved_count
        ? Math.round((simulation.port_analysis.arrival.arrival_resolved_count / simulation.source_unique_sailings) * 10000) / 100
        : 0,
      destination_pct: simulation.destination_analysis?.destination_resolution_pct,
      duration_pct: simulation.quality_gate.duration_validation_pct,
      itinerary_port_pct: simulation.port_analysis?.itinerary_ports?.physical_port_resolution_pct
    },
    changed_candidates: {
      departure_port_changed: changedRows.filter((r) => r.before?.departure_port !== r.after.departure_port).length,
      arrival_port_changed: changedRows.filter((r) => r.before?.arrival_port !== r.after.arrival_port).length,
      destination_changed: changedRows.filter((r) => r.destination_changed).length,
      rows: changedRows
    },
    eligibility_waterfall: {
      as_of_date: simulation.eligibility.as_of_date,
      waterfall: simulation.eligibility.waterfall,
      arithmetic: simulation.eligibility.arithmetic
    },
    production_manifest: { ...simulation.write_manifest.summary, deterministic },
    duplicate_safety: simulation.duplicate_safety,
    first_controlled_batch: {
      ...simulation.first_controlled_batch,
      invalidates_phase2c_batch: true,
      phase2c_batch_obsolete: true,
      phase2c_prior_hash: PHASE2C_BATCH_HASH
    },
    quality_gate: {
      passed: false,
      ready_for_phase3_controlled_apply: false,
      failures: []
    },
    blockers: [],
    recommendation: ""
  };

  const failures = [];
  if (!report.dd1515_regression.passed) failures.push("dd1515_regression");
  if (simulation.endpoint_audit.unresolved_conflicts > 0) failures.push("endpoint_unresolved_conflicts");
  if (simulation.one_way_audit.failed > 0) failures.push("one_way_audit_failures");
  if (!deterministic) failures.push("manifest_not_deterministic");
  if (!simulation.duplicate_safety.passed) failures.push("duplicate_safety");
  if (simulation.first_controlled_batch.size !== 20) failures.push("frozen_batch_not_20");
  if (!simulation.first_controlled_batch.frozen_candidate_hash) failures.push("missing_frozen_hash");

  report.quality_gate.failures = failures;
  report.quality_gate.passed = failures.length === 0 && simulation.quality_gate.passed;
  report.quality_gate.ready_for_phase3_controlled_apply = report.quality_gate.passed;
  report.blockers = failures;
  report.recommendation = report.quality_gate.ready_for_phase3_controlled_apply
    ? "Ready for Phase 3 first controlled apply with frozen hash verification"
    : "Resolve endpoint blockers before Phase 3 apply";

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${REPORT_PATH}`);
  console.log(
    JSON.stringify(
      {
        unique_sailings: report.source_snapshot.unique_sailings,
        dd1515_pass: report.dd1515_regression.passed,
        unresolved_conflicts: report.endpoint_evidence_audit.unresolved_conflicts,
        inserts: report.production_manifest.insert_active,
        frozen_hash: report.first_controlled_batch.frozen_candidate_hash,
        quality_gate: report.quality_gate.passed
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("Disney Phase 2D simulation failed:", error);
  process.exit(1);
});
