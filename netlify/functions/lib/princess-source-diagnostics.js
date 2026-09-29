/**
 * Sanitized Princess official-source transport diagnostics.
 * Never persist raw client IDs, cookies, tokens, or secrets.
 */

const crypto = require("crypto");
const dns = require("dns").promises;

const PRINCESS_SOURCE_FAILURE_CLASSES = Object.freeze([
  "DNS_FAILURE",
  "TLS_FAILURE",
  "UBE_BOOTSTRAP_4XX",
  "UBE_BOOTSTRAP_5XX",
  "CATALOGUE_400",
  "CATALOGUE_401",
  "CATALOGUE_403",
  "CATALOGUE_429",
  "CATALOGUE_5XX",
  "AKAMAI_WAF_REJECTION",
  "CLIENT_ID_MISMATCH",
  "BOOKING_COMPANY_MISMATCH",
  "COOKIE_SESSION_DIFFERENCE",
  "REQUEST_HEADER_DIFFERENCE",
  "SOURCE_TIMEOUT",
  "OTHER"
]);

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function fingerprintClientId(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return { present: false, sha256: null, length: 0 };
  }
  return {
    present: true,
    sha256: sha256Hex(trimmed),
    length: trimmed.length
  };
}

function classifyClientIdSource(env = process.env, refreshed = false) {
  if (String(env.PRINCESS_PCL_CLIENT_ID || "").trim()) return "ENV";
  if (refreshed) return "REFRESHED";
  return "DEFAULT";
}

function requestConstructionFingerprint({
  userAgent,
  origin,
  referer,
  clientIdPresent,
  cookiePresent,
  productcompany,
  bookingcompany
} = {}) {
  return {
    user_agent: userAgent || null,
    origin: origin || null,
    referer: referer || null,
    pcl_client_id_present: clientIdPresent === true,
    cookie_present: cookiePresent === true,
    productcompany: productcompany || null,
    bookingcompany: bookingcompany || null
  };
}

function looksLikeAkamaiWaf(diagnostics = {}) {
  const headers = diagnostics.response_headers || {};
  const server = String(headers.server || "").toLowerCase();
  const excerpt = String(diagnostics.body_excerpt || diagnostics.body || "");
  return (
    server.includes("akamai") ||
    /access denied|reference #|errors.edgesuite.net|you don't have permission to access/i.test(
      excerpt
    )
  );
}

function lastAttempt(diagnostics) {
  const attempts = diagnostics?.attempts || [];
  return attempts[attempts.length - 1] || diagnostics || null;
}

function firstTransport(bootstrap, catalogue, transport) {
  return (
    transport ||
    lastAttempt(bootstrap)?.transport ||
    lastAttempt(catalogue)?.transport ||
    null
  );
}

function classifyPrincessSourceFailure({
  bootstrap = null,
  catalogue = null,
  transport = null
} = {}) {
  const probe = firstTransport(bootstrap, catalogue, transport);
  if (
    probe?.dns?.ok === false ||
    probe?.dns_ok === false ||
    probe?.error_code === "ENOTFOUND" ||
    probe?.error_code === "EAI_AGAIN"
  ) {
    return "DNS_FAILURE";
  }
  if (
    probe?.tls_ok === false ||
    /CERT|UNABLE_TO_VERIFY|SSL|TLS/i.test(String(probe?.error_code || probe?.error || ""))
  ) {
    return "TLS_FAILURE";
  }
  if (probe?.timeout === true || /timeout/i.test(String(probe?.error_code || probe?.error || ""))) {
    return "SOURCE_TIMEOUT";
  }

  const boot = lastAttempt(bootstrap);
  const bootStatus = Number(boot?.http_status || boot?.status || 0);
  if (boot && looksLikeAkamaiWaf(boot)) return "AKAMAI_WAF_REJECTION";
  if (bootStatus >= 500) return "UBE_BOOTSTRAP_5XX";
  if (bootStatus >= 400) return "UBE_BOOTSTRAP_4XX";

  const cat = lastAttempt(catalogue);
  const catStatus = Number(cat?.http_status || cat?.status || 0);
  if (cat && looksLikeAkamaiWaf(cat)) return "AKAMAI_WAF_REJECTION";
  if (catStatus === 401) return "CATALOGUE_401";
  if (catStatus === 403) return "CATALOGUE_403";
  if (catStatus === 429) return "CATALOGUE_429";
  if (catStatus >= 500) return "CATALOGUE_5XX";
  if (catStatus === 400) {
    const excerpt = String(cat?.body_excerpt || cat?.more_information || cat?.http_message || "");
    if (/client.?id|pcl-client-id/i.test(excerpt)) return "CLIENT_ID_MISMATCH";
    if (/bookingcompany|productcompany/i.test(excerpt)) return "BOOKING_COMPANY_MISMATCH";
    return "CATALOGUE_400";
  }

  if (catalogue?.attempts?.length > 1) {
    const cookieUsed = catalogue.attempts.some((row) => row.bootstrap_cookies_used || row.cookie_present);
    const cookieless = catalogue.attempts.some((row) => !row.bootstrap_cookies_used && !row.cookie_present);
    if (cookieUsed && cookieless) return "COOKIE_SESSION_DIFFERENCE";
  }

  return "OTHER";
}

