/**
 * Silversea Cruises — official Gatsby structured catalogue source.
 *
 * Primary (public, unauthenticated):
 *   GET https://www.silversea.com/page-data/cruise-catalog.html/page-data.json
 * Detail:
 *   GET https://www.silversea.com/page-data{fullPath}/page-data.json
 *
 * Official sailing identity: cruiseCode / Voyage Number, e.g. MO271210C26.
 * This module cannot write to the database.
 */

const ADAPTER_ID = "silversea";
const ADAPTER_VERSION = "2026-08-15.silversea1";
const USER_AGENT = "101cruise-discovery/1.0 (+https://101cruise.com.au)";
const SITE_ORIGIN = "https://www.silversea.com";
const CATALOGUE_PATH = "/page-data/cruise-catalog.html/page-data.json";
const CATALOGUE_URL = `${SITE_ORIGIN}${CATALOGUE_PATH}`;

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_REQUEST_DELAY_MS = 75;
const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_MAX_ATTEMPTS = 3;
const CATALOGUE_MAX_BYTES = 4_000_000;
const DETAIL_MAX_BYTES = 2_000_000;
const SOURCE_HEALTH_MIN_CRUISES = 200;
const SOURCE_HEALTH_MIN_UNIQUE_RATIO = 0.99;
const SOURCE_HEALTH_MIN_FIELD_RATIO = 0.95;

const SOURCE_CONTRACT = {
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  cruise_line: "Silversea Cruises",
  primary_endpoint: CATALOGUE_URL,
  detail_endpoint_formula: "https://www.silversea.com/page-data{fullPath}/page-data.json",
  method: "GET",
  authentication_required: false,
  cookies_required: false,
  pagination: "none — single Gatsby catalogue payload",
  official_identity_formula: "cruiseCode",
  official_identity_source: "result.data.cruises.nodes[].cruiseCode",
  official_url_formula: "https://www.silversea.com{fullPath}",
  response_format: "Gatsby page-data JSON",
  writes: false
};

/**
 * Observed cruiseCode ship prefixes from the official catalogue.
 * Informational only — ship identity is the canonical ship name, not the prefix.
 */
const OBSERVED_SHIP_PREFIXES = Object.freeze({
  RA: "Silver Ray",
  WI: "Silver Wind",
  SL: "Silver Spirit",
  SN: "Silver Nova",
  SS: "Silver Shadow",
  DA: "Silver Dawn",
  E4: "Silver Cloud",
  WH: "Silver Whisper",
  MO: "Silver Moon",
  SM: "Silver Muse",
  OR: "Silver Origin",
  EV: "Silver Endeavour"
});

const CRUISE_CODE_RE = /^([A-Z0-9]{2})(\d{6})([SC]?)(\d{2,3})$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normaliseIsoDate(raw) {
  const s = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return null;
}

function addDaysIso(isoDate, days) {
  const [y, m, d] = String(isoDate || "")
    .slice(0, 10)
    .split("-")
    .map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
  return dt.toISOString().slice(0, 10);
}

function nightsBetweenIso(startIso, endIso) {
  const start = normaliseIsoDate(startIso);
  const end = normaliseIsoDate(endIso);
  if (!start || !end) return null;
  const diff = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
  if (!Number.isFinite(diff)) return null;
  return Math.round(diff);
}

function trimShipName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function localizedName(node) {
  if (!node) return null;
  if (typeof node === "string") return trimShipName(node) || null;
  const name = node.name;
  if (typeof name === "string") return trimShipName(name) || null;
  if (name && typeof name === "object") {
    return trimShipName(name.localized || name.en || "") || null;
  }
  return trimShipName(node.localized || node.en || "") || null;
}

function parseCruiseCode(raw) {
  const cruise_code = String(raw || "").trim().toUpperCase();
  if (!cruise_code) return { valid: false, reason: "missing_cruise_code", cruise_code: null };
  const match = cruise_code.match(CRUISE_CODE_RE);
  if (!match) return { valid: false, reason: "unparseable_cruise_code", cruise_code };
  const yearToken = Number(match[2].slice(0, 2));
  const year = yearToken >= 70 ? 1900 + yearToken : 2000 + yearToken;
  const month = match[2].slice(2, 4);
  const day = match[2].slice(4, 6);
  const departure_date_from_code = `${year}-${month}-${day}`;
  const validDate = normaliseIsoDate(departure_date_from_code) === departure_date_from_code;
  const suffixKind = match[3] === "C" ? "combination" : match[3] === "S" ? "segment" : "numeric";
  return {
    valid: true,
    cruise_code,
    ship_prefix: match[1],
    date_token: match[2],
    suffix_kind: suffixKind,
    suffix_number: Number(match[4]),
    departure_date_from_code: validDate ? departure_date_from_code : null,
    observed_ship_name: OBSERVED_SHIP_PREFIXES[match[1]] || null
  };
}

