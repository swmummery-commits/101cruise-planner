#!/usr/bin/env node
/**
 * Disney Cruise Line — Phase 4B cumulative catch-up (batch N >= 2, max 100 INSERTs).
 *
 *   node scripts/run-disney-phase4b-catchup.mjs --master-plan
 *   node scripts/run-disney-phase4b-catchup.mjs --generate-freezes
 *   DISNEY_DISCOVERY_WRITE_ENABLED=true node scripts/run-disney-phase4b-catchup.mjs \
 *     --apply --batch-number=2 --confirm=DISNEY-CONTROLLED-CATCHUP \
 *     --frozen-report=reports/disney-phase4b-catchup-batch-2-freeze.json
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

const REPORT_DIR = path.join(root, "reports");
const MASTER_PLAN_PATH = path.join(REPORT_DIR, "disney-phase4b-catchup-master-plan.json");

const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/disney-discovery-adapter"));
const controlled = require(path.join(root, "netlify/functions/lib/disney-controlled-batch"));
const writes = require(path.join(root, "netlify/functions/lib/disney-discovery-writes"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const {
  executeControlledProductionApply,
  runGlobalLockSmokeTest,
  loadGlobalCruiseWriteLockStatus
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-global-write-lock"));
const {
  buildRollbackManifestFromWriteResult,
  persistMaintenanceRollbackManifest
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-manifests"));

export function parsePhase4bArgs(argv = process.argv) {
  const args = {
    masterPlan: false,
    generateFreezes: false,
    apply: false,
    batchNumber: null,
    confirm: null,
    frozenReport: null,
    lockSmoke: false,
    preflight: false
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--master-plan") args.masterPlan = true;
    if (arg === "--generate-freezes") args.generateFreezes = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--lock-smoke") args.lockSmoke = true;
    if (arg === "--preflight") args.preflight = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--frozen-report=")) args.frozenReport = path.resolve(String(arg.split("=")[1]).trim());
    if (arg.startsWith("--batch-number=")) args.batchNumber = Number(String(arg.split("=")[1]).trim());
    if (arg.startsWith("--limit=") || arg.startsWith("--batch-size=")) {
      throw new Error(`Disney catch-up rejects custom limits. Hard maximum is ${controlled.MAX_CATCHUP_DISNEY_BATCH}.`);
    }
  }
  if (args.apply) {
    args.preflight = true;
    args.lockSmoke = true;
    if (args.batchNumber == null || Number.isNaN(args.batchNumber)) {
      throw new Error("Phase 4B apply requires --batch-number=N where N >= 2");
    }
    if (args.batchNumber < controlled.MIN_PHASE4B_CATCHUP_BATCH) {
      throw new Error(`Phase 4B batch number must be >= ${controlled.MIN_PHASE4B_CATCHUP_BATCH}`);
    }
  }
  return args;
}

export function assertCatchupApplyAllowed(args) {
  if (!args.apply) return;
  if (args.confirm !== controlled.CATCHUP_CONFIRMATION_TOKEN) {
    const err = new Error("disney_catchup_confirmation_required");
    err.code = "disney_catchup_confirmation_required";
    throw err;
  }
  if (String(process.env.DISNEY_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    const err = new Error("DISNEY_DISCOVERY_WRITE_ENABLED must be true for apply");
    err.code = "disney_discovery_write_disabled";
    throw err;
  }
}

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

async function headLineCount(lineId, status = null) {
  const q = status ? `&status=eq.${encodeURIComponent(status)}` : "";
  return (await exactCountSupabase(root, "discovered_cruises", `cruise_line_id=eq.${encodeURIComponent(lineId)}${q}`))
    .count;
}

async function headSentinelCounts(sb) {
  const out = [];
  for (const slug of controlled.SENTINEL_LINE_SLUGS) {
    const line = (await sb(`ci_cruise_lines?slug=eq.${encodeURIComponent(slug)}&select=id,slug&limit=1`))?.[0];
    if (!line) {
      out.push({ slug, active: null, missing: true });
      continue;
    }
    out.push({ slug, active: await headLineCount(line.id, "active") });
  }
  return out;
}

async function loadContext(sb) {
  const line = (
    await sb(`ci_cruise_lines?slug=eq.${controlled.DISNEY_LINE_SLUG}&select=id,name,slug&limit=1`)
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${controlled.DISNEY_LINE_SLUG}`);

  const [ships, destinations, existingRows] = await Promise.all([
    sb(
      `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,official_line_ship_id,active&order=name.asc`
    ),
    sb("destinations?select=id,name,slug,status"),
    sb(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
        line.id
      )}&select=id,cruise_line_id,status,ship_id,destination_id,departure_date,return_date,nights,departure_port,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract,created_at,updated_at&order=created_at.asc`
    )
  ]);

  return {
    line,
    ships: ships || [],
    destinations: (destinations || []).filter((d) => d.status !== "archived"),
    existingRows: existingRows || []
  };
}

async function countCollisions(sb, lineId, entries) {
  let externalKeyCollisions = 0;
  let identityKeyCollisions = 0;
  const officialIds = entries.map((e) => e.official_sailing_id);
  const quoted = officialIds.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",");
  const existingOfficial = quoted.length
    ? await sb(
        `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
          lineId
        )}&official_sailing_id=in.(${quoted})&select=id,official_sailing_id`
      )
    : [];

  for (const entry of entries || []) {
    const ext =
      (
        await sb(
          `discovered_cruises?external_key=eq.${encodeURIComponent(entry.external_key)}&select=id&limit=1`
        )
      )?.[0] || null;
    if (ext?.id) externalKeyCollisions += 1;
    const ident =
      (
        await sb(
          `discovered_cruises?identity_key=eq.${encodeURIComponent(entry.identity_key)}&select=id&limit=1`
        )
      )?.[0] || null;
    if (ident?.id) identityKeyCollisions += 1;
  }

  return {
    selected_existing_matches: existingOfficial?.length || 0,
    external_key_collisions: externalKeyCollisions,
    identity_key_collisions: identityKeyCollisions
  };
}

async function runLiveSimulation(ctx, sb, today) {
  console.error("Running Disney Phase 4B live source simulation…");
  return adapter.simulateDisneyDiscovery({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today,
    existingRows: ctx.existingRows,
    supabaseQuery: sb
  });
}

export async function runDisneyPhase4bCatchup(options = {}) {
  const args = options.args || parsePhase4bArgs();
  const startedAt = new Date().toISOString();
  const startingSha = git("git rev-parse HEAD");
  const today = options.today || perthCalendarDate();
  const sb = options.supabase || createMaintenanceSupabase(root);

  assertCatchupApplyAllowed(args);
  const ctx = await loadContext(sb);
  const baseline = controlled.verifyCumulativeProductionBaseline(ctx.existingRows);
  if (!baseline.ok && !args.masterPlan && !args.generateFreezes) {
    throw new Error(`Cumulative production baseline failed: ${JSON.stringify(baseline)}`);
  }

  const simulation = await runLiveSimulation(ctx, sb, today);

  if (args.masterPlan) {
    const masterPlan = controlled.buildCatchupMasterPlan({
      simulation,
      cruiseLine: ctx.line,
      today,
      existingRows: ctx.existingRows
    });
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(MASTER_PLAN_PATH, JSON.stringify(masterPlan, null, 2));
    return { phase: "4B", action: "master_plan", master_plan: masterPlan, master_plan_path: MASTER_PLAN_PATH, baseline };
  }

  if (!fs.existsSync(MASTER_PLAN_PATH)) {
    throw new Error("master_plan_missing: run --master-plan first");
  }
  const masterPlan = controlled.loadCatchupMasterPlan(JSON.parse(fs.readFileSync(MASTER_PLAN_PATH, "utf8")));

  if (args.generateFreezes) {
    const written = [];
    for (const batch of masterPlan.batch_plan) {
      const freeze = controlled.buildCatchupFreezeFromMasterPlan({
        masterPlan,
        batchNumber: batch.batch_number,
        simulation,
        cruiseLine: ctx.line,
        today
      });
      const freezePath = path.join(root, controlled.catchupBatchFreezePath(batch.batch_number));
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      fs.writeFileSync(freezePath, JSON.stringify(freeze, null, 2));
      written.push({ batch_number: batch.batch_number, batch_size: batch.batch_size, path: freezePath });
    }
    return { phase: "4B", action: "generate_freezes", written, master_plan_hash: masterPlan.overall_planned_identity_hash };
  }

  const batchNumber = args.batchNumber;
  const expectedCount =
    masterPlan.batch_plan.find((b) => b.batch_number === batchNumber)?.batch_size ??
    (() => {
      throw new Error(`batch_not_in_master_plan:${batchNumber}`);
    })();

  const freezePath =
    args.frozenReport || path.join(root, controlled.catchupBatchFreezePath(batchNumber));
  if (!fs.existsSync(freezePath)) throw new Error(`missing_frozen_report:${freezePath}`);

  const frozenReport = controlled.loadCatchupFrozenReport(JSON.parse(fs.readFileSync(freezePath, "utf8")));
  const validation = controlled.validateCatchupFrozenManifest(frozenReport, { expectedCount });
  if (!validation.ok) throw new Error(`frozen_manifest_invalid:${validation.failures.join(",")}`);

  const masterMembership = controlled.verifyMasterPlanIdentityMembership(masterPlan, frozenReport);
  if (!masterMembership.ok) throw new Error(`master_plan_membership:${masterMembership.failures.join(",")}`);

  const cumulativeBaseline = controlled.verifyCumulativeProductionBaseline(ctx.existingRows, simulation);
  const indexes = await writes.indexExistingDisneyRecords(sb, ctx.line.id);
  const existingBeforeIds = new Set(ctx.existingRows.map((r) => r.id));
  const legacySnapshotBefore = controlled.snapshotLegacyRows(ctx.existingRows);
  const officialSnapshotBefore = controlled.snapshotExistingOfficialRows(ctx.existingRows);

  const startingOfficialCount = masterPlan.existing_official_count;
  const prior4bInserts = masterPlan.batch_plan
    .filter((b) => b.batch_number < batchNumber)
    .reduce((sum, b) => sum + b.batch_size, 0);
  const expectedOfficialNow = startingOfficialCount + prior4bInserts;
  if (baseline.official_count !== expectedOfficialNow) {
    throw new Error(
      `official_count_mismatch: expected ${expectedOfficialNow} before batch ${batchNumber}, got ${baseline.official_count}`
    );
  }

  const lockBefore = await loadGlobalCruiseWriteLockStatus(sb);
  let lockSmoke = null;
  if (args.lockSmoke || args.apply) {
    const smokeRunId = controlled.catchupBatchRunId(batchNumber, startedAt).replace(/catchup-\d+-/, "lock-smoke-");
    lockSmoke = await runGlobalLockSmokeTest(sb, {
      ownerId: smokeRunId,
      runId: smokeRunId,
      operation: `disney_phase4b_lock_smoke_batch_${batchNumber}`
    });
    if (!lockSmoke.passed && args.apply) throw new Error(`Global lock smoke failed: ${lockSmoke.reason}`);
  }

  const productsByKey = new Map(simulation.products.map((r) => [r.official_sailing_id, r]));
  const sourceRefresh = controlled.validateSelectedAgainstFreshSource(
    frozenReport.frozen_identities,
    productsByKey,
    frozenReport.entries,
    adapter.ADAPTER_VERSION,
    ctx.line
  );
  const collisionCheck = await countCollisions(sb, ctx.line.id, frozenReport.entries);

  const preWriteGate = controlled.evaluateCatchupPreWriteGate({
    sourceComplete: simulation.quality_gate?.source_complete === true,
    identityCollisions: simulation.snapshot?.expansion?.identity_collisions || 0,
    endpointUnresolvedConflicts: simulation.endpoint_audit?.unresolved_conflicts || 0,
    eligibilityArithmeticPass: simulation.eligibility?.arithmetic?.reconciles === true,
    oneWayNativeParsePass: simulation.one_way_audit?.explicit_two_endpoint_native_parse !== false,
    legacyBaselineOk: baseline.legacy_ok,
    cumulativeBaselineOk: cumulativeBaseline.ok,
    expectedCount,
    selectedCount: frozenReport.entries.length,
    existingSelectedOfficialIds: collisionCheck.selected_existing_matches,
    externalKeyCollisions: collisionCheck.external_key_collisions,
    identityKeyCollisions: collisionCheck.identity_key_collisions,
    hashMismatch: !sourceRefresh.ok,
    lockSmokePassed: !args.apply || lockSmoke?.passed === true
  });

  const countsBefore = {
    disney_total: await headLineCount(ctx.line.id),
    disney_active: await headLineCount(ctx.line.id, "active"),
    disney_official: (
      await exactCountSupabase(
        root,
        "discovered_cruises",
        `cruise_line_id=eq.${encodeURIComponent(ctx.line.id)}&official_sailing_id=not.is.null`
      )
    ).count,
    global_total: (await exactCountSupabase(root, "discovered_cruises")).count,
    global_active: (await exactCountSupabase(root, "discovered_cruises", "status=eq.active")).count,
    sentinel_active: await headSentinelCounts(sb)
  };

  const frozenEntriesById = new Map((frozenReport.entries || []).map((e) => [e.official_sailing_id, e]));
  const selectedProducts = frozenReport.frozen_identities.map((id) => productsByKey.get(id)).filter(Boolean);
  const runId = options.runId || controlled.catchupBatchRunId(batchNumber, startedAt);
  const writeContext = { mode: "catchup", batchNumber };

  let writeResult = null;
  let globalLockReport = null;
  let rollbackPersist = null;
  let partialRecovery = null;

  if (args.apply) {
    if (!preWriteGate.passed) throw new Error(`Pre-write gate failed: ${preWriteGate.failures.join(", ")}`);

    try {
      const protectedApply = await executeControlledProductionApply(
        sb,
        {
          runId,
          lineSlug: controlled.DISNEY_LINE_SLUG,
          operation: controlled.catchupBatchOperation(batchNumber),
          performWrites: true,
          underLockRecheck: async () => {
            const underLockCollisions = await countCollisions(sb, ctx.line.id, frozenReport.entries);
            const refresh = controlled.validateSelectedAgainstFreshSource(
              frozenReport.frozen_identities,
              productsByKey,
              frozenReport.entries,
              adapter.ADAPTER_VERSION,
              ctx.line
            );
            if (underLockCollisions.selected_existing_matches > 0) {
              return { ok: false, reason: "under_lock_selected_official_ids_already_present" };
            }
            if (!refresh.ok) return { ok: false, reason: "under_lock_hash_mismatch" };
            return { ok: true };
          }
        },
        async () =>
          writes.applyDisneyBatchWritesBody({
            selectedProducts,
            frozenEntriesById,
            cruiseLine: ctx.line,
            runId,
            supabase: sb,
            performWrites: true,
            maxWrites: expectedCount,
            writeContext
          })
      );

      globalLockReport = protectedApply.global_lock;
      if (protectedApply.blocked) throw new Error(`Apply blocked: ${protectedApply.reason}`);
      writeResult = protectedApply.writeResult;
      if (writeResult.stats.inserted !== expectedCount) {
        throw new Error(`Unexpected insert count ${writeResult.stats.inserted}; expected ${expectedCount}`);
      }
      if (writeResult.stats.updated > 0) throw new Error(`Unexpected updates: ${writeResult.stats.updated}`);
    } catch (error) {
      partialRecovery = await controlled.buildPartialWriteRecoveryReport({
        supabase: sb,
        cruiseLineId: ctx.line.id,
        frozenOfficialIds: frozenReport.frozen_identities,
        existingBeforeIds,
        writeStats: writeResult?.stats || {},
        error
      });
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(REPORT_DIR, `disney-phase4b-partial-recovery-batch-${batchNumber}-${runId}.json`),
        JSON.stringify({ partialRecovery, batchNumber, runId }, null, 2)
      );
      throw error;
    }

    rollbackPersist = await persistMaintenanceRollbackManifest(sb, {
      runId,
      cruiseLineId: ctx.line.id,
      lineSlug: controlled.DISNEY_LINE_SLUG,
      triggerType: controlled.catchupBatchOperation(batchNumber),
      writeResult
    });
    if (rollbackPersist?.skipped) throw new Error("rollback_manifest_persistence_failed");
  }

  const countsAfter = args.apply
    ? {
        disney_total: await headLineCount(ctx.line.id),
        disney_active: await headLineCount(ctx.line.id, "active"),
        disney_official: (
          await exactCountSupabase(
            root,
            "discovered_cruises",
            `cruise_line_id=eq.${encodeURIComponent(ctx.line.id)}&official_sailing_id=not.is.null`
          )
        ).count,
        global_total: (await exactCountSupabase(root, "discovered_cruises")).count,
        global_active: (await exactCountSupabase(root, "discovered_cruises", "status=eq.active")).count,
        sentinel_active: await headSentinelCounts(sb)
      }
    : countsBefore;

  const insertedIds = (writeResult?.stats?.write_details || [])
    .filter((d) => d.created)
    .map((d) => d.discovered_cruise_id)
    .filter(Boolean);

  const insertedRows = insertedIds.length
    ? await sb(
        `discovered_cruises?id=in.(${insertedIds.map((id) => `"${id}"`).join(",")})&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,status,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract`
      )
    : [];

  const postVerify = args.apply
    ? writes.verifyInsertedRecords(insertedRows, frozenEntriesById, ctx.line.id, {
        expectCatchupMetadata: true,
        batchNumber
      })
    : null;

  const allRowsAfter = args.apply
    ? await sb(
        `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
          ctx.line.id
        )}&select=id,cruise_line_id,status,ship_id,destination_id,departure_date,return_date,nights,departure_port,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract`
      )
    : ctx.existingRows;

  const legacyImmut = args.apply ? controlled.verifyLegacyImmutability(legacySnapshotBefore, allRowsAfter) : null;
  const officialImmut = args.apply
    ? controlled.verifyExistingOfficialImmutability(officialSnapshotBefore, allRowsAfter)
    : null;
  const countReconciliation = args.apply
    ? controlled.verifyCatchupCountReconciliation(countsBefore, countsAfter, writeResult?.stats || {})
    : null;

  const postSim = args.apply ? await runLiveSimulation({ ...ctx, existingRows: allRowsAfter }, sb, today) : null;
  const cumulativeRecon = postSim
    ? controlled.verifyCumulativeDuplicateSkipReconciliation(postSim, allRowsAfter)
    : null;

  const existingOfficialSet = new Set(controlled.collectExistingOfficialIds(allRowsAfter));
  const remainingMasterPlan = controlled.remainingMasterPlanIdentities(masterPlan, existingOfficialSet);

  const dataPassed =
    cumulativeBaseline.ok &&
    preWriteGate.passed &&
    (!args.apply ||
      (writeResult?.stats?.inserted === expectedCount &&
        postVerify?.passed &&
        countReconciliation?.passed &&
        legacyImmut?.passed &&
        officialImmut?.passed &&
        cumulativeRecon?.passed &&
        rollbackPersist?.skipped === false));

  const lockLifecyclePassed =
    lockSmoke?.passed === true &&
    (!args.apply || (globalLockReport?.global_lock_acquired === true && globalLockReport?.global_lock_released === true));

  const report = {
    phase: "4B",
    batch_number: batchNumber,
    repository: { starting_sha: startingSha, tooling_sha: startingSha, apply_sha: args.apply ? git("git rev-parse HEAD") : null },
    production_baseline: cumulativeBaseline,
    master_plan_hash: masterPlan.overall_planned_identity_hash,
    frozen_catchup: {
      batch_number: batchNumber,
      size: expectedCount,
      identities: frozenReport.frozen_identities,
      candidate_hash: frozenReport.frozen_candidate_hash
    },
    prewrite_collisions: collisionCheck,
    pre_write_gate: preWriteGate,
    global_lock: globalLockReport,
    lock_before: lockBefore,
    lock_smoke: lockSmoke,
    under_lock_recheck: args.apply ? { performed: true, passed: true } : null,
    write_result: writeResult
      ? {
          attempted: writeResult.stats.attempted,
          inserted: writeResult.stats.inserted,
          updated: writeResult.stats.updated,
          failed: writeResult.stats.failed,
          partial_write: false,
          inserted_record_ids: insertedIds
        }
      : null,
    partial_recovery: partialRecovery,
    rollback_manifest: {
      persisted: rollbackPersist?.skipped === false,
      manifest_record_id: rollbackPersist?.manifest_record_id || null,
      inserted_count: insertedIds.length
    },
    verification: postVerify,
    count_reconciliation: countReconciliation,
    legacy_immutability: legacyImmut,
    existing_official_immutability: officialImmut,
    cumulative_reconciliation: cumulativeRecon,
    counts_before: countsBefore,
    counts_after: countsAfter,
    official_count_after: countsAfter.disney_official,
    remaining_master_plan_inserts: remainingMasterPlan.length,
    quality_gate: {
      data_passed: dataPassed,
      lock_lifecycle_passed: lockLifecyclePassed,
      rollback_audit_passed: rollbackPersist?.skipped === false,
      overall_passed: dataPassed && lockLifecyclePassed,
      ready_for_next_batch: dataPassed && lockLifecyclePassed && remainingMasterPlan.length > 0
    },
    run_id: runId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    writes: args.apply === true
  };

  const reportPath = path.join(root, controlled.catchupBatchReportPath(batchNumber));
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  report.report_path = reportPath;
  return report;
}

async function main() {
  try {
    const report = await runDisneyPhase4bCatchup();
    console.log(JSON.stringify(report, null, 2));
    if (report.writes && !report.quality_gate?.overall_passed) process.exit(1);
  } catch (err) {
    console.error(JSON.stringify({ status: "failed", error: err.message, code: err.code || null }, null, 2));
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
