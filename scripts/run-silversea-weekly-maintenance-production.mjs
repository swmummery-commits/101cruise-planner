#!/usr/bin/env node
/**
 * Silversea weekly maintenance — production dry-run and bounded apply.
 *
 *   npm run silversea:weekly-maintenance:plan
 *   node scripts/run-silversea-weekly-maintenance-production.mjs --dry-run
 *   node scripts/run-silversea-weekly-maintenance-production.mjs --apply --confirm=SILVERSEA-WEEKLY-MAINTENANCE
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {}

const REPORT_DIR = path.join(root, "reports");
const CONFIRM = "SILVERSEA-WEEKLY-MAINTENANCE";

const { runSilverseaWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/silversea-weekly-maintenance"
));
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { indexExistingSilverseaRecords } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const { productionInventoryBreakdown } = require(path.join(
  root,
  "netlify/functions/lib/silversea-m6-weekly-maintenance-orchestration"
));

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function parseArgs(argv) {
  const args = { apply: false, confirm: null, dryRun: true, today: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--confirm=")) args.confirm = arg.slice("--confirm=".length);
    if (arg === "--dry-run") args.dryRun = true;
    if (arg.startsWith("--today=")) args.today = arg.slice("--today=".length);
  }
  if (args.apply) args.dryRun = false;
  return args;
}

export async function runSilverseaWeeklyMaintenanceProduction(options = {}) {
  const startedAt = new Date().toISOString();
  const runId = options.runId || `silversea-weekly-maintenance-${startedAt.replace(/[:.]/g, "-")}`;
  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.silversea-cruises&select=id&limit=1`))?.[0];
  const beforeIdx = await indexExistingSilverseaRecords(sb, line.id);
  const productionBefore = productionInventoryBreakdown(beforeIdx.rows);

  const report = await runSilverseaWeeklyMaintenance({
    supabase: sb,
    dryRun: options.dryRun !== false,
    performWrites: options.performWrites === true,
    runId,
    today: options.today || undefined
  });

  const afterIdx = await indexExistingSilverseaRecords(sb, line.id);
  const productionAfter = productionInventoryBreakdown(afterIdx.rows);

  const full = {
    ...report,
    git: { sha: git("git rev-parse HEAD"), branch: git("git branch --show-current") },
    production_before: productionBefore,
    production_after: productionAfter,
    production_row_delta:
      productionBefore.total === productionAfter.total &&
      productionBefore.official_total === productionAfter.official_total &&
      productionBefore.legacy === productionAfter.legacy &&
      productionBefore.duplicate_official_ids === productionAfter.duplicate_official_ids
        ? 0
        : 1
  };

  if (!options.skipReportWrite) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `${runId}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(full, null, 2)}\n`);
    full.report_path = reportPath;
  }

  return full;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.apply && args.confirm !== CONFIRM) {
    console.error(JSON.stringify({ ok: false, error: "confirm_token_required" }, null, 2));
    process.exit(1);
  }
  const report = await runSilverseaWeeklyMaintenanceProduction({
    dryRun: args.dryRun,
    performWrites: args.apply,
    today: args.today || undefined
  });
  console.log(
    JSON.stringify(
      {
        ok: report.status !== "FAILED" && report.status !== "BLOCKED",
        mode: report.mode,
        status: report.status,
        plan_counts: report.plan?.counts,
        writes: report.writes,
        production_row_delta: report.production_row_delta,
        report: report.report_path
      },
      null,
      2
    )
  );
  if (report.status === "FAILED") process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
