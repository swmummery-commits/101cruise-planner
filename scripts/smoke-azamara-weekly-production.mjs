#!/usr/bin/env node
/**
 * Production Azamara weekly maintenance Netlify smoke (launcher → background).
 *
 *   node scripts/smoke-azamara-weekly-production.mjs
 *   node scripts/smoke-azamara-weekly-production.mjs --apply
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { spawnSync } from "child_process";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = path.join(root, "reports");

function loadEnv() {
  try {
    const dotenv = require("dotenv");
    dotenv.config({ path: path.join(root, ".env") });
    dotenv.config({ path: path.join(root, ".env.local") });
  } catch {
    /* optional */
  }
}

function parseArgs(argv) {
  return { apply: argv.includes("--apply") };
}

loadEnv();

const siteUrl = String(
  process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app"
).replace(/\/$/, "");

async function resolveSecret() {
  const local = String(process.env.DISCOVERY_CRON_SECRET || "").trim();
  if (local) return local;
  const netlifyBin = path.join(root, "node_modules", ".bin", "netlify");
  const commands = [
    fs.existsSync(netlifyBin) ? [netlifyBin] : null,
    ["npx", "--yes", "netlify-cli@latest"]
  ].filter(Boolean);
  for (const cmd of commands) {
    const pull = spawnSync(cmd[0], [...cmd.slice(1), "env:get", "DISCOVERY_CRON_SECRET", "--context", "production"], {
      cwd: root,
      encoding: "utf8",
      env: process.env
    });
    if (pull.status === 0) {
      const v = String(pull.stdout || "").trim();
      if (v && !/No project id found|TextHTTPError|not configured/i.test(v)) return v;
    }
  }
  return "";
}

async function pollMaintenanceRun({ dispatchId, startedAfter, timeoutMs = 900000 }) {
  const { createMaintenanceSupabase } = require("./lib/supabase-rest.cjs");
  const sb = createMaintenanceSupabase(root);
  const line = (await sb("ci_cruise_lines?slug=eq.azamara&select=id&limit=1"))[0];
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const runs = await sb(
      `cruise_discovery_runs?cruise_line_id=eq.${line.id}&scope=eq.cruise_line&order=created_at.desc&limit=10&select=id,status,stats,finished_at,created_at`
    );
    const match = (runs || []).find((r) => {
      const created = new Date(r.created_at).getTime();
      if (Number.isFinite(startedAfter) && created <= startedAfter) return false;
      if (r.stats?.run_type !== "azamara_weekly_maintenance") return false;
      if (dispatchId && r.stats?.dispatch_id === dispatchId) return true;
      return Number.isFinite(startedAfter) && created > startedAfter;
    });
    if (match?.status === "completed" || match?.status === "failed") {
      return match;
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const secret = await resolveSecret();
  if (!secret) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "DISCOVERY_CRON_SECRET unavailable (local env or netlify env:get)",
        writes_performed: 0
      })
    );
    process.exit(1);
  }

  // Scheduled launchers reject direct HTTP in production (403). Smoke the deployed
  // background worker — the same path the launcher dispatches to after cron auth.
  const endpoint = `${siteUrl}/.netlify/functions/azamara-weekly-maintenance-background`;
  const dispatchId = `azamara-phase7-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify({
      dry_run: !args.apply,
      trigger_type: args.apply ? "phase7_deployed_apply_smoke" : "phase7_deployed_dry_run_smoke",
      dispatch_id: dispatchId
    })
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { success: false, parseError: true, rawPreview: text.slice(0, 400) };
  }

  let maintenanceRun = null;
  let summary = body.summary || {};
  const resolvedDispatchId = body.dispatch_id || dispatchId;
  if (response.status === 202 || response.status === 200) {
    maintenanceRun = await pollMaintenanceRun({
      dispatchId: resolvedDispatchId,
      startedAfter: started - 5000
    });
    summary = maintenanceRun?.stats || summary;
  }

  const writesPerformed = Number(summary.writes_performed ?? body.writes_performed ?? 0);
  const wouldInsert = Number(summary.would_insert ?? summary.proposed_inserts ?? 0);
  const wouldUpdate = Number(summary.would_update ?? summary.proposed_updates ?? 0);
  const identityReview = Number(summary.proposed_identity_review ?? summary.proposed_updates_identity_review ?? 0);
  const dryRun = args.apply ? false : body.dry_run ?? summary.dry_run ?? true;

  const report = {
    ok:
      (response.status === 202 || response.status === 200) &&
      maintenanceRun?.status === "completed" &&
      summary.success !== false &&
      wouldInsert <= 10 &&
      wouldUpdate <= 10 &&
      identityReview === 0,
    status: response.status,
    endpoint: "azamara-weekly-maintenance-background",
    execution: "deployed_background_worker",
    dispatch_id: resolvedDispatchId ?? null,
    maintenance_run_status: maintenanceRun?.status ?? null,
    site_url: siteUrl,
    dry_run: dryRun,
    writes_performed: writesPerformed,
    would_insert: wouldInsert,
    would_update: wouldUpdate,
    proposed_identity_review: identityReview,
    production_official: summary.production_official ?? null,
    recognised_eligible: summary.recognised_eligible ?? null,
    source_absent_sailing_ids: summary.source_absent_sailing_ids ?? null,
    global_lock: summary.global_lock ?? null,
    elapsed_ms: Date.now() - started
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(REPORT_DIR, `azamara-phase7-netlify-weekly-smoke-${stamp}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ report, launcher_body: body, maintenance_run: maintenanceRun }, null, 2)
  );
  report.report_path = reportPath;

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message || String(e), writes_performed: 0 }));
  process.exit(1);
});
