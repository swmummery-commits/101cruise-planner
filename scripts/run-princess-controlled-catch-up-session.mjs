#!/usr/bin/env node
/**
 * Local-only controlled Princess catch-up session orchestrator.
 *
 * Default (zero-write preview):
 *   node scripts/run-princess-controlled-catch-up-session.mjs
 *   node scripts/run-princess-controlled-catch-up-session.mjs --max-batches=3
 *
 * Apply (local Mac only — requires explicit confirmation):
 *   PRINCESS_DISCOVERY_WRITE_ENABLED=true node scripts/run-princess-controlled-catch-up-session.mjs \
 *     --apply \
 *     --confirm=PRINCESS-CONTROLLED-CATCH-UP \
 *     --expected-start-active=416 \
 *     --max-batches=3
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

const batchLib = require(path.join(root, "scripts/lib/princess-controlled-catch-up-batch.cjs"));
const sessionLib = require(path.join(root, "netlify/functions/lib/princess-catch-up-session"));
const { createSupabaseRest } = require(path.join(root, "scripts/lib/supabase-rest.cjs"));

const REPORT_DIR = path.join(root, "reports");

function parseArgs(argv) {
  return sessionLib.parseSessionArgs(argv);
}

async function fetchManifestWriteDetails(sb, manifestId) {
  if (!manifestId) return [];
  const rows = await sb.get(
    `cruise_discovery_maintenance_manifests?id=eq.${manifestId}&select=manifest,run_id,run_record_id`
  );
  return rows[0]?.manifest?.stats?.write_details || [];
}

async function findRecentDailyExpiryRun(sb, sinceIso) {
  const runs = await sb.get(
    `cruise_discovery_runs?order=started_at.desc&limit=20&select=id,status,started_at,finished_at,stats,cruise_line_id`
  );
  return (runs || []).find((r) => {
    const runType = r.stats?.run_type;
    if (runType !== "daily_expiry_maintenance") return false;
    if (sinceIso && r.started_at && r.started_at < sinceIso) return false;
    return r.status === "completed";
  });
}

async function fetchExpiredRows(sb, ids = []) {
  if (!ids.length) return [];
  return sb.get(
    `discovered_cruises?id=in.(${ids.join(",")})&select=id,status,cruise_line_id,departure_date,official_sailing_id`
  );
}

async function runCruiseFinderHealthCheck() {
  const siteUrl = String(
    process.env.NETLIFY_SITE_URL || process.env.URL || "https://admirable-tiramisu-d4da8a.netlify.app"
  ).replace(/\/$/, "");
  try {
    const response = await fetch(`${siteUrl}/.netlify/functions/search-current-cruises`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destination: "alaska", cruiseLine: "princess-cruises" })
    });
    const body = await response.json();
    return {
      ok: response.status === 200 && body?.ok !== false && body?.search_failed !== true,
      status: response.status,
      search_failed: body?.search_failed === true
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function runReadOnlyPreview(args, sessionReport) {
  const counts = await batchLib.baselineCounts(root);
  const fresh = await batchLib.fetchFreshPrincessReconciliation(root, { runIdSuffix: "session-preview" });

  if (!fresh.ok) {
    sessionReport.session_status = "stopped";
    sessionReport.stop_reason = fresh.stop_reason || sessionLib.STOP_REASONS.UNEXPECTED_PREFLIGHT_ERROR;
    sessionReport.preflight = fresh.preflight || null;
    sessionReport.preflight_attempts = fresh.preflight_attempts || [];
    sessionReport.preview = {
      quality_gate: fresh.quality_gate,
      quality_gate_evaluated: fresh.preflight?.quality_gate_evaluated ?? null,
      writes_performed: 0
    };
    return sessionReport;
  }

  sessionReport.preview = {
    ...sessionLib.computeSessionPreview({
      activeProductionTotal: counts.princess_active,
      reconciliation: fresh.reconciliation_summary,
      maxBatches: args.maxBatches
    }),
    snapshot_id: fresh.snapshot_id,
    eligible_total: fresh.summary?.eligible_total ?? null,
    recognised_existing_eligible: fresh.reconciliation_summary?.recognised_existing_eligible ?? null,
    reconciliation_arithmetic_ok: fresh.reconciliation_summary?.reconciliation_arithmetic_ok ?? null,
    quality_gate: fresh.quality_gate,
    writes_performed: 0
  };

  sessionReport.counts_end = counts;
  sessionReport.session_status = "preview_complete";
  sessionReport.stop_reason = null;
  return sessionReport;
}

async function runApplySession(args, sessionReport) {
  const localGuard = sessionLib.validateApplyEnvironment();
  sessionReport.local_execution_guard = localGuard;
  if (!localGuard.ok) {
    sessionReport.session_status = "stopped";
    sessionReport.stop_reason = localGuard.reason;
    return sessionReport;
  }

  const countsStart = await batchLib.baselineCounts(root);
  sessionReport.counts_start = countsStart;
  sessionReport.actual_start_active = countsStart.princess_active;

  if (countsStart.princess_active !== args.expectedStartActive) {
    sessionReport.session_status = "stopped";
    sessionReport.stop_reason = sessionLib.STOP_REASONS.START_ACTIVE_MISMATCH;
    sessionReport.start_active_mismatch = {
      expected: args.expectedStartActive,
      actual: countsStart.princess_active
    };
    return sessionReport;
  }

  const halBaseline = countsStart.hal_active;
  const celebrityBaseline = countsStart.celebrity_active;
  let princessCheckpoint = countsStart.princess_active;
  let batchesCompleted = 0;
  let totalAttempted = 0;
  let totalCommitted = 0;
  let totalRecovered = 0;
  let totalFailed = 0;
  const sessionStartedAt = sessionReport.started_at;
  const sb = createSupabaseRest(root);

  for (let batchNum = 1; batchNum <= args.maxBatches; batchNum += 1) {
    const fresh = await batchLib.fetchFreshPrincessReconciliation(root, {
      runIdSuffix: `session-batch-${batchNum}-preflight`
    });

    const batchRecord = {
      batch_number: batchNum,
      fresh_active_checkpoint: princessCheckpoint,
      snapshot_id: fresh.snapshot_id,
      eligible_total: fresh.summary?.eligible_total ?? null,
      recognised_existing_eligible: fresh.reconciliation_summary?.recognised_existing_eligible ?? null,
      outstanding_eligible_inserts: fresh.reconciliation_summary?.outstanding_eligible_inserts ?? null,
      quality_gate: fresh.quality_gate,
      continuation: null
    };

    if (!fresh.ok) {
      const stopReason = fresh.stop_reason || sessionLib.STOP_REASONS.UNEXPECTED_PREFLIGHT_ERROR;
      batchRecord.preflight = fresh.preflight || null;
      batchRecord.preflight_attempts = fresh.preflight_attempts || [];
      batchRecord.continuation = { continue: false, reason: stopReason };
      sessionReport.batches.push(batchRecord);
      sessionReport.session_status = "stopped";
      sessionReport.stop_reason = stopReason;
      sessionReport.preflight = fresh.preflight || null;
      sessionReport.preflight_attempts = fresh.preflight_attempts || [];
      break;
    }

    const outstanding = fresh.reconciliation_summary?.outstanding_eligible_inserts ?? 0;
    if (outstanding === 0) {
      batchRecord.continuation = {
        continue: false,
        completed: true,
        completion_reason: sessionLib.COMPLETION_REASONS.ZERO_OUTSTANDING_ELIGIBLE
      };
      sessionReport.batches.push(batchRecord);
      sessionReport.session_status = "completed";
      sessionReport.stop_reason = null;
      sessionReport.completion_reason = sessionLib.COMPLETION_REASONS.ZERO_OUTSTANDING_ELIGIBLE;
      break;
    }

    const budget = sessionLib.computeBatchWriteBudget({
      outstandingEligibleInserts: outstanding,
      sessionAttemptedWrites: totalAttempted,
      sessionCommittedWrites: totalCommitted,
      maxBatchesRemaining: args.maxBatches - batchesCompleted
    });

    if (!budget.can_attempt_batch) {
      batchRecord.continuation = { continue: false, reason: sessionLib.STOP_REASONS.SESSION_WRITE_CEILING };
      sessionReport.batches.push(batchRecord);
      sessionReport.session_status = "stopped";
      sessionReport.stop_reason = sessionLib.STOP_REASONS.SESSION_WRITE_CEILING;
      break;
    }

    const maxWrites = budget.batch_max_writes;
    const applyReport = await batchLib.runControlledCatchUpBatch(root, {
      apply: true,
      expectedActiveCount: princessCheckpoint,
      expectedSnapshotId: fresh.snapshot_id,
      maxWrites,
      triggerType: "controlled_catch_up_session_batch",
      runIdSuffix: `session-batch-${batchNum}-apply`,
      reportDir: REPORT_DIR
    });

    const wr = applyReport.write_result || {};
    const attempted = wr.write_details?.length || applyReport.summary?.write_attempts || 0;
    const committed = wr.inserted || applyReport.summary?.inserts || 0;
    const recovered = wr.recovered_after_fetch_failure || applyReport.summary?.recovered_after_fetch_failure || 0;
    const failed = wr.failed || applyReport.summary?.failed_writes || 0;

    totalAttempted += attempted;
    totalCommitted += committed;
    totalRecovered += recovered;
    totalFailed += failed;

    const manifestDetails = await fetchManifestWriteDetails(sb, applyReport.rollback_manifest_id);
    const manifestReconciliation = sessionLib.reconcileManifestWithCommitted({
      manifestWriteDetails: manifestDetails,
      committedIds: applyReport.inserted_ids || [],
      recoveredCount: recovered
    });

    const idempotencyReport = await batchLib.runControlledCatchUpBatch(root, {
      catchUpIdempotency: true,
      expectedActiveCount: applyReport.counts_after?.princess_active,
      expectedSnapshotId: fresh.snapshot_id,
      maxWrites: 0,
      triggerType: "catch_up_idempotency_verification",
      runIdSuffix: `session-batch-${batchNum}-idempotency`,
      reportDir: REPORT_DIR
    });

    const idempotencyCheck = sessionLib.evaluateIdempotencyAnomaly({
      ...idempotencyReport.reconciliation_summary,
      eligible_total: idempotencyReport.summary?.eligible_total,
      duplicate_official_identities:
        idempotencyReport.summary?.resolution_rates?.duplicate_official_identities ?? 0,
      reconciliation_arithmetic_ok: idempotencyReport.summary?.reconciliation_arithmetic_ok
    });

    const cruiseFinder = await runCruiseFinderHealthCheck();
    const countsAfterBatch = applyReport.counts_after || {};
    const collateral = sessionLib.evaluateCollateralInventoryChange({
      halBefore: halBaseline,
      halAfter: countsAfterBatch.hal_active,
      celebrityBefore: celebrityBaseline,
      celebrityAfter: countsAfterBatch.celebrity_active,
      princessDeltaFromSession: applyReport.princess_active_delta || 0
    });

    const postWrite = sessionLib.evaluateBatchPostWriteChecks({
      batchReport: applyReport,
      manifestReconciliation,
      idempotencyCheck,
      cruiseFinderOk: cruiseFinder.ok,
      collateralOk: collateral.ok
    });

    Object.assign(batchRecord, {
      run_id: applyReport.run_id,
      run_record_id: applyReport.run_record_id,
      manifest_id: applyReport.rollback_manifest_id,
      attempted,
      committed,
      recovered,
      failed,
      post_write_verification: applyReport.inserted_verification,
      manifest_reconciliation: manifestReconciliation,
      idempotency_result: idempotencyCheck,
      idempotency_reconciliation: idempotencyReport.reconciliation_summary,
      cruise_finder: cruiseFinder,
      collateral_check: collateral,
      post_write_ok: postWrite.ok,
      stop_reason: postWrite.ok ? null : postWrite.reason
    });

    sessionReport.batches.push(batchRecord);
    batchesCompleted += postWrite.ok ? 1 : 0;
    princessCheckpoint = countsAfterBatch.princess_active ?? princessCheckpoint;

    if (!postWrite.ok || !applyReport.result_ok || applyReport.preflight?.aborted) {
      sessionReport.session_status = "stopped";
      sessionReport.stop_reason = postWrite.reason || sessionLib.STOP_REASONS.UNRECOVERED_WRITE_FAILURE;
      break;
    }

    const continuation = sessionLib.evaluateSessionContinuation({
      batchIndex: batchNum,
      batchesCompleted,
      totalAttemptedWrites: totalAttempted,
      totalCommittedWrites: totalCommitted,
      requestedMaxBatches: args.maxBatches,
      lastBatchOk: true,
      outstandingEligibleInserts: idempotencyReport.reconciliation_summary?.outstanding_eligible_inserts
    });

    batchRecord.continuation = continuation;

    if (!continuation.continue) {
      if (continuation.completed) {
        sessionReport.session_status = "completed";
        sessionReport.stop_reason = null;
        sessionReport.completion_reason = continuation.completion_reason;
      } else {
        sessionReport.session_status = "stopped";
        sessionReport.stop_reason = continuation.reason;
        sessionReport.completion_reason = null;
      }
      break;
    }

    const countsBetween = await batchLib.baselineCounts(root);
    if (countsBetween.princess_active !== princessCheckpoint) {
      const expiryRun = await findRecentDailyExpiryRun(sb, sessionStartedAt);
      const expiredRows = await fetchExpiredRows(sb, expiryRun?.stats?.expired_record_ids || []);
      const expiryEval = sessionLib.evaluateExpiryBetweenBatches({
        princessActiveBefore: princessCheckpoint,
        princessActiveAfter: countsBetween.princess_active,
        halActiveBefore: countsAfterBatch.hal_active,
        halActiveAfter: countsBetween.hal_active,
        celebrityActiveBefore: countsAfterBatch.celebrity_active,
        celebrityActiveAfter: countsBetween.celebrity_active,
        expiryRun,
        princessLineId: batchLib.PRINCESS_LINE_ID,
        expiredPrincessRows: expiredRows
      });
      if (!expiryEval.ok) {
        sessionReport.session_status = "stopped";
        sessionReport.stop_reason = expiryEval.reason || sessionLib.STOP_REASONS.UNEXPLAINED_EXPIRY;
        break;
      }
      if (expiryEval.attributable) {
        princessCheckpoint = expiryEval.freshCheckpointRecommended;
      }
    }
  }

  if (sessionReport.session_status === "running") {
    sessionReport.session_status = batchesCompleted > 0 ? "completed" : "preview_complete";
  }

  sessionReport.total_attempted = totalAttempted;
  sessionReport.total_committed = totalCommitted;
  sessionReport.total_recovered = totalRecovered;
  sessionReport.total_failed = totalFailed;
  sessionReport.writes_performed = totalCommitted;
  sessionReport.counts_end = await batchLib.baselineCounts(root);
  return sessionReport;
}

async function main() {
  const args = parseArgs(process.argv);
  const validation = sessionLib.validateSessionArgs(args);
  if (!validation.ok) {
    console.error(JSON.stringify({ ok: false, errors: validation.errors }, null, 2));
    process.exit(1);
  }

  const sessionId = `princess-catch-up-session-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const countsStart = await batchLib.baselineCounts(root);
  const localGuard = args.apply
    ? sessionLib.validateApplyEnvironment()
    : { ok: true, local_only: true, mode: "read_only" };

  let sessionReport = sessionLib.buildSessionReportSkeleton({
    sessionId,
    mode: args.apply ? "apply" : "dry_run",
    args,
    localGuard,
    countsStart
  });

  if (args.apply) {
    sessionReport = await runApplySession(args, sessionReport);
  } else {
    sessionReport = await runReadOnlyPreview(args, sessionReport);
  }

  sessionReport.ended_at = new Date().toISOString();
  sessionReport.final = sessionLib.buildSessionFinalBlock({
    sessionReport,
    countsEnd: sessionReport.counts_end ?? countsStart
  });

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `princess-controlled-catch-up-session-${sessionId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(sessionReport, null, 2));
  sessionReport.report_path = reportPath;

  console.log(JSON.stringify(sessionReport, null, 2));

  if (sessionLib.resolveSessionExitCode(sessionReport) !== 0) process.exit(1);
}

export {
  parseArgs,
  runReadOnlyPreview,
  runApplySession,
  runCruiseFinderHealthCheck,
  fetchManifestWriteDetails
};

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