function officialProductKey(raw) {
  const direct = raw?.official_sailing_id || raw?.cruise_code || raw?.cruiseCode;
  if (direct) {
    const parsed = parseCruiseCode(direct);
    return parsed.valid ? parsed.cruise_code : String(direct).trim().toUpperCase() || null;
  }
  if (raw?.official_url || raw?.full_path) {
    return cruiseCodeFromPath(raw.official_url || raw.full_path);
  }
  return null;
}

function cruiseCodeFromPath(value) {
  const text = String(value || "");
  const match = text.match(/-([a-z0-9]{2}\d{6}[sc]?\d{2,3})(?:\.html)?(?:[/?#]|$)/i);
  if (!match) return null;
  const parsed = parseCruiseCode(match[1]);
  return parsed.valid ? parsed.cruise_code : null;
}

function buildOfficialUrl(fullPath) {
  const path = String(fullPath || "").trim();
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${SITE_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildDetailUrl(fullPath) {
  const path = String(fullPath || "").trim();
  if (!path) return null;
  const normalised = path.startsWith("/") ? path : `/${path}`;
  return `${SITE_ORIGIN}/page-data${normalised}/page-data.json`;
}

function classifyCodeKind(parsed) {
  if (!parsed?.valid) return "invalid";
  return parsed.suffix_kind;
}

function classifyItineraryStopKind(portName) {
  const name = String(portName || "").trim();
  if (!name) return "unknown";
  if (/^(day at sea|at sea|sea day)$/i.test(name)) return "sea";
  if (/^cruis(e|ing)\b/i.test(name) || /\bcruising\b/i.test(name)) return "scenic";
  return "port";
}

function parseCatalogueNode(node, { collection = "cruises" } = {}) {
  const parsedCode = parseCruiseCode(node?.cruiseCode);
  const data = node?.data || {};
  const departure_date = normaliseIsoDate(data.departureDate);
  const return_date = normaliseIsoDate(data.arrivalDate);
  const source_duration = Number.isFinite(Number(data.days)) ? Number(data.days) : null;
  const calculated_nights = nightsBetweenIso(departure_date, return_date);
  const ship_name = trimShipName(data.ship?.name);
  const full_path = String(node?.fullPath || "").trim() || null;
  const combo_type = data.comboType || null;
  const deferred = collection === "specialVoyages" || Boolean(combo_type);

  return {
    source: "silversea_gatsby_catalogue",
    structured_source: "silversea_gatsby",
    collection,
    deferred_special_voyage: deferred,
    deferred_reason: deferred ? "deferred_special_voyage" : null,
    combo_type,
    cruise_code: parsedCode.cruise_code,
    official_sailing_id: parsedCode.valid ? parsedCode.cruise_code : null,
    cruise_code_valid: parsedCode.valid,
    cruise_code_reason: parsedCode.valid ? null : parsedCode.reason,
    code_kind: classifyCodeKind(parsedCode),
    ship_prefix: parsedCode.ship_prefix || null,
    ship_name: ship_name || null,
    departure_date,
    return_date,
    source_duration,
    calculated_nights,
    duration_matches_dates:
      source_duration != null && calculated_nights != null ? source_duration === calculated_nights : null,
    destination_name: localizedName(data.destination),
    departure_port: localizedName(data.departurePort),
    arrival_port: localizedName(data.arrivalPort),
    departure_port_code: data.departurePort?.data?.code || null,
    arrival_port_code: data.arrivalPort?.data?.code || null,
    full_path,
    official_url: buildOfficialUrl(full_path),
    detail_url: buildDetailUrl(full_path),
    cruise_type: data.cruiseType || null,
    itinerary: [],
    detail_enriched: false,
    detail_error: null
  };
}

function parseItineraryStops(itinerary) {
  if (!Array.isArray(itinerary)) return [];
  return itinerary.map((stop, index) => {
    const port_name = localizedName(stop?.port) || localizedName(stop) || null;
    const kind = classifyItineraryStopKind(port_name);
    return {
      sequence: index + 1,
      day_number: Number.isFinite(Number(stop?.dayNumber)) ? Number(stop.dayNumber) : null,
      date: normaliseIsoDate(stop?.date),
      port_name,
      port_code: stop?.port?.data?.code || stop?.port?.code || null,
      arrival_time: stop?.arrivalTime || null,
      departure_time: stop?.departureTime || null,
      overnight: Boolean(stop?.isOvernight),
      kind
    };
  });
}

function applyVoyageDetail(raw, detailCruise) {
  const data = detailCruise?.data || {};
  const next = { ...raw };
  next.structured_source = "silversea_gatsby_voyage";
  next.detail_enriched = true;
  next.detail_error = null;
  next.cruise_type = data.cruiseType || next.cruise_type;
  next.cruise_group = data.cruiseGroup || null;
  next.destination_id_source = data.destination?.destinationId ?? null;
  next.destination_web_code = data.destination?.destinationWebCode || null;
  next.departure_port_code = data.departurePort?.data?.code || next.departure_port_code;
  next.arrival_port_code = data.arrivalPort?.data?.code || next.arrival_port_code;
  next.departure_port = localizedName(data.departurePort) || next.departure_port;
  next.arrival_port = localizedName(data.arrivalPort) || next.arrival_port;
  next.destination_name = localizedName(data.destination) || next.destination_name;
  next.ship_name = trimShipName(data.ship?.name) || next.ship_name;
  if (data.departureDate) next.departure_date = normaliseIsoDate(data.departureDate) || next.departure_date;
  if (data.arrivalDate) next.return_date = normaliseIsoDate(data.arrivalDate) || next.return_date;
  if (Number.isFinite(Number(data.days))) next.source_duration = Number(data.days);
  next.calculated_nights = nightsBetweenIso(next.departure_date, next.return_date);
  next.duration_matches_dates =
    next.source_duration != null && next.calculated_nights != null
      ? next.source_duration === next.calculated_nights
      : null;
  next.itinerary = parseItineraryStops(data.itinerary);
  next.pre_hotel_count = Array.isArray(data.preHotel) ? data.preHotel.length : data.preHotel ? 1 : 0;
  next.post_hotel_count = Array.isArray(data.postHotel) ? data.postHotel.length : data.postHotel ? 1 : 0;
  next.pre_land_count = Array.isArray(data.preLandProgrammes) ? data.preLandProgrammes.length : 0;
  next.post_land_count = Array.isArray(data.postLandProgrammes) ? data.postLandProgrammes.length : 0;
  return next;
}

function parseCataloguePayload(payload) {
  const cruises = payload?.result?.data?.cruises?.nodes;
  const specialGroups = payload?.result?.data?.specialVoyages?.group;
  if (!Array.isArray(cruises)) {
    return {
      ok: false,
      error: "catalogue_missing_cruise_nodes",
      products: [],
      special_voyages: [],
      audit: { raw_nodes: 0 }
    };
  }

  const products = [];
  const seen = new Set();
  let duplicate_codes = 0;
  let invalid_codes = 0;
  for (const node of cruises) {
    const raw = parseCatalogueNode(node, { collection: "cruises" });
    if (!raw.cruise_code_valid) {
      invalid_codes += 1;
      products.push(raw);
      continue;
    }
    if (seen.has(raw.cruise_code)) {
      duplicate_codes += 1;
      continue;
    }
    seen.add(raw.cruise_code);
    products.push(raw);
  }

  const special_voyages = [];
  for (const group of specialGroups || []) {
    for (const node of group?.nodes || []) {
      const raw = parseCatalogueNode(
        { ...node, data: { ...(node.data || {}), comboType: node.data?.comboType || group.fieldValue } },
        { collection: "specialVoyages" }
      );
      special_voyages.push(raw);
    }
  }

  return {
    ok: true,
    products,
    special_voyages,
    audit: {
      raw_nodes: cruises.length,
      parsed: products.length,
      unique_codes: seen.size,
      duplicate_codes,
      invalid_codes,
      special_voyage_nodes: special_voyages.length
    }
  };
}

function assessCatalogueHealth(payload, parsed) {
  const failures = [];
  if (!payload || typeof payload !== "object") failures.push("catalogue_not_object");
  if (!parsed?.ok) failures.push(parsed?.error || "catalogue_parse_failed");
  const nodes = payload?.result?.data?.cruises?.nodes;
  if (!Array.isArray(nodes)) failures.push("cruise_nodes_missing");
  const count = Array.isArray(nodes) ? nodes.length : 0;
  if (count < SOURCE_HEALTH_MIN_CRUISES) failures.push("catalogue_count_below_minimum");
  const unique = parsed?.audit?.unique_codes || 0;
  const uniqueRatio = count ? unique / count : 0;
  if (count && uniqueRatio < SOURCE_HEALTH_MIN_UNIQUE_RATIO) failures.push("cruise_code_uniqueness_below_minimum");

  const products = parsed?.products || [];
  const fieldHits = {
    cruise_code: 0,
    ship_name: 0,
    departure_date: 0,
    return_date: 0,
    source_duration: 0,
    departure_port: 0,
    arrival_port: 0,
    destination_name: 0,
    full_path: 0
  };
  for (const raw of products) {
    if (raw.cruise_code) fieldHits.cruise_code += 1;
    if (raw.ship_name) fieldHits.ship_name += 1;
    if (raw.departure_date) fieldHits.departure_date += 1;
    if (raw.return_date) fieldHits.return_date += 1;
    if (raw.source_duration != null) fieldHits.source_duration += 1;
    if (raw.departure_port) fieldHits.departure_port += 1;
    if (raw.arrival_port) fieldHits.arrival_port += 1;
    if (raw.destination_name) fieldHits.destination_name += 1;
    if (raw.full_path) fieldHits.full_path += 1;
  }
  const denom = products.length || 1;
  for (const [field, hits] of Object.entries(fieldHits)) {
    if (hits / denom < SOURCE_HEALTH_MIN_FIELD_RATIO) failures.push(`required_field_sparse:${field}`);
  }

  return {
    ok: failures.length === 0,
    failures,
    catalogue_count: count,
    unique_cruise_codes: unique,
    unique_ratio: uniqueRatio,
    field_coverage: Object.fromEntries(
      Object.entries(fieldHits).map(([k, v]) => [k, Number((v / denom).toFixed(4))])
    ),
    thresholds: {
      min_cruises: SOURCE_HEALTH_MIN_CRUISES,
      min_unique_ratio: SOURCE_HEALTH_MIN_UNIQUE_RATIO,
      min_field_ratio: SOURCE_HEALTH_MIN_FIELD_RATIO
    }
  };
}

async function defaultTransport(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DETAIL_MAX_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": USER_AGENT
      },
      signal: controller.signal
    });
    const buf = Buffer.from(await response.arrayBuffer());
    const truncated = buf.length > maxBytes;
    const text = buf.subarray(0, Math.min(buf.length, maxBytes)).toString("utf8");
    return {
      ok: response.ok,
      status: response.status,
      text,
      truncated
    };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    throw new Error(aborted ? "silversea_source_timeout" : error.message || String(error));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, options = {}) {
  const attempts = Math.max(1, Number(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const transport = options.transport || defaultTransport;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(400 * attempt);
    try {
      const result = await transport(url, options);
      if (result.ok) return { ...result, attempts: attempt + 1 };
      lastError = result.error || `http_${result.status}`;
      if (result.status && result.status < 500 && result.status !== 429) {
        return { ...result, error: lastError, attempts: attempt + 1 };
      }
    } catch (error) {
      lastError = error.message || String(error);
    }
  }
  return { ok: false, status: 0, text: "", error: lastError || "fetch_failed", attempts };
}

async function mapWithConcurrency(items, limit, delayMs, worker) {
  const size = Math.max(1, Number(limit) || 1);
  const pause = Math.max(0, Number(delayMs) || 0);
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      if (pause && index > 0) await sleep(pause);
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length || 1) }, run));
  return results;
}

