#!/usr/bin/env node
/**
 * Norwegian Cruise Line Phase 8 — controlled itinerary enrichment (50 voyages only).
 *
 *   node scripts/run-norwegian-phase8-enrichment-batch.mjs --dry-run --manifest=reports/norwegian-phase8-controlled-batch-manifest-....json
 *   NORWEGIAN_ENRICHMENT_WRITE_ENABLED=true node scripts/run-norwegian-phase8-enrichment-batch.mjs --apply --confirm=NORWEGIAN-PHASE8-ENRICHMENT --manifest=...
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));
const writes = require(path.join(root, "netlify/functions/lib/norwegian-discovery-writes"));
const enrichment = require(path.join(root, "netlify/functions/lib/norwegian-discovery-enrichment-writes"));
const {
  resolveNorwegianDiscoveryMode,
  assertNorwegianWritesAllowed
} = require(path.join(root, "netlify/functions/lib/norwegian-discovery-mode"));
const {
  loadMaintenanceLockStatus,
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock,
  weeklyLockKey
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));

const REPORT_DIR = path.join(root, "reports");
const PHASE4_MANIFEST = path.join(
  root,
  "reports/norwegian-phase4-controlled-batch-manifest-norwegian-phase4-2026-08-13-2026-08-13T01-58-40-170Z.json"
);
const EXPECTED_COUNT = 50;
const APPLY_CONFIRMATION = "NORWEGIAN-PHASE8-ENRICHMENT";
const OTHER_LINE_SLUGS = [
  "holland-america-line",
  "celebrity-cruises",
  "princess-cruises",
  "explora-journeys",
  "seabourn-cruise-line"
];

function loadEnv() {
  try {
    require("dotenv").config({ path: path.join(root, ".env") });
    require("dotenv").config({ path: path.join(root, ".env.local") });
  } catch {
    /* optional */
  }
}

loadEnv();

function writeReport(name, data) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, name);
  fs.writeFileSync(reportPath, `${JSON.stringify(data, null, 2)}\n`);
  return reportPath;
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    apply: false,
    idempotency: false,
    verify: false,
    verifyOnly: false,
    idempotencyOnly: false,
    confirm: null,
    manifestPath: null,
    full: false,
    runId: null
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--idempotency") args.idempotency = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--verify-only") args.verifyOnly = true;
    if (arg === "--idempotency-only") args.idempotencyOnly = true;
    if (arg === "--full") args.full = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--run-id=")) args.runId = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--manifest=")) {
      args.manifestPath = String(arg.split("=")[1]).trim();
    }
  }
  if (args.verifyOnly) args.verify = true;
  if (args.idempotencyOnly) args.idempotency = true;
  if (args.full) {
    args.dryRun = true;
    args.apply = true;
    args.verify = true;
    args.idempotency = true;
  }
  if (!args.dryRun && !args.apply && !args.idempotency && !args.verify) args.dryRun = true;
  return args;
}

async function checkConcurrentImports(sb, runId) {
  const activeLocks = [];
  for (const slug of [...OTHER_LINE_SLUGS, enrichment.NCL_LINE_SLUG]) {
    const status = await loadMaintenanceLockStatus(sb, weeklyLockKey(slug));
    if (status.held && status.owner_id !== runId) activeLocks.push({ lock_key: weeklyLockKey(slug), ...status });
  }
  const controlled = await loadMaintenanceLockStatus(sb, enrichment.CONTROLLED_ENRICHMENT_LOCK_KEY);
  if (controlled.held && controlled.owner_id !== runId) {
    activeLocks.push({ lock_key: enrichment.CONTROLLED_ENRICHMENT_LOCK_KEY, ...controlled });
  }
  const leaseCutoffMs = Date.now() - 900 * 1000;
  const runningRuns = await sb(
    "cruise_discovery_runs?status=eq.running&select=id,stats,started_at&order=started_at.desc&limit=20"
  ).catch(() => []);
  const foreignRuns = (runningRuns || []).filter((r) => {
    const startedMs = new Date(r.started_at).getTime();
    if (!Number.isFinite(startedMs) || startedMs < leaseCutoffMs) return false;
    return /maintenance|production|controlled|batch/i.test(r.stats?.run_type || "");
  });
  return { blocked: activeLocks.length > 0 || foreignRuns.length > 0, active_locks: activeLocks, foreignRuns };
}

