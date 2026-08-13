#!/usr/bin/env node
/**
 * Royal Caribbean Prompt 9 — Netlify runtime architecture proof.
 *
 *   node scripts/run-royal-caribbean-prompt9-proof.mjs
 *   node scripts/run-royal-caribbean-prompt9-proof.mjs --skip-netlify
 *   node scripts/run-royal-caribbean-prompt9-proof.mjs --skip-local
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
  require("dotenv").config({ path: path.join(root, ".env.local") });
} catch {
  /* optional */
}

const BRANCH_URL = "https://feat-royal-caribbean-final-catchup--admirable-tiramisu-d4da8a.netlify.app";
const PROOF_MODE = "branch_runtime_proof";
const CONFIRMATION = "RC_BRANCH_RUNTIME_PROOF_2026";
const PROOF_BODY = { mode: PROOF_MODE, confirmation: CONFIRMATION };

const { runRoyalCaribbeanWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const { ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING } = require(path.join(
  root,
  "netlify/functions/lib/royal-caribbean-weekly-health"
));
const { MAINTENANCE_SCHEDULES } = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));

function parseArgs(argv) {
  return {
    skipNetlify: argv.includes("--skip-netlify"),
    skipLocal: argv.includes("--skip-local"),
    pollSeconds: Number(argv.find((a) => a.startsWith("--poll="))?.split("=")[1] || 300),
    output: path.join(
      root,
      `reports/royal-caribbean-prompt9-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`
    )
  };
}

function gitCheckpoint() {
  try {
    return {
      branch: execSync("git branch --show-current", { cwd: root, encoding: "utf8" }).trim(),
      head: execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim(),
      origin_main: execSync("git rev-parse origin/main", { cwd: root, encoding: "utf8" }).trim()
    };
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

function createReadOnlySupabase(rootDir) {
  const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
  const inner = createMaintenanceSupabase(rootDir);
  return async function supabase(restPath, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
      const err = new Error(`Royal Caribbean Prompt 9 blocked mutating ${method} ${restPath}`);
      err.code = "royal_caribbean_readonly_supabase";
      throw err;
    }
    return inner(restPath, options);
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function invokeBranchSmoke() {
  const endpoint = `${BRANCH_URL}/.netlify/functions/royal-caribbean-discovery-smoke`;
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(PROOF_BODY)
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, rawPreview: text.slice(0, 300) };
  }
  return {
    endpoint,
    http_status: response.status,
    elapsed_ms: Date.now() - started,
    body,
    royal_caribbean_netlify_basic_smoke_ok:
      response.status === 200 &&
      body.ok === true &&
      body.graphql_valid === true &&
      body.writes_performed === false &&
      body.authoritative_enumeration === false
  };
}

async function invokeBranchLauncher(runId) {
  const endpoint = `${BRANCH_URL}/.netlify/functions/royal-caribbean-runtime-proof-launcher`;
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...PROOF_BODY, run_id: runId })
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, rawPreview: text.slice(0, 300) };
  }
  return {
    endpoint,
    http_status: response.status,
    elapsed_ms: Date.now() - started,
    body
  };
}

async function pollBackgroundResult(runId, maxWaitMs) {
  const endpoint = `${BRANCH_URL}/.netlify/functions/royal-caribbean-runtime-proof-result`;
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const url = `${endpoint}?run_id=${encodeURIComponent(runId)}&mode=${PROOF_MODE}&confirmation=${encodeURIComponent(CONFIRMATION)}`;
    const response = await fetch(url, { method: "GET" });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { ok: false, rawPreview: text.slice(0, 300) };
    }
    if (response.status === 200 && body.status === "completed" && body.result) {
      return {
        ok: true,
        http_status: response.status,
        waited_ms: Date.now() - started,
        result: body.result
      };
    }
    await sleep(5000);
  }
  return { ok: false, waited_ms: Date.now() - started, error: "background_result_timeout" };
}

async function verifyUnauthenticatedRejected() {
  const endpoint = `${BRANCH_URL}/.netlify/functions/royal-caribbean-discovery-smoke`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "production_read_only" })
  });
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = {};
  }
  return {
    http_status: response.status,
    rejected: response.status === 401 || response.status === 403,
    body
  };
}

async function runLocalDryRun() {
  const sb = createReadOnlySupabase(root);
  const started = Date.now();
  const result = await runRoyalCaribbeanWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    supabase: sb,
    authoritativeEnumeration: true
  });
  return {
    elapsed_ms: Date.now() - started,
    summary: result.summary || {},
    ok: result.ok === true
  };
}

