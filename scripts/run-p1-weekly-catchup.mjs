#!/usr/bin/env node
/**
 * Sequential controlled weekly catch-up for Celebrity or HAL.
 * Does not raise caps. Stops on the first anomaly.
 *
 *   CELEBRITY_WEEKLY_RECONCILIATION_ENABLED=true node scripts/run-p1-weekly-catchup.mjs \
 *     --line=celebrity --apply --confirm=CELEBRITY-P1-CONTROLLED-CATCHUP
 *   HAL_WEEKLY_RECONCILIATION_ENABLED=true node scripts/run-p1-weekly-catchup.mjs \
 *     --line=hal --apply --confirm=HAL-P1-CONTROLLED-CATCHUP
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const { createMaintenanceSupabase, exactCountSupabase, getSupabaseConfig } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const {
  runHalWeeklyMaintenance,
  runCelebrityWeeklyMaintenance,
  MAX_WRITES_PER_BATCH
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner"));
const { executeWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-cron"
));
const {
  assertHalWeeklyMaintenanceEnabled,
  assertCelebrityWeeklyMaintenanceEnabled,
  HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));

const LINES = {
  celebrity: {
    slug: "celebrity-cruises",
    runType: CELEBRITY_WEEKLY_MAINTENANCE_RUN_TYPE,
    runMaintenance: runCelebrityWeeklyMaintenance,
    assertEnabled: assertCelebrityWeeklyMaintenanceEnabled,
    confirm: "CELEBRITY-P1-CONTROLLED-CATCHUP",
    flag: "CELEBRITY_WEEKLY_RECONCILIATION_ENABLED",
    insertAction: "insert_active",
    updateAction: "update_exact_legacy_match",
    keyField: "stable_identity_key"
  },
  hal: {
    slug: "holland-america-line",
    runType: HAL_WEEKLY_MAINTENANCE_RUN_TYPE,
    runMaintenance: runHalWeeklyMaintenance,
    assertEnabled: assertHalWeeklyMaintenanceEnabled,
    confirm: "HAL-P1-CONTROLLED-CATCHUP",
    flag: "HAL_WEEKLY_RECONCILIATION_ENABLED",
    insertAction: "insert_active",
    updateAction: "update_existing",
    keyField: "stable_product_identity_key"
  }
};

function parseArgs(argv) {
  const line = String(argv.find((arg) => arg.startsWith("--line="))?.slice("--line=".length) || "")
    .trim()
    .toLowerCase();
  if (!LINES[line]) throw new Error("--line must be celebrity or hal");
  return {
    line,
    apply: argv.includes("--apply"),
    confirm: argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length) || null,
    maxBatches: Number(argv.find((arg) => arg.startsWith("--max-batches="))?.slice("--max-batches=".length) || 12)
  };
}

function actionKey(entry, spec) {
  return String(entry?.[spec.keyField] || entry?.official_princess_sailing_id || entry?.official_sailing_id || "");
}

function freezeFromManifest(manifest, spec, cap) {
  const writeKeys = (manifest?.products || [])
    .filter((entry) => [spec.insertAction, spec.updateAction].includes(entry.proposed_action))
    .map((entry) => actionKey(entry, spec))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const frozen = writeKeys.slice(0, cap);
  return {
    pending: writeKeys.length,
    frozen,
    hash: require("crypto").createHash("sha256").update(JSON.stringify(frozen)).digest("hex")
  };
}

function compact(summary = {}) {
  return {
    run_id: summary.run_id,
    eligible_total: summary.eligible_total,
    active_production_total: summary.active_production_total,
    proposed_inserts: summary.proposed_inserts,
    proposed_updates: summary.proposed_updates,
    source_absent_active: summary.source_absent_active,
    snapshot_id: summary.snapshot_id,
    quality_gate: summary.quality_gate,
    inserts: summary.inserts,
    updates: summary.updates,
    failed_writes: summary.failed_writes,
    rollback_manifest_id: summary.rollback_manifest_id,
    resolution_rates: summary.resolution_rates
  };
}

async function main() {
  getSupabaseConfig(root);
  const args = parseArgs(process.argv.slice(2));
  const spec = LINES[args.line];
  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.${spec.slug}&select=id,slug&limit=1`))?.[0];
  if (!line) throw new Error("line not found");
  const report = {
    date: "2026-09-01",
    line: spec.slug,
    apply: args.apply === true,
    cap: MAX_WRITES_PER_BATCH,
    batches: [],
    ok: false
  };

  async function dryRun(triggerType) {
    return executeWeeklyMaintenance({
      lineSlug: spec.slug,
      cruiseLineId: line.id,
      runType: spec.runType,
      assertEnabled: () => {},
      runMaintenance: spec.runMaintenance,
      dryRun: true,
      maxWrites: MAX_WRITES_PER_BATCH,
      triggerType,
      supabaseClient: sb
    });
  }

  const first = await dryRun("p1_catchup_preflight");
  if (first.success === false || first.summary?.quality_gate?.passed === false) {
    report.reason = first.reason || "quality_gate_failed";
    report.preflight = compact(first.summary || {});
    fs.writeFileSync(path.join(root, "reports", `${args.line}-p1-catchup-2026-09-01.json`), `${JSON.stringify(report, null, 2)}\n`);
    throw new Error(report.reason);
  }
  report.preflight = compact(first.summary || {});
  report.counts_before = {
    active: (
      await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`)
    ).count
  };

  if (!args.apply) {
    const freeze = freezeFromManifest(first.manifest, spec, MAX_WRITES_PER_BATCH);
    report.preview_freeze = freeze;
    report.ok = true;
    const file = path.join(root, "reports", `${args.line}-p1-catchup-preview-2026-09-01.json`);
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ report_path: file, ...report, manifest: undefined }, null, 2));
    return;
  }

  if (args.confirm !== spec.confirm) throw new Error("weekly_apply_confirmation_required");
  if (String(process.env[spec.flag] || "").trim().toLowerCase() !== "true") {
    throw new Error(`${spec.flag} must be strict true`);
  }

  let pending = Number(first.summary?.proposed_inserts || 0) + Number(first.summary?.proposed_updates || 0);
  let manifest = first.manifest;
  let snapshot = first.summary?.snapshot_id;
  let batch = 0;
  while (pending > 0 && batch < args.maxBatches) {
    batch += 1;
    const freeze = freezeFromManifest(manifest, spec, MAX_WRITES_PER_BATCH);
    if (!freeze.frozen.length) {
      report.reason = "pending_but_empty_freeze";
      break;
    }
    const apply = await executeWeeklyMaintenance({
      lineSlug: spec.slug,
      cruiseLineId: line.id,
      runType: spec.runType,
      assertEnabled: spec.assertEnabled,
      runMaintenance: (ctx) =>
        spec.runMaintenance({
          ...ctx,
          frozenOfficialSailingIds: freeze.frozen,
          maxWrites: freeze.frozen.length
        }),
      dryRun: false,
      maxWrites: freeze.frozen.length,
      triggerType: `p1_catchup_batch_${batch}`,
      supabaseClient: sb
    });
    const failed = Number(apply.summary?.failed_writes || 0);
    const inserted = Number(apply.summary?.inserts || 0);
    const updated = Number(apply.summary?.updates || 0);
    const batchReport = {
      batch,
      freeze_hash: freeze.hash,
      frozen_count: freeze.frozen.length,
      run_id: apply.run_id,
      run_record_id: apply.run_record_id,
      rollback_manifest_id: apply.summary?.rollback_manifest_id || null,
      inserted,
      updated,
      failed,
      ok: apply.success === true && apply.blocked !== true && failed === 0 && inserted + updated === freeze.frozen.length
    };
    report.batches.push(batchReport);
    if (!batchReport.ok) {
      report.reason = apply.reason || "batch_anomaly";
      report.last_summary = compact(apply.summary || {});
      break;
    }

    const recon = await dryRun(`p1_catchup_recon_batch_${batch}`);
    report.batches[report.batches.length - 1].recon = compact(recon.summary || {});
    if (recon.summary?.quality_gate?.passed === false) {
      report.reason = "post_write_quality_gate_failed";
      break;
    }
    if (snapshot && recon.summary?.snapshot_id && recon.summary.snapshot_id !== snapshot) {
      report.reason = "source_snapshot_changed_mid_session";
      report.snapshot_before = snapshot;
      report.snapshot_after = recon.summary.snapshot_id;
      break;
    }
    snapshot = recon.summary?.snapshot_id || snapshot;
    pending =
      Number(recon.summary?.proposed_inserts || 0) + Number(recon.summary?.proposed_updates || 0);
    manifest = recon.manifest;
    if (pending === 0) break;
  }

  report.counts_after = {
    active: (
      await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${line.id}&status=eq.active`)
    ).count
  };
  report.outstanding = pending;
  report.ok = pending === 0 && !report.reason && report.batches.every((row) => row.ok);
  const file = path.join(root, "reports", `${args.line}-p1-catchup-2026-09-01.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report_path: file, ...report }, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
  process.exit(1);
});