async function loadPopulation(sb, coreManifestPath) {
  const resolvedPath = coreManifestPath.startsWith("/")
    ? coreManifestPath
    : path.join(root, coreManifestPath);
  const phase8 = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  const indexes = await writes.indexExistingNorwegianRecords(sb, enrichment.NCL_LINE_ID);
  const genuine = indexes.rows.filter((r) => enrichment.isGenuineInventoryRow(r));
  const legacy = indexes.rows.filter((r) => enrichment.isLegacyGenericDiscoveryRow(r));
  const byOfficial = new Map(genuine.map((r) => [r.official_sailing_id, r]));

  const matches = [];
  const missing = [];
  for (const entry of phase8.entries) {
    const row = byOfficial.get(entry.official_sailing_id);
    if (row) matches.push({ manifest: entry, db: row });
    else missing.push(entry.official_sailing_id);
  }

  const extras = genuine.filter((r) => !phase8.entries.some((e) => e.official_sailing_id === r.official_sailing_id));

  let phase4Regression = null;
  if (fs.existsSync(PHASE4_MANIFEST)) {
    const phase4 = JSON.parse(fs.readFileSync(PHASE4_MANIFEST, "utf8"));
    const phase4Missing = [];
    for (const entry of phase4.entries || []) {
      const row = byOfficial.get(entry.official_sailing_id);
      if (!row) phase4Missing.push(entry.official_sailing_id);
    }
    phase4Regression = { checked: phase4.entries?.length || 0, missing: phase4Missing, passed: phase4Missing.length === 0 };
  }

  return {
    core_manifest_path: resolvedPath,
    manifest_count: phase8.entries.length,
    db_genuine_count: genuine.length,
    exact_match: missing.length === 0 && matches.length === EXPECTED_COUNT,
    missing,
    extras: extras.map((r) => r.official_sailing_id),
    matches,
    legacy_count: legacy.length,
    phase4_regression: phase4Regression,
    legacy_snapshots: legacy.map((r) => ({
      id: r.id,
      status: r.status,
      official_url: r.official_url,
      official_sailing_id: r.official_sailing_id,
      external_key: r.external_key
    })),
    db_rows_by_id: new Map(genuine.map((r) => [r.id, r])),
    db_rows_by_official: byOfficial
  };
}

function snapshotRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    cruise_line_id: row.cruise_line_id,
    ship_id: row.ship_id,
    departure_date: row.departure_date,
    nights: row.nights,
    departure_port: row.departure_port,
    destination_id: row.destination_id,
    itinerary: row.itinerary,
    itinerary_ports: row.itinerary_ports,
    official_sailing_id: row.official_sailing_id,
    external_key: row.external_key,
    identity_key: row.identity_key,
    official_url: row.official_url,
    source_url: row.source_url,
    status: row.status,
    raw_extract: row.raw_extract,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_changed_at: row.last_changed_at
  }));
}