function dnsFamilyClass(family) {
  if (family === 6 || family === "IPv6") return "IPv6";
  if (family === 4 || family === "IPv4") return "IPv4";
  return "UNKNOWN";
}

async function lookupDnsClass(hostname) {
  try {
    const all = await dns.lookup(hostname, { all: true });
    const families = [...new Set((all || []).map((row) => dnsFamilyClass(row.family)))].sort();
    return {
      ok: true,
      hostname,
      address_count: all.length,
      family_classes: families
    };
  } catch (error) {
    return {
      ok: false,
      hostname,
      address_count: 0,
      family_classes: [],
      error_code: error.code || "DNS_ERROR"
    };
  }
}

function redactSecretsFromDiagnostics(value, depth = 0) {
  if (value == null || depth > 8) return value;
  if (typeof value === "string") {
    return value
      .replace(/pcl-client-id["']?\s*[:=]\s*["']?[a-f0-9]{16,}/gi, "pcl-client-id=[REDACTED]")
      .replace(/cookie["']?\s*[:=]\s*["'][^"']+/gi, "cookie=[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactSecretsFromDiagnostics(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === "object" && !Array.isArray(item) && ("sha256" in item || "present" in item)) {
        out[key] = redactSecretsFromDiagnostics(item, depth + 1);
        continue;
      }
      if (
        /^(secret|token|authorization|cookie|set-cookie|client_id|clientid|pcl_client_id)$/i.test(key) &&
        !/sha256|present|source|hash|fingerprint/i.test(key)
      ) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactSecretsFromDiagnostics(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function compareEffectiveClientConfig(mac = {}, netlify = {}) {
  const macSha = mac.sha256 || mac.effective_client_id?.sha256 || null;
  const netlifySha = netlify.sha256 || netlify.effective_client_id?.sha256 || null;
  const macSource = mac.source || mac.client_id_source || null;
  const netlifySource = netlify.source || netlify.client_id_source || null;
  return {
    hash_match: Boolean(macSha) && macSha === netlifySha,
    source_match: macSource === netlifySource,
    mac_source: macSource,
    netlify_source: netlifySource,
    mac_sha256: macSha,
    netlify_sha256: netlifySha
  };
}

function compareRequestConstruction(mac = {}, netlify = {}) {
  const keys = [
    "user_agent",
    "origin",
    "referer",
    "pcl_client_id_present",
    "cookie_present",
    "productcompany",
    "bookingcompany"
  ];
  const differences = keys.filter((key) => (mac[key] ?? null) !== (netlify[key] ?? null));
  return {
    match: differences.length === 0,
    differences,
    mac,
    netlify
  };
}

function assertNoSecretLeakage(payload) {
  const text = JSON.stringify(payload || {});
  const leaks = [];
  if (/pcl-client-id["']?\s*[:=]\s*["']?[a-f0-9]{24,}/i.test(text)) leaks.push("raw_pcl_client_id");
  if (/"cookie"\s*:\s*"[^"\[]{8,}/i.test(text)) leaks.push("raw_cookie");
  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(text)) leaks.push("jwt_like");
  if (/service_role|SUPABASE_SERVICE_ROLE/i.test(text)) leaks.push("supabase_secret");
  return { ok: leaks.length === 0, leaks };
}

module.exports = {
  PRINCESS_SOURCE_FAILURE_CLASSES,
  sha256Hex,
  fingerprintClientId,
  classifyClientIdSource,
  requestConstructionFingerprint,
  classifyPrincessSourceFailure,
  lookupDnsClass,
  dnsFamilyClass,
  redactSecretsFromDiagnostics,
  assertNoSecretLeakage,
  compareEffectiveClientConfig,
  compareRequestConstruction
};
