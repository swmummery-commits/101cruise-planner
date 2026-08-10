/**
 * Shared controlled Princess catch-up batch operations (local scripts).
 */

const fs = require("fs");
const path = require("path");
const { createMaintenanceSupabase, createSupabaseRest, getSupabaseConfig } = require("./supabase-rest.cjs");
const postWriteVerification = require(path.join(
  __dirname,
  "../../netlify/functions/lib/princess-post-write-verification"
));

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";
const HAL_LINE_ID = "a8d0e678-0cb2-4ea7-ad73-251f0eb36ea2";
const CELEBRITY_LINE_ID = "aa2c50ed-7ff5-472d-bc96-3d686d76c5ec";
const FIRST_BATCH_MAX = 20;
const CATCHUP_MAX = 100;

function loadBatchDeps(root) {
  return {
    runPrincessWeeklyMaintenance: require(path.join(
      root,
      "netlify/functions/lib/cruise-discovery-maintenance-runner"
    )).runPrincessWeeklyMaintenance,
    createMaintenanceRun: require(path.join(
      root,
      "netlify/functions/lib/cruise-discovery-maintenance-tracking"
    )).createMaintenanceRun,
    finalizeMaintenanceRun: require(path.join(
      root,
      "netlify/functions/lib/cruise-discovery-maintenance-tracking"
    )).finalizeMaintenanceRun,
    buildMaintenanceRunStats: require(path.join(
      root,
      "netlify/functions/lib/cruise-discovery-maintenance-tracking"
    )).buildMaintenanceRunStats,
    resolveMaintenanceRunStatus: require(path.join(
      root,
      "netlify/functions/lib/cruise-discovery-maintenance-tracking"
    )).resolveMaintenanceRunStatus,
    PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE: require(path.join(
      root,
      "netlify/functions/lib/cruise-discovery-maintenance"
    )).PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
    loadMaintenanceLockStatus: require(path.join(
      root,
      "netlify/functions/lib/cruise-discovery-maintenance-locks"
    )).loadMaintenanceLockStatus,
    weeklyLockKey: require(path.join(
      root,
      "netlify/functions/lib/cruise-discovery-maintenance-locks"
    )).weeklyLockKey,
    publicBookingMinimumDepartureDate: require(path.join(
      root,
      "netlify/functions/lib/public-discovered-cruise-inventory"
    )).publicBookingMinimumDepartureDate,
    perthCalendarDate: require(path.join(
      root,
      "netlify/functions/lib/public-discovered-cruise-inventory"
    )).perthCalendarDate
  };
}

