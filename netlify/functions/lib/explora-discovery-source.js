/**
 * Explora Journeys — official journey catalogue source (public sitemap + schema.org detail pages).
 *
 * Primary endpoints (public, unauthenticated):
 *   GET explorajourneys.com/int/en/journey.sitemap.xml           (full journey catalogue)
 *   GET explorajourneys.com/int/en/destinations-globe/{region}/journeys/{slug}?id-journey={ID}
 *
 * Official sailing identity: the uppercase `id-journey` query parameter, e.g. EX20260212MIASJU.
 * Identity formula: {SHIP2}{YYYYMMDD}{EMBARK3}{DISEMBARK3} (trailing character may be a
 * disambiguating digit when two journeys share ship/date/port pair).
 */

const https = require("https");

const ADAPTER_ID = "explora";
const ADAPTER_VERSION = "2026-08-10.explora1";
const USER_AGENT = "101cruise-discovery/1.0 (+https://101cruise.com.au)";
const SITE_ORIGIN = "https://explorajourneys.com";
const SITEMAP_URL = `${SITE_ORIGIN}/int/en/journey.sitemap.xml`;
const PREFERRED_LOCALE_PREFIX = "/int/en/";
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESPONSE_BYTES = 900_000;
const DEFAULT_MAX_ATTEMPTS = 3;

const SOURCE_CONTRACT = {
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  primary_endpoint: SITEMAP_URL,
  detail_endpoint_formula:
    "https://explorajourneys.com/int/en/destinations-globe/{region}/journeys/{slug}?id-journey={JOURNEY_ID}",
  method: "GET",
  authentication_required: false,
  authentication_notes: "Public sitemap and public journey detail pages; no session or client id required.",
  pagination: "Single sitemap document listing every published journey (one <loc> per sailing)",
  official_identity_formula: "{SHIP2}{YYYYMMDD}{EMBARK3}{DISEMBARK3}",
  official_identity_source: "id-journey query parameter (uppercased)",
  official_url_formula: "sitemap <loc> (int/en locale preferred)",
  structured_metadata: "schema.org Product + Trip JSON-LD, plus meta description carrying ship name and nights",
  land_product_exclusion:
    "Only /journeys/ URLs carrying id-journey are ingested; hotel-only / land-only titles are classified non_cruise"
};

/** Confirmed from the official meta description ("Journey aboard EXPLORA N"). */
const EXPLORA_SHIP_CODE_NAME = Object.freeze({
  EX: "EXPLORA I",
  EP: "EXPLORA II",
  EL: "EXPLORA III",
  EO: "EXPLORA IV",
  EA: "EXPLORA V"
});

/** Journey titles/URLs that describe land or hotel products rather than a ship sailing. */
const NON_CRUISE_TITLE_RE =
  /\b(hotel[- ]only|land[- ]only|hotel stay|hotel package|land (?:programme|program)|pre-?cruise stay|post-?cruise stay|resort stay|city stay|shore excursion)\b/i;
const NON_CRUISE_PATH_RE = /\/(hotels?|stays?|land-(?:programmes?|programs?)|excursions?)\//i;

const JOURNEY_ID_RE = /^([A-Z]{2})(\d{8})([A-Z0-9]{3})([A-Z0-9]{3})$/;
const JOURNEY_SLUG_RE = /^([a-z0-9]{6})-(\d{2})-(v?\d+)$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIsoDateParts(yyyymmdd) {
  const s = String(yyyymmdd || "").trim();
  if (!/^\d{8}$/.test(s)) return null;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

function normaliseIsoDate(raw) {
  const s = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{8}$/.test(s)) return parseIsoDateParts(s);
  return null;
}

function addDaysIso(isoDate, days) {
  const [y, m, d] = String(isoDate).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
  return dt.toISOString().slice(0, 10);
}

