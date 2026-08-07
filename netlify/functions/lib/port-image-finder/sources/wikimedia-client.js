/**
 * Wikimedia Commons client with throttling, retry/backoff, and query cache.
 */

const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";
const MIN_INTERVAL_MS = 1100;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const queryCache = new Map();
let queue = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKey(query, limit) {
  return `${String(query || "").trim().toLowerCase()}|${limit || 12}`;
}

function readCache(key) {
  const hit = queryCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    queryCache.delete(key);
    return null;
  }
  return hit.results;
}

function writeCache(key, results) {
  queryCache.set(key, { at: Date.now(), results });
}

function schedule(fn) {
  queue = queue.then(fn, fn);
  return queue;
}

async function throttle() {
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

function parseRetryAfterMs(response) {
  const header = response.headers.get("retry-after");
  if (!header) return 5000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000);
  return 5000;
}

async function fetchWikimediaApi(params, { timeoutMs = 12_000, attempt = 0 } = {}) {
  await throttle();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${WIKIMEDIA_API}?${params}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "101cruise-port-image-finder/1.0" }
    });
  } catch (error) {
    clearTimeout(timer);
    const err = new Error(error.name === "AbortError" ? "Wikimedia search timed out" : error.message);
    err.code = "search_provider_unavailable";
    throw err;
  }
  clearTimeout(timer);

  if (response.status === 429 && attempt < 2) {
    await sleep(parseRetryAfterMs(response));
    return fetchWikimediaApi(params, { timeoutMs, attempt: attempt + 1 });
  }

  if (!response.ok) {
    const err = new Error(`Wikimedia search failed (${response.status})`);
    err.code = response.status === 429 ? "rate_limited" : "search_provider_unavailable";
    err.statusCode = response.status;
    throw err;
  }

  return response.json();
}

function metaValue(extmetadata, key) {
  const row = extmetadata && extmetadata[key];
  if (!row) return "";
  return String(row.value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAllowedMime(mime) {
  return /^image\/(jpeg|jpg|png|webp)$/i.test(String(mime || ""));
}

function mapPages(data) {
  const pages = data?.query?.pages;
  if (!pages || typeof pages !== "object") return [];
  const out = [];
  for (const page of Object.values(pages)) {
    const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
    if (!info?.url || !isAllowedMime(info.mime)) continue;
    const ext = info.extmetadata || {};
    const license = metaValue(ext, "LicenseShortName") || metaValue(ext, "UsageTerms");
    const credit = metaValue(ext, "Artist") || metaValue(ext, "Credit");
    const description = metaValue(ext, "ImageDescription");
    out.push({
      title: page.title ? String(page.title).replace(/^File:/, "") : "",
      description,
      url: info.thumburl || info.url,
      thumbUrl: info.thumburl || info.url,
      width: info.thumbwidth || info.width || null,
      height: info.thumbheight || info.height || null,
      sourceUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title || "")}`,
      pageUrl: info.descriptionurl || "",
      provider: "wikimedia",
      license,
      credit: credit || "Wikimedia Commons"
    });
  }
  return out;
}

/**
 * @param {string} query
 * @param {{ limit?: number, timeoutMs?: number }} [options]
 */
async function searchWikimediaCommons(query, options = {}) {
  const q = String(query || "").trim();
  if (!q) return [];

  const limit = Math.min(20, options.limit || 12);
  const key = cacheKey(q, limit);
  const cached = readCache(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: q,
    gsrnamespace: "6",
    gsrlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|size|extmetadata|mime",
    iiurlwidth: "1280"
  });

  const data = await schedule(() => fetchWikimediaApi(params, { timeoutMs: options.timeoutMs }));
  const results = mapPages(data);
  writeCache(key, results);
  return results;
}

function __resetWikimediaClientForTests() {
  queryCache.clear();
  queue = Promise.resolve();
  lastRequestAt = 0;
}

module.exports = {
  searchWikimediaCommons,
  __resetWikimediaClientForTests
};
