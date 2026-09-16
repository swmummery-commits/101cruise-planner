#!/usr/bin/env node
/**
 * P3H Royal controlled catch-up. Serial batches <=30. Inserts only.
 * No source-absence hides. No deletes. Stops later batches on first anomaly.
 *
 *   node scripts/run-p3h-royal-catchup-apply.mjs --from=reports/royal-p3h-readonly-snapshot-*.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  freezeRoyalCatchupMasterPlan,
  verifyFrozenRoyalCatchupPlanHash,
  buildRoyalCatchupBatchWeeklyManifest,
  P3G_ROYAL_CATCHUP_BATCH_CAP
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-p3g-catchup-plan"));
const {
  WEEKLY_MANIFEST_MODE,
  WEEKLY_APPLY_CONFIRMATION_TOKEN,
  computeManifestHash,
  validateFrozenWeeklyManifest
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-weekly-manifest"));
const { applyRoyalCaribbeanWeeklyManifest } = require(
  path.join(root, "netlify/functions/lib/royal-caribbean-weekly-apply")
);
const { withGlobalCruiseWriteLock } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-global-write-lock")
);
const { persistMaintenanceRollbackManifest } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-manifests")
);
const { indexExistingRoyalCaribbeanRecords } = require(
  path.join(root, "netlify/functions/lib/royal-caribbean-discovery-writes")
);
const { laterRoyalCatchupBatchesMustStop } = require(
  path.join(root, "netlify/functions/lib/royal-caribbean-p3h-candidate-compare")
);

const fromPath = process.argv.find((arg) => arg.startsWith("--from="))?.slice("--from=".length);
if (!fromPath) {
  console.error("usage: node scripts/run-p3h-royal-catchup-apply.mjs --from=reports/<p3h-snapshot>.json");
  process.exit(1);
}

async function verifyInserted(sb, details) {
  const verified = [];
  for (const detail of details || []) {
    if (detail.result_action !== "inserted" || !detail.discovered_cruise_id) continue;
    const rows = await sb(
      `discovered_cruises?id=eq.${encodeURIComponent(detail.discovered_cruise_id)}&select=id,official_sailing_id,identity_key,external_key,status`
    );
    const row = rows?.[0];
    verified.push({
      discovered_cruise_id: detail.discovered_cruise_id,
      official_sailing_id: detail.official_sailing_id,
      present: Boolean(row),
      identity_match: row?.official_sailing_id === detail.official_sailing_id,
      status: row?.status || null
    });
  }
  return verified;
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.resolve(fromPath), "utf8"));
  if (raw.freeze_gate?.freeze_authorised !== true) {
    console.error("freeze_gate not authorised; refusing writes");
    process.exit(2);
  }
  getSupabaseConfig(root);
  const sb = createMaintenanceSupabase(root);
  const line = (
    await sb("ci_cruise_lines?slug=eq.royal-caribbean-international&select=id,name,slug&limit=1")
  )[0];
  const plan = raw.master_plan;
  const hashCheck = verifyFrozenRoyalCatchupPlanHash(plan);
  if (!hashCheck.ok) {
    console.error("master plan hash mismatch", hashCheck);
    process.exit(2);
  }
  if (plan.batch_cap > 30 || P3G_ROYAL_CATCHUP_BATCH_CAP > 30) {
    console.error("batch cap must remain 30");
    process.exit(2);
  }

  const sourceAbsentBefore = raw.fresh?.source_absent_active ?? null;
  const batches = [];
  let stop = false;

  for (const batch of plan.batches || []) {
    if (stop) {
      batches.push({
        batch_number: batch.batch_number,
        skipped: true,
        applied: false,
        reason: "prior_batch_anomaly"
      });
      continue;
    }

    const runId = `royal-p3h-catchup-b${batch.batch_number}-${Date.now()}`;
    const weeklyManifest = buildRoyalCatchupBatchWeeklyManifest({
      plan,
      batch,
      runId,
      computeManifestHash,
      weeklyManifestMode: WEEKLY_MANIFEST_MODE,
      confirmToken: WEEKLY_APPLY_CONFIRMATION_TOKEN
    });
    if ((weeklyManifest.source_absence_hides || []).length !== 0) {
      throw new Error("p3h_forbids_source_absence_hides");
    }
    if ((weeklyManifest.inserts || []).length > 30) {
      throw new Error("p3h_batch_exceeds_30");
    }
    const validation = validateFrozenWeeklyManifest(weeklyManifest);
    if (!validation.passed) {
      batches.push({
        batch_number: batch.batch_number,
        ok: false,
        failed_writes: 1,
        stopped_early: true,
        reason: validation.failures.join("; ")
      });
      stop = true;
      continue;
    }

    const wrap = await withGlobalCruiseWriteLock(
      sb,
      {
        ownerId: runId,
        runId,
        lineSlug: "royal-caribbean-international",
        operation: "royal_caribbean_p3h_controlled_catchup"
      },
      async () => {
        const liveHash = verifyFrozenRoyalCatchupPlanHash(plan);
        if (!liveHash.ok) return { ok: false, reason: "master_plan_hash_changed" };
        const indexes = await indexExistingRoyalCaribbeanRecords(sb, line.id);
        const collisions = [];
        for (const entry of weeklyManifest.inserts) {
          const existing =
            indexes.byProductKey.get(entry.official_sailing_id) ||
            (entry.identity_key ? indexes.byIdentity.get(entry.identity_key) : null) ||
            (entry.external_key ? indexes.byExternal.get(entry.external_key) : null);
          if (existing) collisions.push(entry.official_sailing_id);
        }
        if (collisions.length) {
          return { ok: false, reason: "under_lock_collision", collisions };
        }
        const applyResult = await applyRoyalCaribbeanWeeklyManifest({
          manifest: weeklyManifest,
          supabase: sb,
          cruiseLine: line,
          performWrites: true,
          runId,
          firstActivationCycle: false
        });
        const rollback = await persistMaintenanceRollbackManifest(sb, {
          runId,
          cruiseLineId: line.id,
          lineSlug: "royal-caribbean-international",
          triggerType: "manual_recovery",
          writeResult: applyResult
        }).catch((error) => ({ error: error.message || String(error) }));
        const verified = await verifyInserted(sb, applyResult.stats?.write_details || []);
        return { applyResult, rollback, verified };
      }
    );

    if (!wrap.acquired) {
      batches.push({
        batch_number: batch.batch_number,
        ok: false,
        failed_writes: 1,
        stopped_early: true,
        reason: wrap.reason || "global_lock_unavailable",
        global_lock: wrap.observability
      });
      stop = true;
      continue;
    }

    const inner = wrap.result || {};
    const stats = inner.applyResult?.stats || {};
    const batchReport = {
      batch_number: batch.batch_number,
      run_id: runId,
      ok: inner.applyResult?.ok === true && (stats.failed || 0) === 0,
      attempted: stats.attempted || 0,
      inserted: stats.inserted || 0,
      updated: stats.updated || 0,
      expired: stats.expired || 0,
      failed_writes: stats.failed || 0,
      stopped_early: stats.stopped_early === true,
      source_absence_hides: 0,
      manifest_hash: weeklyManifest.manifest_hash,
      rollback_manifest_id: inner.rollback?.manifest_record_id || null,
      verified: inner.verified || [],
      reason: inner.reason || inner.applyResult?.reason || null,
      collisions: inner.collisions || [],
      applied: true,
      global_lock: wrap.observability
    };
    if (
      batchReport.ok !== true ||
      batchReport.failed_writes > 0 ||
      (inner.verified || []).some((row) => !row.present || !row.identity_match)
    ) {
      batchReport.ok = false;
      stop = true;
    }
    batches.push(batchReport);
  }

  const stopState = laterRoyalCatchupBatchesMustStop(batches);
  const out = {
    generated_at: new Date().toISOString(),
    master_plan_hash: plan.plan_hash,
    master_plan_size: plan.safe_backlog,
    batch_cap: 30,
    source_absent_active_before: sourceAbsentBefore,
    batches,
    later_batches_stopped: stopState,
    total_inserted: batches.reduce((sum, row) => sum + (row.inserted || 0), 0),
    total_failed: batches.reduce((sum, row) => sum + (row.failed_writes || 0), 0),
    rollback_manifest_ids: batches.map((row) => row.rollback_manifest_id).filter(Boolean)
  };
  const file = path.join(root, "reports", `royal-p3h-controlled-catchup-apply-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ report_file: file, ...out, batches: batches.map((b) => ({
    batch_number: b.batch_number,
    inserted: b.inserted,
    failed: b.failed_writes,
    skipped: b.skipped === true,
    rollback: b.rollback_manifest_id
  })) }, null, 2));
  process.exit(out.total_failed > 0 || batches.some((b) => b.ok === false) ? 2 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
