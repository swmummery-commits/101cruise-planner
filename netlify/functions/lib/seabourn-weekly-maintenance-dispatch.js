/**
 * Seabourn weekly maintenance — launcher ↔ background dispatch.
 *
 * Full Solr enumeration + reconciliation exceeds Netlify synchronous HTTP limits (~30s
 * gateway). The scheduled cron launcher only dispatches to
 * `seabourn-weekly-maintenance-background` (900s background function).
 */

const {
  assertSeabournWeeklyMaintenanceEnabled,
  SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
  isSeabournWeeklyReconciliationEnabled
} = require("./cruise-discovery-maintenance");
const {
  runSeabournWeeklyMaintenance,
  SEABOURN_MAX_WEEKLY_WRITES
} = require("./cruise-discovery-maintenance-runner");
const { executeWeeklyMaintenance, supabase } = require("./cruise-discovery-maintenance-cron");
const { claimOrSkipScheduledBackgroundDispatch, releaseScheduledDispatchLease } = require("./weekly-maintenance-schedule-control");

const {
  assertSeabournWeeklyAuth,
  assertCronAuth,
  cronSecret,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  parseJsonBody,
  redactSecrets
} = require("./seabourn-weekly-auth");

const SEABOURN_LINE_SLUG = "seabourn-cruise-line";
const BACKGROUND_FUNCTION_NAME = "seabourn-weekly-maintenance-background";
const LAUNCHER_FUNCTION_NAME = "seabourn-weekly-maintenance-cron";

function siteBaseUrl(env = process.env) {
  return String(env.URL || env.DEPLOY_PRIME_URL || env.NETLIFY_SITE_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function resolveDryRun(body = {}, env = process.env) {
  if (body.dry_run === true || body.dryRun === true) return true;
  if (!isSeabournWeeklyReconciliationEnabled()) return true;
  return false;
}

function resolveMaxWrites(body = {}) {
  const n = Number(body.max_writes ?? body.maxWrites ?? SEABOURN_MAX_WEEKLY_WRITES);
  if (!Number.isFinite(n) || n < 1) return SEABOURN_MAX_WEEKLY_WRITES;
  return Math.min(Math.floor(n), SEABOURN_MAX_WEEKLY_WRITES);
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

async function dispatchSeabournWeeklyBackground({
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


  const scheduledClaim = await claimOrSkipScheduledBackgroundDispatch({
    supabase,
    lineSlug: "seabourn-cruise-line",
    triggerType,
    dispatchId,
    dryRun
  });
  if (scheduledClaim.already_dispatched) return scheduledClaim.response;

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

async function runSeabournWeeklyBackgroundMaintenance({
  dryRun,
  maxWrites,
  triggerType,
  dispatchId = null,
  supabaseClient = null
}) {
  const sb = supabaseClient || supabase;
  const lines = await sb("ci_cruise_lines?slug=eq.seabourn-cruise-line&select=id,name,slug&limit=1");
  const line = lines?.[0];
  if (!line) {
    const err = new Error("Seabourn line not found");
    err.statusCode = 404;
    err.code = "seabourn_line_not_found";
    throw err;
  }

  const result = await executeWeeklyMaintenance({
    lineSlug: SEABOURN_LINE_SLUG,
    cruiseLineId: line.id,
    runType: SEABOURN_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: assertSeabournWeeklyMaintenanceEnabled,
    runMaintenance: (ctx) =>
      runSeabournWeeklyMaintenance({
        ...ctx,
        writeMode: dryRun ? "production_read_only" : "weekly_maintenance"
      }),
    dryRun,
    maxWrites,
    triggerType,
    supabaseClient: sb
  });

  const summary = result.summary || {};
  const writesPerformed = dryRun
    ? 0
    : (summary.writes_performed ?? (summary.inserts || 0) + (summary.updates || 0));

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
  SEABOURN_LINE_SLUG,
  BACKGROUND_FUNCTION_NAME,
  LAUNCHER_FUNCTION_NAME,
  SEABOURN_MAX_WEEKLY_WRITES,
  siteBaseUrl,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  buildBackgroundPayload,
  assertSeabournWeeklyAuth,
  assertCronAuth,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  parseJsonBody,
  redactSecrets,
  dispatchSeabournWeeklyBackground,
  runSeabournWeeklyBackgroundMaintenance
};
