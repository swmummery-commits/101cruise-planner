/**
 * Auth helpers for Seabourn weekly maintenance HTTP / scheduled invocations.
 *
 * Manual HTTP callers must present DISCOVERY_CRON_SECRET.
 * Platform scheduled invocations include Netlify's `next_run` body contract —
 * header-only schedule indicators are NOT sufficient (forgeable on public URLs).
 */

function cronSecret(env = process.env) {
  return String(env.DISCOVERY_CRON_SECRET || "").trim();
}

function parseJsonBody(event) {
  try {
    return JSON.parse(event?.body || "{}");
  } catch {
    return {};
  }
}

function isScheduledInvocation(event) {
  const headers = event?.headers || {};
  return (
    String(headers["x-netlify-event"] || headers["X-Netlify-Event"] || "").toLowerCase() === "schedule" ||
    String(headers["x-nf-event"] || headers["X-NF-Event"] || "").toLowerCase() === "schedule" ||
    String(headers["netlify-scheduled"] || headers["Netlify-Scheduled"] || "").toLowerCase() === "true"
  );
}

/** Netlify scheduled functions include ISO next_run in the POST body. */
function isNetlifyPlatformScheduledInvocation(event) {
  if (!isScheduledInvocation(event)) return false;
  const body = parseJsonBody(event);
  return typeof body.next_run === "string" && /^\d{4}-\d{2}-\d{2}T/.test(body.next_run);
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
 * Launcher auth: secret OR genuine platform scheduled payload (next_run + schedule header).
 * Header-only schedule bypass is rejected.
 */
function assertSeabournWeeklyAuth(event, env = process.env) {
  const expected = cronSecret(env);
  if (!expected) {
    const err = new Error("DISCOVERY_CRON_SECRET is not configured");
    err.statusCode = 503;
    err.code = "discovery_cron_secret_missing";
    throw err;
  }
  if (headerValue(event, "x-discovery-cron-secret") === expected) return;
  if (isNetlifyPlatformScheduledInvocation(event)) return;
  const err = new Error("Unauthorized");
  err.statusCode = 401;
  err.code = "unauthorized";
  throw err;
}

function redactSecrets(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const clone = { ...payload };
  if (clone.secret) clone.secret = "[REDACTED]";
  if (clone.DISCOVERY_CRON_SECRET) clone.DISCOVERY_CRON_SECRET = "[REDACTED]";
  return clone;
}

module.exports = {
  cronSecret,
  parseJsonBody,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  assertCronAuth,
  assertSeabournWeeklyAuth,
  redactSecrets
};
