/**
 * Auth helpers for Seabourn weekly maintenance HTTP / scheduled invocations.
 */

function cronSecret(env = process.env) {
  return String(env.DISCOVERY_CRON_SECRET || "").trim();
}

function isScheduledInvocation(event) {
  const headers = event?.headers || {};
  return (
    String(headers["x-netlify-event"] || headers["X-Netlify-Event"] || "").toLowerCase() === "schedule" ||
    String(headers["x-nf-event"] || headers["X-NF-Event"] || "").toLowerCase() === "schedule" ||
    String(headers["netlify-scheduled"] || headers["Netlify-Scheduled"] || "").toLowerCase() === "true"
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

/** Scheduled Netlify invocations are platform-authenticated; manual HTTP requires secret. */
function assertSeabournWeeklyAuth(event, env = process.env) {
  if (isScheduledInvocation(event)) return;
  assertCronAuth(event, env);
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
  isScheduledInvocation,
  assertCronAuth,
  assertSeabournWeeklyAuth,
  redactSecrets
};
