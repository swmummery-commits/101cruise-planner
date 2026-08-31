/**
 * Explora weekly maintenance — Scheduled launcher ↔ Background worker dispatch.
 *
 * Netlify Scheduled Functions are hard-capped at ~30s. Explora catalogue maintenance
 * routinely exceeds that (sitemap + hundreds of detail pages), so the scheduled cron
 * only dispatches work to `explora-weekly-maintenance-background`.
 */

const {
  assertExploraWeeklyMaintenanceEnabled,
  EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE,
  isExploraWeeklyReconciliationEnabled
} = require("./cruise-discovery-maintenance");
const { runExploraWeeklyMaintenance, EXPLORA_MAX_WEEKLY_WRITES } = require("./cruise-discovery-maintenance-runner");
const { executeWeeklyMaintenance, supabase } = require("./cruise-discovery-maintenance-cron");
const {
  claimScheduledDispatchLease,
  releaseScheduledDispatchLease,
  scheduledWeeklyDispatchKey
} = require("./weekly-maintenance-schedule-control");

const EXPLORA_LINE_SLUG = "explora-journeys";
const BACKGROUND_FUNCTION_NAME = "explora-weekly-maintenance-background";
const LAUNCHER_FUNCTION_NAME = "explora-weekly-maintenance-cron";

function cronSecret(env = process.env) {
  return String(env.DISCOVERY_CRON_SECRET || "").trim();
}

function siteBaseUrl(env = process.env) {
  return String(env.URL || env.DEPLOY_PRIME_URL || env.NETLIFY_SITE_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function isScheduledInvocation(event) {
  const headers = event?.headers || {};
  return (
    String(headers["x-netlify-event"] || headers["X-Netlify-Event"] || "").toLowerCase() ===
      "schedule" ||
    String(headers["x-nf-event"] || headers["X-NF-Event"] || "").toLowerCase() === "schedule" ||
    String(headers["netlify-scheduled"] || headers["Netlify-Scheduled"] || "").toLowerCase() ===
      "true"
  );
}

function headerValue(event, name) {
  const headers = event?.headers || {};
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return String(value || "").trim();
  }
  return "";
}

function assertCronAuth(event, env = process.env) {
  const expected = cronSecret(env);
  if (!expected) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.statusCode = 503;
    err.code = "discovery_cron_secret_missing";
    throw err;
  }
  const provided = headerValue(event, "x-discovery-cron-secret");
  if (provided !== expected) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    err.code = "unauthorized";
    throw err;
  }
}

/**
 * Scheduled Netlify invocations are platform-authenticated.
 * Manual/HTTP invocations require DISCOVERY_CRON_SECRET.
 */
function assertLauncherAuth(event, env = process.env) {
  if (isScheduledInvocation(event)) return;
  assertCronAuth(event, env);
}

function parseJsonBody(event) {
  try {
    return JSON.parse(event?.body || "{}");
  } catch {
    return {};
  }
}

function resolveDryRun(body = {}, env = process.env) {
  if (body.dry_run === true || body.dryRun === true) return true;
  if (!isExploraWeeklyReconciliationEnabled()) return true;
  return false;
}

function resolveMaxWrites(body = {}) {
  const n = Number(body.max_writes ?? body.maxWrites ?? EXPLORA_MAX_WEEKLY_WRITES);
  if (!Number.isFinite(n) || n < 1) return EXPLORA_MAX_WEEKLY_WRITES;
  return Math.min(Math.floor(n), EXPLORA_MAX_WEEKLY_WRITES);
}

function resolveTriggerType(event, body = {}) {
  if (body.trigger_type || body.triggerType) return String(body.trigger_type || body.triggerType);
  if (isScheduledInvocation(event)) return "scheduled";
  return "manual";
}

function buildBackgroundPayload({
  dryRun,
  maxWrites,
  triggerType,
  dispatchId,
  nextRun = null
}) {
  return {
    dry_run: dryRun === true,
    max_writes: maxWrites,
    trigger_type: triggerType,
    dispatch_id: dispatchId,
    authorised_scheduled_maintenance: true,
    next_run: nextRun
  };
}

function redactSecrets(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value
      .replace(/x-discovery-cron-secret["']?\s*[:=]\s*["']?[^"'\\s]+/gi, "x-discovery-cron-secret=[REDACTED]")
      .replace(/DISCOVERY_CRON_SECRET["']?\s*[:=]\s*["']?[^"'\\s]+/gi, "DISCOVERY_CRON_SECRET=[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/secret|token|authorization/i.test(k)) out[k] = "[REDACTED]";
      else out[k] = redactSecrets(v);
    }
    return out;
  }
  return value;
}

async function dispatchExploraWeeklyBackground({
  dryRun,
  maxWrites,
  triggerType,
  dispatchId,
  nextRun = null,
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

  const periodKey = scheduledWeeklyDispatchKey(EXPLORA_LINE_SLUG);
  const claim = await claimScheduledDispatchLease(supabase, {
    periodKey,
    ownerId: dispatchId,
    triggerType
  });
  if (claim.already_dispatched) {
    return {
      accepted: true,
      already_dispatched: true,
      status: 200,
      url: null,
      dispatch_id: dispatchId,
      dry_run: dryRun === true,
      max_writes: maxWrites,
      trigger_type: triggerType,
      period_key: periodKey,
      body: { status: "already_dispatched" }
    };
  }

  const url = `${base}/.netlify/functions/${BACKGROUND_FUNCTION_NAME}`;
  const payload = buildBackgroundPayload({
    dryRun,
    maxWrites,
    triggerType,
    dispatchId,
    nextRun
  });

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

  // Background functions acknowledge with 202; tolerate 200 for local/dev.
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

async function runExploraWeeklyBackgroundMaintenance({
  dryRun,
  maxWrites,
  triggerType,
  dispatchId = null,
  supabaseClient = null
}) {
  const sb = supabaseClient || supabase;
  const lines = await sb("ci_cruise_lines?slug=eq.explora-journeys&select=id,name,slug&limit=1");
  const line = lines?.[0];
  if (!line) {
    const err = new Error("Explora line not found");
    err.statusCode = 404;
    err.code = "explora_line_not_found";
    throw err;
  }

  // Maintenance run starts as `running` only here — never at dispatch time.
  const result = await executeWeeklyMaintenance({
    lineSlug: EXPLORA_LINE_SLUG,
    cruiseLineId: line.id,
    runType: EXPLORA_WEEKLY_MAINTENANCE_RUN_TYPE,
    assertEnabled: assertExploraWeeklyMaintenanceEnabled,
    runMaintenance: runExploraWeeklyMaintenance,
    dryRun,
    maxWrites,
    triggerType,
    supabaseClient: sb
  });

  return {
    ...result,
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
  EXPLORA_LINE_SLUG,
  BACKGROUND_FUNCTION_NAME,
  LAUNCHER_FUNCTION_NAME,
  EXPLORA_MAX_WEEKLY_WRITES,
  cronSecret,
  siteBaseUrl,
  isScheduledInvocation,
  assertCronAuth,
  assertLauncherAuth,
  parseJsonBody,
  resolveDryRun,
  resolveMaxWrites,
  resolveTriggerType,
  buildBackgroundPayload,
  redactSecrets,
  dispatchExploraWeeklyBackground,
  runExploraWeeklyBackgroundMaintenance
};
