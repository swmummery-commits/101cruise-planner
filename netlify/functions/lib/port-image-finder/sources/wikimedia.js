/**
 * Wikimedia Commons image search (copyright-safe primary source).
 */

const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";

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

/**
 * @param {string} query
 * @param {{ limit?: number, timeoutMs?: number }} [options]
 */
async function searchWikimediaCommons(query, options = {}) {
  const q = String(query || "").trim();
  if (!q) return [];

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: q,
    gsrnamespace: "6",
    gsrlimit: String(Math.min(20, options.limit || 12)),
    prop: "imageinfo",
    iiprop: "url|size|extmetadata|mime",
    iiurlwidth: "1280"
  });

  const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 10_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${WIKIMEDIA_API}?${params}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
  } catch (error) {
    const err = new Error(error.name === "AbortError" ? "Wikimedia search timed out" : error.message);
    err.code = "search_provider_unavailable";
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const err = new Error(`Wikimedia search failed (${response.status})`);
    err.code = "search_provider_unavailable";
    throw err;
  }

  const data = await response.json();
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

module.exports = {
  searchWikimediaCommons
};
