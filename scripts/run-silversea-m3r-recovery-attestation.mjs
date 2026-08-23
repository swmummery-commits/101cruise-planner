#!/usr/bin/env node
/**
 * Silversea M3R — read-only recovery attestation for M3 update-canary lifecycle gap.
 *
 *   node scripts/run-silversea-m3r-recovery-attestation.mjs
 *   node scripts/run-silversea-m3r-recovery-attestation.mjs --read-only-lock
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
const FIXTURE_PATH = path.join(root, "scripts/fixtures/silversea/m3-maintenance-update-canary-SL270927009.json");

const adapter = require(path.join(root, "netlify/functions/lib/silversea-discovery-adapter"));
const { indexExistingSilverseaRecords } = require(path.join(root, "netlify/functions/lib/silversea-discovery-writes"));
const { buildSilverseaWeeklyMaintenanceProposal } = require(path.join(
  root,
  "netlify/functions/lib/silversea-weekly-maintenance-proposal"
));
const {
  classifySilverseaOfficialInventory,
  isExpeditionStoredOfficialRow
} = require(path.join(root, "netlify/functions/lib/silversea-classic-itinerary-ports-backfill"));
const {
  snapshotProtectionRows,
  verifyProtectionSnapshots
} = require(path.join(root, "netlify/functions/lib/silversea-expedition-itinerary-ports-backfill"));
const {
  validateM3Preflight,
  proveRepeatUpdateBlocked
} = require(path.join(root, "netlify/functions/lib/silversea-m3-maintenance-update-canary"));
const m3r = require(path.join(root, "netlify/functions/lib/silversea-m3r-recovery-attestation"));
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

export const M3R_RUNNER_PATH = "scripts/run-silversea-m3r-recovery-attestation.mjs";

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

export function parseM3RArgs(argv = process.argv) {
  const args = { readOnlyLock: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--read-only-lock") args.readOnlyLock = true;
  }
  return args;
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

export async function runSilverseaM3RRecoveryAttestation(options = {}) {
  const startedAt = new Date().toISOString();
  const args = options.args || parseM3RArgs();
  const today = options.today || perthCalendarDate();
  const runId = options.runId || `silversea-m3r-recovery-attestation-${startedAt.replace(/[:.]/g, "-")}`;

  const historicalHashes = {};
  for (const [key, relPath] of Object.entries(m3r.HISTORICAL_ARTIFACT_PATHS)) {
    const fullPath = path.join(root, relPath);
    historicalHashes[key] = fs.existsSync(fullPath) ? m3r.hashFile(fullPath) : null;
  }

  const m3RunnerSource = fs.readFileSync(path.join(root, "scripts/run-silversea-m3-update-canary.mjs"), "utf8");
  const m2RunnerSource = fs.readFileSync(path.join(root, "scripts/run-silversea-m2-insert-canary.mjs"), "utf8");
  const m3FinalizeAudit = m3r.auditFinalizeUnderLockPresent(m3RunnerSource);
  const m2FinalizeAudit = m3r.auditFinalizeUnderLockPresent(m2RunnerSource);
  const orderingAudit = m3r.auditUnderLockSnapshotOrdering(m3RunnerSource);
  const targetQueryAudit = m3r.auditUnderLockTargetQuery(m3RunnerSource);
  const maintenanceRunnerAudit = m3r.auditSilverseaMaintenanceRunners({
    m3: m3RunnerSource,
    m2: m2RunnerSource
  });

  const lifecycleReconciliation = m3r.reconcileHistoricalLifecycle(root);

  const { sb, line, productionIndex, simulation } = await loadProductionContext(today);
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

  const lockStatus = await loadMaintenanceLockStatus(sb, GLOBAL_CRUISE_WRITE_LOCK_KEY);
  const historicalM3LockHeld =
    lockStatus.held === true &&
    (lockStatus.owner_id === m3r.HISTORICAL_M3_SUCCESS_RUN_ID ||
      lockStatus.owner_id === m3r.HISTORICAL_M3_BLOCKED_RUN_ID);

  const slRows =
    (await sb(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&official_sailing_id=eq.${encodeURIComponent(
        m3r.CANARY_OFFICIAL_ID
      )}&select=*`
    )) || [];
  const slRow = slRows.length === 1 ? slRows[0] : null;
  const afterVerification = slRow ? m3r.verifyUpdatedAfterValues(slRow, fixture) : { ok: false, issues: ["row_missing"] };
  const identityVerification = slRow ? m3r.verifyIdentityImmutability(slRow, fixture) : { ok: false, mutations: 1 };

  const whRows =
    (await sb(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(line.id)}&official_sailing_id=eq.${encodeURIComponent(
        m3r.M2_INSERT_CANARY_ID
      )}&select=*`
    )) || [];
  const whRow = whRows.length === 1 ? whRows[0] : null;
  const whProtected =
    whRow &&
    verifyProtectionSnapshots(snapshotProtectionRows([whRow], new Set()), [whRow], new Set(), {
      perthToday: today
    }).ok;

  const inventory = classifySilverseaOfficialInventory(productionIndex.rows);
  const dupes = m3r.countDuplicateOfficialIds(productionIndex.rows.filter((r) => r.official_sailing_id));
  const attributable = m3r.computeM3AttributableEffect(inventory);

  const proposal = buildSilverseaWeeklyMaintenanceProposal({
    simulation,
    productionIndex,
    cruiseLine: line,
    today
  });
  const m1Record = (proposal.records || []).find(
    (r) => String(r.official_sailing_id).toUpperCase() === m3r.CANARY_OFFICIAL_ID
  );
  const preflightBlock = await validateM3Preflight({
    simulation,
    productionIndex,
    cruiseLine: line,
    today,
    fixture
  });
  const repeatBlock = proveRepeatUpdateBlocked(productionIndex, fixture);

  const sn = productionIndex.byOfficialId.get(m3r.M1_SOURCE_ABSENCE_ID);
  const snProtected = sn
    ? verifyProtectionSnapshots(snapshotProtectionRows([sn], new Set()), [sn], new Set(), { perthToday: today }).ok
    : true;

  const classicAudit = m3r.auditClassicIntegrity({
    rows: productionIndex.rows.filter((r) => r.official_sailing_id),
    targetRow: slRow,
    fixture
  });
  const expeditionAudit = m3r.auditExpeditionIntegrity({
    beforeOfficialRows: productionIndex.rows.filter((r) => r.official_sailing_id),
    afterOfficialRows: productionIndex.rows.filter((r) => r.official_sailing_id),
    today
  });
  const legacyAudit = m3r.auditLegacyIntegrity(productionIndex.rows);
  const unsafeAudit = m3r.auditUnsafeRowsUntouched({
    beforeRows: productionIndex.rows,
    afterRows: productionIndex.rows,
    today
  });

  const circular = m3r.auditCircularDependencyWarning();

  let readOnlyLock = { used: false, acquired: false, released: false, double_read_stable: null };
  if (args.readOnlyLock) {
    readOnlyLock.used = true;
    const lock = await acquireGlobalCruiseWriteLock(sb, {
      ownerId: runId,
      runId,
      lineSlug: adapter.LINE_SLUG,
      operation: "silversea_m3r_read_only_attestation",
      leaseSeconds: 300
    });
    readOnlyLock.acquired = lock.acquired === true;
    if (lock.acquired) {
      try {
        const first = await indexExistingSilverseaRecords(sb, line.id);
        const firstSl = first.byOfficialId.get(m3r.CANARY_OFFICIAL_ID);
        const firstWh = first.byOfficialId.get(m3r.M2_INSERT_CANARY_ID);
        const second = await indexExistingSilverseaRecords(sb, line.id);
        const secondSl = second.byOfficialId.get(m3r.CANARY_OFFICIAL_ID);
        const secondWh = second.byOfficialId.get(m3r.M2_INSERT_CANARY_ID);
        readOnlyLock.double_read_stable =
          first.rows.length === second.rows.length &&
          firstSl?.id === secondSl?.id &&
          firstWh?.id === secondWh?.id &&
          JSON.stringify(firstSl?.itinerary_ports) === JSON.stringify(secondSl?.itinerary_ports);
        readOnlyLock.first_read_total = first.rows.length;
        readOnlyLock.second_read_total = second.rows.length;
      } finally {
        readOnlyLock.released = await releaseGlobalCruiseWriteLock(sb, { ownerId: runId });
      }
    }
  }

  const historicalPreserved = m3r.verifyHistoricalArtifactsPreserved(root, historicalHashes);

  const recoveryComplete =
    m3FinalizeAudit.ok &&
    m2FinalizeAudit.ok &&
    maintenanceRunnerAudit.ok &&
    orderingAudit.ok &&
    targetQueryAudit.ok &&
    slRows.length === 1 &&
    slRow?.id === m3r.HISTORICAL_TARGET_UUID &&
    afterVerification.ok &&
    identityVerification.ok &&
    preflightBlock.ok === false &&
    repeatBlock.ok === true &&
    m1Record?.classification === m3r.MAINTENANCE_CLASSIFICATION.UNCHANGED &&
    dupes.length === 0 &&
    attributable.reconciled === true &&
    whRows.length === 1 &&
    whRow?.id === m3r.M2_INSERTED_UUID &&
    whProtected &&
    snProtected &&
    classicAudit.unexpected_m3_attributable_anomalies === 0 &&
    expeditionAudit.ok &&
    legacyAudit.ok &&
    unsafeAudit.ok &&
    historicalPreserved.ok &&
    !historicalM3LockHeld &&
    (!readOnlyLock.used || (readOnlyLock.released === true && readOnlyLock.double_read_stable === true));

  const attestation = {
    phase: "M3R",
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
    m3_tooling_commits: {
      initial: m3r.M3_TOOLING_COMMIT,
      under_lock_fix: m3r.M3_UNDER_LOCK_FIX_COMMIT
    },
    successful_m3_run_id: m3r.HISTORICAL_M3_SUCCESS_RUN_ID,
    blocked_m3_run_id: m3r.HISTORICAL_M3_BLOCKED_RUN_ID,
    lifecycle_reconciliation: lifecycleReconciliation,
    historical_artifacts_rewritten: historicalPreserved.rewritten,
    historical_artifact_preservation: historicalPreserved,
    finalisation_gap_root_cause: {
      classification: "MISSING_FINALIZE_UNDER_LOCK",
      explanation: lifecycleReconciliation.discrepancy_explanation,
      finalize_under_lock_before_fix: false,
      m3_runner_hardened: m3FinalizeAudit.ok,
      m2_runner_hardened: m2FinalizeAudit.ok
    },
    maintenance_runner_audit: maintenanceRunnerAudit,
    under_lock_ordering_audit: orderingAudit,
    under_lock_target_query_audit: targetQueryAudit,
    global_lock: {
      key: GLOBAL_CRUISE_WRITE_LOCK_KEY,
      current: lockStatus,
      historical_m3_lock_currently_held: historicalM3LockHeld,
      stale_metadata_explanation:
        "Historical apply report global_lock_released=false is stale artifact metadata. withGlobalCruiseWriteLock released the DB lock in finally after successful verification; finalizeUnderLock was not invoked to persist COMPLETE and post-release metadata."
    },
    target_row: {
      official_sailing_id: m3r.CANARY_OFFICIAL_ID,
      expected_uuid: m3r.HISTORICAL_TARGET_UUID,
      actual_uuid: slRow?.id || null,
      production_count: slRows.length,
      after_values_verification: afterVerification,
      identity_verification: identityVerification,
      update_allowlist: fixture.update_allowlist
    },
    m2_insert_canary: {
      official_sailing_id: m3r.M2_INSERT_CANARY_ID,
      expected_uuid: m3r.M2_INSERTED_UUID,
      actual_uuid: whRow?.id || null,
      production_count: whRows.length,
      protected: whProtected
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
    m1_reconciliation: {
      classification: m1Record?.classification || null,
      repeat_update_proposal: m1Record?.classification === m3r.MAINTENANCE_CLASSIFICATION.UPDATE_ELIGIBLE,
      preflight_blocked: preflightBlock.ok === false,
      repeat_update_blocked: repeatBlock.ok
    },
    protection_audits: {
      classic: classicAudit,
      expedition: expeditionAudit,
      legacy: legacyAudit,
      source_absence: { ok: snProtected, id: m3r.M1_SOURCE_ABSENCE_ID },
      update_unsafe: unsafeAudit
    },
    m3_attributable_effect: attributable,
    read_only_lock: readOnlyLock,
    circular_dependency: circular,
    lifecycle_interpretation: {
      historical_m3_business_verification_succeeded: true,
      historical_m3_durable_complete_lifecycle: false,
      m3_updated_production_data_independently_attested_correct: afterVerification.ok && identityVerification.ok,
      m3_current_runner_lifecycle_hardened: m3FinalizeAudit.ok
    },
    silversea_maintenance_update_semantics_proven: afterVerification.ok && identityVerification.ok,
    silversea_m3_recovery_attestation_complete: recoveryComplete,
    m4_authorisation:
      recoveryComplete && circular.blocks_m3 !== true
        ? "A. SILVERSEA M4 — SOURCE-ABSENCE OBSERVATION-STATE CANARY AUTHORISED"
        : "B. SILVERSEA M3 REMEDIATION REQUIRED",
    weekly_maintenance_enabled: false
  };

  const outPath = path.join(REPORT_DIR, `${runId}.json`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(attestation, null, 2)}\n`);

  const postPreservation = m3r.verifyHistoricalArtifactsPreserved(root, historicalHashes);
  attestation.historical_artifacts_rewritten_after_attestation = postPreservation.rewritten;

  return {
    ok: recoveryComplete,
    attestation_path: outPath,
    attestation,
    historical_preservation_after: postPreservation
  };
}

async function main() {
  const result = await runSilverseaM3RRecoveryAttestation({ args: parseM3RArgs() });
  console.log(JSON.stringify(result.attestation, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
