#!/usr/bin/env node
/**
 * Royal Caribbean International — final production catch-up (frozen master manifest, 250-record chunks).
 *
 *   node scripts/run-royal-caribbean-final-catchup.mjs --preflight
 *   node scripts/run-royal-caribbean-final-catchup.mjs --manifest
 *   ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED=true node scripts/run-royal-caribbean-final-catchup.mjs --apply --confirm=ROYAL-CARIBBEAN-FINAL-CATCHUP
 *   ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED=true node scripts/run-royal-caribbean-final-catchup.mjs --full --apply --confirm=ROYAL-CARIBBEAN-FINAL-CATCHUP
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
const {
  simulateRoyalCaribbeanInventory,
  catalogueDestinations,
  LINE_SLUG,
  officialProductKey
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-adapter"));
const {
  buildRoyalCaribbeanBatchManifest,
  indexExistingRoyalCaribbeanRecords,
  applyRoyalCaribbeanBatchWrites,
  isLegacyHtmlDiscoveryRow
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-writes"));
const {
  BATCH1_OFFICIAL_SAILING_IDS,
  buildRoyalCaribbeanReconciliationArithmetic,
  evaluateRoyalCaribbeanDryRunHealth,
  computeSourceSnapshotId,
  validateManifestAgainstProduction
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-controlled-batch"));
const {
  MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK,
  CATCHUP_CONFIRM_TOKEN,
  selectCatchupCandidates,
  buildMasterManifest,
  splitMasterIntoChunks,
  validateMasterManifest,
  comparePaginationStrategies,
  compareCatchupSourceSnapshots
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-final-catchup"));
const {
  resolveRoyalCaribbeanDiscoveryMode,
  assertRoyalCaribbeanWritesAllowed
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-mode"));
const {
  countGenuineRoyalCaribbeanSailings,
  fetchRoyalCaribbeanRowsByIds,
  fetchRoyalCaribbeanRowsBySailingIds,
  verifyManifestRowsAgainstProduction,
  verifyBatch1ProductionRecords
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-post-write-verification"));
const { perthCalendarDate, daysUntilDeparture } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const { isRoyalCaribbeanWeeklyReconciliationEnabled } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));

const REPORT_DIR = path.join(root, "reports");
const PROMPT5_SHA = "b29db69";
const BATCH2_MANIFEST_PATH = path.join(
  root,
  "reports/royal-caribbean-controlled-batch-manifest-royal-caribbean-batch2-2026-08-13T02-30-30.json"
);

function parseArgs(argv) {
  const args = {
    preflight: false,
    paginationCheck: false,
    dryRun: false,
    manifest: false,
    apply: false,
    verify: false,
    postDryRun: false,
    full: false,
    confirm: null,
    masterPath: null,
    catchupId: null,
    resumeFromChunk: 1
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--pagination-check") args.paginationCheck = true;
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--manifest") args.manifest = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--post-dry-run") args.postDryRun = true;
    if (arg === "--full") args.full = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--master-path=")) args.masterPath = path.resolve(arg.split("=")[1]);
    if (arg.startsWith("--catchup-id=")) args.catchupId = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--resume-from-chunk=")) args.resumeFromChunk = Number(arg.split("=")[1]);
    if (arg.startsWith("--limit=")) throw new Error("Royal Caribbean catch-up rejects --limit");
  }
  if (args.full) {
    args.preflight = true;
    args.paginationCheck = true;
    args.dryRun = true;
    args.manifest = true;
    args.apply = true;
    args.verify = true;
    args.postDryRun = true;
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

function collectProductionSailingIds(indexes) {
  const ids = new Set();
  for (const row of indexes.byProductKey.values()) {
    if (row?.official_sailing_id && !isLegacyHtmlDiscoveryRow(row)) ids.add(row.official_sailing_id);
  }
  return ids;
}

async function loadLineContext(sb) {
  const line = (
    await sb(
      `ci_cruise_lines?slug=eq.${encodeURIComponent(LINE_SLUG)}&select=id,name,slug,website_url,cruise_search_url&limit=1`
    )
  )?.[0];
  if (!line) throw new Error(`Cruise line not found: ${LINE_SLUG}`);
  const destRows = await sb("destinations?select=id,slug,name&limit=500");
  return { line, destinations: catalogueDestinations(destRows || []) };
}

async function verifyBatch2ProductionRecords(sb) {
  if (!fs.existsSync(BATCH2_MANIFEST_PATH)) return { ok: false, issues: [{ issue: "batch2_manifest_missing" }] };
  const manifest = JSON.parse(fs.readFileSync(BATCH2_MANIFEST_PATH, "utf8"));
  const ids = manifest.entries.map((e) => e.official_sailing_id);
  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const batch = await sb(
      `discovered_cruises?official_sailing_id=in.(${chunk.map((id) => `"${id}"`).join(",")})&select=id,official_sailing_id,status,cruise_line_id,identity_key&limit=100`
    );
    rows.push(...(batch || []));
  }
  const issues = [];
  for (const id of ids) {
    const matches = rows.filter((r) => r.official_sailing_id === id);
    if (matches.length !== 1) issues.push({ official_sailing_id: id, issue: "batch2_count_not_1", count: matches.length });
  }
  const identityKeys = rows.map((r) => r.identity_key).filter(Boolean);
  if (new Set(identityKeys).size !== identityKeys.length) issues.push({ issue: "duplicate_identity_keys_in_batch2" });
  return { ok: issues.length === 0, issues, expected_count: ids.length, found_count: rows.length };
}

async function runFreshDryRun(sb, today) {
  const { line, destinations } = await loadLineContext(sb);
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(line.id)}&select=id,name,cruise_line_id,official_line_ship_id,active&limit=200`
  );
  const simulation = await simulateRoyalCaribbeanInventory({
    cruiseLine: line,
    ships: ships || [],
    destinations,
    today
  });
  const manifest = await buildRoyalCaribbeanBatchManifest({
    products: simulation.products || [],
    cruiseLine: line,
    destinations,
    supabase: sb,
    runId: `rc-catchup-${Date.now()}`
  });
  const ocean = (simulation.products || []).filter((p) => p.product_type === "ocean_cruise");
  const eligibleOcean = ocean.filter((p) => p.ocean_bucket === "eligible");
  const arithmetic = buildRoyalCaribbeanReconciliationArithmetic({
    uniqueSailings: (simulation.products || []).length,
    oceanCruises: ocean.length,
    oceanCruisetours: (simulation.products || []).filter((p) => p.product_type === "ocean_cruisetour").length,
    unknownProducts: (simulation.products || []).filter((p) => p.product_type === "unknown").length,
    otherProductTypes: 0,
    oceanIncomplete: ocean.filter((p) => p.ocean_bucket === "incomplete").length,
    oceanEligible: eligibleOcean.length,
    oceanWithinCutoff: ocean.filter((p) => p.ocean_bucket === "within_cutoff").length,
    oceanPast: ocean.filter((p) => p.ocean_bucket === "past").length,
    oceanUnfamiliarStatus: ocean.filter((p) => p.ocean_bucket === "unfamiliar_status").length,
    oceanOtherExclusions: 0,
    recognisedExistingEligible: eligibleOcean.filter((p) => {
      const entry = manifest.products.find((m) => m.stable_identity_key === p.official_sailing_id);
      return entry && ["duplicate_skip", "update_exact_legacy_match"].includes(entry.proposed_action);
    }).length,
    outstandingEligibleInserts: eligibleOcean.filter((p) => {
      const entry = manifest.products.find((m) => m.stable_identity_key === p.official_sailing_id);
      return entry?.proposed_action === "insert_active";
    }).length,
    proposedUpdates: eligibleOcean.filter((p) => {
      const entry = manifest.products.find((m) => m.stable_identity_key === p.official_sailing_id);
      return entry?.proposed_action === "update_exact_legacy_match";
    }).length
  });
  const health = evaluateRoyalCaribbeanDryRunHealth({ simulation, arithmetic, manifest, actualWrites: 0 });
  return { line, destinations, ships, simulation, manifest, arithmetic, health, today };
}

function buildDryRunSnapshotSummary(simulation, manifest, arithmetic) {
  return {
    source_snapshot_id: computeSourceSnapshotId(simulation),
    sailing_ids: (simulation?.products || []).map((p) => officialProductKey(p.raw)).filter(Boolean),
    unique_sailings: (simulation?.products || []).length,
    proposed_inserts: manifest.products.filter((p) => p.proposed_action === "insert_active").length,
    recognised_existing: manifest.products.filter((p) =>
      ["duplicate_skip", "update_exact_legacy_match"].includes(p.proposed_action)
    ).length,
    outstanding_eligible: manifest.products.filter((p) => p.proposed_action === "insert_active").length,
    reconciliation_arithmetic_ok: arithmetic.reconciliation_arithmetic_ok
  };
}

async function verifyCompletedCatchupChunk(sb, chunk, catchupId, today) {
  const checkpointPath = path.join(
    REPORT_DIR,
    `royal-caribbean-catchup-chunk-${catchupId}-${chunk.chunk_number}.json`
  );
  const checkpoint = fs.existsSync(checkpointPath)
    ? JSON.parse(fs.readFileSync(checkpointPath, "utf8"))
    : null;
  const sailingIds = chunk.manifest.entries.map((e) => e.official_sailing_id);
  const rows = await fetchRoyalCaribbeanRowsBySailingIds(sb, sailingIds);
  const verification = verifyManifestRowsAgainstProduction(chunk.manifest, rows, today, {
    skip45DayBuffer: true
  });
  if (!verification.ok || rows.length !== chunk.record_count) {
    throw new Error(
      `Resume verification failed for completed chunk ${chunk.chunk_number}: ${verification.issues?.length || 0} issues, ${rows.length}/${chunk.record_count} rows`
    );
  }
  return {
    chunk_number: chunk.chunk_number,
    chunk_hash: chunk.manifest_hash,
    intended_count: chunk.record_count,
    attempted: checkpoint?.attempted ?? chunk.record_count,
    successful: checkpoint?.successful ?? chunk.record_count,
    failed: checkpoint?.failed ?? 0,
    inserted_ids: checkpoint?.inserted_ids || rows.map((r) => r.id),
    production_count_before: checkpoint?.production_count_before ?? null,
    production_count_after: checkpoint?.production_count_after ?? null,
    field_mismatch_count: 0,
    chunk_post_write_verification_ok: true,
    resumed_without_reapply: true,
    completed_at: checkpoint?.completed_at || new Date().toISOString()
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  let catchupId = args.catchupId || `royal-caribbean-catchup-${startedAt.replace(/[:.]/g, "-").slice(0, 19)}`;
  const report = {
    phase: "royal_caribbean_prompt6_final_catchup",
    started_at: startedAt,
    catchup_id: catchupId,
    max_chunk_size: MAX_ROYAL_CARIBBEAN_CATCHUP_CHUNK
  };

  report.repository_checkpoint = {
    branch: git("git branch --show-current"),
    head: git("git rev-parse HEAD"),
    origin_main: git("git rev-parse origin/main"),
    local_main: git("git rev-parse main"),
    prompt5_sha: PROMPT5_SHA,
    commits_vs_main: git("git log --oneline origin/main..HEAD").split("\n").filter(Boolean)
  };

  let savedWriteFlag = null;
  if (args.preflight || args.full) {
    if (isRoyalCaribbeanWeeklyReconciliationEnabled()) {
      throw new Error("ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED must remain false");
    }
    savedWriteFlag = process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED;
    delete process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED;
    const discoveryOut = execSync("node scripts/test-royal-caribbean-discovery.mjs", { cwd: root, encoding: "utf8" });
    const batchOut = execSync("node scripts/test-royal-caribbean-controlled-batch.mjs", { cwd: root, encoding: "utf8" });
    const catchupOut = execSync("node scripts/test-royal-caribbean-final-catchup.mjs", { cwd: root, encoding: "utf8" });
    report.tests_preflight = {
      discovery_passed: Number((discoveryOut.match(/(\d+) passed/) || [])[1]),
      controlled_batch_passed: Number((batchOut.match(/(\d+) passed/) || [])[1]),
      catchup_passed: Number((catchupOut.match(/(\d+) passed/) || [])[1])
    };
    if (savedWriteFlag) process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED = savedWriteFlag;
  }

  report.github_workflow = {
    path: ".github/workflows/royal-caribbean-source-smoke.yml",
    present_on_branch: fs.existsSync(path.join(root, ".github/workflows/royal-caribbean-source-smoke.yml")),
    explanation:
      "Workflow was committed in b930163/acb906e. Prompt 5 reported absent because execution was on main branch without RC commits. Restored on clean integration branch."
  };

  const sb = createMaintenanceSupabase(root);
  const today = perthCalendarDate();

  report.production_integrity = {
    batch1: await verifyBatch1ProductionRecords(sb),
    batch2: await verifyBatch2ProductionRecords(sb),
    inventory: await countGenuineRoyalCaribbeanSailings(sb)
  };
  if (!report.production_integrity.batch1.ok || !report.production_integrity.batch2.ok) {
    throw new Error("Existing production records not healthy — abort before catch-up");
  }
  if (report.production_integrity.inventory.genuine_sailing_count < 120) {
    throw new Error(`Expected at least 120 genuine sailings, found ${report.production_integrity.inventory.genuine_sailing_count}`);
  }

  if (args.paginationCheck || args.dryRun || args.manifest || args.apply || args.full) {
    report.pagination_consistency = await comparePaginationStrategies({ today });
    if (!report.pagination_consistency.source_pagination_consistency_ok) {
      throw new Error("Source pagination consistency gate failed");
    }
  }

  let dryRunResult = null;
  let preWriteSnapshot = null;
  const skipFreshDryRun = Boolean(args.masterPath && args.resumeFromChunk > 1 && !args.dryRun && !args.full);
  if ((args.dryRun || args.manifest || args.apply || args.full) && !skipFreshDryRun) {
    dryRunResult = await runFreshDryRun(sb, today);
    preWriteSnapshot = buildDryRunSnapshotSummary(dryRunResult.simulation, dryRunResult.manifest, dryRunResult.arithmetic);
    report.pre_catchup_dry_run = {
      source_snapshot_id: preWriteSnapshot.source_snapshot_id,
      unique_sailings: preWriteSnapshot.unique_sailings,
      reconciliation_arithmetic_ok: preWriteSnapshot.reconciliation_arithmetic_ok,
      dry_run_health: dryRunResult.health,
      ship_audit: dryRunResult.simulation.ship_audit,
      unresolved_embarkation_ports: (dryRunResult.simulation.port_audit?.unresolved_conventional || []).filter(
        (r) => r.role === "embarkation"
      )
    };
    report.ship_code_status = {
      resolved_source_ships: dryRunResult.simulation.ship_audit?.resolved,
      unresolved_source_ships: dryRunResult.simulation.ship_audit?.unresolved,
      resolved_with_unseeded_official_line_ship_id: (dryRunResult.ships || []).filter(
        (s) => s.active !== false && !s.official_line_ship_id
      ).length,
      note: "30 resolved DB ships lack seeded official_line_ship_id — not unresolved ships; not blocking catch-up"
    };
    if (!dryRunResult.health.passed || !dryRunResult.arithmetic.reconciliation_arithmetic_ok) {
      throw new Error("Pre-catchup dry-run gates failed");
    }
  }

  let masterManifest = null;
  if (args.masterPath) {
    masterManifest = JSON.parse(fs.readFileSync(args.masterPath, "utf8"));
    report.master_manifest_path = args.masterPath;
    if (masterManifest.catchup_id) catchupId = masterManifest.catchup_id;
    report.catchup_id = catchupId;
    if (!dryRunResult) {
      const ctx = await loadLineContext(sb);
      dryRunResult = { ...ctx, today };
    }
    dryRunResult.indexes = await indexExistingRoyalCaribbeanRecords(sb, dryRunResult.line.id);
    const masterValidation = validateMasterManifest(masterManifest, {
      expectedHash: masterManifest.manifest_hash,
      today
    });
    report.master_manifest_gate = masterValidation.passed ? "PASS" : "FAIL";
    report.master_manifest_validation = masterValidation;
    if (!masterValidation.passed) {
      throw new Error("Frozen master manifest validation failed");
    }
    report.frozen_master_manifest = {
      path: args.masterPath,
      record_count: masterManifest.entries.length,
      source_snapshot_id: masterManifest.source_snapshot_id,
      manifest_hash: masterManifest.manifest_hash,
      first_official_sailing_id: masterManifest.entries[0]?.official_sailing_id,
      last_official_sailing_id: masterManifest.entries[masterManifest.entries.length - 1]?.official_sailing_id,
      chunk_plan: masterManifest.chunks,
      resume_from_chunk: args.resumeFromChunk
    };
  } else if (args.manifest || args.apply || args.full) {
    dryRunResult.indexes = await indexExistingRoyalCaribbeanRecords(sb, dryRunResult.line.id);
    const existingIds = collectProductionSailingIds(dryRunResult.indexes);
    const selection = selectCatchupCandidates(dryRunResult.simulation.products, {
      excludeSailingIds: existingIds,
      today
    });
    report.catchup_eligibility = {
      eligible_total: selection.eligible_count,
      eligible_22_44_days: selection.eligible_22_44_days,
      eligible_45_plus_days: selection.eligible_45_plus_days,
      excluded_existing: selection.excluded_existing_count,
      public_rule: ">21_days (45-day testing buffer removed)"
    };
    const sourceSnapshotId = computeSourceSnapshotId(dryRunResult.simulation);
    masterManifest = buildMasterManifest({
      selected: selection.selected,
      cruiseLine: dryRunResult.line,
      destinations: dryRunResult.destinations,
      catchupId,
      sourceSnapshotId,
      sourceFetchedAt: new Date().toISOString(),
      today
    });
    const masterValidation = validateMasterManifest(masterManifest, {
      expectedHash: masterManifest.manifest_hash,
      today
    });
    const prodCheck = await validateManifestAgainstProduction(masterManifest, dryRunResult.indexes);
    report.master_manifest_gate = masterValidation.passed && prodCheck.passed ? "PASS" : "FAIL";
    report.master_manifest_validation = { ...masterValidation, production_existing: prodCheck };
    if (!masterValidation.passed || !prodCheck.passed) {
      throw new Error("Master manifest validation failed");
    }
    const masterPath = writeReport(`royal-caribbean-catchup-master-manifest-${catchupId}.json`, masterManifest);
    report.frozen_master_manifest = {
      path: masterPath,
      record_count: masterManifest.entries.length,
      source_snapshot_id: masterManifest.source_snapshot_id,
      manifest_hash: masterManifest.manifest_hash,
      first_official_sailing_id: masterManifest.entries[0]?.official_sailing_id,
      last_official_sailing_id: masterManifest.entries[masterManifest.entries.length - 1]?.official_sailing_id,
      chunk_plan: masterManifest.chunks
    };
  }

  const { chunks } = masterManifest ? splitMasterIntoChunks(masterManifest) : { chunks: [] };
  report.chunk_plan = chunks.map((c) => ({
    chunk_number: c.chunk_number,
    record_count: c.record_count,
    manifest_hash: c.manifest_hash,
    first_official_sailing_id: c.first_official_sailing_id,
    last_official_sailing_id: c.last_official_sailing_id
  }));

  report.genuine_sailing_count_before = report.production_integrity.inventory;
  report.chunk_executions = [];

  if (args.apply || args.full) {
    if (String(process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
      throw new Error("ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED=true required for --apply");
    }
    if (args.confirm !== CATCHUP_CONFIRM_TOKEN) {
      throw new Error(`--confirm=${CATCHUP_CONFIRM_TOKEN} required`);
    }
    const modeGate = resolveRoyalCaribbeanDiscoveryMode("final_catchup");
    assertRoyalCaribbeanWritesAllowed(modeGate);

    for (const chunk of chunks) {
      if (chunk.chunk_number < args.resumeFromChunk) {
        const resumed = await verifyCompletedCatchupChunk(sb, chunk, catchupId, perthCalendarDate());
        report.chunk_executions.push(resumed);
        writeReport(`royal-caribbean-catchup-chunk-${catchupId}-${chunk.chunk_number}.json`, resumed);
        continue;
      }

      const freshToday = perthCalendarDate();
      for (const entry of chunk.manifest.entries) {
        const days = entry.departure_date ? daysUntilDeparture(entry.departure_date, freshToday) : null;
        if (days != null && days <= 21) {
          throw new Error(`Chunk ${chunk.chunk_number} has sailing inside 21-day cutoff: ${entry.official_sailing_id}`);
        }
      }

      const indexes = await indexExistingRoyalCaribbeanRecords(sb, dryRunResult.line.id);
      let existingInChunk = 0;
      for (const entry of chunk.manifest.entries) {
        if (indexes.byProductKey.get(entry.official_sailing_id)) existingInChunk += 1;
      }
      if (existingInChunk > 0) {
        throw new Error(`Concurrency preflight failed for chunk ${chunk.chunk_number}: ${existingInChunk} IDs exist`);
      }

      const countBefore = await countGenuineRoyalCaribbeanSailings(sb);
      const writeResult = await applyRoyalCaribbeanBatchWrites({
        mode: "final_catchup",
        chunkManifest: chunk.manifest,
        masterManifest,
        cruiseLine: dryRunResult.line,
        supabase: sb,
        runId: `${catchupId}-chunk-${chunk.chunk_number}`,
        expectedHash: chunk.manifest_hash,
        expectedCount: chunk.record_count,
        confirmToken: CATCHUP_CONFIRM_TOKEN,
        performWrites: true
      });

      const countAfter = await countGenuineRoyalCaribbeanSailings(sb);
      const rows = await fetchRoyalCaribbeanRowsByIds(sb, writeResult.stats.inserted_ids);
      const verification = verifyManifestRowsAgainstProduction(chunk.manifest, rows, freshToday, {
        skip45DayBuffer: true
      });

      const chunkReport = {
        chunk_number: chunk.chunk_number,
        chunk_hash: chunk.manifest_hash,
        master_manifest_hash: masterManifest.manifest_hash,
        intended_count: chunk.record_count,
        attempted: writeResult.stats.attempted,
        successful: writeResult.stats.inserted,
        failed: writeResult.stats.failed,
        inserted_ids: writeResult.stats.inserted_ids,
        production_count_before: countBefore.genuine_sailing_count,
        production_count_after: countAfter.genuine_sailing_count,
        field_mismatch_count: verification.issues?.length || 0,
        verification_issues: verification.issues?.slice(0, 10) || [],
        chunk_post_write_verification_ok: verification.ok,
        completed_at: new Date().toISOString()
      };
      report.chunk_executions.push(chunkReport);
      writeReport(`royal-caribbean-catchup-chunk-${catchupId}-${chunk.chunk_number}.json`, chunkReport);

      if (!verification.ok || writeResult.stats.inserted !== chunk.record_count || writeResult.stats.failed > 0) {
        throw new Error(`Chunk ${chunk.chunk_number} failed verification or insert count`);
      }
      if (countAfter.genuine_sailing_count - countBefore.genuine_sailing_count !== writeResult.stats.inserted) {
        throw new Error(`Chunk ${chunk.chunk_number} production count delta mismatch`);
      }
    }
  }

  report.genuine_sailing_count_after = await countGenuineRoyalCaribbeanSailings(sb);

  if ((args.verify || args.full) && masterManifest) {
    const sailingIds = masterManifest.entries.map((e) => e.official_sailing_id);
    const rows = await fetchRoyalCaribbeanRowsBySailingIds(sb, sailingIds);
    const masterVerification = verifyManifestRowsAgainstProduction(masterManifest, rows, perthCalendarDate(), {
      skip45DayBuffer: true
    });
    report.master_manifest_post_write_verification_ok = masterVerification.ok;
    report.master_post_write_verification = masterVerification;
    if (!masterVerification.ok) throw new Error("Master manifest post-write verification failed");
  }

  if (args.postDryRun || args.full) {
    const postDry = await runFreshDryRun(sb, perthCalendarDate());
    const postSnapshot = buildDryRunSnapshotSummary(postDry.simulation, postDry.manifest, postDry.arithmetic);
    if (!preWriteSnapshot && masterManifest) {
      preWriteSnapshot = {
        source_snapshot_id: masterManifest.source_snapshot_id,
        unique_sailings: null,
        outstanding_eligible: masterManifest.entries.length,
        reconciliation_arithmetic_ok: true
      };
    }
    report.final_reconciliation = {
      source_snapshot_id: postSnapshot.source_snapshot_id,
      recognised_existing_eligible: postSnapshot.recognised_existing,
      live_outstanding_eligible_inserts: postSnapshot.outstanding_eligible,
      proposed_updates: postDry.manifest.products.filter((p) => p.proposed_action === "update_exact_legacy_match").length,
      incomplete_skipped: postDry.manifest.products.filter((p) => p.proposed_action === "incomplete_skip").length,
      cutoff_skipped: postDry.manifest.products.filter((p) => p.proposed_action === "within_21_day_cutoff_skip").length,
      cruisetour_skipped: postDry.manifest.products.filter((p) => p.proposed_action === "ocean_cruisetour_skip").length,
      reconciliation_arithmetic_ok: postDry.arithmetic.reconciliation_arithmetic_ok
    };
    report.source_drift = compareCatchupSourceSnapshots(preWriteSnapshot, {
      ...postSnapshot,
      post_manifest_new_eligible: postSnapshot.outstanding_eligible
    });
    report.catchup_completion = {
      master_manifest_record_count: masterManifest?.entries?.length || 0,
      master_manifest_successful_inserts: report.chunk_executions.reduce((s, c) => s + (c.successful || 0), 0),
      master_manifest_remaining: Math.max(
        0,
        (masterManifest?.entries?.length || 0) -
          report.chunk_executions.reduce((s, c) => s + (c.successful || 0), 0)
      ),
      live_outstanding_eligible: postSnapshot.outstanding_eligible,
      note: "live_outstanding may exceed zero due to post-manifest source additions"
    };
  }

  const totalInserted = report.chunk_executions.reduce((s, c) => s + (c.successful || 0), 0);
  const allChunksVerified = report.chunk_executions.every((c) => c.chunk_post_write_verification_ok === true);
  const allOk =
    report.master_manifest_post_write_verification_ok === true &&
    allChunksVerified &&
    totalInserted === (masterManifest?.entries?.length || 0) &&
    report.pagination_consistency?.source_pagination_consistency_ok === true;
  report.recommendation = allOk ? "READY FOR WEEKLY AUTOMATION VALIDATION" : "STOP — FINAL CATCH-UP ISSUE";
  report.completed_at = new Date().toISOString();
  const reportPath = writeReport(`royal-caribbean-prompt6-final-catchup-${catchupId}.json`, report);
  console.log(JSON.stringify({ ok: allOk, report: reportPath, recommendation: report.recommendation }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
