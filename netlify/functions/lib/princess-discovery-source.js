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

const https = require("https");
const { canonicalUrl } = require("./cruise-discovery-structured");
const { fetchSourceExcerpt } = require("./source-fetch");
const {
  fingerprintClientId,
  classifyClientIdSource,
  requestConstructionFingerprint,
  classifyPrincessSourceFailure,
  lookupDnsClass,
  redactSecretsFromDiagnostics
} = require("./princess-source-diagnostics");

const ADAPTER_ID = "princess";
const ADAPTER_VERSION = "2026-08-07.princess2";
const USER_AGENT = "101cruise-discovery/1.0 (+https://101cruise.com.au)";
const API_BASE = "https://gw.api.princess.com/pcl-web/internal";
const DEFAULT_CLIENT_ID = "32e7224ac6cc41302f673c5f5d27b4ba";
const DEFAULT_AGENCY_COUNTRY = "AU";
const DEFAULT_PRODUCT_COMPANY = "PC";
const DEFAULT_BOOKING_COMPANY = "PC";

/** @type {null | ((url: string, headers: object, opts: { timeoutMs?: number }) => Promise<object>)} */
let transportGetOverride = null;

const SOURCE_CONTRACT = {
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  primary_endpoint: `${API_BASE}/resdb/p1.0/products`,
  bootstrap_endpoint: `${API_BASE}/ube/p1.0/ube?env=prod&country=AU`,
  method: "GET",
  authentication_required: true,
  authentication_notes:
    "Requires pcl-client-id header (public SPA client id) plus productcompany/bookingcompany headers. UBE bootstrap sets booking company for AU (PA).",
  pagination:
    "Parallel light=true (sail dates) + light=false (itinerary names) catalogue (~1005 groups, ~1969 sailings expanded client-side)",
  official_identity_formula: "{itinerary_id}|{ship_code}|{departure_date_iso}",
  official_url_formula:
    "https://www.princess.com/cruise-search/details/?voyageCode={itinerary_id}&shipCode={ship_code}&sailDate={yyyymmdd}",
  cruisetour_exclusion: "cruiseType=C ocean cruises only; cruisetours use separate inventory and are excluded"
};

const CRUISETOUR_RE =
  /cruisetour|land\s+and\s+sea|denali|yukon|overland|ultimate\s+alaska|tundra\s+wilderness/i;

/** Princess official voyage codes stored when itinerary names are missing (e.g. ANG07A, ASG070). */
const PRINCESS_VOYAGE_CODE_RE = /^[A-Z]{2,4}\d{2}[A-Z0-9]{0,2}$/;

function isPrincessVoyageCode(value) {
  return PRINCESS_VOYAGE_CODE_RE.test(String(value || "").trim());
}

function buildPrincessItineraryNameMap(groups) {
  const map = new Map();
  for (const group of groups || []) {
    const id = group.id || group.itinerary_id;
    const name = String(group.name || "").trim();
    if (id && name) map.set(id, name);
  }
  return map;
}

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

async function resolvePclClientIdDetailed(env = process.env) {
  const envId = String(env.PRINCESS_PCL_CLIENT_ID || "").trim();
  if (envId) {
    return { value: envId, source: "ENV" };
  }
  if (String(env.PRINCESS_PCL_CLIENT_ID_REFRESH || "").trim().toLowerCase() === "true") {
    try {
      const chunk = await fetchSourceExcerpt(
        "https://www.princess.com/cruise-search/_next/static/chunks/commons.3bc1da26bfee81df1d5d.js",
        { timeoutMs: 15000, maxExcerptChars: 500000, userAgent: USER_AGENT }
      );
      const text = chunk.excerpt || chunk.html || "";
      const m = text.match(/32e7224[a-f0-9]{24}/i) || text.match(/[a-f0-9]{32}/i);
      if (m) return { value: m[0], source: "REFRESHED" };
    } catch (_err) {
      /* fallback below */
    }
  }
  return { value: DEFAULT_CLIENT_ID, source: classifyClientIdSource(env, false) };
}

