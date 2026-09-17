/**
 * Disney weekly maintenance — launcher ↔ background dispatch.
 */

const {
  assertDisneyWeeklyMaintenanceEnabled,
  assertDisneyWeeklyMaintenanceScheduled,
  DISNEY_WEEKLY_MAINTENANCE_RUN_TYPE,
  isDisneyMaintenanceScheduledEnabled,
  isDisneyProductionWritesEnabled
} = require("./cruise-discovery-maintenance");
const {
  runDisneyWeeklyMaintenance,
  DISNEY_MAX_WEEKLY_WRITES,
  DISNEY_LINE_SLUG
} = require("./disney-weekly-maintenance");
const { executeWeeklyMaintenance, supabase } = require("./cruise-discovery-maintenance-cron");
const { weeklyDispatchStatus } = require("./weekly-maintenance-write-accounting");

const {
  assertDisneyWeeklyAuth,
  assertCronAuth,
  cronSecret,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  parseJsonBody,
  redactSecrets
} = require("./disney-weekly-auth");

const BACKGROUND_FUNCTION_NAME = "disney-weekly-maintenance-background";
const LAUNCHER_FUNCTION_NAME = "disney-weekly-maintenance-cron";

function siteBaseUrl(env = process.env) {
  return String(env.URL || env.DEPLOY_PRIME_URL || env.NETLIFY_SITE_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function resolveDryRun(body = {}, env = process.env) {
  if (body.dry_run === true || body.dryRun === true) return true;
  if (!isDisneyProductionWritesEnabled()) return true;
  return false;
}

function resolveMaxWrites(body = {}) {
  const n = Number(body.max_writes ?? body.maxWrites ?? DISNEY_MAX_WEEKLY_WRITES);
  if (!Number.isFinite(n) || n < 1) return DISNEY_MAX_WEEKLY_WRITES;
  return Math.min(Math.floor(n), DISNEY_MAX_WEEKLY_WRITES);
}

function resolveTriggerType(event, body = {}) {
  if (body.trigger_type || body.triggerType) return String(body.trigger_type || body.triggerType);
  if (isNetlifyPlatformScheduledInvocation(event)) return "scheduled";
  return "manual";
}

function buildBackgroundPayload({ dryRun, maxWrites, triggerType, dispatchId, nextRun = null, platformScheduled = false, phase = null, freezeManifestId = null }) {
  return {
    dry_run: dryRun === true,
    max_writes: maxWrites,
    trigger_type: triggerType,
    dispatch_id: dispatchId,
    authorised_scheduled_maintenance: platformScheduled === true,
    next_run: nextRun,
    phase: phase || null,
    freeze_manifest_id: freezeManifestId || null
  };
}

function resolveScheduledLauncherState(event, env = process.env) {
  if (!isNetlifyPlatformScheduledInvocation(event)) {
    return { disabled: false, reason: null };
  }
  if (!isDisneyMaintenanceScheduledEnabled()) {
    return {
      disabled: true,
      reason: "DISNEY_DISCOVERY_MAINTENANCE_SCHEDULED_ENABLED=false"
    };
  }
  return { disabled: false, reason: null };
}

async function dispatchDisneyWeeklyBackground({
  dryRun,
  maxWrites,
  triggerType,
  dispatchId,
  nextRun = null,
  platformScheduled = false,
  env = process.env,
  fetchImpl = fetch,
  phase = null,
  freezeManifestId = null
}) {
  const base = siteBaseUrl(env);
  const secret = cronSecret(env);
  if (!base) {
    const err = new Error("missing_site_url");
    err.code = "missing_site_url";
    err.statusCode = 503;
    throw err;
  }
  if (!secret) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.code = "discovery_cron_secret_missing";
    err.statusCode = 503;
    throw err;
  }


  const url = `${base}/.netlify/functions/${BACKGROUND_FUNCTION_NAME}`;
  const payload = buildBackgroundPayload({ dryRun, maxWrites, triggerType, dispatchId, nextRun, platformScheduled, phase, freezeManifestId });

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discovery-cron-secret": secret
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text().catch(() => "");
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: String(text).slice(0, 300) };
  }

  const accepted = response.status === 202 || response.ok;
  return {
    accepted,
    status: response.status,
    url,
    dispatch_id: dispatchId,
    dry_run: dryRun === true,
    max_writes: maxWrites,
    trigger_type: triggerType,
    body: redactSecrets(body)
  };
}

