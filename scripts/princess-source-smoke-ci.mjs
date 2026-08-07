#!/usr/bin/env node
/**
 * Read-only Princess source smoke for CI or manual invocation.
 *
 *   node scripts/princess-source-smoke-ci.mjs
 *
 * Uses existing Princess source/adapter modules only (no maintenance lock).
 * Performs zero inventory writes.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { simulatePrincessInventory } = require(path.join(
  root,
  "netlify/functions/lib/princess-discovery-adapter"
));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";

async function main() {
  const started = Date.now();
  if (String(process.env.PRINCESS_DISCOVERY_WRITE_ENABLED || "").toLowerCase() === "true") {
    throw new Error("PRINCESS_DISCOVERY_WRITE_ENABLED must not be true for CI source smoke");
  }

  const today = perthCalendarDate();
  const simulation = await simulatePrincessInventory({
    today,
    collectSourceDiagnostics: true
  });
  const fetchResult = simulation.fetch_result || {};
  const bootstrapAttempt = fetchResult.source_diagnostics?.bootstrap?.attempts?.[0] || null;
  const catalogueAttempt = fetchResult.source_diagnostics?.catalogue?.attempts?.[0] || null;

  let princessActiveExact = null;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const counted = await exactCountSupabase(
      root,
      "discovered_cruises",
      `cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active`
    );
    princessActiveExact = counted.count;
  }

  const eligible = simulation.metrics?.complete_high_confidence ?? null;
  const report = {
    execution_platform: process.env.GITHUB_ACTIONS === "true" ? "github_actions" : "local",
    github_run_id: process.env.GITHUB_RUN_ID || null,
    github_run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
    inventory_writes_performed: false,
    ok: simulation.ok === true && !simulation.fetch_failed,
    bootstrap_http_status: bootstrapAttempt?.http_status ?? (fetchResult.session?.ok === false ? null : 200),
    catalogue_http_status: catalogueAttempt?.http_status ?? (simulation.fetch_failed ? 400 : 200),
    source_error: fetchResult.error || (simulation.fetch_failed ? "source_fetch_failed" : null),
    source_groups: simulation.num_found_official ?? simulation.raw_group_count ?? null,
    expanded_sailings: simulation.raw_sailing_count ?? fetchResult.products?.length ?? null,
    eligible_high_confidence: simulation.metrics?.complete_high_confidence ?? null,
    active_production_exact: princessActiveExact,
    quality_gate_passed:
      simulation.ok === true &&
      !simulation.fetch_failed &&
      (simulation.metrics?.identity_coverage_pct ?? 0) >= 99,
    identity_coverage_pct: simulation.metrics?.identity_coverage_pct ?? null,
    source_diagnostics_present: Boolean(fetchResult.source_diagnostics),
    elapsed_ms: Date.now() - started
  };

  console.log(JSON.stringify(report, null, 2));

  if (!report.ok || report.source_error || report.catalogue_http_status !== 200 || !report.quality_gate_passed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message || String(err), inventory_writes_performed: false }));
  process.exit(1);
});
