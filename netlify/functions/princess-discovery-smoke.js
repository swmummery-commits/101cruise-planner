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
    const result = await runPrincessWeeklyMaintenance({
      dryRun: true,
      performWrites: false,
      maxWrites: 0,
      runId,
      triggerType: "production_smoke",
      supabase
    });
    const lockAfter = await loadMaintenanceLockStatus(supabase, lockKey);

    const summary = result.summary || {};
    const rates = summary.resolution_rates || {};
    const payload = {
      ok: result.ok === true && !result.blocked,
      mode: "production_read_only",
      dry_run: true,
      blocked: result.blocked === true,
      reason: result.reason || null,
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