async function resolvePclClientId() {
  const resolved = await resolvePclClientIdDetailed();
  return resolved.value;
}

function readResponseSetCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const combined = response.headers.get("set-cookie");
  if (!combined) return [];
  // Avoid splitting on commas inside Expires= attributes when only a combined header exists.
  return combined.split(/,(?=\s*[A-Za-z0-9_.-]+=)/).map((part) => part.trim()).filter(Boolean);
}

const SAFE_RESPONSE_HEADER_KEYS = [
  "content-type",
  "content-length",
  "server",
  "date",
  "cache-control",
  "x-request-id",
  "x-correlation-id",
  "x-akamai-request-id",
  "x-akamai-session-info",
  "x-akamai-transformed"
];

function sanitizeResponseHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase();
    if (lower.includes("cookie") || lower.includes("authorization") || lower.includes("secret")) continue;
    if (SAFE_RESPONSE_HEADER_KEYS.some((allowed) => lower.includes(allowed))) {
      out[lower] = String(value).slice(0, 200);
    }
  }
  return out;
}

function sanitizeBodyExcerpt(text, maxLen = 240) {
  const cleaned = String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen);
}

function sanitizeSessionFingerprint(session) {
  if (!session) return null;
  const cookie = session.cookie ? String(session.cookie) : "";
  return {
    ok: session.ok !== false,
    client_id: fingerprintClientId(session.clientId),
    client_id_source: session.client_id_source || null,
    cookie_present: Boolean(cookie),
    cookie_count: cookie
      ? cookie.split(";").map((part) => part.trim()).filter(Boolean).length
      : Number(session.diagnostics?.cookie_count || 0),
    productcompany: session.productCompany || null,
    bookingcompany: session.bookingCompany || null
  };
}

function buildPrincessSourceDiagnosticsEnvelope({
  session = null,
  catalogue = null,
  extra = {}
} = {}) {
  const bootstrap = session?.diagnostics || extra.bootstrap || null;
  const catalogueDiag = catalogue?.diagnostics || extra.catalogue || null;
  const transport =
    extra.transport ||
    bootstrap?.attempts?.[0]?.transport ||
    catalogueDiag?.attempts?.[0]?.transport ||
    null;
  const fetchFailed = extra.fetch_failed === true || session?.ok === false || catalogue?.ok === false;
  const failureClass = fetchFailed
    ? classifyPrincessSourceFailure({
        bootstrap,
        catalogue: catalogueDiag,
        transport
      })
    : null;
  return redactSecretsFromDiagnostics({
    effective_client_id: fingerprintClientId(session?.clientId),
    client_id_source: session?.client_id_source || extra.client_id_source || classifyClientIdSource(),
    session: sanitizeSessionFingerprint(session),
    bootstrap,
    catalogue: catalogueDiag,
    request: bootstrap?.attempts?.[0]?.request || catalogueDiag?.attempts?.[0]?.request || extra.request || null,
    transport,
    failure_class: failureClass
  });
}

function describeCatalogueAttempt(sessionVariant, attemptIndex) {
  return {
    attempt: attemptIndex + 1,
    bootstrap_cookies_used: Boolean(sessionVariant?.cookie),
    client_id_included: Boolean(sessionVariant?.clientId),
    bookingcompany: sessionVariant?.bookingCompany || DEFAULT_BOOKING_COMPANY,
    productcompany: sessionVariant?.productCompany || DEFAULT_PRODUCT_COMPANY,
    agencyCountry: DEFAULT_AGENCY_COUNTRY
  };
}

