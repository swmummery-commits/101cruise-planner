/**
 * Netlify-orchestrated Mac harvest for Princess weekly maintenance.
 * Netlify does not call the Princess official catalogue from AWS.
 */

const { persistMissedScheduleEvent } = require("./cruise-discovery-maintenance-tracking");
const { netlifyShouldOrchestrateMacHarvest } = require("./princess-source-architecture");
const {
  resolvePrincessHarvestStore,
  enqueuePrincessHarvestRequest,
  waitForPrincessHarvest
} = require("./princess-harvest-queue");

const WAIT_GRACE_MS = 8 * 60 * 1000;
const WAIT_STALE_MS = 12 * 60 * 1000;
const WAIT_POLL_MS = 5000;

async function orchestratePrincessMacHarvest(context = {}) {
  const sb = context.supabase;
  const store = await resolvePrincessHarvestStore(sb);
  const dispatchId = String(context.dispatchId || context.dispatch_id || context.runId || "").trim();
  const periodKey = String(context.periodKey || context.period_key || dispatchId).trim();
  const enqueued = await enqueuePrincessHarvestRequest(store, {
    period_key: periodKey,
    dispatch_id: dispatchId,
    run_record_id: context.runRecordId || context.run_record_id || null,
    dry_run: context.dryRun !== false && context.performWrites !== true
  });
  const wait = await waitForPrincessHarvest(store, enqueued.request.id, {
    expectedStartMs: Date.parse(enqueued.request.requested_at) || Date.now(),
    graceMs: Number(context.harvestGraceMs || WAIT_GRACE_MS),
    staleMs: Number(context.harvestStaleMs || WAIT_STALE_MS),
    pollMs: Number(context.harvestPollMs || WAIT_POLL_MS)
  });
  const freeze = wait.request?.source_freeze || null;
  if (!wait.ok) {
    if (context.cruiseLineId) {
      await persistMissedScheduleEvent(sb, {
        cruiseLineId: context.cruiseLineId,
        lineSlug: "princess-cruises",
        periodKey,
        isoWeek: periodKey,
        reason: wait.status === "STALE_SOURCE_WORKER" ? "STALE_SOURCE_WORKER" : "SOURCE_WORKER_NOT_STARTED"
      }).catch(() => null);
    }
    return {
      ok: false,
      failed: true,
      blocked: false,
      reason: wait.status,
      terminal_status:
        wait.status === "STALE_SOURCE_WORKER" ? "stale_source_worker" : "source_worker_not_started",
      summary: {
        terminal_status:
          wait.status === "STALE_SOURCE_WORKER" ? "stale_source_worker" : "source_worker_not_started",
        inserts: 0,
        updates: 0,
        inventory_changed: false,
        source_freeze_retained: Boolean(freeze),
        harvest_request_id: enqueued.request.id,
        source_snapshot_id: freeze?.snapshot_id || wait.request?.source_snapshot_hash || null
      }
    };
  }
  return {
    ok: true,
    read_only: enqueued.request.dry_run !== false,
    terminal_status: freeze?.terminal_status || "read_only",
    reason: null,
    summary: {
      ...(freeze || {}),
      terminal_status: freeze?.terminal_status || "read_only",
      inserts: freeze?.inserts || 0,
      updates: freeze?.updates || 0,
      inventory_changed: freeze?.inventory_changed === true,
      eligible_total: freeze?.eligible_total ?? wait.request.eligible_count,
      snapshot_id: freeze?.snapshot_id || wait.request.source_snapshot_hash,
      harvest_request_id: enqueued.request.id,
      source_worker: "mac"
    }
  };
}

function wrapPrincessRunMaintenance(runPrincessWeeklyMaintenance) {
  return async function runPrincessWeeklyMaintenanceOrOrchestrate(context = {}) {
    if (context.macHarvestWorker === true) {
      return runPrincessWeeklyMaintenance(context);
    }
    const trigger = String(context.triggerType || context.trigger_type || "");
    if (trigger === "production_smoke" || trigger === "p3p_source_diagnostic") {
      return runPrincessWeeklyMaintenance(context);
    }
    if (!netlifyShouldOrchestrateMacHarvest(context.env || process.env)) {
      return runPrincessWeeklyMaintenance(context);
    }
    return orchestratePrincessMacHarvest(context);
  };
}

module.exports = {
  WAIT_GRACE_MS,
  WAIT_STALE_MS,
  orchestratePrincessMacHarvest,
  wrapPrincessRunMaintenance
};
