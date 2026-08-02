/**
 * Sprint 11D.2 — Prefer structured sailing data from official HTML.
 * Does not bypass auth or bot protections; only public HTML payloads.
 */

function canonicalUrl(url) {
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
function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      blocks.push(parsed);
    } catch {
      /* ignore */
    }
  }
  return blocks;
}

function extractNextData(html) {
  const m = String(html || "").match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function walkCollectUrls(node, out, depth = 0) {
  if (!node || depth > 12) return;
  if (typeof node === "string") {
    if (/^https?:\/\//i.test(node) && /itinerar|sail|voyage|journey|booking|cruise/i.test(node)) {
      out.add(node);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walkCollectUrls(item, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (/url|href|link|itinerary|sailing/i.test(k) && typeof v === "string" && /^https?:\/\//i.test(v)) {
        out.add(v);
      }
      walkCollectUrls(v, out, depth + 1);
    }
  }
}

function extractEmbeddedJsonBlobs(html) {
  const blobs = [];
  const re =
    /<script[^>]*>\s*(?:window\.__[A-Z0-9_]+__\s*=\s*|self\.__next_f\.push\(|var\s+\w+\s*=\s*)(\{[\s\S]{200,}?\});?\s*<\/script>/gi;
  let m;
  let guard = 0;
  while ((m = re.exec(String(html || ""))) !== null && guard < 8) {
    guard += 1;
    try {
      blobs.push(JSON.parse(m[1]));
    } catch {
      /* ignore malformed */
    }
  }
  return blobs;
}

function extractAnchorUrls(html, baseUrl) {
  const urls = new Set();
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let m;
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    base = null;
  }
  while ((m = re.exec(String(html || ""))) !== null) {
    const href = String(m[1] || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) {
      continue;
    }
    try {
      const abs = base ? new URL(href, base).toString() : href;
      if (/itinerar|sail|voyage|journey|booking|find-a-cruise|cruise-search|depart|cruise-details|\/cruises?\//i.test(abs)) {
        urls.add(abs.split("#")[0]);
      }
    } catch {
      /* ignore */
    }
  }
  return [...urls];
}

function walkCollectVoyages(node, out, depth = 0, ctx = {}) {
  if (!node || depth > 14) return;
  if (Array.isArray(node)) {
    for (const item of node) walkCollectVoyages(item, out, depth + 1, ctx);
    return;
  }
  if (typeof node !== "object") return;

  const type = String(node["@type"] || node.type || "").toLowerCase();
  const startDate = node.startDate || node.departureDate || node.sailDate || node.embarkDate || null;
  const endDate = node.endDate || node.returnDate || node.disembarkDate || null;
  const url = node.url || node.bookingUrl || node.offers?.url || ctx.url || null;
  const name = node.name || node.title || node.headline || null;
  const desc = node.description || null;
  const location = node.departureLocation || node.location || node.embarkationPort || null;
  const locName =
    typeof location === "string"
      ? location
      : location?.name || location?.address?.addressLocality || null;
  const duration = node.duration || node.numberOfDays || node.nights || null;
  const identifier = node.identifier || node.sku || node.productID || node.voyageId || null;

  const voyageLike =
    startDate ||
    (type && /trip|event|product|offer|cruise|voyage|itinerary|sailing/.test(type) && (name || url));

  if (voyageLike && (startDate || url || identifier)) {
    out.push({
      source: ctx.source || "structured",
      title: name ? String(name) : null,
      description: desc ? String(desc) : null,
      url: url ? String(url) : null,
      departure_date: startDate ? String(startDate).slice(0, 10) : null,
      return_date: endDate ? String(endDate).slice(0, 10) : null,
      nights: typeof duration === "number" ? duration : null,
      departure_port: locName ? String(locName) : null,
      voyage_id: identifier ? String(identifier) : null,
      ship_name: node.ship?.name || node.vehicle?.name || node.provider?.name || null
    });
  }

  for (const v of Object.values(node)) {
    if (v && typeof v === "object") walkCollectVoyages(v, out, depth + 1, ctx);
  }
}

/**
 * Extract voyage records from JSON-LD, Next.js data and embedded JSON blobs.
 */
function extractStructuredVoyages(html, pageUrl) {
  const voyages = [];
  const methods = [];
  const jsonLd = extractJsonLd(html);
  if (jsonLd.length) {
    methods.push("json_ld_voyage");
    for (const block of jsonLd) {
      const items = Array.isArray(block) ? block : block["@graph"] ? block["@graph"] : [block];
      for (const item of items) walkCollectVoyages(item, voyages, 0, { source: "json_ld", url: pageUrl });
    }
  }
  const nextData = extractNextData(html);
  if (nextData) {
    methods.push("next_data_voyage");
    walkCollectVoyages(nextData, voyages, 0, { source: "next_data", url: pageUrl });
  }
  const embedded = extractEmbeddedJsonBlobs(html);
  if (embedded.length) {
    methods.push("embedded_json_voyage");
    for (const blob of embedded) walkCollectVoyages(blob, voyages, 0, { source: "embedded_json", url: pageUrl });
  }

  const seen = new Set();
  const deduped = [];
  for (const v of voyages) {
    const key = [v.voyage_id || "", v.url || "", v.departure_date || "", v.title || ""].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(v);
  }
  return { voyages: deduped, methods: [...new Set(methods)] };
}

/** Parse sitemap XML for cruise-like loc URLs (no external fetch). */
function extractSitemapLocs(xml, baseUrl) {
  const urls = new Set();
  const re = /<loc>([^<]+)<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || ""))) !== null) {
    const loc = String(m[1] || "").trim();
    if (!loc) continue;
    if (/itinerar|sail|voyage|journey|booking|cruise-details|find-a-cruise|\/cruises?\//i.test(loc)) {
      try {
        urls.add(new URL(loc.split("#")[0]).toString());
      } catch {
        if (baseUrl) {
          try {
            urls.add(new URL(loc, baseUrl).toString());
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  return [...urls];
}

/**
 * Inspect official HTML for sailing URLs + structured payloads.
 */
function extractStructuredSailingSources(html, pageUrl) {
  const sailingUrls = new Set();
  const methods = [];
  const jsonLd = extractJsonLd(html);
  if (jsonLd.length) {
    methods.push("json_ld");
    for (const block of jsonLd) walkCollectUrls(block, sailingUrls);
  }

  const nextData = extractNextData(html);
  if (nextData) {
    methods.push("next_data");
    walkCollectUrls(nextData, sailingUrls);
  }

  const embedded = extractEmbeddedJsonBlobs(html);
  if (embedded.length) {
    methods.push("embedded_json");
    for (const blob of embedded) walkCollectUrls(blob, sailingUrls);
  }

  const anchors = extractAnchorUrls(html, pageUrl);
  if (anchors.length) {
    methods.push("result_links");
    for (const u of anchors) sailingUrls.add(u);
  }

  // Detect likely API endpoints mentioned in page (record only — do not call auth'd APIs)
  const apiHints = [];
  const apiRe = /https?:\/\/[^"'\\\s]+(?:graphql|\/api\/|search|itineraries|sailings)[^"'\\\s]*/gi;
  let am;
  while ((am = apiRe.exec(String(html || ""))) !== null && apiHints.length < 10) {
    apiHints.push(am[0]);
  }
  if (apiHints.length) methods.push("api_hint");

  const voyageExtract = extractStructuredVoyages(html, pageUrl);

  return {
    sailingUrls: [...sailingUrls]
      .filter(Boolean)
      .filter((u) => {
        const { pathMatchesHardReject, pathMatchesRegionalHub, evaluateSailingEvidence } = require("./discovery-non-sailing-filter");
        if (pathMatchesHardReject(u)) return false;
        if (pathMatchesRegionalHub(u) && !/\/cruises?\//i.test(u)) return false;
        return true;
      }),
    methods: [...new Set(methods)],
    apiHints,
    hasStructured: Boolean(jsonLd.length || nextData || embedded.length),
    structuredVoyages: voyageExtract.voyages,
    voyageMethods: voyageExtract.methods
  };
}

/**
 * Build a text excerpt that prefers structured sailing fields when present.
 */
function structuredExcerptHint(html) {
  const parts = [];
  const jsonLd = extractJsonLd(html);
  for (const block of jsonLd) {
    try {
      parts.push(JSON.stringify(block).slice(0, 1500));
    } catch {
      /* ignore */
    }
  }
  const nextData = extractNextData(html);
  if (nextData) {
    try {
      parts.push(JSON.stringify(nextData).slice(0, 2000));
    } catch {
      /* ignore */
    }
  }
  return parts.join("\n").slice(0, 4000);
}

module.exports = {
  extractJsonLd,
  extractNextData,
  extractStructuredSailingSources,
  extractStructuredVoyages,
  extractSitemapLocs,
  structuredExcerptHint,
  extractAnchorUrls
};
