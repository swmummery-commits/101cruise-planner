#!/usr/bin/env node
/**
 * Read-only Disney Cruise Line Phase 2A enumeration + accounting probe.
 *
 *   node scripts/probe-disney-phase2a.mjs
 *
 * Runs two complete probes for reproducibility and writes
 * reports/disney-phase2a-enumeration-reconciliation.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const source = require(path.join(root, "netlify/functions/lib/disney-discovery-source"));

const OUTPUT = path.join(root, "reports/disney-phase2a-enumeration-reconciliation.json");
const PHASE1_BASELINE_SHIP_COUNTS = {
  "Disney Adventure": 107,
  "Disney Fantasy": 70,
  "Disney Dream": 56,
  "Disney Wonder": 55,
  "Disney Treasure": 55,
  "Disney Wish": 51,
  "Disney Destiny": 46,
  "Disney Magic": 44
};

function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function shipCoverageDelta(phase2Counts = {}) {
  return Object.keys({ ...PHASE1_BASELINE_SHIP_COUNTS, ...phase2Counts })
    .sort()
    .map((ship) => ({
      ship,
      phase1_count: PHASE1_BASELINE_SHIP_COUNTS[ship] ?? 0,
      phase2a_count: phase2Counts[ship] ?? 0,
      delta: (phase2Counts[ship] ?? 0) - (PHASE1_BASELINE_SHIP_COUNTS[ship] ?? 0)
    }));
}

function slimProbeForReport(probe) {
  const { sailings, harvest, ...rest } = probe;
  return {
    ...rest,
    sailings_sample: (sailings || []).slice(0, 5).map((s) => ({
      official_product_key: s.official_product_key,
      ship_name: s.ship_name,
      departure_date: s.departure_date,
      product_id: s.product_id
    })),
    sailing_identities: (sailings || []).map((s) => s.official_product_key).sort(),
    harvest_summary: harvest
      ? {
          unique_product_templates: harvest.unique_product_templates,
          unique_itinerary_targets: harvest.unique_itinerary_targets,
          api_calls: harvest.api_calls,
          harvest_plans: harvest.harvest_plans
        }
      : null
  };
}

async function runProbe(label, startSha, { skipFilterContext = false, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      console.log(`[${label}] Starting Phase 2A probe${attempt > 1 ? ` (retry ${attempt})` : ""}…`);
      const probe = await source.probeDisneyEnumerationPhase2a({
        requestDelayMs: 100,
        maxApiCalls: source.PHASE2_MAX_API_CALLS,
        repositoryStartSha: startSha,
        perthToday: "2026-08-15",
        skipFilterContextAnalysis: skipFilterContext
      });
      console.log(
        `[${label}] unique sailings=${probe.enumeration.unique_sailings} raw_rows=${probe.enumeration.raw_sailing_rows} api_calls=${probe.enumeration.api_calls_total}`
      );
      return probe;
    } catch (error) {
      lastError = error;
      console.error(`[${label}] attempt ${attempt} failed:`, error.message);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastError;
}

async function main() {
  const startSha = gitSha();
  const run1 = await runProbe("run-1", startSha, { skipFilterContext: false });
  const run2 = await runProbe("run-2", startSha, { skipFilterContext: true });
  const endSha = gitSha();

  const reproducibility = source.compareProbeIdentitySets(
    run1.sailings.map((s) => s.official_product_key),
    run2.sailings.map((s) => s.official_product_key)
  );

  const report = {
    phase: "2A",
    repository_start_sha: startSha,
    repository_end_sha: endSha,
    production_writes: 0,
    database_mutations: 0,
    phase1_baseline: run1.phase1_baseline,
    product_variant_analysis: run1.product_variant_analysis,
    enumeration: run1.enumeration,
    monthly_reconciliation: run1.monthly_reconciliation,
    totalAvailableCruises_semantics: run1.totalAvailableCruises_semantics,
    filter_context_analysis: {
      samples_tested: run1.filter_context_analysis?.samples_tested ?? 0,
      filter_context_matters: run1.filter_context_analysis?.filter_context_matters ?? false,
      contexts_reveal_extra_sailings: run1.filter_context_analysis?.contexts_reveal_extra_sailings ?? 0,
      api_calls: run1.filter_context_analysis?.api_calls ?? 0,
      sample_comparisons: run1.filter_context_analysis?.comparisons ?? []
    },
    pagination_accounting: run1.pagination_accounting,
    ship_coverage_vs_phase1: shipCoverageDelta(run1.enumeration.ship_counts),
    reproducibility_check: reproducibility,
    run2_enumeration_summary: {
      unique_sailings: run2.enumeration.unique_sailings,
      raw_sailing_rows: run2.enumeration.raw_sailing_rows,
      api_calls_total: run2.enumeration.api_calls_total
    },
    quality_gate: {
      ...run1.quality_gate,
      reproducible: reproducibility.substantially_reproducible
    },
    blockers: [
      ...run1.blockers,
      ...(reproducibility.substantially_reproducible ? [] : ["two-run identity set volatility exceeds threshold"])
    ],
    recommendation: run1.recommendation,
    completed_at: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${OUTPUT}`);
  console.log(JSON.stringify({
    unique_sailings: report.enumeration.unique_sailings,
    monthly_advertised_sum: run1.monthly_advertised_sum,
    totalAvailableCruises_semantics: report.totalAvailableCruises_semantics.conclusion,
    reproducibility: report.reproducibility_check,
    ready_for_phase2b: report.quality_gate.ready_for_phase2b && report.quality_gate.reproducible
  }, null, 2));
}

main().catch((error) => {
  console.error("Phase 2A probe failed:", error);
  process.exit(1);
});
