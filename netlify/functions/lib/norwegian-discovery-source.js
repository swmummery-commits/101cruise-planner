/**
 * Norwegian Cruise Line — official browse catalogue source (read-only).
 *
 * GET https://www.ncl.com/au/en/api/browse/v1/itineraries
 * GET https://www.ncl.com/au/en/api/browse/v1/filters
 */

const ADAPTER_ID = "norwegian";
const ADAPTER_VERSION = "2026-08-13.ncl1";
const USER_AGENT = "101cruise-discovery/1.0 (+https://101cruise.com.au)";
const LOCALE_PREFIX = "/au/en";
const SITE_ORIGIN = "https://www.ncl.com";

const SOURCE_CONTRACT = {
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  primary_endpoint: `${SITE_ORIGIN}${LOCALE_PREFIX}/api/browse/v1/itineraries`,
  filters_endpoint: `${SITE_ORIGIN}${LOCALE_PREFIX}/api/browse/v1/filters`,
  itinerary_schedule_url_formula:
    `${SITE_ORIGIN}${LOCALE_PREFIX}/cruises/{ITINERARY_CODE}/schedule?itineraryCode={ITINERARY_CODE}`,
  method: "GET",
  locale: "au/en (pinned — do not rely on geo redirect alone)",
  authentication_required: false,
  cookies_required: false,
  response_format: "JSON array of itinerary records with sailingDates[]",
  official_identity_formula: "{itineraryCode}|{YYYY-MM-DD}",
  pagination: "None — full catalogue returned in one response",
  public_website_intended: true
};

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normaliseIsoDate(raw) {
  const s = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function epochMsToIso(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ms = n > 10_000_000_000 ? n : n * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function parseSailingDateEntry(entry) {
  if (entry == null) return { departure_date: null, return_date: null, raw: entry };
  if (typeof entry === "string" && /^\d{4}-\d{2}-\d{2}/.test(entry.trim())) {
    return { departure_date: entry.trim().slice(0, 10), return_date: null, raw: entry };
  }
  if (typeof entry === "number" || (typeof entry === "string" && /^\d+$/.test(String(entry).trim()))) {
    const departure_date = epochMsToIso(entry);
    return { departure_date, return_date: null, raw: entry };
  }
  if (typeof entry === "object") {
    return {
      departure_date: epochMsToIso(entry.start ?? entry.departureDate ?? entry.sailStartDate),
      return_date: epochMsToIso(entry.end ?? entry.returnDate ?? entry.sailEndDate),
      raw: entry
    };
  }
  return { departure_date: null, return_date: null, raw: entry };
}

function itineraryCodeFromRecord(record) {
  const codes = Array.isArray(record?.codes) ? record.codes : [];
  return String(codes[0] || record?.itineraryCode || record?.itinerary_code || "").trim().toUpperCase() || null;
}

function officialProductKey(itineraryCode, departureDate) {
  const code = String(itineraryCode || "").trim().toUpperCase();
  const dep = normaliseIsoDate(departureDate);
  if (!code || !dep) return null;
  return `${code}|${dep}`;
}

function buildScheduleUrl(itineraryCode) {
  const code = String(itineraryCode || "").trim();
  if (!code) return null;
  return `${SITE_ORIGIN}${LOCALE_PREFIX}/cruises/${encodeURIComponent(code)}/schedule?itineraryCode=${encodeURIComponent(code)}`;
}

async function fetchJson(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
    attempts = 2
  } = options;

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer =
      controller && timeoutMs
        ? setTimeout(() => {
            controller.abort();
          }, timeoutMs)
        : null;

    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": USER_AGENT,
          Referer: `${SITE_ORIGIN}${LOCALE_PREFIX}/vacations`,
          ...headers
        },
        signal: controller?.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      const text = await response.text();
      if (text.length > maxBytes) {
        throw new Error(`Response too large (${text.length} bytes) for ${url}`);
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new Error(`Invalid JSON from ${url}: ${error.message}`);
      }

      return {
        ok: true,
        url,
        status: response.status,
        bytes: text.length,
        payload,
        fetched_at: new Date().toISOString()
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(400 * attempt);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}

async function fetchNorwegianBrowseCatalogue(options = {}) {
  const result = await fetchJson(SOURCE_CONTRACT.primary_endpoint, options);
  if (!Array.isArray(result.payload)) {
    throw new Error("Expected browse itineraries payload to be a JSON array");
  }
  return {
    ...result,
    records: result.payload,
    record_count: result.payload.length
  };
}

async function fetchNorwegianFilters(options = {}) {
  const result = await fetchJson(SOURCE_CONTRACT.filters_endpoint, options);
  if (!result.payload || typeof result.payload !== "object" || Array.isArray(result.payload)) {
    throw new Error("Expected browse filters payload to be a JSON object");
  }
  return {
    ...result,
    filters: result.payload
  };
}

const NCL_ITINERARY_SHIP_CODES = Object.freeze([
  "PRIDE_AMER",
  "BREAKAWAY",
  "GETAWAY",
  "ESCAPE",
  "ENCORE",
  "SPIRIT",
  "BLISS",
  "PRIMA",
  "PEARL",
  "JEWEL",
  "DAWN",
  "EPIC",
  "AQUA",
  "AURA",
  "GEM",
  "JADE",
  "JOY",
  "LUNA",
  "SKY",
  "STAR",
  "SUN",
  "VIVA"
]);

function addIsoDays(iso, days) {
  const [year, month, day] = String(iso || "").split("-").map(Number);
  if (!year || !month || !day || !Number.isFinite(Number(days))) return null;
  return new Date(Date.UTC(year, month - 1, day + Number(days))).toISOString().slice(0, 10);
}

function inferNorwegianShipCodeFromItinerary(itineraryCode) {
  const code = String(itineraryCode || "").trim().toUpperCase();
  if (!code) return null;
  return (
    [...NCL_ITINERARY_SHIP_CODES]
      .sort((a, b) => b.length - a.length)
      .find((ship) => code === ship || (code.startsWith(ship) && /[0-9_]/.test(code[ship.length] || ""))) || null
  );
}

function inferNorwegianNightsFromItinerary(itineraryCode, shipCode) {
  const code = String(itineraryCode || "").toUpperCase();
  const ship = String(shipCode || inferNorwegianShipCodeFromItinerary(code) || "");
  if (!ship || !code.startsWith(ship)) return null;
  const match = code.slice(ship.length).match(/^(\d+)/);
  const nights = match ? Number(match[1]) : null;
  return Number.isFinite(nights) && nights > 0 ? nights : null;
}

function expandItineraryRecord(record) {
  const itineraryCode = itineraryCodeFromRecord(record);
  const shipCode =
    String(record?.shipCode || "").trim().toUpperCase() ||
    inferNorwegianShipCodeFromItinerary(itineraryCode) ||
    null;
  const duration = Number(record?.duration) || inferNorwegianNightsFromItinerary(itineraryCode, shipCode) || null;
  const sailingDates = Array.isArray(record?.sailingDates) ? record.sailingDates : [];
  const expanded = [];

  for (const entry of sailingDates) {
    const parsed = parseSailingDateEntry(entry);
    const returnDate =
      parsed.return_date ||
      (parsed.departure_date && duration != null ? addIsoDays(parsed.departure_date, duration) : null);
    expanded.push({
      itinerary_code: itineraryCode,
      ship_code: shipCode,
      duration,
      port_of_departure_code: String(record?.portOfDepartureCode || "").trim().toUpperCase() || null,
      destination_codes: Array.isArray(record?.destinationCodes)
        ? record.destinationCodes.map((d) => String(d).trim().toUpperCase()).filter(Boolean)
        : [],
      departure_date: parsed.departure_date,
      return_date: returnDate,
      official_product_key: officialProductKey(itineraryCode, parsed.departure_date),
      schedule_url: buildScheduleUrl(itineraryCode),
      raw_itinerary: record,
      raw_sailing_date: parsed.raw
    });
  }

  return expanded;
}

function expandBrowseCatalogue(records) {
  const itineraries = Array.isArray(records) ? records : [];
  const sailings = [];
  for (const record of itineraries) {
    sailings.push(...expandItineraryRecord(record));
  }
  return { itineraries, sailings };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  USER_AGENT,
  LOCALE_PREFIX,
  SITE_ORIGIN,
  normaliseIsoDate,
  epochMsToIso,
  parseSailingDateEntry,
  itineraryCodeFromRecord,
  officialProductKey,
  buildScheduleUrl,
  fetchNorwegianBrowseCatalogue,
  fetchNorwegianFilters,
  expandItineraryRecord,
  expandBrowseCatalogue,
  inferNorwegianShipCodeFromItinerary,
  inferNorwegianNightsFromItinerary
};