function compareLocalNetlify(local, netlify) {
  const fields = [
    ["union_sailing_identities", "union_sailing_identities"],
    ["fleet_ship_count", "fleet_ship_count"],
    ["recognised_existing_eligible_sailings", "recognised_existing_eligible_sailings"],
    ["proposed_inserts", "proposed_inserts"],
    ["source_absent_active", "source_absent_active"],
    ["production_cutoff_candidates", "production_cutoff_candidates"],
    ["incomplete_skipped", "incomplete_skipped"],
    ["cruisetours_excluded", "cruisetours_excluded"]
  ];
  const deltas = [];
  for (const [localKey, netlifyKey] of fields) {
    const lv = local[localKey] ?? local.summary?.[localKey];
    let nv = netlify[netlifyKey];
    if (netlifyKey === "production_cutoff_candidates" && Array.isArray(nv)) nv = nv.length;
    if (lv != null && nv != null && lv !== nv) {
      deltas.push({ field: localKey, local: lv, netlify: nv, delta: nv - lv });
    }
  }
  const largeUnexplained = deltas.filter((d) => {
    if (d.field === "union_sailing_identities" || d.field === "proposed_inserts") return Math.abs(d.delta) > 10;
    if (d.field === "recognised_existing_eligible_sailings") return Math.abs(d.delta) > 5;
    return Math.abs(d.delta) > 20;
  });
  return {
    deltas,
    local_netlify_source_consistency_ok: largeUnexplained.length === 0
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const checkpoint = gitCheckpoint();
  const runId = `royal-caribbean-prompt9-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const report = {
    prompt: 9,
    checkpoint,
    branch_url: BRANCH_URL,
    run_id: runId,
    architecture: {
      design: "scheduled launcher → background worker",
      synchronous_smoke: "bounded connectivity only (no authoritative enumeration)",
      background_worker: "royal-caribbean-weekly-maintenance-background",
      launcher: "royal-caribbean-weekly-maintenance-cron",
      schedule_registered: MAINTENANCE_SCHEDULES.royal_caribbean_weekly.schedule_registered
    },
    basic_smoke: null,
    background_proof: null,
    launcher: null,
    local_dry_run: null,
    consistency: null,
    cleanup_verification: null,
    write_ceiling_review: ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING,
    production_writes: {
      cruise_inserts: 0,
      cruise_updates: 0,
      cruise_deletes: 0,
      expiry_hide_changes: 0,
      ship_changes: 0,
      port_changes: 0,
      alias_changes: 0,
      destination_changes: 0,
      legacy_row_changes: 0,
      source_absence_state_writes: 0
    },
    flags: {
      royal_caribbean_netlify_basic_smoke_ok: false,
      royal_caribbean_netlify_background_runtime_ok: false,
      local_netlify_source_consistency_ok: false
    },
    recommendation: "NOT READY FOR CONTROLLED WEEKLY ACTIVATION"
  };

  if (!args.skipLocal) {
    console.log("Running local read-only weekly dry-run...");
    report.local_dry_run = await runLocalDryRun();
  }

  if (!args.skipNetlify) {
    console.log("Invoking Netlify bounded smoke...");
    report.basic_smoke = await invokeBranchSmoke();
    report.flags.royal_caribbean_netlify_basic_smoke_ok =
      report.basic_smoke.royal_caribbean_netlify_basic_smoke_ok === true;

    if (!report.flags.royal_caribbean_netlify_basic_smoke_ok) {
      report.recommendation = "NOT READY FOR CONTROLLED WEEKLY ACTIVATION";
      report.blocker = "basic_netlify_smoke_failed";
      fs.writeFileSync(args.output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    console.log("Dispatching background worker via proof launcher...");
    report.launcher = await invokeBranchLauncher(runId);
    if (report.launcher.http_status !== 202 || report.launcher.body?.ok !== true) {
      report.blocker = "launcher_dispatch_failed";
      fs.writeFileSync(args.output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    console.log(`Polling background result (up to ${args.pollSeconds}s)...`);
    const polled = await pollBackgroundResult(runId, args.pollSeconds * 1000);
    report.background_proof = polled;
    const compact = polled.result || {};
    report.flags.royal_caribbean_netlify_background_runtime_ok =
      polled.ok === true &&
      compact.actual_writes === 0 &&
      compact.royal_caribbean_netlify_background_runtime_ok === true;

    if (report.local_dry_run?.summary && compact) {
      report.consistency = compareLocalNetlify(report.local_dry_run.summary, compact);
      report.flags.local_netlify_source_consistency_ok =
        report.consistency.local_netlify_source_consistency_ok === true;
    }
  }

  const ready =
    report.flags.royal_caribbean_netlify_basic_smoke_ok &&
    report.flags.royal_caribbean_netlify_background_runtime_ok &&
    report.flags.local_netlify_source_consistency_ok !== false;

  report.recommendation = ready
    ? "READY FOR CONTROLLED WEEKLY ACTIVATION"
    : "NOT READY FOR CONTROLLED WEEKLY ACTIVATION";
  if (!ready && !report.blocker) {
    report.blocker = "netlify_background_or_consistency_failed";
  }

  fs.writeFileSync(args.output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!ready) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});

export { verifyUnauthenticatedRejected };