async function runDisneyWeeklyBackgroundMaintenance({
  dryRun,
  maxWrites,
  triggerType,
  dispatchId = null,
  supabaseClient = null,
  phase = null,
  freezeManifestId = null
}) {
  const sb = supabaseClient || supabase;
  const lines = await sb(`ci_cruise_lines?slug=eq.${DISNEY_LINE_SLUG}&select=id,name,slug&limit=1`);
  const line = lines?.[0];
  if (!line) {
    const err = new Error("Disney line not found");
    err.statusCode = 404;
    err.code = "disney_line_not_found";
    throw err;
  }

  if (String(phase || "").toLowerCase() === "apply" && freezeManifestId) {
    const { applyDisneyPhaseBBatch } = require("./disney-weekly-phases");
    const freezeRows = await sb(
      `cruise_discovery_maintenance_manifests?id=eq.${encodeURIComponent(freezeManifestId)}&select=id,manifest`
    );
    const freeze = freezeRows?.[0]?.manifest;
    if (!freeze?.plan_hash || !Array.isArray(freeze.inserts)) {
      return { ok: false, phase: "B", reason: "missing_phase_a_freeze", writes_performed: 0 };
    }
    const batch = (freeze.batches && freeze.batches[0]) || {
      batch_number: 1,
      official_sailing_ids: (freeze.insert_official_sailing_ids || []).slice(0, DISNEY_MAX_WEEKLY_WRITES)
    };
    const applied = await applyDisneyPhaseBBatch({
      supabase: sb,
      cruiseLine: line,
      plan: { plan_hash: freeze.plan_hash, inserts: freeze.inserts },
      batch,
      runId: `disney-phase-b-${Date.now()}`,
      triggerType: triggerType || "incident_recovery"
    });
    return {
      ok: applied.ok,
      phase: "B",
      writes_performed: applied.writes || 0,
      summary: {
        inserts: applied.writes || 0,
        inventory_changed: (applied.writes || 0) > 0,
        precommit_manifest_id: applied.precommit_manifest_id,
        terminal_status: applied.ok ? "completed" : "failed"
      }
    };
  }

  if (!dryRun) {
    assertDisneyWeeklyMaintenanceEnabled();
  }

  const result = await executeWeeklyMaintenance({
    lineSlug: DISNEY_LINE_SLUG,
    cruiseLineId: line.id,
    runType: DISNEY_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: dryRun ? () => {} : assertDisneyWeeklyMaintenanceEnabled,
    runMaintenance: (ctx) =>
      runDisneyWeeklyMaintenance({
        ...ctx,
        writeMode: dryRun ? "production_read_only" : "weekly_maintenance"
      }),
    dryRun,
    maxWrites,
    triggerType,
    dispatchId,
    supabaseClient: sb
  });

  const summary = result.summary || {};
  const writesPerformed = dryRun
    ? 0
    : (summary.writes_performed ??
      (summary.inserts || 0) +
        (summary.updates || 0) +
        (summary.source_absence_actions || 0) +
        (summary.reactivations || 0));

  if (!dryRun && result.needs_phase_b && result.summary?.source_freeze_manifest_id) {
    await dispatchDisneyWeeklyBackground({
      dryRun: false,
      maxWrites,
      triggerType: "incident_recovery",
      dispatchId: `${dispatchId || result.summary?.run_id || "disney"}:phase-b`,
      phase: "apply",
      freezeManifestId: result.summary.source_freeze_manifest_id
    }).catch(() => null);
  }

  return {
    ...result,
    summary: { ...(result.summary || {}), dispatch_id: dispatchId },
    writes_performed: writesPerformed,
    dry_run: dryRun === true,
    dispatch_id: dispatchId,
    phase: result.phase || "A",
    status: weeklyDispatchStatus(result)
  };
}

module.exports = {
  DISNEY_LINE_SLUG,
  BACKGROUND_FUNCTION_NAME,
  LAUNCHER_FUNCTION_NAME,
  DISNEY_MAX_WEEKLY_WRITES,
  siteBaseUrl,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  resolveScheduledLauncherState,
  buildBackgroundPayload,
  assertDisneyWeeklyAuth,
  assertCronAuth,
  assertDisneyWeeklyMaintenanceScheduled,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  parseJsonBody,
  redactSecrets,
  dispatchDisneyWeeklyBackground,
  runDisneyWeeklyBackgroundMaintenance
};
