#!/usr/bin/env node
/**
 * Silversea M2R — read-only recovery attestation for M2 insert-canary verification failure.
 *
 *   node scripts/run-silversea-m2r-recovery-attestation.mjs
 *   node scripts/run-silversea-m2r-recovery-attestation.mjs --read-only-lock
 *
 * ZERO discovered_cruises mutations.
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
const HISTORICAL_APPLY_REPORT = path.join(
  root,
  "reports/controlled-production-apply-silversea-m2-maintenance-insert-WH281005017-2026-08-23T01-33-26-599Z.json"
);
const HISTORICAL_ROLLBACK = path.join(
  root,
  "reports/controlled-production-rollback-silversea-m2-maintenance-insert-WH281005017-2026-08-23T01-33-26-599Z.json"
);
const HISTORICAL_SUMMARY = path.join(
  root,
  "reports/silversea-m2-maintenance-insert-WH281005017-2026-08-23T01-33-26-599Z.json"
);

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { indexExistingSilverseaRecords } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const { buildSilverseaWeeklyMaintenanceProposal } = require(path.join(
  root,
  "netlify/functions/lib/silversea-weekly-maintenance-proposal"
));
const { classifySilverseaOfficialInventory, isExpeditionStoredOfficialRow } = require(path.join(
  root,
  "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"
));
const { snapshotProtectionRows, verifyProtectionSnapshots } = require(path.join(
  root,
  "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"
));
const {
  CANARY_OFFICIAL_ID,
  validateM2Preflight,
  proveRepeatInsertBlocked
} = require(path.join(root, "netlify/functions/lib/silversea-m2-maintenance-insert-canary"));
const m2r = require(path.join(root, "netlify/functions/lib/silversea-m2r-recovery-attestation"));
const {
  GLOBAL_CRUISE_WRITE_LOCK_KEY,
  acquireGlobalCruiseWriteLock,
  releaseGlobalCruiseWriteLock
} = require(path.join(root, "netlify/functions/lib/cruise-discovery-global-write-lock"));
const { loadMaintenanceLockStatus } = require(path.join(
  root,
  "netlify/functions/lib/cruise-discovery-maintenance-locks"
));
const { perthCalendarDate } = require(path.join(root, "netlify/functions/lib/public-discovered-cruise-inventory"));
const { loadClassificationDestinations } = require(path.join(root, "netlify/functions/lib/destination-queries"));
const { createMaintenanceSupabase } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

export const M2R_RUNNER_PATH = "scripts/run-silversea-m2r-recovery-attestation.mjs";

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

export function parseM2RArgs(argv = process.argv) {
  const args = { readOnlyLock: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--read-only-lock") args.readOnlyLock = true;
  }
  return args;
}

function baselineTimingGapMs() {
  return (
    new Date(m2r.HISTORICAL_LOCK_ACQUIRED_AT).getTime() -
    new Date(m2r.HISTORICAL_PREFLIGHT_STARTED_AT).getTime()
  );
}

async function loadProductionContext(today) {
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

export async function runSilverseaM2RRecoveryAttestation(options = {}) {
  const startedAt = new Date().toISOString();
  const args = options.args || parseM2RArgs();
  const today = options.today || perthCalendarDate();
  const runId = options.runId || `silversea-m2r-recovery-attestation-${startedAt.replace(/[:.]/g, "-")}`;

  const historicalHashes = {
    apply_report: fs.existsSync(HISTORICAL_APPLY_REPORT) ? m2r.hashFile(HISTORICAL_APPLY_REPORT) : null,
    rollback: fs.existsSync(HISTORICAL_ROLLBACK) ? m2r.hashFile(HISTORICAL_ROLLBACK) : null,
    summary: fs.existsSync(HISTORICAL_SUMMARY) ? m2r.hashFile(HISTORICAL_SUMMARY) : null
  };

  const historicalApply = fs.existsSync(HISTORICAL_APPLY_REPORT)
    ? JSON.parse(fs.readFileSync(HISTORICAL_APPLY_REPORT, "utf8"))
    : null;
  const historicalSummary = fs.existsSync(HISTORICAL_SUMMARY)
    ? JSON.parse(fs.readFileSync(HISTORICAL_SUMMARY, "utf8"))
    : null;

  const runnerSource = fs.readFileSync(
    path.join(root, "scripts/run-silversea-m2-insert-canary.mjs"),
    "utf8"
  );
  const orderingAudit = m2r.auditUnderLockSnapshotOrdering(runnerSource);

  const { sb, line, productionIndex, simulation } = await loadProductionContext(today);
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

  const lockStatus = await loadMaintenanceLockStatus(sb, GLOBAL_CRUISE_WRITE_LOCK_KEY);
  const historicalM2LockHeld =
    lockStatus.held === true && lockStatus.owner_id === m2r.HISTORICAL_M2_RUN_ID;

  const whRows =
    (await sb(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&official_sailing_id=eq.${encodeURIComponent(
        CANARY_OFFICIAL_ID
      )}&select=*`
    )) || [];
  const whRow = whRows.length === 1 ? whRows[0] : null;
  const payloadVerification = whRow ? m2r.verifyInsertedPayloadFields(whRow, fixture) : { ok: false, mismatches: ["row_missing"] };

  const inventory = classifySilverseaOfficialInventory(productionIndex.rows);
  const dupes = m2r.countDuplicateOfficialIds(productionIndex.rows.filter((r) => r.official_sailing_id));
  const attributable = m2r.computeM2AttributableDelta(inventory);

  const affectedExp =
    (await sb(
      `discovered_cruises?id=eq.${encodeURIComponent(m2r.HISTORICAL_AFFECTED_EXPEDITION_UUID)}&select=id,official_sailing_id,ship_id,departure_date,return_date,status,raw_extract,updated_at&limit=1`
    ))?.[0] || null;

  const shipName = affectedExp?.ship_id
    ? (await sb(`ci_cruise_ships?id=eq.${encodeURIComponent(affectedExp.ship_id)}&select=name&limit=1`))?.[0]?.name
    : null;

  const proposal = buildSilverseaWeeklyMaintenanceProposal({
    simulation,
    productionIndex,
    cruiseLine: line,
    today
  });
  const m1Record = m2r.classifyM1Record(proposal, CANARY_OFFICIAL_ID);
  const preflightBlock = await validateM2Preflight({
    simulation,
    productionIndex,
    cruiseLine: line,
    today
  });
  const repeatBlock = proveRepeatInsertBlocked(productionIndex);

  const sl = productionIndex.byOfficialId.get(m2r.M1_UPDATE_CANARY_ID);
  const sn = productionIndex.byOfficialId.get(m2r.M1_SOURCE_ABSENCE_ID);
  const slProtected = sl
    ? verifyProtectionSnapshots(snapshotProtectionRows([sl], new Set()), [sl], new Set(), { perthToday: today }).ok
    : true;
  const snProtected = sn
    ? verifyProtectionSnapshots(snapshotProtectionRows([sn], new Set()), [sn], new Set(), { perthToday: today }).ok
    : true;

  const expeditionRows = productionIndex.rows.filter(isExpeditionStoredOfficialRow);
  const legacyRows = productionIndex.rows.filter((r) => !r.official_sailing_id);

  const circular = m2r.auditCircularDependencyWarning();

  let readOnlyLock = { used: false, acquired: false, released: false, double_read_stable: null };
  if (args.readOnlyLock) {
    readOnlyLock.used = true;
    const lock = await acquireGlobalCruiseWriteLock(sb, {
      ownerId: runId,
      runId,
      lineSlug: adapter.LINE_SLUG,
      operation: "silversea_m2r_read_only_attestation",
      leaseSeconds: 300
    });
    readOnlyLock.acquired = lock.acquired === true;
    if (lock.acquired) {
      try {
        const first = await indexExistingSilverseaRecords(sb, line.id);
        const firstWh = first.byOfficialId.get(CANARY_OFFICIAL_ID);
        const second = await indexExistingSilverseaRecords(sb, line.id);
        const secondWh = second.byOfficialId.get(CANARY_OFFICIAL_ID);
        readOnlyLock.double_read_stable =
          first.rows.length === second.rows.length &&
          firstWh?.id === secondWh?.id &&
          JSON.stringify(firstWh?.itinerary_ports) === JSON.stringify(secondWh?.itinerary_ports);
        readOnlyLock.first_read_total = first.rows.length;
        readOnlyLock.second_read_total = second.rows.length;
      } finally {
        readOnlyLock.released = await releaseGlobalCruiseWriteLock(sb, {
          ownerId: runId
        });
      }
    }
  }

  const historicalPreserved = {
    apply_report: m2r.verifyHistoricalReportPreserved({
      reportPath: HISTORICAL_APPLY_REPORT,
      initialHash: historicalHashes.apply_report
    }),
    rollback: m2r.verifyHistoricalReportPreserved({
      reportPath: HISTORICAL_ROLLBACK,
      initialHash: historicalHashes.rollback
    }),
    summary: m2r.verifyHistoricalReportPreserved({
      reportPath: HISTORICAL_SUMMARY,
      initialHash: historicalHashes.summary
    })
  };

  const recoveryComplete =
    orderingAudit.ok &&
    whRows.length === 1 &&
    whRow?.id === m2r.HISTORICAL_INSERTED_UUID &&
    payloadVerification.ok &&
    preflightBlock.ok === false &&
    repeatBlock.ok === true &&
    m1Record?.classification !== m2r.MAINTENANCE_CLASSIFICATION.INSERT_ELIGIBLE &&
    dupes.length === 0 &&
    attributable.row_delta === 1 &&
    attributable.classic_delta === 1 &&
    attributable.expedition_delta === 0 &&
    attributable.legacy_delta === 0 &&
    slProtected &&
    snProtected &&
    historicalPreserved.apply_report.ok &&
    historicalPreserved.summary.ok &&
    !historicalM2LockHeld &&
    (!readOnlyLock.used || (readOnlyLock.released === true && readOnlyLock.double_read_stable === true));

  const attestation = {
    phase: "M2R",
    run_id: runId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    read_only: true,
    production_writes: {
      inserts: 0,
      updates: 0,
      deletes: 0,
      hides: 0,
      reference_writes: 0
    },
    git_sha: git("git rev-parse HEAD"),
    original_m2_run_id: m2r.HISTORICAL_M2_RUN_ID,
    original_historical_lifecycle: {
      run_status: historicalSummary?.hardened_result?.run_status || "WRITE_SUCCEEDED_VERIFICATION_FAILED",
      verified: false,
      complete: false
    },
    historical_report_rewritten: false,
    historical_report_preservation: historicalPreserved,
    fix_commit: m2r.M2_FIX_COMMIT,
    root_cause: {
      classification: "PRE_LOCK_BASELINE_TIMING",
      affected_expedition_uuid: m2r.HISTORICAL_AFFECTED_EXPEDITION_UUID,
      affected_expedition_official_id: affectedExp?.official_sailing_id || null,
      affected_ship: shipName,
      affected_departure: affectedExp?.departure_date || null,
      historical_changed_field: "raw_extract",
      pre_lock_snapshot_timestamp: m2r.HISTORICAL_PREFLIGHT_STARTED_AT,
      lock_acquisition_timestamp: m2r.HISTORICAL_LOCK_ACQUIRED_AT,
      baseline_timing_gap_ms: baselineTimingGapMs(),
      expedition_modified_by_m2: false,
      evidentiary_limits:
        "No time-travel before/after raw_extract pair for affected Expedition row at historical instant; conclusion based on insert path semantics, target isolation, and post-M2 stability.",
      m2_target_expedition_overlap: 0
    },
    under_lock_ordering_audit: orderingAudit,
    global_lock: {
      key: GLOBAL_CRUISE_WRITE_LOCK_KEY,
      current: lockStatus,
      historical_m2_lock_currently_held: historicalM2LockHeld,
      stale_metadata_explanation:
        "Historical apply report persisted global_lock_released=false because verification failed before finalizeUnderLock could persist release; runner finally block released DB lock. Lease expired 2026-08-23T02:04:39Z."
    },
    inserted_row: {
      official_sailing_id: CANARY_OFFICIAL_ID,
      expected_uuid: m2r.HISTORICAL_INSERTED_UUID,
      actual_uuid: whRow?.id || null,
      production_count: whRows.length,
      payload_verification: payloadVerification,
      itinerary_ports: {
        expected: fixture.itinerary_ports,
        stored: whRow?.itinerary_ports || null,
        expected_count: fixture.itinerary_ports?.length || 0,
        stored_count: whRow?.itinerary_ports?.length || 0,
        semantic_equal: payloadVerification.ok || payloadVerification.mismatches?.includes("itinerary_ports") === false
      }
    },
    production_snapshot: {
      total: inventory.total,
      classic_stored_official: inventory.classic_stored_official_total,
      classic_active: inventory.classic_active_official,
      classic_expired: inventory.classic_expired_official,
      expedition_stored_official: inventory.expedition_stored_official_total,
      expedition_active: inventory.expedition_active_official,
      expedition_expired: inventory.expedition_expired_official,
      legacy: inventory.legacy,
      duplicate_official_ids: dupes
    },
    m1_post_m2: {
      classification: m1Record?.classification || null,
      insert_eligible: m1Record?.classification === m2r.MAINTENANCE_CLASSIFICATION.INSERT_ELIGIBLE,
      duplicate_insert_proposal: m1Record?.classification === m2r.MAINTENANCE_CLASSIFICATION.INSERT_ELIGIBLE
    },
    repeat_m2_block: {
      preflight_ok: preflightBlock.ok,
      failures: preflightBlock.failures,
      prove_repeat_insert_blocked: repeatBlock.ok
    },
    protection: {
      update_canary: { id: m2r.M1_UPDATE_CANARY_ID, present: Boolean(sl), stable: slProtected },
      source_absence: { id: m2r.M1_SOURCE_ABSENCE_ID, present: Boolean(sn), stable: snProtected },
      expedition_count: expeditionRows.length,
      legacy_count: legacyRows.length,
      legacy_all_null_official_id: legacyRows.every((r) => !r.official_sailing_id)
    },
    m2_attributable_delta: attributable,
    read_only_lock_attestation: readOnlyLock,
    circular_dependency: circular,
    source_health: simulation?.health?.ok ? "PASS" : "FAIL",
    source_catalogue: simulation?.summary || null,
    recovery_complete: recoveryComplete,
    m3_decision: recoveryComplete && !circular.blocks_m3 ? "A" : "B",
    weekly_maintenance_enabled: false,
    ok: recoveryComplete
  };

  attestation.inserted_row.itinerary_ports.semantic_equal =
    whRow && fixture.itinerary_ports
      ? JSON.stringify(whRow.itinerary_ports) === JSON.stringify(fixture.itinerary_ports)
      : false;

  const outPath = path.join(REPORT_DIR, `${runId}.json`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(attestation, null, 2)}\n`);

  attestation.attestation_path = outPath;
  return attestation;
}

async function main() {
  const args = parseM2RArgs();
  const result = await runSilverseaM2RRecoveryAttestation({ args, readOnlyLock: args.readOnlyLock });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
