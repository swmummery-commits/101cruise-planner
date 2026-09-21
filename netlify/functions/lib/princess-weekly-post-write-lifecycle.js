/**
 * Princess weekly apply post-write lifecycle.
 * Runs after material writes and before central ledger finalisation.
 */

const {
  collectInsertedRecordIds
} = require("./cruise-discovery-maintenance-manifests");
const {
  extractWriteAccounting,
  validateRollbackManifestIntegrity,
  validatePostWriteReconciliation
} = require("./princess-weekly-maintenance-cli");
const {
  evaluateInsertedVerificationTargets,
  verifyInsertedRows,
  fetchPrincessActiveRows
} = require("./princess-post-write-verification");

async function completePrincessApplyPostWriteLifecycle({
  supabase,
  runId,
  runRecordId = null,
  result = {},
  summary = {},
  writeResult = null,
  rollbackManifest = null,
  rollbackResult = null,
  cruiseLineId = null,
  triggerType = null,
  fetchInsertedRows = fetchPrincessActiveRows,
  runPostWriteReconciliationDryRun
} = {}) {
  const resolvedWriteResult = writeResult || result.write_result || null;
  const resolvedRollback =
    rollbackResult ||
    (rollbackManifest ? { manifest: rollbackManifest } : null) ||
    (result.rollback_result ? result.rollback_result : null);
  const resolvedManifest =
    resolvedRollback?.manifest || rollbackManifest || result.rollback_manifest || null;

  const writeAccounting = extractWriteAccounting(summary, resolvedWriteResult?.stats || resolvedWriteResult);
  const committedInserts = Number(summary.inserts ?? resolvedWriteResult?.stats?.inserted ?? 0);
  const manifestValidation = validateRollbackManifestIntegrity({
    rollbackResult:
      resolvedRollback ||
      (writeAccounting.committed === 0 ? { skipped: true, reason: "no_writes" } : { manifest: resolvedManifest }),
    summary,
    writeResult: resolvedWriteResult,
    runMeta: {
      runId,
      runRecordId,
      cruiseLineId,
      triggerType
    }
  });

  if (writeAccounting.committed === 0) {
    const ok = manifestValidation.ok !== false;
    return {
      ok,
      reason: ok ? "zero_change_apply" : manifestValidation.reason,
      write_accounting: writeAccounting,
      manifest_validation: manifestValidation,
      post_write_verification: { ok: true, skipped: true, reason: "zero_change_apply" },
      post_write_reconciliation: { ok: true, skipped: true, reason: "zero_change_apply" }
    };
  }

  const insertedIds = collectInsertedRecordIds({
    writeResult: resolvedWriteResult,
    rollbackManifest: resolvedManifest
  });
  const targets = evaluateInsertedVerificationTargets({ committedInserts, insertedIds });

  let postWriteVerification;
  if (!targets.ok) {
    postWriteVerification = {
      ok: false,
      reason: "post_write_verification_targets_missing",
      inserted_ids: [],
      committed_inserts: committedInserts
    };
  } else if (!insertedIds.length) {
    postWriteVerification = { ok: true, skipped: true, reason: "no_inserts_to_verify" };
  } else {
    const rows = await fetchInsertedRows(supabase, insertedIds);
    const verification = verifyInsertedRows(rows);
    postWriteVerification = {
      ok: verification.ok,
      issues: verification.issues,
      verified_count: rows.length,
      min_departure: verification.minDeparture,
      inserted_ids: insertedIds
    };
  }

  let postWriteReconciliation = { ok: false, reason: "missing_post_write_reconciliation" };
  if (typeof runPostWriteReconciliationDryRun === "function") {
    const reconRun = await runPostWriteReconciliationDryRun(supabase, runId || "weekly-apply");
    postWriteReconciliation = validatePostWriteReconciliation(reconRun?.summary);
    postWriteReconciliation.raw_summary = reconRun?.summary || null;
    if (reconRun && reconRun.ok === false) {
      postWriteReconciliation.ok = false;
      postWriteReconciliation.reason = reconRun.reason || postWriteReconciliation.reason;
    }
  }
  if (!postWriteVerification.ok) {
    postWriteReconciliation.ok = false;
    postWriteReconciliation.reason =
      postWriteReconciliation.reason || "post_write_record_verification_failed";
  }

  const ok =
    manifestValidation.ok !== false &&
    postWriteVerification.ok === true &&
    postWriteReconciliation.ok === true;
  return {
    ok,
    reason: ok
      ? null
      : postWriteVerification.reason ||
        postWriteReconciliation.reason ||
        manifestValidation.reason ||
        "post_write_lifecycle_failed",
    write_accounting: writeAccounting,
    manifest_validation: manifestValidation,
    post_write_verification: postWriteVerification,
    post_write_reconciliation: postWriteReconciliation
  };
}

module.exports = {
  completePrincessApplyPostWriteLifecycle
};
