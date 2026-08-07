/**
 * Synchronous read-only Princess Discovery smoke test (production verification).
 *
 * POST /.netlify/functions/princess-discovery-smoke
 * Header: x-discovery-cron-secret = DISCOVERY_CRON_SECRET
 *
 * Always dry_run. Never writes. Returns JSON (not 202).
 */

const { runPrincessWeeklyMaintenance } = require("./lib/cruise-discovery-maintenance-runner");
const { supabase } = require("./lib/cruise-discovery-runner");
const { loadMaintenanceLockStatus, weeklyLockKey } = require("./lib/cruise-discovery-maintenance-locks");
const {
  createMaintenanceRun,
  finalizeMaintenanceRun,
  buildMaintenanceRunStats
} = require("./lib/cruise-discovery-maintenance-tracking");
const { PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE } = require("./lib/cruise-discovery-maintenance");

function cronSecret() {
  return String(process.env.DISCOVERY_CRON_SECRET || "").trim();
}

function assertCronAuth(event) {
  const expected = cronSecret();
  if (!expected) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.statusCode = 503;
    throw err;
  }
  const provided = String(
    event.headers?.["x-discovery-cron-secret"] ||
      event.headers?.["X-Discovery-Cron-Secret"] ||
      ""
  ).trim();
  if (provided !== expected) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

exports.handler = async (event) => {
  const started = Date.now();
  const runId = `princess-smoke-${Date.now()}`;
  const lockKey = weeklyLockKey("princess-cruises");

  try {
    assertCronAuth(event);

    if (event.httpMethod && event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ ok: false, error: "method_not_allowed" }) };
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      body = {};
    }

    if (body.mode && String(body.mode).trim() !== "production_read_only") {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok: false, error: "smoke_read_only_only" })
      };
    }

    const lockBefore = await loadMaintenanceLockStatus(supabase, lockKey);
    const lines = await supabase(
      "ci_cruise_lines?slug=eq.princess-cruises&select=id,name,slug&limit=1"
    );
    const line = lines?.[0];
    const dbRun = line
      ? await createMaintenanceRun(supabase, {
          cruiseLineId: line.id,
          runId,
          runType: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
          triggerType: "production_smoke",
          stats: { line_slug: "princess-cruises", smoke: true }
        })
      : null;

    const result = await runPrincessWeeklyMaintenance({
      dryRun: true,
      performWrites: false,
      maxWrites: 0,
      runId,
      runRecordId: dbRun?.id || null,
      triggerType: "production_smoke",
      supabase
    });
    const lockAfter = await loadMaintenanceLockStatus(supabase, lockKey);

    if (dbRun?.id) {
      const summary = result.summary || {};
      await finalizeMaintenanceRun(supabase, dbRun.id, {
        status: result.ok ? "completed" : "failed",
        stats: buildMaintenanceRunStats(summary, {
          run_type: PRINCESS_WEEKLY_MAINTENANCE_RUN_TYPE,
          run_id: runId,
          trigger_type: "production_smoke",
          smoke: true,
          inventory_changed: false
        })
      });
    }

    const summary = result.summary || {};
    const rates = summary.resolution_rates || {};
    const sourceError =
      result.simulation?.fetch_result?.error ||
      result.simulation?.fetch_result?.session?.error ||
      null;
    const sourceErrorStage =
      result.simulation?.fetch_result?.session && result.simulation?.fetch_result?.session?.ok === false
        ? "bootstrap"
        : result.simulation?.fetch_result?.fetch_failed
          ? "catalogue"
          : null;
    const payload = {
      ok: result.ok === true && !result.blocked,
      mode: "production_read_only",
      dry_run: true,
      blocked: result.blocked === true,
      reason: result.reason || null,
      sourceError,
      sourceErrorStage,
      deployedCommitRef: process.env.COMMIT_REF || process.env.DEPLOY_ID || null,
      runRecordId: dbRun?.id || null,
      officialSourceTotal: summary.official_source_total ?? null,
      eligibleTotal: summary.eligible_total ?? null,
      activeProductionTotal: summary.active_production_total ?? null,
      proposedInserts: summary.proposed_inserts ?? null,
      proposedUpdates: summary.proposed_updates ?? null,
      unchanged: summary.unchanged ?? null,
      shipResolutionPct: rates.ship_resolution_pct ?? null,
      departurePortResolutionPct: rates.departure_port_resolution_pct ?? null,
      destinationResolutionPct: rates.destination_resolution_pct ?? null,
      identityCoveragePct: rates.identity_coverage_pct ?? null,
      qualityGatePassed: summary.quality_gate?.passed === true,
      snapshotId: summary.snapshot_id || null,
      rollbackManifestId: summary.rollback_manifest_id || null,
      writesPerformed: false,
      lockKey,
      lockHeldBefore: lockBefore.held === true,
      lockHeldAfter: lockAfter.held === true,
      durationMs: Date.now() - started
    };

    return {
      statusCode: payload.ok ? 200 : result.blocked ? 409 : 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(payload)
    };
  } catch (error) {
    console.error("princess-discovery-smoke", error.message || error);
    return {
      statusCode: error.statusCode || 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        ok: false,
        error: "smoke_failed",
        writesPerformed: false,
        durationMs: Date.now() - started
      })
    };
  }
};
