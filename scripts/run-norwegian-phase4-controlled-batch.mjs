#!/usr/bin/env node
/**
 * Norwegian Cruise Line Phase 4 — first controlled production import (max 25 voyages).
 *
 *   node scripts/run-norwegian-phase4-controlled-batch.mjs --preflight
 *   node scripts/run-norwegian-phase4-controlled-batch.mjs --full --dry-run-only
 *   NORWEGIAN_DISCOVERY_WRITE_ENABLED=true node scripts/run-norwegian-phase4-controlled-batch.mjs --full --apply --confirm=NORWEGIAN-PHASE4-CONTROLLED-BATCH
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const {
  createMaintenanceSupabase,
  createSupabaseRest,
  exactCountSupabase
} = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));
const {
  NCL_LINE_ID,
  buildManifestFromEntries,
  selectControlledBatchProducts,
  applyManifestWrites,
  rollbackInsertedRows,
  revalidateManifestAgainstSource,
  indexExistingNorwegianRecords,
  isLegacyGenericRow
} = require(path.join(root, "netlify/functions/lib/norwegian-discovery-writes"));
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
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { officialProductKey } = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));
const embarkMappings = require(path.join(root, "netlify/functions/lib/norwegian-embark-port-mappings"));
const { resolveNorwegianDeparturePort } = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));

const REPORT_DIR = path.join(root, "reports");
const LINE_SLUG = "norwegian-cruise-line";
const PHASE3_COMMIT = "6301b699f16f06c3d6e585eaf6a441ddd0e86f4e";
const MAX_WRITES = 25;
const APPLY_CONFIRMATION = "NORWEGIAN-PHASE4-CONTROLLED-BATCH";
const CONTROLLED_LOCK_KEY = `${LINE_SLUG}:controlled_batch`;
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

function parseArgs(argv) {
  const args = {
    preflight: false,
    snapshot: false,
    baseline: false,
    manifest: false,
    dryRun: false,
    apply: false,
    verify: false,
    idempotency: false,
    full: false,
    dryRunOnly: false,
    confirm: null,
    manifestPath: null,
    batchId: null
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--snapshot") args.snapshot = true;
    if (arg === "--baseline") args.baseline = true;
    if (arg === "--manifest") args.manifest = true;
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--idempotency") args.idempotency = true;
    if (arg === "--full") args.full = true;
    if (arg === "--dry-run-only") args.dryRunOnly = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--manifest=")) args.manifestPath = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--batch-id=")) args.batchId = String(arg.split("=")[1]).trim();
  }
  if (args.full) {
    args.preflight = true;
    args.snapshot = true;
    args.baseline = true;
    args.manifest = true;
    args.dryRun = true;
    if (!args.dryRunOnly) {
      args.apply = true;
      args.verify = true;
      args.idempotency = true;
    }
  }
  if (!Object.values(args).some((v) => v === true) && !args.manifestPath && !args.batchId && !args.confirm) {
    args.preflight = true;
  }
  return args;
}

function writeReport(filename, data) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, filename);
  fs.writeFileSync(reportPath, `${JSON.stringify(data, null, 2)}\n`);
  return reportPath;
}

function runGit(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function runNpmScript(scriptName) {
  try {
    return execSync(`npm run ${scriptName}`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return `${err.stdout || ""}\n${err.stderr || ""}`;
  }
}

function countDiscoveryDeparturePortTests(output) {
  const passed = (output.match(/^✓/gm) || []).length;
  const failed = (output.match(/^✗/gm) || []).length;
  return { passed, total: passed + failed };
}

function parseTestSummary(output, pattern) {
  const m = output.match(pattern);
  return m ? m[0] : output.split("\n").slice(-5).join("\n");
}

async function countDiscovered(query) {
  const { count } = await exactCountSupabase(root, "discovered_cruises", query);
  return count;
}

async function checkRepositoryBaseline() {
  runGit("git fetch origin main");
  const startingSha = runGit("git rev-parse HEAD");
  const branch = runGit("git rev-parse --abbrev-ref HEAD");
  const workingTree = runGit("git status --porcelain");
  const phase3OnMain = runGit(`git merge-base --is-ancestor ${PHASE3_COMMIT} origin/main && echo yes || echo no`);
  return {
    starting_sha: startingSha,
    branch,
    working_tree_dirty: Boolean(workingTree),
    working_tree_lines: workingTree ? workingTree.split("\n").length : 0,
    phase3_commit: PHASE3_COMMIT,
    phase3_on_origin_main: phase3OnMain.trim() === "yes"
  };
}

async function checkConcurrentImports(sb, runId) {
  const activeLocks = [];
  for (const slug of [...OTHER_LINE_SLUGS, LINE_SLUG]) {
    const key = weeklyLockKey(slug);
    const status = await loadMaintenanceLockStatus(sb, key);
    if (status.held && status.owner_id !== runId) {
      activeLocks.push({ lock_key: key, ...status });
    }
  }
  const controlled = await loadMaintenanceLockStatus(sb, CONTROLLED_LOCK_KEY);
  if (controlled.held && controlled.owner_id !== runId) {
    activeLocks.push({ lock_key: CONTROLLED_LOCK_KEY, ...controlled });
  }

  const runningRuns = await sb(
    "cruise_discovery_runs?status=eq.running&select=id,stats,started_at,cruise_line_id&order=started_at.desc&limit=20"
  ).catch(() => []);

  const leaseCutoffMs = Date.now() - 900 * 1000;
  const foreignRuns = (runningRuns || []).filter((r) => {
    const startedMs = new Date(r.started_at).getTime();
    if (!Number.isFinite(startedMs) || startedMs < leaseCutoffMs) return false;
    const type = r.stats?.run_type || "";
    return /maintenance|production|controlled|batch/i.test(type);
  });

  return {
    blocked: activeLocks.length > 0 || foreignRuns.length > 0,
    active_locks: activeLocks,
    running_import_runs: foreignRuns,
    our_run_id: runId
  };
}

async function verifyPhase3ReferenceData(sb, lineId) {
  const line = (await sb(`ci_cruise_lines?slug=eq.${LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(lineId)}&select=id,name,official_line_ship_id&order=name.asc`
  );
  const withIds = (ships || []).filter((s) => s.official_line_ship_id);
  const sourceIds = (ships || []).map((s) => s.official_line_ship_id).filter(Boolean);
  const dupIds = sourceIds.filter((id, i) => sourceIds.indexOf(id) !== i);
  const prideAmer = (ships || []).filter((s) => s.official_line_ship_id === "PRIDE_AMER");

  const embarkPortCodeMap = adapter.buildEmbarkPortCodeMap({ filters: [] });
  const criticalPorts = [
    { code: "TAR", expect: "Tarragona", not: "Barcelona" },
    { code: "RAV", expect: "Ravenna", not: "Venice" },
    { code: "VCE", expect: "Trieste", not: "Venice" },
    { code: "SAI", expect: "San Antonio", not: "Valparaiso" },
    { code: "INC", expect: "Incheon" },
    { code: "PCV", expect: "Port Canaveral" },
    { code: "SOU", expect: "Southampton" },
    { code: "CIV", expect: "Civitavecchia" },
    { code: "PIR", expect: "Piraeus" },
    { code: "YOK", expect: "Yokohama" }
  ];

  const portChecks = criticalPorts.map(({ code, expect, not }) => {
    const meta = resolveNorwegianDeparturePort({ port_of_departure_code: code }, embarkPortCodeMap);
    const name = meta.canonicalPortName || null;
    return {
      code,
      expected: expect,
      resolved: name,
      ok: name === expect || (expect === "San Antonio" && /San Antonio/i.test(name || "")),
      not_resolved_to: not,
      not_ok: not && name === not
    };
  });

  const gsc = resolveNorwegianDeparturePort({ departure_port: "Great Stirrup Cay" }, embarkPortCodeMap);
  const coco = resolveNorwegianDeparturePort({ departure_port: "CocoCay" }, embarkPortCodeMap);

  const failures = [];
  if (!line) failures.push("missing_ncl_line");
  if ((ships || []).length !== 22) failures.push(`ship_count_${(ships || []).length}_not_22`);
  if (withIds.length !== 22) failures.push(`ships_with_official_id_${withIds.length}_not_22`);
  if (dupIds.length) failures.push("duplicate_ship_source_ids");
  if (prideAmer.length !== 1 || prideAmer[0].name !== "Pride of America") failures.push("pride_amer_mapping");
  if (portChecks.some((p) => !p.ok || p.not_ok)) failures.push("port_mapping_regression");
  if (gsc.canonicalPortName !== "Great Stirrup Cay") failures.push("great_stirrup_cay_missing");
  if (gsc.canonicalPortName === "CocoCay") failures.push("gsc_resolves_to_cococay");

  return {
    passed: failures.length === 0,
    failures,
    line,
    ship_count: (ships || []).length,
    ships_with_official_line_ship_id: withIds.length,
    duplicate_source_ids: [...new Set(dupIds)],
    pride_amer: prideAmer.map((s) => ({ id: s.id, name: s.name, official_line_ship_id: s.official_line_ship_id })),
    port_checks: portChecks,
    great_stirrup_cay: gsc.canonicalPortName,
    cococay_resolves_to: coco.canonicalPortName
  };
}

async function runPreflightTests() {
  const nclOutput = runNpmScript("test:norwegian-discovery");
  const sharedOutput = runNpmScript("test:discovery-departure-port");

  const nclPass = /Norwegian discovery tests passed \(53\)/i.test(nclOutput);
  const sharedCounts = countDiscoveryDeparturePortTests(sharedOutput);
  const sharedFailed = sharedCounts.total - sharedCounts.passed;
  const rawExtractFail = /Public destination API does not expose raw_extract/i.test(sharedOutput);
  const onlyKnownFailure =
    sharedFailed === 1 && rawExtractFail && sharedCounts.passed === 36 && sharedCounts.total === 37;

  return {
    ncl: { output_tail: nclOutput.split("\n").slice(-8).join("\n"), passed: nclPass, count: 53 },
    shared: {
      output_tail: sharedOutput.split("\n").slice(-12).join("\n"),
      passed_count: sharedCounts.passed,
      total_count: sharedCounts.total,
      failed_count: sharedCounts.failed,
      pre_existing_raw_extract_failure: rawExtractFail
    },
    passed: nclPass && onlyKnownFailure
  };
}

async function runLiveSnapshot(sb, line, ships, today) {
  const simulation = await adapter.simulateNorwegianDiscovery({
    cruiseLine: line,
    ships: ships || [],
    today,
    supabaseQuery: (q) => sb(q),
    runEnrichment: false
  });

  const report = {
    generated_at: new Date().toISOString(),
    mode: "norwegian_phase4_live_source_snapshot",
    today,
    source_timestamp: simulation.source_timestamp,
    raw_sailings: simulation.raw_sailing_count,
    ocean_sailings: simulation.ocean_sailing_count,
    eligible_ocean: simulation.eligibility?.publicly_eligible_ocean_sailings,
    within_cutoff: simulation.eligibility?.within_21_day_exclusions,
    cruisetours: simulation.eligibility?.cruisetour_or_package_exclusions,
    import_ready: simulation.eligibility?.import_ready_ocean_sailings,
    blocked_eligible: simulation.blocked_voyage_analysis?.publicly_eligible_blocked ?? 0,
    ships_resolved: simulation.ship_mappings?.resolved_count,
    embark_resolved: simulation.embark_port_audit?.resolved_count,
    production_reconciliation: simulation.production_reconciliation,
    products: simulation.products
  };

  const pathOut = writeReport(`norwegian-phase4-source-snapshot-${today}.json`, {
    ...report,
    products: undefined,
    product_count: simulation.products?.length || 0
  });

  return { report, report_path: pathOut, simulation };
}

async function productionBaseline(sb, lineId) {
  const indexes = await indexExistingNorwegianRecords(sb, lineId);
  const rows = indexes.rows || [];
  const statusCounts = {};
  for (const row of rows) {
    statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
  }

  const legacyRows = rows.filter((r) => isLegacyGenericRow(r));
  const genuine = rows.filter((r) => !isLegacyGenericRow(r) && r.official_sailing_id);
  const activeGenuine = genuine.filter((r) => r.status === "active");

  const report = {
    generated_at: new Date().toISOString(),
    total_rows: rows.length,
    status_counts: statusCounts,
    genuine_voyages: genuine.length,
    active_genuine: activeGenuine.length,
    match_required: statusCounts.match_required || 0,
    hidden: statusCounts.hidden || 0,
    validation_failed: statusCounts.validation_failed || 0,
    legacy_generic_rows: legacyRows.length,
    legacy_row_ids: legacyRows.map((r) => r.id),
    legacy_row_snapshots: legacyRows.map((r) => ({
      id: r.id,
      status: r.status,
      official_url: r.official_url,
      external_key: r.external_key,
      official_sailing_id: r.official_sailing_id
    }))
  };

  const pathOut = writeReport("norwegian-phase4-production-baseline-pre-write.json", report);
  return { report, report_path: pathOut, legacy_snapshots: report.legacy_row_snapshots };
}

function defaultBatchId(today) {
  return `norwegian-phase4-${today}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function buildFrozenManifest(simulation, sb, line, batchId, sourceTimestamp) {
  const selected = selectControlledBatchProducts(simulation.products, { maxWrites: MAX_WRITES });
  if (selected.length !== MAX_WRITES) {
    throw new Error(`Could only select ${selected.length}/${MAX_WRITES} eligible voyages`);
  }

  const distinctShips = new Set(selected.map((p) => p.raw?.ship_code).filter(Boolean));
  const manifest = await buildManifestFromEntries({
    entries: selected,
    cruiseLine: line,
    supabase: sb,
    batchId,
    sourceTimestamp
  });

  manifest.selection_summary = {
    distinct_ships: distinctShips.size,
    ship_codes: [...distinctShips].sort(),
    selection_reasons: selected.map((p) => ({
      official_sailing_id: p.official_sailing_id,
      reason: p.selection_reason || null
    }))
  };

  const filename = `norwegian-phase4-controlled-batch-manifest-${batchId}.json`;
  const manifestPath = writeReport(filename, manifest);
  return { manifest, manifestPath, selected };
}

async function verifyManifestRows(sb, manifest, simulation, today) {
  const sourceById = new Map(
    (simulation.products || [])
      .filter((p) => p.official_sailing_id)
      .map((p) => [p.official_sailing_id, p])
  );
  const revalidation = revalidateManifestAgainstSource(manifest, sourceById, today);
  const indexes = await indexExistingNorwegianRecords(sb, manifest.cruise_line_id);

  const perRow = [];
  for (const entry of manifest.entries || []) {
    const live = sourceById.get(entry.official_sailing_id);
    const existing = indexes.byOfficial.get(entry.official_sailing_id);
    perRow.push({
      official_sailing_id: entry.official_sailing_id,
      source_present: Boolean(live),
      complete_eligible: live?.complete_eligible === true,
      existing_genuine: existing && !isLegacyGenericRow(existing) ? existing.id : null
    });
  }

  return {
    revalidation,
    per_row: perRow,
    passed:
      revalidation.valid &&
      perRow.every((r) => r.source_present && r.complete_eligible && !r.existing_genuine)
  };
}

async function postWriteVerification(sb, manifest, baselineLegacy) {
  const indexes = await indexExistingNorwegianRecords(sb, manifest.cruise_line_id);
  const mismatches = [];
  const verified = [];

  for (const entry of manifest.entries || []) {
    const row =
      indexes.byOfficial.get(entry.official_sailing_id) ||
      indexes.byExternal.get(entry.external_key);
    if (!row) {
      mismatches.push({ official_sailing_id: entry.official_sailing_id, issue: "missing_row" });
      continue;
    }
    const checks = {
      external_key: row.external_key === entry.external_key,
      official_sailing_id: row.official_sailing_id === entry.official_sailing_id,
      ship_id: row.ship_id === entry.resolved_ship_id,
      departure_date: row.departure_date === entry.departure_date,
      nights: Number(row.nights) === Number(entry.duration),
      status_match_required: row.status === "match_required",
      not_active: row.status !== "active"
    };
    if (Object.values(checks).every(Boolean)) {
      verified.push({ id: row.id, official_sailing_id: entry.official_sailing_id, checks });
    } else {
      mismatches.push({ id: row.id, official_sailing_id: entry.official_sailing_id, checks });
    }
  }

  const legacyNow = (indexes.rows || []).filter((r) => isLegacyGenericRow(r));
  const legacyChanged = [];
  for (const before of baselineLegacy || []) {
    const after = legacyNow.find((r) => r.id === before.id);
    if (!after) legacyChanged.push({ id: before.id, issue: "missing" });
    else if (
      after.status !== before.status ||
      after.official_url !== before.official_url ||
      after.external_key !== before.external_key ||
      after.official_sailing_id !== before.official_sailing_id
    ) {
      legacyChanged.push({ id: before.id, before, after });
    }
  }

  return {
    verified_count: verified.length,
    mismatch_count: mismatches.length,
    mismatches,
    legacy_unchanged: legacyChanged.length === 0,
    legacy_changes: legacyChanged,
    passed: verified.length === MAX_WRITES && mismatches.length === 0 && legacyChanged.length === 0
  };
}

async function duplicateAnalysis(sb, lineId) {
  const rows = (await indexExistingNorwegianRecords(sb, lineId)).rows.filter(
    (r) => !isLegacyGenericRow(r) && r.official_sailing_id
  );

  function findDupes(keyFn) {
    const map = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row.id);
    }
    return [...map.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, count: ids.length, ids }));
  }

  return {
    duplicate_official_sailing_ids: findDupes((r) => r.official_sailing_id),
    duplicate_external_keys: findDupes((r) => r.external_key),
    duplicate_itinerary_date: findDupes((r) => `${r.itinerary}|${r.departure_date}`),
    duplicate_identity_keys: findDupes((r) => r.identity_key),
    passed:
      findDupes((r) => r.official_sailing_id).length === 0 &&
      findDupes((r) => r.external_key).length === 0
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const today = perthCalendarDate();
  const sb = createMaintenanceSupabase(root);
  const rest = createSupabaseRest(root);
  const runId = args.batchId || defaultBatchId(today);
  const summary = { run_id: runId, today, steps: {} };

  if (args.preflight || args.full) {
    summary.repo = await checkRepositoryBaseline();
    if (!summary.repo.phase3_on_origin_main) {
      console.error(JSON.stringify({ error: "Phase 3 commit not on origin/main", repo: summary.repo }, null, 2));
      process.exit(2);
    }

    summary.concurrency = await checkConcurrentImports(sb, runId);
    if (summary.concurrency.blocked && args.apply && !args.dryRunOnly) {
      console.error(JSON.stringify({ error: "Another production import is active", concurrency: summary.concurrency }, null, 2));
      process.exit(3);
    }

    summary.reference_data = await verifyPhase3ReferenceData(sb, NCL_LINE_ID);
    if (!summary.reference_data.passed) {
      console.error(JSON.stringify({ error: "Phase 3 reference data regression", reference_data: summary.reference_data }, null, 2));
      process.exit(4);
    }

    summary.tests_pre = await runPreflightTests();
    writeReport("norwegian-phase4-preflight-tests-pre.json", summary.tests_pre);
    if (!summary.tests_pre.passed) {
      console.error(JSON.stringify({ error: "Pre-flight tests failed", tests: summary.tests_pre }, null, 2));
      process.exit(5);
    }
    summary.steps.preflight = "passed";
  }

  const line =
    (await sb(`ci_cruise_lines?slug=eq.${LINE_SLUG}&select=id,name,slug,website_url&limit=1`))?.[0] ||
    summary.reference_data?.line;
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,active,official_line_ship_id&order=name.asc`
  );

  let simulation = null;
  if (args.snapshot || args.manifest || args.dryRun || args.apply || args.full) {
    const snap = await runLiveSnapshot(sb, line, ships, today);
    simulation = snap.simulation;
    summary.source_snapshot = {
      report_path: snap.report_path,
      raw: snap.report.raw_sailings,
      ocean: snap.report.ocean_sailings,
      eligible: snap.report.eligible_ocean,
      within_cutoff: snap.report.within_cutoff,
      cruisetours: snap.report.cruisetours,
      import_ready: snap.report.import_ready,
      blocked: snap.report.blocked_eligible,
      source_timestamp: snap.report.source_timestamp
    };
    summary.steps.snapshot = "completed";
  }

  let baseline = null;
  if (args.baseline || args.manifest || args.apply || args.full) {
    baseline = await productionBaseline(sb, line.id);
    summary.production_baseline = baseline.report;
    summary.steps.baseline = "completed";
  }

  let manifestPath = args.manifestPath;
  let manifest = null;
  if (args.manifest || args.dryRun || args.apply || args.full) {
    if (manifestPath && fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } else if (manifestPath && fs.existsSync(path.join(root, manifestPath))) {
      manifestPath = path.join(root, manifestPath);
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } else {
      const built = await buildFrozenManifest(simulation, sb, line, runId, simulation.source_timestamp);
      manifest = built.manifest;
      manifestPath = built.manifestPath;
    }
    summary.manifest_path = manifestPath;
    summary.batch_id = manifest.batch_id;
    summary.steps.manifest = "frozen";

    const gate = manifest.dry_run_gate;
    summary.dry_run = gate;
    writeReport(`norwegian-phase4-dry-run-${manifest.batch_id}.json`, {
      batch_id: manifest.batch_id,
      dry_run_gate: gate,
      entries: manifest.entries
    });

    const preApplyValidation = await verifyManifestRows(sb, manifest, simulation, today);
    summary.pre_apply_validation = preApplyValidation;
    if (!gate.passed || !preApplyValidation.passed) {
      console.error(JSON.stringify({ error: "Dry-run gate or pre-apply validation failed", summary }, null, 2));
      process.exit(6);
    }
    summary.steps.dry_run = "passed";
  }

  if (args.apply && !args.dryRunOnly) {
    if (args.confirm !== APPLY_CONFIRMATION) {
      throw new Error(`--confirm=${APPLY_CONFIRMATION} required for --apply`);
    }
    const modeGate = resolveNorwegianDiscoveryMode("controlled_batch");
    assertNorwegianWritesAllowed(modeGate);

    const lock = await acquireMaintenanceDbLock(sb, {
      lockKey: CONTROLLED_LOCK_KEY,
      ownerId: runId,
      runId,
      leaseSeconds: 900
    });
    if (!lock.acquired) {
      console.error(JSON.stringify({ error: "Could not acquire controlled batch lock", lock }, null, 2));
      process.exit(7);
    }

    try {
      const preApplyValidation = await verifyManifestRows(sb, manifest, simulation, today);
      if (!preApplyValidation.passed) {
        throw new Error("Pre-apply revalidation failed — aborting entire batch");
      }

      const applyResult = await applyManifestWrites({
        manifest,
        cruiseLine: line,
        supabase: sb,
        maxWrites: MAX_WRITES,
        runId
      });

      summary.apply = applyResult;
      writeReport(`norwegian-phase4-apply-${manifest.batch_id}.json`, applyResult);

      if (applyResult.stats.failed > 0 || applyResult.stats.inserted !== MAX_WRITES) {
        if (applyResult.stats.inserted_ids?.length) {
          summary.rollback = await rollbackInsertedRows(sb, applyResult.stats.inserted_ids);
        }
        throw new Error(
          `Apply produced ${applyResult.stats.inserted} inserts (expected ${MAX_WRITES}), failed=${applyResult.stats.failed}`
        );
      }

      summary.steps.apply = "completed";
    } finally {
      await releaseMaintenanceDbLock(sb, { lockKey: CONTROLLED_LOCK_KEY, ownerId: runId });
    }
  }

  if (args.verify && manifest && !args.dryRunOnly) {
    summary.post_write_verification = await postWriteVerification(sb, manifest, baseline?.legacy_snapshots);
    writeReport(`norwegian-phase4-post-write-verify-${manifest.batch_id}.json`, summary.post_write_verification);
    if (!summary.post_write_verification.passed) {
      console.error(JSON.stringify({ error: "Post-write verification failed", summary }, null, 2));
      process.exit(8);
    }
    summary.steps.verify = "passed";
  }

  if (args.idempotency && manifest && !args.dryRunOnly) {
    const beforeCount = (await indexExistingNorwegianRecords(sb, line.id)).rows.filter(
      (r) => !isLegacyGenericRow(r) && r.official_sailing_id
    ).length;

    const idemResult = await applyManifestWrites({
      manifest,
      cruiseLine: line,
      supabase: sb,
      maxWrites: MAX_WRITES,
      runId: `${runId}-idempotency`
    });

    const afterCount = (await indexExistingNorwegianRecords(sb, line.id)).rows.filter(
      (r) => !isLegacyGenericRow(r) && r.official_sailing_id
    ).length;

    summary.idempotency = {
      ...idemResult,
      row_count_before: beforeCount,
      row_count_after: afterCount,
      row_count_delta: afterCount - beforeCount,
      passed:
        idemResult.stats.inserted === 0 &&
        idemResult.stats.duplicate_skips === MAX_WRITES &&
        afterCount === beforeCount
    };
    writeReport(`norwegian-phase4-idempotency-${manifest.batch_id}.json`, summary.idempotency);

    if (!summary.idempotency.passed) {
      console.error(JSON.stringify({ error: "Idempotency proof failed", summary }, null, 2));
      process.exit(9);
    }
    summary.steps.idempotency = "passed";
  }

  if ((args.verify || args.idempotency || args.full) && simulation && !args.dryRunOnly) {
    summary.duplicate_analysis = await duplicateAnalysis(sb, line.id);
    const reconSimulation = await adapter.simulateNorwegianDiscovery({
      cruiseLine: line,
      ships,
      today,
      supabaseQuery: (q) => sb(q),
      runEnrichment: false
    });
    summary.reconciliation = reconSimulation.production_reconciliation;
    writeReport(`norwegian-phase4-reconciliation-${manifest?.batch_id || runId}.json`, summary.reconciliation);
  }

  if ((args.apply || args.full) && !args.dryRunOnly) {
    summary.tests_post = await runPreflightTests();
    writeReport("norwegian-phase4-preflight-tests-post.json", summary.tests_post);
    summary.steps.tests_post = summary.tests_post.passed ? "passed" : "failed";
  }

  summary.ending_sha = runGit("git rev-parse HEAD");
  summary.production_voyage_writes = args.apply && !args.dryRunOnly ? MAX_WRITES : 0;
  summary.new_publicly_active_ncl_voyages = 0;

  const finalReportPath = writeReport(`norwegian-phase4-final-report-${runId}.json`, summary);
  console.log(JSON.stringify({ ok: true, final_report: finalReportPath, summary }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
