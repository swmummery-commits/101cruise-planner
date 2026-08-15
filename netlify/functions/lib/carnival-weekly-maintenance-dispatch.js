/**
 * Carnival weekly maintenance — launcher ↔ background dispatch.
 */

const {
  assertCclWeeklyMaintenanceEnabled,
  CARNIVAL_WEEKLY_MAINTENANCE_RUN_TYPE,
  isCarnivalWeeklyReconciliationEnabled
} = require("./cruise-discovery-maintenance");
const { runCclWeeklyMaintenance, CCL_MAX_WEEKLY_WRITES } = require("./carnival-weekly-maintenance");
const { executeWeeklyMaintenance, supabase } = require("./cruise-discovery-maintenance-cron");
const {
  assertCclWeeklyAuth,
  assertCronAuth,
  cronSecret,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  parseJsonBody,
  redactSecrets
} = require("./carnival-weekly-auth");

const CCL_LINE_SLUG = "carnival-cruise-line";
const BACKGROUND_FUNCTION_NAME = "carnival-weekly-maintenance-background";
const LAUNCHER_FUNCTION_NAME = "carnival-weekly-maintenance-cron";

function siteBaseUrl(env = process.env) {
  return String(env.URL || env.DEPLOY_PRIME_URL || env.NETLIFY_SITE_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function resolveDryRun(body = {}, env = process.env) {
  if (body.dry_run === true || body.dryRun === true) return true;
  if (!isCarnivalWeeklyReconciliationEnabled()) return true;
  return false;
}

function resolveMaxWrites(body = {}) {
  const n = Number(body.max_writes ?? body.maxWrites ?? CCL_MAX_WEEKLY_WRITES);
  if (!Number.isFinite(n) || n < 1) return CCL_MAX_WEEKLY_WRITES;
  return Math.min(Math.floor(n), CCL_MAX_WEEKLY_WRITES);
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

async function dispatchCclWeeklyBackground({
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

async function runCclWeeklyBackgroundMaintenance({
  dryRun,
  maxWrites,
  triggerType,
  dispatchId = null,
  supabaseClient = null
}) {
  const sb = supabaseClient || supabase;
  const lines = await sb(`ci_cruise_lines?slug=eq.carnival-cruise-line&select=id,name,slug&limit=1`);
  const line = lines?.[0];
  if (!line) {
    const err = new Error("Carnival line not found");
    err.statusCode = 404;
    err.code = "ccl_line_not_found";
    throw err;
  }

  const result = await executeWeeklyMaintenance({
    lineSlug: CCL_LINE_SLUG,
    cruiseLineId: line.id,
    runType: CARNIVAL_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: assertCclWeeklyMaintenanceEnabled,
    runMaintenance: (ctx) =>
      runCclWeeklyMaintenance({
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
  CCL_LINE_SLUG,
  BACKGROUND_FUNCTION_NAME,
  LAUNCHER_FUNCTION_NAME,
  CCL_MAX_WEEKLY_WRITES,
  siteBaseUrl,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  buildBackgroundPayload,
  assertCclWeeklyAuth,
  assertCronAuth,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  parseJsonBody,
  redactSecrets,
  dispatchCclWeeklyBackground,
  runCclWeeklyBackgroundMaintenance
};
