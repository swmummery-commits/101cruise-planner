#!/usr/bin/env node
/**
 * Disney Cruise Line — Phase 3 first controlled production batch (exactly 20 INSERTs).
 *
 *   node scripts/run-disney-first-controlled-batch.mjs --preflight
 *   node scripts/run-disney-first-controlled-batch.mjs --dry-run
 *   node scripts/run-disney-first-controlled-batch.mjs --manifest
 *   DISNEY_DISCOVERY_WRITE_ENABLED=true node scripts/run-disney-first-controlled-batch.mjs \
 *     --apply --confirm=DISNEY-FIRST-CONTROLLED-BATCH \
 *     --frozen-report=reports/disney-phase3-first-controlled-freeze.json
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
const DEFAULT_FREEZE_PATH = path.join(REPORT_DIR, "disney-phase3-first-controlled-freeze.json");
const PHASE3_REPORT_PATH = path.join(REPORT_DIR, "disney-phase3-first-controlled-batch.json");

const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const adapter = require(path.join(root, "netlify/functions/lib/disney-discovery-adapter"));
const controlled = require(path.join(root, "netlify/functions/lib/disney-controlled-batch"));
const writes = require(path.join(root, "netlify/functions/lib/disney-discovery-writes"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { executeControlledProductionApply } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-global-write-lock"
));
const {
  buildRollbackManifestFromWriteResult,
  persistMaintenanceRollbackManifest
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-maintenance-manifests"));

export function parseArgs(argv = process.argv) {
  const args = {
    preflight: false,
    dryRun: false,
    manifest: false,
    apply: false,
    confirm: null,
    frozenReport: null
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--manifest") args.manifest = true;
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--frozen-report=")) args.frozenReport = path.resolve(String(arg.split("=")[1]).trim());
    if (arg.startsWith("--limit=") || arg.startsWith("--batch-size=")) {
      throw new Error("Disney controlled batch rejects custom limits. Hard maximum is 20.");
    }
  }
  if (args.apply) {
    args.preflight = true;
    args.dryRun = true;
    args.manifest = true;
  } else if (!Object.values(args).some((v) => v === true) && !args.confirm) {
    args.preflight = true;
    args.dryRun = true;
  }
  return args;
}

export function assertApplyAllowed(args) {
  if (!args.apply) return;
  if (args.confirm !== controlled.APPLY_CONFIRMATION_TOKEN) {
    const err = new Error("disney_apply_confirmation_required");
    err.code = "disney_apply_confirmation_required";
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
    out.push({
      slug,
      active: await headLineCount(line.id, "active")
    });
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

async function runLiveSimulation(sb, ctx, today) {
  console.error("Running Disney Phase 3 live source simulation…");
  return adapter.simulateDisneyDiscovery({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    today,
    existingRows: ctx.existingRows,
    supabaseQuery: sb
  });
}

function verifyLegacyBaseline(existingRows) {
  const ids = new Set((existingRows || []).map((r) => r.id));
  const legacyPresent = controlled.DISNEY_LEGACY_ROW_IDS.every((id) => ids.has(id));
  const officialMatches = (existingRows || []).filter(
    (r) => r.official_sailing_id && controlled.DISNEY_LEGACY_ROW_IDS.includes(r.id) === false
  );
  const unexpectedOfficial = officialMatches.filter((r) => {
    const key = String(r.official_sailing_id || "");
    return key.includes("|");
  });
  return {
    ok: legacyPresent && unexpectedOfficial.length === 0,
    total: existingRows.length,
    legacy_present: legacyPresent,
    unexpected_official_rows: unexpectedOfficial.map((r) => ({
      id: r.id,
      official_sailing_id: r.official_sailing_id,
      status: r.status
    }))
  };
}

async function countCollisions(sb, lineId, entries) {
  let externalKeyCollisions = 0;
  let identityKeyCollisions = 0;
  const details = [];

  for (const entry of entries || []) {
    const ext =
      (
        await sb(
          `discovered_cruises?external_key=eq.${encodeURIComponent(entry.external_key)}&select=id,cruise_line_id,external_key&limit=1`
        )
      )?.[0] || null;
    if (ext?.id) {
      externalKeyCollisions += 1;
      details.push({ type: "external_key", official_sailing_id: entry.official_sailing_id, id: ext.id });
    }
    const ident =
      (
        await sb(
          `discovered_cruises?identity_key=eq.${encodeURIComponent(entry.identity_key)}&select=id,cruise_line_id,identity_key&limit=1`
        )
      )?.[0] || null;
    if (ident?.id) {
      identityKeyCollisions += 1;
      details.push({ type: "identity_key", official_sailing_id: entry.official_sailing_id, id: ident.id });
    }
  }

  const officialIds = entries.map((e) => e.official_sailing_id);
  const quoted = officialIds.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",");
  const existingOfficial = quoted.length
    ? await sb(
        `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
          lineId
        )}&official_sailing_id=in.(${quoted})&select=id,official_sailing_id`
      )
    : [];

  return {
    external_key_collisions: externalKeyCollisions,
    identity_key_collisions: identityKeyCollisions,
    selected_existing_matches: existingOfficial?.length || 0,
    details
  };
}

export async function runDisneyFirstControlledBatch(options = {}) {
  const args = options.args || parseArgs();
  const startedAt = new Date().toISOString();
  const startingSha = git("git rev-parse HEAD");
  const today = options.today || perthCalendarDate();
  const sb = options.supabase || createMaintenanceSupabase(root);

  assertApplyAllowed(args);

  const ctx = await loadContext(sb);
  const simulation = await runLiveSimulation(sb, ctx, today);
  const legacyBaseline = verifyLegacyBaseline(ctx.existingRows);

  const dd1568 = simulation.products.find((r) => r.official_sailing_id === "DD1568|2027-04-23");
  const dd1568Evidence = dd1568
    ? adapter.collectEndpointEvidence(
        dd1568.raw,
        dd1568.candidate?.departure_port_meta || {},
        dd1568.candidate?.arrival_port_meta || {}
      )
    : null;

  let frozenReport = null;
  if (args.manifest && !args.frozenReport) {
    frozenReport = controlled.buildPhase3FreezeReport({
      simulation,
      cruiseLine: ctx.line,
      today,
      sourceSnapshotTotal: simulation.source_unique_sailings,
      sourceComplete: simulation.quality_gate?.source_complete === true
    });
    if (frozenReport.entries.length !== controlled.MAX_CONTROLLED_DISNEY_BATCH) {
      throw new Error(
        `Insufficient frozen batch size ${frozenReport.entries.length}; expected ${controlled.MAX_CONTROLLED_DISNEY_BATCH}`
      );
    }
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(DEFAULT_FREEZE_PATH, JSON.stringify(frozenReport, null, 2));
    args.frozenReport = DEFAULT_FREEZE_PATH;
  }

  if (args.frozenReport) {
    frozenReport = controlled.loadFrozenReport(JSON.parse(fs.readFileSync(args.frozenReport, "utf8")));
    const validation = controlled.validateFrozenManifest(frozenReport);
    if (!validation.ok) {
      throw new Error(`Frozen manifest validation failed: ${validation.failures.join(", ")}`);
    }
  }

  const indexes = await writes.indexExistingDisneyRecords(sb, ctx.line.id);
  const frozenIds = frozenReport?.frozen_identities || [];
  const selection = controlled.selectFrozenBatchProducts(simulation.products, frozenIds, {
    today,
    existingByOfficialId: indexes.byOfficialId
  });

  const productsByKey = new Map(simulation.products.map((r) => [r.official_sailing_id, r]));
  const sourceRefresh = frozenReport
    ? controlled.validateSelectedAgainstFreshSource(
        selection.selected_ids,
        productsByKey,
        frozenReport.entries,
        adapter.ADAPTER_VERSION,
        ctx.line
      )
    : { ok: false, failures: [{ issue: "no_frozen_report" }] };

  const collisionCheck = frozenReport
    ? await countCollisions(sb, ctx.line.id, frozenReport.entries)
    : {
        external_key_collisions: 0,
        identity_key_collisions: 0,
        selected_existing_matches: 0,
        details: []
      };

  const preWriteGate = controlled.evaluatePreWriteGate({
    sourceComplete: simulation.quality_gate?.source_complete === true,
    identityCollisions: simulation.snapshot?.expansion?.identity_collisions || 0,
    endpointUnresolvedConflicts: simulation.endpoint_audit?.unresolved_conflicts || 0,
    eligibilityArithmeticPass: simulation.eligibility?.arithmetic?.reconciles === true,
    oneWayNativeParsePass: simulation.one_way_audit?.explicit_two_endpoint_native_parse !== false,
    legacyBaselineOk: legacyBaseline.ok,
    selectedCount: selection.selected.length,
    existingSelectedOfficialIds: collisionCheck.selected_existing_matches,
    externalKeyCollisions: collisionCheck.external_key_collisions,
    identityKeyCollisions: collisionCheck.identity_key_collisions,
    hashMismatch: frozenReport ? !sourceRefresh.ok : false,
    phase2dHashRejected: frozenReport ? controlled.rejectObsoletePhase2dHash(frozenReport.frozen_candidate_hash) : false
  });

  const countsBefore = {
    disney_total: await headLineCount(ctx.line.id),
    disney_active: await headLineCount(ctx.line.id, "active"),
    disney_hidden: await headLineCount(ctx.line.id, "hidden"),
    disney_match_required: await headLineCount(ctx.line.id, "match_required"),
    disney_official_sailing_id: (
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

  const legacySnapshotBefore = controlled.snapshotLegacyRows(ctx.existingRows);
  const runId = options.runId || `disney-phase3-first-${startedAt.replace(/[:.]/g, "-")}`;
  const frozenEntriesById = new Map((frozenReport?.entries || []).map((e) => [e.official_sailing_id, e]));

  const batchManifest = await writes.buildDisneyBatchManifest({
    selectedProducts: selection.selected,
    cruiseLine: ctx.line,
    frozenEntriesById,
    supabase: sb,
    runId
  });

  let writeResult = null;
  let globalLockReport = null;
  let rollbackManifest = null;
  let rollbackPersist = null;

  if (args.apply) {
    if (!preWriteGate.passed) {
      throw new Error(`Pre-write gate failed: ${preWriteGate.failures.join(", ")}`);
    }

    const protectedApply = await executeControlledProductionApply(
      sb,
      {
        runId,
        lineSlug: controlled.DISNEY_LINE_SLUG,
        operation: "disney_first_controlled_batch",
        performWrites: true,
        underLockRecheck: async () => {
          const underLockCollisions = await countCollisions(sb, ctx.line.id, frozenReport.entries);
          const underLockSelection = controlled.selectFrozenBatchProducts(simulation.products, frozenIds, {
            today: perthCalendarDate(),
            existingByOfficialId: (await writes.indexExistingDisneyRecords(sb, ctx.line.id)).byOfficialId
          });
          if (underLockCollisions.selected_existing_matches > 0) {
            return { ok: false, reason: "under_lock_selected_official_ids_already_present" };
          }
          if (underLockCollisions.external_key_collisions > 0) {
            return { ok: false, reason: "under_lock_external_key_collision" };
          }
          if (underLockCollisions.identity_key_collisions > 0) {
            return { ok: false, reason: "under_lock_identity_key_collision" };
          }
          if (underLockSelection.selected.length !== controlled.MAX_CONTROLLED_DISNEY_BATCH) {
            return { ok: false, reason: "under_lock_selection_no_longer_valid" };
          }
          const refresh = controlled.validateSelectedAgainstFreshSource(
            underLockSelection.selected_ids,
            productsByKey,
            frozenReport.entries,
            adapter.ADAPTER_VERSION,
            ctx.line
          );
          if (!refresh.ok) return { ok: false, reason: "under_lock_hash_mismatch" };
          return { ok: true };
        }
      },
      async () =>
        writes.applyDisneyBatchWrites({
          selectedProducts: selection.selected,
          frozenEntriesById,
          cruiseLine: ctx.line,
          runId,
          supabase: sb,
          performWrites: true,
          maxWrites: controlled.MAX_CONTROLLED_DISNEY_BATCH,
          operation: "disney_first_controlled_batch"
        })
    );

    globalLockReport = protectedApply.global_lock;
    if (protectedApply.blocked) {
      throw new Error(`Apply blocked: ${protectedApply.reason}`);
    }

    writeResult = protectedApply.writeResult;
    if (writeResult.stats.inserted !== controlled.MAX_CONTROLLED_DISNEY_BATCH) {
      throw new Error(`Unexpected insert count ${writeResult.stats.inserted}`);
    }
    if (writeResult.stats.updated > 0) {
      throw new Error(`Unexpected updates: ${writeResult.stats.updated}`);
    }

    rollbackManifest = buildRollbackManifestFromWriteResult({
      runId,
      cruiseLineId: ctx.line.id,
      lineSlug: controlled.DISNEY_LINE_SLUG,
      triggerType: "disney_first_controlled_batch",
      writeResult
    });

    rollbackPersist = await persistMaintenanceRollbackManifest(sb, {
      runId,
      cruiseLineId: ctx.line.id,
      lineSlug: controlled.DISNEY_LINE_SLUG,
      triggerType: "disney_first_controlled_batch",
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
        `discovered_cruises?id=in.(${insertedIds.map((id) => `"${id}"`).join(",")})&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,arrival_port,status,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract`
      )
    : [];

  const postWriteVerification = args.apply
    ? writes.verifyInsertedRecords(insertedRows, frozenEntriesById, ctx.line.id)
    : null;
  const duplicateVerification = args.apply ? writes.verifyDuplicateChecks(insertedRows) : null;

  const legacyRowsAfter = args.apply
    ? await sb(
        `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
          ctx.line.id
        )}&select=id,status,ship_id,destination_id,departure_date,return_date,nights,departure_port,official_sailing_id,identity_key,external_key,source_url,official_url,raw_extract`
      )
    : ctx.existingRows;
  const legacyImmutability = args.apply
    ? controlled.verifyLegacyImmutability(legacySnapshotBefore, legacyRowsAfter)
    : null;

  const countReconciliation = args.apply
    ? controlled.verifyCountReconciliation(countsBefore, countsAfter, writeResult?.stats || {})
    : null;

  const postWriteManifest = args.apply
    ? adapter.buildProposedWriteManifest(simulation.products, legacyRowsAfter, ctx.line, simulation.legacy_audit)
    : null;

  const newlyInsertedClassifications = args.apply
    ? (postWriteManifest?.manifest || [])
        .filter((m) => frozenIds.includes(m.official_product_key))
        .map((m) => ({
          official_product_key: m.official_product_key,
          action: m.action
        }))
    : null;

  const qualityGatePassed =
    preWriteGate.passed &&
    (!args.apply ||
      (writeResult?.stats?.inserted === 20 &&
        writeResult?.stats?.updated === 0 &&
        postWriteVerification?.passed &&
        duplicateVerification?.passed &&
        countReconciliation?.passed &&
        legacyImmutability?.passed &&
        newlyInsertedClassifications?.every((r) => r.action === "duplicate_skip")));

  const report = {
    phase: "3",
    starting_sha: startingSha,
    tooling_commit_sha: startingSha,
    apply_sha: args.apply ? git("git rev-parse HEAD") : null,
    report_commit_sha: null,
    endpoint_hardening: {
      dd1568_title: dd1568?.raw?.product_name || null,
      parsed_embark: dd1568Evidence?.title_embark || null,
      parsed_arrival: dd1568Evidence?.title_arrival || null,
      all_one_way_native_endpoint_parse: simulation.one_way_audit?.explicit_two_endpoint_native_parse !== false,
      unresolved_endpoint_conflicts: simulation.endpoint_audit?.unresolved_conflicts || 0
    },
    source_snapshot: {
      unique_sailings: simulation.source_unique_sailings,
      complete: simulation.quality_gate?.source_complete === true,
      identity_collisions: simulation.snapshot?.expansion?.identity_collisions || 0
    },
    frozen_batch: frozenReport
      ? {
          size: frozenReport.entries.length,
          identities: frozenReport.frozen_identities,
          candidate_hash: frozenReport.frozen_candidate_hash,
          adapter_version: frozenReport.adapter_version,
          current_perth_date: today
        }
      : null,
    prewrite_state: {
      disney_total: countsBefore.disney_total,
      disney_active: countsBefore.disney_active,
      disney_legacy_rows: controlled.DISNEY_LEGACY_ROW_IDS.length,
      selected_existing_matches: collisionCheck.selected_existing_matches,
      external_key_collisions: collisionCheck.external_key_collisions,
      identity_key_collisions: collisionCheck.identity_key_collisions,
      legacy_baseline: legacyBaseline
    },
    global_lock: globalLockReport,
    under_lock_recheck: args.apply ? { performed: true } : null,
    write_result: writeResult
      ? {
          attempted: writeResult.stats.attempted,
          inserted: writeResult.stats.inserted,
          updated: writeResult.stats.updated,
          duplicate_skips: writeResult.stats.duplicate_skips,
          failed: writeResult.stats.failed,
          inserted_record_ids: insertedIds
        }
      : null,
    post_write_verification: postWriteVerification,
    duplicate_verification: duplicateVerification,
    count_reconciliation: countReconciliation,
    legacy_row_immutability: legacyImmutability,
    rollback_manifest: rollbackManifest,
    rollback_manifest_record_id: rollbackPersist?.manifest_record_id || null,
    post_write_read_only_reconciliation: newlyInsertedClassifications,
    tests: null,
    quality_gate: {
      passed: qualityGatePassed,
      ready_for_catchup: qualityGatePassed === true
    },
    blockers: preWriteGate.passed ? [] : preWriteGate.failures,
    recommendation: qualityGatePassed
      ? "Phase 3 first controlled batch complete. Catch-up not started by design."
      : "Phase 3 blocked. Zero or partial writes must not proceed to catch-up.",
    pre_write_gate: preWriteGate,
    source_refresh: sourceRefresh,
    one_way_audit: simulation.one_way_audit,
    run_id: runId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    writes: args.apply === true
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(PHASE3_REPORT_PATH, JSON.stringify(report, null, 2));
  report.report_path = PHASE3_REPORT_PATH;
  if (args.manifest && frozenReport) report.freeze_path = args.frozenReport || DEFAULT_FREEZE_PATH;

  return report;
}

async function main() {
  try {
    const report = await runDisneyFirstControlledBatch();
    console.log(JSON.stringify(report, null, 2));
    if (!report.quality_gate?.passed && report.writes !== true) {
      if (report.blockers?.length) process.exit(1);
    }
    if (report.writes && !report.quality_gate?.passed) process.exit(1);
  } catch (err) {
    console.error(JSON.stringify({ status: "failed", error: err.message, code: err.code || null }, null, 2));
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