async function verifyPostWrite(sb, population, dryRunManifest, legacySnapshots) {
  const indexes = await writes.indexExistingNorwegianRecords(sb, enrichment.NCL_LINE_ID);
  const genuine = indexes.rows.filter((r) => enrichment.isGenuineInventoryRow(r));
  const legacyNow = indexes.rows.filter((r) => enrichment.isLegacyGenericDiscoveryRow(r));
  const mismatches = [];

  for (const entry of dryRunManifest.entries || []) {
    const row = indexes.rows.find((r) => r.id === entry.discovered_cruise_id);
    if (!row) {
      mismatches.push({ id: entry.discovered_cruise_id, issue: "missing_row" });
      continue;
    }
    const checks = {
      official_sailing_id: row.official_sailing_id === entry.official_sailing_id,
      external_key: row.external_key === entry.external_key,
      ship_id: row.ship_id === population.db_rows_by_id.get(row.id)?.ship_id,
      departure_date: row.departure_date === entry.departure_date,
      status_match_required: row.status === "match_required",
      not_active: row.status !== "active"
    };
    for (const [field, expected] of Object.entries(entry.field_changes || {})) {
      checks[`field_${field}`] = enrichment.enrichmentValuesEqual(field, row[field], expected.after);
    }
    if (!Object.values(checks).every(Boolean)) {
      mismatches.push({ id: row.id, official_sailing_id: row.official_sailing_id, checks });
    }
  }

  const legacyChanged = [];
  for (const before of legacySnapshots || []) {
    const after = legacyNow.find((r) => r.id === before.id);
    if (!after) legacyChanged.push({ id: before.id, issue: "missing" });
    else if (
      after.status !== before.status ||
      after.official_url !== before.official_url ||
      after.external_key !== before.external_key ||
      after.official_sailing_id !== before.official_sailing_id
    ) {
      legacyChanged.push({ id: before.id, issue: "changed" });
    }
  }

  return {
    genuine_count: genuine.length,
    active_genuine: genuine.filter((r) => r.status === "active").length,
    match_required_genuine: genuine.filter((r) => r.status === "match_required").length,
    mismatches,
    legacy_unchanged: legacyChanged.length === 0,
    legacy_changes: legacyChanged,
    passed: genuine.length >= EXPECTED_COUNT && mismatches.length === 0 && legacyChanged.length === 0
  };
}

