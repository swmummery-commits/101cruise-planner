#!/usr/bin/env node
/**
 * Carnival Cruise Line — first controlled production batch (exactly 20 official sailings).
 *
 *   node scripts/run-carnival-first-controlled-batch.mjs --preflight
 *   node scripts/run-carnival-first-controlled-batch.mjs --dry-run
 *   node scripts/run-carnival-first-controlled-batch.mjs --manifest
 *   CARNIVAL_DISCOVERY_WRITE_ENABLED=true node scripts/run-carnival-first-controlled-batch.mjs --apply --confirm=CARNIVAL-FIRST-CONTROLLED-BATCH --manifest-path=reports/...
 *   node scripts/run-carnival-first-controlled-batch.mjs --verify --manifest-path=reports/...
 *   node scripts/run-carnival-first-controlled-batch.mjs --idempotency --manifest-path=reports/...
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

const { createMaintenanceSupabase, exactCountSupabase, getSupabaseConfig } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const adapter = require(path.join(root, "netlify/functions/lib/carnival-discovery-adapter"));
const {
  CCL_LINE_SLUG,
  MAX_CONTROLLED_CCL_BATCH,
  APPLY_CONFIRMATION,
  selectControlledBatchProducts,
  buildFrozenManifest,
  validateFrozenManifest,
  revalidateManifestAgainstSource,
  evaluatePreApplyQualityGate
} = require(path.join(root, "netlify/functions/lib/carnival-controlled-batch"));
const {
  buildCclBatchManifest,
  evaluatePreflightWritePlan,
  applyCclBatchWrites,
  indexExistingCclRecords,
  isLegacyGenericCclRow,
  isOfficialCclStructuredRecord
} = require(path.join(root, "netlify/functions/lib/carnival-discovery-writes"));
const {
  resolveCarnivalDiscoveryMode,
  assertCarnivalWritesAllowed
} = require(path.join(root, "netlify/functions/lib/carnival-discovery-mode"));
const {
  countOfficialCclRows,
  fetchCclRowsBySailingIds,
  verifyManifestRowsAgainstProduction,
  verifyPublicInventoryEligibility,
  indexCclProductionRecords
} = require(path.join(root, "netlify/functions/lib/carnival-post-write-verification"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { officialSailingId } = require(path.join(root, "netlify/functions/lib/carnival-discovery-adapter"));

const REPORT_DIR = path.join(root, "reports");

function parseArgs(argv) {
  const args = {
    preflight: false,
    dryRun: false,
    manifest: false,
    apply: false,
    verify: false,
    idempotency: false,
    confirm: null,
    manifestPath: null
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--manifest") args.manifest = true;
    if (arg === "--apply") args.apply = true;
    if (arg === "--verify") args.verify = true;
    if (arg === "--idempotency") args.idempotency = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--manifest-path=")) args.manifestPath = path.resolve(arg.split("=")[1]);
    if (arg.startsWith("--manifest=")) args.manifestPath = path.resolve(arg.split("=")[1]);
    if (arg.startsWith("--batch-size=") || arg.startsWith("--limit=")) {
      throw new Error("Carnival first controlled batch rejects custom limits. Hard maximum is 20.");
    }
  }
  if (!args.apply && !args.verify && !args.idempotency) {
    if (!Object.values(args).some((v) => v === true)) args.preflight = true;
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
    destinations: adapter.catalogueDestinations(destRows || [])
  };
}

async function runLiveSimulation(sb, today) {
  adapter.clearCclFetchCache();
  require(path.join(root, "netlify/functions/lib/carnival-discovery-source")).clearCarnivalFetchCache();
  const ctx = await loadLineContext(sb);
  const simulation = await adapter.simulateCclDiscovery({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    shipAliases: ctx.shipAliases,
    destinations: ctx.destinations,
    today
  });
  return { ...ctx, simulation, today };
}

async function auditLegacyRows(sb, lineId) {
  const indexed = await indexExistingCclRecords(sb, lineId);
  const legacyDetails = (indexed.legacyRows || []).map((row) => ({
    id: row.id,
    status: row.status,
    ship_id: row.ship_id,
    departure_date: row.departure_date,
    departure_port: row.departure_port,
    destination_id: row.destination_id,
    official_sailing_id: row.official_sailing_id,
    structured_source: row.raw_extract?.structured_source || null,
    official_url: row.official_url || null,
    legacy: isLegacyGenericCclRow(row),
    official: isOfficialCclStructuredRecord(row)
  }));

  const publicLegacy = legacyDetails.filter((row) => row.status === "active");
  const conflictingOfficialIds = legacyDetails.filter((row) => row.official_sailing_id);

  return {
    legacy_count: legacyDetails.length,
    legacy_rows: legacyDetails,
    public_legacy_rows: publicLegacy.length,
    legacy_with_official_sailing_id: conflictingOfficialIds.length,
    stop_required: publicLegacy.length > 0 || conflictingOfficialIds.length > 0,
    official_existing_count: indexed.officialBySailingId.size
  };
}

async function buildSelectionManifest(sb, today, codeSha) {
  const live = await runLiveSimulation(sb, today);
  const qualityGate = evaluatePreApplyQualityGate(live.simulation);
  if (!qualityGate.ok) {
    const err = new Error(`Quality gate failed before batch selection: ${qualityGate.failures.join(", ")}`);
    err.code = "quality_gate_failed";
    err.qualityGate = qualityGate;
    throw err;
  }

  const officialExisting = await indexExistingCclRecords(sb, live.line.id);
  const exclude = new Set([...officialExisting.officialBySailingId.keys()]);
  const selection = selectControlledBatchProducts(live.simulation.products, {
    maxWrites: MAX_CONTROLLED_CCL_BATCH,
    today,
    excludeSailingIds: exclude
  });

  if (selection.selected.length < MAX_CONTROLLED_CCL_BATCH) {
    throw new Error(
      `Insufficient eligible new official candidates: ${selection.selected.length} available, ${MAX_CONTROLLED_CCL_BATCH} required`
    );
  }

  const batchManifest = await buildCclBatchManifest({
    products: live.simulation.products,
    cruiseLine: live.line,
    supabase: sb,
    selectedOnly: selection.selected.slice(0, MAX_CONTROLLED_CCL_BATCH)
  });
  const writePlan = evaluatePreflightWritePlan(batchManifest.entries, { maxWrites: MAX_CONTROLLED_CCL_BATCH });
  if (!writePlan.ok) {
    throw new Error(`Preflight write plan blocked: ${writePlan.failures.join(", ")}`);
  }

  const runId = `ccl-first-controlled-batch-${today.replace(/-/g, "")}`;
  const frozen = buildFrozenManifest({
    selected: selection.selected,
    cruiseLine: live.line,
    entries: batchManifest.entries,
    runId,
    codeSha,
    today
  });
  const validation = validateFrozenManifest(frozen, { expectedCount: MAX_CONTROLLED_CCL_BATCH });
  if (!validation.ok) {
    throw new Error(`Frozen manifest invalid: ${validation.failures.join(", ")}`);
  }

  return {
    live,
    selection,
    batchManifest,
    writePlan,
    frozen,
    qualityGate
  };
}

function loadManifestFromPath(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

async function revalidatePinnedManifest(sb, manifest, today) {
  const live = await runLiveSimulation(sb, today);
  const bySailingId = new Map(
    (live.simulation.products || [])
      .filter((row) => officialSailingId(row.raw))
      .map((row) => [officialSailingId(row.raw), row])
  );
  const qualityGate = evaluatePreApplyQualityGate(live.simulation);
  const sourceCheck = revalidateManifestAgainstSource(manifest, bySailingId);
  const validation = validateFrozenManifest(manifest, { expectedCount: MAX_CONTROLLED_CCL_BATCH });
  return { live, qualityGate, sourceCheck, validation };
}

async function main() {
  getSupabaseConfig(root);
  const args = parseArgs(process.argv);
  const today = perthCalendarDate();
  const sb = createMaintenanceSupabase(root);
  const codeSha = git("git rev-parse HEAD");
  const ctx = await loadLineContext(sb);
  const legacyAudit = await auditLegacyRows(sb, ctx.line.id);

  if (legacyAudit.stop_required) {
    throw new Error("Legacy Carnival rows require review before controlled batch (public or conflicting official IDs)");
  }

  if (args.preflight || args.dryRun || args.manifest) {
    const built = await buildSelectionManifest(sb, today, codeSha);
    const report = {
      phase: args.manifest ? "manifest" : args.dryRun ? "dry_run" : "preflight",
      code_sha: codeSha,
      today,
      legacy_audit: legacyAudit,
      quality_gate: built.qualityGate,
      source: {
        raw_groups: built.live.simulation.fetch_result?.raw_group_count,
        unique_groups: built.live.simulation.fetch_result?.unique_group_count,
        unique_sailings: built.live.simulation.products?.length,
        cutoff_eligible: built.live.simulation.readiness_funnel?.cutoff_eligible,
        quality_gate_metrics: built.live.simulation.quality_gate_metrics
      },
      write_plan: built.writePlan,
      selected_batch: built.frozen.entries.map((entry, index) => ({
        n: index + 1,
        sailing_id: entry.official_sailing_id,
        itinerary: entry.itinerary_code,
        ship_code: entry.ship_code,
        departure: entry.departure_date,
        nights: entry.nights,
        port: entry.departure_port,
        destination_id: entry.destination_id,
        action: entry.proposed_action
      })),
      manifest_path: null
    };

    if (args.manifest || args.dryRun) {
      report.manifest_path = writeReport(
        `carnival-first-controlled-batch-manifest-${today}-${Date.now()}.json`,
        built.frozen
      );
    }

    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args.apply) {
    assertCarnivalWritesAllowed(resolveCarnivalDiscoveryMode("controlled_batch"));
    if (args.confirm !== APPLY_CONFIRMATION) {
      throw new Error(`--confirm=${APPLY_CONFIRMATION} is required`);
    }
    const manifest = loadManifestFromPath(args.manifestPath);
    const revalidated = await revalidatePinnedManifest(sb, manifest, today);
    if (!revalidated.qualityGate.ok) {
      throw new Error(`Quality gate failed before apply: ${revalidated.qualityGate.failures.join(", ")}`);
    }
    if (!revalidated.validation.ok) {
      throw new Error(`Manifest validation failed: ${revalidated.validation.failures.join(", ")}`);
    }
    if (!revalidated.sourceCheck.ok) {
      throw new Error(`Pinned source revalidation failed: ${JSON.stringify(revalidated.sourceCheck.failures)}`);
    }

    const countsBefore = await countOfficialCclRows(sb);
    const runId = manifest.run_id || `ccl-first-controlled-batch-apply-${Date.now()}`;
    const writeResult = await applyCclBatchWrites({
      manifest,
      cruiseLine: ctx.line,
      maxWrites: MAX_CONTROLLED_CCL_BATCH,
      runId,
      supabase: sb,
      performWrites: true,
      expectedHash: manifest.manifest_hash
    });
    const countsAfter = await countOfficialCclRows(sb);
    const rows = await fetchCclRowsBySailingIds(
      sb,
      manifest.entries.map((entry) => entry.official_sailing_id)
    );
    const readback = verifyManifestRowsAgainstProduction(manifest, rows, today);
    const publicCheck = verifyPublicInventoryEligibility(rows, today);

    const applyReport = {
      phase: "apply",
      code_sha: codeSha,
      manifest_path: args.manifestPath,
      manifest_hash: manifest.manifest_hash,
      counts_before: countsBefore,
      counts_after: countsAfter,
      write_result: writeResult.stats,
      readback,
      public_inventory: publicCheck,
      legacy_audit_after: await auditLegacyRows(sb, ctx.line.id),
      rollback_manifest_path: writeReport(`carnival-first-controlled-batch-rollback-${runId}.json`, {
        run_id: runId,
        code_sha: codeSha,
        manifest_hash: manifest.manifest_hash,
        before_counts: countsBefore,
        write_details: writeResult.stats.write_details
      })
    };

    applyReport.report_path = writeReport(`carnival-first-controlled-batch-apply-${runId}.json`, applyReport);
    console.log(JSON.stringify(applyReport, null, 2));
    if (!readback.ok || writeResult.stats.failed > 0) process.exit(1);
    return;
  }

  if (args.verify || args.idempotency) {
    const manifest = loadManifestFromPath(args.manifestPath);
    const rows = await fetchCclRowsBySailingIds(
      sb,
      manifest.entries.map((entry) => entry.official_sailing_id)
    );
    const readback = verifyManifestRowsAgainstProduction(manifest, rows, today);
    const publicCheck = verifyPublicInventoryEligibility(rows, today);
    const counts = await countOfficialCclRows(sb);

    let idempotency = null;
    if (args.idempotency) {
      const indexes = await indexExistingCclRecords(sb, ctx.line.id);
      const pinnedIds = manifest.pinned_official_sailing_ids || manifest.entries.map((e) => e.official_sailing_id);
      const missingInDb = pinnedIds.filter((id) => !indexes.officialBySailingId.has(String(id)));
      const built = await buildSelectionManifest(sb, today, codeSha);
      idempotency = {
        pinned_manifest_ids: pinnedIds,
        missing_official_rows_in_db: missingInDb,
        fresh_selection_overlap_with_pinned: built.frozen.entries.filter((entry) =>
          pinnedIds.includes(entry.official_sailing_id)
        ).length,
        fresh_selection_first_id: built.frozen.entries[0]?.official_sailing_id || null,
        fresh_selection_inserts: built.writePlan.inserts,
        ok:
          missingInDb.length === 0 &&
          built.frozen.entries.filter((entry) => pinnedIds.includes(entry.official_sailing_id)).length === 0 &&
          built.writePlan.inserts === MAX_CONTROLLED_CCL_BATCH
      };
    }

    const report = {
      phase: args.idempotency ? "idempotency" : "verify",
      counts,
      readback,
      public_inventory: publicCheck,
      idempotency,
      legacy_audit: await auditLegacyRows(sb, ctx.line.id)
    };
    console.log(JSON.stringify(report, null, 2));
    if (!readback.ok || (idempotency && !idempotency.ok)) process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ status: "failed", error: err.message || String(err), code: err.code || null }, null, 2));
  process.exit(1);
});
