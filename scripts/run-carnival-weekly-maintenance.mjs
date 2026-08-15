#!/usr/bin/env node
/**
 * Carnival Cruise Line weekly maintenance — dry-run by default.
 *
 *   node scripts/run-carnival-weekly-maintenance.mjs
 *   node scripts/run-carnival-weekly-maintenance.mjs --dry-run
 *   CARNIVAL_DISCOVERY_WRITE_ENABLED=true node scripts/run-carnival-weekly-maintenance.mjs --apply
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

const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const { runCclWeeklyMaintenance, CCL_LINE_SLUG, CCL_MAX_WEEKLY_WRITES } = require(path.join(
  root,
  "netlify/functions/lib/carnival-weekly-maintenance"
));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));
const { redactSecrets } = require(path.join(root, "netlify/functions/lib/carnival-weekly-auth"));

const REPORT_DIR = path.join(root, "reports");

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, maxWrites: CCL_MAX_WEEKLY_WRITES, today: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--apply") {
      args.apply = true;
      args.dryRun = false;
    }
    if (arg.startsWith("--max-writes=")) {
      args.maxWrites = Number(arg.slice("--max-writes=".length));
    }
    if (arg.startsWith("--today=")) {
      args.today = String(arg.slice("--today=".length)).trim();
    }
  }
  return args;
}

function writeReport(name, data) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, name);
  fs.writeFileSync(reportPath, `${JSON.stringify(data, null, 2)}\n`);
  return reportPath;
}

async function main() {
  getSupabaseConfig(root);
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const today = args.today || perthCalendarDate();
  const runId = `ccl-weekly-${today.replace(/-/g, "")}-${Date.now()}`;
  const sb = createMaintenanceSupabase(root);

  const result = await runCclWeeklyMaintenance({
    supabase: sb,
    dryRun: args.dryRun,
    performWrites: args.apply,
    runId,
    today,
    maxWrites: args.maxWrites
  });

  const report = redactSecrets({
    mode: args.apply ? "apply" : "dry_run",
    line_slug: CCL_LINE_SLUG,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    run_id: result.run_id || runId,
    success: result.success,
    blocked: result.blocked === true,
    reason: result.reason || null,
    dry_run: result.dry_run,
    summary: result.summary || null,
    quality_gate: result.summary?.quality_gate || null,
    apply: result.apply || null
  });

  report.report_path = writeReport(
    `carnival-weekly-maintenance-${args.apply ? "apply" : "dry-run"}-${today}-${Date.now()}.json`,
    report
  );

  console.log(JSON.stringify(report, null, 2));

  if (result.success === false || result.blocked) {
    process.exit(result.blocked ? 2 : 1);
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        mode: process.argv.includes("--apply") ? "apply" : "dry_run",
        status: "failed",
        error: err.code || err.message || String(err)
      },
      null,
      2
    )
  );
  process.exit(1);
});