function readNodeSetCookies(headers = {}) {
  const raw = headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

async function princessTransportGet(url, headers, { timeoutMs = 30000 } = {}) {
  if (transportGetOverride) {
    const response = await transportGetOverride(url, headers, { timeoutMs });
    return { ...response, transport: { mocked: true, tcp_tls_success: true } };
  }
  const parsed = new URL(url);
  const dns = await lookupDnsClass(parsed.hostname);
  if (!dns.ok) {
    const err = new Error("princess_source_dns_failure");
    err.code = dns.error_code || "ENOTFOUND";
    err.transport = { dns, tcp_tls_success: false, timeout: false };
    throw err;
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers,
        timeout: timeoutMs
      },
      (response) => {
        let text = "";
        const socket = response.socket;
        const transport = {
          dns,
          hostname: parsed.hostname,
          path: `${parsed.pathname}${parsed.search}`,
          tcp_tls_success: true,
          tls_protocol: typeof socket?.getProtocol === "function" ? socket.getProtocol() : null,
          remote_family_class: socket?.remoteFamily === "IPv6" ? "IPv6" : "IPv4",
          timeout: false
        };
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode || 0,
            headers: response.headers || {},
            text,
            setCookie: readNodeSetCookies(response.headers),
            transport
          });
        });
      }
    );
    req.on("timeout", () => {
      const err = new Error("princess_source_timeout");
      err.code = "ETIMEDOUT";
      err.transport = { dns, hostname: parsed.hostname, tcp_tls_success: false, timeout: true };
      req.destroy(err);
    });
    req.on("error", (error) => {
      error.transport = {
        dns,
        hostname: parsed.hostname,
        tcp_tls_success: false,
        timeout: /timeout/i.test(error.message || "") || error.code === "ETIMEDOUT",
        tls_ok: !/CERT|SSL|TLS/i.test(String(error.code || error.message || "")),
        error_code: error.code || "TRANSPORT_ERROR"
      };
      reject(error);
    });
    req.end();
  });
}

async function princessApiGet(path, { session = null, clientId = null, collectDiagnostics = false } = {}) {
  const started = Date.now();
  const resolved = clientId
    ? { value: clientId, source: session?.client_id_source || "SESSION" }
    : session?.clientId
      ? { value: session.clientId, source: session.client_id_source || "SESSION" }
      : await resolvePclClientIdDetailed();
  const id = resolved.value;
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
  let response;
  try {
    response = await princessTransportGet(url, headers);
  } catch (error) {
    const transport = error.transport || { tcp_tls_success: false, error_code: error.code || "TRANSPORT_ERROR" };
    const result = {
      ok: false,
      status: 0,
      data: null,
      text: "",
      headers: {},
      setCookie: [],
      transport
    };
    if (collectDiagnostics) {
      result.diagnostics = redactSecretsFromDiagnostics({
        http_status: 0,
        elapsed_ms: Date.now() - started,
        response_content_type: null,
        response_headers: {},
        body_excerpt: sanitizeBodyExcerpt(error.message),
        transport,
        effective_client_id: fingerprintClientId(id),
        client_id_source: resolved.source,
        request: requestConstructionFingerprint({
          userAgent: USER_AGENT,
          origin: headers.Origin,
          referer: headers.Referer,
          clientIdPresent: Boolean(id),
          cookiePresent: Boolean(session?.cookie),
          productcompany: productCompany,
          bookingcompany: bookingCompany
        })
      });
    }
    return result;
  }
  const text = response.text;
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_err) {
    data = null;
  }
  const setCookie = response.setCookie || [];
  const result = {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    data,
    text,
    headers: response.headers,
    setCookie,
    transport: response.transport || null
  };
  if (collectDiagnostics) {
    const parsedUrl = new URL(url);
    result.diagnostics = redactSecretsFromDiagnostics({
      http_status: response.status,
      elapsed_ms: Date.now() - started,
      response_content_type: response.headers["content-type"] || null,
      response_content_length: response.headers["content-length"] || null,
      response_headers: sanitizeResponseHeaders(response.headers),
      body_excerpt: sanitizeBodyExcerpt(text),
      transport: response.transport || { transport: "https" },
      hostname: parsedUrl.hostname,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      effective_client_id: fingerprintClientId(id),
      client_id_source: resolved.source,
      request: requestConstructionFingerprint({
        userAgent: USER_AGENT,
        origin: headers.Origin,
        referer: headers.Referer,
        clientIdPresent: Boolean(id),
        cookiePresent: Boolean(session?.cookie),
        productcompany: productCompany,
        bookingcompany: bookingCompany
      })
    });
  }
  return result;
}

