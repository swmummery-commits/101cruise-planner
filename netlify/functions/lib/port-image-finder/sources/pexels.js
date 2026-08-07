/**
 * Pexels image search (optional — requires PEXELS_API_KEY).
 */

function getPexelsApiKey() {
  return String(process.env.PEXELS_API_KEY || "").trim();
}

/**
 * @param {string} query
 * @param {{ limit?: number, timeoutMs?: number }} [options]
 */
async function searchPexels(query, options = {}) {
  const key = getPexelsApiKey();
  if (!key) return [];

  const q = String(query || "").trim();
  if (!q) return [];

  const params = new URLSearchParams({
    query: q,
    orientation: "landscape",
    per_page: String(Math.min(15, options.limit || 10))
  });

  const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 8_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`https://api.pexels.com/v1/search?${params}`, {
      signal: controller.signal,
      headers: {
        Authorization: key,
        Accept: "application/json"
      }
    });
  } catch (error) {
    const err = new Error(error.name === "AbortError" ? "Pexels search timed out" : error.message);
    err.code = "search_provider_unavailable";
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) return [];

  const data = await response.json();
  const photos = Array.isArray(data?.photos) ? data.photos : [];
  return photos.map((photo) => ({
    title: photo?.alt || "",
    description: photo?.alt || "",
    url: photo?.src?.large2x || photo?.src?.large || photo?.src?.original || "",
    thumbUrl: photo?.src?.medium || photo?.src?.small || "",
    width: photo?.width || null,
    height: photo?.height || null,
    sourceUrl: photo?.url || "",
    pageUrl: photo?.url || "",
    provider: "pexels",
    license: "Pexels License",
    credit: photo?.photographer ? `Photo by ${photo.photographer} on Pexels` : "Pexels"
  }));
}

module.exports = {
  getPexelsApiKey,
  searchPexels
};
