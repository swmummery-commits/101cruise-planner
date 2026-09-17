#!/usr/bin/env node
/**
 * P3J Disney catch-up via Phase A freeze + Phase B batches of 30.
 * Stops on first anomaly. Does not delete. Does not claim W38 scheduled lease.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const { scheduledWeeklyDispatchKey } = require(
  path.join(root, "netlify/functions/lib/weekly-maintenance-schedule-control")
);
const { loadMaintenanceLockStatus } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks")
);
const { runDisneyWeeklyMaintenance, DISNEY_LINE_SLUG } = require(
  path.join(root, "netlify/functions/lib/disney-weekly-maintenance")
);
const {
  persistDisneySourceFreeze,
  applyDisneyPhaseBBatch
} = require(path.join(root, "netlify/functions/lib/disney-weekly-phases"));

async function main() {
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const freeze30 = JSON.parse(
    fs.readFileSync(path.join(root, "reports/disney-p3j-partial-write-30-freeze-2026-09-17.json"), "utf8")
  );
  const freezeIds = new Set(freeze30.official_sailing_ids || []);
  const periodKey = scheduledWeeklyDispatchKey(DISNEY_LINE_SLUG);
  const beforeLease = await loadMaintenanceLockStatus(sb, periodKey);

  const runId = `disney-cruise-line:p3j-catchup-a-${Date.now()}`;
  const phaseA = await runDisneyWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    triggerType: "preflight",
    runId,
    deadlineMs: 20 * 60 * 1000
  });
  const afterLease = await loadMaintenanceLockStatus(sb, periodKey);
  if (beforeLease.held !== true && afterLease.held === true) {
    throw new Error("catch-up claimed W38 schedule lease");
  }

  const plan = phaseA.phase_a_plan;
  if (!plan?.plan_hash) throw new Error("missing phase A plan");
  const reproposed = (plan.payload?.insert_official_sailing_ids || []).filter((id) => freezeIds.has(id));
  if (reproposed.length) {
    throw new Error(`first 30 reproposed: ${reproposed.join(",")}`);
  }

  const gate = phaseA.summary?.source_quality_gate || {};
  const quality = {
    ship: gate.ship_resolution_pct ?? gate.resolution_rates?.ship_resolution_pct,
    departure_port: gate.embarkation_resolution_pct,
    destination: gate.destination_resolution_pct,
    identity: gate.identity_coverage_pct,
    duplicate_official_ids: gate.duplicate_official_identities,
    passed: gate.passed === true
  };
  if (quality.passed !== true) {
    const file = path.join(root, "reports", `disney-p3j-catchup-blocked-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ blocked: true, quality, summary: phaseA.summary }, null, 2));
    console.log(JSON.stringify({ blocked: true, quality, report_file: file }, null, 2));
    return;
  }

  const line = (await sb(`ci_cruise_lines?slug=eq.${DISNEY_LINE_SLUG}&select=id,name,slug&limit=1`))[0];
  const freezePersist = await persistDisneySourceFreeze(sb, {
    runId,
    cruiseLineId: line.id,
    plan,
    triggerType: "incident_recovery"
  });

  const batches = [];
  for (const batch of plan.batches || []) {
    const applied = await applyDisneyPhaseBBatch({
      supabase: sb,
      cruiseLine: line,
      plan,
      batch,
      runId: `disney-phase-b-p3j-${batch.batch_number}-${Date.now()}`,
      triggerType: "incident_recovery"
    });
    batches.push({
      batch_number: batch.batch_number,
      expected: batch.expected_record_count,
      writes: applied.writes,
      ok: applied.ok,
      reason: applied.reason || null,
      run_record_id: applied.run_record_id,
      precommit_manifest_id: applied.precommit_manifest_id
    });
    if (!applied.ok || applied.writes !== batch.expected_record_count) {
      break;
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    source_runtime_ms: (plan.stage_timings || []).reduce((sum, row) => sum + Number(row.duration_ms || 0), 0),
    stage_timings: plan.stage_timings,
    api_calls: plan.api_calls,
    eligible: phaseA.summary?.eligible_total,
    plan_hash: plan.plan_hash,
    freeze_manifest_id: freezePersist.manifest_record_id,
    remaining_inserts: plan.payload?.insert_official_sailing_ids?.length || 0,
    reviews: plan.payload?.review_official_sailing_ids?.length || 0,
    quality,
    batches,
    writes_total: batches.reduce((sum, row) => sum + Number(row.writes || 0), 0),
    failures: batches.filter((row) => row.ok !== true),
    w38_schedule_lease_held: afterLease.held === true
  };
  const file = path.join(root, "reports", `disney-p3j-catchup-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report_file: file, ...report, batches: batches.map((b) => ({ n: b.batch_number, writes: b.writes, ok: b.ok })) }, null, 2));
  if (report.failures.length) process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
