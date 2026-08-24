/**
 * Silversea weekly maintenance — launcher ↔ background dispatch.
 */

const {
  runSilverseaWeeklyMaintenance,
  LINE_SLUG,
  RUN_TYPE
} = require("./silversea-weekly-maintenance");
const { supabase } = require("./cruise-discovery-ops");
const { RUN_STATUS } = require("./cruise-discovery-controlled-production-run");
const {
  assertSilverseaWeeklyAuth,
  assertCronAuth,
  cronSecret,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  parseJsonBody,
  redactSecrets
} = require("./silversea-weekly-auth");

const BACKGROUND_FUNCTION_NAME = "silversea-weekly-maintenance-background";
const LAUNCHER_FUNCTION_NAME = "silversea-weekly-maintenance-cron";

function siteBaseUrl(env = process.env) {
  return String(env.URL || env.DEPLOY_PRIME_URL || env.NETLIFY_SITE_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function resolveDryRun(body = {}, env = process.env) {
  if (body.dry_run === true || body.dryRun === true) return true;
  if (body.dry_run === false || body.dryRun === false) return false;
  return !isNetlifyPlatformScheduledInvocation({ body, headers: { "x-netlify-event": "schedule" } });
}

function resolveTriggerType(event, body = {}) {
  if (body.trigger_type || body.triggerType) return String(body.trigger_type || body.triggerType);
  if (isNetlifyPlatformScheduledInvocation(event)) return "scheduled";
  return "manual";
}

async function dispatchSilverseaWeeklyBackground({
  dryRun,
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
    err.statusCode = 503;
    throw err;
  }
  if (!secret) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.statusCode = 503;
    throw err;
  }

  const url = `${base}/.netlify/functions/${BACKGROUND_FUNCTION_NAME}`;
  const payload = {
    dry_run: dryRun === true,
    trigger_type: triggerType,
    dispatch_id: dispatchId,
    authorised_scheduled_maintenance: platformScheduled === true,
    next_run: nextRun
  };

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
    body
  };
}

async function runSilverseaWeeklyBackgroundMaintenance({
  dryRun = true,
  triggerType = "background",
  dispatchId = null,
  supabaseClient = supabase
} = {}) {
  const runId =
    dispatchId || `silversea-weekly-maintenance-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const report = await runSilverseaWeeklyMaintenance({
    supabase: supabaseClient,
    dryRun: dryRun !== false,
    performWrites: dryRun === false,
    runId
  });
  return {
    success:
      report.status === "DRY_RUN_COMPLETE" ||
      report.status === RUN_STATUS.COMPLETE ||
      report.status === "COMPLETE",
    line_slug: LINE_SLUG,
    run_type: RUN_TYPE,
    trigger_type: triggerType,
    dispatch_id: runId,
    dry_run: dryRun !== false,
    report
  };
}

module.exports = {
  BACKGROUND_FUNCTION_NAME,
  LAUNCHER_FUNCTION_NAME,
  resolveDryRun,
  resolveTriggerType,
  dispatchSilverseaWeeklyBackground,
  runSilverseaWeeklyBackgroundMaintenance,
  assertSilverseaWeeklyAuth,
  assertCronAuth,
  parseJsonBody,
  redactSecrets,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation
};
