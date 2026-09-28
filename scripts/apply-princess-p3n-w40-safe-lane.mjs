#!/usr/bin/env node
/**
 * P3N W40 controlled Safe Lane apply. Not the old GitHub APPLY workflow.
 * Zero writes unless --apply --confirm=PRINCESS-P3N-W40-SAFE-LANE.
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

process.env.PRINCESS_WEEKLY_RECONCILIATION_ENABLED = "true";

const apply = process.argv.includes("--apply");
const confirm = process.argv.includes("--confirm=PRINCESS-P3N-W40-SAFE-LANE");

const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { executeWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-cron"
));
const { runPrincessWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const {
  PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
  assertPrincessWeeklyMaintenanceEnabled
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const { completePrincessApplyPostWriteLifecycle } = require(path.join(
  root,
  "netlify/functions/lib/princess-weekly-post-write-lifecycle"
));

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const EXPECTED_SNAPSHOT = "ad35440b1d5cb770064764184c470d09b2a48bb89966bddbf3b238bdbea2f713";

async function main() {
  if (apply && !confirm) {
    console.error(JSON.stringify({ ok: false, error: "confirmation_required" }));
    process.exit(1);
  }
  process.env.PRINCESS_WEEKLY_RECONCILIATION_ENABLED = "true";
  const sb = createMaintenanceSupabase(root);
  const dry = await runPrincessWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    writeMode: "weekly_maintenance",
    triggerType: "p3n_w40_preflight"
  });
  const summary = dry.summary || {};
  const officialIds = summary.frozen_source?.official_ids || [];
  if (summary.snapshot_id !== EXPECTED_SNAPSHOT) {
    console.error(JSON.stringify({ ok: false, error: "snapshot_drift", got: summary.snapshot_id }));
    process.exit(1);
  }
  if (summary.unexplained_active_rows !== 0) {
    console.error(JSON.stringify({ ok: false, error: "unexplained_active_rows", count: summary.unexplained_active_rows }));
    process.exit(1);
  }

  const classified = await runPrincessWeeklyMaintenance({
    supabase: sb,
    dryRun: true,
    performWrites: false,
    writeMode: "weekly_maintenance",
    triggerType: "p3n_w40_two_snapshot_classify",
    snapshotAOfficialIds: officialIds,
    snapshotBOfficialIds: officialIds
  });
  const products = classified.manifest?.products || [];
  const safeIds = products
    .filter((p) => p.proposed_action === "update_safe_metadata_allowed")
    .map((p) => p.official_princess_sailing_id);
  const remapIds = products
    .filter((p) => p.proposed_action === "remap_official_id_allowed")
    .map((p) => p.official_princess_sailing_id);
  const frozen = [...safeIds, ...remapIds];
  const plan = {
    snapshot_id: classified.summary?.snapshot_id,
    unexplained: classified.summary?.unexplained_active_rows,
    remaps: classified.summary?.remap_classifications || [],
    safe_ids: safeIds,
    remap_ids: remapIds,
    frozen_count: frozen.length
  };
  if (!apply) {
    console.log(JSON.stringify({ ok: true, apply: false, discovered_cruises_writes: 0, plan }, null, 2));
    process.exit(0);
  }
  if (frozen.length === 0 || frozen.length > 30) {
    console.error(JSON.stringify({ ok: false, error: "frozen_safe_lane_invalid", plan }));
    process.exit(1);
  }

  const result = await executeWeeklyMaintenance({
    lineSlug: "princess-cruises",
    cruiseLineId: PRINCESS_LINE_ID,
    runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: assertPrincessWeeklyMaintenanceEnabled,
    runMaintenance: (context) =>
      runPrincessWeeklyMaintenance({
        ...context,
        writeMode: "weekly_maintenance",
        snapshotAOfficialIds: officialIds,
        snapshotBOfficialIds: officialIds,
        frozenOfficialSailingIds: frozen
      }),
    dryRun: false,
    maxWrites: 30,
    triggerType: "p3n_w40_controlled_safe_lane",
    postWriteLifecycle: completePrincessApplyPostWriteLifecycle
  });

  const outPath = path.join(
    root,
    "reports",
    `princess-p3n-w40-safe-lane-apply-${Date.now()}.json`
  );
  fs.writeFileSync(outPath, JSON.stringify({ plan, result }, null, 2));
  console.log(JSON.stringify({
    ok: result.success === true || result.review_required === true,
    outPath,
    inserts: result.summary?.inserts ?? null,
    updates: result.summary?.updates ?? null,
    failed_writes: result.summary?.failed_writes ?? null,
    terminal_status: result.summary?.terminal_status || result.terminal_status,
    run_record_id: result.run_record_id || result.summary?.run_record_id || null,
    rollback_manifest_id: result.summary?.rollback_manifest_id || null
  }, null, 2));
  process.exit(result.success === true || result.review_required === true ? 0 : 1);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
