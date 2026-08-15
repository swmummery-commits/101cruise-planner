#!/usr/bin/env node
/**
 * Silversea Cruises — first controlled production batch (100 Classic sailings, insert-only).
 *
 *   node scripts/run-silversea-first-controlled-batch.mjs --preflight
 *   node scripts/run-silversea-first-controlled-batch.mjs --dry-run
 *   node scripts/run-silversea-first-controlled-batch.mjs --manifest
 *   SILVERSEA_DISCOVERY_WRITE_ENABLED=true node scripts/run-silversea-first-controlled-batch.mjs \
 *     --apply --confirm=SILVERSEA-FIRST-CONTROLLED-BATCH
 *
 * Hard limit: MAX 100 inserts. No automatic continuation. No weekly maintenance.
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

const { createMaintenanceSupabase, exactCountSupabase, getSupabaseConfig } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));
const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const { perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const {
  MAX_FIRST_CONTROLLED_BATCH,
  APPLY_CONFIRMATION_TOKEN,
  FIRST_BATCH_MODE,
  FIRST_BATCH_75_MODE,
  buildExclusiveClassificationFunnel,
  selectFirstBatchProducts,
  loadFrozenOfficialSailingIds,
  selectFrozenBatchProducts,
  summariseAdditionalEligibleIgnored,
  buildPreWriteTableRow,
  computeManifestHash,
  validateSelectedAgainstFreshSource,
  evaluatePreWriteGate,
  isClassic,
  isExpedition
} = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const {
  buildSilverseaBatchManifest,
  applySilverseaBatchWrites,
  indexExistingSilverseaRecords
} = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const {
  resolveSilverseaDiscoveryMode,
  assertSilverseaWritesAllowed
} = require(path.join(root, "netlify/functions/lib/silversea-discovery-mode"));
const { buildRollbackManifestFromWriteResult } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-manifests"
));

export const LINE_SLUG = adapter.LINE_SLUG;

export function parseArgs(argv = process.argv) {
  const args = {
    preflight: false,
    dryRun: false,
    manifest: false,
    apply: false,
    confirm: null,
    expectedCount: null,
    frozenReport: null
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--dry-run") args.dryRun = true;
    if (arg === "--manifest") args.manifest = true;
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--expected-count=")) args.expectedCount = Number(arg.split("=")[1]);
    if (arg.startsWith("--frozen-report=")) {
      args.frozenReport = path.resolve(String(arg.split("=")[1]).trim());
    }
    if (arg.startsWith("--limit=")) {
      throw new Error("Silversea controlled batch rejects --limit. Hard maximum is 100.");
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
  if (args.confirm !== APPLY_CONFIRMATION_TOKEN) {
    const err = new Error("silversea_apply_confirmation_required");
    err.code = "silversea_apply_confirmation_required";
    throw err;
  }
  if (String(process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    const err = new Error("SILVERSEA_DISCOVERY_WRITE_ENABLED must be true for apply");
    err.code = "silversea_discovery_write_disabled";
    throw err;
  }
}

async function countExistingOfficialIds(sb, cruiseLineId, officialIds) {
  if (!officialIds?.length) return { count: 0, rows: [] };
  const chunkSize = 50;
  const rows = [];
  for (let i = 0; i < officialIds.length; i += chunkSize) {
    const chunk = officialIds.slice(i, i + chunkSize);
    const quoted = chunk.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",");
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
        cruiseLineId
      )}&official_sailing_id=in.(${quoted})&select=id,official_sailing_id,status`
    );
    if (batch?.length) rows.push(...batch);
  }
  return { count: rows.length, rows };
}

function loadFrozenReport(reportPath) {
  if (!reportPath || !fs.existsSync(reportPath)) {
    const err = new Error(`frozen_report_not_found:${reportPath}`);
    err.code = "frozen_report_not_found";
    throw err;
  }
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
}

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

async function headLineCount(lineId, statusFilter = null) {
  let query = `cruise_line_id=eq.${encodeURIComponent(lineId)}`;
  if (statusFilter) query += `&status=eq.${statusFilter}`;
  const { count } = await exactCountSupabase(root, "discovered_cruises", query);
  return count;
}

async function headOtherLineCounts(sb) {
  const slugs = [
    "royal-caribbean-international",
    "celebrity-cruises",
    "princess-cruises",
    "seabourn-cruise-line",
    "norwegian-cruise-line"
  ];
  const out = {};
  for (const slug of slugs) {
    const line = (await sb(`ci_cruise_lines?slug=eq.${slug}&select=id&limit=1`))?.[0];
    if (!line?.id) continue;
    out[slug] = await headLineCount(line.id, "active");
  }
  return out;
}

async function loadContext(sb) {
  const line = (await sb(`ci_cruise_lines?slug=eq.${LINE_SLUG}&select=id,name,slug,website_url&limit=1`))?.[0];
  if (!line) throw new Error(`Cruise line not found: ${LINE_SLUG}`);
  const destRows = await loadClassificationDestinations(sb);
  const destinations = adapter.catalogueDestinations(destRows || []);
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const existing = await indexExistingSilverseaRecords(sb, line.id);
  return { line, destinations, ships: ships || [], existing };
}

function normaliseAll(rawProducts, context) {
  return (rawProducts || []).map((raw) => {
    const result = adapter.normaliseSilverseaProduct(raw, context);
    result.identity_class = adapter.classifyAgainstExisting(
      result,
      context.existingByOfficialId,
      context.existingRows
    );
    return result;
  });
}

function buildProductsByCode(normalised) {
  const map = new Map();
  for (const row of normalised) {
    if (row.official_sailing_id) map.set(String(row.official_sailing_id).toUpperCase(), row);
  }
  return map;
}

function summariseResolution(normalised) {
  const classic = normalised.filter((n) => isClassic(n.raw));
  return {
    classic_count: classic.length,
    expedition_count: normalised.filter((n) => isExpedition(n.raw)).length,
    classic_duration_mismatch: classic.filter((n) => n.raw?.duration_matches_dates !== true).length,
    classic_ship_unresolved: classic.filter((n) => !n.ship_resolution?.resolved).length,
    classic_embark_unresolved: classic.filter((n) => n.departure_port_resolution?.status !== "resolved").length,
    classic_disembark_unresolved: classic.filter((n) => n.arrival_port_resolution?.status !== "resolved").length,
    classic_destination_unresolved: classic.filter((n) => n.destination_resolution?.status !== "resolved").length,
    classic_itinerary_port_unresolved: classic.filter((n) => (n.itinerary_ports_unresolved || 0) > 0).length
  };
}

async function verifyInsertedRecords(sb, lineId, writeDetails, manifestProducts) {
  const insertedIds = (writeDetails || [])
    .filter((d) => d.created && d.discovered_cruise_id)
    .map((d) => d.discovered_cruise_id);
  if (!insertedIds.length) return { ok: false, reason: "no_inserted_ids", records: [] };

  const select =
    "id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,itinerary_ports,status,official_url,source_url,official_sailing_id,raw_extract";
  const rows = await sb(`discovered_cruises?id=in.(${insertedIds.join(",")})&select=${select}`);
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  const manifestById = new Map((manifestProducts || []).map((m) => [m.official_sailing_id, m]));

  const checks = [];
  let allOk = true;
  for (const detail of writeDetails.filter((d) => d.created)) {
    const row = byId.get(detail.discovered_cruise_id);
    const manifest = manifestById.get(detail.official_sailing_id);
    const issues = [];
    if (!row) issues.push("missing_from_production");
    if (row?.cruise_line_id !== lineId) issues.push("wrong_cruise_line");
    if (row?.official_sailing_id !== detail.official_sailing_id) issues.push("wrong_official_sailing_id");
    if (row?.status !== "active") issues.push(`unexpected_status:${row?.status}`);
    if (manifest?.candidate) {
      if (row?.ship_id !== manifest.candidate.ship_id) issues.push("ship_mismatch");
      if (row?.departure_date !== manifest.candidate.departure_date) issues.push("departure_mismatch");
      if (row?.return_date !== manifest.candidate.return_date) issues.push("return_mismatch");
      if (row?.nights !== manifest.candidate.nights) issues.push("nights_mismatch");
      if (row?.destination_id !== manifest.candidate.destination_id) issues.push("destination_mismatch");
    }
    if (issues.length) allOk = false;
    checks.push({
      discovered_cruise_id: detail.discovered_cruise_id,
      official_sailing_id: detail.official_sailing_id,
      ok: issues.length === 0,
      issues
    });
  }

  const officialIds = (rows || []).map((r) => r.official_sailing_id).filter(Boolean);
  const duplicateOfficialIds = officialIds.length !== new Set(officialIds).size;

  return {
    ok: allOk && !duplicateOfficialIds,
    duplicate_official_sailing_id: duplicateOfficialIds,
    verified_count: checks.filter((c) => c.ok).length,
    failed_count: checks.filter((c) => !c.ok).length,
    records: checks
  };
}

export async function runSilverseaFirstControlledBatch(options = {}) {
  getSupabaseConfig(root);
  const args = options.args || parseArgs(options.argv);
  assertApplyAllowed(args);

  const startedAt = options.startedAt || new Date().toISOString();
  const today = options.today || perthCalendarDate();
  const sb = options.supabase || createMaintenanceSupabase(root);
  const modeGate = resolveSilverseaDiscoveryMode(args.apply ? "production_write" : "production_read_only");

  const ctx = await loadContext(sb);
  ctx.existingRows = ctx.existing.rows;
  ctx.existingByOfficialId = ctx.existing.byOfficialId;
  ctx.cruiseLine = ctx.line;

  const countsBefore = {
    silversea_total: await headLineCount(ctx.line.id),
    silversea_active: await headLineCount(ctx.line.id, "active"),
    discovered_cruises_total: (await exactCountSupabase(root, "discovered_cruises")).count,
    active_discovered_total: (await exactCountSupabase(root, "discovered_cruises", "status=eq.active")).count,
    other_lines_active: await headOtherLineCounts(sb)
  };

  const legacyRowsBefore = ctx.existing.rows.map((r) => ({
    id: r.id,
    status: r.status,
    official_sailing_id: r.official_sailing_id,
    official_url: r.official_url,
    review_reason: r.review_reason
  }));

  const frozenReportEarly = args.frozenReport ? loadFrozenReport(args.frozenReport) : null;
  const expectedCountEarly = args.expectedCount ?? (frozenReportEarly ? loadFrozenOfficialSailingIds(frozenReportEarly).length : null);
  const legacyHiddenRows = legacyRowsBefore.filter((r) => !r.official_sailing_id);
  if (expectedCountEarly === 75) {
    if (countsBefore.silversea_total !== 8) {
      throw new Error(
        `Unexpected Silversea production total ${countsBefore.silversea_total} (expected 8) — STOP WITH ZERO WRITES`
      );
    }
    if (countsBefore.silversea_active !== 0) {
      throw new Error(
        `Unexpected Silversea active count ${countsBefore.silversea_active} (expected 0) — STOP WITH ZERO WRITES`
      );
    }
    if (legacyHiddenRows.length !== 8) {
      throw new Error(
        `Unexpected legacy hidden row count ${legacyHiddenRows.length} (expected 8) — STOP WITH ZERO WRITES`
      );
    }
    const withOfficialId = ctx.existing.rows.filter((r) => r.official_sailing_id);
    if (withOfficialId.length > 0) {
      throw new Error(
        `Unexpected existing official Silversea sailing IDs: ${withOfficialId.length} — STOP WITH ZERO WRITES`
      );
    }
  }

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: ctx.line,
    ships: ctx.ships,
    destinations: ctx.destinations,
    existingRows: ctx.existing.rows,
    today,
    enrich: true,
    concurrency: options.concurrency || 4,
    requestDelayMs: options.requestDelayMs || 75
  });

  if (!simulation.ok || !simulation.health?.ok) {
    throw new Error("Silversea source health check failed — STOP WITH ZERO WRITES");
  }

  const normalised = simulation.products || [];
  const funnel = buildExclusiveClassificationFunnel(normalised, {
    today,
    existingByOfficialId: ctx.existingByOfficialId
  });

  if (!funnel.reconciles) {
    throw new Error(
      `Exclusive classification does not reconcile: total=${funnel.total}, sum=${funnel.sum} — STOP WITH ZERO WRITES`
    );
  }

  const frozenReport = args.frozenReport ? loadFrozenReport(args.frozenReport) : null;
  const frozenIds = frozenReport ? loadFrozenOfficialSailingIds(frozenReport) : null;
  const expectedCount = args.expectedCount ?? (frozenIds ? frozenIds.length : null);
  const batchMode = expectedCount === 75 ? FIRST_BATCH_75_MODE : FIRST_BATCH_MODE;
  const maxWrites = expectedCount != null ? Math.min(expectedCount, MAX_FIRST_CONTROLLED_BATCH) : MAX_FIRST_CONTROLLED_BATCH;

  if (expectedCount != null && (!Number.isFinite(expectedCount) || expectedCount < 1 || expectedCount > MAX_FIRST_CONTROLLED_BATCH)) {
    throw new Error(`expected-count must be between 1 and ${MAX_FIRST_CONTROLLED_BATCH}`);
  }
  if (frozenIds && expectedCount != null && frozenIds.length !== expectedCount) {
    throw new Error(`frozen selection count ${frozenIds.length} != expected-count ${expectedCount}`);
  }

  const selection = frozenIds
    ? selectFrozenBatchProducts(normalised, frozenIds, {
        today,
        existingByOfficialId: ctx.existingByOfficialId
      })
    : selectFirstBatchProducts(normalised, {
        maxWrites,
        today,
        existingByOfficialId: ctx.existingByOfficialId
      });

  const ignoredAdditional = frozenIds
    ? summariseAdditionalEligibleIgnored(frozenIds, normalised, today, ctx.existingByOfficialId)
    : null;

  const existingOfficialBefore = await countExistingOfficialIds(sb, ctx.line.id, selection.selected_ids);

  const runId =
    options.runId ||
    (expectedCount === 75
      ? `silversea-first-batch-75-${startedAt.replace(/[:.]/g, "-")}`
      : `silversea-first-batch-${startedAt.replace(/[:.]/g, "-")}`);
  const manifest = await buildSilverseaBatchManifest({
    selectedProducts: selection.selected,
    cruiseLine: ctx.line,
    destinations: ctx.destinations,
    supabase: sb,
    runId,
    today,
    existingByOfficialId: ctx.existingByOfficialId
  });
  manifest.manifest_hash = computeManifestHash(manifest);

  const proposedInserts = manifest.products.filter((p) => p.proposed_action === "insert_active").length;
  const proposedUpdates = manifest.products.filter((p) => p.proposed_action === "update_existing").length;

  const sourceRefresh = validateSelectedAgainstFreshSource(
    selection.selected_ids,
    buildProductsByCode(normalised)
  );

  const resolution = summariseResolution(normalised);
  const preWriteGate = evaluatePreWriteGate({
    funnel,
    selection,
    proposedInserts,
    proposedUpdates,
    sourceHealthOk: simulation.health?.ok === true,
    sourceRefreshOk: sourceRefresh.ok,
    maxWrites,
    expectedCount,
    existingSelectedOfficialIds: existingOfficialBefore.count
  });

  const preWriteTable = selection.selected.map((row, index) => ({
    ...buildPreWriteTableRow(index + 1, row),
    pass: true
  }));
  const preWriteReport = {
    silversea_production_total: countsBefore.silversea_total,
    silversea_active_total: countsBefore.silversea_active,
    legacy_hidden_rows: legacyRowsBefore.filter((r) => !r.official_sailing_id).length,
    catalogue_total: simulation.summary?.catalogue_nodes,
    source_health_ok: simulation.health?.ok === true,
    frozen_selection_count: frozenIds?.length ?? null,
    frozen_unique_official_ids: frozenIds ? new Set(frozenIds).size : null,
    frozen_still_eligible: selection.frozen_still_eligible ?? null,
    frozen_no_longer_eligible: selection.no_longer_eligible ?? [],
    frozen_missing: selection.missing ?? [],
    ignored_additional_eligible: ignoredAdditional,
    selected_official_ids_already_present: existingOfficialBefore.count,
    classic_count: simulation.summary?.classic,
    expedition_deferred: simulation.summary?.expedition,
    special_voyages_deferred: simulation.summary?.deferred_special_voyages,
    beyond_21_day_count: simulation.summary?.eligible_beyond_cutoff,
    duration_mismatch_count: simulation.summary?.duration_mismatches,
    classic_duration_mismatch_exclusions: resolution.classic_duration_mismatch,
    ship_unresolved: resolution.classic_ship_unresolved,
    embark_unresolved: resolution.classic_embark_unresolved,
    disembark_unresolved: resolution.classic_disembark_unresolved,
    destination_unresolved: resolution.classic_destination_unresolved,
    itinerary_ports_unresolved: resolution.classic_itinerary_port_unresolved,
    other_incomplete: funnel.counts.classic_other_incomplete,
    fully_eligible_classic_pool: selection.eligible_count,
    recognised_existing_official_ids: funnel.counts.recognised_existing_official_id,
    proposed_inserts: proposedInserts,
    proposed_updates: proposedUpdates,
    exclusive_funnel: funnel.counts,
    pre_write_table: preWriteTable,
    pre_write_gate: preWriteGate
  };

  if (!preWriteGate.passed) {
    const report = {
      phase: "preflight_blocked",
      run_id: runId,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      writes: false,
      pre_write_report: preWriteReport,
      pre_write_gate: preWriteGate,
      source_refresh: sourceRefresh
    };
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `silversea-first-controlled-batch-${runId}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    report.report_path = reportPath;
    return report;
  }

  let writeResult = null;
  let rollbackManifest = null;

  if (args.apply) {
    assertSilverseaWritesAllowed(modeGate);
    writeResult = await applySilverseaBatchWrites({
      selectedProducts: selection.selected,
      cruiseLine: ctx.line,
      runId,
      supabase: sb,
      today,
      existingByOfficialId: ctx.existingByOfficialId,
      performWrites: true,
      maxWrites
    });

    rollbackManifest = buildRollbackManifestFromWriteResult({
      runId,
      cruiseLineId: ctx.line.id,
      lineSlug: LINE_SLUG,
      triggerType: batchMode,
      writeResult
    });

    if (expectedCount != null && writeResult.stats.inserted !== expectedCount) {
      throw new Error(`Unexpected insert count ${writeResult.stats.inserted} != authorised ${expectedCount}`);
    }
    if (writeResult.stats.inserted > maxWrites) {
      throw new Error(`Unexpected insert count ${writeResult.stats.inserted} > ${maxWrites}`);
    }
    if (writeResult.stats.updated > 0) {
      throw new Error(`Unexpected updates during insert-only batch: ${writeResult.stats.updated}`);
    }
  }

  const countsAfter = args.apply
    ? {
        silversea_total: await headLineCount(ctx.line.id),
        silversea_active: await headLineCount(ctx.line.id, "active"),
        discovered_cruises_total: (await exactCountSupabase(root, "discovered_cruises")).count,
        active_discovered_total: (await exactCountSupabase(root, "discovered_cruises", "status=eq.active")).count,
        other_lines_active: await headOtherLineCounts(sb)
      }
    : countsBefore;

  const legacyRowsAfter = args.apply
    ? (
        await indexExistingSilverseaRecords(
          sb,
          ctx.line.id
        )
      ).rows
        .filter((r) => !r.official_sailing_id)
        .map((r) => ({
          id: r.id,
          status: r.status,
          official_sailing_id: r.official_sailing_id,
          official_url: r.official_url,
          review_reason: r.review_reason
        }))
    : legacyRowsBefore;

  const verification = args.apply
    ? await verifyInsertedRecords(sb, ctx.line.id, writeResult.stats.write_details, manifest.products)
    : null;

  const report = {
    phase: args.apply ? "apply" : args.manifest ? "manifest" : "preflight",
    run_id: runId,
    batch_mode: batchMode,
    expected_count: expectedCount,
    frozen_report_path: args.frozenReport || null,
    manifest_hash: manifest.manifest_hash,
    mode: modeGate.mode,
    writes: args.apply === true,
    weekly_maintenance: "not_enabled",
    production_silversea_inserts: writeResult?.stats?.inserted || 0,
    production_silversea_updates: writeResult?.stats?.updated || 0,
    production_silversea_deletes: 0,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    git: {
      branch: git("git rev-parse --abbrev-ref HEAD"),
      sha: git("git rev-parse HEAD")
    },
    counts_before: countsBefore,
    counts_after: countsAfter,
    pre_write_report: preWriteReport,
    exclusive_funnel: funnel,
    selection: {
      frozen_selection: Boolean(frozenIds),
      eligible_count: selection.eligible_count,
      selected_count: selection.selected.length,
      selected_official_sailing_ids: selection.selected_ids,
      frozen_still_eligible: selection.frozen_still_eligible ?? null,
      exact_frozen_set_match: selection.exact_frozen_set_match ?? null
    },
    manifest,
    write_result: writeResult,
    verification,
    legacy_hidden_rows_before: legacyRowsBefore,
    legacy_hidden_rows_after: legacyRowsAfter,
    legacy_hidden_unchanged:
      JSON.stringify(legacyRowsBefore) === JSON.stringify(legacyRowsAfter),
    cross_line_active_delta: args.apply
      ? Object.fromEntries(
          Object.entries(countsBefore.other_lines_active).map(([slug, before]) => [
            slug,
            (countsAfter.other_lines_active[slug] || 0) - before
          ])
        )
      : null,
    source_health: simulation.health,
    source_refresh: sourceRefresh
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `silversea-first-controlled-batch-${runId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  report.report_path = reportPath;

  if (rollbackManifest) {
    const rollbackPath = path.join(REPORT_DIR, `silversea-first-controlled-batch-rollback-${runId}.json`);
    fs.writeFileSync(rollbackPath, JSON.stringify(rollbackManifest, null, 2));
    report.rollback_manifest_path = rollbackPath;
  }

  return report;
}

async function main() {
  try {
    const report = await runSilverseaFirstControlledBatch();
    console.log(JSON.stringify(report, null, 2));
    if (report.pre_write_report?.pre_write_gate && !report.pre_write_report.pre_write_gate.passed) {
      process.exit(1);
    }
    if (report.verification && !report.verification.ok) process.exit(1);
  } catch (err) {
    console.error(JSON.stringify({ status: "failed", error: err.code || err.message }, null, 2));
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
