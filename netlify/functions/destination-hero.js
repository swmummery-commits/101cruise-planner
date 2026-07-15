/**
 * Destination hero image lookup for Cruise Finder.
 *
 * GET /.netlify/functions/destination-hero?q=Alaska%20glaciers%20and%20mountains
 *
 * Search phrases should describe destination scenery only
 * (no ships, no cruise-line branding).
 *
 * Providers (no paid plan required):
 *   1. Unsplash — if UNSPLASH_ACCESS_KEY is set (optional, free demo/production tiers)
 *   2. Openverse — default, no API key (commercial Creative Commons filter)
 */

function jsonResponse(statusCode, body, cacheSeconds) {
  const cache =
    typeof cacheSeconds === "number"
      ? `public, max-age=${cacheSeconds}`
      : "no-store";
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": cache
    },
    body: JSON.stringify(body)
  };
}

function cleanQuery(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function pickLandscape(candidates) {
  const scored = candidates
    .filter((c) => c && c.url && /^https:\/\//i.test(c.url))
    .map((c) => {
      const w = Number(c.width) || 0;
      const h = Number(c.height) || 0;
      const ratio = h > 0 ? w / h : 0;
      let score = 0;
      if (w >= 1200) score += 30;
      else if (w >= 900) score += 18;
      else if (w >= 600) score += 8;
      if (ratio >= 1.35) score += 24;
      else if (ratio >= 1.15) score += 10;
      if (/unsplash\.com|pexels\.com|images\.unsplash/i.test(c.url)) score += 12;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

async function searchUnsplash(query, accessKey) {
  const params = new URLSearchParams({
    query,
    orientation: "landscape",
    per_page: "8",
    content_filter: "high"
  });
  const response = await fetch(`https://api.unsplash.com/search/photos?${params}`, {
    method: "GET",
    headers: {
      Authorization: `Client-ID ${accessKey}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) return null;
  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  const candidates = results.map((photo) => ({
    url: photo?.urls?.regular || photo?.urls?.full || null,
    thumb: photo?.urls?.small || null,
    width: photo?.width,
    height: photo?.height,
    alt: photo?.alt_description || query,
    credit: photo?.user?.name || "Unsplash",
    provider: "unsplash"
  }));
  return pickLandscape(candidates);
}

async function searchOpenverse(query) {
  const params = new URLSearchParams({
    q: query,
    page_size: "12",
    aspect_ratio: "wide",
    license_type: "commercial",
    category: "photograph"
  });
  const response = await fetch(`https://api.openverse.org/v1/images/?${params}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "101cruise-CruiseFinder/1.0 (destination-hero)"
    }
  });
  if (!response.ok) return null;
  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  const candidates = results.map((item) => ({
    url: item?.url || null,
    thumb: item?.thumbnail || null,
    width: item?.width,
    height: item?.height,
    alt: item?.title || query,
    credit: item?.creator || "Openverse",
    provider: "openverse"
  }));
  return pickLandscape(candidates);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(204, {});
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const query = cleanQuery(event.queryStringParameters?.q || event.queryStringParameters?.query);
  if (!query) {
    return jsonResponse(400, { error: "Missing q search phrase", url: null });
  }

  try {
    const unsplashKey = process.env.UNSPLASH_ACCESS_KEY || "";
    let hit = null;

    if (unsplashKey) {
      try {
        hit = await searchUnsplash(query, unsplashKey);
      } catch (_error) {
        hit = null;
      }
    }

    if (!hit) {
      hit = await searchOpenverse(query);
    }

    if (!hit || !hit.url) {
      return jsonResponse(404, { url: null, query, provider: null }, 300);
    }

    return jsonResponse(
      200,
      {
        url: hit.url,
        thumb: hit.thumb || null,
        query,
        provider: hit.provider,
        alt: hit.alt || query,
        credit: hit.credit || null,
        width: hit.width || null,
        height: hit.height || null
      },
      86400
    );
  } catch (error) {
    return jsonResponse(
      502,
      {
        url: null,
        query,
        error: error && error.message ? error.message : "Image lookup failed"
      },
      60
    );
  }
};