function parseJsonSafe(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error.message || "invalid_json" };
  }
}

async function fetchSilverseaCatalogue(options = {}) {
  const url = options.catalogueUrl || CATALOGUE_URL;
  const response = await fetchWithRetry(url, {
    ...options,
    maxBytes: options.maxBytes || CATALOGUE_MAX_BYTES
  });
  if (!response.ok) {
    return {
      ok: false,
      error: response.error || `catalogue_http_${response.status}`,
      products: [],
      special_voyages: [],
      health: { ok: false, failures: ["catalogue_http_failed"] },
      audit: { catalogue_url: url }
    };
  }
  const json = parseJsonSafe(response.text);
  if (!json.ok) {
    return {
      ok: false,
      error: "catalogue_invalid_json",
      products: [],
      special_voyages: [],
      health: { ok: false, failures: ["catalogue_invalid_json"] },
      audit: { catalogue_url: url }
    };
  }
  const parsed = parseCataloguePayload(json.value);
  const health = assessCatalogueHealth(json.value, parsed);
  return {
    ok: parsed.ok && health.ok,
    error: parsed.ok ? (health.ok ? null : "catalogue_health_failed") : parsed.error,
    products: parsed.products || [],
    special_voyages: parsed.special_voyages || [],
    health,
    audit: { catalogue_url: url, ...(parsed.audit || {}) }
  };
}

