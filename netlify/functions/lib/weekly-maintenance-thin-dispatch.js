/**
 * Shared thin launcher → background weekly-maintenance dispatch.
 * Used by HAL and Celebrity (and available to other lines).
 */

const { executeWeeklyMaintenance, supabase } = require("./cruise-discovery-maintenance-cron");
const { collectInvocationProvenance } = require("./weekly-maintenance-schedule-control");

function cronSecret(env = process.env) {
  return String(env.DISCOVERY_CRON_SECRET || "").trim();
}

function siteBaseUrl(env = process.env) {
  return String(env.URL || env.DEPLOY_PRIME_URL || env.NETLIFY_SITE_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function headerValue(event, name) {
  const headers = event?.headers || {};
  const lower = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return String(value || "").trim();
  }
  return "";
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

function parseJsonBody(event) {
  try {
    return JSON.parse(event?.body || "{}");
  } catch {
    return {};
  }
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

function assertLauncherAuth(event, env = process.env) {
  if (isScheduledInvocation(event)) return;
  assertCronAuth(event, env);
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

function createThinWeeklyDispatch({
  lineSlug,
  runType,
  assertEnabled,
  isEnabled,
  runMaintenance,
  maxWrites = 100,
  launcherFunctionName,
  backgroundFunctionName
}) {
  function resolveDryRun(body = {}, env = process.env) {
    if (body.dry_run === true || body.dryRun === true) return true;
    if (!isEnabled()) return true;
    return false;
  }

  function resolveMaxWrites(body = {}) {
    const n = Number(body.max_writes ?? body.maxWrites ?? maxWrites);
    if (!Number.isFinite(n) || n < 1) return maxWrites;
    return Math.min(Math.floor(n), maxWrites);
  }

  function resolveTriggerType(event, body = {}) {
    if (body.trigger_type || body.triggerType) return String(body.trigger_type || body.triggerType);
    if (isScheduledInvocation(event)) return "scheduled";
    return "manual";
  }

  function buildBackgroundPayload({
    dryRun,
    maxWrites: writes,
    triggerType,
    dispatchId,
    nextRun = null,
    provenance = null
  }) {
    return {
      dry_run: dryRun === true,
      max_writes: writes,
      trigger_type: triggerType,
      dispatch_id: dispatchId,
      authorised_scheduled_maintenance: true,
      next_run: nextRun,
      invocation_provenance: provenance
    };
  }

  async function dispatchWeeklyBackground({
    dryRun,
    maxWrites: writes,
    triggerType,
    dispatchId,
    nextRun = null,
    provenance = null,
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

    const url = `${base}/.netlify/functions/${backgroundFunctionName}`;
    const payload = buildBackgroundPayload({
      dryRun,
      maxWrites: writes,
      triggerType,
      dispatchId,
      nextRun,
      provenance
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

    return {
      accepted: response.status === 202 || response.ok,
      status: response.status,
      url,
      dispatch_id: dispatchId,
      dry_run: dryRun === true,
      max_writes: writes,
      trigger_type: triggerType,
      body: redactSecrets(body)
    };
  }

  async function runWeeklyBackgroundMaintenance({
    dryRun,
    maxWrites: writes,
    triggerType,
    dispatchId = null,
    provenance = null,
    supabaseClient = null
  }) {
    const sb = supabaseClient || supabase;
    const lines = await sb(`ci_cruise_lines?slug=eq.${encodeURIComponent(lineSlug)}&select=id,name,slug&limit=1`);
    const line = lines?.[0];
    if (!line) {
      const err = new Error(`${lineSlug} line not found`);
      err.statusCode = 404;
      err.code = "cruise_line_not_found";
      throw err;
    }

    const result = await executeWeeklyMaintenance({
      lineSlug,
      cruiseLineId: line.id,
      runType,
      assertEnabled,
      runMaintenance,
      dryRun,
      maxWrites: writes,
      triggerType,
      supabaseClient: sb,
      statsEnricher: (summary, extra) => ({
        ...extra,
        dispatch_id: dispatchId,
        invocation_provenance: provenance || collectInvocationProvenance({}, process.env, {
          function_name: backgroundFunctionName,
          dispatch_id: dispatchId
        })
      })
    });

    return {
      ...result,
      dispatch_id: dispatchId,
      phase: "background_maintenance",
      status:
        result.blocked && result.already_running
          ? "already_running"
          : result.review_required
            ? "review_required"
            : result.success
              ? "completed"
              : "failed"
    };
  }

  return {
    lineSlug,
    runType,
    BACKGROUND_FUNCTION_NAME: backgroundFunctionName,
    LAUNCHER_FUNCTION_NAME: launcherFunctionName,
    MAX_WEEKLY_WRITES: maxWrites,
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
    dispatchWeeklyBackground,
    runWeeklyBackgroundMaintenance
  };
}

module.exports = {
  createThinWeeklyDispatch,
  cronSecret,
  siteBaseUrl,
  isScheduledInvocation,
  assertCronAuth,
  assertLauncherAuth,
  parseJsonBody,
  redactSecrets
};
