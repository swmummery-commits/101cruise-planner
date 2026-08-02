/**
 * Remember permanently rejected non-sailing URLs so weekly Discovery does not re-fetch them.
 * Uses existing discovered_cruises rows (status=hidden, review_reason non_sailing:*) — no migration.
 */

const { parseNonSailingReviewReason, isTransientFetchFailure } = require("./discovery-non-sailing-filter");

function canonicalDiscoveryUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"].forEach(
      (k) => u.searchParams.delete(k)
    );
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}${u.search}`.toLowerCase();
  } catch {
    return String(url || "")
      .trim()
      .toLowerCase()
      .replace(/\/$/, "");
  }
}

/**
 * Load hidden non-sailing URLs for a cruise line (or all lines when lineId omitted).
 * @returns {Promise<Map<string, { reason: string, version: string|null, first_seen: string|null, last_seen: string|null }>>}
 */
async function loadRejectedSourceMemory(supabase, { cruiseLineId = null } = {}) {
  const memory = new Map();
  let path =
    "discovered_cruises?status=eq.hidden&review_reason=like.non_sailing:*&select=id,official_url,source_url,review_reason,discovered_at,last_seen_at,cruise_line_id&limit=5000";
  if (cruiseLineId) {
    path += `&cruise_line_id=eq.${encodeURIComponent(cruiseLineId)}`;
  }

  const rows = await supabase(path);
  for (const row of rows || []) {
    const parsed = parseNonSailingReviewReason(row.review_reason);
    if (!parsed || parsed.retryable) continue;
    for (const raw of [row.official_url, row.source_url]) {
      const key = canonicalDiscoveryUrl(raw);
      if (!key) continue;
      memory.set(key, {
        reason: parsed.classifier,
        version: parsed.version,
        first_seen: row.discovered_at || null,
        last_seen: row.last_seen_at || null,
        cruise_id: row.id
      });
    }
  }
  return memory;
}

function isPermanentlyRejectedUrl(url, memoryMap) {
  if (!memoryMap?.size) return null;
  const key = canonicalDiscoveryUrl(url);
  return memoryMap.get(key) || null;
}

function shouldSkipUrlBeforeFetch(url, { memoryMap, transientReason = null } = {}) {
  if (transientReason && isTransientFetchFailure(transientReason)) return false;
  return Boolean(isPermanentlyRejectedUrl(url, memoryMap));
}

module.exports = {
  canonicalDiscoveryUrl,
  loadRejectedSourceMemory,
  isPermanentlyRejectedUrl,
  shouldSkipUrlBeforeFetch
};
