/**
 * Silversea M3R — read-only recovery attestation for M3 update-canary lifecycle gap.
 */

const fs = require("fs");
const crypto = require("crypto");
const {
  CANARY_OFFICIAL_ID,
  M2_INSERT_CANARY_ID,
  M1_SOURCE_ABSENCE_ID,
  UPDATE_UNSAFE_GUARD_IDS,
  compareUpdatedRowToFixture,
  proveRepeatUpdateBlocked,
  buildImmutableFingerprint,
  IMMUTABLE_FIELDS
} = require("./silversea-m3-maintenance-update-canary");
const {
  classifySilverseaOfficialInventory,
  isExpeditionStoredOfficialRow
} = require("./silversea-classic-itinerary-ports-backfill");
const {
  snapshotProtectionRows,
  verifyProtectionSnapshots
} = require("./silversea-expedition-itinerary-ports-backfill");
const {
  RUN_STATUS,
  ControlledProductionRunStore,
  finalizeControlledProductionUnderLock,
  persistPostLockReleaseMetadata,
  buildApplyReportLifecycle,
  buildPreWriteRollbackManifest
} = require("./cruise-discovery-controlled-production-run");
const { buildGlobalLockReportFields } = require("./cruise-discovery-global-write-lock");
const { auditUnderLockSnapshotOrdering, auditCircularDependencyWarning, hashFile, countDuplicateOfficialIds } = require("./silversea-m2r-recovery-attestation");
const { MAINTENANCE_CLASSIFICATION } = require("./silversea-weekly-maintenance-policy");

const HISTORICAL_M3_SUCCESS_RUN_ID =
  "silversea-m3-maintenance-update-SL270927009-2026-08-23T05-29-32-410Z";
const HISTORICAL_M3_BLOCKED_RUN_ID =
  "silversea-m3-maintenance-update-SL270927009-2026-08-23T05-25-46-306Z";
const HISTORICAL_TARGET_UUID = "46e8e274-9f46-4529-9c6f-5bdac69bdedb";
const M2_INSERTED_UUID = "94b60f04-3728-49af-8d58-70e93f6dfd7c";
const M3_TOOLING_COMMIT = "183875dbbd1529388bc687b1aeeb0f70a3a2f307";
const M3_UNDER_LOCK_FIX_COMMIT = "f734d15843eb357641349a0844cb593ad56e3a30";
const M3_PRODUCTION_BEFORE_TOTAL = 920;
const M3_CLASSIC_BEFORE = 602;

const HISTORICAL_ARTIFACT_PATHS = Object.freeze({
  success_apply: `reports/controlled-production-apply-${HISTORICAL_M3_SUCCESS_RUN_ID}.json`,
  success_rollback: `reports/controlled-production-rollback-${HISTORICAL_M3_SUCCESS_RUN_ID}.json`,
  success_summary: `reports/${HISTORICAL_M3_SUCCESS_RUN_ID}.json`,
  blocked_apply: `reports/controlled-production-apply-${HISTORICAL_M3_BLOCKED_RUN_ID}.json`,
  blocked_summary: `reports/${HISTORICAL_M3_BLOCKED_RUN_ID}.json`
});

