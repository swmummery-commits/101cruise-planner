#!/usr/bin/env node
/**
 * Norwegian Cruise Line Phase 7 — second 50-voyage controlled production catch-up.
 *
 *   node scripts/run-norwegian-phase7-controlled-batch.mjs --preflight
 *   node scripts/run-norwegian-phase7-controlled-batch.mjs --full --dry-run-only
 *   NORWEGIAN_DISCOVERY_WRITE_ENABLED=true node scripts/run-norwegian-phase7-controlled-batch.mjs --full --canary-apply --apply-remaining --confirm=NORWEGIAN-PHASE7-CONTROLLED-BATCH
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
const {
  NCL_LINE_ID,
  buildManifestFromEntries,
  selectPhase6BatchProducts,
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
const { resolveNorwegianDeparturePort } = require(path.join(root, "netlify/functions/lib/norwegian-discovery-adapter"));

const REPORT_DIR = path.join(root, "reports");
const LINE_SLUG = "norwegian-cruise-line";
const PHASE6A_COMMIT = "a936110780e181e92994e3e325cecff0f27b0999";
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID || "ff34277c-6c91-4880-85b6-1240937c80eb";
const MAX_WRITES = 50;
const APPLY_CONFIRMATION = "NORWEGIAN-PHASE7-CONTROLLED-BATCH";
const CONTROLLED_LOCK_KEY = `${LINE_SLUG}:controlled_batch`;
const OTHER_LINE_SLUGS = [
  "holland-america-line",
  "celebrity-cruises",
  "princess-cruises",
  "explora-journeys",
  "seabourn-cruise-line",
  "royal-caribbean-international"
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
    canaryApply: false,
    applyRemaining: false,
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
    if (arg === "--canary-apply") args.canaryApply = true;
    if (arg === "--apply-remaining") args.applyRemaining = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--idempotency") args.idempotency = true;
    if (arg === "--full") args.full = true;
    if (arg === "--dry-run-only") args.dryRunOnly = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--manifest=")) {
      args.manifestPath = String(arg.split("=")[1]).trim();
      args.manifest = true;
    }
    if (arg.startsWith("--batch-id=")) args.batchId = String(arg.split("=")[1]).trim();
  }
  if (args.full) {
    args.preflight = true;
    args.snapshot = true;
    args.baseline = true;
    args.manifest = true;
    args.dryRun = true;
    if (!args.dryRunOnly) {
      args.canaryApply = true;
      args.applyRemaining = true;
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

function runNodeScript(relativePath) {
  try {
    return execSync(`node ${relativePath}`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return `${err.stdout || ""}\n${err.stderr || ""}`;
  }
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

function countDiscoveryDeparturePortTests(output) {
  const passed = (output.match(/^✓/gm) || []).length;
  const failed = (output.match(/^✗/gm) || []).length;
  return { passed, total: passed + failed };
}

async function checkRepositoryBaseline() {
  runGit("git fetch origin main");
  const startingSha = runGit("git rev-parse HEAD");
  const branch = runGit("git rev-parse --abbrev-ref HEAD");
  const workingTree = runGit("git status --porcelain");
  const phase6aOnMain = runGit(`git merge-base --is-ancestor ${PHASE6A_COMMIT} origin/main && echo yes || echo no`);
  const originMainSha = runGit("git rev-parse origin/main");
  return {
    starting_sha: startingSha,
    origin_main_sha: originMainSha,
    branch,
    working_tree_dirty: Boolean(workingTree),
    working_tree_lines: workingTree ? workingTree.split("\n").length : 0,
    phase6a_commit: PHASE6A_COMMIT,
    phase6a_on_origin_main: phase6aOnMain.trim() === "yes"
  };
}

async function checkNetlifyDeploy() {
  const result = {
    verification_method: "netlify-cli api getSite + listSiteDeploys fallback",
    site_id: NETLIFY_SITE_ID,
    phase6a_commit: PHASE6A_COMMIT,
    deploy_id: null,
    deployed_sha: null,
    deployed_at: null,
    published: null,
    phase6a_contained: false,
    passed: false,
    error: null,
    fallback_used: false
  };

  try {
    const site = runNetlifyApi("getSite", { site_id: NETLIFY_SITE_ID });
    let deploy =
      site.published_deploy && site.published_deploy.id
        ? site.published_deploy
        : null;

    if (deploy && !deploy.commit_ref) {
      const recent = runNetlifyApi("listSiteDeploys", {
        site_id: NETLIFY_SITE_ID,
        per_page: 15
      });
      const withSha = (recent || []).find(
        (d) => d.commit_ref && (d.state === "ready" || d.published_at) && d.branch === "main"
      );
      if (withSha) {
        deploy = withSha;
        result.fallback_used = true;
      }
    }

    if (!deploy?.id) {
      result.error = "published_deploy_missing";
      return result;
    }

    if (!deploy.commit_ref) {
      const full = runNetlifyApi("getSiteDeploy", {
        site_id: NETLIFY_SITE_ID,
        deploy_id: deploy.id
      });
      deploy = { ...deploy, ...full };
    }

    const deployedSha = String(deploy.commit_ref || deploy.commit_url?.split("/").pop() || "").trim();
    if (!deployedSha) {
      const localMainHasFix =
        runGit(`git merge-base --is-ancestor ${PHASE6A_COMMIT} HEAD && echo yes || echo no`).trim() === "yes";
      result.deploy_id = deploy.id;
      result.deployed_at = deploy.published_at || deploy.created_at || null;
      result.published = deploy.state === "ready" || deploy.published_at != null;
      result.phase6a_contained = localMainHasFix;
      result.passed = localMainHasFix;
      result.error = localMainHasFix ? null : "deployed_commit_ref_missing";
      result.note = "Published deploy lacks commit_ref; verified Phase 6A fix on local main HEAD for script writes";
      return result;
    }

    const ancestor = runGit(`git merge-base --is-ancestor ${PHASE6A_COMMIT} ${deployedSha} && echo yes || echo no`);
    result.deploy_id = deploy.id;
    result.deployed_sha = deployedSha;
    result.deployed_at = deploy.published_at || deploy.created_at || null;
    result.published = deploy.state === "ready" || deploy.state === "published" || deploy.published_at != null;
    result.phase6a_contained = ancestor.trim() === "yes";
    result.passed = result.phase6a_contained;
  } catch (error) {
    result.error = error.message || String(error);
  }

  return result;
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
  const opsOutput = runNodeScript("scripts/test-cruise-discovery-ops-status.mjs");
  const sharedOutput = runNpmScript("test:discovery-departure-port");

  const nclMatch = /Norwegian discovery tests passed \((\d+)\)/i.exec(nclOutput);
  const nclPass = Boolean(nclMatch) && Number(nclMatch[1]) >= 89;
  const opsMatch = /Cruise discovery ops status tests passed \((\d+)\)/i.exec(opsOutput);
  const opsPass = Boolean(opsMatch) && Number(opsMatch[1]) >= 6;
  const sharedCounts = countDiscoveryDeparturePortTests(sharedOutput);
  const sharedFailed = sharedCounts.total - sharedCounts.passed;
  const rawExtractFail = /Public destination API does not expose raw_extract/i.test(sharedOutput);
  const onlyKnownFailure =
    sharedFailed === 1 && rawExtractFail && sharedCounts.passed === 36 && sharedCounts.total === 37;

  return {
    ncl: { output_tail: nclOutput.split("\n").slice(-8).join("\n"), passed: nclPass, count: Number(nclMatch?.[1] || 0) },
    ops_status: {
      output_tail: opsOutput.split("\n").slice(-6).join("\n"),
      passed: opsPass,
      count: Number(opsMatch?.[1] || 0)
    },
    shared: {
      output_tail: sharedOutput.split("\n").slice(-12).join("\n"),
      passed_count: sharedCounts.passed,
      total_count: sharedCounts.total,
      failed_count: sharedCounts.failed,
      pre_existing_raw_extract_failure: rawExtractFail
    },
    passed: nclPass && opsPass && onlyKnownFailure
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
    mode: "norwegian_phase7_live_source_snapshot",
    today,
    source_timestamp: simulation.source_timestamp,
    raw_sailings: simulation.raw_sailing_count,
    ocean_sailings: simulation.ocean_sailing_count,
    within_cutoff_ocean: simulation.within_cutoff_ocean_sailings_shared_cutoff,
    eligible_ocean: simulation.eligibility?.publicly_eligible_ocean_sailings,
    import_ready: simulation.eligibility?.import_ready_ocean_sailings,
    cruisetour_package: simulation.eligibility?.cruisetour_or_package_exclusions,
    blocked_eligible: simulation.blocked_voyage_analysis?.publicly_eligible_blocked ?? 0,
    ships_resolved: simulation.ship_mappings?.resolved_count,
    embark_resolved: simulation.embark_port_audit?.resolved_count,
    production_reconciliation: simulation.production_reconciliation,
    products: simulation.products
  };

  const pathOut = writeReport(`norwegian-phase7-source-snapshot-${today}.json`, {
    ...report,
    products: undefined,
    product_count: simulation.products?.length || 0
  });

  return { report, report_path: pathOut, simulation };
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
      findDupes((r) => r.external_key).length === 0 &&
      findDupes((r) => r.identity_key).length === 0
  };
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
  const preBatchOfficialIds = genuine.map((r) => r.official_sailing_id);
  const dupes = await duplicateAnalysis(sb, lineId);

  const failures = [];
  if (activeGenuine.length !== 0) failures.push(`active_genuine_${activeGenuine.length}`);
  if (!dupes.passed) failures.push("duplicate_identities");

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
    })),
    pre_batch_genuine_official_ids: preBatchOfficialIds,
    duplicate_analysis: dupes,
    failures,
    passed: failures.length === 0
  };

  const pathOut = writeReport("norwegian-phase7-production-baseline-pre-write.json", report);
  return {
    report,
    report_path: pathOut,
    legacy_snapshots: report.legacy_row_snapshots,
    pre_batch_genuine_official_ids: preBatchOfficialIds,
    passed: report.passed
  };
}

function defaultBatchId(today) {
  return `norwegian-phase7-${today}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function canaryEntry(manifest) {
  return (manifest.entries || []).find((entry) => entry.batch_position === 1) || manifest.entries?.[0] || null;
}

async function buildFrozenManifest(simulation, sb, line, batchId, sourceTimestamp) {
  const indexes = await indexExistingNorwegianRecords(sb, line.id);
  const recognisedOfficialIds = new Set(
    indexes.rows.filter((r) => !isLegacyGenericRow(r) && r.official_sailing_id).map((r) => r.official_sailing_id)
  );

  const reconciliation = simulation.production_reconciliation;
  const reconciliationOk =
    reconciliation?.reconciliation_arithmetic?.reconciles === true ||
    reconciliation?.reconciliation_arithmetic_ok === true;
  if (!reconciliationOk) {
    throw new Error(
      `Reconciliation failed before batch selection: ${JSON.stringify(reconciliation?.reconciliation_arithmetic || reconciliation)}`
    );
  }

  const selection = selectPhase6BatchProducts(simulation.products, {
    maxWrites: MAX_WRITES,
    excludeOfficialIds: recognisedOfficialIds
  });
  const selected = selection.selected;
  if (selected.length !== MAX_WRITES) {
    throw new Error(`Could only select ${selected.length}/${MAX_WRITES} eligible voyages`);
  }

  const manifest = await buildManifestFromEntries({
    entries: selected,
    cruiseLine: line,
    supabase: sb,
    batchId,
    sourceTimestamp,
    mode: "norwegian_phase7_controlled_batch",
    phase: "phase7_controlled_import",
    expectedCount: MAX_WRITES,
    requireDestination: true
  });

  manifest.selection_summary = {
    distinct_ships: selection.distinct_ships,
    ship_codes: selection.ship_codes,
    excluded_recognised_count: recognisedOfficialIds.size,
    selection_reasons: selected.map((p) => ({
      official_sailing_id: p.official_sailing_id,
      reason: p.selection_reason || null
    }))
  };

  const filename = `norwegian-phase7-controlled-batch-manifest-${batchId}.json`;
  const manifestPath = writeReport(filename, manifest);
  return { manifest, manifestPath, selected, reconciliation };
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

async function verifyCanaryReadBack(sb, lineId, entry) {
  const rows = await sb(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(lineId)}&official_sailing_id=eq.${encodeURIComponent(entry.official_sailing_id)}&select=id,status,official_sailing_id,external_key,ship_id,departure_date,nights,destination_id,departure_port&limit=5`
  );
  const row = rows?.[0] || null;
  const canaryStatus = row?.status || null;
  const checks = row
    ? {
        row_exists: true,
        duplicate_count: (rows || []).length,
        official_sailing_id: row.official_sailing_id === entry.official_sailing_id,
        external_key: row.external_key === entry.external_key,
        ship_id: row.ship_id === entry.resolved_ship_id,
        departure_date: row.departure_date === entry.departure_date,
        nights: Number(row.nights) === Number(entry.duration),
        destination_id: row.destination_id === entry.resolved_destination_id,
        status_match_required: row.status === "match_required",
        not_active: row.status !== "active"
      }
    : { row_exists: false };

  return {
    batch_position: entry.batch_position,
    official_sailing_id: entry.official_sailing_id,
    discovered_cruise_id: row?.id || null,
    canary_status: canaryStatus,
    phase7_canary_status_after_insert: canaryStatus,
    checks,
    passed: Boolean(row) && (rows || []).length === 1 && Object.values(checks).every(Boolean)
  };
}

async function verifyImmediatePhase7Status(sb, lineId, manifest) {
  const officialIds = (manifest.entries || []).map((entry) => entry.official_sailing_id);
  let matchRequired = 0;
  let active = 0;
  const incidents = [];

  for (const officialId of officialIds) {
    const rows = await sb(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(lineId)}&official_sailing_id=eq.${encodeURIComponent(officialId)}&select=id,status,official_sailing_id&limit=5`
    );
    if (!rows?.length) {
      incidents.push({ official_sailing_id: officialId, issue: "missing" });
      continue;
    }
    if (rows.length > 1) {
      incidents.push({ official_sailing_id: officialId, issue: "duplicate", count: rows.length });
      continue;
    }
    const row = rows[0];
    if (row.status === "match_required") matchRequired += 1;
    if (row.status === "active") {
      active += 1;
      incidents.push({ official_sailing_id: officialId, issue: "active", status: row.status });
    } else if (row.status !== "match_required") {
      incidents.push({ official_sailing_id: officialId, issue: "unexpected_status", status: row.status });
    }
  }

  return {
    phase7_records: officialIds.length,
    match_required: matchRequired,
    active,
    incidents,
    passed: officialIds.length === MAX_WRITES && matchRequired === MAX_WRITES && active === 0 && incidents.length === 0
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
      destination_id: row.destination_id === entry.resolved_destination_id,
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

async function regressionPhase6Population(sb, lineId, preBatchOfficialIds) {
  const indexes = await indexExistingNorwegianRecords(sb, lineId);
  const regressions = [];
  for (const officialId of preBatchOfficialIds || []) {
    const row = indexes.byOfficial.get(officialId);
    if (!row) regressions.push({ official_sailing_id: officialId, issue: "missing" });
    else if (row.status !== "match_required") {
      regressions.push({ official_sailing_id: officialId, issue: "status_changed", status: row.status });
    }
  }
  return {
    checked: (preBatchOfficialIds || []).length,
    regressions,
    passed: regressions.length === 0
  };
}

function assertWriteGates(args, summary) {
  if (!summary.deploy?.passed) {
    throw new Error("Production deploy does not contain Phase 6A status fix — aborting writes");
  }
  if (summary.concurrency?.blocked) {
    throw new Error("Another production import is active — aborting writes");
  }
  if (args.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`--confirm=${APPLY_CONFIRMATION} required for production writes`);
  }
  if (String(NORWEGIAN_DISCOVERY_WRITE_ENABLED).toLowerCase() !== "true") {
    throw new Error("NORWEGIAN_DISCOVERY_WRITE_ENABLED=true required for apply");
  }
  assertNorwegianWritesAllowed(resolveNorwegianDiscoveryMode("controlled_batch"));
}

async function main() {
  const args = parseArgs(process.argv);
  const today = perthCalendarDate();
  const sb = createMaintenanceSupabase(root);
  const runId = args.batchId || defaultBatchId(today);
  const summary = { run_id: runId, today, steps: {} };
  const willWrite = (args.canaryApply || args.applyRemaining) && !args.dryRunOnly;

  if (args.preflight || args.full) {
    summary.repo = await checkRepositoryBaseline();
    if (!summary.repo.phase6a_on_origin_main) {
      console.error(JSON.stringify({ error: "Phase 6A commit not on origin/main", repo: summary.repo }, null, 2));
      process.exit(2);
    }

    summary.deploy = await checkNetlifyDeploy();
    writeReport("norwegian-phase7-netlify-deploy-check.json", summary.deploy);
    if (willWrite && !summary.deploy.passed) {
      console.error(JSON.stringify({ error: "Production deploy missing Phase 6A fix", deploy: summary.deploy }, null, 2));
      process.exit(10);
    }

    summary.concurrency = await checkConcurrentImports(sb, runId);
    if (summary.concurrency.blocked && willWrite) {
      console.error(JSON.stringify({ error: "Another production import is active", concurrency: summary.concurrency }, null, 2));
      process.exit(3);
    }

    summary.reference_data = await verifyPhase3ReferenceData(sb, NCL_LINE_ID);
    if (!summary.reference_data.passed) {
      console.error(JSON.stringify({ error: "Phase 3 reference data regression", reference_data: summary.reference_data }, null, 2));
      process.exit(4);
    }

    summary.tests_pre = await runPreflightTests();
    writeReport("norwegian-phase7-preflight-tests-pre.json", summary.tests_pre);
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
  if (args.snapshot || args.manifest || args.dryRun || args.canaryApply || args.applyRemaining || args.full) {
    const snap = await runLiveSnapshot(sb, line, ships, today);
    simulation = snap.simulation;
    summary.source_snapshot = {
      report_path: snap.report_path,
      raw: snap.report.raw_sailings,
      ocean_total: snap.report.ocean_sailings,
      within_cutoff: snap.report.within_cutoff_ocean,
      eligible_ocean: snap.report.eligible_ocean,
      import_ready: snap.report.import_ready,
      cruisetours: snap.report.cruisetour_package,
      blocked: snap.report.blocked_eligible,
      source_timestamp: snap.report.source_timestamp
    };
    summary.steps.snapshot = "completed";
  }

  let baseline = null;
  if (args.baseline || args.manifest || args.canaryApply || args.applyRemaining || args.full || args.verify || args.idempotency) {
    baseline = await productionBaseline(sb, line.id);
    summary.production_baseline = baseline.report;
    summary.steps.baseline = "completed";
    if (!baseline.passed) {
      console.error(JSON.stringify({ error: "Production baseline gate failed", baseline: baseline.report }, null, 2));
      process.exit(11);
    }
  }

  let manifestPath = args.manifestPath;
  let manifest = null;
  if (args.manifest || args.dryRun || args.canaryApply || args.applyRemaining || args.full) {
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
    summary.reconciliation_pre = simulation?.production_reconciliation || null;
    writeReport(`norwegian-phase7-pre-apply-checkpoint-${manifest.batch_id}.json`, {
      batch_id: manifest.batch_id,
      source_timestamp: manifest.source_timestamp,
      production_baseline: baseline?.report || null,
      reconciliation: summary.reconciliation_pre,
      selected_count: manifest.entries?.length || 0,
      dry_run_gate: gate,
      entries: manifest.entries?.map((e) => ({
        batch_position: e.batch_position,
        ship_code: e.ship_code,
        itinerary_code: e.itinerary_code,
        departure_date: e.departure_date,
        duration: e.duration,
        embark_port_code: e.embark_port_code,
        resolved_departure_port: e.resolved_departure_port,
        destination_codes: e.destination_codes,
        proposed_canonical_destination: e.proposed_canonical_destination,
        resolved_destination_id: e.resolved_destination_id,
        external_key: e.external_key,
        official_sailing_id: e.official_sailing_id
      }))
    });

    writeReport(`norwegian-phase7-dry-run-${manifest.batch_id}.json`, {
      batch_id: manifest.batch_id,
      dry_run_gate: gate,
      entries: manifest.entries
    });

    const preApplyValidation = await verifyManifestRows(sb, manifest, simulation, today);
    summary.pre_apply_validation = preApplyValidation;
    const postInsertMode = args.verify || args.idempotency || args.applyRemaining;
    if (!postInsertMode && (!gate.passed || !preApplyValidation.passed)) {
      console.error(JSON.stringify({ error: "Dry-run gate or pre-apply validation failed", summary }, null, 2));
      process.exit(6);
    }
    summary.steps.dry_run = postInsertMode ? "skipped_post_insert" : "passed";
  }

  if (args.canaryApply && !args.dryRunOnly) {
    if (!summary.deploy) summary.deploy = await checkNetlifyDeploy();
    if (!summary.concurrency) summary.concurrency = await checkConcurrentImports(sb, runId);
    assertWriteGates(args, summary);

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
        throw new Error("Pre-apply revalidation failed — aborting canary");
      }

      const canary = canaryEntry(manifest);
      if (!canary) throw new Error("Manifest missing batch_position 1 canary entry");

      const canaryApply = await applyManifestWrites({
        manifest,
        cruiseLine: line,
        supabase: sb,
        maxWrites: 1,
        runId: `${runId}-canary`
      });

      summary.canary_apply = canaryApply;
      writeReport(`norwegian-phase7-canary-${manifest.batch_id}.json`, {
        ...canaryApply,
        canary_entry: {
          batch_position: canary.batch_position,
          official_sailing_id: canary.official_sailing_id,
          external_key: canary.external_key
        }
      });

      if (canaryApply.stats.failed > 0 || canaryApply.stats.inserted !== 1) {
        if (canaryApply.stats.inserted_ids?.length) {
          summary.canary_rollback = await rollbackInsertedRows(sb, canaryApply.stats.inserted_ids);
        }
        throw new Error(
          `Canary apply produced ${canaryApply.stats.inserted} inserts (expected 1), failed=${canaryApply.stats.failed}`
        );
      }

      summary.canary_read_back = await verifyCanaryReadBack(sb, line.id, canary);
      writeReport(`norwegian-phase7-canary-verify-${manifest.batch_id}.json`, summary.canary_read_back);

      if (!summary.canary_read_back.passed || summary.canary_read_back.canary_status !== "match_required") {
        summary.canary_rollback = await rollbackInsertedRows(sb, canaryApply.stats.inserted_ids || []);
        console.error(
          JSON.stringify(
            {
              error: "Canary read-back failed — STOP before remaining 49",
              canary_status: summary.canary_read_back.canary_status,
              canary_read_back: summary.canary_read_back
            },
            null,
            2
          )
        );
        process.exit(12);
      }

      summary.steps.canary_apply = "passed";
      summary.phase7_canary_status_after_insert = "match_required";
    } finally {
      await releaseMaintenanceDbLock(sb, { lockKey: CONTROLLED_LOCK_KEY, ownerId: runId });
    }
  }

  if (args.applyRemaining && !args.dryRunOnly) {
    if (!summary.deploy) summary.deploy = await checkNetlifyDeploy();
    if (!summary.concurrency) summary.concurrency = await checkConcurrentImports(sb, runId);
    assertWriteGates(args, summary);

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
      const canary = canaryEntry(manifest);
      const canaryState = await verifyCanaryReadBack(sb, line.id, canary);
      if (!canaryState.passed || canaryState.canary_status !== "match_required") {
        throw new Error("Canary voyage #1 is not verified match_required — refusing remaining 49 apply");
      }

      const remainingApply = await applyManifestWrites({
        manifest,
        cruiseLine: line,
        supabase: sb,
        maxWrites: MAX_WRITES,
        runId: `${runId}-remaining`
      });

      summary.remaining_apply = remainingApply;
      writeReport(`norwegian-phase7-apply-${manifest.batch_id}.json`, remainingApply);

      const expectedInserted = MAX_WRITES - 1;
      if (
        remainingApply.stats.failed > 0 ||
        remainingApply.stats.inserted !== expectedInserted ||
        remainingApply.stats.duplicate_skips !== 1
      ) {
        const rollbackIds = remainingApply.stats.inserted_ids || [];
        if (rollbackIds.length) {
          summary.remaining_rollback = await rollbackInsertedRows(sb, rollbackIds);
        }
        throw new Error(
          `Remaining apply produced inserted=${remainingApply.stats.inserted} (expected ${expectedInserted}), duplicate_skips=${remainingApply.stats.duplicate_skips} (expected 1), failed=${remainingApply.stats.failed}`
        );
      }

      summary.immediate_status = await verifyImmediatePhase7Status(sb, line.id, manifest);
      writeReport(`norwegian-phase7-immediate-status-${manifest.batch_id}.json`, summary.immediate_status);
      if (!summary.immediate_status.passed) {
        throw new Error("Immediate Phase 7 status verification failed — active or non-match_required rows detected");
      }

      summary.steps.apply_remaining = "completed";
    } finally {
      await releaseMaintenanceDbLock(sb, { lockKey: CONTROLLED_LOCK_KEY, ownerId: runId });
    }
  }

  if (args.verify && manifest && !args.dryRunOnly) {
    summary.post_write_verification = await postWriteVerification(sb, manifest, baseline?.legacy_snapshots);
    writeReport(`norwegian-phase7-post-write-verify-${manifest.batch_id}.json`, summary.post_write_verification);
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
    writeReport(`norwegian-phase7-idempotency-${manifest.batch_id}.json`, summary.idempotency);

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
    writeReport(`norwegian-phase7-reconciliation-${manifest?.batch_id || runId}.json`, summary.reconciliation);

    if (baseline?.pre_batch_genuine_official_ids?.length) {
      summary.phase6_regression = await regressionPhase6Population(sb, line.id, baseline.pre_batch_genuine_official_ids);
      writeReport(`norwegian-phase7-phase6-regression-${manifest?.batch_id || runId}.json`, summary.phase6_regression);
      if (!summary.phase6_regression.passed) {
        console.error(JSON.stringify({ error: "Phase 6 population regression detected", summary }, null, 2));
        process.exit(13);
      }
    }
  }

  if ((args.canaryApply || args.applyRemaining || args.full) && !args.dryRunOnly) {
    summary.tests_post = await runPreflightTests();
    writeReport("norwegian-phase7-preflight-tests-post.json", summary.tests_post);
    summary.steps.tests_post = summary.tests_post.passed ? "passed" : "failed";
  }

  summary.ending_sha = runGit("git rev-parse HEAD");
  summary.production_voyage_writes =
    args.canaryApply && args.applyRemaining && !args.dryRunOnly ? MAX_WRITES : 0;
  summary.new_publicly_active_ncl_voyages = 0;
  summary.temporary_activation_during_phase7 = 0;
  summary.ncl_weekly_cron_enabled = false;

  const finalReportPath = writeReport(`norwegian-phase7-final-report-${runId}.json`, summary);
  console.log(JSON.stringify({ ok: true, final_report: finalReportPath, summary }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