async function bootstrapPrincessSession(options = {}) {
  const collectDiagnostics = options.collectDiagnostics === true;
  const resolved = options.clientId
    ? { value: options.clientId, source: options.client_id_source || "SESSION" }
    : await resolvePclClientIdDetailed();
  const clientId = resolved.value;
  const result = await princessApiGet("/ube/p1.0/ube?env=prod&country=AU", {
    clientId,
    collectDiagnostics,
    session: {
      productCompany: DEFAULT_PRODUCT_COMPANY,
      bookingCompany: DEFAULT_BOOKING_COMPANY,
      client_id_source: resolved.source
    }
  });
  if (!result.ok) {
    const diagnostics = collectDiagnostics
      ? redactSecretsFromDiagnostics({
          stage: "bootstrap",
          attempts: [result.diagnostics].filter(Boolean),
          effective_client_id: fingerprintClientId(clientId),
          client_id_source: resolved.source,
          failure_class: classifyPrincessSourceFailure({
            bootstrap: { attempts: [result.diagnostics].filter(Boolean) },
            transport: result.transport || result.diagnostics?.transport
          })
        })
      : null;
    return {
      ok: false,
      error: result.data?.message || result.data?.httpMessage || `ube_bootstrap_http_${result.status}`,
      clientId,
      client_id_source: resolved.source,
      diagnostics
    };
  }
  const settings = result.data?.ube?.settings || {};
  const features = settings.features || {};
  const cookie = (result.setCookie || []).map((part) => String(part).split(";")[0].trim()).filter(Boolean).join("; ");

  return {
    ok: true,
    clientId,
    client_id_source: resolved.source,
    cookie,
    productCompany: settings.productCompany || DEFAULT_PRODUCT_COMPANY,
    bookingCompany: features.bookingCompanyCode || features.id || DEFAULT_BOOKING_COMPANY,
    settings,
    diagnostics: collectDiagnostics
      ? redactSecretsFromDiagnostics({
          stage: "bootstrap",
          attempts: [result.diagnostics].filter(Boolean),
          cookie_count: (result.setCookie || []).length,
          cookie_present: Boolean(cookie),
          bookingcompany: features.bookingCompanyCode || features.id || DEFAULT_BOOKING_COMPANY,
          productcompany: settings.productCompany || DEFAULT_PRODUCT_COMPANY,
          effective_client_id: fingerprintClientId(clientId),
          client_id_source: resolved.source
        })
      : null
  };
}

function formatPrincessHttpError(result, stage = "catalogue") {
  const data = result?.data || {};
  const path = result?.diagnostics?.request?.path || null;
  const parts = [
    stage,
    data.httpCode ? `http_${data.httpCode}` : result?.status ? `http_${result.status}` : null,
    data.httpMessage || null,
    data.moreInformation || null,
    path ? `path=${path}` : null
  ].filter(Boolean);
  return {
    message: parts.join(" | "),
    stage,
    http_status: result?.status ?? (data.httpCode ? Number(data.httpCode) : null),
    http_message: data.httpMessage || null,
    more_information: data.moreInformation || null,
    endpoint: path
  };
}

function isPrincessTransientMissingParamsError(errorDetail, attempts = []) {
  const msg = String(errorDetail?.more_information || errorDetail?.http_message || errorDetail?.message || "");
  if (!/missing in the API request/i.test(msg)) return false;
  const httpStatuses = (attempts || []).map((a) => a.http_status ?? a.status).filter(Boolean);
  return httpStatuses.length > 0 && httpStatuses.every((s) => Number(s) === 400);
}

function recordCatalogueControlAttempt(internalAttempts, variant, result, attemptIndex) {
  internalAttempts.push({
    http_status: result.status,
    http_message: result.data?.httpMessage || null,
    more_information: result.data?.moreInformation || null,
    variant: describeCatalogueAttempt(variant, attemptIndex)
  });
}

