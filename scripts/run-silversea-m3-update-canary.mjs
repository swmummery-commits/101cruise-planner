#!/usr/bin/env node
/**
 * Silversea M3 — controlled weekly-maintenance UPDATE canary (exactly SL270927009).
 *
 *   node scripts/run-silversea-m3-update-canary.mjs --preflight
 *   node scripts/run-silversea-m3-update-canary.mjs --write-fixture
 *   SILVERSEA_DISCOVERY_WRITE_ENABLED=true node scripts/run-silversea-m3-update-canary.mjs \
 *     --apply --confirm=SILVERSEA-M3-MAINTENANCE-UPDATE-CANARY
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
} catch {}

const REPORT_DIR = path.join(root, "reports");
const FIXTURE_PATH = path.join(root, "scripts/fixtures/silversea/m3-maintenance-update-canary-SL270927009.json");

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { indexExistingSilverseaRecords } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const {
  buildSilverseaWeeklyMaintenanceProposal
} = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-proposal"));
const { MAINTENANCE_CLASSIFICATION } = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-policy"));
const { classifySilverseaOfficialInventory } = require(path.join(
  root,
  "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"
));
const { snapshotProtectionRows, verifyProtectionSnapshots } = require(path.join(
  root,
  "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"
));
const {
  CANARY_OFFICIAL_ID,
  M2_INSERT_CANARY_ID,
  M1_SOURCE_ABSENCE_ID,
  M3_FIXTURE_REL,
  M3_OPERATION,
  M3_APPLY_CONFIRMATION_TOKEN,
  EXPECTED_UPDATES,
  validateM3Preflight,
  buildM3CanaryFixture,
  verifyFrozenBeforeMatch,
  applyM3UpdateOnly,
  compareUpdatedRowToFixture,
  verifyM3Protection,
  proveRepeatUpdateBlocked,
  buildM3RollbackManifest,
  assignPersistedFixtureHash,
  IMMUTABLE_FIELDS
} = require(path.join(root, "netlify/functions/lib/silversea-m3-maintenance-update-canary"));
const {
  RUN_STATUS,
  buildApplyReportLifecycle,
  updateReportLifecycle,
  ControlledProductionRunStore,
  executeHardenedControlledProductionApply,
  buildAuthoritativeVerificationResult
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-controlled-production-run"));
const { DEFAULT_GLOBAL_LEASE_SECONDS } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-global-write-lock"
));
const {
  resolveSilverseaDiscoveryMode,
  assertSilverseaWritesAllowed
} = require(path.join(root, "netlify/functions/lib/silversea-discovery-mode"));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

export const M3_RUNNER_PATH = "scripts/run-silversea-m3-update-canary.mjs";

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

export function parseM3Args(argv = process.argv) {
  const args = { preflight: false, writeFixture: false, apply: false, confirm: null, today: null };
  for (const arg of argv.slice(2)) {
    if (arg === "--preflight") args.preflight = true;
    if (arg === "--write-fixture") args.writeFixture = true;
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--confirm=")) args.confirm = String(arg.split("=")[1]).trim();
    if (arg.startsWith("--today=")) args.today = String(arg.split("=")[1]).trim();
  }
  if (args.apply) args.preflight = true;
  if (!args.preflight && !args.writeFixture && !args.apply) args.preflight = true;
  return args;
}

export function assertM3ApplyAllowed(args) {
  if (!args.apply) return;
  if (args.confirm !== M3_APPLY_CONFIRMATION_TOKEN) {
    throw new Error("m3_apply_confirmation_required");
  }
  if (String(process.env.SILVERSEA_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
    throw new Error("SILVERSEA_DISCOVERY_WRITE_ENABLED must be true for apply");
  }
}

function countDuplicateOfficialIds(rows) {
  const seen = new Set();
  const dupes = [];
  for (const row of rows) {
    const id = String(row.official_sailing_id || "").toUpperCase();
    if (!id) continue;
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  return dupes;
}

async function loadContext(today) {
  const sb = createMaintenanceSupabase(root);
  const line = (await sb(`ci_cruise_lines?slug=eq.${adapter.LINE_SLUG}&select=id,name,slug&limit=1`))?.[0];
  if (!line) throw new Error("Silversea line not found");

  const productionIndex = await indexExistingSilverseaRecords(sb, line.id);
  const destinations = adapter.catalogueDestinations(await loadClassificationDestinations(async (q) => sb(q)));
  const ships = await sb(
    `ci_cruise_ships?cruise_line_id=eq.${line.id}&select=id,name,cruise_line_id,official_line_ship_id`
  );

  const simulation = await adapter.simulateSilverseaInventory({
    cruiseLine: line,
    ships,
    destinations,
    existingRows: productionIndex.rows,
    today,
    concurrency: 6
  });

  return { sb, line, productionIndex, simulation, today };
}

export async function runSilverseaM3UpdateCanary(options = {}) {
  const startedAt = new Date().toISOString();
  const args = options.args || parseM3Args();
  const today = options.today || args.today || perthCalendarDate();
  const runId =
    options.runId ||
    `silversea-m3-maintenance-update-${CANARY_OFFICIAL_ID}-${startedAt.replace(/[:.]/g, "-")}`;

  assertM3ApplyAllowed(args);

  const { sb, line, productionIndex, simulation } = await loadContext(today);
  const inventory = classifySilverseaOfficialInventory(productionIndex.rows);
  const duplicateBefore = countDuplicateOfficialIds(productionIndex.rows.filter((r) => r.official_sailing_id));

  const productionBefore = {
    total: inventory.total,
    classic_stored_official: inventory.classic_stored_official_total,
    classic_active: inventory.classic_active_official,
    classic_expired: inventory.classic_expired_official,
    expedition_stored_official: inventory.expedition_stored_official_total,
    expedition_active: inventory.expedition_active_official,
    expedition_expired: inventory.expedition_expired_official,
    legacy: inventory.legacy,
    duplicate_official_ids: duplicateBefore
  };

  let fixture = fs.existsSync(FIXTURE_PATH) ? JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) : null;

  const preflight = await validateM3Preflight({
    simulation,
    productionIndex,
    cruiseLine: line,
    today,
    fixture
  });

  const sourceHealth = preflight.sourceHealthy && preflight.populationGuard.ok ? "PASS" : "FAIL";

  if (!preflight.ok) {
    return {
      ok: false,
      phase: "M3",
      run_id: runId,
      stopped: true,
      reason: "preflight_failed",
      failures: preflight.failures,
      classification: preflight.proposalRecord?.classification || null,
      changed_fields: preflight.proposalRecord?.changed_fields || [],
      guards: preflight.guards,
      source_health: sourceHealth,
      production_before: productionBefore,
      production_uuid: preflight.productionRow?.id || null,
      weekly_maintenance_enabled: false,
      git_sha: git("git rev-parse HEAD")
    };
  }

  if (args.writeFixture || !fixture) {
    fixture = buildM3CanaryFixture({
      runId,
      simulation,
      productionRow: preflight.productionRow,
      proposalRecord: preflight.proposalRecord,
      guards: preflight.guards,
      cruiseLine: line,
      productionBefore,
      sourceHealth
    });
    if (args.writeFixture) {
      fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
      fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
      fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
      assignPersistedFixtureHash(fixture);
      fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
    }
  }

  const frozenBefore = verifyFrozenBeforeMatch(preflight.productionRow, fixture);
  if (!frozenBefore.ok) {
    return {
      ok: false,
      phase: "M3",
      run_id: runId,
      stopped: true,
      reason: "frozen_before_failed",
      issues: frozenBefore.issues,
      weekly_maintenance_enabled: false
    };
  }

  const report = {
    phase: "M3",
    run_id: runId,
    started_at: startedAt,
    mode: args.apply ? "apply" : "preflight",
    official_sailing_id: CANARY_OFFICIAL_ID,
    production_uuid: fixture.production_uuid,
    fixture_path: M3_FIXTURE_REL,
    fixture_count: 1,
    fixture_hash: fixture.fixture_hash,
    source_health: sourceHealth,
    classification: preflight.proposalRecord.classification,
    update_allowlist: fixture.update_allowlist,
    changed_fields: preflight.proposalRecord.changed_fields,
    field_diff_table: preflight.fieldDiffTable,
    guards: preflight.guards,
    immutable_fields: IMMUTABLE_FIELDS,
    planned_inserts: 0,
    planned_updates: EXPECTED_UPDATES,
    planned_deletes: 0,
    planned_hides: 0,
    planned_reference_writes: 0,
    production_before: productionBefore,
    hardened_controlled_production: true,
    runner: M3_RUNNER_PATH,
    weekly_maintenance_enabled: false,
    git_sha: git("git rev-parse HEAD")
  };

  if (!args.apply) {
    report.ended_at = new Date().toISOString();
    report.ok = true;
    return report;
  }

  const store = new ControlledProductionRunStore(REPORT_DIR, runId);
  let rollbackManifest = buildM3RollbackManifest({ runId, fixture, productionBefore });
  let applyReport = buildApplyReportLifecycle({
    runId,
    createdAt: startedAt,
    fixturePath: M3_FIXTURE_REL,
    operation: M3_OPERATION,
    lineSlug: adapter.LINE_SLUG,
    expectedInserts: 0,
    productionBefore
  });
  applyReport.phase = "M3";
  applyReport.expected_updates = EXPECTED_UPDATES;
  applyReport.update_allowlist = fixture.update_allowlist.slice();
  applyReport.hardened_runner = true;

  const rollbackPath = store.persistPreparedRollback(rollbackManifest);
  const applyReportPath = store.persistPreparedReport(applyReport);
  applyReport = updateReportLifecycle(applyReport, {
    rollback_manifest_path: rollbackPath,
    apply_report_path: applyReportPath
  });
  store.updateReport(applyReport);

  const preparedRollback = store.readRollback();
  const preparedReport = JSON.parse(fs.readFileSync(applyReportPath, "utf8"));
  if (preparedRollback?.status !== RUN_STATUS.PREPARED || preparedReport.status !== RUN_STATUS.PREPARED) {
    throw new Error("prepared_state_reread_failed — STOP WITH ZERO WRITES");
  }

  const timings = { started_at: startedAt };
  assertSilverseaWritesAllowed(resolveSilverseaDiscoveryMode("production_write"));

  let writeResult = null;
  let updatedRow = null;
  let verification = null;
  let underLockBeforeRows = null;

  const hardenedResult = await executeHardenedControlledProductionApply(
    sb,
    {
      runId,
      lineSlug: adapter.LINE_SLUG,
      operation: M3_OPERATION,
      performWrites: true,
      leaseSeconds: DEFAULT_GLOBAL_LEASE_SECONDS,
      underLockRecheck: async () => {
        const row = (
          await sb(
            `discovered_cruises?id=eq.${encodeURIComponent(fixture.production_uuid)}&official_sailing_id=eq.${encodeURIComponent(
              CANARY_OFFICIAL_ID
            )}&select=*&limit=1`
          )
        )?.[0];
        if (!row) return { ok: false, reason: "under_lock_target_missing" };
        const frozen = verifyFrozenBeforeMatch(row, fixture);
        if (!frozen.ok) return { ok: false, reason: "under_lock_frozen_before_mismatch", issues: frozen.issues };
        return { ok: true, proposed_updates: EXPECTED_UPDATES, proposed_inserts: 0 };
      }
    },
    {
      onLockAcquired: async (lockMeta) => {
        underLockBeforeRows = (await indexExistingSilverseaRecords(sb, line.id)).rows;
        rollbackManifest.status = RUN_STATUS.LOCK_ACQUIRED;
        store.updateRollback(rollbackManifest);
        applyReport = updateReportLifecycle(applyReport, {
          status: RUN_STATUS.LOCK_ACQUIRED,
          global_lock: lockMeta.observability || lockMeta
        });
        store.updateReport(applyReport);
        timings.lock_acquired_at = new Date().toISOString();
      },
      mutate: async () => {
        timings.mutation_started_at = new Date().toISOString();
        rollbackManifest.status = RUN_STATUS.MUTATING;
        store.updateRollback(rollbackManifest);
        applyReport = updateReportLifecycle(applyReport, { status: RUN_STATUS.MUTATING });
        store.updateReport(applyReport);
        const result = await applyM3UpdateOnly(sb, { fixture, runId });
        timings.mutation_ended_at = new Date().toISOString();
        if (result.ok && result.row?.id) {
          rollbackManifest.updated_record_ids = rollbackManifest.updated_record_ids || [];
          if (!rollbackManifest.updated_record_ids.includes(result.row.id)) {
            rollbackManifest.updated_record_ids.push(result.row.id);
          }
          rollbackManifest.updated_official_sailing_ids = [CANARY_OFFICIAL_ID];
          store.updateRollback(rollbackManifest);
        }
        return result;
      },
      onWriteComplete: async ({ writeResult: wr }) => {
        writeResult = wr;
        rollbackManifest.status = RUN_STATUS.WRITE_COMPLETE;
        rollbackManifest.updated_count = wr.stats?.updated || 0;
        store.updateRollback(rollbackManifest);
        applyReport = updateReportLifecycle(applyReport, {
          status: RUN_STATUS.WRITE_COMPLETE,
          write_result: wr.stats
        });
        store.updateReport(applyReport);
      },
      onVerificationStart: async () => {
        timings.verification_started_at = new Date().toISOString();
        rollbackManifest.status = RUN_STATUS.VERIFYING;
        store.updateRollback(rollbackManifest);
        applyReport = updateReportLifecycle(applyReport, { status: RUN_STATUS.VERIFYING });
        store.updateReport(applyReport);
      },
      verifyUnderLock: async () => {
        updatedRow = (
          await sb(
            `discovered_cruises?id=eq.${encodeURIComponent(fixture.production_uuid)}&official_sailing_id=eq.${encodeURIComponent(
              CANARY_OFFICIAL_ID
            )}&select=*&limit=1`
          )
        )?.[0];

        const rowMatch = compareUpdatedRowToFixture(updatedRow, fixture);
        const indexedAfter = await indexExistingSilverseaRecords(sb, line.id);
        const inventoryAfter = classifySilverseaOfficialInventory(indexedAfter.rows);

        const protection = await verifyM3Protection({
          beforeSnapshot: {
            officialRows: (underLockBeforeRows || productionIndex.rows).filter((r) => r.official_sailing_id),
            legacyRows: (underLockBeforeRows || productionIndex.rows).filter((r) => !r.official_sailing_id)
          },
          afterRows: indexedAfter.rows,
          targetUuid: fixture.production_uuid,
          today
        });

        const rowDeltaOk =
          inventoryAfter.total === productionBefore.total &&
          inventoryAfter.classic_stored_official_total === productionBefore.classic_stored_official &&
          inventoryAfter.expedition_stored_official_total === productionBefore.expedition_stored_official &&
          inventoryAfter.legacy === productionBefore.legacy;

        const aggregateOk =
          writeResult?.ok === true &&
          writeResult.stats?.updated === 1 &&
          writeResult.stats?.inserted === 0 &&
          rowMatch.ok &&
          protection.ok &&
          rowDeltaOk;

        verification = buildAuthoritativeVerificationResult({
          aggregateOk,
          verification: {
            row_match: rowMatch,
            protection,
            inventory_after: inventoryAfter,
            row_delta_ok: rowDeltaOk,
            updated_uuid: updatedRow?.id
          },
          updated_official_sailing_id: CANARY_OFFICIAL_ID
        });

        timings.verification_ended_at = new Date().toISOString();
        return verification;
      }
    }
  );

  timings.ended_at = new Date().toISOString();
  const indexedPostLock = await indexExistingSilverseaRecords(sb, line.id);
  const postProposal = buildSilverseaWeeklyMaintenanceProposal({
    simulation,
    productionIndex: indexedPostLock,
    cruiseLine: line,
    today
  });
  const postRecord = postProposal.records.find((r) => r.official_sailing_id === CANARY_OFFICIAL_ID);
  const repeatBlock = proveRepeatUpdateBlocked(indexedPostLock, fixture);

  const finalReport = {
    ...report,
    ok: hardenedResult.run_status === RUN_STATUS.COMPLETE && verification?.ok === true,
    ended_at: timings.ended_at,
    hardened_result: hardenedResult,
    write_result: writeResult,
    verification,
    performance: {
      mutation_duration_ms:
        timings.mutation_started_at && timings.mutation_ended_at
          ? new Date(timings.mutation_ended_at) - new Date(timings.mutation_started_at)
          : null,
      verification_duration_ms:
        timings.verification_started_at && timings.verification_ended_at
          ? new Date(timings.verification_ended_at) - new Date(timings.verification_started_at)
          : null,
      lock_held_duration_ms:
        timings.lock_acquired_at && timings.ended_at
          ? new Date(timings.ended_at) - new Date(timings.lock_acquired_at)
          : null
    },
    post_lock: {
      classification: postRecord?.classification || null,
      update_eligible_again: postRecord?.classification === MAINTENANCE_CLASSIFICATION.UPDATE_ELIGIBLE,
      repeat_update_blocked: repeatBlock.ok
    },
    production_summary: {
      inserts: 0,
      updates: writeResult?.stats?.updated || 0,
      deletes: 0,
      hides: 0,
      reference_writes: 0,
      row_delta: 0
    }
  };

  const outPath = path.join(REPORT_DIR, `${runId}.json`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(finalReport, null, 2)}\n`);
  return finalReport;
}

async function main() {
  const args = parseM3Args();
  const result = await runSilverseaM3UpdateCanary({ args });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
