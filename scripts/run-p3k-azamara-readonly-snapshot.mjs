#!/usr/bin/env node
/**
 * P3K Azamara READ-ONLY snapshot / production reconciliation.
 * Unique incident/preflight namespace. Must not claim azamara:2026-W38:scheduled.
 *
 *   node scripts/run-p3k-azamara-readonly-snapshot.mjs --label=A
 *   node scripts/run-p3k-azamara-readonly-snapshot.mjs --label=B
 *   node scripts/run-p3k-azamara-readonly-snapshot.mjs --label=recon
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { scheduledWeeklyDispatchKey, perthIsoWeek } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);
const { runAzamaraWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/azamara-weekly-maintenance")
);

function parseArgs(argv) {
  const args = { label: "A" };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--label=")) args.label = String(arg.slice("--label=".length)).trim() || "A";
  }
  return args;
}

function compactProduct(p) {
  if (!p) return null;
  return {
    official_sailing_id: p.official_sailing_id || null,
    disposition: p.disposition || null,
    failure: p.failure || null,
    url: p.url || null,
    ship: p.ship || null,
    departure: p.departure || null,
    return_date: p.return_date || null,
    nights: p.nights || null,
    departure_port: p.departure_port || null,
    destination: p.destination || null,
    dest_quality: p.dest_quality || null
  };
}

async function main() {
  const args = parseArgs(process.argv);
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const week = perthIsoWeek();
  const scheduledKey = scheduledWeeklyDispatchKey("azamara");
  const leaseBefore = await loadMaintenanceLockStatus(sb, scheduledKey);
  const runId = `azamara:p3k-${args.label}-${week}-${Date.now()}`;
  const started = Date.now();

  const result = await runAzamaraWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    runId,
    triggerType: args.label === "recon" ? "preflight" : "incident"
  });

  const leaseAfter = await loadMaintenanceLockStatus(sb, scheduledKey);
  const sim = result.simulation || {};
  const fetchResult = sim.fetch_result || {};
  const eligible = sim.source_eligible_official_ids || [];
  const identityHash =
    fetchResult.official_source_identity_hash ||
    crypto.createHash("sha256").update([...eligible].sort().join("|")).digest("hex");
  const products = sim.products || [];
  const withCandidate = products.filter((p) => p.candidate);
  const shipResolved = withCandidate.filter((p) => p.candidate?.ship_id).length;
  const portResolved = withCandidate.filter((p) => p.candidate?.departure_port).length;
  const destResolved = withCandidate.filter((p) => p.candidate?.destination_id).length;
  const identityCoverage =
    withCandidate.length === 0 ? 0 : withCandidate.filter((p) => p.identity_key).length / withCandidate.length;

  const report = {
    generated_at: new Date().toISOString(),
    label: args.label,
    run_id: runId,
    week,
    scheduled_lease_key: scheduledKey,
    scheduled_lease_before_held: leaseBefore.held === true,
    scheduled_lease_after_held: leaseAfter.held === true,
    scheduled_lease_created: leaseBefore.held !== true && leaseAfter.held === true,
    elapsed_ms: Date.now() - started,
    terminal_status: result.terminal_status || result.summary?.terminal_status || null,
    reason: result.reason || result.summary?.reason || null,
    source_repair_required: result.source_repair_required === true,
    source_unstable: result.source_unstable === true,
    dry_run: result.dry_run === true,
    writes: result.summary?.writes_performed || { inserted: 0, updated: 0, failed: 0 },
    fetch_result: {
      ok: fetchResult.ok,
      sitemap_url: fetchResult.sitemap_url,
      final_url: fetchResult.final_url,
      http_status: fetchResult.http_status,
      sitemap_sha256: fetchResult.sitemap_sha256,
      sitemap_locs: fetchResult.sitemap_locs,
      sitemap_packages: fetchResult.sitemap_packages,
      eligible_urls: fetchResult.eligible_urls,
      ocean_eligible_urls: fetchResult.ocean_eligible_urls,
      urls_processed: fetchResult.urls_processed,
      urls_target: fetchResult.urls_target,
      http_failures: fetchResult.http_failures,
      stale_dead: fetchResult.stale_dead,
      source_timeout: fetchResult.source_timeout,
      pagination: fetchResult.pagination,
      detail_concurrency: fetchResult.detail_concurrency,
      stage_accounting: fetchResult.stage_accounting
    },
    outcome_counts: sim.outcome_counts || null,
    quality_gate_metrics: sim.quality_gate_metrics || null,
    source_eligible: eligible.length,
    official_source_identity_hash: identityHash,
    production_official: result.summary?.production_official ?? result.manifest?.production_official ?? null,
    recognised_eligible: result.summary?.recognised_eligible ?? null,
    proposed_inserts: result.summary?.proposed_inserts ?? (result.manifest?.inserts || []).length,
    proposed_updates: result.summary?.proposed_updates ?? (result.manifest?.updates || []).length,
    proposed_identity_review: result.summary?.proposed_identity_review ?? (result.manifest?.identity_review || []).length,
    proposed_source_absence_hides:
      result.summary?.proposed_source_absence_hides ?? (result.manifest?.source_absence_hides || []).length,
    source_absence_policy: {
      source_complete: result.manifest?.source_complete ?? null,
      source_absence_actions_allowed: result.manifest?.source_absence_policy?.source_absence_actions_allowed ?? null,
      source_absent_observed: result.manifest?.source_absence_policy?.source_absent_observed ?? null,
      source_absent_actionable: result.manifest?.source_absence_policy?.source_absent_actionable ?? null,
      source_absent_retained: result.manifest?.source_absence_policy?.source_absent_retained ?? null,
      deactivation_allowed: false
    },
    legacy_ignored: result.summary?.legacy_ignored ?? result.manifest?.legacy_ignored ?? null,
    quality: {
      candidate_count: withCandidate.length,
      ship_resolved: shipResolved,
      departure_port_resolved: portResolved,
      destination_resolved: destResolved,
      identity_coverage: identityCoverage,
      duplicate_official_ids: sim.quality_gate_metrics?.duplicate_official_sailing_ids ?? null,
      duplicate_identities: sim.quality_gate_metrics?.duplicate_official_identities ?? null
    },
    insert_ids: (result.manifest?.inserts || []).map((e) => e.official_sailing_id).filter(Boolean),
    update_ids: (result.manifest?.updates || []).map((e) => e.official_sailing_id).filter(Boolean),
    identity_review_ids: result.summary?.identity_review_sailing_ids || [],
    source_eligible_official_ids: eligible,
    product_dispositions: products.reduce((acc, p) => {
      const key = p.failure ? `${p.disposition}:${p.failure}` : p.disposition;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    sample_products: products.slice(0, 8).map(compactProduct)
  };

  const file = path.join(root, "reports", `azamara-p3k-snapshot-${args.label}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        report_file: file,
        label: args.label,
        run_id: runId,
        terminal_status: report.terminal_status,
        reason: report.reason,
        source_eligible: report.source_eligible,
        identity_hash: identityHash,
        sitemap_sha256: fetchResult.sitemap_sha256,
        elapsed_ms: report.elapsed_ms,
        source_timeout: fetchResult.source_timeout,
        stage_reconciled: fetchResult.stage_accounting?.reconciled,
        scheduled_lease_created: report.scheduled_lease_created,
        writes: report.writes,
        proposed_inserts: report.proposed_inserts,
        proposed_updates: report.proposed_updates,
        identity_reviews: report.proposed_identity_review,
        source_absent: report.source_absence_policy.source_absent_observed,
        source_absence_actions_allowed: report.source_absence_policy.source_absence_actions_allowed
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