async function fetchPrincessResdbCatalogue({
  session,
  cruiseType = "C",
  agencyCountry = DEFAULT_AGENCY_COUNTRY,
  light = true,
  collectDiagnostics = false
} = {}) {
  const query =
    `resdb/p1.0/products?agencyCountry=${encodeURIComponent(agencyCountry)}` +
    `&cruiseType=${encodeURIComponent(cruiseType)}` +
    `&voyageStatus=A&webDisplay=Y&promoFilter=all&light=${light ? "true" : "false"}`;
  // Header-only requests first — bootstrap cookies are intermittently rejected by Akamai.
  const sessionVariants = [
    { ...session, cookie: null },
    session,
    { ...session, cookie: null, bookingCompany: DEFAULT_BOOKING_COMPANY },
    { ...session, bookingCompany: DEFAULT_BOOKING_COMPANY }
  ];
  let lastError = null;
  let lastErrorDetail = null;
  const internalAttempts = [];
  const attempts = [];

  async function runVariantLoop() {
    for (let attempt = 0; attempt < sessionVariants.length; attempt += 1) {
      if (attempt > 0) await sleep(400 * attempt);
      const variant = sessionVariants[attempt];
      const result = await princessApiGet(query, {
        collectDiagnostics,
        session: {
          clientId: variant.clientId,
          cookie: variant.cookie || null,
          productCompany: variant.productCompany,
          bookingCompany: variant.bookingCompany,
          client_id_source: variant.client_id_source || session?.client_id_source
        }
      });
      recordCatalogueControlAttempt(internalAttempts, variant, result, internalAttempts.length);
      if (collectDiagnostics && result.diagnostics) {
        attempts.push({
          ...internalAttempts[internalAttempts.length - 1].variant,
          ...result.diagnostics
        });
      }
      if (result.ok) {
        const products = result.data?.products || [];
        return {
          ok: true,
          products,
          raw_count: products.length,
          diagnostics: collectDiagnostics ? { stage: "catalogue", attempts } : null
        };
      }
      lastErrorDetail = formatPrincessHttpError(result, "catalogue");
      lastError = lastErrorDetail.message;
    }
    return null;
  }

  const firstPass = await runVariantLoop();
  if (firstPass?.ok) return firstPass;

  if (isPrincessTransientMissingParamsError(lastErrorDetail, internalAttempts)) {
    await sleep(2500);
    const headerOnly = { ...session, cookie: null };
    const retryResult = await princessApiGet(query, {
      collectDiagnostics,
      session: {
        clientId: headerOnly.clientId,
        cookie: null,
        productCompany: headerOnly.productCompany,
        bookingCompany: headerOnly.bookingCompany
      }
    });
    recordCatalogueControlAttempt(internalAttempts, headerOnly, retryResult, internalAttempts.length);
    if (collectDiagnostics && retryResult.diagnostics) {
      attempts.push({
        ...internalAttempts[internalAttempts.length - 1].variant,
        retry_after_transient_400: true,
        ...retryResult.diagnostics
      });
    }
    if (retryResult.ok) {
      const products = retryResult.data?.products || [];
      return {
        ok: true,
        products,
        raw_count: products.length,
        diagnostics: collectDiagnostics
          ? { stage: "catalogue", attempts, transient_retry: true }
          : { stage: "catalogue", transient_retry: true, control_attempts: internalAttempts.length }
      };
    }
    lastErrorDetail = formatPrincessHttpError(retryResult, "catalogue");
    lastError = lastErrorDetail.message;
  }

  return {
    ok: false,
    error: lastError || "products_fetch_failed",
    error_detail: lastErrorDetail,
    products: [],
    diagnostics: collectDiagnostics ? { stage: "catalogue", attempts } : null
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

function expandProductGroupsToRawSailings(
  groups,
  { shipsById = {}, portsById = {}, itineraryNamesById = new Map(), today, futureOnly = true } = {}
) {
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
    const itinerary_name =
      itineraryNamesById.get(itineraryId) || String(group.name || "").trim() || null;

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
          itinerary_name,
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
  const collectDiagnostics = options.collectDiagnostics !== false;
  const session = options.session || (await bootstrapPrincessSession({ ...options, collectDiagnostics }));
  if (!session.ok) {
    const source_diagnostics = buildPrincessSourceDiagnosticsEnvelope({
      session,
      extra: { fetch_failed: true }
    });
    return {
      ok: false,
      fetch_failed: true,
      error: session.error,
      products: [],
      session: sanitizeSessionFingerprint(session),
      source_diagnostics
    };
  }

  const sessionCtx = {
    clientId: session.clientId,
    cookie: session.cookie,
    productCompany: session.productCompany,
    bookingCompany: session.bookingCompany,
    client_id_source: session.client_id_source || classifyClientIdSource()
  };

  const [catalogue, catalogueNames, reference] = await Promise.all([
    fetchPrincessResdbCatalogue({ session: sessionCtx, cruiseType: "C", light: true, collectDiagnostics }),
    fetchPrincessResdbCatalogue({ session: sessionCtx, cruiseType: "C", light: false, collectDiagnostics }),
    fetchPrincessReferenceData(sessionCtx)
  ]);

  if (!catalogue.ok) {
    const source_diagnostics = buildPrincessSourceDiagnosticsEnvelope({
      session: { ...session, client_id_source: sessionCtx.client_id_source },
      catalogue,
      extra: { fetch_failed: true }
    });
    return {
      ok: false,
      fetch_failed: true,
      error: catalogue.error,
      error_detail: catalogue.error_detail || null,
      products: [],
      session: sanitizeSessionFingerprint(sessionCtx),
      source_diagnostics
    };
  }

  const itineraryNamesById = catalogueNames.ok
    ? buildPrincessItineraryNameMap(catalogueNames.products)
    : new Map();

  const expanded = expandProductGroupsToRawSailings(catalogue.products, {
    shipsById: reference.shipsById,
    portsById: reference.portsById,
    itineraryNamesById,
    today,
    futureOnly: options.futureOnly !== false
  });

  const source_diagnostics = collectDiagnostics
    ? buildPrincessSourceDiagnosticsEnvelope({
        session: { ...session, client_id_source: sessionCtx.client_id_source },
        catalogue
      })
    : catalogue.diagnostics?.transient_retry === true
      ? {
          catalogue: {
            stage: "catalogue",
            transient_retry: true,
            control_attempts: catalogue.diagnostics.control_attempts ?? null
          }
        }
      : null;

  return {
    ok: true,
    fetch_failed: false,
    session: sessionCtx,
    num_found_official: catalogue.raw_count,
    raw_group_count: catalogue.raw_count,
    itinerary_name_count: itineraryNamesById.size,
    itinerary_names_fetch_failed: !catalogueNames.ok,
    reference,
    source_diagnostics,
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
  resolvePclClientIdDetailed,
  bootstrapPrincessSession,
  fetchPrincessResdbCatalogue,
  fetchPrincessReferenceData,
  buildPrincessItineraryNameMap,
  isPrincessVoyageCode,
  expandProductGroupsToRawSailings,
  fetchAllPrincessRawSailings,
  discoverOfficialVoyageUrls,
  normalisePrincessVoyage,
  probePrincessInventory,
  summarisePrincessProducts,
  sanitizeResponseHeaders,
  sanitizeBodyExcerpt,
  sanitizeSessionFingerprint,
  buildPrincessSourceDiagnosticsEnvelope,
  formatPrincessHttpError,
  isPrincessTransientMissingParamsError,
  __setPrincessTransportGetForTests: (fn) => {
    transportGetOverride = fn;
  },
  __resetPrincessTransportGetForTests: () => {
    transportGetOverride = null;
  },
  __getPrincessTransportGetOverride: () => transportGetOverride
};
