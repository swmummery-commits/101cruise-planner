/**
 * Princess Cruises — official resdb inventory source (Polar Bear / UBE SPA backend).
 *
 * Primary endpoints (public cruise-search SPA contract):
 *   GET gw.api.princess.com/pcl-web/internal/ube/p1.0/ube?env=prod&country=AU
 *   GET gw.api.princess.com/pcl-web/internal/resdb/p1.0/products?agencyCountry=AU&cruiseType=C&...
 *   GET gw.api.princess.com/pcl-web/internal/resdb/p1.0/ships
 *   GET gw.api.princess.com/pcl-web/internal/resdb/p1.0/ports
 *
 * Official sailing identity: {itinerary_id}|{ship_code}|{departure_date_yyyy_mm_dd}
 */

const { canonicalUrl } = require("./cruise-discovery-structured");
const { fetchSourceExcerpt } = require("./source-fetch");

const ADAPTER_ID = "princess";
const ADAPTER_VERSION = "2026-08-06.princess1";
const USER_AGENT = "101cruise-discovery/1.0 (+https://101cruise.com.au)";
const API_BASE = "https://gw.api.princess.com/pcl-web/internal";
const DEFAULT_CLIENT_ID = "32e7224ac6cc41302f673c5f5d27b4ba";
const DEFAULT_AGENCY_COUNTRY = "AU";
const DEFAULT_PRODUCT_COMPANY = "PC";
const DEFAULT_BOOKING_COMPANY = "PC";

const SOURCE_CONTRACT = {
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  primary_endpoint: `${API_BASE}/resdb/p1.0/products`,
  bootstrap_endpoint: `${API_BASE}/ube/p1.0/ube?env=prod&country=AU`,
  method: "GET",
  authentication_required: true,
  authentication_notes:
    "Requires pcl-client-id header (public SPA client id) plus productcompany/bookingcompany headers. UBE bootstrap sets booking company for AU (PA).",
  pagination: "Single light=true catalogue response (~1005 cruise product groups, ~1969 dated sailings expanded client-side)",
  official_identity_formula: "{itinerary_id}|{ship_code}|{departure_date_iso}",
  official_url_formula:
    "https://www.princess.com/cruise-search/details/?voyageCode={itinerary_id}&shipCode={ship_code}&sailDate={yyyymmdd}",
  cruisetour_exclusion: "cruiseType=C ocean cruises only; cruisetours use separate inventory and are excluded"
};

const CRUISETOUR_RE =
  /cruisetour|land\s+and\s+sea|denali|yukon|overland|ultimate\s+alaska|tundra\s+wilderness/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseSailDate(raw) {
  const s = String(raw || "").trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function addDaysIso(isoDate, days) {
  const [y, m, d] = String(isoDate).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days) || 0);
  return dt.toISOString().slice(0, 10);
}

function officialProductKey(raw) {
  if (!raw) return null;
  if (raw.official_sailing_id) return raw.official_sailing_id;
  const dep = parseSailDate(raw.departure_date || raw.sail_date || raw.sailDate);
  if (raw.itinerary_id && raw.ship_code && dep) {
    return `${raw.itinerary_id}|${raw.ship_code}|${dep}`;
  }
  return null;
}

function officialGroupKey(raw) {
  return raw?.itinerary_id || raw?.id || null;
}

function buildOfficialUrl({ itinerary_id, ship_code, sail_date }) {
  const yyyymmdd = String(sail_date || "").replace(/-/g, "");
  if (!itinerary_id || !ship_code || !yyyymmdd) return null;
  return canonicalUrl(
    `https://www.princess.com/cruise-search/details/?voyageCode=${encodeURIComponent(itinerary_id)}&shipCode=${encodeURIComponent(ship_code)}&sailDate=${encodeURIComponent(yyyymmdd)}`
  );
}

function classifyProductType(raw) {
  if (raw?.cruise_type === "T" || raw?.product_type === "cruisetour") return "cruisetour";
  const text = [raw?.itinerary_name, raw?.name, raw?.official_url].filter(Boolean).join(" ");
  if (CRUISETOUR_RE.test(text)) return "cruisetour";
  return "cruise";
}

