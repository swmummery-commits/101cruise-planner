#!/usr/bin/env node
/**
 * Carnival Cruise Line — Prompt 5 production catch-up (frozen master manifest, 250-record chunks).
 *
 *   node scripts/run-carnival-full-catchup.mjs --preflight
 *   node scripts/run-carnival-full-catchup.mjs --manifest
 *   CARNIVAL_DISCOVERY_WRITE_ENABLED=true node scripts/run-carnival-full-catchup.mjs --apply --confirm=CARNIVAL-FULL-CATCHUP
 *   CARNIVAL_DISCOVERY_WRITE_ENABLED=true node scripts/run-carnival-full-catchup.mjs --full --apply --confirm=CARNIVAL-FULL-CATCHUP
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
const {
  simulateCclDiscovery,
  catalogueDestinations,
  clearCclFetchCache,
  officialSailingId
} = require(path.join(root, "netlify/functions/lib/carnival-discovery-adapter"));
const {
  buildCclBatchManifest,
  indexExistingCclRecords,
  applyCclBatchWrites
} = require(path.join(root, "netlify/functions/lib/carnival-discovery-writes"));
const { evaluatePreApplyQualityGate, CCL_LINE_SLUG, computeManifestHash } = require(path.join(
  root,
  "netlify/functions/lib/carnival-controlled-batch"
));
const {
  MAX_CCL_CATCHUP_CHUNK,
  CATCHUP_CONFIRM_TOKEN,
  selectCatchupCandidates,
  buildMasterManifest,
  splitMasterIntoChunks,
  validateMasterManifest,
  validateCatchupChunk,
  chunkManifestToApplyManifest,
  computeSourceSnapshotId
} = require(path.join(root, "netlify/functions/lib/carnival-final-catchup"));
const { auditCclProductionInventory, buildCatchupPlan } = require(path.join(
  root,
  "netlify/functions/lib/carnival-inventory-audit"
));
const { resolveCarnivalDiscoveryMode, assertCarnivalWritesAllowed } = require(path.join(
  root,
  "netlify/functions/lib/carnival-discovery-mode"
));
const {
  countOfficialCclRows,
  fetchCclRowsBySailingIds,
  verifyManifestRowsAgainstProduction
} = require(path.join(root, "netlify/functions/lib/carnival-post-write-verification"));
const { runCclWeeklyMaintenance } = require(path.join(root, "netlify/functions/lib/carnival-weekly-maintenance"));
const { isCarnivalWeeklyReconciliationEnabled } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));
const { perthCalendarDate, daysUntilDeparture } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const {
  acquireMaintenanceDbLock,
  releaseMaintenanceDbLock,
  weeklyLockKey
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-locks"));

const REPORT_DIR = path.join(root, "reports");

function parseArgs(argv) {
  const args = {
    preflight: false,
    manifest: false,
    apply: false,
    full: false,
    confirm: null,
    masterPath: null,
    resumeFromChunk: 1,
    deltaApply: false,
    weeklyDryRun: false,
    weeklyApply: false,
    finalDryRun: false
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--manifest") args.manifest = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--full") args.full = true;
    if (arg === "--delta-apply") args.deltaApply = true;
    if (arg === "--weekly-dry-run") args.weeklyDryRun = true;
    if (arg === "--weekly-apply") args.weeklyApply = true;
    if (arg === "--final-dry-run") args.finalDryRun = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--master-path=")) args.masterPath = path.resolve(arg.split("=")[1]);
    if (arg.startsWith("--resume-from-chunk=")) args.resumeFromChunk = Number(arg.split("=")[1]);
    if (arg.startsWith("--limit=") || arg.startsWith("--batch-size=")) {
      throw new Error("Carnival catch-up rejects custom limits. Hard maximum is 250 per batch.");
    }
  }
  if (args.full) {
    args.preflight = true;
    args.manifest = true;
    args.apply = true;
    args.deltaApply = true;
    args.weeklyDryRun = true;
    args.finalDryRun = true;
  }
  if (!Object.values(args).some((v) => v === true) && !args.masterPath && !args.confirm) {
    args.preflight = true;
  }
  return args;
}

function writeReport(name, data) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, name);
  fs.writeFileSync(reportPath, `${JSON.stringify(data, null, 2)}\n`);
  return reportPath;
}

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function assertWeeklyReconciliationDisabled() {
  if (isCarnivalWeeklyReconciliationEnabled()) {
    throw new Error("CARNIVAL_WEEKLY_RECONCILIATION_ENABLED must remain false during catch-up");
  }
}

function assertWritesEnabled() {
  if (String(process.env.CARNIVAL_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("CARNIVAL_DISCOVERY_WRITE_ENABLED=true required for writes");
  }
}

function assertCatchupApplyGates(args) {
  assertWritesEnabled();
  if (args.confirm !== CATCHUP_CONFIRM_TOKEN) {
    throw new Error(`--confirm=${CATCHUP_CONFIRM_TOKEN} required`);
  }
  assertCarnivalWritesAllowed(resolveCarnivalDiscoveryMode("full_catchup"));
}

async function loadLineContext(sb) {
  const line = (
    await sb(
      `ci_cruise_lines?slug=eq.${encodeURIComponent(CCL_LINE_SLUG)}&select=id,name,slug,website_url,cruise_search_url&limit=1`
    )
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${CCL_LINE_SLUG}`);
  const [ships, shipAliases, destRows] = await Promise.all([
    sb(`ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id,active&order=name.asc`),
    sb(`cruise_ship_aliases?cruise_line_id=eq.${line.id}&select=ship_id,raw_alias,normalised_alias`),
    sb("destinations?select=id,name,slug,status,classification_enabled")
  ]);
  return {
    line,
    ships: ships || [],
    shipAliases: shipAliases || [],
    destinations: catalogueDestinations(destRows || [])
  };
}

async function runLiveSimulation(sb, today) {
  clearCclFetchCache();
  require(path.join(root, "netlify/functions/lib/carnival-discovery-source")).clearCarnivalFetchCache();
  const ctx = await loadLineContext(sb);
  const simulation = await simulateCclDiscovery({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    shipAliases: ctx.shipAliases,
    destinations: ctx.destinations,
    today
  });
  return { ...ctx, simulation, today };
}

function partitionCutoffSkips(entries, today) {
  const actionable = [];
  const skipped = [];
  for (const entry of entries || []) {
    const days = entry.departure_date ? daysUntilDeparture(entry.departure_date, today) : null;
    if (days != null && days <= 21) {
      skipped.push({
        official_sailing_id: entry.official_sailing_id,
        reason: "within_21_day_cutoff",
        days_until_departure: days
      });
    } else {
      actionable.push(entry);
    }
  }
  return { actionable, skipped };
}

function recomputeChunkManifest(chunkManifest, entries) {
  const next = { ...chunkManifest, entries, expected_record_count: entries.length };
  next.manifest_hash = computeManifestHash(next);
  return next;
}

async function buildCatchupMaster(sb, ctx, catchupId, codeSha, today) {
  const qualityGate = evaluatePreApplyQualityGate(ctx.simulation);
  if (!qualityGate.ok) {
    throw new Error(`Quality gate failed: ${qualityGate.failures.join(", ")}`);
  }

  const indexed = await indexExistingCclRecords(sb, ctx.line.id);
  const selection = selectCatchupCandidates(ctx.simulation.products, {
    excludeSailingIds: new Set([...indexed.officialBySailingId.keys()]),
    today
  });
  const batchManifest = await buildCclBatchManifest({
    products: ctx.simulation.products,
    cruiseLine: ctx.line,
    supabase: sb,
    selectedOnly: selection.selected
  });
  const entries = batchManifest.entries.filter((entry) => entry.proposed_action === "insert_active");
  const masterManifest = buildMasterManifest({
    entries,
    cruiseLine: ctx.line,
    catchupId,
    sourceSnapshotId: computeSourceSnapshotId(ctx.simulation),
    sourceFetchedAt: new Date().toISOString(),
    today,
    codeSha
  });
  const validation = validateMasterManifest(masterManifest, {
    expectedHash: masterManifest.manifest_hash,
    today
  });
  if (!validation.passed) {
    throw new Error(`Master manifest validation failed: ${validation.failures.join(", ")}`);
  }
  return { masterManifest, selection, batchManifest, qualityGate, indexed };
}

async function verifyCompletedCatchupChunk(sb, chunk, catchupId, today) {
  const checkpointPath = path.join(REPORT_DIR, `carnival-catchup-chunk-${catchupId}-${chunk.chunk_number}.json`);
  const checkpoint = fs.existsSync(checkpointPath) ? JSON.parse(fs.readFileSync(checkpointPath, "utf8")) : null;
  const { actionable } = partitionCutoffSkips(chunk.manifest.entries, today);
  const sailingIds = actionable.map((entry) => entry.official_sailing_id);
  const rows = await fetchCclRowsBySailingIds(sb, sailingIds);
  const verifyManifest = recomputeChunkManifest(chunk.manifest, actionable);
  const verification = verifyManifestRowsAgainstProduction(verifyManifest, rows, today);
  if (!verification.ok || rows.length !== actionable.length) {
    throw new Error(
      `Resume verification failed for chunk ${chunk.chunk_number}: ${verification.issues?.length || 0} issues, ${rows.length}/${actionable.length} rows`
    );
  }
  return {
    chunk_number: chunk.chunk_number,
    chunk_hash: chunk.manifest_hash,
    intended_count: chunk.record_count,
    attempted: checkpoint?.attempted ?? actionable.length,
    successful: checkpoint?.successful ?? actionable.length,
    failed: checkpoint?.failed ?? 0,
    cutoff_skipped: checkpoint?.cutoff_skipped ?? [],
    inserted_ids: checkpoint?.inserted_ids || rows.map((row) => row.id),
    chunk_post_write_verification_ok: true,
    resumed_without_reapply: true,
    completed_at: checkpoint?.completed_at || new Date().toISOString()
  };
}

async function applyCatchupChunk(sb, { chunk, masterManifest, line, catchupId, resumeFromChunk }) {
  const freshToday = perthCalendarDate();
  if (chunk.chunk_number < resumeFromChunk) {
    return verifyCompletedCatchupChunk(sb, chunk, catchupId, freshToday);
  }

  const chunkValidation = validateCatchupChunk(chunk.manifest, masterManifest, {
    expectedHash: chunk.manifest_hash,
    today: masterManifest.perth_today
  });
  if (!chunkValidation.passed) {
    throw new Error(`Chunk ${chunk.chunk_number} validation failed: ${chunkValidation.failures.join(", ")}`);
  }

  const { actionable, skipped } = partitionCutoffSkips(chunk.manifest.entries, freshToday);
  const applyChunkManifest = recomputeChunkManifest(chunk.manifest, actionable);
  if (applyChunkManifest.entries.length > MAX_CCL_CATCHUP_CHUNK) {
    throw new Error(`Chunk ${chunk.chunk_number} exceeds hard cap of ${MAX_CCL_CATCHUP_CHUNK}`);
  }

  const indexes = await indexExistingCclRecords(sb, line.id);
  let existingInChunk = 0;
  for (const entry of actionable) {
    if (indexes.officialBySailingId.get(String(entry.official_sailing_id))) existingInChunk += 1;
  }
  if (existingInChunk > 0) {
    throw new Error(`Concurrency preflight failed for chunk ${chunk.chunk_number}: ${existingInChunk} IDs exist`);
  }

  const lockKey = weeklyLockKey(CCL_LINE_SLUG);
  const ownerId = `${catchupId}-chunk-${chunk.chunk_number}`;
  const lock = await acquireMaintenanceDbLock(sb, {
    lockKey,
    ownerId,
    runId: ownerId,
    leaseSeconds: 900
  });
  if (!lock.acquired) {
    throw new Error(`Could not acquire maintenance lock for chunk ${chunk.chunk_number}: ${lock.reason}`);
  }

  try {
    const countsBefore = await countOfficialCclRows(sb);
    const runId = `${catchupId}-chunk-${chunk.chunk_number}`;
    const applyManifest = chunkManifestToApplyManifest(applyChunkManifest, runId);
    const writeResult = await applyCclBatchWrites({
      manifest: applyManifest,
      cruiseLine: line,
      maxWrites: MAX_CCL_CATCHUP_CHUNK,
      runId,
      supabase: sb,
      performWrites: true,
      expectedHash: applyManifest.manifest_hash
    });
    const countsAfter = await countOfficialCclRows(sb);
    const rows = await fetchCclRowsBySailingIds(
      sb,
      actionable.map((entry) => entry.official_sailing_id)
    );
    const verification = verifyManifestRowsAgainstProduction(applyChunkManifest, rows, freshToday);

    const chunkReport = {
      chunk_number: chunk.chunk_number,
      chunk_hash: chunk.manifest_hash,
      master_manifest_hash: masterManifest.manifest_hash,
      intended_count: chunk.record_count,
      attempted: writeResult.stats.inserted + writeResult.stats.updated + writeResult.stats.failed,
      successful: writeResult.stats.inserted + writeResult.stats.updated,
      failed: writeResult.stats.failed,
      cutoff_skipped: skipped,
      inserted_ids: writeResult.stats.write_details.map((detail) => detail.discovered_cruise_id).filter(Boolean),
      production_count_before: countsBefore.official_ccl_rows,
      production_count_after: countsAfter.official_ccl_rows,
      field_mismatch_count: verification.issues?.length || 0,
      verification_issues: verification.issues?.slice(0, 10) || [],
      chunk_post_write_verification_ok: verification.ok,
      completed_at: new Date().toISOString()
    };

    if (
      !verification.ok ||
      writeResult.stats.failed > 0 ||
      writeResult.stats.inserted !== actionable.length ||
      countsAfter.official_ccl_rows - countsBefore.official_ccl_rows !== writeResult.stats.inserted
    ) {
      throw new Error(`Chunk ${chunk.chunk_number} failed verification or insert count`);
    }

    return chunkReport;
  } finally {
    await releaseMaintenanceDbLock(sb, { lockKey, ownerId });
  }
}

async function runDeltaApply(sb, line, catchupId, codeSha) {
  const today = perthCalendarDate();
  const live = await runLiveSimulation(sb, today);
  const qualityGate = evaluatePreApplyQualityGate(live.simulation);
  if (!qualityGate.ok) {
    throw new Error(`Delta apply quality gate failed: ${qualityGate.failures.join(", ")}`);
  }

  const indexed = await indexExistingCclRecords(sb, line.id);
  const selection = selectCatchupCandidates(live.simulation.products, {
    excludeSailingIds: new Set([...indexed.officialBySailingId.keys()]),
    today
  });
  if (!selection.selected.length) {
    return { applied: 0, eligible: 0, skipped: true, quality_gate: qualityGate };
  }

  const capped = selection.selected.slice(0, MAX_CCL_CATCHUP_CHUNK);
  const batchManifest = await buildCclBatchManifest({
    products: live.simulation.products,
    cruiseLine: line,
    supabase: sb,
    selectedOnly: capped
  });
  const entries = batchManifest.entries.filter((entry) => entry.proposed_action === "insert_active");
  const { actionable, skipped } = partitionCutoffSkips(entries, today);
  if (!actionable.length) {
    return { applied: 0, eligible: selection.selected.length, cutoff_skipped: skipped, quality_gate: qualityGate };
  }

  const deltaManifest = {
    generated_at: new Date().toISOString(),
    mode: "carnival_catchup_delta",
    cruise_line_id: line.id,
    expected_record_count: actionable.length,
    code_sha: codeSha,
    entries: actionable
  };
  deltaManifest.manifest_hash = computeManifestHash(deltaManifest);

  const lockKey = weeklyLockKey(CCL_LINE_SLUG);
  const ownerId = `${catchupId}-delta`;
  const lock = await acquireMaintenanceDbLock(sb, { lockKey, ownerId, runId: ownerId, leaseSeconds: 900 });
  if (!lock.acquired) {
    throw new Error(`Could not acquire maintenance lock for delta apply: ${lock.reason}`);
  }

  try {
    const runId = `${catchupId}-delta-${Date.now()}`;
    const applyManifest = { ...deltaManifest, run_id: runId };
    const writeResult = await applyCclBatchWrites({
      manifest: applyManifest,
      cruiseLine: line,
      maxWrites: MAX_CCL_CATCHUP_CHUNK,
      runId,
      supabase: sb,
      performWrites: true,
      expectedHash: deltaManifest.manifest_hash
    });
    const rows = await fetchCclRowsBySailingIds(
      sb,
      actionable.map((entry) => entry.official_sailing_id)
    );
    const verification = verifyManifestRowsAgainstProduction(deltaManifest, rows, today);
    if (!verification.ok || writeResult.stats.failed > 0 || writeResult.stats.inserted !== actionable.length) {
      throw new Error("Delta apply failed verification");
    }
    return {
      applied: writeResult.stats.inserted,
      eligible: selection.selected.length,
      cutoff_skipped: skipped,
      quality_gate: qualityGate,
      verification
    };
  } finally {
    await releaseMaintenanceDbLock(sb, { lockKey, ownerId });
  }
}

async function main() {
  getSupabaseConfig(root);
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const codeSha = git("git rev-parse HEAD");
  let catchupId = `carnival-catchup-${startedAt.replace(/[:.]/g, "-").slice(0, 19)}`;
  const today = perthCalendarDate();
  const sb = createMaintenanceSupabase(root);
  const report = {
    phase: "carnival_prompt5_full_catchup",
    started_at: startedAt,
    catchup_id: catchupId,
    code_sha: codeSha,
    max_chunk_size: MAX_CCL_CATCHUP_CHUNK,
    confirm_token: CATCHUP_CONFIRM_TOKEN
  };

  let ok = true;
  let masterManifest = null;
  let lineContext = null;

  try {
    if (
      args.preflight ||
      args.manifest ||
      args.apply ||
      args.full ||
      args.deltaApply ||
      args.weeklyDryRun ||
      args.finalDryRun
    ) {
      assertWeeklyReconciliationDisabled();
    }
    if (args.apply || args.full || args.deltaApply) assertCatchupApplyGates(args);

    if (args.preflight || args.full) {
      let discoveryPassed = null;
      let controlledPassed = null;
      try {
        const discoveryOut = execSync("node scripts/test-carnival-discovery.mjs", { cwd: root, encoding: "utf8" });
        discoveryPassed = Number((discoveryOut.match(/tests passed:\s*(\d+)/) || [])[1]);
      } catch {
        discoveryPassed = 0;
      }
      try {
        const batchOut = execSync("node scripts/test-carnival-controlled-batch.mjs", { cwd: root, encoding: "utf8" });
        controlledPassed = Number((batchOut.match(/tests passed:\s*(\d+)/) || [])[1]);
      } catch {
        controlledPassed = 0;
      }
      report.tests_preflight = { discovery_passed: discoveryPassed, controlled_batch_passed: controlledPassed };
      if (!discoveryPassed || !controlledPassed) ok = false;
    }

    lineContext = await loadLineContext(sb);
    const live = await runLiveSimulation(sb, today);
    const qualityGate = evaluatePreApplyQualityGate(live.simulation);
    report.quality_gate = qualityGate;
    if (!qualityGate.ok) ok = false;

    const sourceSailingIds = new Set(
      (live.simulation.products || []).map((row) => officialSailingId(row.raw)).filter(Boolean)
    );
    const inventory = await auditCclProductionInventory(sb, { sourceSailingIds });
    const indexed = inventory.indexed || (await indexExistingCclRecords(sb, lineContext.line.id));
    const catchupPlan = buildCatchupPlan(live.simulation.products, indexed, today);
    report.inventory_audit = {
      official_count: inventory.official_count,
      legacy_count: inventory.legacy_count,
      unexpected_count: inventory.unexpected_count,
      stop_required: inventory.stop_required,
      duplicate_official_sailing_ids: inventory.duplicate_official_sailing_ids
    };
    report.catchup_plan = catchupPlan;
    report.production_counts_before = await countOfficialCclRows(sb);
    if (inventory.stop_required) ok = false;

    if (args.manifest || args.apply || args.full) {
      if (args.masterPath) {
        masterManifest = JSON.parse(fs.readFileSync(args.masterPath, "utf8"));
        report.master_manifest_path = args.masterPath;
        if (masterManifest.catchup_id) catchupId = masterManifest.catchup_id;
        report.catchup_id = catchupId;
        const validation = validateMasterManifest(masterManifest, {
          expectedHash: masterManifest.manifest_hash,
          today: masterManifest.perth_today || today
        });
        report.master_manifest_validation = validation;
        if (!validation.passed) ok = false;
      } else {
        const built = await buildCatchupMaster(sb, live, catchupId, codeSha, today);
        masterManifest = built.masterManifest;
        report.catchup_eligibility = {
          eligible_total: built.selection.eligible_count,
          excluded_existing: built.selection.excluded_existing_count,
          insert_entries: masterManifest.entries.length
        };
        report.master_manifest_path = writeReport(`carnival-catchup-master-manifest-${catchupId}.json`, masterManifest);
      }
    }

    const { chunks } = masterManifest ? splitMasterIntoChunks(masterManifest) : { chunks: [] };
    report.chunk_plan = (masterManifest?.chunks || chunks.map((chunk) => ({
      chunk_number: chunk.chunk_number,
      record_count: chunk.record_count,
      manifest_hash: chunk.manifest_hash
    })));

    report.chunk_executions = [];
    if ((args.apply || args.full) && masterManifest) {
      for (const chunk of chunks) {
        const chunkReport = await applyCatchupChunk(sb, {
          chunk,
          masterManifest,
          line: lineContext.line,
          catchupId,
          resumeFromChunk: args.resumeFromChunk
        });
        report.chunk_executions.push(chunkReport);
        writeReport(`carnival-catchup-chunk-${catchupId}-${chunk.chunk_number}.json`, chunkReport);
      }

      const cutoffSkippedIds = new Set(
        report.chunk_executions.flatMap((chunk) =>
          (chunk.cutoff_skipped || []).map((skip) => skip.official_sailing_id)
        )
      );
      const verifyEntries = masterManifest.entries.filter(
        (entry) => !cutoffSkippedIds.has(entry.official_sailing_id)
      );
      const verifyManifest = { ...masterManifest, entries: verifyEntries };
      const masterRows = await fetchCclRowsBySailingIds(
        sb,
        verifyEntries.map((entry) => entry.official_sailing_id)
      );
      const masterVerification = verifyManifestRowsAgainstProduction(verifyManifest, masterRows, perthCalendarDate());
      report.master_post_write_verification = {
        ...masterVerification,
        cutoff_skipped_count: cutoffSkippedIds.size
      };
      if (!masterVerification.ok) ok = false;
    }

    if ((args.deltaApply || args.full) && ok) {
      report.delta_apply = await runDeltaApply(sb, lineContext.line, catchupId, codeSha);
    }

    if (args.weeklyDryRun || args.full) {
      report.weekly_dry_run = await runCclWeeklyMaintenance({
        supabase: sb,
        dryRun: true,
        performWrites: false,
        runId: `${catchupId}-weekly-dry-run`
      });
      if (report.weekly_dry_run?.success === false && report.weekly_dry_run?.blocked) ok = false;
    }

    if (args.weeklyApply) {
      assertWritesEnabled();
      assertCarnivalWritesAllowed(resolveCarnivalDiscoveryMode("weekly_maintenance"));
      report.weekly_apply = await runCclWeeklyMaintenance({
        supabase: sb,
        dryRun: false,
        performWrites: true,
        runId: `${catchupId}-weekly-apply`
      });
      if (!report.weekly_apply?.success) ok = false;
    }

    if (args.finalDryRun || args.full) {
      const postLive = await runLiveSimulation(sb, perthCalendarDate());
      const postGate = evaluatePreApplyQualityGate(postLive.simulation);
      const postIndexed = await indexExistingCclRecords(sb, lineContext.line.id);
      const postPlan = buildCatchupPlan(postLive.simulation.products, postIndexed, perthCalendarDate());
      report.final_dry_run = {
        quality_gate: postGate,
        catchup_plan: postPlan,
        source_snapshot_id: computeSourceSnapshotId(postLive.simulation),
        official_rows: (await countOfficialCclRows(sb)).official_ccl_rows
      };
      if (!postGate.ok) ok = false;
    }

    report.production_counts_after = await countOfficialCclRows(sb);
    report.recommendation = ok ? "READY FOR WEEKLY AUTOMATION VALIDATION" : "STOP — CARNIVAL CATCH-UP ISSUE";
  } catch (error) {
    ok = false;
    report.error = error.message || String(error);
    report.recommendation = "STOP — CARNIVAL CATCH-UP ISSUE";
  }

  report.completed_at = new Date().toISOString();
  const reportPath = writeReport(`carnival-catchup-${catchupId}.json`, report);
  console.log(JSON.stringify({ ok, report: reportPath, recommendation: report.recommendation }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