async function headCount(root, table, query = "") {
  const https = require("https");
  const { url, key } = getSupabaseConfig(root);
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${table}?select=id${query ? `&${query}` : ""}`);
    https
      .request(
        u,
        { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } },
        (res) => {
          const range = res.headers["content-range"] || "";
          const m = range.match(/\/(\d+)/);
          resolve(m ? Number(m[1]) : 0);
        }
      )
      .on("error", reject)
      .end();
  });
}

async function baselineCounts(root) {
  return {
    princess_active: await headCount(
      root,
      "discovered_cruises",
      `status=eq.active&cruise_line_id=eq.${PRINCESS_LINE_ID}`
    ),
    hal_active: await headCount(root, "discovered_cruises", `status=eq.active&cruise_line_id=eq.${HAL_LINE_ID}`),
    celebrity_active: await headCount(
      root,
      "discovered_cruises",
      `status=eq.active&cruise_line_id=eq.${CELEBRITY_LINE_ID}`
    ),
    manifests: await headCount(root, "cruise_discovery_maintenance_manifests")
  };
}

async function fetchPrincessActiveRows(root, sb, ids = null) {
  const client = sb || createMaintenanceSupabase(root);
  return postWriteVerification.fetchPrincessActiveRows(client, ids);
}

function verifyInsertedRows(rows, _deps = null) {
  return postWriteVerification.verifyInsertedRows(rows);
}

function buildReconciliationSummaryFromResult(summary, writeResult = null) {
  if (!summary) return null;
  return {
    active_production_total: summary.active_production_total ?? null,
    eligible_total: summary.eligible_total ?? null,
    recognised_existing_eligible: summary.recognised_existing_eligible ?? summary.unchanged ?? null,
    outstanding_eligible_inserts: summary.outstanding_eligible_inserts ?? summary.proposed_inserts ?? null,
    proposed_updates: summary.proposed_updates ?? null,
    source_absent_active: summary.source_absent_active ?? null,
    writes_executed: (writeResult?.inserted || 0) + (writeResult?.updated || 0),
    reconciliation_arithmetic_ok: summary.reconciliation_arithmetic_ok ?? null,
    all_active_recognised_in_eligible_source: summary.all_active_recognised_in_eligible_source ?? null
  };
}

async function fetchFreshPrincessReconciliation(root, { runIdSuffix = "preflight", allowRetry = true } = {}) {
  const deps = loadBatchDeps(root);
  const preflightLib = require(path.join(root, "netlify/functions/lib/princess-preflight-result"));
  const sb = createMaintenanceSupabase(root);

  async function attempt(attemptNum) {
    const startedAt = Date.now();
    const suffix = attemptNum > 1 ? `${runIdSuffix}-retry-${attemptNum}` : runIdSuffix;
    const runId = `princess-${suffix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const result = await deps.runPrincessWeeklyMaintenance({
      dryRun: true,
      performWrites: false,
      maxWrites: 0,
      runId,
      supabase: sb,
      triggerType: "catch_up_session_preflight",
      collectSourceDiagnostics: true
    });
    const elapsedMs = Date.now() - startedAt;
    const preflight = preflightLib.classifyPrincessMaintenanceResult(result, { elapsedMs });
    return {
      result,
      preflight,
      runId,
      attemptNum,
      elapsedMs
    };
  }

  function buildReturn(attemptRecord, preflightAttempts) {
    const summary = attemptRecord.result.summary || {};
    const preflight = attemptRecord.preflight;
    return {
      ok: preflight.ok,
      run_id: attemptRecord.runId,
      summary,
      reconciliation_summary: buildReconciliationSummaryFromResult(summary),
      quality_gate: summary.quality_gate || null,
      snapshot_id: summary.snapshot_id || preflight.snapshot_id || null,
      preflight,
      stop_reason: preflight.ok ? null : preflightLib.mapPreflightToStopReason(preflight),
      preflight_attempts: preflightAttempts.map((entry) =>
        preflightLib.buildPreflightAttemptRecord({
          attemptNum: entry.attemptNum,
          preflight: entry.preflight,
          runId: entry.runId,
          elapsedMs: entry.elapsedMs
        })
      ),
      simulation: attemptRecord.result.simulation || null
    };
  }

  const firstAttempt = await attempt(1);
  const attempts = [firstAttempt];

  if (
    !firstAttempt.preflight.ok &&
    allowRetry &&
    preflightLib.isTransientPreflightFailure(firstAttempt.preflight)
  ) {
    await new Promise((resolve) => setTimeout(resolve, preflightLib.PREFLIGHT_RETRY_WAIT_MS));
    const secondAttempt = await attempt(2);
    attempts.push(secondAttempt);
    return buildReturn(secondAttempt, attempts);
  }

  return buildReturn(firstAttempt, attempts);
}

