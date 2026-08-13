/**
 * Auth helpers for Royal Caribbean weekly maintenance HTTP / scheduled invocations.
 */

function discoveryCronSecretPresent(env = process.env) {
  return Boolean(String(env.DISCOVERY_CRON_SECRET || "").trim());
}

function headerValue(event, name) {
  const headers = event?.headers || {};
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return String(value || "").trim();
  }
  return "";
}

function parseJsonBody(event) {
  try {
    return JSON.parse(event?.body || "{}");
  } catch {
    return {};
  }
}

function assertCronAuth(event, env = process.env) {
  const expected = String(env.DISCOVERY_CRON_SECRET || "").trim();
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

function assertSmokeAuth(event, env = process.env) {
  assertCronAuth(event, env);
  return { auth: "discovery_cron_secret" };
}

function redactSecrets(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value
      .replace(/x-discovery-cron-secret["']?\s*[:=]\s*["']?[^"'\\s]+/gi, "x-discovery-cron-secret=[REDACTED]")
      .replace(/DISCOVERY_CRON_SECRET["']?\s*[:=]\s*["']?[^"'\\s]+/gi, "DISCOVERY_CRON_SECRET=[REDACTED]")
      .replace(/service_role["']?\s*[:=]\s*["']?[^"'\\s]+/gi, "service_role=[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/secret|token|authorization|service_role/i.test(k)) out[k] = "[REDACTED]";
      else out[k] = redactSecrets(v);
    }
    return out;
  }
  return value;
}

module.exports = {
  discoveryCronSecretPresent,
  parseJsonBody,
  assertCronAuth,
  assertSmokeAuth,
  redactSecrets
};