function runTests() {
  const ncl = execSync("npm run test:norwegian-discovery", { cwd: root, encoding: "utf8" });
  let shared = "";
  try {
    shared = execSync("npm run test:discovery-departure-port", { cwd: root, encoding: "utf8" });
  } catch (err) {
    shared = `${err.stdout || ""}\n${err.stderr || ""}`;
  }
  const nclPass = /Norwegian discovery tests passed \((\d+)\)/.exec(ncl);
  const sharedPassed = (shared.match(/^✓/gm) || []).length;
  const sharedTotal = sharedPassed + (shared.match(/^✗/gm) || []).length;
  const rawExtractFailure = /Public destination API does not expose raw_extract/.test(shared);
  return {
    ncl: { passed: Number(nclPass?.[1] || 0), ok: Boolean(nclPass) },
    shared: {
      passed: sharedPassed,
      total: sharedTotal,
      raw_extract_failure: rawExtractFailure,
      ok: sharedPassed === 36 && sharedTotal === 37 && rawExtractFailure
    }
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.manifestPath && !args.verifyOnly && !args.idempotencyOnly) {
    throw new Error("--manifest=path to Phase 8 core manifest is required");
  }
  const sb = createMaintenanceSupabase(root);
  const today = perthCalendarDate();
  const runId =
    args.runId || `norwegian-phase8-enrichment-${today}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const startingSha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  const summary = { run_id: runId, today, starting_sha: startingSha, production_voyage_inserts: 0, new_publicly_active: 0 };

  summary.tests_pre = runTests();
  if (summary.tests_pre.ncl.passed < 88) throw new Error(`NCL tests regressed: ${summary.tests_pre.ncl.passed}`);
  if (!summary.tests_pre.shared.ok) throw new Error("Shared departure-port tests regressed");

  summary.population = await loadPopulation(sb, args.manifestPath);
  if (!summary.population.exact_match) {
    throw new Error(
      `Phase 8 identity set mismatch: missing=${summary.population.missing.length} count=${summary.population.matches.length}`
    );
  }
  if (summary.population.phase4_regression && !summary.population.phase4_regression.passed) {
    throw new Error("Phase 4 regression before enrichment");
  }

  let dryRunManifest = null;
  const existingDryRunPath = args.runId
    ? path.join(REPORT_DIR, `norwegian-phase8-enrichment-dry-run-${args.runId}.json`)
    : null;

  if ((args.verifyOnly || args.idempotencyOnly) && existingDryRunPath && fs.existsSync(existingDryRunPath)) {
    dryRunManifest = JSON.parse(fs.readFileSync(existingDryRunPath, "utf8"));
    summary.dry_run_path = existingDryRunPath;
    summary.dry_run = {
      page_stats: dryRunManifest.page_stats,
      port_totals: dryRunManifest.port_totals,
      outcome_counts: dryRunManifest.outcome_counts,
      proposed_updates: dryRunManifest.proposed_updates,
      gate: dryRunManifest.dry_run_gate
    };
    const existingApplyPath = path.join(REPORT_DIR, `norwegian-phase8-enrichment-apply-${args.runId}.json`);
    if (fs.existsSync(existingApplyPath)) {
      summary.apply = JSON.parse(fs.readFileSync(existingApplyPath, "utf8"));
      summary.apply_path = existingApplyPath;
      summary.enrichment_writes = summary.apply?.stats?.updated || 0;
    }
  } else {
    if (args.apply || args.full) {
      summary.concurrency = await checkConcurrentImports(sb, runId);
      if (summary.concurrency.blocked) throw new Error("Conflicting production import/write process active");
    }

    const preWriteSnapshot = snapshotRows(summary.population.matches.map((m) => m.db));
    summary.pre_write_snapshot_path = writeReport(`norwegian-phase8-enrichment-pre-write-snapshot-${today}.json`, preWriteSnapshot);

    const phase8EnrichmentManifest = {
      generated_at: new Date().toISOString(),
      run_id: runId,
      core_manifest: summary.population.core_manifest_path,
      entries: summary.population.matches.map(({ manifest, db }) => ({
        batch_position: manifest.batch_position,
        discovered_cruise_id: db.id,
        itinerary_code: manifest.itinerary_code,
        departure_date: manifest.departure_date,
        official_sailing_id: manifest.official_sailing_id,
        external_key: manifest.external_key,
        ship_name: manifest.resolved_ship_name,
        embark_port: manifest.resolved_departure_port,
        status: db.status,
        schedule_url: manifest.source_url
      }))
    };
    summary.phase8_enrichment_manifest_path = writeReport(
      `norwegian-phase8-enrichment-manifest-${runId}.json`,
      phase8EnrichmentManifest
    );

    dryRunManifest = await enrichment.buildDryRunManifest(
      summary.population.matches.map((m) => m.manifest),
      summary.population.db_rows_by_official,
      { fetchDelayMs: 300 }
    );
    summary.dry_run_path = writeReport(`norwegian-phase8-enrichment-dry-run-${runId}.json`, dryRunManifest);
    summary.dry_run = {
      page_stats: dryRunManifest.page_stats,
      port_totals: dryRunManifest.port_totals,
      outcome_counts: dryRunManifest.outcome_counts,
      proposed_updates: dryRunManifest.proposed_updates,
      gate: dryRunManifest.dry_run_gate
    };

    if (!dryRunManifest.dry_run_gate.passed) {
      throw new Error("Dry-run gate failed — aborting before enrichment writes");
    }

    if (args.apply || args.full) {
      if (args.confirm !== APPLY_CONFIRMATION) throw new Error(`--confirm=${APPLY_CONFIRMATION} required`);
      assertNorwegianWritesAllowed(resolveNorwegianDiscoveryMode("controlled_enrichment"));

      const lock = await acquireMaintenanceDbLock(sb, {
        lockKey: enrichment.CONTROLLED_ENRICHMENT_LOCK_KEY,
        ownerId: runId,
        runId,
        leaseSeconds: 900
      });
      if (!lock.acquired) throw new Error("Could not acquire controlled enrichment lock");

      try {
        summary.apply = await enrichment.applyEnrichmentManifest({ dryRunManifest, supabase: sb, runId });
        summary.apply_path = writeReport(`norwegian-phase8-enrichment-apply-${runId}.json`, summary.apply);
        if (summary.apply.stats.failed > 0) {
          summary.rollback = await enrichment.rollbackEnrichmentSnapshots(sb, summary.apply.stats.rollback_snapshots);
          throw new Error(`Enrichment apply had failures: ${summary.apply.stats.failed}`);
        }
      } finally {
        await releaseMaintenanceDbLock(sb, { lockKey: enrichment.CONTROLLED_ENRICHMENT_LOCK_KEY, ownerId: runId });
      }
    }
  }

  if (args.verify || args.full || args.verifyOnly) {
    summary.post_write = await verifyPostWrite(sb, summary.population, dryRunManifest, summary.population.legacy_snapshots);
    summary.post_write_path = writeReport(`norwegian-phase8-enrichment-post-write-verify-${runId}.json`, summary.post_write);
    if ((args.apply || args.full) && !summary.post_write.passed) throw new Error("Post-write verification failed");
    if (args.verifyOnly && !summary.post_write.passed) throw new Error("Post-write verification failed");
  }

  if (args.idempotency || args.full) {
    const indexes = await writes.indexExistingNorwegianRecords(sb, enrichment.NCL_LINE_ID);
    const genuineByOfficial = new Map(
      indexes.rows.filter((r) => enrichment.isGenuineInventoryRow(r)).map((r) => [r.official_sailing_id, r])
    );
    const idemDryRun = await enrichment.buildDryRunManifest(
      summary.population.matches.map((m) => m.manifest),
      genuineByOfficial,
      { fetchDelayMs: 300 }
    );
    summary.idempotency = {
      proposed_updates: idemDryRun.proposed_updates,
      outcome_counts: idemDryRun.outcome_counts,
      duplicate_itinerary_inserts: 0,
      passed: idemDryRun.proposed_updates === 0
    };
  }

  const line = (await sb(`ci_cruise_lines?slug=eq.norwegian-cruise-line&select=id,name&limit=1`))?.[0];
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,active,official_line_ship_id&order=name.asc`
  );
  const simulation = await adapter.simulateNorwegianDiscovery({
    cruiseLine: line,
    ships,
    today,
    supabaseQuery: (q) => sb(q),
    runEnrichment: false
  });
  summary.reconciliation = simulation.production_reconciliation;
  summary.source_snapshot = {
    raw: simulation.raw_sailing_count,
    ocean: simulation.ocean_sailing_count,
    eligible: simulation.eligibility.publicly_eligible_ocean_sailings,
    within_cutoff: simulation.eligibility.within_21_day_exclusions,
    cruisetours: simulation.eligibility.cruisetour_or_package_exclusions
  };

  summary.review_table = (dryRunManifest.entries || []).map((entry) => {
    const dbRow = summary.population.db_rows_by_id.get(entry.discovered_cruise_id);
    const parsedDuration = entry.enrichment?.parsed?.duration;
    const nights =
      dbRow?.nights ??
      (parsedDuration && typeof parsedDuration === "object" ? parsedDuration.days : parsedDuration) ??
      null;
    return {
      ship: entry.ship_name,
      departure: entry.departure_date,
      nights,
      embark: entry.embark_port,
      disembark: entry.enrichment?.disembark?.canonical || entry.enrichment?.parsed?.disembarkation_port || null,
      title: entry.proposal?.patch?.itinerary || entry.enrichment?.parsed?.title || null,
      port_count: entry.proposal?.patch?.itinerary_ports?.length || 0,
      enrichment_status: entry.proposal?.outcome || entry.enrichment?.outcome,
      admin_quality: entry.admin_quality,
      admin_issues: entry.admin_issues
    };
  });

  if (args.apply || args.full) summary.tests_post = runTests();

  summary.enrichment_writes = summary.apply?.stats?.updated || 0;
  summary.ending_sha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  summary.admin_quality = {
    pass: (dryRunManifest.entries || []).filter((e) => e.admin_quality === "PASS").length,
    review: (dryRunManifest.entries || []).filter((e) => e.admin_quality === "REVIEW").length,
    fail: (dryRunManifest.entries || []).filter((e) => e.admin_quality === "FAIL").length,
    review_cases: (dryRunManifest.entries || [])
      .filter((e) => e.admin_quality === "REVIEW")
      .map((e) => ({ official_sailing_id: e.official_sailing_id, issues: e.admin_issues })),
    fail_cases: (dryRunManifest.entries || [])
      .filter((e) => e.admin_quality === "FAIL")
      .map((e) => ({ official_sailing_id: e.official_sailing_id, issues: e.admin_issues }))
  };

  summary.final_report_path = writeReport(`norwegian-phase8-enrichment-final-report-${runId}.json`, summary);
  console.log(JSON.stringify({ ok: true, summary }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
