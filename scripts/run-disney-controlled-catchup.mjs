#!/usr/bin/env node
/**
 * Disney Cruise Line — Phase 4A controlled catch-up (max 100 INSERTs per invocation).
 *
 *   node scripts/run-disney-controlled-catchup.mjs --preflight --lock-smoke
 *   node scripts/run-disney-controlled-catchup.mjs --manifest
 *   DISNEY_DISCOVERY_WRITE_ENABLED=true node scripts/run-disney-controlled-catchup.mjs \
 *     --apply --confirm=DISNEY-CONTROLLED-CATCHUP \
 *     --frozen-report=reports/disney-phase4a-catchup-batch-1-freeze.json
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
const PHASE3_FREEZE_PATH = path.join(REPORT_DIR, "disney-phase3-first-controlled-freeze.json");
const DEFAULT_CATCHUP_FREEZE = path.join(REPORT_DIR, "disney-phase4a-catchup-batch-1-freeze.json");
const PHASE4A_REPORT = path.join(REPORT_DIR, "disney-phase4a-first-catchup-batch.json");

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

export function parseCatchupArgs(argv = process.argv) {
  const args = {
    preflight: false,
    lockSmoke: false,
    manifest: false,
    apply: false,
    verifyApplied: false,
    confirm: null,
    frozenReport: null
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--lock-smoke") args.lockSmoke = true;
    if (arg === "--manifest") args.manifest = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--verify-applied") args.verifyApplied = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--frozen-report=")) args.frozenReport = path.resolve(String(arg.split("=")[1]).trim());
    if (arg.startsWith("--limit=") || arg.startsWith("--batch-size=")) {
      throw new Error(`Disney catch-up rejects custom limits. Hard maximum is ${controlled.MAX_CATCHUP_DISNEY_BATCH}.`);
    }
  }
  if (args.apply) {
    args.preflight = true;
    args.lockSmoke = true;
    args.manifest = true;
  } else if (!Object.values(args).some((v) => v === true) && !args.confirm && !args.verifyApplied) {
    args.preflight = true;
    args.lockSmoke = true;
  }
  if (args.verifyApplied) {
    args.preflight = false;
    args.lockSmoke = false;
    args.manifest = false;
    args.apply = false;
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
      )}&select=id,status,ship_id,destination_id,departure_date,return_date,nights,departure_port,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract,created_at,updated_at&order=created_at.asc`
    )
  ]);

  return {
    line,
    ships: ships || [],
    destinations: (destinations || []).filter((d) => d.status !== "archived"),
    existingRows: existingRows || []
  };
}

function loadPhase3Identities() {
  if (!fs.existsSync(PHASE3_FREEZE_PATH)) return [];
  const freeze = JSON.parse(fs.readFileSync(PHASE3_FREEZE_PATH, "utf8"));
  return freeze.frozen_identities || [];
}

function verifyProductionBaseline(existingRows, phase3Ids, options = {}) {
  const legacy = existingRows.filter((r) => controlled.DISNEY_LEGACY_ROW_IDS.includes(r.id));
  const official = existingRows.filter((r) => r.official_sailing_id);
  const phase3Present = phase3Ids.every((id) => official.some((r) => r.official_sailing_id === id));
  const phase3Active = phase3Ids.every((id) => official.some((r) => r.official_sailing_id === id && r.status === "active"));
  const expectedTotal = options.expectedTotal ?? 26;
  const expectedOfficial = options.expectedOfficial ?? 20;
  return {
    ok:
      existingRows.length === expectedTotal &&
      official.length === expectedOfficial &&
      legacy.length === 6 &&
      phase3Present &&
      phase3Active,
    disney_total: existingRows.length,
    disney_active: existingRows.filter((r) => r.status === "active").length,
    official_count: official.length,
    legacy_count: legacy.length,
    phase3_present: phase3Present,
    phase3_active: phase3Active
  };
}

async function verifyAppliedCatchupReport({ sb, startingSha, today, phase3Ids, ctx }) {
  if (!fs.existsSync(PHASE4A_REPORT)) {
    throw new Error("verify_applied_missing_report");
  }
  const prior = JSON.parse(fs.readFileSync(PHASE4A_REPORT, "utf8"));
  if (!prior.writes || !prior.write_result?.inserted_record_ids?.length) {
    throw new Error("verify_applied_no_prior_writes");
  }

  const frozenPath = prior.freeze_path || DEFAULT_CATCHUP_FREEZE;
  const frozenReport = controlled.loadCatchupFrozenReport(JSON.parse(fs.readFileSync(frozenPath, "utf8")));
  const legacySnapshotBefore = controlled.snapshotLegacyRows(
    ctx.existingRows.filter((r) => controlled.DISNEY_LEGACY_ROW_IDS.includes(r.id))
  );
  const phase3SnapshotBefore = controlled.snapshotPhase3Rows(
    ctx.existingRows.filter((r) => r.official_sailing_id),
    phase3Ids
  );

  const allRowsAfter = await sb(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
      ctx.line.id
    )}&select=id,cruise_line_id,status,ship_id,destination_id,departure_date,return_date,nights,departure_port,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract`
  );

  const postSim = await adapter.simulateDisneyDiscovery({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today,
    existingRows: allRowsAfter,
    supabaseQuery: sb
  });
  const postManifest = adapter.buildProposedWriteManifest(postSim.products, allRowsAfter, ctx.line, postSim.legacy_audit);
  const allOfficialIds = [...phase3Ids, ...(frozenReport.frozen_identities || [])];
  const postReclass = allOfficialIds.map((id) => ({
    official_sailing_id: id,
    action: postManifest.manifest.find((m) => m.official_product_key === id)?.action
  }));

  const legacyImmut = controlled.verifyLegacyImmutability(legacySnapshotBefore, allRowsAfter);
  const phase3Immut = controlled.verifyPhase3TwentyImmutability(phase3SnapshotBefore, allRowsAfter);
  const postWriteReconciliationPassed =
    postReclass.filter((r) => r.action === "duplicate_skip").length === allOfficialIds.length &&
    postReclass.filter((r) => r.action === "update_exact_existing").length === 0;

  const dataPassed =
    prior.write_result?.inserted === controlled.MAX_CATCHUP_DISNEY_BATCH &&
    prior.verification?.failed_count === 0 &&
    prior.count_reconciliation?.passed === true &&
    legacyImmut.passed &&
    phase3Immut.passed &&
    postWriteReconciliationPassed;

  const lockLifecyclePassed = prior.lock_smoke?.passed === true && prior.global_lock?.global_lock_released === true;

  const report = {
    ...prior,
    repository: {
      ...prior.repository,
      final_report_sha: startingSha
    },
    phase3_validation: {
      disney_total: allRowsAfter.length,
      disney_active: allRowsAfter.filter((r) => r.status === "active").length,
      phase3_twenty_verified: phase3Ids.every((id) =>
        allRowsAfter.some((r) => r.official_sailing_id === id && r.status === "active")
      ),
      legacy_six_verified: legacyImmut.passed
    },
    legacy_immutability: legacyImmut,
    phase3_twenty_immutability: phase3Immut,
    post_write_reconciliation: {
      remaining_proposed_inserts: postSim.write_manifest?.summary?.insert_active,
      official_duplicate_skip: postReclass.filter((r) => r.action === "duplicate_skip").length,
      update_proposals: postReclass.filter((r) => r.action === "update_exact_existing").length,
      details: postReclass
    },
    quality_gate: {
      data_passed: dataPassed,
      lock_lifecycle_passed: lockLifecyclePassed,
      rollback_audit_passed: prior.phase3_rollback_manifest?.existed === true,
      overall_passed: dataPassed && lockLifecyclePassed,
      ready_for_additional_catchup: dataPassed && lockLifecyclePassed
    },
    verify_applied_at: new Date().toISOString()
  };

  fs.writeFileSync(PHASE4A_REPORT, JSON.stringify(report, null, 2));
  report.report_path = PHASE4A_REPORT;
  return report;
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

export async function runDisneyControlledCatchup(options = {}) {
  const args = options.args || parseCatchupArgs();
  const startedAt = new Date().toISOString();
  const startingSha = git("git rev-parse HEAD");
  const today = options.today || perthCalendarDate();
  const sb = options.supabase || createMaintenanceSupabase(root);

  assertCatchupApplyAllowed(args);

  const phase3Ids = loadPhase3Identities();
  const ctx = await loadContext(sb);

  if (args.verifyApplied) {
    return verifyAppliedCatchupReport({ sb, startingSha, today, phase3Ids, ctx });
  }

  const baseline = verifyProductionBaseline(ctx.existingRows, phase3Ids);
  const indexes = await writes.indexExistingDisneyRecords(sb, ctx.line.id);
  const existingBeforeIds = new Set(ctx.existingRows.map((r) => r.id));
  const legacySnapshotBefore = controlled.snapshotLegacyRows(ctx.existingRows);
  const phase3SnapshotBefore = controlled.snapshotPhase3Rows(
    ctx.existingRows.filter((r) => r.official_sailing_id),
    phase3Ids
  );

  const lockAnomaly = controlled.analysePhase3LockAnomaly();
  const lockBefore = await loadGlobalCruiseWriteLockStatus(sb);

  let lockSmoke = null;
  if (args.lockSmoke || args.apply) {
    const smokeRunId = `disney-phase4a-lock-smoke-${startedAt.replace(/[:.]/g, "-")}`;
    lockSmoke = await runGlobalLockSmokeTest(sb, {
      ownerId: smokeRunId,
      runId: smokeRunId,
      operation: "disney_phase4a_lock_smoke"
    });
    if (!lockSmoke.passed && args.apply) {
      throw new Error(`Global lock smoke failed: ${lockSmoke.reason}`);
    }
  }

  const phase3Rows = ctx.existingRows.filter((r) => phase3Ids.includes(r.official_sailing_id));
  let phase3Rollback = await controlled.findPhase3RollbackManifest(
    sb,
    phase3Rows.map((r) => r.id)
  );
  if (!phase3Rollback.existed) {
    phase3Rollback = await controlled.recoverPhase3RollbackManifestIfMissing(sb, {
      cruiseLineId: ctx.line.id,
      phase3InsertedRows: phase3Rows
    });
  }

  console.error("Running Disney Phase 4A live source simulation…");
  const simulation = await adapter.simulateDisneyDiscovery({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today,
    existingRows: ctx.existingRows,
    supabaseQuery: sb
  });

  const excludeOfficialIds = new Set(phase3Ids);
  let frozenReport = null;
  if (args.manifest && !args.frozenReport) {
    frozenReport = controlled.buildCatchupFreezeReport({
      simulation,
      cruiseLine: ctx.line,
      today,
      batchNumber: 1,
      excludeOfficialIds,
      maxSize: controlled.MAX_CATCHUP_DISNEY_BATCH,
      existingByOfficialId: indexes.byOfficialId
    });
    if (frozenReport.entries.length !== controlled.MAX_CATCHUP_DISNEY_BATCH) {
      throw new Error(
        `Insufficient catch-up candidates ${frozenReport.entries.length}; expected ${controlled.MAX_CATCHUP_DISNEY_BATCH}`
      );
    }
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(DEFAULT_CATCHUP_FREEZE, JSON.stringify(frozenReport, null, 2));
    args.frozenReport = DEFAULT_CATCHUP_FREEZE;
  }

  if (args.frozenReport) {
    frozenReport = controlled.loadCatchupFrozenReport(JSON.parse(fs.readFileSync(args.frozenReport, "utf8")));
    const validation = controlled.validateCatchupFrozenManifest(frozenReport);
    if (!validation.ok) {
      throw new Error(`Catch-up frozen manifest invalid: ${validation.failures.join(", ")}`);
    }
  }

  const selection = controlled.selectCatchupBatchProducts(
    simulation.products,
    simulation.write_manifest?.manifest || [],
    {
      maxSize: controlled.MAX_CATCHUP_DISNEY_BATCH,
      today,
      existingByOfficialId: indexes.byOfficialId,
      excludeOfficialIds
    }
  );

  const productsByKey = new Map(simulation.products.map((r) => [r.official_sailing_id, r]));
  const sourceRefresh = frozenReport
    ? controlled.validateSelectedAgainstFreshSource(
        frozenReport.frozen_identities,
        productsByKey,
        frozenReport.entries,
        adapter.ADAPTER_VERSION,
        ctx.line
      )
    : { ok: false, failures: [{ issue: "no_frozen_report" }] };

  const collisionCheck = frozenReport
    ? await countCollisions(sb, ctx.line.id, frozenReport.entries)
    : { selected_existing_matches: 0, external_key_collisions: 0, identity_key_collisions: 0 };

  const preWriteGate = controlled.evaluateCatchupPreWriteGate({
    sourceComplete: simulation.quality_gate?.source_complete === true,
    identityCollisions: simulation.snapshot?.expansion?.identity_collisions || 0,
    endpointUnresolvedConflicts: simulation.endpoint_audit?.unresolved_conflicts || 0,
    eligibilityArithmeticPass: simulation.eligibility?.arithmetic?.reconciles === true,
    oneWayNativeParsePass: simulation.one_way_audit?.explicit_two_endpoint_native_parse !== false,
    legacyBaselineOk: baseline.ok,
    phase3TwentyVerified: baseline.phase3_present && baseline.phase3_active,
    selectedCount: frozenReport?.entries?.length || selection.selected.length,
    existingSelectedOfficialIds: collisionCheck.selected_existing_matches,
    externalKeyCollisions: collisionCheck.external_key_collisions,
    identityKeyCollisions: collisionCheck.identity_key_collisions,
    hashMismatch: frozenReport ? !sourceRefresh.ok : false,
    lockSmokePassed: !args.apply || lockSmoke?.passed === true,
    phase3RollbackOk: phase3Rollback.existed || phase3Rollback.recovered === true
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

  const frozenEntriesById = new Map((frozenReport?.entries || []).map((e) => [e.official_sailing_id, e]));
  const selectedProducts = frozenReport
    ? frozenReport.frozen_identities.map((id) => productsByKey.get(id)).filter(Boolean)
    : selection.selected;

  const runId = options.runId || `disney-phase4a-catchup-1-${startedAt.replace(/[:.]/g, "-")}`;
  let writeResult = null;
  let globalLockReport = null;
  let rollbackPersist = null;
  let rollbackManifest = null;
  let partialRecovery = null;

  if (args.apply) {
    if (!preWriteGate.passed) {
      throw new Error(`Catch-up pre-write gate failed: ${preWriteGate.failures.join(", ")}`);
    }

    try {
      const protectedApply = await executeControlledProductionApply(
        sb,
        {
          runId,
          lineSlug: controlled.DISNEY_LINE_SLUG,
          operation: "disney_phase4a_catchup_batch_1",
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
            maxWrites: controlled.MAX_CATCHUP_DISNEY_BATCH
          })
      );

      globalLockReport = protectedApply.global_lock;
      if (protectedApply.blocked) {
        throw new Error(`Catch-up apply blocked: ${protectedApply.reason}`);
      }

      writeResult = protectedApply.writeResult;
      if (writeResult.stats.inserted !== controlled.MAX_CATCHUP_DISNEY_BATCH) {
        throw new Error(`Unexpected insert count ${writeResult.stats.inserted}`);
      }
      if (writeResult.stats.updated > 0) {
        throw new Error(`Unexpected updates: ${writeResult.stats.updated}`);
      }
    } catch (error) {
      partialRecovery = await controlled.buildPartialWriteRecoveryReport({
        supabase: sb,
        cruiseLineId: ctx.line.id,
        frozenOfficialIds: frozenReport.frozen_identities,
        existingBeforeIds,
        writeStats: writeResult?.stats || {},
        error
      });
      rollbackManifest = buildRollbackManifestFromWriteResult({
        runId,
        cruiseLineId: ctx.line.id,
        lineSlug: controlled.DISNEY_LINE_SLUG,
        triggerType: "disney_phase4a_catchup_partial",
        writeResult: writeResult || { stats: partialRecovery }
      });
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(REPORT_DIR, `disney-phase4a-partial-recovery-${runId}.json`),
        JSON.stringify({ partialRecovery, rollbackManifest }, null, 2)
      );
      throw error;
    }

    rollbackManifest = buildRollbackManifestFromWriteResult({
      runId,
      cruiseLineId: ctx.line.id,
      lineSlug: controlled.DISNEY_LINE_SLUG,
      triggerType: "disney_phase4a_catchup_batch_1",
      writeResult
    });
    rollbackPersist = await persistMaintenanceRollbackManifest(sb, {
      runId,
      cruiseLineId: ctx.line.id,
      lineSlug: controlled.DISNEY_LINE_SLUG,
      triggerType: "disney_phase4a_catchup_batch_1",
      writeResult
    });
  }

  const countsAfter = args.apply
    ? {
        disney_total: await headLineCount(ctx.line.id),
        disney_active: await headLineCount(ctx.line.id, "active"),
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
    ? writes.verifyInsertedRecords(insertedRows, frozenEntriesById, ctx.line.id)
    : null;

  const allRowsAfter = args.apply
    ? await sb(
        `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
          ctx.line.id
        )}&select=id,cruise_line_id,status,ship_id,destination_id,departure_date,return_date,nights,departure_port,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract`
      )
    : ctx.existingRows;

  const legacyImmut = args.apply
    ? controlled.verifyLegacyImmutability(legacySnapshotBefore, allRowsAfter)
    : null;
  const phase3Immut = args.apply
    ? controlled.verifyPhase3TwentyImmutability(phase3SnapshotBefore, allRowsAfter)
    : null;

  const countReconciliation = args.apply
    ? controlled.verifyCatchupCountReconciliation(countsBefore, countsAfter, writeResult?.stats || {})
    : null;

  const postSim = args.apply
    ? await adapter.simulateDisneyDiscovery({
        cruiseLine: ctx.line,
        ships: ctx.ships,
        destinations: ctx.destinations,
        today,
        existingRows: allRowsAfter,
        supabaseQuery: sb
      })
    : null;

  const postManifest = postSim
    ? adapter.buildProposedWriteManifest(postSim.products, allRowsAfter, ctx.line, postSim.legacy_audit)
    : null;

  const allOfficialIds = [...phase3Ids, ...(frozenReport?.frozen_identities || [])];
  const postReclass = postManifest
    ? allOfficialIds.map((id) => ({
        official_sailing_id: id,
        action: postManifest.manifest.find((m) => m.official_product_key === id)?.action
      }))
    : null;

  const postWriteReconciliationPassed =
    !args.apply ||
    ((postReclass?.filter((r) => r.action === "duplicate_skip").length || 0) ===
      (phase3Ids.length + (frozenReport?.frozen_identities?.length || 0)) &&
      (postReclass?.filter((r) => r.action === "update_exact_existing").length || 0) === 0);

  const dataPassed =
    baseline.ok &&
    preWriteGate.passed &&
    (!args.apply ||
      (writeResult?.stats?.inserted === controlled.MAX_CATCHUP_DISNEY_BATCH &&
        postVerify?.passed &&
        countReconciliation?.passed &&
        legacyImmut?.passed &&
        phase3Immut?.passed &&
        postWriteReconciliationPassed));

  const lockLifecyclePassed =
    lockSmoke?.passed === true &&
    (!args.apply ||
      (globalLockReport?.global_lock_acquired === true && globalLockReport?.global_lock_released === true));

  const report = {
    phase: "4A",
    repository: {
      starting_sha: startingSha,
      tooling_sha: startingSha,
      apply_sha: args.apply ? git("git rev-parse HEAD") : null,
      final_report_sha: null
    },
    phase3_validation: {
      disney_total: baseline.disney_total,
      disney_active: baseline.disney_active,
      phase3_twenty_verified: baseline.phase3_present && baseline.phase3_active,
      legacy_six_verified: baseline.legacy_count === 6
    },
    phase3_lock_anomaly: lockAnomaly,
    lock_before: lockBefore,
    lock_smoke: lockSmoke,
    phase3_rollback_manifest: {
      existed: phase3Rollback.existed === true,
      manifest_record_id: phase3Rollback.manifest_record_id || null,
      recovered_if_missing: phase3Rollback.recovered === true,
      inserted_count: phase3Rollback.inserted_count || phase3Rows.length
    },
    source_snapshot: {
      unique_sailings: simulation.source_unique_sailings,
      complete: simulation.quality_gate?.source_complete === true,
      identity_collisions: simulation.snapshot?.expansion?.identity_collisions || 0,
      production_eligible: simulation.eligibility?.waterfall?.production_eligible,
      remaining_inserts_before: simulation.write_manifest?.summary?.insert_active
    },
    production_reconciliation_before: simulation.write_manifest?.summary,
    frozen_catchup: frozenReport
      ? {
          batch_number: 1,
          size: frozenReport.entries.length,
          identities: frozenReport.frozen_identities,
          candidate_hash: frozenReport.frozen_candidate_hash
        }
      : null,
    prewrite_collisions: collisionCheck,
    pre_write_gate: preWriteGate,
    global_lock: globalLockReport,
    under_lock_recheck: args.apply ? { performed: true } : null,
    write_result: writeResult
      ? {
          attempted: writeResult.stats.attempted,
          inserted: writeResult.stats.inserted,
          updated: writeResult.stats.updated,
          failed: writeResult.stats.failed,
          deletes: 0,
          deactivations: 0,
          partial_write: false,
          inserted_record_ids: insertedIds
        }
      : null,
    partial_recovery: partialRecovery,
    rollback_manifest: {
      persisted: rollbackPersist?.skipped === false,
      manifest_record_id: rollbackPersist?.manifest_record_id || null,
      inserted_count: rollbackManifest?.inserted?.length || 0
    },
    verification: postVerify,
    count_reconciliation: countReconciliation,
    legacy_immutability: legacyImmut,
    phase3_twenty_immutability: phase3Immut,
    post_write_reconciliation: {
      remaining_proposed_inserts: postSim?.write_manifest?.summary?.insert_active,
      official_duplicate_skip: postReclass?.filter((r) => r.action === "duplicate_skip").length,
      update_proposals: postReclass?.filter((r) => r.action === "update_exact_existing").length,
      details: postReclass
    },
    counts_before: countsBefore,
    counts_after: countsAfter,
    quality_gate: {
      data_passed: dataPassed,
      lock_lifecycle_passed: lockLifecyclePassed,
      rollback_audit_passed: phase3Rollback.existed || phase3Rollback.recovered === true,
      overall_passed: dataPassed && lockLifecyclePassed,
      ready_for_additional_catchup: dataPassed && lockLifecyclePassed
    },
    blockers: preWriteGate.passed ? [] : preWriteGate.failures,
    run_id: runId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    writes: args.apply === true
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(PHASE4A_REPORT, JSON.stringify(report, null, 2));
  report.report_path = PHASE4A_REPORT;
  if (args.frozenReport) report.freeze_path = args.frozenReport;

  return report;
}

async function main() {
  try {
    const report = await runDisneyControlledCatchup();
    console.log(JSON.stringify(report, null, 2));
    if (!report.quality_gate?.overall_passed && report.writes) process.exit(1);
    if (report.blockers?.length && !report.writes) process.exit(1);
  } catch (err) {
    console.error(JSON.stringify({ status: "failed", error: err.message, code: err.code || null }, null, 2));
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