async function fetchSilverseaVoyageDetail(raw, options = {}) {
  const url = raw?.detail_url || buildDetailUrl(raw?.full_path);
  if (!url) {
    return { ok: false, error: "missing_detail_url", raw: { ...raw, detail_error: "missing_detail_url" } };
  }
  const response = await fetchWithRetry(url, {
    ...options,
    maxBytes: options.maxBytes || DETAIL_MAX_BYTES
  });
  if (!response.ok) {
    return {
      ok: false,
      error: response.error || `detail_http_${response.status}`,
      raw: { ...raw, detail_error: response.error || `detail_http_${response.status}` }
    };
  }
  const json = parseJsonSafe(response.text);
  if (!json.ok) {
    return { ok: false, error: "detail_invalid_json", raw: { ...raw, detail_error: "detail_invalid_json" } };
  }
  const cruise = json.value?.result?.data?.cruise;
  if (!cruise?.data) {
    return { ok: false, error: "detail_missing_cruise", raw: { ...raw, detail_error: "detail_missing_cruise" } };
  }
  return { ok: true, raw: applyVoyageDetail(raw, cruise) };
}

function durationMismatches(products) {
  return (products || [])
    .filter((p) => p.duration_matches_dates === false)
    .map((p) => ({
      cruise_code: p.cruise_code,
      departure_date: p.departure_date,
      arrival_date: p.return_date,
      source_duration: p.source_duration,
      calculated_nights: p.calculated_nights,
      cruise_type: p.cruise_type,
      code_kind: p.code_kind,
      itinerary_stops: p.itinerary?.length || 0,
      collection: p.collection
    }));
}

