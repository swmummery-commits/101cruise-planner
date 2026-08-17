/**
 * Azamara weekly maintenance — launcher ↔ background dispatch.
 */

const {
  assertAzamaraWeeklyMaintenanceEnabled,
  AZAMARA_WEEKLY_MAINTENANCE_RUN_TYPE,
  isAzamaraWeeklyReconciliationEnabled
} = require("./cruise-discovery-maintenance");
const { runAzamaraWeeklyMaintenance, AZAMARA_MAX_WEEKLY_WRITES } = require("./azamara-weekly-maintenance");
const { executeWeeklyMaintenance, supabase } = require("./cruise-discovery-maintenance-cron");
const {
  assertAzamaraWeeklyAuth,
  assertCronAuth,
  cronSecret,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  parseJsonBody,
  redactSecrets
} = require("./azamara-weekly-auth");

const AZAMARA_LINE_SLUG = "azamara";
const BACKGROUND_FUNCTION_NAME = "azamara-weekly-maintenance-background";
const LAUNCHER_FUNCTION_NAME = "azamara-weekly-maintenance-cron";

function siteBaseUrl(env = process.env) {
  return String(env.URL || env.DEPLOY_PRIME_URL || env.NETLIFY_SITE_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function resolveDryRun(body = {}) {
  if (body.dry_run === true || body.dryRun === true) return true;
  if (!isAzamaraWeeklyReconciliationEnabled()) return true;
  return false;
}

function resolveMaxWrites(body = {}) {
  const n = Number(body.max_writes ?? body.maxWrites ?? AZAMARA_MAX_WEEKLY_WRITES);
  if (!Number.isFinite(n) || n < 1) return AZAMARA_MAX_WEEKLY_WRITES;
  return Math.min(Math.floor(n), AZAMARA_MAX_WEEKLY_WRITES);
}

function resolveTriggerType(event, body = {}) {
  if (body.trigger_type || body.triggerType) return String(body.trigger_type || body.triggerType);
  if (isNetlifyPlatformScheduledInvocation(event)) return "scheduled";
  return "manual";
}

function buildBackgroundPayload({ dryRun, maxWrites, triggerType, dispatchId, nextRun = null, platformScheduled = false }) {
  return {
    dry_run: dryRun === true,
    max_writes: maxWrites,
    trigger_type: triggerType,
    dispatch_id: dispatchId,
    authorised_scheduled_maintenance: platformScheduled === true,
    next_run: nextRun
  };
}

async function dispatchAzamaraWeeklyBackground({
  dryRun,
  maxWrites,
  triggerType,
  dispatchId,
  nextRun = null,
  platformScheduled = false,
  env = process.env,
  fetchImpl = fetch
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
  const payload = buildBackgroundPayload({ dryRun, maxWrites, triggerType, dispatchId, nextRun, platformScheduled });

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

  return {
    accepted: response.status === 202 || response.ok,
    status: response.status,
    url,
    dispatch_id: dispatchId,
    dry_run: dryRun === true,
    max_writes: maxWrites,
    trigger_type: triggerType,
    body: redactSecrets(body)
  };
}

async function runAzamaraWeeklyBackgroundMaintenance({
  dryRun,
  maxWrites,
  triggerType,
  dispatchId = null,
  supabaseClient = null
}) {
  const sb = supabaseClient || supabase;
  const lines = await sb(`ci_cruise_lines?slug=eq.azamara&select=id,name,slug&limit=1`);
  const line = lines?.[0];
  if (!line) {
    const err = new Error("Azamara line not found");
    err.statusCode = 404;
    err.code = "azamara_line_not_found";
    throw err;
  }

  const result = await executeWeeklyMaintenance({
    lineSlug: AZAMARA_LINE_SLUG,
    cruiseLineId: line.id,
    runType: AZAMARA_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: assertAzamaraWeeklyMaintenanceEnabled,
    runMaintenance: (ctx) =>
      runAzamaraWeeklyMaintenance({
        ...ctx,
        performWrites: !dryRun,
        maxWrites
      }),
    dryRun,
    maxWrites,
    triggerType,
    supabaseClient: sb
  });

  const summary = result.summary || {};
  const writesPerformed = dryRun
    ? 0
    : (summary.writes_performed?.inserted || 0) +
      (summary.writes_performed?.updated || 0) +
      (summary.writes_performed?.cutoff_hidden || 0) +
      (summary.writes_performed?.source_absence_hidden || 0);

  return {
    ...result,
    summary: { ...(result.summary || {}), dispatch_id: dispatchId },
    writes_performed: writesPerformed,
    dry_run: dryRun === true,
    dispatch_id: dispatchId,
    phase: "background_maintenance",
    status:
      result.blocked && result.already_running
        ? "already_running"
        : result.success
          ? "completed"
          : "failed"
  };
}

module.exports = {
  AZAMARA_LINE_SLUG,
  BACKGROUND_FUNCTION_NAME,
  LAUNCHER_FUNCTION_NAME,
  AZAMARA_MAX_WEEKLY_WRITES,
  siteBaseUrl,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  buildBackgroundPayload,
  assertAzamaraWeeklyAuth,
  assertCronAuth,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  parseJsonBody,
  redactSecrets,
  dispatchAzamaraWeeklyBackground,
  runAzamaraWeeklyBackgroundMaintenance
};
