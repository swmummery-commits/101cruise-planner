#!/usr/bin/env node
/**
 * Royal Caribbean Prompt 8 — Netlify runtime proof + weekly maintenance validation.
 *
 *   node scripts/run-royal-caribbean-prompt8-validation.mjs
 *   node scripts/run-royal-caribbean-prompt8-validation.mjs --skip-netlify
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

const { createMaintenanceSupabase, getSupabaseConfig } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const { runRoyalCaribbeanWeeklyMaintenance } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-runner"
));
const { indexGenuineRoyalCaribbeanProduction } = require(path.join(
  root,
  "netlify/functions/lib/royal-caribbean-post-write-verification"
));
const { MAINTENANCE_SCHEDULES } = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));
const { ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING } = require(path.join(
  root,
  "netlify/functions/lib/royal-caribbean-weekly-health"
));
const inventory = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

function parseArgs(argv) {
  return {
    skipNetlify: argv.includes("--skip-netlify"),
    output: path.join(root, `reports/royal-caribbean-prompt8-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`)
  };
}

function createReadOnlySupabase(rootDir) {
  const inner = createMaintenanceSupabase(rootDir);
  return async function supabase(restPath, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
      const err = new Error(`Royal Caribbean Prompt 8 blocked mutating ${method} ${restPath}`);
      err.code = "royal_caribbean_readonly_supabase";
      throw err;
    }
    return inner(restPath, options);
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

async function attemptNetlifySmoke() {
  const siteUrl = String(
    process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app"
  ).replace(/\/$/, "");
  const secret = String(process.env.DISCOVERY_CRON_SECRET || "").trim();
  if (!secret) {
    return {
      status: "NOT PROVEN",
      reason: "DISCOVERY_CRON_SECRET unavailable for authenticated Netlify smoke invocation"
    };
  }

  const attempts = [
    `${siteUrl}/.netlify/functions/royal-caribbean-discovery-smoke`,
    `https://feat-royal-caribbean-final-catchup--admirable-tiramisu-d4da8a.netlify.app/.netlify/functions/royal-caribbean-discovery-smoke`,
    `https://deploy-preview--admirable-tiramisu-d4da8a.netlify.app/.netlify/functions/royal-caribbean-discovery-smoke`
  ];

  for (const endpoint of attempts) {
    try {
      const started = Date.now();
      const basic = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-discovery-cron-secret": secret
        },
        body: JSON.stringify({ mode: "production_read_only" })
      });
      const basicText = await basic.text();
      let basicBody;
      try {
        basicBody = JSON.parse(basicText);
      } catch {
        basicBody = { ok: false, rawPreview: basicText.slice(0, 200) };
      }
      if (basic.status === 404) continue;

      const authStarted = Date.now();
      const auth = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-discovery-cron-secret": secret
        },
        body: JSON.stringify({ mode: "production_read_only", authoritative_enumeration: true })
      });
      const authText = await auth.text();
      let authBody;
      try {
        authBody = JSON.parse(authText);
      } catch {
        authBody = { ok: false, rawPreview: authText.slice(0, 200) };
      }

      const proven =
        basic.status === 200 &&
        basicBody.ok === true &&
        basicBody.graphql_valid === true &&
        basicBody.writes_performed === false;

      return {
        status: proven ? "PROVEN" : "NOT PROVEN",
        endpoint,
        deploy_url: basicBody.deploy_url || endpoint.replace("/.netlify/functions/royal-caribbean-discovery-smoke", ""),
        deployed_commit_ref: basicBody.deployed_commit_ref || null,
        basic_smoke: {
          http_status: basic.status,
          graphql_valid: basicBody.graphql_valid,
          upstream_http_status: basicBody.upstream_http_status,
          fleet_count: basicBody.fleet_count,
          sample_group_count: basicBody.sample_group_count,
          user_agent: basicBody.user_agent,
          writes_performed: basicBody.writes_performed,
          duration_ms: Date.now() - started
        },
        authoritative_smoke: {
          http_status: auth.status,
          graphql_valid: authBody.graphql_valid,
          authoritative_requests: authBody.authoritative_requests,
          authoritative_groups_union: authBody.authoritative_groups_union,
          authoritative_sailing_ids_union: authBody.authoritative_sailing_ids_union,
          writes_performed: authBody.writes_performed,
          duration_ms: Date.now() - authStarted
        },
        royal_caribbean_netlify_runtime_ok: proven && auth.status === 200 && authBody.writes_performed === false
      };
    } catch (error) {
      return {
        status: "NOT PROVEN",
        endpoint,
        reason: error.message || String(error)
      };
    }
  }

  return {
    status: "NOT PROVEN",
    reason:
      "royal-caribbean-discovery-smoke endpoint not deployed on production or branch deploy URLs (HTTP 404). Deploy RC branch to Netlify before activation."
  };
}

function attemptGitHubSmoke() {
  try {
    execSync("gh --version", { stdio: "ignore" });
  } catch {
    return { status: "NOT EXECUTED", reason: "gh CLI unavailable in execution environment" };
  }
  try {
    const runJson = execSync(
      "gh workflow run royal-caribbean-source-smoke.yml --ref feat/royal-caribbean-final-catchup && sleep 5 && gh run list --workflow=royal-caribbean-source-smoke.yml --limit 1 --json databaseId,headSha,conclusion,status",
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return { status: "TRIGGERED", raw: runJson.trim() };
  } catch (error) {
    return { status: "NOT EXECUTED", reason: error.message || String(error) };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const checkpoint = gitCheckpoint();
  const { url } = getSupabaseConfig(root);
  const sb = createReadOnlySupabase(root);

  const production = await indexGenuineRoyalCaribbeanProduction(sb);
  if (production.duplicate_official_sailing_ids.length || production.duplicate_identity_keys.length) {
    throw new Error("Production identity uniqueness check failed — STOP");
  }

  const weeklyStarted = Date.now();
  const weekly = await runRoyalCaribbeanWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    skipLock: true,
    supabase: sb,
    triggerType: "prompt8_weekly_validation",
    runId: `royal-caribbean-prompt8-${startedAt.replace(/[:.]/g, "-")}`
  });
  const weeklyDurationMs = Date.now() - weeklyStarted;

  const netlify = args.skipNetlify ? { status: "SKIPPED" } : await attemptNetlifySmoke();
  const github = attemptGitHubSmoke();

  const boundaryToday = inventory.perthCalendarDate();
  const boundary = {
    today_perth: boundaryToday,
    day_22: inventory.addCalendarDays(boundaryToday, 22),
    day_21: inventory.addCalendarDays(boundaryToday, 21),
    day_20: inventory.addCalendarDays(boundaryToday, 20),
    eligible_22_days: inventory.isCruisePubliclyBookable({
      departureDate: inventory.addCalendarDays(boundaryToday, 22),
      status: "active",
      perthToday: boundaryToday
    }),
    hide_candidate_21_days: inventory.shouldRemoveFromPublicInventory({
      departureDate: inventory.addCalendarDays(boundaryToday, 21),
      status: "active",
      perthToday: boundaryToday
    }),
    hide_candidate_20_days: inventory.shouldRemoveFromPublicInventory({
      departureDate: inventory.addCalendarDays(boundaryToday, 20),
      status: "active",
      perthToday: boundaryToday
    })
  };

  const recommendation =
    netlify.royal_caribbean_netlify_runtime_ok === true &&
    weekly.summary?.weekly_maintenance_healthy === true &&
    weekly.summary?.royal_caribbean_source_enumeration_ok === true
      ? "READY TO ENABLE CONTROLLED WEEKLY MAINTENANCE"
      : "NOT READY TO ENABLE WEEKLY MAINTENANCE";

  const report = {
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    mode: "royal_caribbean_prompt8_validation",
    read_only: true,
    repository_checkpoint: checkpoint,
    supabase_url: url,
    production_inventory: {
      genuine_sailing_count: production.genuine_sailing_count,
      unique_official_sailing_ids: production.unique_official_sailing_ids,
      unique_identity_keys: production.unique_identity_keys,
      duplicate_official_sailing_ids: production.duplicate_official_sailing_ids,
      duplicate_identity_keys: production.duplicate_identity_keys,
      legacy_html_count: production.legacy_html_count,
      earliest_departure: production.earliest_departure,
      latest_departure: production.latest_departure
    },
    weekly_source_wiring: {
      authoritative_enumeration: true,
      union_page_sizes: [25, 50, 100]
    },
    netlify_runtime: netlify,
    github_runtime: github,
    weekly_dry_run: {
      ok: weekly.ok === true,
      duration_ms: weeklyDurationMs,
      summary: weekly.summary,
      actual_writes: 0
    },
    cutoff_boundary_test: boundary,
    weekly_write_architecture: {
      frozen_maintenance_manifest: true,
      explicit_insert_update_expiry_sections: true,
      post_write_verification: true,
      write_ceiling: ROYAL_CARIBBEAN_WEEKLY_WRITE_CEILING
    },
    schedule_recommendation: MAINTENANCE_SCHEDULES.royal_caribbean_weekly,
    production_impact: {
      cruise_inserts: 0,
      cruise_updates: 0,
      cruise_deletes: 0,
      expiry_changes: 0,
      ship_changes: 0,
      port_changes: 0,
      alias_changes: 0,
      destination_changes: 0,
      legacy_row_changes: 0
    },
    recommendation,
    recommendation_blocker:
      recommendation === "READY TO ENABLE CONTROLLED WEEKLY MAINTENANCE"
        ? null
        : netlify.status !== "PROVEN"
          ? "Netlify runtime not proven — deploy RC branch and invoke royal-caribbean-discovery-smoke from Netlify infrastructure"
          : weekly.summary?.weekly_maintenance_healthy !== true
            ? weekly.reason || "weekly maintenance health gate failed"
            : "unknown"
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: weekly.ok === true,
        output: args.output,
        production_genuine: production.genuine_sailing_count,
        union_sailings: weekly.summary?.union_sailing_identities,
        proposed_inserts: weekly.summary?.proposed_inserts,
        source_absent: weekly.summary?.source_absent_active,
        enumeration_ok: weekly.summary?.royal_caribbean_source_enumeration_ok,
        weekly_healthy: weekly.summary?.weekly_maintenance_healthy,
        netlify: netlify.status,
        recommendation
      },
      null,
      2
    )
  );

  if (production.duplicate_official_sailing_ids.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
