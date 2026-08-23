#!/usr/bin/env node
/**
 * Silversea M2 — controlled weekly-maintenance INSERT canary (exactly WH281005017).
 *
 *   node scripts/run-silversea-m2-insert-canary.mjs --preflight
 *   node scripts/run-silversea-m2-insert-canary.mjs --write-fixture
 *   SILVERSEA_DISCOVERY_WRITE_ENABLED=true node scripts/run-silversea-m2-insert-canary.mjs \
 *     --apply --confirm=SILVERSEA-M2-MAINTENANCE-INSERT-CANARY
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
const FIXTURE_PATH = path.join(root, "scripts/fixtures/silversea/m2-maintenance-insert-canary-WH281005017.json");

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { indexExistingSilverseaRecords } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const {
  buildSilverseaWeeklyMaintenanceProposal
} = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-proposal"));
const { MAINTENANCE_CLASSIFICATION } = require(path.join(root, "netlify/functions/lib/silversea-weekly-maintenance-policy"));
const { classifySilverseaOfficialInventory, isClassicStoredOfficialRow } = require(path.join(
  root,
  "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"
));
const { snapshotProtectionRows, verifyProtectionSnapshots } = require(path.join(
  root,
  "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"
));
const {
  CANARY_OFFICIAL_ID,
  M2_FIXTURE_REL,
  M2_OPERATION,
  M2_APPLY_CONFIRMATION_TOKEN,
  EXPECTED_INSERTS,
  buildM2CanaryFixture,
  validateM2Preflight,
  verifyFixtureAgainstPreflight,
  enrichCandidateForM2,
  applyM2InsertOnly,
  compareInsertedRowToFixture,
  verifyM2Protection,
  proveRepeatInsertBlocked,
  buildM2RollbackManifest,
  buildAuthoritativeVerificationResult,
  assignPersistedFixtureHash,
  hashFixtureContent
} = require(path.join(root, "netlify/functions/lib/silversea-m2-maintenance-insert-canary"));
const {
  RUN_STATUS,
  buildApplyReportLifecycle,
  updateReportLifecycle,
  ControlledProductionRunStore,
  executeHardenedControlledProductionApply,
  appendInsertedRecord,
  finalizeControlledProductionUnderLock,
  persistPostLockReleaseMetadata,
  isSuccessfulControlledProductionRun
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

export const M2_RUNNER_PATH = "scripts/run-silversea-m2-insert-canary.mjs";
export const M1_UPDATE_CANARY_ID = "SL270927009";
export const M1_SOURCE_ABSENCE_ID = "SN280222C25";

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

export function parseM2Args(argv = process.argv) {
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

export function assertM2ApplyAllowed(args) {
  if (!args.apply) return;
  if (args.confirm !== M2_APPLY_CONFIRMATION_TOKEN) {
    throw new Error("m2_apply_confirmation_required");
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

function auditIdentityCollisions(productionRows, candidate) {
  const officialCollision = productionRows.some(
    (r) => String(r.official_sailing_id).toUpperCase() === CANARY_OFFICIAL_ID
  );
  const shipDateMatches = productionRows.filter(
    (r) =>
      r.ship_id === candidate.ship_id &&
      r.departure_date === candidate.departure_date &&
      String(r.official_sailing_id).toUpperCase() !== CANARY_OFFICIAL_ID
  );
  return {
    official_identity_collision: officialCollision,
    same_ship_departure_count: shipDateMatches.length,
    same_ship_departure_ids: shipDateMatches.map((r) => r.official_sailing_id)
  };
}

function buildInsertPayloadTable(fixture) {
  const payload = fixture.insert_payload;
  const candidate = fixture.candidate;
  const fields = [
    ["id", payload.id || "(generated at insert)", "application", "YES", "new row UUID"],
    ["official_sailing_id", payload.official_sailing_id, "source", "YES", "identity key"],
    ["cruise_line_id", payload.cruise_line_id, "reference", "YES", "Silversea line"],
    ["ship_id", payload.ship_id, "reference", "YES", "ship resolution"],
    ["title", payload.title, "source", "YES", "derived title"],
    ["departure_date", payload.departure_date, "source", "YES", "sailing start"],
    ["return_date", payload.return_date, "source", "YES", "sailing end"],
    ["nights", payload.nights, "source", "YES", "duration"],
    ["departure_port", payload.departure_port, "source", "YES", "embark port"],
    ["destination_id", payload.destination_id, "reference", "YES", "destination mapping"],
    ["official_url", payload.official_url, "source", "YES", "canonical URL"],
    ["source_url", payload.source_url || candidate.source_url, "source", "YES", "discovery URL"],
    ["itinerary", payload.itinerary, "source", "YES", "text itinerary"],
    ["itinerary_ports", payload.itinerary_ports, "source", "YES", "includeItineraryPorts=true"],
    ["raw_extract", payload.raw_extract || candidate.raw_extract, "source", "YES", "business fingerprint"],
    ["status", payload.status, "lifecycle", "YES", "initial active"]
  ];
  return fields.map(([field, value, source, inserted, reason]) => ({
    field,
    value,
    source,
    inserted,
    reason
  }));
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

export async function runSilverseaM2InsertCanary(options = {}) {
  const startedAt = new Date().toISOString();
  const args = options.args || parseM2Args();
  const today = options.today || args.today || perthCalendarDate();
  const runId =
    options.runId ||
    `silversea-m2-maintenance-insert-${CANARY_OFFICIAL_ID}-${startedAt.replace(/[:.]/g, "-")}`;

  assertM2ApplyAllowed(args);

  const { sb, line, productionIndex, simulation } = await loadContext(today);
  const inventory = classifySilverseaOfficialInventory(productionIndex.rows);
  const duplicateBefore = countDuplicateOfficialIds(productionIndex.rows.filter((r) => r.official_sailing_id));

  const preflight = await validateM2Preflight({
    sb,
    adapter,
    simulation,
    productionIndex,
    cruiseLine: line,
    today
  });

  const sourceHealth = preflight.sourceHealthy && preflight.populationGuard.ok ? "PASS" : "FAIL";
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

  if (!preflight.ok) {
    return {
      ok: false,
      phase: "M2",
      run_id: runId,
      stopped: true,
      reason: "preflight_failed",
      failures: preflight.failures,
      source_health: sourceHealth,
      production_before: productionBefore,
      weekly_maintenance_enabled: false
    };
  }

  let fixture = null;
  if (fs.existsSync(FIXTURE_PATH)) {
    fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  }

  if (args.writeFixture || !fixture) {
    fixture = buildM2CanaryFixture({
      runId,
      simulation,
      normalised: preflight.normalised,
      cruiseLine: line,
      productionBefore,
      sourceHealth,
      classificationRecord: preflight.proposalRecord
    });
    if (args.writeFixture) {
      fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
      fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
      fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
      assignPersistedFixtureHash(fixture);
      fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
    }
  }

  const fixtureCheck = verifyFixtureAgainstPreflight(fixture, preflight);
  if (!fixtureCheck.ok) {
    return {
      ok: false,
      phase: "M2",
      run_id: runId,
      stopped: true,
      reason: "fixture_mismatch",
      fixture_issues: fixtureCheck.issues,
      source_health: sourceHealth,
      production_before: productionBefore,
      weekly_maintenance_enabled: false
    };
  }

  const candidateForInsert = enrichCandidateForM2(fixture.candidate, runId);
  const identityAudit = auditIdentityCollisions(productionIndex.rows, candidateForInsert);
  const insertPayloadTable = buildInsertPayloadTable(fixture);
  const protectionSnapshot = snapshotProtectionRows(
    productionIndex.rows.filter((r) => r.official_sailing_id),
    new Set()
  );

  const report = {
    phase: "M2",
    run_id: runId,
    started_at: startedAt,
    mode: args.apply ? "apply" : "preflight",
    official_sailing_id: CANARY_OFFICIAL_ID,
    fixture_path: M2_FIXTURE_REL,
    fixture_count: 1,
    fixture_hash: fixture.fixture_hash,
    source_health: sourceHealth,
    source_snapshot_fingerprint: fixture.source_snapshot_fingerprint,
    source_snapshot_timestamp: fixture.source_snapshot_timestamp,
    production_before: productionBefore,
    classification: preflight.proposalRecord?.classification,
    product_type: "classic",
    special_product_deferred: false,
    itinerary_ports_count: fixture.itinerary_ports_count,
    itinerary_ports: fixture.itinerary_ports,
    identity_audit: identityAudit,
    planned_inserts: EXPECTED_INSERTS,
    planned_updates: 0,
    planned_deletes: 0,
    planned_hides: 0,
    planned_reference_writes: 0,
    insert_payload_table: insertPayloadTable,
    insert_payload_itinerary_ports_match: true,
    hardened_controlled_production: true,
    runner: M2_RUNNER_PATH,
    weekly_maintenance_enabled: false,
    git_sha: git("git rev-parse HEAD")
  };

  if (!args.apply) {
    report.ended_at = new Date().toISOString();
    report.ok = true;
    return report;
  }

  const store = new ControlledProductionRunStore(REPORT_DIR, runId);
  let rollbackManifest = buildM2RollbackManifest({
    runId,
    fixture,
    productionBefore,
    insertedUuid: null
  });
  let applyReport = buildApplyReportLifecycle({
    runId,
    createdAt: startedAt,
    fixturePath: M2_FIXTURE_REL,
    operation: M2_OPERATION,
    lineSlug: adapter.LINE_SLUG,
    expectedInserts: EXPECTED_INSERTS,
    productionBefore
  });
  applyReport.phase = "M2";
  applyReport.expected_updates = 0;
  applyReport.hardened_runner = true;
  applyReport.preflight_gates = { source_health: sourceHealth, fixture_ok: true, classification: MAINTENANCE_CLASSIFICATION.INSERT_ELIGIBLE };

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
  let insertedRow = null;
  let verification = null;
  let underLockBeforeRows = null;

  const hardenedResult = await executeHardenedControlledProductionApply(
    sb,
    {
      runId,
      lineSlug: adapter.LINE_SLUG,
      operation: M2_OPERATION,
      performWrites: true,
      leaseSeconds: DEFAULT_GLOBAL_LEASE_SECONDS,
      underLockRecheck: async () => {
        const existing = (
          await sb(
            `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&official_sailing_id=eq.${encodeURIComponent(
              CANARY_OFFICIAL_ID
            )}&select=id,official_sailing_id&limit=1`
          )
        )?.[0];
        if (existing?.official_sailing_id) {
          return { ok: false, reason: "under_lock_identity_present", id: existing.id };
        }
        return { ok: true, proposed_inserts: EXPECTED_INSERTS, proposed_updates: 0 };
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
        const result = await applyM2InsertOnly(sb, { candidate: candidateForInsert, runId });
        timings.mutation_ended_at = new Date().toISOString();
        if (result.ok && result.row?.id) {
          appendInsertedRecord(rollbackManifest, {
            discoveredCruiseId: result.row.id,
            officialSailingId: CANARY_OFFICIAL_ID
          });
          store.updateRollback(rollbackManifest);
        }
        return result;
      },
      onWriteComplete: async ({ writeResult: wr }) => {
        writeResult = wr;
        rollbackManifest.status = RUN_STATUS.WRITE_COMPLETE;
        rollbackManifest.inserted_count = wr.stats?.inserted || 0;
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
        insertedRow = (
          await sb(
            `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&official_sailing_id=eq.${encodeURIComponent(
              CANARY_OFFICIAL_ID
            )}&select=*&limit=2`
          )
        ) || [];
        if (insertedRow.length !== 1) {
          return { ok: false, reason: "inserted_row_count", count: insertedRow.length };
        }
        insertedRow = insertedRow[0];

        const rowMatch = compareInsertedRowToFixture(insertedRow, fixture);
        const indexedAfter = await indexExistingSilverseaRecords(sb, line.id);
        const inventoryAfter = classifySilverseaOfficialInventory(indexedAfter.rows);
        const protection = await verifyM2Protection({
          sb,
          lineId: line.id,
          beforeSnapshot: {
            officialRows: (underLockBeforeRows || productionIndex.rows).filter((r) => r.official_sailing_id),
            legacyRows: (underLockBeforeRows || productionIndex.rows).filter((r) => !r.official_sailing_id)
          },
          afterRows: indexedAfter.rows,
          today
        });

        const updateCanary = indexedAfter.byOfficialId.get(M1_UPDATE_CANARY_ID);
        const absenceCanary = indexedAfter.byOfficialId.get(M1_SOURCE_ABSENCE_ID);
        const updateCanaryBefore = productionIndex.byOfficialId.get(M1_UPDATE_CANARY_ID);
        const absenceCanaryBefore = productionIndex.byOfficialId.get(M1_SOURCE_ABSENCE_ID);

        const updateCanaryProtected = (() => {
          if (!updateCanaryBefore || !updateCanary) return true;
          const beforeSnap = snapshotProtectionRows([updateCanaryBefore], new Set());
          return verifyProtectionSnapshots(beforeSnap, [updateCanary], new Set(), { perthToday: today }).ok;
        })();
        const absenceCanaryProtected = (() => {
          if (!absenceCanaryBefore || !absenceCanary) return true;
          const beforeSnap = snapshotProtectionRows([absenceCanaryBefore], new Set());
          return verifyProtectionSnapshots(beforeSnap, [absenceCanary], new Set(), { perthToday: today }).ok;
        })();

        const duplicateAfter = countDuplicateOfficialIds(indexedAfter.rows.filter((r) => r.official_sailing_id));
        const rowDeltaOk =
          inventoryAfter.total === productionBefore.total + 1 &&
          inventoryAfter.classic_stored_official_total === productionBefore.classic_stored_official + 1 &&
          inventoryAfter.expedition_stored_official_total === productionBefore.expedition_stored_official &&
          inventoryAfter.legacy === productionBefore.legacy;

        const aggregateOk =
          writeResult?.ok === true &&
          writeResult.stats?.inserted === 1 &&
          writeResult.stats?.updated === 0 &&
          rowMatch.ok &&
          protection.ok &&
          duplicateAfter.length === 0 &&
          rowDeltaOk &&
          updateCanaryProtected &&
          absenceCanaryProtected;

        verification = buildAuthoritativeVerificationResult({
          aggregateOk,
          verification: {
            row_match: rowMatch,
            protection,
            inventory_after: inventoryAfter,
            row_delta_ok: rowDeltaOk,
            duplicate_official_ids: duplicateAfter,
            update_canary_protected: updateCanaryProtected,
            absence_canary_protected: absenceCanaryProtected,
            inserted_uuid: insertedRow.id,
            itinerary_ports_persistence: {
              expected_count: fixture.itinerary_ports.length,
              stored_count: (insertedRow.itinerary_ports || []).length,
              equal: rowMatch.ok && !rowMatch.issues.includes("itinerary_ports")
            }
          },
          inserted_official_sailing_id: CANARY_OFFICIAL_ID
        });

        timings.verification_ended_at = new Date().toISOString();
        return verification;
      },
      finalizeUnderLock: async ({ verificationResult, verificationError, writeResult: wr }) => {
        const finalized = finalizeControlledProductionUnderLock({
          store,
          rollbackManifest,
          applyReport,
          verificationResult,
          verificationError,
          writeResult: wr,
          performance: {
            mutation_duration_ms:
              timings.mutation_started_at && timings.mutation_ended_at
                ? new Date(timings.mutation_ended_at) - new Date(timings.mutation_started_at)
                : null,
            verification_duration_ms:
              timings.verification_started_at && timings.verification_ended_at
                ? new Date(timings.verification_ended_at) - new Date(timings.verification_started_at)
                : null
          },
          validateWrite: ({ finalStatus, writeResult: writeCheck }) => {
            if (writeCheck.stats.inserted !== EXPECTED_INSERTS) {
              throw new Error(`insert_count_mismatch:${writeCheck.stats.inserted}`);
            }
            if (finalStatus !== RUN_STATUS.VERIFIED) {
              throw new Error("write_succeeded_verification_failed");
            }
          }
        });
        applyReport = finalized.applyReport;
        rollbackManifest = finalized.rollbackManifest;
        return { persisted: true, final_status: finalized.finalStatus };
      }
    }
  );

  timings.ended_at = new Date().toISOString();
  if (!hardenedResult.blocked && applyReport) {
    applyReport = persistPostLockReleaseMetadata({
      store,
      applyReport,
      globalLockObservability: hardenedResult.global_lock,
      timings
    });
  }

  const lockObs = hardenedResult.global_lock || {};
  const lockHeldMs =
    timings.lock_acquired_at && timings.ended_at
      ? new Date(timings.ended_at) - new Date(timings.lock_acquired_at)
      : null;

  const indexedPostLock = await indexExistingSilverseaRecords(sb, line.id);
  const postProposal = buildSilverseaWeeklyMaintenanceProposal({
    simulation,
    productionIndex: indexedPostLock,
    cruiseLine: line,
    today
  });
  const postRecord = postProposal.records.find(
    (r) => String(r.official_sailing_id).toUpperCase() === CANARY_OFFICIAL_ID
  );
  const repeatBlock = proveRepeatInsertBlocked(indexedPostLock);

  const finalReport = {
    ...report,
    ok: isSuccessfulControlledProductionRun(hardenedResult.run_status, verification) && !hardenedResult.blocked,
    ended_at: timings.ended_at,
    hardened_result: {
      run_status: hardenedResult.run_status,
      lock_released: hardenedResult.global_lock?.global_lock_released === true
    },
    write_result: writeResult,
    verification,
    inserted_uuid: insertedRow?.id || null,
    performance: {
      mutation_duration_ms:
        timings.mutation_started_at && timings.mutation_ended_at
          ? new Date(timings.mutation_ended_at) - new Date(timings.mutation_started_at)
          : null,
      verification_duration_ms:
        timings.verification_started_at && timings.verification_ended_at
          ? new Date(timings.verification_ended_at) - new Date(timings.verification_started_at)
          : null,
      lock_held_duration_ms: lockHeldMs,
      lease_seconds: DEFAULT_GLOBAL_LEASE_SECONDS,
      lease_headroom_seconds: lockObs.expires_at
        ? Math.floor((new Date(lockObs.expires_at) - new Date(timings.ended_at)) / 1000)
        : null
    },
    post_lock: {
      wh281005017_count: (indexedPostLock.byOfficialId.has(CANARY_OFFICIAL_ID) ? 1 : 0),
      post_insert_classification: postRecord?.classification || null,
      duplicate_insert_proposal_blocked: repeatBlock.ok
    },
    production_summary: {
      inserts: writeResult?.stats?.inserted || 0,
      updates: writeResult?.stats?.updated || 0,
      deletes: 0,
      hides: 0,
      reference_writes: 0,
      row_delta: verification?.verification?.inventory_after
        ? verification.verification.inventory_after.total - productionBefore.total
        : null
    }
  };

  const outPath = path.join(REPORT_DIR, `${runId}.json`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(finalReport, null, 2)}\n`);

  return finalReport;
}

async function main() {
  const args = parseM2Args();
  const result = await runSilverseaM2InsertCanary({ args });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