async function resolvePclClientId() {
  const envId = String(process.env.PRINCESS_PCL_CLIENT_ID || "").trim();
  if (envId) return envId;
  if (String(process.env.PRINCESS_PCL_CLIENT_ID_REFRESH || "").trim().toLowerCase() === "true") {
    try {
      const chunk = await fetchSourceExcerpt(
        "https://www.princess.com/cruise-search/_next/static/chunks/commons.3bc1da26bfee81df1d5d.js",
        { timeoutMs: 15000, maxExcerptChars: 500000, userAgent: USER_AGENT }
      );
      const text = chunk.excerpt || chunk.html || "";
      const m = text.match(/32e7224[a-f0-9]{24}/i) || text.match(/[a-f0-9]{32}/i);
      if (m) return m[0];
    } catch (_err) {
      /* fallback below */
    }
  }
  return DEFAULT_CLIENT_ID;
}

async function princessApiGet(path, { session = null, clientId = null } = {}) {
  const id = clientId || session?.clientId || (await resolvePclClientId());
  const bookingCompany =
    session?.bookingCompany || session?.booking_company || DEFAULT_BOOKING_COMPANY;
  const productCompany = session?.productCompany || session?.product_company || DEFAULT_PRODUCT_COMPANY;
  const headers = {
    Accept: "application/json, text/plain, */*",
    "User-Agent": USER_AGENT,
    Referer: "https://www.princess.com/cruise-search/cruises/",
    Origin: "https://www.princess.com",
    "pcl-client-id": id,
    productcompany: productCompany,
    bookingcompany: bookingCompany
  };
  if (session?.cookie) headers.Cookie = session.cookie;

  const url = path.startsWith("http") ? path : `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(url, { method: "GET", headers, redirect: "follow" });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_err) {
    data = null;
  }
  const setCookie = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : response.headers.raw?.()["set-cookie"] || [];
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    data,
    text,
    headers: Object.fromEntries(response.headers.entries()),
    setCookie
  };
}

async function bootstrapPrincessSession(options = {}) {
  const clientId = options.clientId || (await resolvePclClientId());
  const result = await princessApiGet("/ube/p1.0/ube?env=prod&country=AU", {
    clientId,
    session: {
      productCompany: DEFAULT_PRODUCT_COMPANY,
      bookingCompany: DEFAULT_BOOKING_COMPANY
    }
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.data?.message || result.data?.httpMessage || `ube_bootstrap_http_${result.status}`,
      clientId
    };
  }
  const settings = result.data?.ube?.settings || {};
  const features = settings.features || {};
  const cookie = (result.setCookie || []).map((part) => String(part).split(";")[0].trim()).filter(Boolean).join("; ");

  return {
    ok: true,
    clientId,
    cookie,
    productCompany: settings.productCompany || DEFAULT_PRODUCT_COMPANY,
    bookingCompany: features.bookingCompanyCode || features.id || DEFAULT_BOOKING_COMPANY,
    settings
  };
}

async function fetchPrincessResdbCatalogue({ session, cruiseType = "C", agencyCountry = DEFAULT_AGENCY_COUNTRY } = {}) {
  const query =
    `resdb/p1.0/products?agencyCountry=${encodeURIComponent(agencyCountry)}` +
    `&cruiseType=${encodeURIComponent(cruiseType)}` +
    "&voyageStatus=A&webDisplay=Y&promoFilter=all&light=true";
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(500 * attempt);
    const result = await princessApiGet(query, {
      session: {
        clientId: session.clientId,
        cookie: session.cookie,
        productCompany: session.productCompany,
        bookingCompany: session.bookingCompany
      }
    });
    if (result.ok) {
      const products = result.data?.products || [];
      return { ok: true, products, raw_count: products.length };
    }
    lastError = result.data?.httpMessage || result.data?.message || `products_http_${result.status}`;
  }
  return {
    ok: false,
    error: lastError || "products_fetch_failed",
    products: []
  };
}

async function fetchPrincessReferenceData(session) {
  const [shipsResult, portsResult] = await Promise.all([
    princessApiGet("resdb/p1.0/ships", { session }),
    princessApiGet("resdb/p1.0/ports", { session })
  ]);
  const shipsById = Object.fromEntries((shipsResult.data?.ships || []).map((s) => [s.id, s]));
  const portsById = Object.fromEntries((portsResult.data?.ports || []).map((p) => [p.id, p]));
  return {
    shipsById,
    portsById,
    ship_count: Object.keys(shipsById).length,
    port_count: Object.keys(portsById).length
  };
}

function expandProductGroupsToRawSailings(groups, { shipsById = {}, portsById = {}, today, futureOnly = true } = {}) {
  const products = [];
  const seen = new Set();
  let duplicateSailingIds = 0;
  let pastSailings = 0;
  let malformed = 0;
  let cruisetourGroups = 0;

  for (const group of groups || []) {
    const itineraryId = group.id || group.itinerary_id;
    if (!itineraryId) {
      malformed += 1;
      continue;
    }
    const embPort = group.embkDbkPortIds?.[0] || null;
    const disPort = group.embkDbkPortIds?.[1] || group.embkDbkPortIds?.[0] || null;
    const portMeta = embPort ? portsById[embPort] : null;
    const tradeIds = (group.trades || []).map((t) => t.id).filter(Boolean);

    for (const shipEntry of group.ships || []) {
      const shipCode = shipEntry.id;
      const shipMeta = shipsById[shipCode] || {};
      for (const sailRaw of shipEntry.sailDates || []) {
        const departure_date = parseSailDate(sailRaw);
        if (!departure_date || !shipCode) {
          malformed += 1;
          continue;
        }
        if (futureOnly && today && departure_date < today) {
          pastSailings += 1;
          continue;
        }
        const nights = group.cruiseDuration ?? group.cruise_duration ?? null;
        const return_date = nights != null ? addDaysIso(departure_date, Number(nights)) : null;
        const raw = {
          source: "princess_resdb",
          structured_source: "princess_resdb_products",
          itinerary_id: itineraryId,
          itinerary_group_id: itineraryId,
          official_sailing_id: null,
          ship_code: shipCode,
          ship_name: shipMeta.name || null,
          departure_date,
          return_date,
          nights,
          departure_port_code: embPort,
          arrival_port_code: disPort,
          departure_port: portMeta?.name || embPort,
          arrival_port: disPort ? portsById[disPort]?.name || disPort : null,
          trade_ids: tradeIds,
          cruise_type: "C",
          product_type: "cruise",
          sail_date: sailRaw,
          official_url: buildOfficialUrl({ itinerary_id: itineraryId, ship_code: shipCode, sail_date: departure_date })
        };
        raw.official_sailing_id = officialProductKey(raw);
        if (!raw.official_sailing_id) {
          malformed += 1;
          continue;
        }
        if (seen.has(raw.official_sailing_id)) {
          duplicateSailingIds += 1;
          continue;
        }
        seen.add(raw.official_sailing_id);
        products.push(raw);
      }
    }
  }

  return {
    products,
    audit: {
      source_groups: (groups || []).length,
      expanded_sailings: products.length,
      duplicate_sailing_ids: duplicateSailingIds,
      past_sailings_skipped: pastSailings,
      malformed,
      cruisetour_groups: cruisetourGroups
    }
  };
}

async function fetchAllPrincessRawSailings(options = {}) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const session = options.session || (await bootstrapPrincessSession(options));
  if (!session.ok) {
    return {
      ok: false,
      fetch_failed: true,
      error: session.error,
      products: [],
      session
    };
  }

  const sessionCtx = {
    clientId: session.clientId,
    cookie: session.cookie,
    productCompany: session.productCompany,
    bookingCompany: session.bookingCompany
  };

  const [catalogue, reference] = await Promise.all([
    fetchPrincessResdbCatalogue({ session: sessionCtx, cruiseType: "C" }),
    fetchPrincessReferenceData(sessionCtx)
  ]);

  if (!catalogue.ok) {
    return {
      ok: false,
      fetch_failed: true,
      error: catalogue.error,
      products: [],
      session: sessionCtx
    };
  }

  const expanded = expandProductGroupsToRawSailings(catalogue.products, {
    shipsById: reference.shipsById,
    portsById: reference.portsById,
    today,
    futureOnly: options.futureOnly !== false
  });

  return {
    ok: true,
    fetch_failed: false,
    session: sessionCtx,
    num_found_official: catalogue.raw_count,
    raw_group_count: catalogue.raw_count,
    reference,
    ...expanded,
    source_contract: SOURCE_CONTRACT
  };
}

async function discoverOfficialVoyageUrls({ seedUrl = "https://www.princess.com/cruise-search/", maxLinks = 40 } = {}) {
  const result = await fetchSourceExcerpt(seedUrl, {
    timeoutMs: 15000,
    maxExcerptChars: 600000,
    includeHtml: true,
    userAgent: USER_AGENT
  });
  if (!result.ok) {
    return { ok: false, error: result.error || "fetch_failed", urls: [] };
  }
  const html = result.html || result.excerpt || "";
  const regexLinks = [];
  const re = /https?:\/\/www\.princess\.com\/[a-z]{2}(?:-[a-z]{2})?\/cruise-search\/details\/[^\s"'<>]+/gi;
  let m;
  while ((m = re.exec(html)) && regexLinks.length < maxLinks) {
    regexLinks.push(canonicalUrl(m[0]));
  }
  const urls = [...new Set(regexLinks)].slice(0, maxLinks);
  return {
    ok: true,
    urls,
    note: "SPA inventory uses resdb API; HTML link discovery is a legacy fallback only"
  };
}

function normalisePrincessVoyage(voyage, sourceUrl) {
  const productType = classifyProductType(voyage);
  return {
    official_product_key: officialProductKey(voyage),
    product_type: productType,
    ship_name: voyage.ship_name || voyage.ship || null,
    departure_port: voyage.departure_port || voyage.departurePort || null,
    departure_date: voyage.departure_date || voyage.startDate || null,
    return_date: voyage.return_date || voyage.endDate || null,
    nights: voyage.nights || voyage.duration_nights || null,
    destination_name: voyage.destination || voyage.region || null,
    official_url: voyage.official_url || sourceUrl,
    itinerary_name: voyage.name || voyage.title || null,
    raw: voyage
  };
}

async function probePrincessInventory({
  seedUrl = "https://www.princess.com/cruise-search/",
  maxLinks = 30,
  maxProducts = 100,
  requestDelayMs = 200,
  today = new Date().toISOString().slice(0, 10)
} = {}) {
  const fetchResult = await fetchAllPrincessRawSailings({ today, maxProducts });
  const products = (fetchResult.products || []).slice(0, maxProducts).map((raw) => normalisePrincessVoyage(raw));
  const stats = summarisePrincessProducts(products, today);

  return {
    ok: fetchResult.ok || products.length > 0,
    read_only: true,
    source: SOURCE_CONTRACT,
    discovered_urls: 0,
    products,
    stats,
    fetch: {
      num_found_official: fetchResult.num_found_official,
      expanded_sailings: fetchResult.audit?.expanded_sailings,
      fetch_failed: fetchResult.fetch_failed,
      error: fetchResult.error || null
    },
    investigation: {
      spa: "Next.js cruise-search (Polar Bear / UBE)",
      official_api_base: API_BASE,
      resdb_products_endpoint: `${API_BASE}/resdb/p1.0/products`,
      ube_bootstrap_endpoint: SOURCE_CONTRACT.bootstrap_endpoint,
      client_id_source: "Public SPA bundle (pcl-client-id header)",
      official_identity_formula: SOURCE_CONTRACT.official_identity_formula
    }
  };
}

function summarisePrincessProducts(products, today) {
  const stats = {
    raw_products: products.length,
    genuine_cruises: 0,
    cruisetours: 0,
    with_official_identity: 0,
    future_products: 0,
    malformed: 0
  };
  for (const p of products) {
    if (p.official_product_key) stats.with_official_identity += 1;
    if (p.product_type === "cruise") stats.genuine_cruises += 1;
    if (p.product_type === "cruisetour") stats.cruisetours += 1;
    if (p.departure_date && p.departure_date >= today) stats.future_products += 1;
    if (!p.departure_date || !p.ship_name) stats.malformed += 1;
  }
  return stats;
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  DEFAULT_CLIENT_ID,
  officialProductKey,
  officialGroupKey,
  buildOfficialUrl,
  classifyProductType,
  parseSailDate,
  resolvePclClientId,
  bootstrapPrincessSession,
  fetchPrincessResdbCatalogue,
  fetchPrincessReferenceData,
  expandProductGroupsToRawSailings,
  fetchAllPrincessRawSailings,
  discoverOfficialVoyageUrls,
  normalisePrincessVoyage,
  probePrincessInventory,
  summarisePrincessProducts
};
