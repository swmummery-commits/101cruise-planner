#!/usr/bin/env node
/**
 * Production read-only Seabourn weekly maintenance smoke (Netlify infrastructure).
 *
 *   npm run smoke:seabourn-weekly-production
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

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
const secret = String(process.env.DISCOVERY_CRON_SECRET || "").trim();

async function main() {
  if (!secret) {
    console.error(JSON.stringify({ ok: false, error: "DISCOVERY_CRON_SECRET required", writes_performed: 0 }));
    process.exit(1);
  }
  if (String(process.env.SEABOURN_DISCOVERY_WRITE_ENABLED || "").toLowerCase() === "true") {
    throw new Error("SEABOURN_DISCOVERY_WRITE_ENABLED must not be true for weekly smoke");
  }

  const endpoint = `${siteUrl}/.netlify/functions/seabourn-weekly-maintenance-cron`;
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify({ dry_run: true, trigger_type: "prompt7_netlify_smoke" })
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { success: false, parseError: true, rawPreview: text.slice(0, 400) };
  }

  const summary = body.summary || {};
  const report = {
    ok:
      response.status === 200 &&
      body.success === true &&
      body.dry_run === true &&
      Number(body.writes_performed || 0) === 0 &&
      (summary.source_quality_gate?.passed !== false),
    status: response.status,
    endpoint: "seabourn-weekly-maintenance-cron",
    site_url: siteUrl,
    dry_run: body.dry_run,
    writes_performed: body.writes_performed ?? 0,
    num_found: summary.official_source_total ?? null,
    eligible_total: summary.eligible_total ?? null,
    recognised_existing_eligible: summary.recognised_existing_eligible ?? null,
    outstanding_eligible_inserts: summary.outstanding_eligible_inserts ?? null,
    source_absent_observed: summary.source_absent_observed ?? null,
    source_absent_actionable: summary.source_absent_actionable ?? null,
    proposed_updates: summary.proposed_updates ?? null,
    snapshot_id: summary.snapshot_id ?? null,
    elapsed_ms: Date.now() - started
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(REPORT_DIR, `seabourn-prompt7-netlify-weekly-smoke-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ report, body }, null, 2));
  report.report_path = reportPath;

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message || String(e), writes_performed: 0 }));
  process.exit(1);
});