async function preflightNextBatch(root, { expectedActiveCount, expectedSnapshotId, runId }) {
  const deps = loadBatchDeps(root);
  const sb = createMaintenanceSupabase(root);
  const counts = await baselineCounts(root);
  if (counts.princess_active !== expectedActiveCount) {
    return {
      ok: false,
      aborted: true,
      reason: "expected_active_count_mismatch",
      expected_active_count: expectedActiveCount,
      actual_active_count: counts.princess_active,
      writes_performed: false
    };
  }

  const held = await deps.loadMaintenanceLockStatus(sb, deps.weeklyLockKey("princess-cruises"));
  if (held.held && held.owner_id && held.owner_id !== runId) {
    return {
      ok: false,
      aborted: true,
      reason: "maintenance_lock_held",
      lock_owner: held.owner_id,
      writes_performed: false
    };
  }

  const dry = await deps.runPrincessWeeklyMaintenance({
    dryRun: true,
    performWrites: false,
    maxWrites: 0,
    runId: `${runId}-preflight`,
    supabase: sb,
    triggerType: "catch_up_preflight",
    collectSourceDiagnostics: true
  });

  if (!dry.ok) {
    const preflightLib = require(path.join(root, "netlify/functions/lib/princess-preflight-result"));
    const preflight = preflightLib.classifyPrincessMaintenanceResult(dry, { elapsedMs: null });
    return {
      ok: false,
      aborted: true,
      reason: preflightLib.mapPreflightToStopReason(preflight),
      preflight,
      quality_gate: dry.summary?.quality_gate || null,
      writes_performed: false
    };
  }

  const snapshotId = dry.summary?.snapshot_id || null;
  if (snapshotId !== expectedSnapshotId) {
    return {
      ok: false,
      aborted: true,
      reason: "expected_snapshot_id_mismatch",
      expected_snapshot_id: expectedSnapshotId,
      actual_snapshot_id: snapshotId,
      dry_run_summary: dry.summary || null,
      writes_performed: false
    };
  }

  if (!dry.summary?.quality_gate?.passed) {
    const preflightLib = require(path.join(root, "netlify/functions/lib/princess-preflight-result"));
    const preflight = preflightLib.classifyPrincessMaintenanceResult(dry, { elapsedMs: null });
    return {
      ok: false,
      aborted: true,
      reason: preflightLib.mapPreflightToStopReason(preflight),
      preflight,
      quality_gate: dry.summary?.quality_gate || null,
      writes_performed: false
    };
  }

  return { ok: true, counts, dry_run_summary: dry.summary, snapshot_id: snapshotId };
}

function validateNextBatchArgs(args, { requireMaxWrites = false } = {}) {
  if (args.expectedActiveCount == null || Number.isNaN(args.expectedActiveCount)) {
    throw new Error("--expected-active-count=<number> is required");
  }
  if (!args.expectedSnapshotId) {
    throw new Error("--expected-snapshot-id=<snapshot_id> is required");
  }
  if (requireMaxWrites) {
    if (args.maxWrites == null || Number.isNaN(args.maxWrites)) {
      throw new Error("--max-writes=<number> is required for apply");
    }
    if (args.maxWrites < 1 || args.maxWrites > CATCHUP_MAX) {
      throw new Error(`--max-writes must be between 1 and ${CATCHUP_MAX}`);
    }
  }
}

