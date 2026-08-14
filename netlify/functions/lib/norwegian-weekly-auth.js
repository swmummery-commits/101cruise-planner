/**
 * Auth helpers for Norwegian weekly maintenance HTTP / scheduled invocations.
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

function assertNorwegianWeeklyAuth(event, env = process.env) {
  if (isNetlifyPlatformScheduledInvocation(event)) return;
  assertCronAuth(event, env);
}

function redactSecrets(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const copy = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(copy)) {
    if (/secret|token|password|authorization/i.test(key)) copy[key] = "[REDACTED]";
    else if (typeof copy[key] === "object") copy[key] = redactSecrets(copy[key]);
  }
  return copy;
}

module.exports = {
  cronSecret,
  parseJsonBody,
  isScheduledInvocation,
  isNetlifyPlatformScheduledInvocation,
  headerValue,
  assertCronAuth,
  assertNorwegianWeeklyAuth,
  redactSecrets
};
