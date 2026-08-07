#!/usr/bin/env node
/**
 * Read-only Princess source smoke for CI or manual invocation.
 *
 *   node scripts/princess-source-smoke-ci.mjs
 *
 * Uses existing Princess maintenance modules (dry run, zero writes).
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, exactCountSupabase, getSupabaseConfig } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const HAL_LINE_ID = "a8d0e678-0cb2-4ea7-ad73-251f0eb36ea2";
const CELEBRITY_LINE_ID = "aa2c50ed-7ff5-472d-bc96-3d686d76c5ec";

function assertReadOnlyEnv() {
  for (const flag of [
    "PRINCESS_DISCOVERY_WRITE_ENABLED",
    "PRINCESS_WEEKLY_RECONCILIATION_ENABLED"
  ]) {
    if (String(process.env[flag] || "").toLowerCase() === "true") {
      throw new Error(`${flag} must not be true for CI source smoke`);
    }
  }
}

async function exactLineCounts() {
  const [princess, hal, celebrity] = await Promise.all([
    exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active`),
    exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${HAL_LINE_ID}&status=eq.active`),
    exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${CELEBRITY_LINE_ID}&status=eq.active`)
  ]);
  return { princess: princess.count, hal: hal.count, celebrity: celebrity.count };
}

async function main() {
  const started = Date.now();
  assertReadOnlyEnv();

  getSupabaseConfig(root);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Princess CI source smoke");
  }

  const countsBefore = await exactLineCounts();
  const sb = createMaintenanceSupabase(root);
  const runId = `princess-ci-smoke-${Date.now()}`;

  const result = await runPrincessWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    maxWrites: 0,
    runId,
    supabase: sb,
    triggerType: "ci_source_smoke",
    collectSourceDiagnostics: true,
    writeMode: "production_read_only"
  });

  const countsAfter = await exactLineCounts();
  const summary = result.summary || {};
  const simulation = result.simulation || {};
  const fetchResult = simulation.fetch_result || {};
  const bootstrapAttempt = fetchResult.source_diagnostics?.bootstrap?.attempts?.[0] || null;
  const catalogueAttempt = fetchResult.source_diagnostics?.catalogue?.attempts?.[0] || null;
  const rates = summary.resolution_rates || {};

  const report = {
    execution_platform: process.env.GITHUB_ACTIONS === "true" ? "github_actions" : "local",
    github_run_id: process.env.GITHUB_RUN_ID || null,
    github_run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
    github_sha: process.env.GITHUB_SHA || null,
    github_ref: process.env.GITHUB_REF || null,
    runner_os: process.env.RUNNER_OS || null,
    node_version: process.version,
    inventory_writes_performed: false,
    ok: result.ok === true && !result.blocked && !fetchResult.fetch_failed,
    bootstrap_http_status: bootstrapAttempt?.http_status ?? null,
    catalogue_http_status: catalogueAttempt?.http_status ?? (fetchResult.fetch_failed ? 400 : 200),
    source_error: fetchResult.error || result.reason || null,
    source_groups: summary.official_source_total ?? simulation.num_found_official ?? null,
    expanded_sailings: simulation.raw_sailing_count ?? null,
    within_21_day_excluded: summary.within_public_cutoff_excluded ?? null,
    incomplete_skipped: summary.incomplete_skipped ?? null,
    eligible_total: summary.eligible_total ?? null,
    active_production_exact: countsAfter.princess,
    unchanged: summary.unchanged ?? null,
    proposed_inserts: summary.proposed_inserts ?? null,
    snapshot_id: summary.snapshot_id ?? null,
    quality_gate_passed: summary.quality_gate?.passed === true,
    quality_gate_failures: summary.quality_gate?.failures || [],
    ship_resolution_pct: rates.ship_resolution_pct ?? null,
    departure_port_resolution_pct: rates.departure_port_resolution_pct ?? null,
    destination_resolution_pct: rates.destination_resolution_pct ?? null,
    identity_coverage_pct: rates.identity_coverage_pct ?? null,
    counts_before: countsBefore,
    counts_after: countsAfter,
    inventory_unchanged:
      countsBefore.princess === countsAfter.princess &&
      countsBefore.hal === countsAfter.hal &&
      countsBefore.celebrity === countsAfter.celebrity,
    elapsed_ms: Date.now() - started
  };

  console.log(JSON.stringify(report, null, 2));

  if (
    !report.ok ||
    report.source_error ||
    report.catalogue_http_status !== 200 ||
    report.quality_gate_passed !== true ||
    !report.inventory_unchanged
  ) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message || String(err), inventory_writes_performed: false }));
  process.exit(1);
});