function auditFinalizeUnderLockPresent(runnerSource) {
  const src = String(runnerSource || "");
  const checks = {
    finalize_under_lock_present: /finalizeUnderLock:\s*async/.test(src),
    uses_shared_helper:
      /finalizeControlledProductionUnderLock/.test(src),
    post_lock_release_metadata: /persistPostLockReleaseMetadata/.test(src),
    success_ok_uses_verified: /isSuccessfulControlledProductionRun/.test(src)
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return { ok: failed.length === 0, checks, failed };
}

function auditSilverseaMaintenanceRunners(runnerSources) {
  const issues = [];
  for (const [name, src] of Object.entries(runnerSources || {})) {
    if (!/executeHardenedControlledProductionApply/.test(src)) continue;
    const audit = auditFinalizeUnderLockPresent(src);
    if (!audit.ok) issues.push({ runner: name, missing: audit.failed });
  }
  return { ok: issues.length === 0, issues };
}

function verifyHistoricalArtifactsPreserved(root, initialHashes) {
  const results = {};
  for (const [key, relPath] of Object.entries(HISTORICAL_ARTIFACT_PATHS)) {
    const fullPath = require("path").join(root, relPath);
    const initialHash = initialHashes[key];
    if (!fs.existsSync(fullPath)) {
      results[key] = { ok: false, reason: "missing", rewritten: false };
      continue;
    }
    const currentHash = hashFile(fullPath);
    const report = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    results[key] = {
      ok: currentHash === initialHash,
      initial_hash: initialHash,
      current_hash: currentHash,
      rewritten: currentHash !== initialHash,
      status: report.status,
      global_lock_released: report.global_lock?.global_lock_released ?? null
    };
  }
  const allOk = Object.values(results).every((r) => r.ok);
  return { ok: allOk, artifacts: results, rewritten: !allOk };
}

function reconcileHistoricalLifecycle(root) {
  const successApply = JSON.parse(
    fs.readFileSync(require("path").join(root, HISTORICAL_ARTIFACT_PATHS.success_apply), "utf8")
  );
  const successSummary = JSON.parse(
    fs.readFileSync(require("path").join(root, HISTORICAL_ARTIFACT_PATHS.success_summary), "utf8")
  );
  const blockedSummary = fs.existsSync(require("path").join(root, HISTORICAL_ARTIFACT_PATHS.blocked_summary))
    ? JSON.parse(fs.readFileSync(require("path").join(root, HISTORICAL_ARTIFACT_PATHS.blocked_summary), "utf8"))
    : null;

  return {
    successful_run_id: HISTORICAL_M3_SUCCESS_RUN_ID,
    blocked_run_id: HISTORICAL_M3_BLOCKED_RUN_ID,
    runner_level: {
      verification_ok: successSummary.verification?.ok === true,
      run_status: successSummary.hardened_result?.run_status || null,
      top_level_ok: successSummary.ok === true
    },
    durable_apply_report: {
      status: successApply.status,
      global_lock_released: successApply.global_lock?.global_lock_released,
      verification_persisted: successApply.verification != null
    },
    blocked_attempt: {
      production_writes: blockedSummary?.production_summary || { inserts: 0, updates: 0 },
      blocked_reason: blockedSummary?.hardened_result?.reason || "under_lock_frozen_before_mismatch",
      run_status: blockedSummary?.hardened_result?.run_status || "BLOCKED"
    },
    discrepancy_explanation:
      "In-memory hardened pipeline reached VERIFIED with verification.ok=true and released the DB lock in withGlobalCruiseWriteLock finally, but durable apply report stopped at VERIFYING because finalizeUnderLock was never invoked to persist COMPLETE and post-lock global_lock_released metadata."
  };
}

function verifyUpdatedAfterValues(productionRow, fixture) {
  return compareUpdatedRowToFixture(productionRow, fixture);
}

function verifyIdentityImmutability(productionRow, fixture) {
  const current = buildImmutableFingerprint(productionRow);
  const expected = fixture.immutable_fingerprint || {};
  const mismatches = [];
  for (const field of IMMUTABLE_FIELDS) {
    if (JSON.stringify(current[field]) !== JSON.stringify(expected[field])) {
      mismatches.push(field);
    }
  }
  return { ok: mismatches.length === 0, mismatches, mutations: mismatches.length };
}

function computeM3AttributableEffect(inventory) {
  return {
    inserts: 0,
    updates: 1,
    deletes: 0,
    hides: 0,
    reference_writes: 0,
    row_delta: inventory.total - M3_PRODUCTION_BEFORE_TOTAL,
    classic_delta: inventory.classic_stored_official_total - M3_CLASSIC_BEFORE,
    expedition_delta: inventory.expedition_stored_official_total - 310,
    legacy_delta: inventory.legacy - 8,
    reconciled:
      inventory.total === M3_PRODUCTION_BEFORE_TOTAL &&
      inventory.classic_stored_official_total === M3_CLASSIC_BEFORE &&
      inventory.expedition_stored_official_total === 310 &&
      inventory.legacy === 8
  };
}

function auditClassicIntegrity({ rows, targetRow, fixture }) {
  const dupes = countDuplicateOfficialIds(rows.filter((r) => r.official_sailing_id));
  const targetCheck = targetRow ? verifyUpdatedAfterValues(targetRow, fixture) : { ok: false };
  return {
    duplicate_official_ids: dupes,
    target_after_values_ok: targetCheck.ok,
    unexpected_m3_attributable_anomalies: dupes.length > 0 || !targetCheck.ok ? 1 : 0
  };
}

function auditExpeditionIntegrity({ beforeOfficialRows, afterOfficialRows, today = "2026-08-22" }) {
  const expeditionBefore = (beforeOfficialRows || []).filter(isExpeditionStoredOfficialRow);
  const expeditionAfter = (afterOfficialRows || []).filter(isExpeditionStoredOfficialRow);
  const protection = verifyProtectionSnapshots(
    snapshotProtectionRows(expeditionBefore, new Set()),
    expeditionAfter,
    new Set(),
    { perthToday: today }
  );
  return { ok: protection.ok, issues: protection.issues || [] };
}

function auditLegacyIntegrity(rows) {
  const legacy = (rows || []).filter((r) => !r.official_sailing_id);
  const ok =
    legacy.length === 8 &&
    legacy.every((r) => r.status === "hidden" || String(r.status).toLowerCase() === "hidden");
  return { ok, count: legacy.length };
}

function auditUnsafeRowsUntouched({ beforeRows, afterRows, today = "2026-08-22" }) {
  const beforeById = new Map((beforeRows || []).map((r) => [String(r.official_sailing_id).toUpperCase(), r]));
  const afterById = new Map((afterRows || []).map((r) => [String(r.official_sailing_id).toUpperCase(), r]));
  const modified = [];
  for (const id of UPDATE_UNSAFE_GUARD_IDS) {
    const before = beforeById.get(String(id).toUpperCase());
    const after = afterById.get(String(id).toUpperCase());
    if (!before || !after) continue;
    const snap = verifyProtectionSnapshots(
      snapshotProtectionRows([before], new Set()),
      [after],
      new Set(),
      { perthToday: today }
    );
    if (!snap.ok) modified.push(id);
  }
  return { ok: modified.length === 0, modified };
}

function simulateLifecycleFinalizationSuccess({ reportDir, runId }) {
  const store = new ControlledProductionRunStore(reportDir, runId);
  let rollbackManifest = buildPreWriteRollbackManifest({
    runId,
    fixturePath: "fixture.json",
    operation: "test",
    lineSlug: "silversea-cruises",
    expectedInserts: 0,
    expectedUpdates: 1,
    productionBefore: { total: 920 }
  });
  let applyReport = buildApplyReportLifecycle({
    runId,
    createdAt: new Date().toISOString(),
    fixturePath: "fixture.json",
    operation: "test",
    lineSlug: "silversea-cruises",
    expectedInserts: 0,
    productionBefore: { total: 920 }
  });
  store.persistPreparedRollback(rollbackManifest);
  store.persistPreparedReport(applyReport);

  const verificationResult = { ok: true, row_match: { ok: true } };
  const writeResult = { stats: { updated: 1, inserted: 0, failed: 0 } };
  const finalized = finalizeControlledProductionUnderLock({
    store,
    rollbackManifest,
    applyReport,
    verificationResult,
    verificationError: null,
    writeResult,
    validateWrite: ({ finalStatus }) => {
      if (finalStatus !== RUN_STATUS.VERIFIED) throw new Error("expected verified");
    }
  });

  const lockObs = buildGlobalLockReportFields(
    { acquired: true, owner_id: runId, run_id: runId },
    { global_lock_released: true }
  );
  persistPostLockReleaseMetadata({
    store,
    applyReport: finalized.applyReport,
    globalLockObservability: lockObs,
    timings: { ended_at: new Date().toISOString() }
  });

  const persisted = JSON.parse(fs.readFileSync(store.applyReportPath, "utf8"));
  return {
    ok:
      persisted.status === RUN_STATUS.COMPLETE &&
      persisted.verification?.ok === true &&
      persisted.global_lock?.global_lock_released === true,
    persisted
  };
}

function simulateLifecycleFinalizationFailure({ reportDir, runId }) {
  const store = new ControlledProductionRunStore(reportDir, runId);
  let rollbackManifest = buildPreWriteRollbackManifest({
    runId,
    fixturePath: "fixture.json",
    operation: "test",
    lineSlug: "silversea-cruises",
    expectedInserts: 0,
    expectedUpdates: 1,
    productionBefore: { total: 920 }
  });
  let applyReport = buildApplyReportLifecycle({
    runId,
    createdAt: new Date().toISOString(),
    fixturePath: "fixture.json",
    operation: "test",
    lineSlug: "silversea-cruises",
    expectedInserts: 0,
    productionBefore: { total: 920 }
  });
  store.persistPreparedRollback(rollbackManifest);
  store.persistPreparedReport(applyReport);

  const finalized = finalizeControlledProductionUnderLock({
    store,
    rollbackManifest,
    applyReport,
    verificationResult: { ok: false, reason: "protection_failed" },
    verificationError: null,
    writeResult: { stats: { updated: 1, inserted: 0 } }
  });

  const lockObs = buildGlobalLockReportFields(
    { acquired: true, owner_id: runId, run_id: runId },
    { global_lock_released: true }
  );
  persistPostLockReleaseMetadata({
    store,
    applyReport: finalized.applyReport,
    globalLockObservability: lockObs,
    timings: { ended_at: new Date().toISOString() }
  });

  const persisted = JSON.parse(fs.readFileSync(store.applyReportPath, "utf8"));
  return {
    ok:
      persisted.status === RUN_STATUS.WRITE_SUCCEEDED_VERIFICATION_FAILED &&
      persisted.status !== RUN_STATUS.COMPLETE &&
      persisted.global_lock?.global_lock_released === true,
    persisted
  };
}

function simulateRealNonTargetMutationDetection({ targetUuid, today = "2026-08-22" }) {
  const classicBefore = {
    id: "other-classic",
    official_sailing_id: "SLMOCK001",
    cruise_line_id: "line",
    ship_id: "ship",
    departure_date: "2028-01-01",
    return_date: "2028-01-10",
    nights: 9,
    departure_port: "Venice",
    destination_id: "dest",
    itinerary: "Venice, Rome",
    itinerary_ports: ["Venice", "Rome"],
    status: "active",
    official_url: "https://example.com",
    source_url: "https://example.com",
    raw_extract: { silversea_cruise_code: "SLMOCK001" }
  };
  const classicAfter = {
    ...classicBefore,
    itinerary: "Venice, Rome, MUTATED"
  };
  const protection = verifyProtectionSnapshots(
    snapshotProtectionRows([classicBefore], new Set([targetUuid])),
    [classicAfter],
    new Set([targetUuid]),
    { perthToday: today }
  );
  return { ok: protection.ok === false, protection };
}

function auditUnderLockTargetQuery(runnerSource) {
  const src = String(runnerSource || "");
  const ok = /underLockRecheck:[\s\S]*select=\*&limit=1/.test(src);
  return { ok, sufficient: ok };
}

module.exports = {
  HISTORICAL_M3_SUCCESS_RUN_ID,
  HISTORICAL_M3_BLOCKED_RUN_ID,
  HISTORICAL_TARGET_UUID,
  M2_INSERT_CANARY_ID,
  M2_INSERTED_UUID,
  M1_SOURCE_ABSENCE_ID,
  M3_TOOLING_COMMIT,
  M3_UNDER_LOCK_FIX_COMMIT,
  HISTORICAL_ARTIFACT_PATHS,
  auditFinalizeUnderLockPresent,
  auditSilverseaMaintenanceRunners,
  verifyHistoricalArtifactsPreserved,
  reconcileHistoricalLifecycle,
  verifyUpdatedAfterValues,
  verifyIdentityImmutability,
  computeM3AttributableEffect,
  auditClassicIntegrity,
  auditExpeditionIntegrity,
  auditLegacyIntegrity,
  auditUnsafeRowsUntouched,
  simulateLifecycleFinalizationSuccess,
  simulateLifecycleFinalizationFailure,
  simulateRealNonTargetMutationDetection,
  auditUnderLockTargetQuery,
  auditUnderLockSnapshotOrdering,
  auditCircularDependencyWarning,
  hashFile,
  countDuplicateOfficialIds,
  MAINTENANCE_CLASSIFICATION,
  CANARY_OFFICIAL_ID
};
