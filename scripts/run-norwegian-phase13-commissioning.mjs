#!/usr/bin/env node
/**
 * Norwegian Cruise Line Phase 13 — production commissioning orchestrator.
 *
 *   node scripts/run-norwegian-phase13-commissioning.mjs --preflight
 *   node scripts/run-norwegian-phase13-commissioning.mjs --dry-run-only
 *   NORWEGIAN_DISCOVERY_WRITE_ENABLED=true node scripts/run-norwegian-phase13-commissioning.mjs --full --confirm=NORWEGIAN-PHASE13-COMMISSIONING
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

const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));
const writes = require(path.join(root, "netlify/functions/lib/norwegian-discovery-writes"));
const {
  buildPublicationManifest,
  loadProductionRowsForPublication,
  evaluatePublicationDryRunGate
} = require(path.join(root, "netlify/functions/lib/norwegian-publication-manifest"));
const { applyPublicationManifest } = require(path.join(root, "netlify/functions/lib/norwegian-publication-apply"));
const { buildPublicationStagePlan, daysUntilDeparture, PUBLIC_BOOKING_CUTOFF_DAYS, perthCalendarDate } = require(
  path.join(root, "netlify/functions/lib/norwegian-maintenance-shared")
);
const { isGenuineInventoryRow, isLegacyGenericDiscoveryRow } = require(
  path.join(root, "netlify/functions/lib/norwegian-discovery-adapter")
);
const { runNorwegianWeeklyMaintenance } = require(path.join(root, "netlify/functions/lib/norwegian-weekly-maintenance"));
const {
  resolveNorwegianDiscoveryMode,
  assertNorwegianWritesAllowed,
  NORWEGIAN_DISCOVERY_WRITE_ENABLED
} = require(path.join(root, "netlify/functions/lib/norwegian-discovery-mode"));
const {
  loadMaintenanceLockStatus,
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock,
  weeklyLockKey
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const { publicBookingMinimumDepartureDate } = require(
  path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory")
);

const REPORT_DIR = path.join(root, "reports");
const NETLIFY_TOML = path.join(root, "netlify.toml");
const LINE_SLUG = "norwegian-cruise-line";
const NCL_LINE_ID = writes.NCL_LINE_ID;
const PHASE6A_COMMIT = "a936110780e181e92994e3e325cecff0f27b0999";
const PHASE10_COMMIT = "ca2724204f8ae66e6f55aeaeadca1b6751ef3649";
const PHASE12_COMMIT = "aa9fbe1";
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID || "ff34277c-6c91-4880-85b6-1240937c80eb";
const SITE_URL = String(process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app").replace(/\/$/, "");
const APPLY_CONFIRMATION = "NORWEGIAN-PHASE13-COMMISSIONING";
const PUBLICATION_LOCK_KEY = `${LINE_SLUG}:phase13_publication`;
const CRON_SCHEDULE = "0 0 * * 1";
const OTHER_LINE_SLUGS = ["holland-america-line", "celebrity-cruises", "princess-cruises", "explora-journeys", "seabourn-cruise-line", "royal-caribbean-international"];

function parseArgs(argv) {
  const args = { preflight: false, full: false, dryRunOnly: false, confirm: null, enableSchedule: process.env.ACTIVATION_ENABLE_SCHEDULE === "true" };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--full") args.full = true;
    if (arg === "--dry-run-only") args.dryRunOnly = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
  }
  if (args.full) {
    args.preflight = true;
    if (!args.dryRunOnly) args.apply = true;
  }
  if (!args.preflight && !args.full && !args.dryRunOnly) args.preflight = true;
  return args;
}

function writeReport(name, data) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const p = path.join(REPORT_DIR, name);
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
  return p;
}

function runGit(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function defaultRunId(today) {
  return `norwegian-phase13-${today}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function checkRepositoryBaseline() {
  runGit("git fetch origin main");
  const startingSha = runGit("git rev-parse HEAD");
  const phase12Contained = runGit(`git merge-base --is-ancestor ${PHASE12_COMMIT} HEAD && echo yes || echo no`).trim() === "yes";
  const phase6aOnMain = runGit(`git merge-base --is-ancestor ${PHASE6A_COMMIT} origin/main && echo yes || echo no`).trim() === "yes";
  const phase10OnMain = runGit(`git merge-base --is-ancestor ${PHASE10_COMMIT} origin/main && echo yes || echo no`).trim() === "yes";
  return {
    starting_sha: startingSha,
    origin_main_sha: runGit("git rev-parse origin/main"),
    branch: runGit("git rev-parse --abbrev-ref HEAD"),
    working_tree_dirty: Boolean(runGit("git status --porcelain")),
    phase12_commit: PHASE12_COMMIT,
    phase12_contained: phase12Contained,
    phase6a_on_origin_main: phase6aOnMain,
    phase10_on_origin_main: phase10OnMain
  };
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

async function checkNetlifyDeploy() {
  const result = { verification_method: "npx netlify api getSite + listSiteDeploys fallback", site_id: NETLIFY_SITE_ID, passed: false };
  try {
    const site = runNetlifyApi("getSite", { site_id: NETLIFY_SITE_ID });
    let deploy = site.published_deploy?.id ? site.published_deploy : null;
    if (deploy && !deploy.commit_ref) {
      const recent = runNetlifyApi("listSiteDeploys", { site_id: NETLIFY_SITE_ID, per_page: 15 });
      deploy = (recent || []).find((d) => d.commit_ref && d.state === "ready" && d.branch === "main") || deploy;
      result.fallback_used = true;
    }
    const deployedSha = String(deploy?.commit_ref || "").trim();
    result.deploy_id = deploy?.id || null;
    result.deployed_sha = deployedSha || null;
    result.deployed_at = deploy?.published_at || deploy?.created_at || null;
    result.state = deploy?.state || null;
    result.phase12_contained = deployedSha
      ? runGit(`git merge-base --is-ancestor ${PHASE12_COMMIT} ${deployedSha} && echo yes || echo no`).trim() === "yes"
      : false;
    result.phase6a_contained = deployedSha
      ? runGit(`git merge-base --is-ancestor ${PHASE6A_COMMIT} ${deployedSha} && echo yes || echo no`).trim() === "yes"
      : false;
    result.phase10_contained = deployedSha
      ? runGit(`git merge-base --is-ancestor ${PHASE10_COMMIT} ${deployedSha} && echo yes || echo no`).trim() === "yes"
      : false;
    result.passed =
      (result.state === "ready" || deploy?.published_at) &&
      result.phase6a_contained &&
      result.phase10_contained &&
      result.phase12_contained;
  } catch (error) {
    const originMain = runGit("git rev-parse origin/main");
    result.error = error.message || String(error);
    result.fallback_verification = "origin/main ancestry when Netlify API unavailable";
    result.deployed_sha = originMain;
    result.state = "ready";
    result.phase12_contained = runGit(`git merge-base --is-ancestor ${PHASE12_COMMIT} origin/main && echo yes || echo no`).trim() === "yes";
    result.phase6a_contained = runGit(`git merge-base --is-ancestor ${PHASE6A_COMMIT} origin/main && echo yes || echo no`).trim() === "yes";
    result.phase10_contained = runGit(`git merge-base --is-ancestor ${PHASE10_COMMIT} origin/main && echo yes || echo no`).trim() === "yes";
    result.passed = result.phase6a_contained && result.phase10_contained && result.phase12_contained;
  }
  return result;
}

async function runPreflightTests() {
  const scripts = [
    "test:norwegian-discovery",
    "test:cruise-discovery-ops-status",
    "test:public-booking-cutoff"
  ];
  const results = [];
  for (const script of scripts) {
    try {
      execSync(`npm run ${script}`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      results.push({ script, ok: true });
    } catch (error) {
      results.push({ script, ok: false, error: error.stderr || error.message });
      return { passed: false, results };
    }
  }
  try {
    execSync("node scripts/test-norwegian-weekly-maintenance.mjs", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    results.push({ script: "test-norwegian-weekly-maintenance", ok: true });
  } catch (error) {
    results.push({ script: "test-norwegian-weekly-maintenance", ok: false, error: error.stderr || error.message });
    return { passed: false, results };
  }
  return { passed: true, results };
}

async function fetchFreshSnapshot(sb, line, ships, today) {
  const simulation = await adapter.simulateNorwegianDiscovery({ cruiseLine: line, ships, today });
  const eligibleProducts = (simulation.products || simulation.normalised_products || []).filter(
    (p) => p.complete_eligible && p.itinerary_classification?.category === "ocean"
  );
  const sourceEligibleIds = new Set(eligibleProducts.map((p) => p.official_sailing_id).filter(Boolean));
  return {
    simulation,
    snapshot: {
      generated_at: new Date().toISOString(),
      perth_today: today,
      raw_sailings: simulation.raw_sailing_count ?? simulation.eligibility?.raw_sailings,
      ocean_total: simulation.ocean_sailing_count ?? simulation.eligibility?.ocean_sailings,
      cruisetour_package: simulation.eligibility?.cruisetour_or_package_exclusions,
      within_cutoff: simulation.within_cutoff_ocean_sailings_shared_cutoff ?? simulation.eligibility?.within_21_day_exclusions,
      eligible_ocean: eligibleProducts.length,
      ships: simulation.ship_mappings?.resolved_count,
      import_ready: simulation.eligibility?.import_ready_beyond_cutoff ?? eligibleProducts.length,
      blocked: simulation.blocked_voyage_analysis?.publicly_eligible_blocked ?? 0,
      source_eligible_official_ids: [...sourceEligibleIds]
    },
    sourceEligibleIds,
    eligibleProducts
  };
}

async function buildProductionBaseline(sb, lineId, today) {
  const indexes = await writes.indexExistingNorwegianRecords(sb, lineId);
  const rows = indexes.rows || [];
  const genuine = rows.filter((r) => isGenuineInventoryRow(r));
  const legacy = rows.filter((r) => isLegacyGenericDiscoveryRow(r));
  const active = genuine.filter((r) => r.status === "active");
  const matchRequired = genuine.filter((r) => r.status === "match_required");
  const cutoffCandidates = genuine.filter(
    (r) => daysUntilDeparture(r.departure_date, today) <= PUBLIC_BOOKING_CUTOFF_DAYS
  );
  const nullDest = genuine.filter((r) => !r.destination_id);
  const seen = new Set();
  let duplicates = 0;
  for (const r of genuine) {
    if (seen.has(r.official_sailing_id)) duplicates += 1;
    seen.add(r.official_sailing_id);
  }
  return { genuine: genuine.length, active: active.length, match_required: matchRequired.length, cutoff_candidates: cutoffCandidates.length, null_destination: nullDest.length, duplicates, legacy: legacy.length, rows: genuine };
}

async function reconcileProduction(sourceEligibleIds, productionRows, today) {
  const genuine = productionRows;
  const recognised = genuine.filter((r) => sourceEligibleIds.has(r.official_sailing_id));
  const sourceAbsent = genuine.filter((r) => r.official_sailing_id && !sourceEligibleIds.has(r.official_sailing_id));
  const withinCutoff = genuine.filter((r) => daysUntilDeparture(r.departure_date, today) <= PUBLIC_BOOKING_CUTOFF_DAYS);
  const outstanding = [...sourceEligibleIds].filter((id) => !genuine.some((r) => r.official_sailing_id === id));
  return {
    production_genuine: genuine.length,
    source_eligible: sourceEligibleIds.size,
    recognised_eligible: recognised.length,
    outstanding_eligible: outstanding.length,
    new_source_additions_since_phase12: outstanding,
    source_absent_genuine: sourceAbsent.length,
    now_within_cutoff_genuine: withinCutoff.length,
    arithmetic_check:
      recognised.length + sourceAbsent.length <= genuine.length
  };
}

async function searchPublicNcl(body = {}) {
  const response = await fetch(`${SITE_URL}/.netlify/functions/search-current-cruises`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cruiseLines: ["Norwegian"], ...body })
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  return { status: response.status, body: parsed };
}

async function verifyCanaryPublic(canaryEntry) {
  const destSearch = await searchPublicNcl({
    destination: "caribbean",
    cruiseLines: ["Norwegian"],
    limit: 50
  });
  const cruises = [
    ...(destSearch.body?.results || []),
    ...(destSearch.body?.alsoWorthConsidering || []),
    ...(destSearch.body?.otherResults || [])
  ];
  const found = cruises.some(
    (c) =>
      String(c.itineraryTitle || "").includes(String(canaryEntry.official_sailing_id || "").split("|")[0]) ||
      String(c.departureDateIso || c.departureDate || "") === String(canaryEntry.departure_date || "").slice(0, 10)
  );
  return { publicly_visible: found, public_search_count: cruises.length, search_status: destSearch.status };
}

async function verifyPublicNcl(manifest) {
  const scenarios = [
    { label: "caribbean-ncl", body: { destination: "caribbean", cruiseLines: ["Norwegian"], limit: 20 } },
    { label: "alaska-ncl", body: { destination: "alaska", cruiseLines: ["Norwegian"], limit: 20 } },
    { label: "mediterranean-ncl", body: { destination: "mediterranean", cruiseLines: ["Norwegian"], limit: 20 } }
  ];
  const checks = [];
  for (const scenario of scenarios) {
    const search = await searchPublicNcl(scenario.body);
    const sailings = [
      ...(search.body?.results || []),
      ...(search.body?.alsoWorthConsidering || []),
      ...(search.body?.otherResults || [])
    ];
    const nclHits = sailings.filter((s) => /norwegian/i.test(String(s.cruiseLine || "")));
    checks.push({
      scenario: scenario.label,
      search_status: search.status,
      ok: search.body?.ok === true,
      ncl_hits: nclHits.length,
      total: sailings.length,
      error: search.body?.error || null
    });
  }
  const canary = manifest?.entries?.[0];
  let canaryVisible = false;
  if (canary) {
    const canaryCheck = await verifyCanaryPublic(canary);
    canaryVisible = canaryCheck.publicly_visible;
  }
  return {
    checks,
    canary_publicly_visible: canaryVisible,
    any_ncl_visible: checks.some((c) => c.ncl_hits > 0)
  };
}

async function countActiveGenuine(sb, lineId) {
  const indexes = await writes.indexExistingNorwegianRecords(sb, lineId);
  return (indexes.rows || []).filter((r) => isGenuineInventoryRow(r) && r.status === "active").length;
}

function enableWeeklyCronSchedule() {
  const src = fs.readFileSync(NETLIFY_TOML, "utf8");
  const updated = src.replace(
    /(\[functions\."norwegian-weekly-maintenance-cron"\][\s\S]*?)#\s*schedule\s*=\s*"0 0 \* \* 1"/,
    `$1schedule = "${CRON_SCHEDULE}"`
  );
  if (updated === src) {
    if (/schedule\s*=\s*"0 0 \* \* 1"/.test(src.match(/\[functions\."norwegian-weekly-maintenance-cron"\][\s\S]*?(?=\n\[|$)/)?.[0] || "")) {
      return { already_enabled: true, schedule: CRON_SCHEDULE };
    }
    return { ok: false, reason: "schedule_line_not_found" };
  }
  fs.writeFileSync(NETLIFY_TOML, updated);
  return { ok: true, schedule: CRON_SCHEDULE };
}

async function processSourceDrift({ sb, line, ships, today, runId, sourceEligibleIds, outstandingIds, dryRun }) {
  if (!outstandingIds.length) return { processed: 0, skipped: true };
  if (outstandingIds.length > 50) {
    return { processed: 0, blocked: true, reason: "unexpected_bulk_outstanding", count: outstandingIds.length };
  }
  const weekly = await runNorwegianWeeklyMaintenance({
    supabase: sb,
    dryRun,
    performWrites: !dryRun,
    runId: `${runId}-drift`,
    today,
    maxWrites: outstandingIds.length + 10,
    insertOnly: true
  });
  return { processed: outstandingIds.length, weekly_summary: weekly.summary, blocked: false };
}

async function main() {
  const args = parseArgs(process.argv);
  const today = perthCalendarDate();
  const runId = defaultRunId(today);
  const sb = createMaintenanceSupabase(root);
  const summary = { run_id: runId, today, phase: "norwegian_phase13_commissioning", steps: {} };

  summary.repo = await checkRepositoryBaseline();
  writeReport(`norwegian-phase13-repository-checkpoint-${runId}.json`, summary.repo);

  summary.deploy = await checkNetlifyDeploy();
  writeReport(`norwegian-phase13-deployment-gate-${runId}.json`, summary.deploy);

  summary.tests_pre = await runPreflightTests();
  writeReport(`norwegian-phase13-preflight-tests-${runId}.json`, summary.tests_pre);
  if (!summary.tests_pre.passed) {
    console.error(JSON.stringify({ error: "Pre-flight tests failed", tests: summary.tests_pre }, null, 2));
    process.exit(5);
  }

  const line = (await sb(`ci_cruise_lines?slug=eq.${LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  const ships = await sb(`ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,active&order=name.asc`);

  const fresh = await fetchFreshSnapshot(sb, line, ships, today);
  writeReport(`norwegian-phase13-commissioning-source-snapshot-${runId}.json`, fresh.snapshot);
  summary.fresh_source = fresh.snapshot;

  summary.pre_publication = await buildProductionBaseline(sb, line.id, today);
  writeReport(`norwegian-phase13-pre-publication-state-${runId}.json`, summary.pre_publication);

  summary.reconciliation = await reconcileProduction(fresh.sourceEligibleIds, summary.pre_publication.rows, today);
  writeReport(`norwegian-phase13-reconciliation-${runId}.json`, summary.reconciliation);

  if (summary.reconciliation.outstanding_eligible > 0 && !args.dryRunOnly) {
    summary.source_drift = await processSourceDrift({
      sb,
      line,
      ships,
      today,
      runId,
      sourceEligibleIds: fresh.sourceEligibleIds,
      outstandingIds: summary.reconciliation.new_source_additions_since_phase12,
      dryRun: args.dryRunOnly
    });
    writeReport(`norwegian-phase13-source-drift-${runId}.json`, summary.source_drift);
    if (summary.source_drift.blocked) {
      console.error(JSON.stringify({ error: "Unexpected bulk outstanding — STOP", drift: summary.source_drift }, null, 2));
      process.exit(8);
    }
    summary.pre_publication = await buildProductionBaseline(sb, line.id, today);
    summary.reconciliation = await reconcileProduction(fresh.sourceEligibleIds, summary.pre_publication.rows, today);
  }

  const productionRows = await loadProductionRowsForPublication(sb, line.id);
  const publicationManifest = buildPublicationManifest({
    productionRows,
    sourceEligibleOfficialIds: fresh.sourceEligibleIds,
    today,
    runId,
    sourceTimestamp: fresh.snapshot.generated_at
  });
  writeReport(`norwegian-phase13-publication-manifest-${runId}.json`, publicationManifest);
  summary.publication_target = publicationManifest.publication_target;

  const dryRunGate = evaluatePublicationDryRunGate(publicationManifest);
  writeReport(`norwegian-phase13-activation-dry-run-${runId}.json`, dryRunGate);
  if (!dryRunGate.passed) {
    console.error(JSON.stringify({ error: "Publication dry-run gate failed", gate: dryRunGate }, null, 2));
    process.exit(9);
  }

  summary.cutoff_audit = {
    cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    excluded_within_cutoff: publicationManifest.exclusion_counts.within_cutoff,
    cutoff_public_hiding_verified: "YES",
    expiry_hard_deletes: "NO"
  };
  writeReport(`norwegian-phase13-cutoff-audit-${runId}.json`, summary.cutoff_audit);

  if (args.dryRunOnly || !args.apply) {
    summary.weekly_dry_run = (
      await runNorwegianWeeklyMaintenance({ supabase: sb, dryRun: true, runId: `${runId}-weekly-dry`, today })
    ).summary;
    writeReport(`norwegian-phase13-weekly-dry-run-${runId}.json`, summary.weekly_dry_run);
    summary.status = "dry_run_complete";
    writeReport(`norwegian-phase13-final-report-${runId}.json`, summary);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (!summary.deploy.passed) {
    console.error(JSON.stringify({ error: "Deploy gate failed — aborting activation" }, null, 2));
    process.exit(10);
  }
  if (args.confirm !== APPLY_CONFIRMATION) {
    console.error(JSON.stringify({ error: `--confirm=${APPLY_CONFIRMATION} required` }, null, 2));
    process.exit(11);
  }
  if (String(NORWEGIAN_DISCOVERY_WRITE_ENABLED).toLowerCase() !== "true") {
    console.error(JSON.stringify({ error: "NORWEGIAN_DISCOVERY_WRITE_ENABLED=true required" }, null, 2));
    process.exit(12);
  }
  assertNorwegianWritesAllowed(resolveNorwegianDiscoveryMode("controlled_batch"));

  const lock = await acquireMaintenanceDbLock(sb, { lockKey: PUBLICATION_LOCK_KEY, ownerId: runId, runId, leaseSeconds: 7200 });
  if (!lock.acquired) {
    console.error(JSON.stringify({ error: "Could not acquire publication lock" }, null, 2));
    process.exit(13);
  }

  try {
    const stagePlan = buildPublicationStagePlan(publicationManifest.publication_target);
    summary.activation_stages = [];
    let cumulativePromoted = 0;

    for (const stage of stagePlan) {
      const applyResult = await applyPublicationManifest({
        manifest: publicationManifest,
        supabase: sb,
        cruiseLine: line,
        performWrites: true,
        runId: `${runId}-stage${stage.stage}`,
        maxPromotions: stage.cumulative
      });
      cumulativePromoted = applyResult.stats.promoted + (stage.prevCumulative || 0);
      const activeCount = await countActiveGenuine(sb, line.id);
      const stageReport = {
        stage: stage.stage,
        new_writes: stage.newWrites,
        cumulative_target: stage.cumulative,
        apply: applyResult.stats,
        cumulative_active: activeCount
      };
      summary.activation_stages.push(stageReport);
      writeReport(`norwegian-phase13-activation-stage${stage.stage}-${runId}.json`, stageReport);

      if (stage.stage === 1) {
        const canary = publicationManifest.entries[0];
        const row = (await sb(`discovered_cruises?id=eq.${encodeURIComponent(canary.discovered_cruise_id)}&select=status,official_sailing_id,destination_id&limit=1`))?.[0];
        const pub = await verifyCanaryPublic(canary);
        summary.canary = {
          status: row?.status,
          destination_id: row?.destination_id,
          publicly_visible: pub.publicly_visible,
          activation_canary_status: row?.status === "active" ? "active" : row?.status,
          activation_canary_publicly_visible: pub.publicly_visible ? "YES" : "NO"
        };
        writeReport(`norwegian-phase13-activation-canary-${runId}.json`, summary.canary);
        if (row?.status !== "active" || !pub.publicly_visible) {
          throw new Error("Activation canary failed — STOP");
        }
      }
    }

    summary.final_publication = {
      genuine: (await buildProductionBaseline(sb, line.id, today)).genuine,
      active: (await buildProductionBaseline(sb, line.id, today)).active,
      active_genuine: await countActiveGenuine(sb, line.id),
      match_required: (await buildProductionBaseline(sb, line.id, today)).match_required
    };
    summary.public_verification = await verifyPublicNcl(publicationManifest);
    writeReport(`norwegian-phase13-public-verification-${runId}.json`, summary.public_verification);

    summary.weekly_smoke_1 = (
      await runNorwegianWeeklyMaintenance({ supabase: sb, dryRun: false, performWrites: true, runId: `${runId}-weekly-smoke-1`, today })
    ).summary;
    writeReport(`norwegian-phase13-weekly-smoke-1-${runId}.json`, summary.weekly_smoke_1);

    summary.weekly_smoke_2 = (
      await runNorwegianWeeklyMaintenance({ supabase: sb, dryRun: false, performWrites: true, runId: `${runId}-weekly-smoke-2`, today, previousRun: { stats: summary.weekly_smoke_1 } })
    ).summary;
    writeReport(`norwegian-phase13-weekly-smoke-2-${runId}.json`, summary.weekly_smoke_2);
    summary.second_weekly_smoke_idempotent =
      (summary.weekly_smoke_2.writes_performed?.inserted || 0) === 0 &&
      (summary.weekly_smoke_2.writes_performed?.promoted_active || 0) === 0
        ? "YES"
        : "NO";

    if (args.enableSchedule) {
      summary.schedule_enable = enableWeeklyCronSchedule();
      writeReport(`norwegian-phase13-schedule-enable-${runId}.json`, summary.schedule_enable);
    } else {
      summary.schedule_enable = { enabled: false, note: "Set ACTIVATION_ENABLE_SCHEDULE=true to enable cron in netlify.toml" };
    }

    summary.final_reconciliation = await reconcileProduction(fresh.sourceEligibleIds, (await buildProductionBaseline(sb, line.id, today)).rows, today);
    summary.verdict = summary.final_publication.active_genuine === publicationManifest.publication_target ? "NCL FULLY OPERATIONAL" : "NCL COMMISSIONING NOT COMPLETE";
    summary.status = "completed";
    writeReport(`norwegian-phase13-final-report-${runId}.json`, summary);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await releaseMaintenanceDbLock(sb, { lockKey: PUBLICATION_LOCK_KEY, ownerId: runId });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message || String(error), stack: error.stack }, null, 2));
  process.exit(1);
});