function nightsBetweenIso(startIso, endIso) {
  const start = normaliseIsoDate(startIso);
  const end = normaliseIsoDate(endIso);
  if (!start || !end) return null;
  const diff = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
  if (!Number.isFinite(diff) || diff <= 0 || diff > 400) return null;
  return Math.round(diff);
}

/**
 * @param {string} rawId `id-journey` value, e.g. EX20260212MIASJU
 */
function parseJourneyId(rawId) {
  const id = String(rawId || "").trim().toUpperCase();
  const match = id.match(JOURNEY_ID_RE);
  if (!match) return { valid: false, journey_id: id || null };
  const departure_date = parseIsoDateParts(match[2]);
  if (!departure_date) return { valid: false, journey_id: id };
  return {
    valid: true,
    journey_id: id,
    ship_code: match[1],
    ship_name: EXPLORA_SHIP_CODE_NAME[match[1]] || null,
    departure_date,
    embark_code: match[3],
    disembark_code: match[4]
  };
}

function officialProductKey(raw) {
  if (!raw) return null;
  const direct = raw.official_sailing_id || raw.journey_id || raw.explora_sailing_id || raw.explora_journey_id;
  if (direct) return String(direct).trim().toUpperCase() || null;
  const fromUrl = raw.official_url ? journeyIdFromUrl(raw.official_url) : null;
  return fromUrl || null;
}

function journeyIdFromUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    const id = parsed.searchParams.get("id-journey");
    return id ? id.trim().toUpperCase() : null;
  } catch {
    return null;
  }
}

function isJourneyDetailUrl(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    if (!/explorajourneys\.com$/i.test(parsed.hostname.replace(/^www\./i, ""))) return false;
    if (!/\/journeys\//i.test(parsed.pathname)) return false;
    return Boolean(parsed.searchParams.get("id-journey"));
  } catch {
    return false;
  }
}

/**
 * Canonical journey URL: lowercase origin/path, `id-journey` kept uppercase because the official
 * site treats the identity parameter as case-sensitive.
 */
function buildOfficialUrl(loc) {
  const raw = typeof loc === "string" ? loc : loc?.official_url || loc?.loc || null;
  if (!raw) return null;
  try {
    const parsed = new URL(String(raw).trim(), SITE_ORIGIN);
    if (!parsed.pathname.startsWith(PREFERRED_LOCALE_PREFIX)) {
      const journeyPath = parsed.pathname.replace(/^\/[a-z]{2,3}\/[a-z]{2}\//i, "");
      parsed.pathname = `${PREFERRED_LOCALE_PREFIX}${journeyPath}`;
    }
    const path = parsed.pathname.replace(/\/+$/, "").toLowerCase() || "/";
    const base = `https://${parsed.hostname.toLowerCase()}${path}`;
    const journeyId = parsed.searchParams.get("id-journey");
    return journeyId ? `${base}?id-journey=${journeyId.trim().toUpperCase()}` : base;
  } catch {
    return null;
  }
}

/**
 * @param {string} loc sitemap <loc> URL
 */
function parseSitemapUrl(loc, lastmod = null) {
  const url = String(loc || "").trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: "invalid_url", official_url: url || null };
  }

  const journeyId = journeyIdFromUrl(url);
  if (!journeyId) {
    return { valid: false, reason: "missing_id_journey", official_url: buildOfficialUrl(url) };
  }
  if (!/\/journeys\//i.test(parsed.pathname)) {
    return { valid: false, reason: "not_a_journey_url", official_url: buildOfficialUrl(url), journey_id: journeyId };
  }

  const identity = parseJourneyId(journeyId);
  if (!identity.valid) {
    return { valid: false, reason: "unparseable_journey_id", official_url: buildOfficialUrl(url), journey_id: journeyId };
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const journeysIndex = segments.findIndex((s) => s.toLowerCase() === "journeys");
  const region_code = journeysIndex > 0 ? segments[journeysIndex - 1].toLowerCase() : null;
  const slug = journeysIndex >= 0 ? segments[journeysIndex + 1] || null : null;
  const slugMatch = slug ? slug.match(JOURNEY_SLUG_RE) : null;

  return {
    valid: true,
    journey_id: identity.journey_id,
    ship_code: identity.ship_code,
    ship_name: identity.ship_name,
    departure_date: identity.departure_date,
    embark_code: identity.embark_code,
    disembark_code: identity.disembark_code,
    region_code,
    slug,
    nights_from_slug: slugMatch ? Number(slugMatch[2]) : null,
    official_url: buildOfficialUrl(url),
    lastmod: lastmod || null
  };
}

