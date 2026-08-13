#!/usr/bin/env node
/**
 * Royal Caribbean International — first controlled production batch (exactly 20 cruises).
 *
 *   node scripts/run-royal-caribbean-first-controlled-batch.mjs --preflight
 *   node scripts/run-royal-caribbean-first-controlled-batch.mjs --dry-run
 *   node scripts/run-royal-caribbean-first-controlled-batch.mjs --manifest
 *   ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED=true node scripts/run-royal-caribbean-first-controlled-batch.mjs --apply --confirm=ROYAL-CARIBBEAN-FIRST-CONTROLLED-BATCH --manifest-path=reports/...
 *   node scripts/run-royal-caribbean-first-controlled-batch.mjs --full --dry-run-only
 *   ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED=true node scripts/run-royal-caribbean-first-controlled-batch.mjs --full --apply --confirm=ROYAL-CARIBBEAN-FIRST-CONTROLLED-BATCH
 *
 * Hard limit: MAX 20 inserts. No --limit above 20. No unbounded apply.
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

const {
  createMaintenanceSupabase,
  getSupabaseConfig
} = require(path.join(root, "scripts/lib/supabase-rest.cjs"));
const {
  simulateRoyalCaribbeanInventory,
  catalogueDestinations,
  LINE_SLUG
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-adapter"));
const {
  buildRoyalCaribbeanBatchManifest,
  indexExistingRoyalCaribbeanRecords,
  applyRoyalCaribbeanBatchWrites
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-writes"));
const {
  MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
  RC_LINE_ID,
  selectControlledBatchProducts,
  buildFrozenManifest,
  computeManifestHash,
  computeSourceSnapshotId,
  validateFrozenManifest,
  validateManifestAgainstProduction,
  evaluatePreWriteDryRunGate,
  buildRoyalCaribbeanReconciliationArithmetic,
  evaluateRoyalCaribbeanDryRunHealth
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-controlled-batch"));
const {
  resolveRoyalCaribbeanDiscoveryMode,
  assertRoyalCaribbeanWritesAllowed,
  ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-mode"));
const {
  countGenuineRoyalCaribbeanSailings,
  fetchRoyalCaribbeanRowsByIds,
  verifyManifestRowsAgainstProduction
} = require(path.join(root, "netlify/functions/lib/royal-caribbean-post-write-verification"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { isRoyalCaribbeanWeeklyReconciliationEnabled } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance"
));

const REPORT_DIR = path.join(root, "reports");
const APPLY_CONFIRMATION = "ROYAL-CARIBBEAN-FIRST-CONTROLLED-BATCH";
const PROMPT3_SHA = "d3cd4ca960cac7f401340f15a2b0dd746249e053";

function parseArgs(argv) {
  const args = {
    preflight: false,
    dryRun: false,
    manifest: false,
    apply: false,
    verify: false,
    idempotency: false,
    postDryRun: false,
    full: false,
    dryRunOnly: false,
    confirm: null,
    manifestPath: null,
    batchId: null
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--manifest") args.manifest = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--idempotency") args.idempotency = true;
    if (arg === "--post-dry-run") args.postDryRun = true;
    if (arg === "--full") args.full = true;
    if (arg === "--dry-run-only") args.dryRunOnly = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--manifest-path=")) args.manifestPath = path.resolve(arg.split("=")[1]);
    if (arg.startsWith("--manifest=")) args.manifestPath = path.resolve(arg.split("=")[1]);
    if (arg.startsWith("--batch-id=")) args.batchId = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--limit=")) {
      throw new Error("Royal Caribbean controlled batch rejects --limit. Hard maximum is 20.");
    }
  }
  if (args.full) {
    args.preflight = true;
    args.dryRun = true;
    args.manifest = true;
    if (!args.dryRunOnly) {
      args.apply = true;
      args.verify = true;
      args.postDryRun = true;
      args.idempotency = true;
    }
  }
  if (!Object.values(args).some((v) => v === true) && !args.manifestPath && !args.confirm) {
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

async function verifyPrompt3Metadata(sb) {
  const heroRows = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${encodeURIComponent(
      RC_LINE_ID
    )}&name=eq.${encodeURIComponent("Hero of the Seas")}&select=id,name,official_line_ship_id,active,status&limit=5`
  );
  const heroExact = (heroRows || []).filter((r) => r.name === "Hero of the Seas");
  const colonResolve = require(path.join(root, "netlify/functions/lib/royal-caribbean-discovery-adapter"));
  const { resolveRawPortText, resetPortsCache } = require(path.join(
    root,
    "netlify/functions/lib/discovery-departure-port"
  ));
  resetPortsCache();
  const colon = resolveRawPortText("Colón", { sourceField: "royal_caribbean_graphql" });
  const colonAscii = resolveRawPortText("Colon", { sourceField: "royal_caribbean_graphql" });
  const colonCode = colonResolve.classifyItineraryStop({ name: "Colón", code: "ONX" });
  return {
    hero: {
      count: heroExact.length,
      ok: heroExact.length === 1 && heroExact[0].official_line_ship_id === "HE" && heroExact[0].active !== false,
      record: heroExact[0] || null
    },
    colon: {
      ok:
        colon.status === "resolved" &&
        colonAscii.status === "resolved" &&
        colon.canonicalPortName === colonAscii.canonicalPortName &&
        colonCode.classification === "alias_resolved",
      colon,
      colonAscii,
      colonCode
    }
  };
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
    runId: `rc-prompt4-prewrite-${Date.now()}`
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

function buildManifestFromDryRun(dryRunResult, batchId) {
  const { line, destinations, simulation, today } = dryRunResult;
  const indexes = dryRunResult.indexes;
  const selection = selectControlledBatchProducts(simulation.products, {
    maxWrites: MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
    today
  });
  if (selection.selected.length < MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH) {
    throw new Error(
      `Insufficient eligible candidates for 20-cruise batch: ${selection.selected.length} available`
    );
  }
  const sourceSnapshotId = computeSourceSnapshotId(simulation);
  const manifest = buildFrozenManifest({
    selected: selection.selected.slice(0, MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH),
    cruiseLine: line,
    destinations,
    batchId,
    sourceSnapshotId,
    sourceFetchedAt: new Date().toISOString(),
    today
  });
  return { manifest, selection, sourceSnapshotId };
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const batchId =
    args.batchId ||
    `royal-caribbean-batch1-${startedAt.replace(/[:.]/g, "-").slice(0, 19)}`;
  const report = {
    phase: "royal_caribbean_prompt4_controlled_batch",
    started_at: startedAt,
    batch_id: batchId,
    max_batch_size: MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH
  };

  report.repository_checkpoint = {
    branch: git("git branch --show-current"),
    head: git("git rev-parse HEAD"),
    origin_main: git("git rev-parse origin/main"),
    local_main: git("git rev-parse main"),
    prompt3_sha: PROMPT3_SHA,
    status_sample: git("git status --short").split("\n").slice(0, 15)
  };

  if (args.preflight || args.dryRun || args.manifest || args.apply || args.full) {
    if (isRoyalCaribbeanWeeklyReconciliationEnabled()) {
      throw new Error("ROYAL_CARIBBEAN_WEEKLY_RECONCILIATION_ENABLED must remain false");
    }
    if (!args.apply && ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED) {
      throw new Error("ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED must be false unless --apply");
    }
    const prevWriteFlag = process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED;
    delete process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED;
    try {
      const testOut = execSync("node scripts/test-royal-caribbean-discovery.mjs", {
        cwd: root,
        encoding: "utf8"
      });
      const passed = (testOut.match(/(\d+) passed/) || [])[1];
      report.tests_preflight = { command: "node scripts/test-royal-caribbean-discovery.mjs", passed: Number(passed) };
      const batchOut = execSync("node scripts/test-royal-caribbean-controlled-batch.mjs", {
        cwd: root,
        encoding: "utf8"
      });
      const batchPassed = (batchOut.match(/(\d+) passed/) || [])[1];
      report.tests_preflight.controlled_batch_passed = Number(batchPassed);
    } catch (error) {
      throw new Error(`Royal Caribbean tests failed: ${error.message}`);
    } finally {
      if (prevWriteFlag) process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED = prevWriteFlag;
    }
  }

  const sb = createMaintenanceSupabase(root);
  const today = perthCalendarDate();

  if (args.preflight || args.manifest || args.dryRun || args.apply || args.full) {
    report.metadata_verification = await verifyPrompt3Metadata(sb);
    if (!report.metadata_verification.hero.ok || !report.metadata_verification.colon.ok) {
      throw new Error("Prompt 3 metadata verification failed");
    }
  }

  let dryRunResult = null;
  if (args.dryRun || args.manifest || args.apply || args.full) {
    dryRunResult = await runFreshDryRun(sb, today);
    report.pre_write_dry_run = {
      unique_sailings: dryRunResult.simulation.products?.length,
      ordinary_ocean: dryRunResult.simulation.classification?.ordinary_ocean_cruises,
      cruisetours_excluded: dryRunResult.simulation.classification?.ocean_cruisetours_excluded,
      within_21_day: dryRunResult.simulation.time_eligibility?.within_21_day_cutoff,
      adapter_incomplete: dryRunResult.simulation.products?.filter(
        (p) => p.product_type === "ocean_cruise" && p.ocean_bucket === "incomplete"
      ).length,
      proposed_inserts: dryRunResult.manifest.products.filter((p) => p.proposed_action === "insert_active").length,
      reconciliation_arithmetic_ok: dryRunResult.arithmetic.reconciliation_arithmetic_ok,
      dry_run_health: dryRunResult.health,
      ship_audit: {
        total: dryRunResult.simulation.ship_audit?.total_source_ships,
        resolved: dryRunResult.simulation.ship_audit?.resolved,
        unresolved: dryRunResult.simulation.ship_audit?.unresolved
      },
      unresolved_embarkation_ports: (dryRunResult.simulation.port_audit?.unresolved_conventional || []).filter(
        (r) => r.role === "embarkation"
      )
    };
    if (!dryRunResult.health.passed || !dryRunResult.arithmetic.reconciliation_arithmetic_ok) {
      throw new Error("Pre-write dry-run gates failed");
    }
    if (report.pre_write_dry_run.unresolved_embarkation_ports?.length) {
      throw new Error("Unresolved embarkation ports block controlled batch");
    }
    if (dryRunResult.simulation.ship_audit?.unresolved > 0) {
      throw new Error("Unresolved ships block controlled batch");
    }
  }

  let manifest = null;
  if (args.manifestPath) {
    manifest = JSON.parse(fs.readFileSync(args.manifestPath, "utf8"));
    report.manifest_path = args.manifestPath;
  } else if (args.manifest || args.apply || args.full) {
    dryRunResult.indexes = await indexExistingRoyalCaribbeanRecords(sb, dryRunResult.line.id);
    const built = buildManifestFromDryRun(dryRunResult, batchId);
    manifest = built.manifest;
    report.batch_selection = {
      eligible_pool_size: built.selection.eligible_pool_size,
      composition: built.selection.composition,
      official_sailing_ids: manifest.entries.map((e) => e.official_sailing_id),
      departure_range: {
        earliest: manifest.entries.map((e) => e.departure_date).sort()[0],
        latest: manifest.entries.map((e) => e.departure_date).sort().slice(-1)[0]
      }
    };
    const manifestPath = writeReport(`royal-caribbean-controlled-batch-manifest-${batchId}.json`, manifest);
    report.frozen_manifest = {
      path: manifestPath,
      manifest_hash: manifest.manifest_hash,
      source_snapshot_id: manifest.source_snapshot_id,
      record_count: manifest.entries.length
    };
  }

  if (manifest && (args.manifest || args.apply || args.full)) {
    dryRunResult = dryRunResult || (await runFreshDryRun(sb, today));
    const preWriteGate = evaluatePreWriteDryRunGate({
      simulation: dryRunResult.simulation,
      manifest,
      arithmetic: dryRunResult.arithmetic,
      health: dryRunResult.health
    });
    const indexes = await indexExistingRoyalCaribbeanRecords(sb, dryRunResult.line.id);
    const prodValidation = await validateManifestAgainstProduction(manifest, indexes);
    const manifestValidation = validateFrozenManifest(manifest, { expectedHash: manifest.manifest_hash, today });
    report.pre_write_gates = {
      ...manifestValidation.gates,
      existing_official_sailing_ids_0: prodValidation.existing_official_sailing_ids === 0,
      dry_run_gate: preWriteGate.passed,
      production_manifest_gate: prodValidation.passed
    };
    if (!manifestValidation.passed || !prodValidation.passed || !preWriteGate.passed) {
      throw new Error(
        `Pre-write manifest validation failed: ${[...manifestValidation.failures, ...prodValidation.failures, ...preWriteGate.failures].join("; ")}`
      );
    }
  }

  report.genuine_sailing_count_before = await countGenuineRoyalCaribbeanSailings(sb);

  if (args.apply || args.full) {
    if (String(process.env.ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
      throw new Error("ROYAL_CARIBBEAN_DISCOVERY_WRITE_ENABLED=true required for --apply");
    }
    if (args.confirm !== APPLY_CONFIRMATION) {
      throw new Error(`--confirm=${APPLY_CONFIRMATION} required for --apply`);
    }
    const modeGate = resolveRoyalCaribbeanDiscoveryMode("controlled_batch");
    assertRoyalCaribbeanWritesAllowed(modeGate);

    const writeResult = await applyRoyalCaribbeanBatchWrites({
      mode: "controlled_batch",
      manifest,
      cruiseLine: dryRunResult.line,
      supabase: sb,
      runId: batchId,
      expectedHash: manifest.manifest_hash,
      expectedCount: MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
      maxWrites: MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
      performWrites: true
    });

    report.controlled_apply = {
      attempted: writeResult.stats.attempted,
      successful_inserts: writeResult.stats.inserted,
      failed_inserts: writeResult.stats.failed,
      duplicate_skips: writeResult.stats.duplicate_skips,
      stopped_early: writeResult.stats.stopped_early,
      inserted_ids: writeResult.stats.inserted_ids,
      write_details: writeResult.stats.write_details
    };

    manifest.writes_performed = true;
    manifest.actual_writes = writeResult.stats.inserted;
    writeReport(`royal-caribbean-controlled-batch-apply-${batchId}.json`, {
      batch_id: batchId,
      manifest_hash: manifest.manifest_hash,
      apply: report.controlled_apply,
      generated_at: new Date().toISOString()
    });

    if (writeResult.stats.inserted !== MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH) {
      throw new Error(`Expected exactly ${MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH} inserts, got ${writeResult.stats.inserted}`);
    }
  }

  if ((args.verify || args.full) && manifest) {
    const rows = await fetchRoyalCaribbeanRowsByIds(sb, report.controlled_apply?.inserted_ids || []);
    const verification = verifyManifestRowsAgainstProduction(manifest, rows, today);
    report.post_write_verification_ok = verification.ok;
    report.post_write_verification = verification;
    report.production_records = rows.map((row) => ({
      official_sailing_id: row.official_sailing_id,
      db_record_id: row.id,
      ship_id: row.ship_id,
      departure_date: row.departure_date,
      nights: row.nights,
      departure_port: row.departure_port,
      destination_id: row.destination_id,
      external_key: row.external_key,
      identity_key: row.identity_key
    }));
    if (!verification.ok) throw new Error("Post-write verification failed");
  }

  report.genuine_sailing_count_after = await countGenuineRoyalCaribbeanSailings(sb);

  if (args.postDryRun || args.full) {
    const postDry = await runFreshDryRun(sb, today);
    report.post_write_dry_run = {
      recognised_existing_eligible: postDry.manifest.products.filter((p) =>
        ["duplicate_skip", "update_exact_legacy_match"].includes(p.proposed_action)
      ).length,
      outstanding_eligible_inserts: postDry.manifest.products.filter((p) => p.proposed_action === "insert_active")
        .length,
      proposed_updates: postDry.manifest.products.filter((p) => p.proposed_action === "update_exact_legacy_match")
        .length,
      incomplete_skipped: postDry.manifest.products.filter((p) => p.proposed_action === "incomplete_skip").length,
      cutoff_skipped: postDry.manifest.products.filter((p) => p.proposed_action === "within_21_day_cutoff_skip")
        .length,
      cruisetour_skipped: postDry.manifest.products.filter((p) => p.proposed_action === "ocean_cruisetour_skip").length,
      reconciliation_arithmetic_ok: postDry.arithmetic.reconciliation_arithmetic_ok,
      duplicate_skips: postDry.manifest.products.filter((p) => p.proposed_action === "duplicate_skip").length
    };
    writeReport(`royal-caribbean-prompt4-postwrite-dry-run.json`, {
      generated_at: new Date().toISOString(),
      summary: report.post_write_dry_run,
      reconciliation_arithmetic: postDry.arithmetic
    });
  }

  if (args.idempotency || args.full) {
    const indexes = await indexExistingRoyalCaribbeanRecords(sb, dryRunResult.line.id);
    const replayValidation = await validateManifestAgainstProduction(manifest, indexes);
    const idempotentApply = await applyRoyalCaribbeanBatchWrites({
      mode: "controlled_batch",
      manifest,
      cruiseLine: dryRunResult.line,
      supabase: sb,
      runId: `${batchId}-idempotency-check`,
      expectedHash: manifest.manifest_hash,
      expectedCount: MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
      maxWrites: MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH,
      performWrites: false
    });
    report.idempotency_proof = {
      manifest_existing_check_passed: !replayValidation.passed,
      existing_official_sailing_ids: replayValidation.existing_official_sailing_ids,
      dry_replay_would_insert: idempotentApply.stats.inserted,
      dry_replay_duplicate_aborts: idempotentApply.stats.duplicate_skips,
      all_20_recognised: replayValidation.existing_official_sailing_ids === MAX_CONTROLLED_ROYAL_CARIBBEAN_BATCH
    };
  }

  report.completed_at = new Date().toISOString();
  report.recommendation = report.post_write_verification_ok === true ? "READY FOR NEXT CONTROLLED BATCH" : null;
  const reportPath = writeReport(`royal-caribbean-prompt4-controlled-batch-${batchId}.json`, report);
  console.log(JSON.stringify({ ok: true, report: reportPath, recommendation: report.recommendation }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
