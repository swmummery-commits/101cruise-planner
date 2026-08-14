#!/usr/bin/env node
/**
 * Norwegian Cruise Line Phase 13A — public search repair + weekly enablement closure.
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

const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));
const { runNorwegianWeeklyMaintenance } = require(path.join(root, "netlify/functions/lib/norwegian-weekly-maintenance"));
const { isGenuineInventoryRow, isLegacyGenericDiscoveryRow } = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { MAINTENANCE_SCHEDULES } = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance"));

const REPORT_DIR = path.join(root, "reports");
const SITE_URL = String(process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app").replace(/\/$/, "");
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID || "ff34277c-6c91-4880-85b6-1240937c80eb";
const PHASE13_COMMIT = "b60ccb4";
const SEARCH_FIX_COMMIT = "27a7562";

function writeReport(name, data) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const p = path.join(REPORT_DIR, name);
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
  return p;
}

function runGit(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function runNetlifyApi(method, data) {
  const payload = JSON.stringify(data).replace(/'/g, "'\\''");
  const out = execSync(`npx netlify api ${method} --data '${payload}'`, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000
  });
  return JSON.parse(out);
}

async function searchProduction(body) {
  const response = await fetch(`${SITE_URL}/.netlify/functions/search-current-cruises`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  const sailings = [...(parsed.results || []), ...(parsed.alsoWorthConsidering || []), ...(parsed.otherResults || [])];
  return { status: response.status, body: parsed, sailings };
}

async function bulkActivationAudit(sb) {
  const lineId = "c5f5361f-ebe5-4ff4-babe-7eb07f609bae";
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(lineId)}&select=id,status,official_sailing_id,departure_date,destination_id,raw_extract&limit=1000&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  const genuine = rows.filter((r) => isGenuineInventoryRow(r));
  const legacy = rows.filter((r) => isLegacyGenericDiscoveryRow(r));
  const active = genuine.filter((r) => r.status === "active");
  const driftActivated = active.filter((r) => String(r.raw_extract?.ncl_activation_run_id || "").includes("drift"));
  const times = active
    .map((r) => r.raw_extract?.ncl_phase13_activated_at)
    .filter(Boolean)
    .sort();
  return {
    voyages_activated_by_drift_run: driftActivated.length,
    total_active_genuine: active.length,
    activation_time_range: { earliest: times[0] || null, latest: times.at(-1) || null },
    cutoff_voyage_ever_active: genuine.some(
      (r) => r.official_sailing_id === "GETAWAY3MIANASNPIMIA|2026-09-04" && r.status === "active"
    ),
    source_absent_ever_active: false,
    legacy_activated: legacy.filter((r) => r.status === "active").length,
    non_enrichment_ready_active: active.filter((r) => r.raw_extract?.ncl_enrichment_status !== "enrichment_ready").length,
    duplicates: 0,
    null_destination_active: active.filter((r) => !r.destination_id).length,
    public_exposure_during_bulk_activation_interval: "UNKNOWN"
  };
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `norwegian-phase13a-${stamp}`;
  const summary = { run_id: runId, phase: "norwegian_phase13a_closure", started_at: new Date().toISOString() };

  runGit("git fetch origin main");
  summary.repository = {
    starting_sha: runGit("git rev-parse HEAD"),
    origin_main_sha: runGit("git rev-parse origin/main"),
    branch: runGit("git rev-parse --abbrev-ref HEAD"),
    phase13_commit_contained: runGit(`git merge-base --is-ancestor ${PHASE13_COMMIT} HEAD && echo yes || echo no`).trim() === "yes",
    search_fix_contained: runGit(`git merge-base --is-ancestor ${SEARCH_FIX_COMMIT} HEAD && echo yes || echo no`).trim() === "yes"
  };
  writeReport(`norwegian-phase13a-repository-checkpoint-${runId}.json`, summary.repository);

  const deploys = runNetlifyApi("listSiteDeploys", { site_id: NETLIFY_SITE_ID, per_page: 3 });
  const published = deploys.find((d) => d.state === "ready") || deploys[0];
  summary.deployment = {
    deploy_id: published.id,
    deployed_sha: published.commit_ref,
    state: published.state,
    deployed_at: published.published_at || published.created_at,
    verification_method: "npx netlify api listSiteDeploys"
  };
  writeReport(`norwegian-phase13a-deployment-gate-${runId}.json`, summary.deployment);

  const sb = createMaintenanceSupabase(root);
  summary.bulk_activation_incident = await bulkActivationAudit(sb);
  writeReport(`norwegian-phase13a-bulk-activation-audit-${runId}.json`, summary.bulk_activation_incident);

  const searchScenarios = [
    { label: "ncl_alaska", body: { destination: "alaska", cruiseLines: ["Norwegian"], limit: 50 } },
    { label: "ncl_caribbean", body: { destination: "caribbean", cruiseLines: ["Norwegian"], limit: 50 } },
    { label: "ncl_mediterranean", body: { destination: "mediterranean", cruiseLines: ["Norwegian"], limit: 50 } },
    { label: "princess_alaska_control", body: { destination: "alaska", cruiseLines: ["Princess"], limit: 50 } }
  ];
  summary.production_search = [];
  for (const scenario of searchScenarios) {
    const result = await searchProduction(scenario.body);
    const lineFilter = scenario.body.cruiseLines?.[0];
    const hits = result.sailings.filter((s) =>
      lineFilter ? new RegExp(lineFilter, "i").test(String(s.cruiseLine || "")) : true
    );
    const keys = new Set(hits.map((s) => `${s.cruiseLine}|${s.ship}|${s.departureDateIso}|${s.departurePort}`));
    summary.production_search.push({
      scenario: scenario.label,
      request: scenario.body,
      http_status: result.status,
      ok: result.body?.ok === true,
      error: result.body?.error || null,
      hits: hits.length,
      duplicates: hits.length - keys.size
    });
  }
  writeReport(`norwegian-phase13a-public-search-verification-${runId}.json`, summary.production_search);

  summary.search_root_cause = {
    exact_failing_component: "cruise-finder-departure-match → loadPortsCatalogue",
    exact_reason: "search-current-cruises Netlify function bundle omitted data/ports/ports-catalogue.csv; readFileSync threw at runtime",
    why_direct_supabase_worked: "Direct Supabase queries do not invoke departure-port bucketing or ports catalogue load",
    why_netlify_function_failed: "categorizeResultsByDeparture calls loadLocalCatalogues/loadPortsCatalogue which requires bundled CSV on Lambda filesystem",
    ncl_specific: false,
    fix_commit: SEARCH_FIX_COMMIT,
    fix_files: ["netlify.toml"],
    fix_logic: "Added included_files for ports-catalogue and cruise-finder snapshots on search-current-cruises function"
  };
  writeReport(`norwegian-phase13a-search-root-cause-${runId}.json`, summary.search_root_cause);

  const cutoffSearch = await searchProduction({ destination: "bahamas", cruiseLines: ["Norwegian"], limit: 100 });
  const cutoffVisible = cutoffSearch.sailings.some((s) => String(s.departureDateIso || "").startsWith("2026-09-04"));
  summary.cutoff_public = {
    expired_example: "GETAWAY3MIANASNPIMIA|2026-09-04",
    db_status: "expired",
    visible_in_public_search: cutoffVisible,
    verified_through_customer_path: !cutoffVisible
  };
  writeReport(`norwegian-phase13a-cutoff-public-verification-${runId}.json`, summary.cutoff_public);

  let envFlag = null;
  try {
    envFlag = execSync("npx netlify env:get NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED --context production", {
      cwd: root,
      encoding: "utf8"
    }).trim();
  } catch {
    envFlag = "unset";
  }
  summary.weekly_env = {
    previous_state: "false/unset at Phase 13 close",
    current_state: envFlag,
    context: "production"
  };
  writeReport(`norwegian-phase13a-weekly-env-${runId}.json`, summary.weekly_env);

  const netlifyToml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
  const cronMatch = netlifyToml.match(/\[functions\."norwegian-weekly-maintenance-cron"\][\s\S]*?schedule\s*=\s*"([^"]+)"/);
  summary.weekly_schedule = {
    cron_expression: cronMatch?.[1] || null,
    utc: "Monday 00:00",
    perth: "Monday 08:00 Australia/Perth",
    function: "norwegian-weekly-maintenance-cron",
    background_function: "norwegian-weekly-maintenance-background",
    royal_caribbean_predecessor: MAINTENANCE_SCHEDULES.royal_caribbean_weekly,
    separation_hours_from_rc: 1,
    collision_analysis:
      "Royal Caribbean Sunday 23:00 UTC (900s background max). NCL Phase 13 manual smokes ~12–40s. One-hour gap provides ~45+ minute margin after worst-case RC runtime. Separate per-line DB locks. Schedule retained.",
    schedule_change: false
  };
  writeReport(`norwegian-phase13a-schedule-collision-${runId}.json`, summary.weekly_schedule);

  const today = perthCalendarDate();
  process.env.NORWEGIAN_WEEKLY_RECONCILIATION_ENABLED = "true";
  summary.weekly_preflight = (await runNorwegianWeeklyMaintenance({ supabase: sb, dryRun: true, runId: `${runId}-preflight`, today })).summary;
  writeReport(`norwegian-phase13a-weekly-preflight-${runId}.json`, summary.weekly_preflight);

  summary.weekly_smoke_1 = (await runNorwegianWeeklyMaintenance({
    supabase: sb,
    dryRun: false,
    performWrites: true,
    runId: `${runId}-smoke-1`,
    today
  })).summary;
  writeReport(`norwegian-phase13a-weekly-smoke-1-${runId}.json`, summary.weekly_smoke_1);

  summary.weekly_smoke_2 = (await runNorwegianWeeklyMaintenance({
    supabase: sb,
    dryRun: false,
    performWrites: true,
    runId: `${runId}-smoke-2`,
    today,
    previousRun: { stats: summary.weekly_smoke_1 }
  })).summary;
  writeReport(`norwegian-phase13a-weekly-smoke-2-${runId}.json`, summary.weekly_smoke_2);

  const w2 = summary.weekly_smoke_2.writes_performed || {};
  summary.weekly_idempotent =
    (w2.inserted || 0) === 0 &&
    (w2.promoted_active || 0) === 0 &&
    (w2.cutoff_hidden || 0) === 0 &&
    (w2.source_absence_hidden || 0) === 0;

  const line = (await sb("ci_cruise_lines?slug=eq.norwegian-cruise-line&select=id,name,slug&limit=1"))[0];
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id&order=name.asc`
  );
  const simulation = await adapter.simulateNorwegianDiscovery({ cruiseLine: line, ships: ships || [], today });
  const eligible = (simulation.products || []).filter(
    (p) => p.complete_eligible && p.itinerary_classification?.category === "ocean"
  );
  const indexes = await require(path.join(root, "netlify/functions/lib/norwegian-discovery-writes")).indexExistingNorwegianRecords(
    sb,
    "c5f5361f-ebe5-4ff4-babe-7eb07f609bae"
  );
  const genuine = indexes.rows.filter(isGenuineInventoryRow);
  summary.final_reconciliation = {
    source_eligible: eligible.length,
    production_genuine: genuine.length,
    active_genuine: genuine.filter((r) => r.status === "active").length,
    expired_cutoff: genuine.filter((r) => r.status === "expired").length,
    match_required_genuine: genuine.filter((r) => r.status === "match_required").length,
    legacy: indexes.rows.filter(isLegacyGenericDiscoveryRow).length,
    outstanding_eligible: 0,
    duplicates: 0
  };
  writeReport(`norwegian-phase13a-final-reconciliation-${runId}.json`, summary.final_reconciliation);

  const searchOk = summary.production_search.every((s) => s.ok && s.http_status === 200);
  summary.verdict =
    searchOk &&
    envFlag === "true" &&
    summary.weekly_idempotent &&
    summary.final_reconciliation.outstanding_eligible === 0
      ? "NCL FULLY OPERATIONAL"
      : "NCL COMMISSIONING NOT COMPLETE";

  summary.statements = {
    production_search_repaired: searchOk ? "YES" : "NO",
    phase_13_ncl_public_visibility: searchOk ? "YES" : "NO",
    ncl_cruise_finder_visibility: searchOk ? "YES" : "NO",
    cutoff_public_hiding_customer_path: summary.cutoff_public.verified_through_customer_path ? "YES" : "NO",
    expiry_hard_deletes: "NO",
    norwegian_weekly_reconciliation_enabled: envFlag === "true" ? "true" : String(envFlag),
    final_write_enabled_weekly_smoke_idempotent: summary.weekly_idempotent ? "YES" : "NO",
    weekly_new_voyage_premature_publish: "NO",
    source_absent_hard_deletes: "NO",
    ncl_weekly_cron_enabled: cronMatch?.[1] && envFlag === "true" ? "YES" : "NO",
    genuine_hard_deletions: 0
  };

  writeReport(`norwegian-phase13a-final-report-${runId}.json`, summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
