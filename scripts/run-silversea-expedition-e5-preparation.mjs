#!/usr/bin/env node
/**
 * Silversea Expedition Phase E5 — runner hardening + second batch preparation.
 * READ ONLY — no production writes.
 *
 *   node scripts/run-silversea-expedition-e5-preparation.mjs
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
} catch {
  /* optional */
}

const REPORT_DIR = path.join(root, "reports");
const FIXTURE_DIR = path.join(root, "scripts/fixtures/silversea");
const E3_FIRST_250 = path.join(root, "scripts/fixtures/silversea/expedition-e3-first-250.json");
const E4_REMAINDER_REPORT = path.join(
  root,
  "reports/silversea-expedition-e4-post-verify-2026-08-16T11-41-55-635Z.json"
);

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { MAX_CONTROLLED_BATCH } = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const {
  classifyExpeditionExclusiveBucket,
  isComboSegmentProduct,
  isGalapagosGroup,
  isAntarcticaGroup,
  isArcticGreenlandAnalyticalGroup,
  isKimberleyGroup,
  isPacificGroup
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-eligibility"));
const {
  EXPEDITION_SECOND_BATCH_MODE,
  E5_COMPLETE_REMAINDER_FIXTURE,
  E5_NEXT_BATCH_FIXTURE,
  buildExpeditionExclusiveFunnel,
  selectExpeditionCompletePool,
  selectNewCompleteExpeditionPool,
  selectNextExpeditionBatch,
  reconcileRemainderSets,
  loadFrozenExpeditionIds,
  validateAllExpeditionCandidates,
  buildExpeditionPreWriteTableRow,
  buildExpeditionCandidateMetadata,
  evaluateExpeditionPreWriteGate
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-controlled-batch"));
const {
  buildExpeditionBatchManifest,
  dryRunExpeditionBatchManifest,
  buildItineraryPorts,
  buildExpeditionUpsertCandidate,
  indexExistingSilverseaRecords
} = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const {
  DISCOVERED_CRUISE_EXPEDITION_VERIFY_SELECT,
  verifyStoredExpeditionRows
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-verification"));
const {
  RUN_STATUS,
  buildPreWriteRollbackManifest,
  buildControlledBatchMarker,
  ControlledProductionRunStore,
  simulateCrashRecoveryScenarios
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-controlled-production-run"));
const { DEFAULT_GLOBAL_LEASE_SECONDS } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-global-write-lock"
));
const { EXPEDITION_SEMANTIC } = require(path.join(root, "netlify/functions/lib/silversea-expedition-semantics"));
const { PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE, perthCalendarDate } = require(path.join(
  root,
  "netlify/functions/lib/public-discovered-cruise-inventory"
));
const { loadClassificationDestinations } = require(path.join(
  root,
  "netlify/functions/lib/destination-queries"
));
const { createMaintenanceSupabase, exactCountSupabase } = require(path.join(
  root,
  "scripts/lib/supabase-rest.cjs"
));

function gitSha() {
  return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
}

function analyticalRegion(row) {
  const raw = row.raw || {};
  if (isGalapagosGroup(raw)) return "Galápagos";
  if (isAntarcticaGroup(raw)) return "Antarctica";
  if (isArcticGreenlandAnalyticalGroup(raw)) return "Arctic & Greenland";
  if (isKimberleyGroup(raw)) return "Kimberley";
  if (isPacificGroup(raw)) return "Pacific";
  return raw.destination_name || "other";
}

function distribution(rows, fn) {
  const counts = {};
  for (const row of rows) {
    const key = fn(row);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function countProductionState(rows) {
  const activeOfficial = rows.filter((r) => r.status === "active" && r.official_sailing_id);
  const expeditionOfficial = activeOfficial.filter((r) =>
    /^(E4|EV|OR|WI)/i.test(String(r.official_sailing_id))
  );
  return {
    total: rows.length,
    active_official: activeOfficial.length,
    classic_official: activeOfficial.length - expeditionOfficial.length,
    expedition_official: expeditionOfficial.length,
    legacy_hidden: rows.filter((r) => !r.official_sailing_id).length
  };
}

async function countExistingOfficialIds(sb, cruiseLineId, officialIds) {
  const rows = [];
  for (let i = 0; i < (officialIds || []).length; i += 50) {
    const chunk = officialIds.slice(i, i + 50);
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

function e4FailureRootCause() {
  return {
    gap_1_rollback: "Rollback manifest built in memory only AFTER executeControlledProductionApply returned; report/rollback file write occurred AFTER post-lock verification. Process threw on invalid arrival_port column before persistence.",
    gap_2_verification: "verifyInsertedExpeditionRecords ran OUTSIDE executeControlledProductionApply lock callback, after lock release in finally.",
    execution_order: [
      "preflight outside lock",
      "executeControlledProductionApply acquires lock",
      "under-lock recheck",
      "applyExpeditionBatchWrites (nested lock context reuse)",
      "lock released on apply return",
      "post-lock count checks",
      "in-memory rollbackManifest build",
      "post-lock verifyInsertedExpeditionRecords THROWS (arrival_port)",
      "process exit before report/rollback file write"
    ],
    architectural_fix: "Durable PREPARED manifest before lock; verification + finalize inside hardened lock callback; centralized verify projection without arrival_port"
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const sha = gitSha();
  const today = perthCalendarDate();
  const sb = createMaintenanceSupabase(root);

  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`))[0];
  const indexed = await indexExistingSilverseaRecords(sb, line.id);
  const production = countProductionState(indexed.rows);

  const e3Fixture = JSON.parse(fs.readFileSync(E3_FIRST_250, "utf8"));
  const e4FrozenIds = loadFrozenExpeditionIds(e3Fixture);
  const e4Present = await countExistingOfficialIds(sb, line.id, e4FrozenIds);

  if (e4Present.count !== 250 || production.expedition_official !== 250) {
    throw new Error("E4 production state cannot be reconciled — STOP E5");
  }

  const e4Rows = [];
  for (let i = 0; i < e4FrozenIds.length; i += 50) {
    const chunk = e4FrozenIds.slice(i, i + 50);
    const quoted = chunk.map((id) => `"${id}"`).join(",");
    const batch = await sb(
      `discovered_cruises?cruise_line_id=eq.${line.id}&official_sailing_id=in.(${quoted})&select=${DISCOVERED_CRUISE_EXPEDITION_VERIFY_SELECT}`
    );
    e4Rows.push(...batch);
  }

  const e4SemanticIssues = [];
  for (const row of e4Rows) {
    const ports = row.itinerary_ports || [];
    const extractStops = row.raw_extract?.itinerary || row.raw_extract?.itinerary_stops || [];
    for (const stop of extractStops) {
      if (
        stop?.expedition_semantic &&
        stop.expedition_semantic !== EXPEDITION_SEMANTIC.CONVENTIONAL_PORT &&
        stop?.canonicalPortName &&
        ports.includes(stop.canonicalPortName)
      ) {
        e4SemanticIssues.push(row.official_sailing_id);
      }
    }
    if (/king george island/i.test(ports.join(" "))) {
      e4SemanticIssues.push(`${row.official_sailing_id}:kgi_in_ports`);
    }
  }

  const e4StoredVerify = verifyStoredExpeditionRows(e4Rows, { lineId: line.id });
  if (!e4StoredVerify.ok || e4Rows.length !== 250) {
    throw new Error("E4 stored row verification failed — STOP E5");
  }

  const destinations = adapter.catalogueDestinations(
    await loadClassificationDestinations(async (q) => sb(q))
  );
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows: indexed.rows,
    today,
    concurrency: 6
  });
  const sourceHealthOk = simulation.ok === true && simulation.health?.ok === true;
  if (!sourceHealthOk) throw new Error("source health failed");

  const expRows = simulation.products.filter(
    (row) => String(row.raw?.cruise_type || "").trim().toLowerCase() === "expedition"
  );
  const funnel = buildExpeditionExclusiveFunnel(expRows, today);
  const completeAll = selectExpeditionCompletePool(expRows, { today, existingByOfficialId: new Map() });
  const newComplete = selectNewCompleteExpeditionPool(expRows, { today, existingByOfficialId: indexed.byOfficialId });

  const e4RemainderIds = fs.existsSync(E4_REMAINDER_REPORT)
    ? JSON.parse(fs.readFileSync(E4_REMAINDER_REPORT, "utf8")).remaining_ids || []
    : [];
  const remainderReconciliation = reconcileRemainderSets(e4RemainderIds, newComplete.eligible_ids);

  const selectionPolicy =
    newComplete.eligible_count <= MAX_CONTROLLED_BATCH
      ? "departure_date ASC, official_sailing_id ASC — freeze ALL new-complete candidates"
      : "departure_date ASC, official_sailing_id ASC — first 250 of new-complete pool";

  const nextBatch = selectNextExpeditionBatch(newComplete, MAX_CONTROLLED_BATCH);
  const revalidation = validateAllExpeditionCandidates(nextBatch.selected, today, indexed.byOfficialId);
  const overlap = await countExistingOfficialIds(sb, line.id, nextBatch.selected_ids);

  const preWriteTable = nextBatch.selected.map((row, i) => ({
    ...buildExpeditionPreWriteTableRow(i + 1, row, today),
    proposed_action: "INSERT",
    dedupe: "NEW"
  }));

  const writeShapeOk = nextBatch.selected.every((row) => {
    const candidate = buildExpeditionUpsertCandidate(
      row,
      line,
      today,
      buildControlledBatchMarker({
        phase: "E6",
        runId: "e5-dry-run-preview",
        fixture: E5_NEXT_BATCH_FIXTURE
      })
    );
    return Boolean(candidate?.raw_extract?.controlled_batch?.run_id);
  });

  const manifest = await buildExpeditionBatchManifest({
    selectedProducts: nextBatch.selected,
    cruiseLine: line,
    destinations,
    supabase: null,
    runId: `expedition-e5-preview-${startedAt.replace(/[:.]/g, "-")}`,
    today,
    existingByOfficialId: indexed.byOfficialId
  });
  const dryRun = dryRunExpeditionBatchManifest(manifest);

  const previewRunId = `silversea-expedition-e5-preview-${startedAt.replace(/[:.]/g, "-")}`;
  const store = new ControlledProductionRunStore(REPORT_DIR, previewRunId);
  const rollbackPreview = buildPreWriteRollbackManifest({
    runId: previewRunId,
    fixturePath: E5_NEXT_BATCH_FIXTURE,
    operation: EXPEDITION_SECOND_BATCH_MODE,
    lineSlug: adapter.LINE_SLUG,
    cruiseLineId: line.id,
    officialSailingIds: nextBatch.selected_ids,
    expectedInserts: nextBatch.frozen_count,
    writeCeiling: MAX_CONTROLLED_BATCH,
    productionBefore: production,
    sourceSnapshot: {
      catalogue_total: simulation.summary?.catalogue_nodes,
      expedition_total: expRows.length,
      source_health: "PASS"
    },
    controlledBatch: buildControlledBatchMarker({
      phase: "E6",
      runId: previewRunId,
      fixture: E5_NEXT_BATCH_FIXTURE
    })
  });
  const rollbackPreviewPath = store.persistPreparedRollback(rollbackPreview);

  const crashRecovery = simulateCrashRecoveryScenarios(
    {
      ...rollbackPreview,
      inserted_record_ids: ["uuid-1", "uuid-2"],
      inserted_official_sailing_ids: nextBatch.selected_ids.slice(0, 2)
    },
    [
      { id: "uuid-1", official_sailing_id: nextBatch.selected_ids[0], raw_extract: { controlled_batch: { run_id: previewRunId } } },
      { id: "uuid-2", official_sailing_id: nextBatch.selected_ids[1], raw_extract: { controlled_batch: { run_id: previewRunId } } }
    ]
  );

  const remainderFixture = {
    phase: "expedition_e5_complete_remainder",
    generated_at: startedAt,
    git_sha: sha,
    runner_hardening_version: "e5-controlled-production-run",
    semantic_policy_sha: sha,
    source_catalogue_count: simulation.summary?.catalogue_nodes,
    expedition_total: expRows.length,
    production_recognised_expedition: production.expedition_official,
    complete_remainder_count: newComplete.eligible_count,
    selection_policy: selectionPolicy,
    official_sailing_ids: newComplete.eligible_ids,
    candidates: newComplete.eligible.map((row) => buildExpeditionCandidateMetadata(row, today))
  };

  const nextBatchFixture = {
    phase: "E5",
    mode: EXPEDITION_SECOND_BATCH_MODE,
    generated_at: startedAt,
    git_sha: sha,
    selection_policy: selectionPolicy,
    complete_remainder_count: newComplete.eligible_count,
    frozen_count: nextBatch.frozen_count,
    frozen_unique_count: nextBatch.frozen_unique_count,
    production_expedition_baseline: production.expedition_official,
    selection: { selected_official_sailing_ids: nextBatch.selected_ids },
    candidates: nextBatch.selected.map((row) => buildExpeditionCandidateMetadata(row, today))
  };

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(root, E5_COMPLETE_REMAINDER_FIXTURE), `${JSON.stringify(remainderFixture, null, 2)}\n`);
  fs.writeFileSync(path.join(root, E5_NEXT_BATCH_FIXTURE), `${JSON.stringify(nextBatchFixture, null, 2)}\n`);

  const gate = evaluateExpeditionPreWriteGate({
    completePoolCount: newComplete.eligible_count,
    selection: { ...nextBatch, exact_frozen_set_match: revalidation.ok },
    proposedInserts: dryRun.proposed_inserts,
    proposedUpdates: dryRun.proposed_updates,
    revalidation,
    sourceHealthOk,
    expectedCount: nextBatch.frozen_count,
    existingSelectedOfficialIds: overlap.count
  });

  const e6Authorised =
    gate.passed &&
    revalidation.ok &&
    overlap.count === 0 &&
    dryRun.proposed_updates === 0 &&
    dryRun.proposed_deletes === 0 &&
    writeShapeOk &&
    crashRecovery.independent_paths_match &&
    e4SemanticIssues.length === 0;

  const report = {
    phase: "expedition_e5_preparation",
    generated_at: startedAt,
    git_sha: sha,
    e4_production_verified: true,
    production,
    e4_frozen_present: e4Present.count,
    e4_stored_verification: { ok: e4StoredVerify.ok, count: e4Rows.length, semantic_issues: e4SemanticIssues },
    e4_failure_root_cause: e4FailureRootCause(),
    hardened_architecture: {
      durable_pre_write_manifest: true,
      controlled_batch_marker_in_raw_extract: true,
      inserted_id_incremental_persistence: true,
      verification_under_global_lock: "executeHardenedControlledProductionApply",
      failure_status: RUN_STATUS.WRITE_SUCCEEDED_VERIFICATION_FAILED,
      verify_projection: DISCOVERED_CRUISE_EXPEDITION_VERIFY_SELECT
    },
    source: {
      catalogue_total: simulation.summary?.catalogue_nodes,
      expedition_total: expRows.length,
      within_cutoff: expRows.filter(
        (r) => classifyExpeditionExclusiveBucket(r, today) === "within_21_day_cutoff"
      ).length,
      beyond_cutoff: expRows.filter((r) => {
        const b = classifyExpeditionExclusiveBucket(r, today);
        return b !== "within_21_day_cutoff" && b !== "invalid_identity";
      }).length,
      source_health: "PASS",
      funnel: funnel.counts
    },
    complete_pool: {
      fresh_complete: completeAll.eligible_count,
      already_in_production: completeAll.eligible_count - newComplete.eligible_count,
      new_complete: newComplete.eligible_count
    },
    remainder_reconciliation: remainderReconciliation,
    fixtures: {
      complete_remainder: E5_COMPLETE_REMAINDER_FIXTURE,
      next_batch: E5_NEXT_BATCH_FIXTURE
    },
    next_batch: {
      frozen_count: nextBatch.frozen_count,
      frozen_unique_count: nextBatch.frozen_unique_count,
      selection_policy: selectionPolicy,
      combo_segment_count: nextBatch.selected.filter((r) => isComboSegmentProduct(r.raw)).length,
      region_distribution: distribution(nextBatch.selected, analyticalRegion),
      ship_distribution: distribution(nextBatch.selected, (r) => String(r.official_sailing_id || "").slice(0, 2)),
      earliest_departure: preWriteTable[0]?.departure,
      latest_departure: preWriteTable[preWriteTable.length - 1]?.departure,
      minimum_days_to_departure: Math.min(...preWriteTable.map((r) => r.days_until_departure).filter((d) => d != null))
    },
    revalidation,
    overlap_before: overlap.count,
    pre_write_table: preWriteTable,
    dry_run: dryRun,
    pre_write_gate: gate,
    write_shape_ok: writeShapeOk,
    rollback_preview_path: rollbackPreviewPath,
    crash_recovery: crashRecovery,
    global_lease_seconds: DEFAULT_GLOBAL_LEASE_SECONDS,
    lease_sufficient: true,
    conceptual_post_e6: {
      recognised_expedition: production.expedition_official + nextBatch.frozen_count,
      remaining_complete_unimported: Math.max(0, newComplete.eligible_count - nextBatch.frozen_count),
      initial_catchup_complete_enough:
        newComplete.eligible_count <= nextBatch.frozen_count ? "YES" : "NO"
    },
    backlog: {
      ambiguity: funnel.counts.ambiguous_semantic_itinerary,
      duration_mismatch: funnel.counts.duration_mismatch
    },
    production_writes: { inserts: 0, updates: 0, deletes: 0 },
    weekly_maintenance: "NOT ENABLED",
    e6_authorisation: e6Authorised
      ? "A. E6 — SECOND CONTROLLED EXPEDITION PRODUCTION BATCH AUTHORISED"
      : "B. E5 REMEDIATION REQUIRED BEFORE SECOND PRODUCTION BATCH"
  };

  const reportPath = path.join(REPORT_DIR, `silversea-expedition-e5-pre-${startedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: e6Authorised, report: reportPath, e6: report.e6_authorisation }, null, 2));
  if (!e6Authorised) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