async function runControlledCatchUpBatch(root, {
  apply = false,
  catchUpIdempotency = false,
  expectedActiveCount,
  expectedSnapshotId,
  maxWrites = CATCHUP_MAX,
  triggerType,
  runIdSuffix,
  reportDir
}) {
  const deps = loadBatchDeps(root);
  const sb = createMaintenanceSupabase(root);
  const runId = `princess-${runIdSuffix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const countsBefore = await baselineCounts(root);
  const lockKey = deps.weeklyLockKey("princess-cruises");
  const writeAttempt = apply || catchUpIdempotency;

  if (apply) {
    validateNextBatchArgs({ expectedActiveCount, expectedSnapshotId, maxWrites }, { requireMaxWrites: true });
    const preflight = await preflightNextBatch(root, { expectedActiveCount, expectedSnapshotId, runId });
    if (!preflight.ok) {
      return {
        phase: "preflight_abort",
        run_id: runId,
        trigger_type: triggerType,
        result_ok: false,
        preflight,
        counts_before: countsBefore,
        counts_after: countsBefore,
        rollback_manifest_id: null,
        princess_active_delta: 0
      };
    }
  }

  if (writeAttempt) {
    const held = await deps.loadMaintenanceLockStatus(sb, lockKey);
    if (held.held && held.owner_id && held.owner_id !== runId) {
      throw new Error(
        `Princess maintenance lock already held by ${held.owner_id} (key: ${lockKey}). Aborting before writes.`
      );
    }
  }

  if (catchUpIdempotency) {
    validateNextBatchArgs({ expectedActiveCount, expectedSnapshotId, maxWrites });
    const preflight = await preflightNextBatch(root, { expectedActiveCount, expectedSnapshotId, runId });
    if (!preflight.ok) {
      throw new Error(`Catch-up idempotency preflight failed: ${preflight.reason}`);
    }
  }

  let dbRun = null;
  if (writeAttempt) {
    if (String(process.env.PRINCESS_DISCOVERY_WRITE_ENABLED || "").toLowerCase() !== "true") {
      throw new Error("PRINCESS_DISCOVERY_WRITE_ENABLED must be true for write modes");
    }
    dbRun = await deps.createMaintenanceRun(sb, {
      cruiseLineId: PRINCESS_LINE_ID,
      runId,
      runType: deps.PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
      triggerType,
      stats: {
        line_slug: "princess-cruises",
        controlled_batch: true,
        next_batch: true,
        max_writes: catchUpIdempotency ? 0 : maxWrites,
        expected_active_count: expectedActiveCount,
        expected_snapshot_id: expectedSnapshotId
      }
    });
  }

  const result = await deps.runPrincessWeeklyMaintenance({
    dryRun: !apply,
    performWrites: Boolean(apply),
    writeMode: apply ? "production_write" : "production_read_only",
    maxWrites: catchUpIdempotency ? 0 : maxWrites,
    runId,
    runRecordId: dbRun?.id || null,
    supabase: sb,
    triggerType
  });

  if (dbRun?.id) {
    const summary = result.summary || {};
    await deps.finalizeMaintenanceRun(sb, dbRun.id, {
      status: deps.resolveMaintenanceRunStatus({ ok: result.ok, summary }),
      stats: deps.buildMaintenanceRunStats(summary, {
        run_type: deps.PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
        run_id: runId,
        trigger_type: triggerType,
        controlled_batch: true,
        next_batch: true,
        inventory_changed: (summary.inserts || 0) + (summary.updates || 0) > 0
      })
    });
  }

  const countsAfter = await baselineCounts(root);
  const insertedIds = (result.write_result?.write_details || [])
    .filter((d) => d.created || d.result_action === "inserted" || d.recovered_after_fetch_failure)
    .map((d) => d.discovered_cruise_id)
    .filter(Boolean);

  const insertedRows = insertedIds.length
    ? await fetchPrincessActiveRows(root, createSupabaseRest(root), insertedIds)
    : [];
  const verification = verifyInsertedRows(insertedRows, deps);

  const report = {
    phase: catchUpIdempotency ? "catch_up_idempotency" : apply ? "apply" : "dry_run",
    run_id: runId,
    run_record_id: dbRun?.id || null,
    trigger_type: triggerType,
    next_batch: true,
    expected_active_count: expectedActiveCount,
    expected_snapshot_id: expectedSnapshotId,
    max_writes: maxWrites,
    result_ok: result.ok,
    summary: result.summary || null,
    reconciliation_summary: buildReconciliationSummaryFromResult(result.summary, result.write_result),
    quality_gate: result.summary?.quality_gate || null,
    write_result: result.write_result || null,
    rollback_manifest_id: result.summary?.rollback_manifest_id || null,
    counts_before: countsBefore,
    counts_after: countsAfter,
    inserted_ids: insertedIds,
    inserted_verification: verification,
    princess_active_delta: countsAfter.princess_active - countsBefore.princess_active,
    hal_unchanged: countsAfter.hal_active === countsBefore.hal_active,
    celebrity_unchanged: countsAfter.celebrity_active === countsBefore.celebrity_active
  };

  if (reportDir) {
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `princess-controlled-batch-${runIdSuffix}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    report.report_path = reportPath;
  }

  return report;
}

module.exports = {
  PRINCESS_LINE_ID,
  HAL_LINE_ID,
  CELEBRITY_LINE_ID,
  FIRST_BATCH_MAX,
  CATCHUP_MAX,
  loadBatchDeps,
  headCount,
  baselineCounts,
  fetchPrincessActiveRows,
  verifyInsertedRows,
  buildReconciliationSummaryFromResult,
  fetchFreshPrincessReconciliation,
  preflightNextBatch,
  validateNextBatchArgs,
  runControlledCatchUpBatch
};
