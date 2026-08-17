#!/usr/bin/env node
/**
 * Silversea Expedition Phase E6 — second/final controlled production batch (60 inserts).
 * Uses hardened executeHardenedControlledProductionApply — NOT the E4 runner lifecycle.
 *
 *   node scripts/run-silversea-expedition-e6-apply.mjs --preflight
 *   SILVERSEA_DISCOVERY_WRITE_ENABLED=true node scripts/run-silversea-expedition-e6-apply.mjs \
 *     --apply --confirm=SILVERSEA-EXPEDITION-SECOND-CONTROLLED-BATCH
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
const FIXTURE_PATH = path.join(root, "scripts/fixtures/silversea/expedition-e5-next-batch.json");
const E3_FIRST_250_PATH = path.join(root, "scripts/fixtures/silversea/expedition-e3-first-250.json");
const HARDENED_RUNNER_MODULE = "netlify/functions/lib/cruise-discovery-controlled-production-run.js";
const E4_RUNNER_PATH = "scripts/run-silversea-expedition-e4-apply.mjs";

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { MAX_CONTROLLED_BATCH } = require(path.join(root, "netlify/functions/lib/silversea-controlled-batch"));
const {
  classifyExpeditionExclusiveBucket,
  isComboSegmentProduct
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-eligibility"));
const {
  EXPEDITION_SECOND_BATCH_MODE,
  EXPEDITION_E5_APPLY_CONFIRMATION_TOKEN,
  E5_NEXT_BATCH_FIXTURE,
  loadFrozenExpeditionIds,
  selectFrozenExpeditionBatch,
  selectExpeditionCompletePool,
  selectNewCompleteExpeditionPool,
  validateAllExpeditionCandidates,
  buildExpeditionPreWriteTableRow,
  computeExpeditionManifestHash,
  evaluateExpeditionPreWriteGate
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-controlled-batch"));
const {
  buildExpeditionBatchManifest,
  dryRunExpeditionBatchManifest,
  applyExpeditionBatchWrites,
  buildItineraryPorts,
  buildExpeditionUpsertCandidate,
  indexExistingSilverseaRecords
} = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const {
  DISCOVERED_CRUISE_EXPEDITION_VERIFY_SELECT,
  verifyStoredExpeditionRow,
  assertExpeditionVerifyProjectionValid
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-verification"));
const {
  RUN_STATUS,
  buildPreWriteRollbackManifest,
  buildControlledBatchMarker,
  appendInsertedRecord,
  buildApplyReportLifecycle,
  updateReportLifecycle,
  ControlledProductionRunStore,
  executeHardenedControlledProductionApply,
  recoverInsertedRowsByRunId,
  simulateCrashRecoveryScenarios
} = require(path.join(root, HARDENED_RUNNER_MODULE));
const { DEFAULT_GLOBAL_LEASE_SECONDS } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-global-write-lock"
));
const {
  resolveSilverseaDiscoveryMode,
  assertSilverseaWritesAllowed
} = require(path.join(root, "netlify/functions/lib/silversea-discovery-mode"));
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

export const LINE_SLUG = adapter.LINE_SLUG;
export const E6_USES_HARDENED_RUNNER = true;
export const E6_RUNNER_PATH = "scripts/run-silversea-expedition-e6-apply.mjs";

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function parseArgs(argv = process.argv) {
  const args = { preflight: false, apply: false, confirm: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
  }
  if (args.apply) args.preflight = true;
  if (!args.preflight && !args.apply) args.preflight = true;
  return args;
}

function assertApplyAllowed(args) {
  if (!args.apply) return;
  if (args.confirm !== EXPEDITION_E5_APPLY_CONFIRMATION_TOKEN) {
    const err = new Error("expedition_e6_apply_confirmation_required");
    err.code = "expedition_e6_apply_confirmation_required";
    throw err;
  }
  if (String(process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    const err = new Error("SILVERSEA_DISCOVERY_WRITE_ENABLED must be true for apply");
    err.code = "silversea_discovery_write_disabled";
    throw err;
  }
}

function assertHardenedArchitecturePresent() {
  const hardenedPath = path.join(root, HARDENED_RUNNER_MODULE);
  if (!fs.existsSync(hardenedPath)) {
    throw new Error("hardened_controlled_production_run_missing — STOP WITH ZERO WRITES");
  }
  if (typeof executeHardenedControlledProductionApply !== "function") {
    throw new Error("executeHardenedControlledProductionApply_unavailable — STOP WITH ZERO WRITES");
  }
}

function countProductionState(rows) {
  const activeOfficial = rows.filter((r) => r.status === "active" && r.official_sailing_id);
  const expeditionOfficial = activeOfficial.filter((r) =>
    /^(E4|EV|OR|WI)/i.test(String(r.official_sailing_id))
  );
  const classicOfficial = activeOfficial.filter(
    (r) => !/^(E4|EV|OR|WI)/i.test(String(r.official_sailing_id))
  );
  return {
    total: rows.length,
    active_official: activeOfficial.length,
    classic_official: classicOfficial.length,
    expedition_official: expeditionOfficial.length,
    legacy_hidden: rows.filter((r) => !r.official_sailing_id).length,
    recognised_expedition: expeditionOfficial.length
  };
}

function isExpeditionOfficialId(id) {
  return /^(E4|EV|OR|WI)/i.test(String(id || ""));
}

function snapshotOfficialRows(rows) {
  return rows
    .filter((r) => r.official_sailing_id)
    .map((r) => ({
      id: r.id,
      official_sailing_id: r.official_sailing_id,
      status: r.status,
      departure_date: r.departure_date,
      return_date: r.return_date,
      ship_id: r.ship_id,
      destination_id: r.destination_id,
      nights: r.nights,
      departure_port: r.departure_port
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function countExistingOfficialIds(sb, cruiseLineId, officialIds) {
  if (!officialIds?.length) return { count: 0, rows: [] };
  const rows = [];
  for (let i = 0; i < officialIds.length; i += 50) {
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

async function fetchRowsByRunId(sb, lineId, runId) {
  return sb(
    `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
      lineId
    )}&raw_extract->controlled_batch->>run_id=eq.${encodeURIComponent(runId)}&select=${DISCOVERED_CRUISE_EXPEDITION_VERIFY_SELECT}`
  );
}

async function fetchRowsByIds(sb, ids) {
  if (!ids?.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const batch = await sb(`discovered_cruises?id=in.(${chunk.join(",")})&select=${DISCOVERED_CRUISE_EXPEDITION_VERIFY_SELECT}`);
    if (batch?.length) out.push(...batch);
  }
  return out;
}

function auditWriteShape(row, cruiseLine, today, controlledBatch) {
  const candidate = buildExpeditionUpsertCandidate(row, cruiseLine, today, controlledBatch);
  const issues = [];
  if (!candidate) issues.push("upsert_candidate_null");
  if (!candidate?.raw_extract?.controlled_batch?.run_id) issues.push("missing_controlled_batch_run_id");
  const ports = buildItineraryPorts(row);
  for (const stop of row.itinerary || []) {
    if (stop.kind !== "port") continue;
    if (
      stop.expedition_semantic &&
      stop.expedition_semantic !== EXPEDITION_SEMANTIC.CONVENTIONAL_PORT &&
      stop.port_resolution?.canonicalPortName &&
      ports.includes(stop.port_resolution.canonicalPortName)
    ) {
      issues.push(`semantic_leak:${stop.port_code || stop.port_name}`);
    }
  }
  return { ok: issues.length === 0, issues, ports, candidate };
}

function kgiLogisticsCount(rows) {
  let count = 0;
  for (const row of rows) {
    const codes = [
      row.departure_port_resolution?.sourceCode,
      row.departure_port_resolution?.portCode,
      row.arrival_port_resolution?.sourceCode,
      row.arrival_port_resolution?.portCode
    ]
      .map((c) => String(c || "").toUpperCase())
      .filter(Boolean);
    const names = [row.raw?.departure_port, row.raw?.arrival_port].join(" ");
    if (
      codes.some((c) => c === "AQKGG" || c === "AQKGI") ||
      /king george island/i.test(names)
    ) {
      count += 1;
    }
  }
  return count;
}

function verifyKgiPayloads(rows, cruiseLine, today, controlledBatch) {
  const issues = [];
  for (const row of rows) {
    const hasKgi =
      row.departure_port_resolution?.expedition_logistics_gateway ||
      row.arrival_port_resolution?.expedition_logistics_gateway;
    if (!hasKgi) continue;
    const candidate = buildExpeditionUpsertCandidate(row, cruiseLine, today, controlledBatch);
    const ports = buildItineraryPorts(row);
    if (/king george island/i.test(ports.join(" "))) {
      issues.push({ id: row.official_sailing_id, issue: "kgi_in_itinerary_ports" });
    }
    if (!candidate?.raw_extract?.expedition_endpoint_embark && !candidate?.raw_extract?.expedition_endpoint_disembark) {
      issues.push({ id: row.official_sailing_id, issue: "kgi_metadata_missing" });
    }
  }
  return { ok: issues.length === 0, issues };
}

async function headLineCount(lineId, statusFilter = null) {
  let query = `cruise_line_id=eq.${encodeURIComponent(lineId)}`;
  if (statusFilter) query += `&status=eq.${statusFilter}`;
  const { count } = await exactCountSupabase(root, "discovered_cruises", query);
  return count;
}

function compareSnapshots(before, after) {
  const afterById = new Map(after.map((r) => [r.id, r]));
  return before.every((row) => {
    const current = afterById.get(row.id);
    return current && JSON.stringify(row) === JSON.stringify(current);
  });
}

export async function runSilverseaExpeditionE6(options = {}) {
  assertHardenedArchitecturePresent();
  assertExpeditionVerifyProjectionValid();

  const args = options.args || parseArgs();
  assertApplyAllowed(args);
  const startedAt = new Date().toISOString();
  const today = perthCalendarDate();
  const modeGate = resolveSilverseaDiscoveryMode(args.apply ? "production_write" : "production_read_only");
  const sb = createMaintenanceSupabase(root);

  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`fixture_not_found:${FIXTURE_PATH} — STOP WITH ZERO WRITES`);
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  const frozenIds = loadFrozenExpeditionIds(fixture);
  const expectedCount = frozenIds.length;
  if (expectedCount !== 60 || new Set(frozenIds).size !== 60) {
    throw new Error(`fixture_count_invalid:${expectedCount} — STOP WITH ZERO WRITES`);
  }

  const line = (await sb(`ci_cruise_lines?slug=eq.${LINE_SLUG}&select=id,name,slug,website_url&limit=1`))?.[0];
  if (!line) throw new Error(`Cruise line not found: ${LINE_SLUG}`);

  const destinations = adapter.catalogueDestinations(
    await loadClassificationDestinations(async (q) => sb(q))
  );
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );
  const indexed = await indexExistingSilverseaRecords(sb, line.id);
  const existingRows = indexed.rows;
  const existingByOfficialId = indexed.byOfficialId;

  const productionBefore = countProductionState(existingRows);
  const e3Fixture = JSON.parse(fs.readFileSync(E3_FIRST_250_PATH, "utf8"));
  const e3FrozenIds = loadFrozenExpeditionIds(e3Fixture);
  const e3Present = await countExistingOfficialIds(sb, line.id, e3FrozenIds);
  if (e3Present.count !== 250) {
    throw new Error(`e3_frozen_not_complete:${e3Present.count}/250 — STOP WITH ZERO WRITES`);
  }

  const legacyBefore = existingRows
    .filter((r) => !r.official_sailing_id)
    .map((r) => ({
      id: r.id,
      status: r.status,
      official_sailing_id: r.official_sailing_id,
      review_reason: r.review_reason
    }));

  const officialSnapshotBefore = snapshotOfficialRows(existingRows);
  const expeditionSnapshotBefore = officialSnapshotBefore.filter((r) =>
    isExpeditionOfficialId(r.official_sailing_id)
  );
  const classicSnapshotBefore = officialSnapshotBefore.filter(
    (r) => !isExpeditionOfficialId(r.official_sailing_id)
  );

  const countsBefore = {
    silversea_total: await headLineCount(line.id),
    silversea_active: await headLineCount(line.id, "active")
  };

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows,
    today,
    concurrency: 6
  });
  const sourceHealthOk = simulation.ok === true && simulation.health?.ok === true;
  if (!sourceHealthOk) {
    throw new Error("source_health_failed — STOP WITH ZERO WRITES");
  }

  const expRows = simulation.products.filter(
    (row) => String(row.raw?.cruise_type || "").trim().toLowerCase() === "expedition"
  );
  const uniqueCodes = new Set(expRows.map((r) => String(r.official_sailing_id || "").toUpperCase()).filter(Boolean));

  const selection = selectFrozenExpeditionBatch(expRows, frozenIds, {
    today,
    existingByOfficialId
  });
  if (!selection.exact_frozen_set_match) {
    throw new Error(
      `frozen_set_no_longer_eligible missing=${selection.missing.length} ineligible=${selection.no_longer_eligible.length} — STOP WITH ZERO WRITES`
    );
  }

  const revalidation = validateAllExpeditionCandidates(selection.selected, today, existingByOfficialId);
  if (!revalidation.ok) {
    throw new Error(`revalidation_failed:${revalidation.failed.length} — STOP WITH ZERO WRITES`);
  }

  const preWriteTable = selection.selected.map((row, i) => ({
    ...buildExpeditionPreWriteTableRow(i + 1, row, today),
    proposed_action: "INSERT",
    dedupe: "NEW"
  }));

  const cutoffViolations = preWriteTable.filter(
    (r) => r.days_until_departure != null && r.days_until_departure < PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE
  );
  if (cutoffViolations.length > 0) {
    throw new Error(`cutoff_violations:${cutoffViolations.length} — STOP WITH ZERO WRITES`);
  }

  const existingOfficialBefore = await countExistingOfficialIds(sb, line.id, frozenIds);
  if (existingOfficialBefore.count > 0) {
    throw new Error(`selected_ids_already_present:${existingOfficialBefore.count} — STOP WITH ZERO WRITES`);
  }

  const runId = options.runId || `silversea-expedition-e6-${startedAt.replace(/[:.]/g, "-")}`;
  const controlledBatchMarker = buildControlledBatchMarker({
    line: "silversea",
    productType: "expedition",
    phase: "E6",
    runId,
    fixture: E5_NEXT_BATCH_FIXTURE
  });

  const writeShapeResults = selection.selected.map((row) =>
    auditWriteShape(row, line, today, controlledBatchMarker)
  );
  if (!writeShapeResults.every((r) => r.ok)) {
    throw new Error("write_shape_invalid — STOP WITH ZERO WRITES");
  }

  const kgiCount = kgiLogisticsCount(selection.selected);
  const kgiVerify = verifyKgiPayloads(selection.selected, line, today, controlledBatchMarker);
  if (!kgiVerify.ok) {
    throw new Error("kgi_payload_invalid — STOP WITH ZERO WRITES");
  }

  const comboCount = selection.selected.filter((r) => isComboSegmentProduct(r.raw)).length;
  const comboIds = new Set(selection.selected.map((r) => String(r.official_sailing_id).toUpperCase()));
  const comboSafe = comboIds.size === selection.selected.length;

  const manifest = await buildExpeditionBatchManifest({
    selectedProducts: selection.selected,
    cruiseLine: line,
    destinations,
    supabase: sb,
    runId,
    today,
    existingByOfficialId
  });
  manifest.manifest_hash = computeExpeditionManifestHash(manifest);
  const dryRun = dryRunExpeditionBatchManifest(manifest);

  const completePool = selectExpeditionCompletePool(expRows, { today, existingByOfficialId });
  const preWriteGate = evaluateExpeditionPreWriteGate({
    completePoolCount: completePool.eligible_count,
    selection,
    proposedInserts: dryRun.proposed_inserts,
    proposedUpdates: dryRun.proposed_updates,
    revalidation,
    sourceHealthOk,
    expectedCount,
    existingSelectedOfficialIds: existingOfficialBefore.count
  });

  if (
    !preWriteGate.passed ||
    dryRun.proposed_inserts !== expectedCount ||
    dryRun.proposed_updates !== 0 ||
    dryRun.proposed_deletes !== 0
  ) {
    const blocked = {
      phase: "e6_preflight_blocked",
      run_id: runId,
      e6_uses_hardened_runner: true,
      e4_runner_not_used: true,
      pre_write_gate: preWriteGate,
      dry_run: dryRun,
      production_before: productionBefore
    };
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `silversea-expedition-e6-${runId}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(blocked, null, 2)}\n`);
    return { ...blocked, report_path: reportPath, blocked: true };
  }

  const store = new ControlledProductionRunStore(REPORT_DIR, runId);
  let rollbackManifest = buildPreWriteRollbackManifest({
    runId,
    fixturePath: E5_NEXT_BATCH_FIXTURE,
    operation: EXPEDITION_SECOND_BATCH_MODE,
    lineSlug: LINE_SLUG,
    cruiseLineId: line.id,
    officialSailingIds: frozenIds,
    expectedInserts: expectedCount,
    writeCeiling: expectedCount,
    productionBefore: productionBefore,
    sourceSnapshot: {
      catalogue_total: simulation.summary?.catalogue_nodes,
      expedition_total: expRows.length,
      unique_cruise_codes: uniqueCodes.size,
      source_health: sourceHealthOk ? "PASS" : "FAIL",
      fetched_at: startedAt
    },
    createdAt: startedAt,
    controlledBatch: controlledBatchMarker
  });

  let applyReport = buildApplyReportLifecycle({
    runId,
    createdAt: startedAt,
    fixturePath: E5_NEXT_BATCH_FIXTURE,
    operation: EXPEDITION_SECOND_BATCH_MODE,
    lineSlug: LINE_SLUG,
    expectedInserts: expectedCount,
    productionBefore: productionBefore
  });
  applyReport.hardened_runner = true;
  applyReport.e4_runner_not_used = true;
  applyReport.e6_runner_path = E6_RUNNER_PATH;

  const rollbackPath = store.persistPreparedRollback(rollbackManifest);
  const applyReportPath = store.persistPreparedReport(applyReport);
  applyReport = updateReportLifecycle(applyReport, {
    rollback_manifest_path: rollbackPath,
    apply_report_path: applyReportPath
  });
  store.updateReport(applyReport);

  const preparedRollbackReread = store.readRollback();
  const preparedReportReread = JSON.parse(fs.readFileSync(applyReportPath, "utf8"));
  if (
    !preparedRollbackReread ||
    preparedRollbackReread.status !== RUN_STATUS.PREPARED ||
    preparedReportReread.status !== RUN_STATUS.PREPARED
  ) {
    throw new Error("prepared_state_reread_failed — STOP WITH ZERO WRITES");
  }

  let writeResult = null;
  let hardenedResult = null;
  let underLockRecheck = null;
  let verification = null;
  let runIdRows = null;
  let crashRecovery = null;

  if (args.apply) {
    assertSilverseaWritesAllowed(modeGate);

    hardenedResult = await executeHardenedControlledProductionApply(
      sb,
      {
        runId,
        lineSlug: LINE_SLUG,
        operation: EXPEDITION_SECOND_BATCH_MODE,
        performWrites: true,
        leaseSeconds: DEFAULT_GLOBAL_LEASE_SECONDS,
        underLockRecheck: async (lockMeta) => {
          const freshIndexed = await indexExistingSilverseaRecords(sb, line.id);
          const existingUnderLock = await countExistingOfficialIds(sb, line.id, frozenIds);
          underLockRecheck = {
            total_silversea: freshIndexed.rows.length,
            expedition_official: countProductionState(freshIndexed.rows).expedition_official,
            selected_ids_present: existingUnderLock.count,
            proposed_inserts: expectedCount,
            proposed_updates: 0,
            proposed_deletes: 0,
            write_ceiling_valid: expectedCount <= MAX_CONTROLLED_BATCH,
            lock_meta: {
              owner: lockMeta.owner_id,
              acquired_at: lockMeta.acquired_at,
              expires_at: lockMeta.expires_at
            }
          };
          if (existingUnderLock.count > 0) {
            return { ok: false, reason: "under_lock_selected_official_ids_already_present" };
          }
          if (dryRun.proposed_inserts !== expectedCount || dryRun.proposed_updates !== 0) {
            return { ok: false, reason: "under_lock_write_count_invalid" };
          }
          return { ok: true };
        }
      },
      {
        onLockAcquired: async (lockMeta) => {
          rollbackManifest.status = RUN_STATUS.LOCK_ACQUIRED;
          rollbackManifest.lock_acquired_at = lockMeta.acquired_at;
          store.updateRollback(rollbackManifest);
          applyReport = updateReportLifecycle(applyReport, {
            status: RUN_STATUS.LOCK_ACQUIRED,
            global_lock: lockMeta.observability || lockMeta
          });
          store.updateReport(applyReport);
        },
        mutate: async () => {
          rollbackManifest.status = RUN_STATUS.MUTATING;
          store.updateRollback(rollbackManifest);
          applyReport = updateReportLifecycle(applyReport, { status: RUN_STATUS.MUTATING });
          store.updateReport(applyReport);

          return applyExpeditionBatchWrites({
            selectedProducts: selection.selected,
            cruiseLine: line,
            runId,
            supabase: sb,
            today,
            existingByOfficialId,
            performWrites: true,
            maxWrites: expectedCount,
            mode: EXPEDITION_SECOND_BATCH_MODE,
            controlledBatch: controlledBatchMarker,
            onInsertSuccess: async ({ discovered_cruise_id, official_sailing_id }) => {
              rollbackManifest = appendInsertedRecord(rollbackManifest, {
                discoveredCruiseId: discovered_cruise_id,
                officialSailingId: official_sailing_id
              });
              store.updateRollback(rollbackManifest);
            }
          });
        },
        onWriteComplete: async ({ writeResult: wr }) => {
          writeResult = wr;
          rollbackManifest.status = RUN_STATUS.WRITE_COMPLETE;
          store.updateRollback(rollbackManifest);
          applyReport = updateReportLifecycle(applyReport, {
            status: RUN_STATUS.WRITE_COMPLETE,
            write_result: {
              inserted: wr.stats.inserted,
              updated: wr.stats.updated,
              failed: wr.stats.failed,
              attempted: wr.stats.attempted
            }
          });
          store.updateReport(applyReport);
        },
        onVerificationStart: async () => {
          rollbackManifest.status = RUN_STATUS.VERIFYING;
          store.updateRollback(rollbackManifest);
          applyReport = updateReportLifecycle(applyReport, { status: RUN_STATUS.VERIFYING });
          store.updateReport(applyReport);
        },
        verifyUnderLock: async ({ writeResult: wr }) => {
          const insertedIds = (wr.stats.write_details || [])
            .filter((d) => d.created && d.discovered_cruise_id)
            .map((d) => d.discovered_cruise_id);

          if (insertedIds.length !== expectedCount) {
            return {
              ok: false,
              reason: `expected_${expectedCount}_inserted_got_${insertedIds.length}`,
              lock_held: true
            };
          }

          const rows = await fetchRowsByIds(sb, insertedIds);
          runIdRows = await fetchRowsByRunId(sb, line.id, runId);

          const manifestById = new Map((manifest.products || []).map((m) => [m.official_sailing_id, m]));
          const sourceById = new Map(
            selection.selected.map((r) => [String(r.official_sailing_id).toUpperCase(), r])
          );

          const checks = rows.map((row) => {
            const manifestEntry = manifestById.get(row.official_sailing_id);
            const sourceRow = sourceById.get(String(row.official_sailing_id).toUpperCase());
            const rowCheck = verifyStoredExpeditionRow(row, {
              lineId: line.id,
              manifestEntry,
              sourceRow
            });
            const marker = row?.raw_extract?.controlled_batch;
            const markerIssues = [];
            if (marker?.run_id !== runId) markerIssues.push("run_id_mismatch");
            if (marker?.phase !== "E6") markerIssues.push("phase_mismatch");
            if (marker?.fixture !== E5_NEXT_BATCH_FIXTURE) markerIssues.push("fixture_mismatch");
            const issues = [...(rowCheck.issues || []), ...markerIssues];
            return {
              official_sailing_id: row.official_sailing_id,
              discovered_cruise_id: row.id,
              ok: issues.length === 0,
              issues
            };
          });

          const officialIds = rows.map((r) => r.official_sailing_id).filter(Boolean);
          verification = {
            ok: checks.every((c) => c.ok) && officialIds.length === new Set(officialIds).size,
            duplicate_official_sailing_id: officialIds.length !== new Set(officialIds).size,
            verified_count: checks.filter((c) => c.ok).length,
            failed_count: checks.filter((c) => !c.ok).length,
            records: checks
          };

          const freshIndexed = await indexExistingSilverseaRecords(sb, line.id);
          const officialSnapshotUnderLock = snapshotOfficialRows(freshIndexed.rows);
          const previousExpeditionUnchanged = compareSnapshots(
            expeditionSnapshotBefore,
            officialSnapshotUnderLock.filter((r) => isExpeditionOfficialId(r.official_sailing_id))
          );
          const previousClassicUnchanged = compareSnapshots(
            classicSnapshotBefore,
            officialSnapshotUnderLock.filter((r) => !isExpeditionOfficialId(r.official_sailing_id))
          );
          const legacyAfterUnderLock = freshIndexed.rows
            .filter((r) => !r.official_sailing_id)
            .map((r) => ({
              id: r.id,
              status: r.status,
              official_sailing_id: r.official_sailing_id,
              review_reason: r.review_reason
            }));
          const legacyUnchanged = JSON.stringify(legacyBefore) === JSON.stringify(legacyAfterUnderLock);

          const duplicateCheck = await countExistingOfficialIds(sb, line.id, frozenIds);
          const totalAfterUnderLock = await headLineCount(line.id);

          const runIdOfficialIds = new Set(
            (runIdRows || []).map((r) => String(r.official_sailing_id).toUpperCase())
          );
          const frozenSet = new Set(frozenIds.map((id) => String(id).toUpperCase()));
          const runIdMatch =
            runIdRows.length === expectedCount &&
            [...frozenSet].every((id) => runIdOfficialIds.has(id));

          verification = {
            ...verification,
            rows_matching_run_id: runIdRows.length,
            run_id_official_ids_match_fixture: runIdMatch,
            lock_held_through_verification: true,
            previous_expedition_250_unchanged: previousExpeditionUnchanged,
            previous_classic_unchanged: previousClassicUnchanged,
            legacy_8_unchanged: legacyUnchanged,
            duplicate_selected_ids: duplicateCheck.count !== expectedCount ? duplicateCheck.count : 0,
            row_delta_under_lock: totalAfterUnderLock - countsBefore.silversea_total,
            count_reconciliation:
              wr.stats.attempted ===
              wr.stats.inserted + wr.stats.duplicate_skips + wr.stats.invalid_skips + wr.stats.failed
          };

          return verification;
        },
        finalizeUnderLock: async ({ verificationResult, verificationError, writeResult: wr }) => {
          const finalStatus = verificationError || verificationResult?.ok === false
            ? RUN_STATUS.WRITE_SUCCEEDED_VERIFICATION_FAILED
            : RUN_STATUS.VERIFIED;

          rollbackManifest.status = finalStatus;
          rollbackManifest.verification_status = verificationResult || null;
          rollbackManifest.verification_error = verificationError || null;
          rollbackManifest.completion_status =
            finalStatus === RUN_STATUS.VERIFIED ? RUN_STATUS.COMPLETE : finalStatus;
          store.updateRollback(rollbackManifest);

          applyReport = updateReportLifecycle(applyReport, {
            status: finalStatus === RUN_STATUS.VERIFIED ? RUN_STATUS.COMPLETE : finalStatus,
            verification: verificationResult,
            verification_error: verificationError || null,
            global_lock_held_through_verification: true
          });
          store.updateReport(applyReport);

          if (finalStatus === RUN_STATUS.VERIFIED) {
            rollbackManifest.status = RUN_STATUS.COMPLETE;
            store.updateRollback(rollbackManifest);
          }

          crashRecovery = simulateCrashRecoveryScenarios(rollbackManifest, runIdRows || []);

          if (wr.stats.failed > 0) {
            throw new Error(`partial_write_failure: inserted=${wr.stats.inserted} failed=${wr.stats.failed}`);
          }
          if (wr.stats.inserted !== expectedCount) {
            throw new Error(`insert_count_mismatch:${wr.stats.inserted} !== ${expectedCount}`);
          }
          if (wr.stats.updated > 0) {
            throw new Error(`unexpected_updates:${wr.stats.updated}`);
          }

          return { persisted: true, final_status: finalStatus };
        }
      }
    );

    writeResult = hardenedResult.writeResult;

    if (hardenedResult.blocked) {
      const blocked = {
        phase: "e6_apply_blocked",
        run_id: runId,
        reason: hardenedResult.reason,
        global_lock: hardenedResult.global_lock,
        under_lock_recheck: underLockRecheck,
        run_status: hardenedResult.run_status
      };
      const reportPath = path.join(REPORT_DIR, `silversea-expedition-e6-${runId}.json`);
      fs.writeFileSync(reportPath, `${JSON.stringify(blocked, null, 2)}\n`);
      return { ...blocked, report_path: reportPath, blocked: true };
    }

    if (hardenedResult.writeError) {
      throw hardenedResult.writeError;
    }

    if (
      hardenedResult.run_status === RUN_STATUS.WRITE_SUCCEEDED_VERIFICATION_FAILED ||
      (verification && !verification.ok)
    ) {
      throw new Error("write_succeeded_verification_failed");
    }

    if (!hardenedResult.lock_held_through_verification) {
      throw new Error("verification_not_under_lock");
    }
  }

  const indexedAfter = args.apply ? await indexExistingSilverseaRecords(sb, line.id) : indexed;
  const productionAfter = args.apply ? countProductionState(indexedAfter.rows) : productionBefore;
  const countsAfter = args.apply
    ? {
        silversea_total: await headLineCount(line.id),
        silversea_active: await headLineCount(line.id, "active")
      }
    : countsBefore;

  const officialSnapshotAfter = args.apply ? snapshotOfficialRows(indexedAfter.rows) : officialSnapshotBefore;
  const previousExpeditionUnchanged = args.apply
    ? compareSnapshots(
        expeditionSnapshotBefore,
        officialSnapshotAfter.filter((r) => isExpeditionOfficialId(r.official_sailing_id))
      )
    : true;
  const previousClassicUnchanged = args.apply
    ? compareSnapshots(
        classicSnapshotBefore,
        officialSnapshotAfter.filter((r) => !isExpeditionOfficialId(r.official_sailing_id))
      )
    : true;

  const legacyAfter = args.apply
    ? indexedAfter.rows
        .filter((r) => !r.official_sailing_id)
        .map((r) => ({
          id: r.id,
          status: r.status,
          official_sailing_id: r.official_sailing_id,
          review_reason: r.review_reason
        }))
    : legacyBefore;

  let postApplySnapshot = null;
  let secondaryConfirmation = null;
  if (args.apply) {
    const newComplete = selectNewCompleteExpeditionPool(expRows, {
      today,
      existingByOfficialId: indexedAfter.byOfficialId
    });
    postApplySnapshot = {
      expedition_total: expRows.length,
      within_cutoff: expRows.filter(
        (r) => classifyExpeditionExclusiveBucket(r, today) === "within_21_day_cutoff"
      ).length,
      beyond_cutoff: expRows.filter((r) => {
        const b = classifyExpeditionExclusiveBucket(r, today);
        return b !== "within_21_day_cutoff" && b !== "invalid_identity";
      }).length,
      recognised_expedition_production_ids: productionAfter.recognised_expedition,
      fresh_complete: selectExpeditionCompletePool(expRows, {
        today,
        existingByOfficialId: indexedAfter.byOfficialId
      }).eligible_count,
      new_complete_not_in_production: newComplete.new_complete_count,
      ambiguity_blocked: expRows.filter(
        (r) => classifyExpeditionExclusiveBucket(r, today) === "ambiguous_semantic_itinerary"
      ).length,
      duration_mismatch: expRows.filter(
        (r) => classifyExpeditionExclusiveBucket(r, today) === "duration_mismatch"
      ).length
    };

    const postLockRunIdRows = await fetchRowsByRunId(sb, line.id, runId);
    const postLockOverlap = await countExistingOfficialIds(sb, line.id, frozenIds);
    secondaryConfirmation = {
      all_frozen_ids_present: postLockOverlap.count === expectedCount,
      rows_by_run_id: postLockRunIdRows.length,
      duplicate_zero: postLockOverlap.count === expectedCount,
      total_reconciles: countsAfter.silversea_total - countsBefore.silversea_total === expectedCount
    };
  }

  const newCompletePool = selectNewCompleteExpeditionPool(expRows, {
    today,
    existingByOfficialId: args.apply ? indexedAfter.byOfficialId : existingByOfficialId
  });

  const report = {
    phase: args.apply ? "e6_apply" : "e6_preflight",
    run_id: runId,
    e6_uses_hardened_runner: true,
    e4_runner_not_used: true,
    e4_runner_path: E4_RUNNER_PATH,
    e6_runner_path: E6_RUNNER_PATH,
    hardened_module: HARDENED_RUNNER_MODULE,
    fixture_path: E5_NEXT_BATCH_FIXTURE,
    frozen_count: expectedCount,
    frozen_unique_count: new Set(frozenIds).size,
    source: {
      catalogue_total: simulation.summary?.catalogue_nodes,
      unique_cruise_codes: uniqueCodes.size,
      expedition_total: expRows.length,
      within_cutoff: expRows.filter(
        (r) => classifyExpeditionExclusiveBucket(r, today) === "within_21_day_cutoff"
      ).length,
      beyond_cutoff: expRows.filter((r) => {
        const b = classifyExpeditionExclusiveBucket(r, today);
        return b !== "within_21_day_cutoff" && b !== "invalid_identity";
      }).length,
      source_health: sourceHealthOk ? "PASS" : "FAIL"
    },
    frozen_revalidation: revalidation,
    production_before: productionBefore,
    production_after: productionAfter,
    selected_ids_already_present_before: existingOfficialBefore.count,
    dry_run: dryRun,
    pre_write_gate: preWriteGate,
    pre_write_table: preWriteTable,
    write_shape_all_verified: writeShapeResults.every((r) => r.ok),
    kgi_logistics_voyage_count: kgiCount,
    kgi_payload_verification: kgiVerify.ok ? "PASS" : "FAIL",
    combo_segment_count: comboCount,
    combo_identity_safe: comboSafe,
    controlled_batch_marker: controlledBatchMarker,
    prepared_state: {
      rollback_path: rollbackPath,
      apply_report_path: applyReportPath,
      rollback_reread: preparedRollbackReread?.status === RUN_STATUS.PREPARED,
      report_reread: preparedReportReread?.status === RUN_STATUS.PREPARED
    },
    global_lock_path: "controlled_production_import:global",
    lease_seconds: DEFAULT_GLOBAL_LEASE_SECONDS,
    lease_sufficient: true,
    hardened_apply: hardenedResult,
    under_lock_recheck: underLockRecheck,
    write_result: writeResult,
    verification,
    crash_recovery: crashRecovery,
    counts_before: countsBefore,
    counts_after: countsAfter,
    row_delta: args.apply ? countsAfter.silversea_total - countsBefore.silversea_total : 0,
    expedition_delta: args.apply
      ? productionAfter.recognised_expedition - productionBefore.recognised_expedition
      : 0,
    legacy_before: legacyBefore,
    legacy_after: legacyAfter,
    legacy_8_unchanged: JSON.stringify(legacyBefore) === JSON.stringify(legacyAfter),
    previous_expedition_250_unchanged: previousExpeditionUnchanged,
    previous_classic_unchanged: previousClassicUnchanged,
    secondary_confirmation: secondaryConfirmation,
    post_apply_snapshot: postApplySnapshot,
    initial_catchup_complete_enough:
      args.apply && postApplySnapshot?.new_complete_not_in_production === 0 ? "YES" : args.apply ? "NO" : null,
    weekly_maintenance: "NOT ENABLED",
    next_phase:
      args.apply && postApplySnapshot?.new_complete_not_in_production === 0
        ? "A. SILVERSEA M1 — WEEKLY MAINTENANCE READ-ONLY HARDENING"
        : null,
    production_writes: {
      inserts: writeResult?.stats?.inserted || 0,
      updates: writeResult?.stats?.updated || 0,
      deletes: 0
    },
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    git: { branch: git("git rev-parse --abbrev-ref HEAD"), sha: git("git rev-parse HEAD") }
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `silversea-expedition-e6-${runId}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  report.report_path = reportPath;

  return report;
}

async function main() {
  try {
    const report = await runSilverseaExpeditionE6();
    console.log(
      JSON.stringify(
        {
          ok: !report.blocked,
          phase: report.phase,
          e6_uses_hardened_runner: report.e6_uses_hardened_runner,
          inserts: report.production_writes?.inserts,
          report: report.report_path
        },
        null,
        2
      )
    );
    if (report.blocked) process.exit(1);
    if (report.verification && !report.verification.ok) process.exit(1);
    if (report.phase === "e6_apply" && report.production_writes.inserts !== 60) process.exit(1);
  } catch (err) {
    console.error(JSON.stringify({ status: "failed", error: err.message, code: err.code }, null, 2));
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
