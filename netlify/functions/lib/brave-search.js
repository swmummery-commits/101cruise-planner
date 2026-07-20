/**
 * Shared Brave Web Search client for Netlify functions.
 * Extracted for Sprint 10D reuse; Cruise Finder retains its own query/domain logic.
 */

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

function getBraveApiKey() {
  return String(process.env.BRAVE_SEARCH_API_KEY || "").trim();
}

/**
 * @param {string} apiKey
 * @param {string} query
 * @param {{ count?: number, country?: string }} [options]
 * @returns {Promise<Array<{ title?: string, url?: string, description?: string, age?: string }>>}
 */
async function braveSearch(apiKey, query, options = {}) {
  const key = String(apiKey || getBraveApiKey() || "").trim();
  if (!key) {
    const err = new Error("BRAVE_SEARCH_API_KEY is not configured");
    err.code = "search_provider_unavailable";
    err.statusCode = 503;
    throw err;
  }

  const q = String(query || "").trim();
  if (!q) return [];

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(options.count || 8));
  url.searchParams.set("country", options.country || "AU");
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("result_filter", "web");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": key
    }
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const err = new Error(
      (data && (data.message || data.error)) || `Brave search failed (${response.status})`
    );
    err.code = "search_provider_unavailable";
    err.statusCode = response.status === 429 ? 429 : 503;
    throw err;
  }

  return (data && data.web && Array.isArray(data.web.results) ? data.web.results : []) || [];
}

/**
 * Deduplicate by URL then domain+title.
 * @param {Array<{ url?: string, title?: string }>} results
 */
function dedupeSearchResults(results) {
  const seenUrl = new Set();
  const seenDomainTitle = new Set();
  const out = [];
  for (const row of results || []) {
    const url = String(row.url || "").trim();
    if (!url || seenUrl.has(url)) continue;
    let domain = "";
    try {
      domain = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    const titleKey = `${domain}|${String(row.title || "").trim().toLowerCase()}`;
    if (seenDomainTitle.has(titleKey)) continue;
    seenUrl.add(url);
    seenDomainTitle.add(titleKey);
    out.push({ ...row, url, domain });
  }
  return out;
}

module.exports = {
  BRAVE_ENDPOINT,
  getBraveApiKey,
  braveSearch,
  dedupeSearchResults
};
