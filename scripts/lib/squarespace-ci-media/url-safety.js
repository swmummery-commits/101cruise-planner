/**
 * SSRF-safe remote URL validation for Squarespace → Media Library migration.
 */

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata"
]);

function ipv4Parts(host) {
  const m = String(host || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "::1" || host === "[::1]" || host.startsWith("fe80:")) return true;

  const parts = ipv4Parts(host);
  if (parts) {
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

/**
 * Validate that a URL is safe to fetch (http/https, public host).
 * Does not resolve DNS — call again on each redirect Location.
 */
export function assertSafeRemoteUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw Object.assign(new Error("Invalid URL"), { code: "invalid_url" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw Object.assign(new Error("Only http/https URLs are allowed"), {
      code: "invalid_protocol"
    });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error("URLs with credentials are not allowed"), {
      code: "credentials_in_url"
    });
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    throw Object.assign(new Error("Private or local network hosts are blocked"), {
      code: "ssrf_blocked"
    });
  }
  return parsed;
}

export function classifyHost(url) {
  if (!url || !String(url).trim()) return "blank";
  let host = "";
  try {
    host = new URL(String(url).trim()).hostname.toLowerCase();
  } catch {
    return "invalid_url";
  }
  if (host.includes("squarespace")) return "squarespace";
  if (host.includes("supabase.co") || host.includes("supabase.in")) return "supabase";
  if (host.endsWith("101cruise.com.au")) return "101cruise";
  return "other";
}

export function isSquarespaceHost(url) {
  return classifyHost(url) === "squarespace";
}

export { isPrivateOrLocalHost };