async function fetchAllSilverseaRawVoyages(options = {}) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const enrich = options.enrich !== false;
  const concurrency = Number(options.concurrency) || DEFAULT_CONCURRENCY;
  const delayMs = options.requestDelayMs != null ? Number(options.requestDelayMs) : DEFAULT_REQUEST_DELAY_MS;
  const maxVoyages = Number(options.maxVoyages) || null;

  const catalogue = await fetchSilverseaCatalogue(options);
  if (!catalogue.ok && !(options.allowUnhealthy && catalogue.products?.length)) {
    return {
      ok: false,
      fetch_failed: true,
      error: catalogue.error,
      products: [],
      special_voyages: catalogue.special_voyages || [],
      num_found_official: 0,
      health: catalogue.health,
      audit: catalogue.audit,
      source_contract: SOURCE_CONTRACT
    };
  }

  let products = [...(catalogue.products || [])].sort((a, b) =>
    String(a.cruise_code || "").localeCompare(String(b.cruise_code || ""))
  );
  if (maxVoyages) products = products.slice(0, maxVoyages);

  let detail_ok = 0;
  let detail_failed = 0;
  if (enrich) {
    const enriched = await mapWithConcurrency(products, concurrency, delayMs, async (raw) => {
      if (!raw.cruise_code_valid || !raw.detail_url) return raw;
      const result = await fetchSilverseaVoyageDetail(raw, options);
      if (result.ok) {
        detail_ok += 1;
        return result.raw;
      }
      detail_failed += 1;
      return result.raw;
    });
    products = enriched;
  }

  return {
    ok: true,
    fetch_failed: false,
    products,
    special_voyages: catalogue.special_voyages || [],
    num_found_official: catalogue.audit?.raw_nodes || products.length,
    raw_voyage_count: products.length,
    health: catalogue.health,
    audit: {
      ...(catalogue.audit || {}),
      today,
      detail_enriched: enrich,
      detail_ok,
      detail_failed,
      duration_mismatches: durationMismatches(products)
    },
    source_contract: SOURCE_CONTRACT
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  USER_AGENT,
  CATALOGUE_URL,
  SITE_ORIGIN,
  OBSERVED_SHIP_PREFIXES,
  SOURCE_HEALTH_MIN_CRUISES,
  parseCruiseCode,
  officialProductKey,
  cruiseCodeFromPath,
  buildOfficialUrl,
  buildDetailUrl,
  trimShipName,
  normaliseIsoDate,
  addDaysIso,
  nightsBetweenIso,
  parseCatalogueNode,
  parseCataloguePayload,
  parseItineraryStops,
  applyVoyageDetail,
  assessCatalogueHealth,
  classifyItineraryStopKind,
  durationMismatches,
  fetchSilverseaCatalogue,
  fetchSilverseaVoyageDetail,
  fetchAllSilverseaRawVoyages
};