function classifyProductType(raw) {
  if (!raw) return "unknown";
  const url = String(raw.official_url || raw.url || "");
  const title = [raw.itinerary_name, raw.title, raw.slug].filter(Boolean).join(" ");
  if ((url && NON_CRUISE_PATH_RE.test(url)) || NON_CRUISE_TITLE_RE.test(title)) return "non_cruise";
  const journeyId = officialProductKey(raw);
  if (!journeyId || (url && !isJourneyDetailUrl(url))) return "non_journey";
  return "ocean_cruise";
}

function parseSitemapXml(xml) {
  const entries = [];
  const text = String(xml || "");
  const blocks = text.match(/<url\b[\s\S]*?<\/url>/gi) || [];
  for (const block of blocks) {
    const loc = (block.match(/<loc>([\s\S]*?)<\/loc>/i) || [])[1];
    const lastmod = (block.match(/<lastmod>([\s\S]*?)<\/lastmod>/i) || [])[1] || null;
    if (!loc) continue;
    entries.push({ loc: decodeXmlEntities(loc.trim()), lastmod: lastmod ? lastmod.trim() : null });
  }
  if (!blocks.length) {
    for (const match of text.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)) {
      entries.push({ loc: decodeXmlEntities(match[1].trim()), lastmod: null });
    }
  }
  return entries;
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}

function decodeHtmlEntities(value) {
  return decodeXmlEntities(value).replace(/&nbsp;/gi, " ").replace(/&#(\d+);/g, (_m, code) =>
    String.fromCharCode(Number(code))
  );
}

