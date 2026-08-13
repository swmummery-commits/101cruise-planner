#!/usr/bin/env node
/**
 * Royal Caribbean International weekly maintenance — Prompt 2 dry-run only.
 *
 *   npm run royal-caribbean:weekly-maintenance
 *   node scripts/run-royal-caribbean-weekly-maintenance.mjs
 *
 * Production writes are refused. --apply is rejected.
 * Uses a GET-only Supabase wrapper and skips maintenance locks/run records.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

try {
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runRoyalCaribbeanWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const { ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED } = require(path.join(
  root,
  "netlify/functions/lib/royal-caribbean-discovery-mode"
));
const { isRoyalCaribbeanWeeklyReconciliationEnabled } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));

function parseArgs(argv) {
  const args = {
    apply: false,
    output: path.join(root, "reports/royal-caribbean-prompt3-dry-run.json")
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") args.apply = true;
    else if (arg.startsWith("--output=")) args.output = path.resolve(arg.slice("--output=".length));
  }
  return args;
}

function createReadOnlySupabase(rootDir) {
  const inner = createMaintenanceSupabase(rootDir);
  return async function supabase(restPath, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
      const err = new Error(`Royal Caribbean dry-run blocked mutating ${method} ${restPath}`);
      err.code = "royal_caribbean_readonly_supabase";
      throw err;
    }
    return inner(restPath, options);
  };
}

function slimManifest(manifest) {
  const products = manifest?.products || [];
  const byAction = {};
  for (const p of products) {
    const action = p.proposed_action || "unknown";
    byAction[action] = (byAction[action] || 0) + 1;
  }
  return {
    generated_at: manifest?.generated_at || null,
    mode: manifest?.mode || null,
    writes_performed: manifest?.writes_performed === true,
    actual_writes: manifest?.actual_writes || 0,
    product_count: products.length,
    proposed_action_counts: byAction,
    insert_sample: products.filter((p) => p.proposed_action === "insert_active").slice(0, 25),
    update_sample: products.filter((p) => p.proposed_action === "update_exact_legacy_match").slice(0, 10),
    legacy_html_discovery_artefacts: manifest?.legacy_html_discovery_artefacts || []
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.apply) {
    throw new Error("Royal Caribbean Prompt 2 refuses --apply. Production writes remain disabled.");
  }
  if (ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED) {
    throw new Error("ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED must be false for this dry-run");
  }
  if (isRoyalCaribbeanWeeklyReconciliationEnabled()) {
    throw new Error("ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED must be false for this dry-run");
  }

  const startedAt = new Date().toISOString();
  const { url } = getSupabaseConfig(root);
  const sb = createReadOnlySupabase(root);
  const result = await runRoyalCaribbeanWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    skipLock: true,
    supabase: sb,
    triggerType: "prompt2_dry_run",
    runId: `royal-caribbean-prompt2-${startedAt.replace(/[:.]/g, "-")}`
  });

  const report = {
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    mode: "royal_caribbean_prompt2_dry_run",
    read_only: true,
    supabase_url: url,
    write_flags: {
      ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED: false,
      ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED: false
    },
    ok: result.ok === true,
    reason: result.reason || null,
    summary: result.summary || null,
    sample_stats: result.sample_stats || null,
    page_log: result.page_log || [],
    manifest: slimManifest(result.manifest),
    actual_writes: 0
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: report.ok,
    output: args.output,
    itinerary_groups: report.summary?.itinerary_groups,
    unique_sailings: report.summary?.unique_sailing_ids,
    proposed_inserts: report.summary?.proposed_inserts,
    proposed_updates: report.summary?.proposed_updates,
    actual_writes: 0,
    reconciliation_arithmetic_ok: report.summary?.reconciliation_arithmetic_ok,
    reason: report.reason
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
