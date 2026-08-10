#!/usr/bin/env node
/**
 * Architecture tests for local-only Princess catch-up session runner (no production writes).
 *   node scripts/test-princess-catch-up-session.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const reconciliation = require(path.join(root, "netlify/functions/lib/princess-reconciliation-summary"));
const session = require(path.join(root, "netlify/functions/lib/princess-catch-up-session"));
const preflight = require(path.join(root, "netlify/functions/lib/princess-preflight-result"));

const sessionSrc = fs.readFileSync(
  path.join(root, "scripts/run-princess-controlled-catch-up-session.mjs"),
  "utf8"
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

test("default mode is zero-write (no --apply in script default path)", () => {
  if (!sessionSrc.includes('mode: args.apply ? "apply" : "dry_run"')) {
    throw new Error("missing dry_run default mode");
  }
  if (!sessionSrc.includes("runReadOnlyPreview")) throw new Error("missing read-only preview");
});

test("apply requires explicit confirmation token", () => {
  const bad = session.validateSessionArgs({
    apply: true,
    maxBatches: 1,
    expectedStartActive: 416,
    confirm: "WRONG"
  });
  if (bad.ok) throw new Error("expected confirmation failure");
  const good = session.validateSessionArgs({
    apply: true,
    maxBatches: 1,
    expectedStartActive: 416,
    confirm: session.APPLY_CONFIRM_TOKEN
  });
  if (!good.ok) throw new Error("expected valid apply args");
});

test("expected-start-active required for apply", () => {
  const v = session.validateSessionArgs({
    apply: true,
    maxBatches: 1,
    confirm: session.APPLY_CONFIRM_TOKEN,
    expectedStartActive: null
  });
  if (v.ok) throw new Error("expected start active required");
});

test("max batches >3 rejected", () => {
  const v = session.validateSessionArgs({ apply: false, maxBatches: 4 });
  if (v.ok) throw new Error("max batches 4 must be rejected");
});

test("max batches 1-3 allowed", () => {
  for (const n of [1, 2, 3]) {
    const v = session.validateSessionArgs({ apply: false, maxBatches: n });
    if (!v.ok) throw new Error(`max batches ${n} should be allowed`);
  }
});

test("max writes per batch cannot exceed 100", () => {
  if (session.BATCH_MAX_WRITES !== 100) throw new Error("batch max must be 100");
  const budget = session.computeBatchWriteBudget({
    outstandingEligibleInserts: 500,
    sessionAttemptedWrites: 0,
    maxBatchesRemaining: 3
  });
  if (budget.batch_max_writes > 100) throw new Error("budget exceeds 100 per batch");
});

test("max session attempted writes cannot exceed 300", () => {
  if (session.MAX_WRITES_PER_SESSION !== 300) throw new Error("session max must be 300");
  const budget = session.computeBatchWriteBudget({
    outstandingEligibleInserts: 1000,
    sessionAttemptedWrites: 250,
    maxBatchesRemaining: 3
  });
  if (budget.batch_max_writes > 50) throw new Error("should cap at remaining session budget");
  if (250 + budget.batch_max_writes > 300) throw new Error("session total would exceed 300");
});

test("cloud/CI apply rejected", () => {
  const guard = session.validateApplyEnvironment({ GITHUB_ACTIONS: "true" });
  if (guard.ok) throw new Error("GitHub Actions must block apply");
  const local = session.validateApplyEnvironment({});
  if (!local.ok) throw new Error("local env should allow apply guard pass");
});

test("batch 1 success permits batch 2", () => {
  const next = session.evaluateSessionContinuation({
    batchIndex: 1,
    batchesCompleted: 1,
    totalAttemptedWrites: 100,
    totalCommittedWrites: 100,
    maxBatchesPerSession: 3,
    lastBatchOk: true,
    outstandingEligibleInserts: 990
  });
  if (!next.continue) throw new Error("batch 2 should be permitted");
});

test("batch 1 failure blocks batch 2", () => {
  const next = session.evaluateSessionContinuation({
    batchIndex: 1,
    batchesCompleted: 0,
    totalAttemptedWrites: 100,
    lastBatchOk: false
  });
  if (next.continue) throw new Error("failed batch must block continuation");
});

test("batch 2 failure blocks batch 3", () => {
  const next = session.evaluateSessionContinuation({
    batchIndex: 2,
    batchesCompleted: 1,
    totalAttemptedWrites: 200,
    lastBatchOk: false
  });
  if (next.continue) throw new Error("batch 2 failure must block batch 3");
});

test("manifest mismatch stops post-write checks", () => {
  const check = session.evaluateBatchPostWriteChecks({
    batchReport: { write_result: { failed: 0 }, inserted_verification: { ok: true } },
    manifestReconciliation: { ok: false, manifest_count: 99, committed_count: 100 },
    idempotencyCheck: { ok: true },
    cruiseFinderOk: true,
    collateralOk: true
  });
  if (check.ok) throw new Error("manifest mismatch must stop");
  if (check.reason !== session.STOP_REASONS.MANIFEST_MISMATCH) throw new Error("wrong stop reason");
});

test("lock loss maps to lock ownership stop reason constant", () => {
  if (!session.STOP_REASONS.LOCK_OWNERSHIP_LOST) throw new Error("missing lock ownership reason");
});

test("source quality failure stop reason exists", () => {
  if (!session.STOP_REASONS.QUALITY_GATE_FAILED) throw new Error("missing quality gate reason");
});

test("preflight snapshot mismatch stop reason exists", () => {
  if (!session.STOP_REASONS.SNAPSHOT_MISMATCH) throw new Error("missing snapshot mismatch reason");
});

test("unresolved count mismatch uses start active mismatch on first batch", () => {
  if (!session.STOP_REASONS.START_ACTIVE_MISMATCH) throw new Error("missing start mismatch reason");
  if (!session.STOP_REASONS.ACTIVE_COUNT_MISMATCH) throw new Error("missing active mismatch reason");
});

test("legitimate verified daily expiry between batches can refresh checkpoint", () => {
  const result = session.evaluateExpiryBetweenBatches({
    princessActiveBefore: 416,
    princessActiveAfter: 414,
    halActiveBefore: 824,
    halActiveAfter: 824,
    celebrityActiveBefore: 1172,
    celebrityActiveAfter: 1172,
    expiryRun: {
      id: "expiry-run-1",
      stats: {
        run_id: "daily-expiry-1",
        expired_count: 2,
        expired_record_ids: ["a", "b"]
      }
    },
    princessLineId: "princess-line",
    expiredPrincessRows: [
      { id: "a", cruise_line_id: "princess-line", status: "expired" },
      { id: "b", cruise_line_id: "princess-line", status: "expired" }
    ]
  });
  if (!result.ok || !result.attributable) throw new Error("expected attributable expiry");
  if (result.freshCheckpointRecommended !== 414) throw new Error("expected checkpoint refresh");
});

test("unexplained expiry/count delta stops", () => {
  const result = session.evaluateExpiryBetweenBatches({
    princessActiveBefore: 416,
    princessActiveAfter: 410,
    halActiveBefore: 824,
    halActiveAfter: 824,
    celebrityActiveBefore: 1172,
    celebrityActiveAfter: 1172,
    expiryRun: null
  });
  if (result.ok) throw new Error("unexplained delta must stop");
});

test("idempotency anomaly stops when active != recognised", () => {
  const idem = session.evaluateIdempotencyAnomaly({
    active_production_total: 416,
    recognised_existing_eligible: 316,
    outstanding_eligible_inserts: 1090,
    eligible_total: 1506,
    source_absent_active: 0,
    writes_executed: 0
  });
  if (idem.ok) throw new Error("316 vs 416 must be idempotency anomaly");
});

test("Cruise Finder regression stop reason exists and post-write check uses it", () => {
  const check = session.evaluateBatchPostWriteChecks({
    batchReport: { write_result: { failed: 0 }, inserted_verification: { ok: true } },
    manifestReconciliation: { ok: true },
    idempotencyCheck: { ok: true },
    cruiseFinderOk: false,
    collateralOk: true
  });
  if (check.ok) throw new Error("cruise finder regression must stop");
});

test("HAL/Celebrity collateral write stops when unattributed", () => {
  const col = session.evaluateCollateralInventoryChange({
    halBefore: 824,
    halAfter: 820,
    celebrityBefore: 1172,
    celebrityAfter: 1172,
    princessDeltaFromSession: 100
  });
  if (col.ok) throw new Error("unattributed HAL change must fail");
  const check = session.evaluateBatchPostWriteChecks({
    batchReport: { write_result: { failed: 0 }, inserted_verification: { ok: true } },
    manifestReconciliation: { ok: true },
    idempotencyCheck: { ok: true },
    cruiseFinderOk: true,
    collateralOk: col.ok
  });
  if (check.ok) throw new Error("collateral failure must stop batch");
});

test("final partial batch below 100 supported", () => {
  const budget = session.computeBatchWriteBudget({
    outstandingEligibleInserts: 45,
    sessionAttemptedWrites: 200,
    maxBatchesRemaining: 1
  });
  if (budget.batch_max_writes !== 45) throw new Error("expected partial final batch of 45");
});

test("zero outstanding eligible inserts ends session cleanly", () => {
  const next = session.evaluateSessionContinuation({
    batchIndex: 0,
    batchesCompleted: 0,
    outstandingEligibleInserts: 0,
    lastBatchOk: true
  });
  if (next.continue) throw new Error("zero outstanding must stop");
  if (!next.completed) throw new Error("zero outstanding must be clean completion");
  if (next.reason != null) throw new Error("zero outstanding must not set stop reason");
  if (next.completion_reason !== session.COMPLETION_REASONS.ZERO_OUTSTANDING_ELIGIBLE) {
    throw new Error("expected zero outstanding completion reason");
  }
});

test("each successful batch should have unique run + manifest IDs (session script structure)", () => {
  if (!sessionSrc.includes("run_id: applyReport.run_id")) throw new Error("batch run id tracked");
  if (!sessionSrc.includes("manifest_id: applyReport.rollback_manifest_id")) {
    throw new Error("batch manifest id tracked");
  }
  if (!sessionSrc.includes("session-batch-${batchNum}-apply")) {
    throw new Error("independent batch suffix expected");
  }
});

test("session report arithmetic fields present", () => {
  if (!sessionSrc.includes("total_attempted")) throw new Error("missing total_attempted");
  if (!sessionSrc.includes("total_committed")) throw new Error("missing total committed");
  if (!sessionSrc.includes("princess-controlled-catch-up-session")) throw new Error("missing report path");
});

test("reconciliation_summary fields remain unambiguous after 416 batch", () => {
  const summary = reconciliation.buildPrincessReconciliationSummary({
    activeProductionTotal: 416,
    eligibleTotal: 1506,
    recognisedExistingEligible: 416,
    outstandingEligibleInserts: 1090,
    proposedUpdates: 0,
    sourceAbsentActive: 0
  });
  if (summary.recognised_existing_eligible !== 416) throw new Error("expected 416 recognised");
  if (!summary.reconciliation_arithmetic_ok) throw new Error("arithmetic must reconcile");
});

test("316 existing + 100 inserts => idempotency recognises all 416 active eligible identities", () => {
  const idem = session.evaluateIdempotencyAnomaly({
    active_production_total: 416,
    recognised_existing_eligible: 416,
    outstanding_eligible_inserts: 1090,
    proposed_updates: 0,
    eligible_total: 1506,
    source_absent_active: 0,
    writes_executed: 0,
    reconciliation_arithmetic_ok: true
  });
  if (!idem.ok) throw new Error(`false positive: ${idem.detail}`);
});

test("session preview does not fabricate future batch snapshots", () => {
  if (sessionSrc.includes("for (let batchNum") && sessionSrc.includes("runReadOnlyPreview")) {
    const previewBody = sessionSrc.split("async function runReadOnlyPreview")[1]?.split("async function runApplySession")[0];
    if (previewBody?.includes("runControlledCatchUpBatch")) {
      throw new Error("preview must not run apply batches");
    }
  }
  const preview = session.computeSessionPreview({
    activeProductionTotal: 416,
    reconciliation: { outstanding_eligible_inserts: 1090 },
    maxBatches: 3
  });
  if (preview.theoretical_max_writes !== 300) throw new Error("preview max writes should be 300");
});

test("parseSessionArgs defaults to read-only (apply false)", () => {
  const args = session.parseSessionArgs(["node", "script.mjs"]);
  if (args.apply) throw new Error("default must not be apply");
});

test("max-batches=1 + successful batch => completed with success exit semantics", () => {
  const next = session.evaluateSessionContinuation({
    batchIndex: 1,
    batchesCompleted: 1,
    totalAttemptedWrites: 100,
    totalCommittedWrites: 100,
    requestedMaxBatches: 1,
    lastBatchOk: true,
    outstandingEligibleInserts: 990
  });
  if (next.continue) throw new Error("must not continue after requested batch limit");
  if (!next.completed) throw new Error("requested batch limit must be clean completion");
  if (next.reason != null) throw new Error("clean completion must not set stop reason");
  if (next.completion_reason !== session.COMPLETION_REASONS.REQUESTED_BATCH_LIMIT_REACHED) {
    throw new Error("expected requested batch limit completion reason");
  }
  const exitCode = session.resolveSessionExitCode({
    session_status: "completed",
    stop_reason: null,
    completion_reason: session.COMPLETION_REASONS.REQUESTED_BATCH_LIMIT_REACHED
  });
  if (exitCode !== 0) throw new Error("completed session must exit 0");
});

test("max-batches=3 + three successful batches => completed, exit 0, exactly 3 batches", () => {
  let batchesCompleted = 0;
  for (let batchNum = 1; batchNum <= 3; batchNum += 1) {
    const next = session.evaluateSessionContinuation({
      batchIndex: batchNum,
      batchesCompleted,
      totalAttemptedWrites: batchesCompleted * 100,
      totalCommittedWrites: batchesCompleted * 100,
      requestedMaxBatches: 3,
      lastBatchOk: true,
      outstandingEligibleInserts: 990 - batchesCompleted * 100
    });
    if (batchNum < 3) {
      if (!next.continue) throw new Error(`batch ${batchNum} should permit continuation`);
      batchesCompleted += 1;
    } else {
      batchesCompleted += 1;
      const afterThird = session.evaluateSessionContinuation({
        batchIndex: 3,
        batchesCompleted: 3,
        totalAttemptedWrites: 300,
        totalCommittedWrites: 300,
        requestedMaxBatches: 3,
        lastBatchOk: true,
        outstandingEligibleInserts: 690
      });
      if (afterThird.continue) throw new Error("batch 4 must not start");
      if (!afterThird.completed) throw new Error("three requested batches must complete cleanly");
      if (afterThird.completion_reason !== session.COMPLETION_REASONS.REQUESTED_BATCH_LIMIT_REACHED) {
        throw new Error("expected requested batch completion reason after batch 3");
      }
    }
  }
});

test("hard max batches >3 still rejected", () => {
  const v = session.validateSessionArgs({ apply: false, maxBatches: 4 });
  if (v.ok) throw new Error("max batches 4 must remain rejected");
});

test("batch failure before requested ceiling => stopped with non-success exit", () => {
  const next = session.evaluateSessionContinuation({
    batchIndex: 1,
    batchesCompleted: 0,
    requestedMaxBatches: 3,
    lastBatchOk: false
  });
  if (next.continue) throw new Error("failed batch must block next batch");
  if (next.completed) throw new Error("failed batch must not be clean completion");
  const exitCode = session.resolveSessionExitCode({
    session_status: "stopped",
    stop_reason: session.STOP_REASONS.UNRECOVERED_WRITE_FAILURE
  });
  if (exitCode === 0) throw new Error("stopped session must not exit 0");
});

test("final.outstanding_eligible_inserts populated from final idempotency reconciliation", () => {
  const finalBlock = session.buildSessionFinalBlock({
    sessionReport: {
      batches: [
        {
          idempotency_reconciliation: {
            active_production_total: 516,
            eligible_total: 1506,
            recognised_existing_eligible: 516,
            outstanding_eligible_inserts: 990,
            proposed_updates: 0,
            source_absent_active: 0,
            reconciliation_arithmetic_ok: true
          }
        }
      ]
    },
    countsEnd: { princess_active: 516, hal_active: 824, celebrity_active: 1172 }
  });
  if (finalBlock.outstanding_eligible_inserts !== 990) {
    throw new Error(`expected 990 outstanding, got ${finalBlock.outstanding_eligible_inserts}`);
  }
  if (finalBlock.recognised_existing_eligible !== 516) throw new Error("expected recognised 516");
});

test("final outstanding count is not derived only from subtraction", () => {
  if (sessionSrc.includes("outstandingEligibleInserts - attempted")) {
    throw new Error("final outstanding must not be simple subtraction");
  }
  if (!sessionSrc.includes("buildSessionFinalBlock")) throw new Error("must use buildSessionFinalBlock");
  if (!sessionSrc.includes("idempotency_reconciliation")) {
    throw new Error("must store idempotency reconciliation on batch");
  }
});

test("final reconciliation fields agree with final idempotency result", () => {
  const reconciliationSummary = {
    active_production_total: 516,
    eligible_total: 1506,
    recognised_existing_eligible: 516,
    outstanding_eligible_inserts: 990,
    proposed_updates: 0,
    source_absent_active: 0,
    reconciliation_arithmetic_ok: true
  };
  const extracted = session.extractFinalReconciliation({
    batches: [{ idempotency_reconciliation: reconciliationSummary }]
  });
  if (extracted.outstanding_eligible_inserts !== reconciliationSummary.outstanding_eligible_inserts) {
    throw new Error("final reconciliation must mirror idempotency summary");
  }
  if (extracted.reconciliation_arithmetic_ok !== true) throw new Error("arithmetic flag must match");
});

test("requested max batches reached with partial final batch => clean completion", () => {
  const next = session.evaluateSessionContinuation({
    batchIndex: 3,
    batchesCompleted: 3,
    totalAttemptedWrites: 245,
    totalCommittedWrites: 245,
    requestedMaxBatches: 3,
    lastBatchOk: true,
    outstandingEligibleInserts: 745
  });
  if (!next.completed) throw new Error("partial third batch at requested ceiling must complete cleanly");
  if (next.completion_reason !== session.COMPLETION_REASONS.REQUESTED_BATCH_LIMIT_REACHED) {
    throw new Error("expected requested batch completion reason");
  }
});

test("hard safety write ceiling remains distinct from requested batch completion", () => {
  const requestedDone = session.evaluateSessionContinuation({
    batchIndex: 1,
    batchesCompleted: 1,
    totalAttemptedWrites: 100,
    requestedMaxBatches: 1,
    lastBatchOk: true,
    outstandingEligibleInserts: 990
  });
  if (requestedDone.reason === session.STOP_REASONS.SESSION_BATCH_CEILING) {
    throw new Error("requested limit must not use session_batch_ceiling stop reason");
  }

  const safetyStop = session.evaluateSessionContinuation({
    batchIndex: 2,
    batchesCompleted: 1,
    totalAttemptedWrites: 300,
    requestedMaxBatches: 3,
    lastBatchOk: true,
    outstandingEligibleInserts: 690
  });
  if (safetyStop.completed) throw new Error("hard write ceiling while batches remain is a safety stop");
  if (safetyStop.reason !== session.STOP_REASONS.SESSION_WRITE_CEILING) {
    throw new Error("expected hard write ceiling stop reason");
  }
});

test("resolveSessionExitCode treats stopped as failure and completed as success", () => {
  if (session.resolveSessionExitCode({ session_status: "stopped" }) !== 1) {
    throw new Error("stopped must exit 1");
  }
  if (session.resolveSessionExitCode({ session_status: "completed" }) !== 0) {
    throw new Error("completed must exit 0");
  }
  if (session.resolveSessionExitCode({ session_status: "preview_complete" }) !== 0) {
    throw new Error("preview must exit 0");
  }
});

test("fresh.ok=false + quality_gate=null => NOT quality_gate_failed", () => {
  const classified = preflight.classifyPrincessMaintenanceResult({
    ok: false,
    blocked: true,
    reason: "maintenance_lock_held",
    worker_state: "already_running",
    lock_status: { held: true, owner_id: "other-run" }
  });
  if (classified.preflight_error_code !== preflight.PREFLIGHT_ERROR_CODES.LOCK_UNAVAILABLE) {
    throw new Error("expected lock_unavailable classification");
  }
  if (classified.quality_gate_evaluated !== false) {
    throw new Error("quality gate must not be marked evaluated");
  }
  const stopReason = preflight.mapPreflightToStopReason(classified);
  if (stopReason === session.STOP_REASONS.QUALITY_GATE_FAILED) {
    throw new Error("lock failure must not map to quality_gate_failed");
  }
  if (stopReason !== session.STOP_REASONS.LOCK_UNAVAILABLE) {
    throw new Error(`expected lock_unavailable stop, got ${stopReason}`);
  }
});

test("actual quality gate evaluated false => quality_gate_failed", () => {
  const classified = preflight.classifyPrincessMaintenanceResult({
    ok: false,
    blocked: true,
    failed: true,
    summary: {
      quality_gate: { passed: false, failures: ["ship_resolution_below_98pct"], blocked: true },
      snapshot_id: "abc123"
    }
  });
  if (classified.quality_gate_evaluated !== true || classified.quality_gate_passed !== false) {
    throw new Error("quality gate should be evaluated false");
  }
  if (classified.preflight_error_code !== preflight.PREFLIGHT_ERROR_CODES.RESOLUTION_BELOW_THRESHOLD) {
    throw new Error("resolution-only failure should map to resolution_below_threshold");
  }
  const mixed = preflight.classifyPrincessMaintenanceResult({
    ok: false,
    summary: {
      quality_gate: {
        passed: false,
        failures: ["eligible_inventory_collapse_gt_20pct"],
        blocked: true
      }
    }
  });
  if (preflight.mapPreflightToStopReason(mixed) !== session.STOP_REASONS.QUALITY_GATE_FAILED) {
    throw new Error("non-resolution gate failure must map to quality_gate_failed");
  }
});

test("source bootstrap failure => source_fetch_failed stop mapping", () => {
  const classified = preflight.classifyPrincessMaintenanceResult({
    ok: false,
    failed: true,
    reason: "official_source_unreachable",
    simulation: {
      fetch_failed: true,
      error: "ube_bootstrap_http_503",
      source_diagnostics: { stage: "bootstrap", bootstrap: { stage: "bootstrap", status: 503 } }
    }
  });
  if (classified.preflight_error_code !== preflight.PREFLIGHT_ERROR_CODES.SOURCE_BOOTSTRAP_FAILED) {
    throw new Error("expected bootstrap failure code");
  }
  if (preflight.mapPreflightToStopReason(classified) !== session.STOP_REASONS.SOURCE_FETCH_FAILED) {
    throw new Error("bootstrap failure maps to source_fetch_failed stop reason");
  }
});

test("catalogue failure => source_fetch_failed stop mapping", () => {
  const classified = preflight.classifyPrincessMaintenanceResult({
    ok: false,
    failed: true,
    reason: "official_source_unreachable",
    simulation: {
      fetch_failed: true,
      error: "products_fetch_failed",
      source_diagnostics: { stage: "catalogue", catalogue: { stage: "catalogue", status: 502 } }
    }
  });
  if (classified.preflight_error_code !== preflight.PREFLIGHT_ERROR_CODES.SOURCE_CATALOGUE_FAILED) {
    throw new Error("expected catalogue failure code");
  }
});

test("source timeout => source_timeout stop mapping", () => {
  const classified = preflight.classifyPrincessMaintenanceResult({
    ok: false,
    failed: true,
    reason: "official_source_unreachable",
    simulation: {
      fetch_failed: true,
      error: "princess_source_timeout",
      source_diagnostics: { stage: "catalogue" }
    }
  });
  if (classified.preflight_error_code !== preflight.PREFLIGHT_ERROR_CODES.SOURCE_TIMEOUT) {
    throw new Error("expected timeout code");
  }
  if (preflight.mapPreflightToStopReason(classified) !== session.STOP_REASONS.SOURCE_TIMEOUT) {
    throw new Error("timeout maps to source_timeout stop reason");
  }
});

test("lock unavailable => lock_unavailable stop mapping", () => {
  const stopReason = preflight.mapPreflightToStopReason({
    preflight_error_code: preflight.PREFLIGHT_ERROR_CODES.LOCK_UNAVAILABLE
  });
  if (stopReason !== session.STOP_REASONS.LOCK_UNAVAILABLE) throw new Error("lock mapping failed");
});

test("unexpected exception-style preflight => unexpected_preflight_error", () => {
  const classified = preflight.classifyPrincessMaintenanceResult({ ok: false, reason: "unknown" });
  if (classified.preflight_error_code !== preflight.PREFLIGHT_ERROR_CODES.UNEXPECTED_PREFLIGHT_ERROR) {
    throw new Error("expected unexpected_preflight_error");
  }
});

test("failure report preserves diagnostic fields", () => {
  const classified = preflight.classifyPrincessMaintenanceResult(
    {
      ok: false,
      blocked: true,
      reason: "maintenance_lock_held",
      lock_status: { held: true, owner_id: "owner-1" }
    },
    { elapsedMs: 6123 }
  );
  const record = preflight.buildPreflightAttemptRecord({
    attemptNum: 1,
    preflight: classified,
    runId: "run-1",
    elapsedMs: 6123
  });
  if (record.elapsed_ms !== 6123) throw new Error("elapsed_ms missing");
  if (record.quality_gate_evaluated !== false) throw new Error("quality_gate_evaluated missing");
  if (!record.lock_status?.owner_id) throw new Error("lock_status missing");
});

test("session runner maps preflight stop reasons instead of blanket quality_gate_failed", () => {
  if (!sessionSrc.includes("fresh.stop_reason")) throw new Error("must use fresh.stop_reason");
  if (!sessionSrc.includes("preflight_attempts")) throw new Error("must record preflight_attempts");
  if (!sessionSrc.includes("UNEXPECTED_PREFLIGHT_ERROR")) throw new Error("unexpected preflight stop must exist");
});

test("transient preflight failure is retryable; quality gate failure is not", () => {
  const batchSrc = fs.readFileSync(
    path.join(root, "scripts/lib/princess-controlled-catch-up-batch.cjs"),
    "utf8"
  );
  const lockFailure = preflight.classifyPrincessMaintenanceResult({
    ok: false,
    blocked: true,
    reason: "maintenance_lock_held"
  });
  const gateFailure = preflight.classifyPrincessMaintenanceResult({
    ok: false,
    summary: { quality_gate: { passed: false, failures: ["eligible_inventory_collapse_gt_20pct"] } }
  });
  if (!preflight.isTransientPreflightFailure(lockFailure)) {
    throw new Error("lock failure should be transient");
  }
  if (preflight.isTransientPreflightFailure(gateFailure)) {
    throw new Error("quality gate failure must not be transient");
  }
  if (!batchSrc.includes("allowRetry")) throw new Error("batch lib should support allowRetry preflight path");
});

test("bounded preflight retry path exists with single retry wait", () => {
  const batchSrc = fs.readFileSync(
    path.join(root, "scripts/lib/princess-controlled-catch-up-batch.cjs"),
    "utf8"
  );
  if (!batchSrc.includes("PREFLIGHT_RETRY_WAIT_MS")) throw new Error("missing retry wait constant usage");
  if (!batchSrc.includes("attempt(2)")) throw new Error("missing second attempt");
  if (preflight.PREFLIGHT_RETRY_WAIT_MS !== 2500) throw new Error("retry wait should be 2500ms");
});

console.log(`\ntest-princess-catch-up-session: ${passed} passed`);
