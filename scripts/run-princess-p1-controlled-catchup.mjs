#!/usr/bin/env node
/**
 * Princess P1 controlled catch-up:
 *   1) official-ID remaps keep existing UUIDs
 *   2) frozen TRUE_NEW inserts + itinerary-label-only safe updates
 *
 * Preview:
 *   node scripts/run-princess-p1-controlled-catchup.mjs
 *
 * Apply:
 *   PRINCESS_WEEKLY_RECONCILIATION_ENABLED=true node scripts/run-princess-p1-controlled-catchup.mjs \
 *     --apply --confirm=PRINCESS-P1-CONTROLLED-CATCHUP
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

const AUDIT_PATH = path.join(root, "reports/princess-p1-remap-audit-2026-09-01.json");
const REPORT_PATH = path.join(root, "reports/princess-p1-controlled-catchup-2026-09-01.json");
const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const CONFIRM = "PRINCESS-P1-CONTROLLED-CATCHUP";
const SELECT =
  "id,status,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,official_url,official_sailing_id,identity_key,external_key,raw_extract,match_confidence";

const { createMaintenanceSupabase, exactCountSupabase, getSupabaseConfig } = require(
  path.join(root, "scripts/lib/supabase-rest.cjs")
);
const remap = require(path.join(root, "netlify/functions/lib/princess-official-id-remap"));
const { runGlobalProtectedMaintenanceWrites } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-global-write-lock"
));
const {
  persistMaintenanceRollbackManifest,
  persistMaintenanceManifest
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-manifests"));
const {
  createMaintenanceRun,
  finalizeMaintenanceRun,
  buildMaintenanceRunStats
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-tracking"));
const { executeWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-cron"
));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const {
  assertPrincessWeeklyMaintenanceEnabled,
  PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));

function parseArgs(argv) {
  return {
    apply: argv.includes("--apply"),
    confirm: argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length) || null
  };
}

async function princessCounts(sb) {
  const active = await exactCountSupabase(
    root,
    "discovered_cruises",
    `cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active`
  );
  return { active: active.count };
}

async function loadPrincessRows(sb) {
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&select=${SELECT}&order=id.asc&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

function compactSummary(summary = {}) {
  return {
    run_id: summary.run_id,
    dry_run: summary.dry_run,
    eligible_total: summary.eligible_total,
    active_production_total: summary.active_production_total,
    proposed_inserts: summary.proposed_inserts,
    proposed_updates: summary.proposed_updates,
    source_absent_active: summary.source_absent_active,
    source_absent_sailing_ids: summary.source_absent_sailing_ids,
    snapshot_id: summary.snapshot_id,
    quality_gate: summary.quality_gate,
    inserts: summary.inserts,
    updates: summary.updates,
    failed_writes: summary.failed_writes,
    rollback_manifest_id: summary.rollback_manifest_id,
    identity_review_sailing_ids: summary.identity_review_sailing_ids || null
  };
}

async function main() {
  getSupabaseConfig(root);
  const args = parseArgs(process.argv.slice(2));
  const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, "utf8"));
  const sb = createMaintenanceSupabase(root);
  const productionRows = await loadPrincessRows(sb);
  const classified = remap.classifyPrincessInsertSet(audit.inserts || [], productionRows);
  const safeUpdates = (audit.safe_updates || []).map((row) => row.official_sailing_id);
  const frozenIds = [
    ...classified.TRUE_NEW.map((row) => row.official_sailing_id),
    ...safeUpdates
  ].sort();

  const report = {
    date: "2026-09-01",
    apply: args.apply === true,
    hashes_match: audit.hashes_match === true,
    source_snapshot: audit.sim1_snapshot,
    classifications: {
      TRUE_NEW: classified.TRUE_NEW.map((row) => row.official_sailing_id),
      OFFICIAL_ID_REMAP: classified.OFFICIAL_ID_REMAP.map((row) => ({
        uuid: row.existing_uuid,
        from: row.previous_official_sailing_id,
        to: row.next_official_sailing_id
      })),
      AMBIGUOUS: classified.AMBIGUOUS.map((row) => row.official_sailing_id)
    },
    frozen_ids: frozenIds,
    counts_before: await princessCounts(sb),
    remap: null,
    frozen_apply: null,
    recon: null,
    ok: false
  };

  if (classified.AMBIGUOUS.length) {
    report.reason = "ambiguous_inserts_present";
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    throw new Error("ambiguous_inserts_present");
  }
  if (classified.OFFICIAL_ID_REMAP.length !== 7 || classified.TRUE_NEW.length !== 2 || safeUpdates.length !== 6) {
    report.reason = "unexpected_classification_counts";
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    throw new Error(report.reason);
  }

  if (!args.apply) {
    report.ok = true;
    report.mode = "preview";
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args.confirm !== CONFIRM) throw new Error("weekly_apply_confirmation_required");
  if (String(process.env.PRINCESS_WEEKLY_RECONCILIATION_ENABLED || "").trim().toLowerCase() !== "true") {
    throw new Error("princess_weekly_reconciliation_disabled");
  }

  const remapRunId = `princess-p1-official-id-remap-${Date.now()}`;
  const remapRun = await createMaintenanceRun(sb, {
    cruiseLineId: PRINCESS_LINE_ID,
    runId: remapRunId,
    runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    triggerType: "p1_official_id_remap",
    stats: { line_slug: "princess-cruises", dry_run: false }
  });

  const remapProtected = await runGlobalProtectedMaintenanceWrites(sb, {
    runId: remapRunId,
    runRecordId: remapRun?.id || null,
    lineSlug: "princess-cruises",
    operation: "princess_p1_official_id_remap",
    underLockRecheck: async () => {
      const live = await loadPrincessRows(sb);
      const liveClassified = remap.classifyPrincessInsertSet(audit.inserts || [], live);
      if (liveClassified.AMBIGUOUS.length) return { ok: false, reason: "under_lock_ambiguous" };
      if (liveClassified.OFFICIAL_ID_REMAP.length !== 7) {
        return { ok: false, reason: "under_lock_remap_count_changed" };
      }
      return { ok: true, live };
    },
    writeFn: async () => {
      const live = await loadPrincessRows(sb);
      const byId = new Map(live.map((row) => [row.id, row]));
      const stats = { inserted: 0, updated: 0, failed: 0, write_details: [] };
      for (const entry of classified.OFFICIAL_ID_REMAP) {
        const existingRow = byId.get(entry.existing_uuid);
        if (!existingRow) {
          stats.failed += 1;
          stats.write_details.push({ error: "existing_row_missing", discovered_cruise_id: entry.existing_uuid });
          return { stats, aborted: true, reason: "existing_row_missing" };
        }
        const result = await remap.applyPrincessOfficialIdRemap(sb, {
          existingRow,
          insert: entry,
          cruiseLineId: PRINCESS_LINE_ID,
          runId: remapRunId
        });
        if (!result.ok) {
          stats.failed += 1;
          stats.write_details.push(result);
          return { stats, aborted: true, reason: result.reason };
        }
        stats.updated += 1;
        stats.write_details.push(result);
      }
      return { stats, aborted: false };
    }
  });

  if (remapProtected.blocked || remapProtected.writeResult?.aborted) {
    await finalizeMaintenanceRun(sb, remapRun?.id, {
      status: "failed",
      stats: { run_id: remapRunId, trigger_type: "p1_official_id_remap", failed_writes: 1 },
      errorMessage: remapProtected.reason || remapProtected.writeResult?.reason || "remap_failed"
    });
    report.remap = { ok: false, blocked: remapProtected.blocked, reason: remapProtected.reason };
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    throw new Error(report.remap.reason || "remap_failed");
  }

  const remapStats = remapProtected.writeResult.stats;
  const remapRollback = await persistMaintenanceRollbackManifest(sb, {
    runId: remapRunId,
    runRecordId: remapRun?.id || null,
    cruiseLineId: PRINCESS_LINE_ID,
    lineSlug: "princess-cruises",
    triggerType: "p1_official_id_remap",
    writeResult: { stats: remapStats, write_details: remapStats.write_details }
  });
  await persistMaintenanceManifest(sb, {
    manifestType: "historical_audit",
    manifest: {
      run_id: remapRunId,
      run_record_id: remapRun?.id || null,
      cruise_line_id: PRINCESS_LINE_ID,
      cruise_line_slug: "princess-cruises",
      trigger_type: "p1_official_id_remap",
      remapped_uuids: classified.OFFICIAL_ID_REMAP.map((row) => row.existing_uuid),
      from_to: classified.OFFICIAL_ID_REMAP.map((row) => ({
        id: row.existing_uuid,
        from: row.previous_official_sailing_id,
        to: row.next_official_sailing_id
      }))
    }
  });
  await finalizeMaintenanceRun(sb, remapRun?.id, {
    status: "completed",
    stats: buildMaintenanceRunStats(
      {
        run_type: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
        run_id: remapRunId,
        trigger_type: "p1_official_id_remap",
        dry_run: false,
        inserts: 0,
        updates: remapStats.updated,
        failed_writes: remapStats.failed,
        inventory_changed: true,
        rollback_manifest_id: remapRollback?.manifest_record_id || null,
        terminal_status: "completed"
      },
      { line_slug: "princess-cruises" }
    )
  });
  report.remap = {
    ok: true,
    run_id: remapRunId,
    run_record_id: remapRun?.id || null,
    rollback_manifest_id: remapRollback?.manifest_record_id || null,
    updated: remapStats.updated,
    failed: remapStats.failed,
    uuids: classified.OFFICIAL_ID_REMAP.map((row) => row.existing_uuid)
  };

  const frozen = await executeWeeklyMaintenance({
    lineSlug: "princess-cruises",
    cruiseLineId: PRINCESS_LINE_ID,
    runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: assertPrincessWeeklyMaintenanceEnabled,
    runMaintenance: (ctx) =>
      runPrincessWeeklyMaintenance({
        ...ctx,
        frozenOfficialSailingIds: frozenIds,
        maxWrites: frozenIds.length
      }),
    dryRun: false,
    maxWrites: frozenIds.length,
    triggerType: "p1_frozen_catchup",
    supabaseClient: sb
  });
  report.frozen_apply = {
    ok: frozen.success === true && frozen.blocked !== true,
    run_id: frozen.run_id,
    run_record_id: frozen.run_record_id,
    reason: frozen.reason || null,
    summary: compactSummary(frozen.summary || {})
  };

  const recon = await executeWeeklyMaintenance({
    lineSlug: "princess-cruises",
    cruiseLineId: PRINCESS_LINE_ID,
    runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: () => {},
    runMaintenance: runPrincessWeeklyMaintenance,
    dryRun: true,
    maxWrites: 30,
    triggerType: "p1_post_write_recon",
    supabaseClient: sb
  });
  report.recon = {
    ok: recon.success === true,
    run_id: recon.run_id,
    run_record_id: recon.run_record_id,
    summary: compactSummary(recon.summary || {})
  };
  report.counts_after = await princessCounts(sb);
  report.ok =
    report.remap.ok === true &&
    report.frozen_apply.ok === true &&
    Number(report.frozen_apply.summary.failed_writes || 0) === 0 &&
    Number(report.recon.summary.proposed_inserts || -1) === 0 &&
    (Number(report.recon.summary.proposed_updates || 0) === 0 ||
      (report.recon.summary.identity_review_sailing_ids || []).length === 0);
  report.outstanding = {
    proposed_inserts: report.recon.summary.proposed_inserts,
    proposed_updates: report.recon.summary.proposed_updates,
    source_absent_active: report.recon.summary.source_absent_active,
    source_absent_sailing_ids: report.recon.summary.source_absent_sailing_ids || []
  };

  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
  process.exit(1);
});