function exploraTransportGet(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        timeout: timeoutMs,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en",
          "User-Agent": USER_AGENT
        }
      },
      (response) => {
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total <= maxBytes) chunks.push(chunk);
          else response.destroy();
        });
        response.on("end", () => {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode || 0,
            text: Buffer.concat(chunks).toString("utf8"),
            truncated: total > maxBytes
          });
        });
        response.on("close", () => {
          if (total > maxBytes) {
            resolve({
              ok: response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode || 0,
              text: Buffer.concat(chunks).toString("utf8"),
              truncated: true
            });
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("explora_source_timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function fetchWithRetry(url, options = {}) {
  const attempts = Math.max(1, Number(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const transport = options.transport || exploraTransportGet;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(400 * attempt);
    try {
      const result = await transport(url, options);
      if (result.ok) return { ...result, attempts: attempt + 1 };
      lastError = `http_${result.status}`;
      if (result.status && result.status < 500 && result.status !== 429) {
        return { ...result, error: lastError, attempts: attempt + 1 };
      }
    } catch (error) {
      lastError = error.message || String(error);
    }
  }
  return { ok: false, status: 0, text: "", error: lastError || "fetch_failed", attempts };
}

async function mapWithConcurrency(items, limit, worker) {
  const size = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return results;
}

/**
 * @returns {Promise<{ ok: boolean, journeys: object[], error?: string, audit: object }>}
 */
async function fetchJourneySitemap(options = {}) {
  const url = options.sitemapUrl || SITEMAP_URL;
  const response = await fetchWithRetry(url, options);
  if (!response.ok) {
    return {
      ok: false,
      error: response.error || `sitemap_http_${response.status}`,
      journeys: [],
      audit: { sitemap_url: url, raw_locs: 0, parsed: 0, skipped: 0 }
    };
  }

  const entries = parseSitemapXml(response.text);
  const journeys = [];
  const seen = new Set();
  const skipReasons = {};
  let duplicates = 0;

  for (const entry of entries) {
    const parsedEntry = parseSitemapUrl(entry.loc, entry.lastmod);
    if (!parsedEntry.valid) {
      const reason = parsedEntry.reason || "unknown";
      skipReasons[reason] = (skipReasons[reason] || 0) + 1;
      continue;
    }
    if (seen.has(parsedEntry.journey_id)) {
      duplicates += 1;
      continue;
    }
    seen.add(parsedEntry.journey_id);
    journeys.push(parsedEntry);
  }

  return {
    ok: true,
    journeys,
    audit: {
      sitemap_url: url,
      raw_locs: entries.length,
      parsed: journeys.length,
      duplicate_journey_ids: duplicates,
      skipped: entries.length - journeys.length - duplicates,
      skip_reasons: skipReasons
    }
  };
}

function extractJsonLdBlocks(html) {
  const blocks = [];
  for (const match of String(html || "").matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    const body = match[1].trim();
    if (!body) continue;
    try {
      blocks.push(JSON.parse(body));
    } catch {
      /* ignore malformed block */
    }
  }
  return blocks;
}

function findSchemaNode(blocks, type) {
  for (const block of blocks) {
    const nodes = Array.isArray(block?.["@graph"]) ? block["@graph"] : [block];
    for (const node of nodes) {
      if (!node) continue;
      const nodeType = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
      if (nodeType.includes(type)) return node;
    }
  }
  return null;
}

function readMetaContent(html, name) {
  const source = String(html || "");
  const byName = source.match(
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]*content=["']([^"']*)["']`, "i")
  );
  if (byName?.[1]) return decodeHtmlEntities(byName[1]);
  const byProperty = source.match(
    new RegExp(`<meta[^>]+property=["']${name}["'][^>]*content=["']([^"']*)["']`, "i")
  );
  return byProperty?.[1] ? decodeHtmlEntities(byProperty[1]) : null;
}

/**
 * Parse a journey detail page into structured fields (schema.org Trip + meta description).
 */
function parseJourneyDetailHtml(html) {
  const blocks = extractJsonLdBlocks(html);
  const trip = findSchemaNode(blocks, "Trip");
  const product = findSchemaNode(blocks, "Product");
  const metaDescription = readMetaContent(html, "description") || readMetaContent(html, "og:description");

  const shipMatch = metaDescription ? metaDescription.match(/aboard\s+(EXPLORA\s+[IVX]+)/i) : null;
  const nightsMatch = metaDescription ? metaDescription.match(/for\s+(\d{1,3})\s+nights?/i) : null;

  const itineraryPorts = Array.isArray(trip?.itinerary)
    ? trip.itinerary.map((place) => String(place?.name || "").trim()).filter(Boolean)
    : [];

  return {
    has_trip_jsonld: Boolean(trip),
    itinerary_name: trip?.name ? String(trip.name).trim() : product?.name ? String(product.name).trim() : null,
    description: trip?.description ? String(trip.description).trim() : null,
    departure_date: normaliseIsoDate(trip?.departureTime),
    return_date: normaliseIsoDate(trip?.arrivalTime),
    itinerary_ports: itineraryPorts,
    departure_port: itineraryPorts[0] || null,
    arrival_port: itineraryPorts.length ? itineraryPorts[itineraryPorts.length - 1] : null,
    ship_name: shipMatch ? shipMatch[1].toUpperCase().replace(/\s+/g, " ") : null,
    nights_from_meta: nightsMatch ? Number(nightsMatch[1]) : null,
    meta_description: metaDescription || null,
    image: product?.image ? String(product.image) : null
  };
}

function buildRawJourney(sitemapEntry, detail = null) {
  const nights =
    nightsBetweenIso(detail?.departure_date || sitemapEntry.departure_date, detail?.return_date) ??
    detail?.nights_from_meta ??
    sitemapEntry.nights_from_slug ??
    null;
  const departure_date = detail?.departure_date || sitemapEntry.departure_date;
  const return_date =
    detail?.return_date || (nights != null && departure_date ? addDaysIso(departure_date, nights) : null);

  const raw = {
    source: "explora_journey_sitemap",
    structured_source: detail?.has_trip_jsonld ? "explora_journey_trip_jsonld" : "explora_journey_sitemap",
    journey_id: sitemapEntry.journey_id,
    official_sailing_id: sitemapEntry.journey_id,
    ship_code: sitemapEntry.ship_code,
    ship_name: detail?.ship_name || sitemapEntry.ship_name || null,
    region_code: sitemapEntry.region_code,
    slug: sitemapEntry.slug,
    departure_date,
    return_date,
    nights,
    embark_code: sitemapEntry.embark_code,
    disembark_code: sitemapEntry.disembark_code,
    departure_port: detail?.departure_port || null,
    arrival_port: detail?.arrival_port || null,
    itinerary_ports: detail?.itinerary_ports || [],
    itinerary_name: detail?.itinerary_name || null,
    description: detail?.description || detail?.meta_description || null,
    lastmod: sitemapEntry.lastmod || null,
    detail_enriched: Boolean(detail?.has_trip_jsonld),
    official_url: sitemapEntry.official_url
  };
  raw.product_type = classifyProductType(raw);
  return raw;
}

/**
 * Fetch and parse a single journey detail page.
 */
async function enrichJourneyFromDetailPage(sitemapEntry, options = {}) {
  const url = sitemapEntry.official_url;
  const response = await fetchWithRetry(url, options);
  if (!response.ok || !response.text) {
    return {
      ok: false,
      error: response.error || `detail_http_${response.status}`,
      journey_id: sitemapEntry.journey_id,
      raw: buildRawJourney(sitemapEntry, null)
    };
  }
  const detail = parseJourneyDetailHtml(response.text);
  return {
    ok: detail.has_trip_jsonld,
    error: detail.has_trip_jsonld ? null : "missing_trip_jsonld",
    journey_id: sitemapEntry.journey_id,
    detail,
    raw: buildRawJourney(sitemapEntry, detail)
  };
}

/**
 * Full read-only catalogue fetch: sitemap → future journeys → detail-page enrichment.
 */
async function fetchAllExploraRawJourneys(options = {}) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const futureOnly = options.futureOnly !== false;
  const enrich = options.enrich !== false;
  const concurrency = Number(options.concurrency) || DEFAULT_CONCURRENCY;
  const maxJourneys = Number(options.maxJourneys) || null;

  const sitemap = await fetchJourneySitemap(options);
  if (!sitemap.ok) {
    return {
      ok: false,
      fetch_failed: true,
      error: sitemap.error,
      products: [],
      num_found_official: 0,
      audit: sitemap.audit,
      source_contract: SOURCE_CONTRACT
    };
  }

  let candidates = sitemap.journeys;
  let pastSkipped = 0;
  if (futureOnly) {
    const future = candidates.filter((entry) => entry.departure_date >= today);
    pastSkipped = candidates.length - future.length;
    candidates = future;
  }
  candidates = candidates.sort((a, b) => a.journey_id.localeCompare(b.journey_id));
  if (maxJourneys) candidates = candidates.slice(0, maxJourneys);

  if (!enrich) {
    const products = candidates.map((entry) => buildRawJourney(entry, null));
    return {
      ok: true,
      fetch_failed: false,
      products,
      num_found_official: sitemap.journeys.length,
      raw_journey_count: products.length,
      audit: {
        ...sitemap.audit,
        past_journeys_skipped: pastSkipped,
        detail_enriched: 0,
        detail_failed: 0
      },
      source_contract: SOURCE_CONTRACT
    };
  }

  const enriched = await mapWithConcurrency(candidates, concurrency, (entry) =>
    enrichJourneyFromDetailPage(entry, options)
  );

  const products = [];
  const detailFailures = [];
  for (const result of enriched) {
    products.push(result.raw);
    if (!result.ok) {
      detailFailures.push({ journey_id: result.journey_id, error: result.error });
    }
  }

  return {
    ok: true,
    fetch_failed: false,
    products,
    num_found_official: sitemap.journeys.length,
    raw_journey_count: products.length,
    detail_failures: detailFailures,
    audit: {
      ...sitemap.audit,
      past_journeys_skipped: pastSkipped,
      detail_requested: candidates.length,
      detail_enriched: candidates.length - detailFailures.length,
      detail_failed: detailFailures.length,
      concurrency
    },
    source_contract: SOURCE_CONTRACT
  };
}

function normaliseExploraJourney(raw, sourceUrl = null) {
  return {
    official_product_key: officialProductKey(raw),
    product_type: classifyProductType(raw),
    ship_name: raw.ship_name || null,
    departure_port: raw.departure_port || null,
    departure_date: raw.departure_date || null,
    return_date: raw.return_date || null,
    nights: raw.nights ?? null,
    destination_name: raw.region_code || null,
    official_url: raw.official_url || sourceUrl,
    itinerary_name: raw.itinerary_name || null,
    raw
  };
}

function summariseExploraProducts(products, today) {
  const stats = {
    raw_products: products.length,
    ocean_cruises: 0,
    non_cruise: 0,
    non_journey: 0,
    with_official_identity: 0,
    future_products: 0,
    malformed: 0
  };
  for (const product of products) {
    const key = officialProductKey(product.raw || product);
    const type = product.product_type || classifyProductType(product.raw || product);
    if (key) stats.with_official_identity += 1;
    if (type === "ocean_cruise") stats.ocean_cruises += 1;
    if (type === "non_cruise") stats.non_cruise += 1;
    if (type === "non_journey") stats.non_journey += 1;
    const departure = product.departure_date || product.raw?.departure_date;
    if (departure && departure >= today) stats.future_products += 1;
    if (!departure || !(product.ship_name || product.raw?.ship_name)) stats.malformed += 1;
  }
  return stats;
}

/** Read-only inventory probe used by simulation scripts and source smoke checks. */
async function probeExploraInventory(options = {}) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const fetchResult = await fetchAllExploraRawJourneys({ ...options, today });
  const products = (fetchResult.products || []).map((raw) => normaliseExploraJourney(raw));
  return {
    ok: fetchResult.ok,
    read_only: true,
    source: SOURCE_CONTRACT,
    products,
    stats: summariseExploraProducts(products, today),
    fetch: {
      num_found_official: fetchResult.num_found_official,
      raw_journey_count: fetchResult.raw_journey_count,
      fetch_failed: fetchResult.fetch_failed,
      error: fetchResult.error || null,
      audit: fetchResult.audit || null
    }
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  SITEMAP_URL,
  SITE_ORIGIN,
  USER_AGENT,
  DEFAULT_CONCURRENCY,
  EXPLORA_SHIP_CODE_NAME,
  officialProductKey,
  journeyIdFromUrl,
  isJourneyDetailUrl,
  parseJourneyId,
  parseSitemapUrl,
  parseSitemapXml,
  buildOfficialUrl,
  classifyProductType,
  parseJourneyDetailHtml,
  buildRawJourney,
  enrichJourneyFromDetailPage,
  fetchJourneySitemap,
  fetchAllExploraRawJourneys,
  normaliseExploraJourney,
  summariseExploraProducts,
  probeExploraInventory,
  mapWithConcurrency,
  addDaysIso,
  nightsBetweenIso,
  normaliseIsoDate
};
