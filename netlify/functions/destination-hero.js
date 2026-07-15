/**
 * Destination hero image lookup for Cruise Finder.
 *
 * GET /.netlify/functions/destination-hero?q=Hawaii%20tropical%20coastline&require=hawaii,hawaiian,maui
 *
 * Filters out ships, indoor/business scenes, and results that do not
 * match destination require-tokens — never returns the first random hit.
 *
 * Providers:
 *   1. Unsplash — if UNSPLASH_ACCESS_KEY is set
 *   2. Openverse — default (commercial Creative Commons)
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

function parseRequire(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3)
    .slice(0, 16);
}

const REJECT_RE =
  /\b(cruise\s*ship|ocean\s*liner|passenger\s*ship|ferry|container\s*ship|cargo\s*ship|yacht\s*marina\s*boat\s*show|conference|convention|meeting\s*room|boardroom|office|powerpoint|presentation|infographic|diagram|logo|branding|screenshot|brochure|flyer|indoor\s*event|auditorium|trade\s*show|expo|webinar|classroom|lecture)\b/i;

function candidateText(c) {
  return [c.alt, c.title, c.tags, c.url]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matchesRequire(text, requireTokens) {
  if (!requireTokens.length) return true;
  return requireTokens.some((token) => text.includes(token));
}

function isRejected(text) {
  return REJECT_RE.test(text);
}

function pickLandscape(candidates, requireTokens) {
  const scored = candidates
    .filter((c) => c && c.url && /^https:\/\//i.test(c.url))
    .map((c) => {
      const text = candidateText(c);
      const w = Number(c.width) || 0;
      const h = Number(c.height) || 0;
      const ratio = h > 0 ? w / h : 0;
      let score = 0;

      if (isRejected(text)) return { ...c, score: -1000, text };
      if (!matchesRequire(text, requireTokens)) return { ...c, score: -500, text };

      if (w >= 1200) score += 30;
      else if (w >= 900) score += 18;
      else if (w >= 600) score += 8;
      if (ratio >= 1.35) score += 24;
      else if (ratio >= 1.15) score += 10;
      if (/unsplash\.com|images\.unsplash|pexels\.com/i.test(c.url)) score += 12;

      /* Prefer outdoor scenery language */
      if (/\b(landscape|coast|beach|glacier|mountain|harbour|harbor|island|ocean|sea|fjord|volcano|temple|scenery|wilderness)\b/i.test(text)) {
        score += 16;
      }

      return { ...c, score, text };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0] || null;
}

async function searchUnsplash(query, accessKey) {
  const params = new URLSearchParams({
    query,
    orientation: "landscape",
    per_page: "15",
    content_filter: "high"
  });
  const response = await fetch(`https://api.unsplash.com/search/photos?${params}`, {
    method: "GET",
    headers: {
      Authorization: `Client-ID ${accessKey}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) return [];
  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map((photo) => ({
    url: photo?.urls?.regular || photo?.urls?.full || null,
    thumb: photo?.urls?.small || null,
    width: photo?.width,
    height: photo?.height,
    alt: photo?.alt_description || "",
    title: photo?.description || "",
    tags: Array.isArray(photo?.tags) ? photo.tags.map((t) => t.title || "").join(" ") : "",
    credit: photo?.user?.name || "Unsplash",
    provider: "unsplash"
  }));
}

async function searchOpenverse(query) {
  const params = new URLSearchParams({
    q: query,
    page_size: "20",
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
  if (!response.ok) return [];
  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map((item) => ({
    url: item?.url || null,
    thumb: item?.thumbnail || null,
    width: item?.width,
    height: item?.height,
    alt: item?.title || "",
    title: item?.title || "",
    tags: Array.isArray(item?.tags)
      ? item.tags.map((t) => (typeof t === "string" ? t : t.name || "")).join(" ")
      : "",
    credit: item?.creator || "Openverse",
    provider: "openverse"
  }));
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(204, {});
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const query = cleanQuery(event.queryStringParameters?.q || event.queryStringParameters?.query);
  const requireTokens = parseRequire(event.queryStringParameters?.require);
  if (!query) {
    return jsonResponse(400, { error: "Missing q search phrase", url: null });
  }

  try {
    const unsplashKey = process.env.UNSPLASH_ACCESS_KEY || "";
    let candidates = [];

    if (unsplashKey) {
      try {
        candidates = candidates.concat(await searchUnsplash(query, unsplashKey));
      } catch (_error) {
        /* continue to Openverse */
      }
    }

    try {
      candidates = candidates.concat(await searchOpenverse(query));
    } catch (_error) {
      /* ignore */
    }

    const hit = pickLandscape(candidates, requireTokens);

    if (!hit || !hit.url) {
      return jsonResponse(404, { url: null, query, require: requireTokens, provider: null }, 300);
    }

    return jsonResponse(
      200,
      {
        url: hit.url,
        thumb: hit.thumb || null,
        query,
        require: requireTokens,
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
