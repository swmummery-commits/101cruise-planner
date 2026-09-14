#!/usr/bin/env node
/**
 * One controlled HAL recovery APPLY for the small 2-insert weekly backlog.
 * Existing write cap. Global write lock. Rollback manifest. No cap raise.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

process.env.HAL_WEEKLY_RECONCILIATION_ENABLED = "true";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runHalWeeklyMaintenance } = require(
  path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-runner")
);

async function main() {
  getSupabaseConfig(root);
  process.env.HAL_WEEKLY_RECONCILIATION_ENABLED = "true";
  const sb = createMaintenanceSupabase(root);
  const result = await runHalWeeklyMaintenance({
    supabase: sb,
    dryRun: false,
    performWrites: true,
    maxWrites: 100,
    runId: `hal-p3f-controlled-apply-${Date.now()}`,
    triggerType: "manual_recovery"
  });
  const summary = result.summary || {};
  const report = {
    generated_at: new Date().toISOString(),
    ok: result.ok,
    success: result.success,
    reason: result.reason || null,
    writes: (summary.inserts || 0) + (summary.updates || 0),
    inserts: summary.inserts || 0,
    updates: summary.updates || 0,
    failed_writes: summary.failed_writes || 0,
    rollback_manifest_id: summary.rollback_manifest_id || null,
    inventory_changed: summary.inventory_changed === true,
    global_lock: summary.global_lock || result.global_lock || null,
    summary
  };
  const file = path.join(root, "reports", `hal-p3f-controlled-apply-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report_file: file, ...report, summary: undefined }, null, 2));
  process.exit(result.ok === false || (summary.failed_writes || 0) > 0 ? 2 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
