#!/usr/bin/env node
/**
 * Production Seabourn weekly maintenance Netlify smoke (launcher → background).
 *
 *   npm run smoke:seabourn-weekly-production
 *
 * Uses Netlify CLI linked-site env when DISCOVERY_CRON_SECRET is not in local .env.
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

loadEnv();

const siteUrl = String(
  process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app"
).replace(/\/$/, "");

async function resolveSecret() {
  const local = String(process.env.DISCOVERY_CRON_SECRET || "").trim();
  if (local) return local;
  const pull = spawnSync("npx", ["netlify", "env:get", "DISCOVERY_CRON_SECRET"], {
    cwd: root,
    encoding: "utf8",
    env: process.env
  });
  if (pull.status === 0) {
    const v = String(pull.stdout || "").trim();
    if (v) return v;
  }
  return "";
}

async function pollMaintenanceRun({ dispatchId, timeoutMs = 900000 }) {
  const { createMaintenanceSupabase } = require("./lib/supabase-rest.cjs");
  const sb = createMaintenanceSupabase(root);
  const line = (await sb("ci_cruise_lines?slug=eq.seabourn-cruise-line&select=id&limit=1"))[0];
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const runs = await sb(
      `cruise_discovery_runs?cruise_line_id=eq.${line.id}&scope=eq.cruise_line&order=created_at.desc&limit=5&select=id,status,stats,finished_at,created_at`
    );
    const match =
      (runs || []).find((r) => r.stats?.dispatch_id === dispatchId) ||
      (runs || []).find((r) => r.stats?.run_type === "seabourn_weekly_maintenance");
    if (match?.status === "completed" || match?.status === "failed") {
      return match;
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  return null;
}

async function main() {
  if (String(process.env.SEABOURN_DISCOVERY_WRITE_ENABLED || "").toLowerCase() === "true") {
    throw new Error("SEABOURN_DISCOVERY_WRITE_ENABLED must not be true for weekly smoke");
  }

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

  const endpoint = `${siteUrl}/.netlify/functions/seabourn-weekly-maintenance-cron`;
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify({ dry_run: true, trigger_type: "prompt7a_netlify_smoke" })
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
  if (response.status === 202 && body.dispatch_id) {
    maintenanceRun = await pollMaintenanceRun({ dispatchId: body.dispatch_id });
    summary = maintenanceRun?.stats || summary;
  }

  const writesPerformed = Number(summary.writes_performed ?? body.writes_performed ?? 0);
  const report = {
    ok:
      (response.status === 202 || response.status === 200) &&
      body.success === true &&
      (body.dry_run === true || summary.dry_run === true) &&
      writesPerformed === 0 &&
      summary.source_quality_gate?.passed !== false,
    status: response.status,
    endpoint: "seabourn-weekly-maintenance-cron",
    execution: response.status === 202 ? "launcher_dispatch_background" : "inline",
    dispatch_id: body.dispatch_id ?? null,
    maintenance_run_status: maintenanceRun?.status ?? null,
    site_url: siteUrl,
    dry_run: body.dry_run ?? summary.dry_run ?? true,
    writes_performed: writesPerformed,
    num_found: summary.official_source_total ?? null,
    eligible_total: summary.eligible_total ?? null,
    recognised_existing_eligible: summary.recognised_existing_eligible ?? null,
    outstanding_eligible_inserts: summary.outstanding_eligible_inserts ?? null,
    source_absent_observed: summary.source_absent_observed ?? null,
    source_absent_actionable: summary.source_absent_actionable ?? null,
    proposed_updates: summary.proposed_updates ?? null,
    proposed_updates_identity_review: summary.proposed_updates_identity_review ?? null,
    snapshot_id: summary.snapshot_id ?? null,
    elapsed_ms: Date.now() - started
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(REPORT_DIR, `seabourn-prompt7a-netlify-weekly-smoke-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ report, launcher_body: body, maintenance_run: maintenanceRun }, null, 2));
  report.report_path = reportPath;

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message || String(e), writes_performed: 0 }));
  process.exit(1);
});
