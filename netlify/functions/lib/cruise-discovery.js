/**
 * Cruise Discovery Engine — extract → normalise → match → validate.
 * Official cruise-line sources only. Never invent itineraries, prices, or sailing dates.
 *
 * Sprint 11D.1: normalisation stage + review-queue noise reduction.
 */

const crypto = require("crypto");
const { braveSearch, getBraveApiKey } = require("./brave-search");
const { fetchSourceExcerpt } = require("./source-fetch");
const { scoreSailingUrl, buildBraveSailingQueries } = require("./cruise-discovery-url-score");
const {
  extractStructuredSailingSources,
  structuredExcerptHint,
  extractSitemapLocs
} = require("./cruise-discovery-structured");
const { resolveAdapter } = require("./cruise-discovery-adapters");
const {
  applyDepartureResolutionToCandidate,
  validateDepartureForCandidate,
  resolveDepartureFromSource,
  legacyExtractDeparturePort
} = require("./discovery-departure-port");
const {
  classifyNonSailingSource,
  slugTokenRejected,
  guessLooksNonSailing,
  provesIndividualSailing
} = require("./discovery-non-sailing-filter");
const { classificationDestinations } = require("./destination-classification");
const {
  evaluateIngestionAutomation,
  ACTION: AUTOMATION_ACTION
} = require("./discovery-auto-resolver");
const { shouldSkipUrlBeforeFetch, canonicalDiscoveryUrl } = require("./discovery-source-memory");
const {
  isCrystalCruisesLine,
  parseCrystalVoyageFromUrl,
  extractCrystalTitleShip,
  resolveCrystalShipEvidence,
  crystalShipConflictBlocksActivation
} = require("./discovery-crystal-ship");

const MONTHS = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
};

const GENERIC_TOKENS = new Set([
  "cruise",
  "cruises",
  "ship",
  "ships",
  "fleet",
  "voyage",
  "sailing",
  "itinerary",
  "book",
  "deals",
  "offer",
  "offers",
  "explore",
  "discover",
  "about",
  "home",
  "menu",
  "contact",
  "privacy",
  "cookie",
  "the",
  "and",
  "our",
  "your",
  "from",
  "with"
]);

function normaliseName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ship-oriented normalisation (MS/MV prefixes, trailing "ship"/"cruise"). */
function normaliseShipName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^(ms|mv|ss|rms)\s+/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(ship|cruise|cruises)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hostnameOf(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isSameSite(url, officialHostname) {
  const host = hostnameOf(url);
  if (!host || !officialHostname) return false;
  return host === officialHostname || host.endsWith(`.${officialHostname}`);
}

function canonicalUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    u.hash = "";
    // Drop common tracking params; keep path identity.
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"].forEach(
      (k) => u.searchParams.delete(k)
    );
    let path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}${u.search}`.toLowerCase();
  } catch {
    return String(url || "")
      .trim()
      .toLowerCase()
      .replace(/\/$/, "");
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoFromParts(year, monthIndex, day) {
  if (monthIndex == null || !year || !day) return null;
  if (day < 1 || day > 31 || monthIndex < 0 || monthIndex > 11) return null;
  const dt = new Date(Date.UTC(year, monthIndex, day));
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== monthIndex || dt.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

function parseFlexibleDate(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const iso = raw.match(/\b(20\d{2})-(\d{2})-(\d{2})(?:[T\s]|$)/);
  if (iso) return isoFromParts(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const dmy = raw.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i
  );
  if (dmy) {
    const month = MONTHS[dmy[2].toLowerCase().slice(0, 3)] ?? MONTHS[dmy[2].toLowerCase()];
    return isoFromParts(Number(dmy[3]), month, Number(dmy[1]));
  }

  const mdy = raw.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i
  );
  if (mdy) {
    const month = MONTHS[mdy[1].toLowerCase().slice(0, 3)] ?? MONTHS[mdy[1].toLowerCase()];
    return isoFromParts(Number(mdy[3]), month, Number(mdy[2]));
  }

  // AU-preferred numeric: DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const numeric = raw.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](20\d{2})\b/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = Number(numeric[3]);
    if (a > 12) return isoFromParts(year, b - 1, a); // DD/MM
    if (b > 12) return isoFromParts(year, a - 1, b); // MM/DD
    // Ambiguous → prefer AU DD/MM
    return isoFromParts(year, b - 1, a);
  }

  return null;
}

/** Collect the first plausible departure date from text (does not invent). */
function extractDepartureDate(text) {
  const raw = String(text || "");
  const labelled = raw.match(
    /\b(?:depart(?:s|ure|ing)?|sail(?:s|ing)?|leaves|from)\b[^.\n]{0,40}?((?:20\d{2}-\d{2}-\d{2})|(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2})|(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2})|(?:\d{1,2}[\/.\-]\d{1,2}[\/.\-]20\d{2}))/i
  );
  if (labelled) {
    const parsed = parseFlexibleDate(labelled[1]);
    if (parsed) return parsed;
  }
  return parseFlexibleDate(raw);
}

function extractNights(text) {
  const raw = String(text || "");
  const patterns = [
    /\b(\d{1,2})\s*[-–]?\s*nights?\b/i,
    /\b(\d{1,2})\s*[-–]?\s*day(?:s)?\s+cruise\b/i,
    /\b(\d{1,2})\s*nt\b/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    // "N day cruise" usually means N-1 nights; keep nights only for explicit night tokens.
    if (re.source.includes("day")) {
      const nights = n > 1 ? n - 1 : null;
      if (nights && nights < 100) return nights;
      continue;
    }
    if (n > 0 && n < 100) return n;
  }
  return null;
}

function extractFare(text) {
  const raw = String(text || "");
  const m = raw.match(
    /\b(?:from\s+)?((?:AUD|USD|EUR|GBP|CA\$|A\$|US\$|\$)\s*[\d,]+(?:\.\d{2})?)\b(?:\s*(?:pp|per\s*person))?/i
  );
  if (!m) return null;
  const display = m[0].replace(/\s+/g, " ").trim();
  const num = display.replace(/[^\d.]/g, "");
  const amount = num ? Number(num) : null;
  let currency = null;
  if (/AUD|A\$/i.test(display)) currency = "AUD";
  else if (/USD|US\$/i.test(display)) currency = "USD";
  else if (/EUR/i.test(display)) currency = "EUR";
  else if (/GBP/i.test(display)) currency = "GBP";
  else if (/\$/.test(display)) currency = "USD";
  return {
    brochure_fare_display: display,
    brochure_fare: Number.isFinite(amount) ? amount : null,
    currency
  };
}

function extractDeparturePort(text) {
  return legacyExtractDeparturePort(text);
}

function extractItinerary(text) {
  const blob = String(text || "");
  const itinMatch = blob.match(
    /([A-Z][A-Za-z .'-]{2,40}(?:\s*(?:→|->|–|-|to)\s*[A-Z][A-Za-z .'-]{2,40}){2,})/
  );
  if (!itinMatch) return null;
  return itinMatch[1].replace(/\s+/g, " ").trim().slice(0, 400);
}

function addDaysIso(isoDate, days) {
  if (!isoDate || !days) return null;
  const dt = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + Number(days));
  return dt.toISOString().slice(0, 10);
}

function shipAliasKeys(shipName, cruiseLineName) {
  const keys = new Set();
  const base = normaliseShipName(shipName);
  if (!base) return keys;
  keys.add(base);

  const line = normaliseShipName(cruiseLineName);
  if (line && base.startsWith(`${line} `)) {
    keys.add(base.slice(line.length).trim());
  }
  // Common brand prefixes in DB names
  for (const brand of [
    "celebrity",
    "royal caribbean",
    "princess",
    "holland america",
    "norwegian",
    "carnival",
    "msc",
    "cunard",
    "disney",
    "viking",
    "oceania",
    "regent",
    "seabourn",
    "silversea",
    "azamara",
    "virgin voyages",
    "p o",
    "po",
    "princess cruises"
  ]) {
    if (base.startsWith(`${brand} `)) keys.add(base.slice(brand.length).trim());
  }
  // "of the seas" ships sometimes appear without suffix in marketing
  if (base.endsWith(" of the seas")) {
    keys.add(base.replace(/ of the seas$/, "").trim());
  }
  // Strip trailing "cruises" from raw marketing names ("Brilliant Lady Cruises")
  if (base.endsWith(" cruises")) {
    keys.add(base.replace(/ cruises$/, "").trim());
  }
  return [...keys].filter((k) => {
    if (!k || GENERIC_TOKENS.has(k)) return false;
    const words = k.split(" ").filter(Boolean);
    if (words.length >= 2) return k.length >= 5;
    // Single-token aliases must be long enough to avoid "edge"/"joy" false matches
    return k.length >= 8;
  });
}

/** Dice coefficient on character bigrams (0–1). */
function diceCoefficient(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const bigrams = new Map();
  for (let i = 0; i < x.length - 1; i += 1) {
    const bg = x.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < y.length - 1; i += 1) {
    const bg = y.slice(i, i + 2);
    const count = bigrams.get(bg) || 0;
    if (count > 0) {
      overlap += 1;
      bigrams.set(bg, count - 1);
    }
  }
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

/**
 * Suggest a ship match for an unmatched raw name (does not auto-apply).
 * Returns confidence 0–100 or null if below minConfidence.
 */
function suggestShipMatch(rawName, ships, cruiseLineName = "", { minConfidence = 55 } = {}) {
  let needle = normaliseShipName(rawName);
  if (!needle || !ships?.length) return null;
  // Marketing often appends "Cruises" to the ship name
  if (needle.endsWith(" cruises")) needle = needle.replace(/ cruises$/, "").trim();
  const lineKey = normaliseShipName(cruiseLineName);
  if (lineKey && needle.startsWith(`${lineKey} `)) {
    needle = needle.slice(lineKey.length).trim();
  }
  if (!needle) return null;

  let best = null;
  for (const ship of ships) {
    const keys = shipAliasKeys(ship.name, cruiseLineName);
    // Always include full normalised DB name even if short-token filter dropped aliases
    const full = normaliseShipName(ship.name);
    if (full) keys.push(full);

    for (const key of keys) {
      if (!key) continue;
      let score = 0;
      if (key === needle) score = 100;
      else if (key.includes(needle) || needle.includes(key)) {
        const ratio = Math.min(key.length, needle.length) / Math.max(key.length, needle.length);
        score = Math.round(72 + ratio * 26);
      } else {
        score = Math.round(diceCoefficient(key, needle) * 100);
      }
      if (score > 100) score = 100;
      if (!best || score > best.confidence) {
        best = {
          ship_id: ship.id,
          ship_name: ship.name,
          confidence: score,
          normalised_raw: needle,
          normalised_db: key
        };
      }
    }
  }
  if (!best || best.confidence < minConfidence) return null;
  return best;
}

function suggestDestinationMatch(rawName, destinations, { minConfidence = 60 } = {}) {
  const needle = normaliseName(rawName);
  if (!needle || !destinations?.length) return null;
  let best = null;
  for (const dest of destinations) {
    const keys = [normaliseName(dest.name), normaliseName(dest.slug).replace(/-/g, " ")].filter(
      Boolean
    );
    for (const key of keys) {
      let score = 0;
      if (key === needle) score = 100;
      else if (key.includes(needle) || needle.includes(key)) {
        const ratio = Math.min(key.length, needle.length) / Math.max(key.length, needle.length);
        score = Math.round(70 + ratio * 28);
      } else {
        score = Math.round(diceCoefficient(key, needle) * 100);
      }
      if (!best || score > best.confidence) {
        best = {
          destination_id: dest.id,
          destination_name: dest.name,
          confidence: score,
          normalised_raw: needle
        };
      }
    }
  }
  if (!best || best.confidence < minConfidence) return null;
  return best;
}

function rawShipNameFromReviewItem(item) {
  const payload = item?.payload || {};
  if (payload.raw_ship_name) return String(payload.raw_ship_name).trim();
  const guesses = payload.diagnostics?.ship_name_guesses;
  if (Array.isArray(guesses) && guesses[0]) return String(guesses[0]).trim();
  const title = String(item?.title || "");
  // "Virgin Voyages: Brilliant Lady Cruises — no date"
  const m = title.match(/:\s*(.+?)\s*—/);
  if (m) {
    const part = m[1].trim();
    if (part && !/^unknown ship$/i.test(part)) return part;
  }
  return "";
}

/**
 * Stable entity-level group key for review queue consolidation.
 */
function entityGroupKeyFromItem(item) {
  if (item?.payload?.entity_group_key) return String(item.payload.entity_group_key);
  const line = item?.cruise_line_id || "";
  const type = item?.item_type || "other";

  if (type === "missing_ship_url") {
    return `${type}|${line}|ship:${item?.payload?.ship_id || ""}`;
  }
  if (type === "unknown_destination") {
    const raw = normaliseName(item?.payload?.raw_destination_name || item?.title || "unknown");
    const sug = item?.payload?.suggested_destination_id || "";
    return `${type}|${line}|destraw:${raw}|sug:${sug}`;
  }
  if (type === "missing_url" || type === "other") {
    return `${type}|${line}|url:${canonicalUrl(item?.source_url || "")}`;
  }

  const rawShip = normaliseShipName(rawShipNameFromReviewItem(item) || "unknown");
  const sug = item?.payload?.suggested_ship_id || "";
  return `${type}|${line}|shipraw:${rawShip}|sug:${sug}`;
}

function buildEntityReviewPayload({
  type,
  cruiseLine,
  ships,
  destinations,
  extracted,
  key,
  reasons,
  signalScore
}) {
  const rawShip =
    extracted.ship_name_guess ||
    extracted.raw_extract?.ship_name_guesses?.[0] ||
    null;
  const suggestion =
    type === "unknown_ship" && rawShip
      ? suggestShipMatch(rawShip, ships || [], cruiseLine?.name || "")
      : null;

  let destSuggestion = null;
  if (type === "unknown_destination") {
    // Prefer destination name tokens from title/description when unmatched
    const blob = [extracted.raw_extract?.title, extracted.raw_extract?.description]
      .filter(Boolean)
      .join(" ");
    destSuggestion = suggestDestinationMatch(blob, destinations || []);
  }

  const entity_group_key =
    type === "missing_ship_url"
      ? `missing_ship_url|${cruiseLine.id}|ship:${extracted.ship_id || ""}`
      : type === "unknown_destination"
        ? `unknown_destination|${cruiseLine.id}|destraw:${normaliseName(
            destSuggestion?.normalised_raw || "unknown"
          )}|sug:${destSuggestion?.destination_id || ""}`
        : `${type}|${cruiseLine.id}|shipraw:${normaliseShipName(rawShip || "unknown")}|sug:${
            suggestion?.ship_id || ""
          }`;

  return {
    external_key: key,
    reasons,
    signal_score: signalScore,
    entity_group_key,
    raw_ship_name: rawShip,
    normalised_raw_ship_name: normaliseShipName(rawShip || ""),
    suggested_ship_id: suggestion?.ship_id || null,
    suggested_ship_name: suggestion?.ship_name || null,
    suggested_confidence: suggestion?.confidence ?? null,
    raw_destination_name: destSuggestion?.normalised_raw || null,
    suggested_destination_id: destSuggestion?.destination_id || null,
    suggested_destination_name: destSuggestion?.destination_name || null,
    suggested_destination_confidence: destSuggestion?.confidence ?? null,
    diagnostics: {
      ship_name_guesses: extracted.raw_extract?.ship_name_guesses || [],
      nights: extracted.nights,
      departure_date: extracted.departure_date,
      destination_id: extracted.destination_id,
      ship_id: extracted.ship_id,
      canonical_url: extracted.raw_extract?.canonical_url || null,
      excerpt_chars: extracted.raw_extract?.excerpt_chars || 0
    },
    extract: {
      title: extracted.raw_extract?.title || null,
      description: extracted.raw_extract?.description || null
    }
  };
}

/**
 * Group pending review items into entity-level problems.
 */
function groupReviewItems(items, { lineNameById = {} } = {}) {
  const map = new Map();
  for (const item of items || []) {
    const groupKey = entityGroupKeyFromItem(item);
    let group = map.get(groupKey);
    if (!group) {
      const rawShip = rawShipNameFromReviewItem(item) || null;
      group = {
        group_id: groupKey,
        item_type: item.item_type,
        cruise_line_id: item.cruise_line_id || null,
        cruise_line_name: lineNameById[item.cruise_line_id] || null,
        raw_ship_name: item.payload?.raw_ship_name || rawShip,
        normalised_raw_ship_name:
          item.payload?.normalised_raw_ship_name || normaliseShipName(rawShip || ""),
        suggested_ship_id: item.payload?.suggested_ship_id || null,
        suggested_ship_name: item.payload?.suggested_ship_name || null,
        suggested_confidence: item.payload?.suggested_confidence ?? null,
        suggested_destination_id: item.payload?.suggested_destination_id || null,
        suggested_destination_name: item.payload?.suggested_destination_name || null,
        suggested_destination_confidence: item.payload?.suggested_destination_confidence ?? null,
        affected_count: 0,
        item_ids: [],
        sample_urls: [],
        sample_titles: [],
        reasons: item.detail || item.payload?.reasons?.join("; ") || null,
        created_at: item.created_at || null,
        last_seen_at: item.last_seen_at || item.created_at || null,
        departure_date_raw: item.payload?.diagnostics?.departure_date_raw || item.payload?.departure_date_raw || null,
        parsed_departure_date: item.payload?.diagnostics?.departure_date || null,
        source_title: item.payload?.extract?.title || null,
        affected_external_keys: Array.isArray(item.affected_external_keys)
          ? [...item.affected_external_keys]
          : item.payload?.external_key
            ? [item.payload.external_key]
            : []
      };
      map.set(groupKey, group);
    }
    group.affected_count += 1;
    group.item_ids.push(item.id);
    if (item.payload?.external_key && !group.affected_external_keys.includes(item.payload.external_key)) {
      group.affected_external_keys.push(item.payload.external_key);
    }
    if (item.last_seen_at && (!group.last_seen_at || item.last_seen_at > group.last_seen_at)) {
      group.last_seen_at = item.last_seen_at;
    }
    if (!group.source_title && item.payload?.extract?.title) {
      group.source_title = item.payload.extract.title;
    }
    if (!group.departure_date_raw && item.payload?.diagnostics?.departure_date) {
      group.parsed_departure_date = item.payload.diagnostics.departure_date;
    }
    if (item.source_url && group.sample_urls.length < 5) {
      group.sample_urls.push(item.source_url);
    }
    if (item.title && group.sample_titles.length < 3) {
      group.sample_titles.push(item.title);
    }
    // Prefer richest suggestion fields
    if (!group.suggested_ship_id && item.payload?.suggested_ship_id) {
      group.suggested_ship_id = item.payload.suggested_ship_id;
      group.suggested_ship_name = item.payload.suggested_ship_name || null;
      group.suggested_confidence = item.payload.suggested_confidence ?? null;
    }
    if (
      group.suggested_confidence == null ||
      (item.payload?.suggested_confidence != null &&
        item.payload.suggested_confidence > group.suggested_confidence)
    ) {
      if (item.payload?.suggested_ship_id) {
        group.suggested_ship_id = item.payload.suggested_ship_id;
        group.suggested_ship_name = item.payload.suggested_ship_name || null;
        group.suggested_confidence = item.payload.suggested_confidence;
      }
    }
    if (!group.raw_ship_name && (item.payload?.raw_ship_name || rawShipNameFromReviewItem(item))) {
      group.raw_ship_name = item.payload?.raw_ship_name || rawShipNameFromReviewItem(item);
      group.normalised_raw_ship_name = normaliseShipName(group.raw_ship_name || "");
    }
    if (item.created_at && (!group.created_at || item.created_at < group.created_at)) {
      group.created_at = item.created_at;
    }
  }

  return [...map.values()].sort((a, b) => {
    if (b.affected_count !== a.affected_count) return b.affected_count - a.affected_count;
    return String(a.cruise_line_name || "").localeCompare(String(b.cruise_line_name || ""));
  });
}

/**
 * Match a ship against source text using normalised aliases + word boundaries.
 */
function matchShip(text, ships, cruiseLineName = "") {
  const hay = ` ${normaliseShipName(text)} `;
  if (!hay.trim() || !ships?.length) return null;

  const ranked = [...ships].sort(
    (a, b) => normaliseShipName(b.name).length - normaliseShipName(a.name).length
  );

  for (const ship of ranked) {
    const keys = shipAliasKeys(ship.name, cruiseLineName);
    for (const key of keys) {
      if (hay.includes(` ${key} `)) return ship;
    }
  }
  return null;
}

/**
 * Pull plausible ship-name phrases from title/URL/text for diagnostics + matching.
 */
function extractShipNameGuesses(text, url, cruiseLineName) {
  const guesses = [];
  const seen = new Set();
  const push = (name) => {
    const cleaned = String(name || "").replace(/\s+/g, " ").trim();
    if (cleaned.length < 3 || cleaned.length > 60) return;
    const key = normaliseShipName(cleaned);
    if (!key || seen.has(key) || GENERIC_TOKENS.has(key)) return;
    seen.add(key);
    guesses.push(cleaned);
  };

  const raw = String(text || "");
  const patterns = [
    /\b(?:aboard|onboard|on board|sailing on|sail on|cruise on)\s+(?:the\s+)?([A-Z][A-Za-z0-9'’.-]+(?:\s+[A-Z][A-Za-z0-9'’.-]+){0,4})/g,
    /\b((?:MS|MV|SS)\s+[A-Z][A-Za-z0-9'’.-]+(?:\s+[A-Z][A-Za-z0-9'’.-]+){0,3})\b/g
  ];
  for (const re of patterns) {
    let m;
    const clone = new RegExp(re.source, re.flags);
    while ((m = clone.exec(raw)) !== null) push(m[1]);
  }

  try {
    const path = new URL(String(url || "")).pathname || "";
    const parts = path.split("/").filter(Boolean);
    for (const part of parts) {
      if (/ship|fleet|vessel/i.test(part)) continue;
      if (!/[a-z]/i.test(part)) continue;
      if (part.length < 5) continue;
      const slugGuess = part.replace(/[-_]+/g, " ");
      if (slugTokenRejected(slugGuess)) continue;
      push(slugGuess);
    }
  } catch {
    /* ignore */
  }

  // Drop guesses that are just the cruise line brand
  const lineKey = normaliseShipName(cruiseLineName);
  const lineTokens = new Set(lineKey.split(" ").filter(Boolean));
  return guesses.filter((g) => {
    const n = normaliseShipName(g);
    if (!n || n === lineKey) return false;
    if (guessLooksNonSailing(g)) return false;
    const tokens = n.split(" ").filter((t) => t && !GENERIC_TOKENS.has(t));
    if (!tokens.length) return false;
    if (tokens.every((t) => lineTokens.has(t))) return false;
    return true;
  });
}

function matchDestination(text, destinations, aliases = []) {
  const hay = ` ${normaliseName(text)} `;
  if (!hay.trim()) return [];
  const found = [];
  const seen = new Set();
  const classifiable = classificationDestinations(destinations || []);

  for (const alias of aliases || []) {
    const needle = normaliseName(alias.normalised_alias || alias.raw_alias);
    if (!needle || needle.length < 3) continue;
    if (!hay.includes(` ${needle} `)) continue;
    if (seen.has(alias.destination_id)) continue;
    const dest = classifiable.find((d) => d.id === alias.destination_id);
    if (dest) {
      seen.add(dest.id);
      found.push({ dest, evidence: `alias:${alias.raw_alias}` });
    }
  }

  const ranked = [...classifiable].sort(
    (a, b) => normaliseName(b.name).length - normaliseName(a.name).length
  );
  for (const dest of ranked) {
    if (seen.has(dest.id)) continue;
    const name = normaliseName(dest.name);
    const slug = normaliseName(dest.slug).replace(/-/g, " ");
    const region = normaliseName(dest.primary_region);
    let evidence = null;
    if (name && name.length >= 3 && hay.includes(` ${name} `)) evidence = `name:${dest.name}`;
    else if (slug && slug.length >= 3 && hay.includes(` ${slug} `)) evidence = `slug:${dest.slug}`;
    else if (region && region.includes(" ") && hay.includes(` ${region} `)) {
      evidence = `region:${dest.primary_region}`;
    }
    if (evidence) {
      seen.add(dest.id);
      found.push({ dest, evidence });
    }
  }
  return found;
}

function externalKey({ cruiseLineId, officialUrl, departureDate, shipId, nights }) {
  const basis = [
    cruiseLineId || "",
    canonicalUrl(officialUrl),
    departureDate || "",
    shipId || "",
    nights || ""
  ].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function reviewFingerprint(item) {
  const payloadKey = item.payload?.external_key || item.payload?.ship_id || "";
  return [
    item.item_type || "",
    canonicalUrl(item.source_url || ""),
    payloadKey,
    item.cruise_line_id || ""
  ].join("|");
}

function validateCruise(candidate) {
  const reasons = [];
  if (!candidate.ship_id) reasons.push("Ship not matched to Ships database");
  if (!candidate.destination_id) reasons.push("Destination not matched");
  if (!candidate.departure_date) reasons.push("Departure date missing or invalid");
  if (!candidate.official_url) reasons.push("Official URL missing");
  else {
    try {
      // eslint-disable-next-line no-new
      new URL(candidate.official_url);
    } catch {
      reasons.push("Official URL invalid");
    }
  }

  const departureCheck = validateDepartureForCandidate(candidate);
  reasons.push(...departureCheck.reasons);
  return reasons;
}

/**
 * Score whether source text looks like a sailing candidate (not a hub/marketing page).
 * Does not make records active — only gates whether we create a candidate/review item.
 */
function cruiseSignalScore(signals) {
  let score = 0;
  if (signals.departure_date) score += 2;
  if (signals.nights) score += 1;
  if (signals.ship_id) score += 2;
  else if (signals.ship_name_guess && !guessLooksNonSailing(signals.ship_name_guess)) score += 2;
  if (signals.brochure_fare_display) score += 1;
  if (signals.itinerary) score += 1;
  if (signals.departure_port) score += 1;
  return score;
}

/**
 * Stage 1 — extract raw signals only from source text (never invent).
 */
function extractRawSignals({ title, description, url, excerpt, cruiseLine, structuredVoyage = null }) {
  const sv = structuredVoyage || {};
  const blob = [title, description, excerpt, sv.title, sv.description].filter(Boolean).join("\n");
  if (!blob.trim() && !sv.departure_date && !sv.url) return null;

  const fare = extractFare(blob);
  let shipGuesses = extractShipNameGuesses(`${title}\n${description}\n${excerpt}`, url, cruiseLine?.name);
  if (sv.ship_name && !shipGuesses.includes(sv.ship_name)) shipGuesses.unshift(String(sv.ship_name));
  if (isCrystalCruisesLine(cruiseLine?.name)) {
    const voyage = parseCrystalVoyageFromUrl(url);
    const titleShip = extractCrystalTitleShip(title);
    const canonicalShip =
      voyage?.shipName && titleShip && normaliseShipName(voyage.shipName) === normaliseShipName(titleShip)
        ? voyage.shipName
        : sv.ship_name || voyage?.shipName || titleShip;
    if (canonicalShip) {
      shipGuesses = [
        String(canonicalShip),
        ...shipGuesses.filter((g) => normaliseShipName(g) !== normaliseShipName(canonicalShip))
      ];
    }
    shipGuesses = shipGuesses.filter((g) => !/^none cs[ey]/i.test(String(g).replace(/-/g, " ")));
  }
  return {
    title: title || sv.title || null,
    description: description || sv.description || null,
    url: url || sv.url || null,
    excerpt_chars: excerpt ? excerpt.length : 0,
    blob,
    departure_date_raw: sv.departure_date || extractDepartureDate(blob),
    nights_raw: sv.nights || extractNights(blob),
    fare_raw: fare,
    departure_port_raw: sv.departure_port || extractDeparturePort(blob),
    itinerary_raw: extractItinerary(blob),
    ship_name_guesses: shipGuesses,
    voyage_id: sv.voyage_id || null,
    return_date_raw: sv.return_date || null,
    extraction_evidence: sv.source ? { structured_source: sv.source } : undefined
  };
}

/**
 * Stage 2 — normalise extracted values (canonical forms only; no invention).
 */
function normaliseCandidate(raw) {
  if (!raw) return null;
  let nights = raw.nights_raw || null;
  if (!nights && raw.departure_date_raw && raw.return_date_raw) {
    try {
      const a = new Date(`${raw.departure_date_raw}T00:00:00Z`).getTime();
      const b = new Date(`${raw.return_date_raw}T00:00:00Z`).getTime();
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) nights = Math.round((b - a) / 86400000);
    } catch {
      /* ignore */
    }
  }
  return {
    ...raw,
    official_url: String(raw.url || "").trim(),
    canonical_url: canonicalUrl(raw.url),
    departure_date: raw.departure_date_raw || null,
    return_date: raw.return_date_raw || null,
    nights,
    departure_port: raw.departure_port_raw
      ? raw.departure_port_raw.replace(/\s+/g, " ").trim()
      : null,
    itinerary: raw.itinerary_raw || null,
    brochure_fare_display: raw.fare_raw?.brochure_fare_display || null,
    brochure_fare: raw.fare_raw?.brochure_fare ?? null,
    currency: raw.fare_raw?.currency ?? null,
    ship_name_guess: raw.ship_name_guesses?.[0] || null,
    ship_name_guesses: raw.ship_name_guesses || []
  };
}

/**
 * Stage 3 — match normalised candidate to Ships + Destinations.
 */
function matchShipWithAliases(text, ships, aliases, cruiseLineName) {
  const hay = ` ${normaliseShipName(text)} `;
  if (!hay.trim()) return null;

  for (const alias of aliases || []) {
    const needle = normaliseShipName(alias.normalised_alias || alias.raw_alias);
    if (needle && hay.includes(` ${needle} `)) {
      const ship = (ships || []).find((s) => s.id === alias.ship_id);
      if (ship) return { ship, via: "alias", alias };
    }
  }

  const ship = matchShip(text, ships, cruiseLineName);
  return ship ? { ship, via: "name", alias: null } : null;
}

function matchEntities(normalised, { cruiseLine, ships, destinations, preferredDestination, shipAliases, destinationAliases, structuredVoyage = null }) {
  if (!normalised) return null;

  const crystalResolution = isCrystalCruisesLine(cruiseLine?.name)
    ? resolveCrystalShipEvidence({
        url: normalised.official_url || normalised.url,
        title: normalised.title,
        description: normalised.description,
        structuredVoyage,
        ships,
        cruiseLineName: cruiseLine?.name
      })
    : null;

  let shipHit =
    matchShipWithAliases(
      normalised.blob,
      ships,
      shipAliases || [],
      cruiseLine?.name
    ) ||
    matchShipWithAliases(
      [...(normalised.ship_name_guesses || []), normalised.ship_name_guess].filter(Boolean).join(" "),
      ships,
      shipAliases || [],
      cruiseLine?.name
    );

  if (crystalResolution?.ship && !crystalResolution.conflict) {
    shipHit = { ship: crystalResolution.ship, via: "crystal_official_evidence", alias: null };
  } else if (
    crystalResolution?.conflict &&
    crystalResolution.voyage?.shipName &&
    extractCrystalTitleShip(normalised.title)
  ) {
    const urlShip = crystalResolution.evidence.find((e) => e.source === "url_voyage_code")?.ship;
    const titleShip = crystalResolution.evidence.find((e) => e.source === "page_title")?.ship;
    if (urlShip && titleShip && urlShip.id === titleShip.id) {
      shipHit = { ship: urlShip, via: "crystal_url_title", alias: null };
    }
  }

  // Prefer destination only when the source text actually mentions it (never force).
  const destHits = matchDestination(
    normalised.blob,
    destinations || [],
    destinationAliases || []
  );
  let destination = destHits[0]?.dest || null;
  if (
    !destination &&
    preferredDestination &&
    (normaliseName(normalised.blob).includes(normaliseName(preferredDestination.name)) ||
      normaliseName(normalised.blob).includes(
        normaliseName(preferredDestination.slug).replace(/-/g, " ")
      ))
  ) {
    destination = preferredDestination;
    destHits.push({ dest: preferredDestination, evidence: "preferred_mentioned" });
  }

  return {
    ...normalised,
    ship_id: shipHit?.ship?.id || null,
    matched_ship: shipHit?.ship || null,
    ship_match_via: shipHit?.via || null,
    crystal_ship_resolution: crystalResolution || undefined,
    destination_id: destination?.id || null,
    matched_destination: destination || null,
    destination_ids: destHits.map((h) => h.dest.id),
    destination_evidence: Object.fromEntries(destHits.map((h) => [h.dest.id, h.evidence])),
    departure_date_raw: normalised.departure_date_raw || null,
    return_date:
      normalised.departure_date && normalised.nights
        ? addDaysIso(normalised.departure_date, normalised.nights)
        : null
  };
}

/**
 * Full pipeline for one search hit: extract → normalise → match → validate gate.
 * Returns null when the page has no meaningful sailing signals (skip, no review noise).
 */
function lifecycleFromValidation(reasons, { lowSignal = false } = {}) {
  if (lowSignal) return "ignored_low_signal";
  if (!reasons?.length) return "active";
  if (reasons.some((r) => /Ship not matched/i.test(r))) return "match_required";
  if (reasons.some((r) => /Destination not matched/i.test(r))) return "match_required";
  if (reasons.some((r) => /Departure date/i.test(r))) return "validation_failed";
  if (reasons.some((r) => /departure port|Invalid departure|Ambiguous departure/i.test(r))) {
    return "validation_failed";
  }
  if (reasons.some((r) => /Official URL/i.test(r))) return "validation_failed";
  return "validation_failed";
}

/**
 * Full pipeline for one search hit: extract → normalise → match → validate gate.
 * Returns null when the page has no meaningful sailing signals (skip, no review noise).
 */
function buildCandidateFromSource({
  title,
  description,
  url,
  excerpt,
  cruiseLine,
  ships,
  destinations,
  preferredDestination,
  shipAliases = [],
  destinationAliases = [],
  structuredVoyage = null
}) {
  const raw = extractRawSignals({ title, description, url, excerpt, cruiseLine, structuredVoyage });
  if (!raw) return null;

  const nonSailing = classifyNonSailingSource({
    url,
    title,
    description,
    excerpt,
    ship_name_guesses: raw.ship_name_guesses,
    ships,
    knownShipNamesList: (ships || []).map((s) => s.name)
  });
  if (nonSailing.rejected) {
    return {
      skip: true,
      reason: nonSailing.reason,
      signalScore: 0,
      diagnostics: { ship_name_guesses: raw.ship_name_guesses }
    };
  }

  const normalised = normaliseCandidate(raw);
  const matched = matchEntities(normalised, {
    cruiseLine,
    ships,
    destinations,
    preferredDestination,
    shipAliases,
    destinationAliases,
    structuredVoyage
  });

  if (crystalShipConflictBlocksActivation(matched.crystal_ship_resolution)) {
    return {
      skip: true,
      reason: "crystal_ship_evidence_conflict",
      signalScore: 0,
      diagnostics: {
        ship_name_guesses: matched.ship_name_guesses,
        crystal_conflict: matched.crystal_ship_resolution.conflict
      }
    };
  }

  const signalScore = cruiseSignalScore({
    departure_date: matched.departure_date,
    nights: matched.nights,
    ship_id: matched.ship_id,
    ship_name_guess: matched.ship_name_guess,
    brochure_fare_display: matched.brochure_fare_display,
    itinerary: matched.itinerary,
    departure_port: matched.departure_port
  });

  // Hub/marketing pages without sailing signals — do not enqueue review.
  if (signalScore < 2) {
    return { skip: true, reason: "insufficient_cruise_signals", signalScore, diagnostics: {
      ship_name_guesses: matched.ship_name_guesses,
      departure_date: matched.departure_date,
      nights: matched.nights
    } };
  }

  const draft = {
    cruise_line_id: cruiseLine.id,
    ship_id: matched.ship_id,
    destination_id: matched.destination_id,
    destination_ids: matched.destination_ids || [],
    destination_evidence: matched.destination_evidence || {},
    departure_date: matched.departure_date,
    departure_date_raw: matched.departure_date || null,
    return_date: matched.return_date,
    nights: matched.nights,
    departure_port: matched.departure_port,
    itinerary: matched.itinerary,
    brochure_fare: matched.brochure_fare,
    currency: matched.currency,
    brochure_fare_display: matched.brochure_fare_display,
    official_url: matched.official_url,
    source_url: matched.official_url,
    raw_extract: {
      title: matched.title,
      description: matched.description,
      excerpt_chars: matched.excerpt_chars,
      ship_name_guesses: matched.ship_name_guesses,
      signal_score: signalScore,
      canonical_url: matched.canonical_url,
      ship_match_via: matched.ship_match_via || null
    },
    matched_ship: matched.matched_ship,
    matched_destination: matched.matched_destination,
    ship_name_guess: matched.ship_name_guess,
    destination_name: matched.matched_destination?.name || preferredDestination?.name || null
  };

  const withDeparture = applyDepartureResolutionToCandidate(draft, {
    title: matched.title,
    description: matched.description,
    excerpt
  });
  withDeparture.departure_port_meta = withDeparture.departure_port_meta || withDeparture.raw_extract?.departure_port_meta;

  const individualGate = provesIndividualSailing({
    ship_id: withDeparture.ship_id,
    departure_date: withDeparture.departure_date,
    departure_port: withDeparture.departure_port,
    departure_port_meta: withDeparture.departure_port_meta,
    ship_name_guess: withDeparture.ship_name_guess,
    ships
  });
  if (!individualGate.proven && signalScore < 4) {
    return {
      skip: true,
      reason: individualGate.reason || "non_sailing_marketing_page",
      signalScore,
      diagnostics: { missing: individualGate.missing, ship_name_guesses: matched.ship_name_guesses }
    };
  }

  const reasons = validateCruise(withDeparture);
  const confidence =
    reasons.length === 0 ? "high" : reasons.length <= 2 && draft.ship_id ? "medium" : "low";
  const status = lifecycleFromValidation(reasons);

  return {
    skip: false,
    candidate: withDeparture,
    reasons,
    confidence,
    status,
    signalScore
  };
}

/** @deprecated Prefer buildCandidateFromSource — kept for callers/tests. */
function extractCandidateFromText(args) {
  const built = buildCandidateFromSource(args);
  if (!built || built.skip) return null;
  return {
    ...built.candidate,
    ship_name_raw: built.candidate.matched_ship?.name || built.candidate.ship_name_guess || null,
    destination_name_raw: built.candidate.matched_destination?.name || null
  };
}

async function searchOfficialCruises({ cruiseLine, destination, count = 8, adapter = null }) {
  const apiKey = getBraveApiKey();
  const host = hostnameOf(cruiseLine.website_url);
  if (!host) {
    const err = new Error(`${cruiseLine.name} has no official website_url`);
    err.code = "missing_website";
    throw err;
  }

  const destName = destination?.name || "cruise";
  const queries = buildBraveSailingQueries({ host, destName, adapter });
  if (cruiseLine.cruise_search_url) {
    queries.push(
      `${destName} (itinerary OR sailing OR "nights") site:${hostnameOf(cruiseLine.cruise_search_url) || host}`
    );
  }

  const seen = new Set();
  const results = [];
  for (const q of queries) {
    const hits = await braveSearch(apiKey, q, { count, country: "AU", timeoutMs: 8_000 });
    for (const hit of hits || []) {
      const url = String(hit.url || "").trim();
      if (!url || seen.has(canonicalUrl(url))) continue;
      if (!isSameSite(url, host) && !isSameSite(url, hostnameOf(cruiseLine.cruise_search_url))) {
        continue;
      }
      seen.add(canonicalUrl(url));
      results.push({ ...hit, source_method: "brave_fallback" });
    }
    if (results.length >= count * 2) break; // gather extras for scoring/filter
  }
  return results;
}

/**
 * Convert structured voyage record to a discovery hit (layer 1 extraction).
 */
function structuredVoyageToHit(voyage, cruiseLine, sourceMethod) {
  const excerpt = [
    voyage.title,
    voyage.description,
    voyage.departure_port ? `Departure port: ${voyage.departure_port}` : "",
    voyage.ship_name ? `Ship: ${voyage.ship_name}` : "",
    voyage.departure_date ? `Departure date: ${voyage.departure_date}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  return {
    url: voyage.url || cruiseLine.cruise_search_url || cruiseLine.website_url,
    title: voyage.title || `${cruiseLine.name} sailing`,
    description: voyage.description || "",
    excerpt,
    source_method: sourceMethod || "structured_voyage",
    structured_voyage: voyage
  };
}

/**
 * Fetch official sitemap(s) for sailing URLs.
 */
async function collectFromSitemap(cruiseLine, adapter) {
  const base = String(cruiseLine.website_url || cruiseLine.cruise_search_url || "").trim();
  if (!base) return { hits: [], pagesFetched: 0, diagnostics: [] };
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    return { hits: [], pagesFetched: 0, diagnostics: [] };
  }
  const paths = adapter.sitemapPaths || ["/sitemap.xml"];
  const hits = [];
  const diagnostics = [];
  let pagesFetched = 0;
  for (const p of paths) {
    const sitemapUrl = `${origin}${p.startsWith("/") ? p : `/${p}`}`;
    const fetched = await fetchSourceExcerpt(sitemapUrl, {
      timeoutMs: 5_000,
      maxExcerptChars: 500_000,
      includeHtml: true
    });
    pagesFetched += 1;
    if (!fetched.ok || !fetched.html) {
      diagnostics.push({ url: sitemapUrl, decision: "skip", reason: fetched.error || "sitemap_fetch_failed" });
      continue;
    }
    const locs = extractSitemapLocs(fetched.html, origin);
    for (const loc of locs.slice(0, 40)) {
      hits.push({
        url: loc,
        title: `${cruiseLine.name} sailing`,
        description: "From official sitemap",
        source_method: "sitemap"
      });
    }
    if (locs.length) break;
  }
  return { hits, pagesFetched, diagnostics };
}

/**
 * Primary path: parse cruise_search_url for sailing links / structured data.
 */
async function collectFromOfficialSearchPage(cruiseLine, destination, adapter) {
  const searchUrl = String(cruiseLine.cruise_search_url || cruiseLine.website_url || "").trim();
  if (!searchUrl) return { hits: [], sourceMethod: null, diagnostics: [] };
  const usedWebsiteFallback = !cruiseLine.cruise_search_url && Boolean(cruiseLine.website_url);

  const destName = destination?.name || "";
  const fetched = await fetchSourceExcerpt(searchUrl, {
    timeoutMs: 6_000,
    maxExcerptChars: 2_000,
    includeHtml: true
  });
  if (!fetched.ok || !fetched.html) {
    return {
      hits: [],
      sourceMethod: null,
      diagnostics: [
        {
          url: searchUrl,
          decision: "skip",
          reason: fetched.error || "official_search_fetch_failed",
          source_method: "official_search_page"
        }
      ]
    };
  }

  const structured = extractStructuredSailingSources(fetched.html, searchUrl);
  const htmlSize = String(fetched.html || "").length;
  const javascriptEmpty = htmlSize < 1200 && !structured.hasStructured;
  let sourceMethod = "official_search_page";
  if (structured.methods.includes("next_data") || structured.methods.includes("embedded_json")) {
    sourceMethod = "official_embedded_json";
  } else if (structured.methods.includes("api_hint")) {
    sourceMethod = "official_api";
  } else if (structured.voyageMethods?.includes("json_ld_voyage")) {
    sourceMethod = "json_ld_voyage";
  }

  const host = hostnameOf(cruiseLine.website_url);
  const hits = [];
  const diagnostics = [];

  if (structured.structuredVoyages?.length) {
    for (const voyage of structured.structuredVoyages.slice(0, adapter.maxFetches || 15)) {
      hits.push(structuredVoyageToHit(voyage, cruiseLine, sourceMethod));
    }
  }

  for (const url of structured.sailingUrls) {
    if (!isSameSite(url, host) && !isSameSite(url, hostnameOf(searchUrl))) continue;
    if (destName) {
      const hay = url.toLowerCase();
      const destToken = normaliseName(destName).split(" ")[0];
      // soft prefer destination mention in URL; still allow if sailing path strong
      const scored = scoreSailingUrl({ url, title: "", description: destName }, adapter);
      if (scored.decision === "skip" && !hay.includes(destToken)) {
        diagnostics.push({
          url,
          canonical_url: canonicalUrl(url),
          decision: "skip",
          reason: scored.reason,
          sailing_score: scored.score,
          positive_signals: scored.positive,
          negative_signals: scored.negative,
          source_method: sourceMethod,
          adapter: adapter?.id
        });
        continue;
      }
    }
    hits.push({
      url,
      title: `${cruiseLine.name} sailing`,
      description: destName ? `${destName} itinerary` : "Official sailing",
      source_method: sourceMethod
    });
  }

  return {
    hits,
    sourceMethod: usedWebsiteFallback ? "official_website_fallback" : sourceMethod,
    diagnostics,
    pagesFetched: 1,
    htmlSize,
    javascriptEmpty,
    structuredVoyageCount: structured.structuredVoyages?.length || 0,
    usedWebsiteFallback
  };
}

function primaryReviewType(reasons, candidate) {
  if (!candidate.ship_id) return "unknown_ship";
  if (!candidate.destination_id) return "unknown_destination";
  if (!candidate.departure_date) return "missing_departure_date";
  if (Array.isArray(reasons) && reasons.some((r) => /Invalid departure value/i.test(r))) {
    return "invalid_departure_port";
  }
  if (Array.isArray(reasons) && reasons.some((r) => /Missing departure port/i.test(r))) {
    return "missing_departure_port";
  }
  if (Array.isArray(reasons) && reasons.some((r) => /Ambiguous departure port/i.test(r))) {
    return "ambiguous_departure_port";
  }
  if (!candidate.official_url) return "missing_url";
  if (Array.isArray(reasons) && reasons.some((r) => /ambiguous/i.test(r))) return "ambiguous_match";
  return "validation_failure";
}

function dedupeReviewItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const fp = reviewFingerprint(item);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push({ ...item, payload: { ...(item.payload || {}), fingerprint: fp } });
  }
  return out;
}

/**
 * Discover cruises for one cruise line (optionally scoped to one destination).
 * Sprint 11D.2: cruise_search_url first, score before fetch, Brave fallback.
 */
/**
 * Discovery search targets: explicit destination scope, or a single unfiltered pass.
 * Line-wide runs must not loop published Living Destinations as implicit filters.
 */
function resolveDiscoveryDestinationTargets(destination) {
  return destination ? [destination] : [null];
}

async function discoverForCruiseLine({
  cruiseLine,
  ships,
  destinations,
  destination = null,
  fetchPages = true,
  maxResults = 8,
  shipAliases = [],
  destinationAliases = [],
  rejectedUrlMemory = null
}) {
  const adapter = resolveAdapter(cruiseLine);
  const fetchCap = Math.min(maxResults, adapter.maxFetches || 8);
  // Line-wide discovery (no destination filter) must not iterate published Living Destinations.
  const destList = resolveDiscoveryDestinationTargets(destination);
  const stats = {
    search_hits: 0,
    brave_results_received: 0,
    results_excluded_before_fetch: 0,
    sailing_urls_fetched: 0,
    generic_pages_skipped: 0,
    ignored_non_sailing_source: 0,
    rejected_url_memory_skip: 0,
    candidates: 0,
    skipped_non_cruise: 0,
    duplicate_candidates_suppressed: 0,
    upserted_active: 0,
    upserted_review: 0,
    unchanged: 0,
    changed: 0,
    new: 0,
    review_items: 0,
    destinations_scanned: destination ? destList.length : 0,
    pages_fetched: 0,
    candidates_validated: 0,
    source_method_counts: {},
    adapter_id: adapter.id
  };
  const urlDiagnostics = [];
  const candidates = [];
  const reviewItems = [];
  const seenUrls = new Set();
  const missingShipUrlSeen = new Set();
  const lineConfigSeen = new Set();
  const shipMaintenanceSeen = new Set();

  if (!hostnameOf(cruiseLine.website_url)) {
    reviewItems.push({
      item_type: "missing_url",
      title: `${cruiseLine.name}: missing official website`,
      detail: "Set website_url (and optionally cruise_search_url) before discovery.",
      cruise_line_id: cruiseLine.id,
      payload: { cruise_line_id: cruiseLine.id }
    });
    stats.review_items = reviewItems.length;
    return { candidates, reviewItems: dedupeReviewItems(reviewItems), stats, urlDiagnostics };
  }

  const knownShipNamesList = (ships || []).map((s) => s.name).filter(Boolean);

  const targets = destList.length ? destList : [null];
  for (const dest of targets) {
    let hits = [];
    let usedMethod = null;

    try {
      const official = await collectFromOfficialSearchPage(cruiseLine, dest, adapter);
      stats.pages_fetched += official.pagesFetched || 0;
      if (official.diagnostics?.length) urlDiagnostics.push(...official.diagnostics);
      if (official.javascriptEmpty) stats.javascript_empty_html = true;
      if (official.structuredVoyageCount) {
        stats.structured_voyages_found = (stats.structured_voyages_found || 0) + official.structuredVoyageCount;
      }
      if (official.hits?.length) {
        hits = official.hits;
        usedMethod = official.sourceMethod || "official_search_page";
      }
    } catch (error) {
      console.warn("official search page failed", cruiseLine.name, error.message);
    }

    if (!hits.length) {
      try {
        const sitemap = await collectFromSitemap(cruiseLine, adapter);
        stats.pages_fetched += sitemap.pagesFetched || 0;
        if (sitemap.diagnostics?.length) urlDiagnostics.push(...sitemap.diagnostics);
        if (sitemap.hits?.length) {
          hits = sitemap.hits;
          usedMethod = "sitemap";
        }
      } catch (error) {
        console.warn("sitemap collection failed", cruiseLine.name, error.message);
      }
    }

    if (!hits.length) {
      try {
        const braveHits = await searchOfficialCruises({
          cruiseLine,
          destination: dest,
          count: fetchCap,
          adapter
        });
        stats.brave_results_received += braveHits.length;
        hits = braveHits;
        usedMethod = "brave_fallback";
      } catch (error) {
        reviewItems.push({
          item_type: "other",
          title: `Search failed for ${cruiseLine.name}${dest ? ` / ${dest.name}` : ""}`,
          detail: error.message || "Brave search failed",
          cruise_line_id: cruiseLine.id,
          destination_id: dest?.id || null,
          payload: { error: error.message, code: error.code || null }
        });
        continue;
      }
    }

    stats.search_hits += hits.length;
    stats.source_method_counts[usedMethod || "unknown"] =
      (stats.source_method_counts[usedMethod || "unknown"] || 0) + 1;

    const ranked = [];
    for (const hit of hits) {
      if (shouldSkipUrlBeforeFetch(hit.url, { memoryMap: rejectedUrlMemory })) {
        stats.rejected_url_memory_skip += 1;
        urlDiagnostics.push({
          url: hit.url,
          canonical_url: canonicalDiscoveryUrl(hit.url),
          title: hit.title || null,
          decision: "skip",
          reason: "rejected_url_memory",
          source_method: hit.source_method || usedMethod
        });
        continue;
      }

      if (hit.structured_voyage) {
        ranked.push({
          hit,
          scored: {
            score: 100,
            decision: "fetch",
            reason: "structured_voyage",
            positive: ["structured_voyage"],
            negative: []
          },
          diag: {
            url: hit.url,
            canonical_url: canonicalUrl(hit.url),
            title: hit.title || null,
            snippet: hit.description || null,
            sailing_score: 100,
            positive_signals: ["structured_voyage"],
            negative_signals: [],
            decision: "fetch",
            reason: "structured_voyage",
            adapter_used: adapter.id,
            source_method: hit.source_method || usedMethod
          }
        });
        continue;
      }

      const scored = scoreSailingUrl({ ...hit, knownShipNames: knownShipNamesList }, adapter);
      const diag = {
        url: hit.url,
        canonical_url: canonicalUrl(hit.url),
        title: hit.title || null,
        snippet: hit.description || null,
        sailing_score: scored.score,
        positive_signals: scored.positive,
        negative_signals: scored.negative,
        decision: scored.decision,
        reason: scored.reason,
        adapter_used: adapter.id,
        source_method: hit.source_method || usedMethod
      };
      if (scored.decision === "skip") {
        stats.results_excluded_before_fetch += 1;
        if (scored.reason === "ignored_non_sailing_source") stats.ignored_non_sailing_source += 1;
        else stats.generic_pages_skipped += 1;
        urlDiagnostics.push(diag);
        continue;
      }
      ranked.push({ hit, scored, diag });
    }

    ranked.sort((a, b) => b.scored.score - a.scored.score);
    let toFetch = ranked.slice(0, fetchCap);

    // If official search produced only non-sailing URLs, fall back to Brave once.
    if (!toFetch.length && usedMethod && usedMethod !== "brave_fallback") {
      try {
        const braveHits = await searchOfficialCruises({
          cruiseLine,
          destination: dest,
          count: fetchCap,
          adapter
        });
        stats.brave_results_received += braveHits.length;
        usedMethod = "brave_fallback";
        stats.source_method_counts.brave_fallback =
          (stats.source_method_counts.brave_fallback || 0) + 1;
        for (const hit of braveHits) {
          if (shouldSkipUrlBeforeFetch(hit.url, { memoryMap: rejectedUrlMemory })) {
            stats.rejected_url_memory_skip += 1;
            continue;
          }
          const scored = scoreSailingUrl({ ...hit, knownShipNames: knownShipNamesList }, adapter);
          const diag = {
            url: hit.url,
            canonical_url: canonicalUrl(hit.url),
            title: hit.title || null,
            snippet: hit.description || null,
            sailing_score: scored.score,
            positive_signals: scored.positive,
            negative_signals: scored.negative,
            decision: scored.decision,
            reason: scored.reason,
            adapter_used: adapter.id,
            source_method: "brave_fallback"
          };
          if (scored.decision === "skip") {
            stats.results_excluded_before_fetch += 1;
            if (scored.reason === "ignored_non_sailing_source") stats.ignored_non_sailing_source += 1;
            else stats.generic_pages_skipped += 1;
            urlDiagnostics.push(diag);
            continue;
          }
          ranked.push({ hit, scored, diag });
        }
        ranked.sort((a, b) => b.scored.score - a.scored.score);
        toFetch = ranked.slice(0, fetchCap);
      } catch (error) {
        console.warn("brave fallback after empty official sailing set failed", error.message);
      }
    }

    for (const { hit, scored, diag } of toFetch) {
      const urlKey = canonicalUrl(hit.url);
      if (seenUrls.has(urlKey)) {
        stats.duplicate_candidates_suppressed += 1;
        continue;
      }
      seenUrls.add(urlKey);

      let excerpt = hit.excerpt || "";
      if (fetchPages && !excerpt) {
        const fetched = await fetchSourceExcerpt(hit.url, {
          timeoutMs: 5_000,
          maxExcerptChars: 4_000,
          includeHtml: true
        });
        if (fetched.ok) {
          excerpt = fetched.excerpt || "";
          if (fetched.html) {
            const structuredHint = structuredExcerptHint(fetched.html);
            if (structuredHint) excerpt = `${structuredHint}\n${excerpt}`.slice(0, 5000);
          }
          stats.pages_fetched += 1;
          stats.sailing_urls_fetched += 1;
          diag.decision = "fetched";
          diag.reason = "sailing_candidate_fetched";
        } else {
          diag.decision = "fetch_failed";
          diag.reason = fetched.error || "fetch_failed";
          urlDiagnostics.push({ ...diag, sailing_score: scored.score });
          continue;
        }
      } else if (hit.structured_voyage) {
        stats.structured_voyages_used = (stats.structured_voyages_used || 0) + 1;
        diag.decision = "structured_voyage";
        diag.reason = "structured_voyage_no_fetch";
      }
      urlDiagnostics.push({ ...diag, sailing_score: scored.score });

      const built = buildCandidateFromSource({
        title: hit.title,
        description: hit.description,
        url: hit.url,
        excerpt,
        cruiseLine,
        ships,
        destinations: destinations || [],
        preferredDestination: dest,
        shipAliases,
        destinationAliases,
        structuredVoyage: hit.structured_voyage || null
      });

      if (!built) continue;
      if (built.skip) {
        stats.skipped_non_cruise += 1;
        continue;
      }

      const extracted = built.candidate;
      extracted.raw_extract = {
        ...(extracted.raw_extract || {}),
        discovery_11d2: {
          adapter: adapter.id,
          source_method: hit.source_method || usedMethod,
          sailing_score: scored.score,
          positive_signals: scored.positive,
          negative_signals: scored.negative
        }
      };

      if (extracted.matched_ship && !extracted.matched_ship.official_ship_url) {
        const pageLooksLikeShip =
          normaliseShipName(`${hit.title} ${excerpt}`).includes(
            normaliseShipName(extracted.matched_ship.name)
          ) && /ship|vessel|deck/i.test(`${hit.title} ${hit.description || ""}`);
        if (pageLooksLikeShip && scored.negative.some((n) => /\/ships?\//i.test(String(n)))) {
          extracted.suggested_official_ship_url = hit.url;
        }
      }

      const key = externalKey({
        cruiseLineId: cruiseLine.id,
        officialUrl: extracted.official_url,
        departureDate: extracted.departure_date,
        shipId: extracted.ship_id,
        nights: extracted.nights
      });

      const shipDisplay =
        extracted.matched_ship?.name || extracted.ship_name_guess || "Unknown ship";
      const row = {
        cruise_line_id: extracted.cruise_line_id,
        ship_id: extracted.ship_id,
        destination_id: extracted.destination_id,
        departure_date: extracted.departure_date,
        return_date: extracted.return_date,
        nights: extracted.nights,
        departure_port: extracted.departure_port,
        itinerary: extracted.itinerary,
        brochure_fare: extracted.brochure_fare,
        currency: extracted.currency,
        brochure_fare_display: extracted.brochure_fare_display,
        official_url: extracted.official_url,
        source_url: extracted.source_url,
        raw_extract: extracted.raw_extract,
        destination_ids: extracted.destination_ids || [],
        destination_evidence: extracted.destination_evidence || {},
        departure_date_raw: extracted.departure_date_raw || null,
        external_key: key,
        identity_key: null,
        status: built.status,
        match_confidence: built.confidence,
        review_reason: built.reasons.length ? built.reasons.join("; ") : null,
        cruise_line_name: cruiseLine.name,
        ship_name: shipDisplay === "Unknown ship" ? null : shipDisplay,
        destination_name: extracted.matched_destination?.name || null
      };

      let ingestionAutomation = null;
      if (built.status !== "active") {
        ingestionAutomation = evaluateIngestionAutomation({
          built,
          extracted: { ...extracted, external_key: key },
          cruiseLine,
          ships,
          destinations: destinations || [],
          destinationAliases,
          aliases: shipAliases
        });

        if (
          ingestionAutomation.action === AUTOMATION_ACTION.AUTO_REJECT ||
          ingestionAutomation.action === AUTOMATION_ACTION.CLOSE_OBSOLETE
        ) {
          stats.skipped_non_cruise += 1;
          continue;
        }

        if (
          ingestionAutomation.action === AUTOMATION_ACTION.SHIP_MAINTENANCE &&
          ingestionAutomation.ship_maintenance
        ) {
          const maintKey = ingestionAutomation.ship_maintenance.dedupe_key;
          if (!shipMaintenanceSeen.has(maintKey)) {
            shipMaintenanceSeen.add(maintKey);
            reviewItems.push({
              item_type: "missing_ship_url",
              title: `Catalogue: official ship URL needed for ${ingestionAutomation.ship_maintenance.ship_name}`,
              detail: "Ship catalogue maintenance — does not block sailing approval.",
              cruise_line_id: cruiseLine.id,
              source_url: ingestionAutomation.ship_maintenance.suggested_official_ship_url,
              payload: {
                entity_group_key: maintKey,
                ship_id: ingestionAutomation.ship_maintenance.ship_id,
                maintenance_routing: "fleet_audit",
                suggested_official_ship_url: ingestionAutomation.ship_maintenance.suggested_official_ship_url
              }
            });
          }
          candidates.push(row);
          stats.candidates += 1;
          continue;
        }

        if (ingestionAutomation.action === AUTOMATION_ACTION.LINE_CONFIG && ingestionAutomation.line_config_warning) {
          const cfgKey = ingestionAutomation.line_config_warning.dedupe_key;
          if (!lineConfigSeen.has(cfgKey)) {
            lineConfigSeen.add(cfgKey);
            reviewItems.push({
              item_type: "missing_url",
              title: `${cruiseLine.name}: configuration required`,
              detail: "Cruise-line configuration maintenance — not a sailing approval decision.",
              cruise_line_id: cruiseLine.id,
              payload: {
                entity_group_key: cfgKey,
                configuration_field: ingestionAutomation.line_config_warning.field,
                maintenance_routing: "line_configuration"
              }
            });
          }
          continue;
        }

        if (ingestionAutomation.action === AUTOMATION_ACTION.AUTO_PUBLISH) {
          row.status = "active";
        } else if (ingestionAutomation.action === AUTOMATION_ACTION.AUTO_RESOLVE) {
          row.status = built.status;
        } else if (ingestionAutomation.action !== AUTOMATION_ACTION.HUMAN_REVIEW) {
          continue;
        }
      }

      candidates.push(row);
      stats.candidates += 1;
      if (row.status === "active") stats.candidates_validated += 1;

      if (built.status !== "active" && ingestionAutomation?.action === AUTOMATION_ACTION.HUMAN_REVIEW) {
        const type = primaryReviewType(built.reasons, extracted);
        const payload = buildEntityReviewPayload({
          type,
          cruiseLine,
          ships,
          destinations: destinations || [],
          extracted,
          key,
          reasons: built.reasons,
          signalScore: built.signalScore
        });
        const displayShip =
          payload.raw_ship_name ||
          extracted.matched_ship?.name ||
          (type === "unknown_ship" ? "Unknown ship" : shipDisplay);
        reviewItems.push({
          item_type: type,
          title: `${cruiseLine.name}: ${displayShip} — ${row.departure_date || "no date"}`,
          detail: row.review_reason,
          cruise_line_id: cruiseLine.id,
          destination_id: row.destination_id,
          source_url: row.official_url,
          payload
        });
      }

      if (
        extracted.suggested_official_ship_url &&
        extracted.ship_id &&
        !missingShipUrlSeen.has(extracted.ship_id) &&
        built.status === "active"
      ) {
        missingShipUrlSeen.add(extracted.ship_id);
        reviewItems.push({
          item_type: "missing_ship_url",
          title: `Catalogue: official ship URL needed for ${shipDisplay}`,
          detail:
            "Ship catalogue maintenance only — sailing data is otherwise valid. Confirm official_ship_url in Fleet Audit.",
          cruise_line_id: cruiseLine.id,
          source_url: extracted.suggested_official_ship_url,
          payload: {
            entity_group_key: `missing_ship_url|${cruiseLine.id}|ship:${extracted.ship_id}`,
            ship_id: extracted.ship_id,
            suggested_official_ship_url: extracted.suggested_official_ship_url,
            suggested_ship_id: extracted.ship_id,
            suggested_ship_name: extracted.matched_ship?.name || shipDisplay,
            raw_ship_name: extracted.matched_ship?.name || shipDisplay
          }
        });
      }
    }
  }

  const uniqueReview = dedupeReviewItems(reviewItems);
  stats.review_items = uniqueReview.length;
  return { candidates, reviewItems: uniqueReview, stats, urlDiagnostics: urlDiagnostics.slice(0, 200) };
}


function formatAuDate(iso) {
  if (!iso) return null;
  try {
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC"
    });
  } catch {
    return String(iso);
  }
}

function resolveBrochureFare(row) {
  const display = String(row.brochure_fare_display || "").trim();
  if (display) return display;
  if (row.brochure_fare != null && row.currency) {
    return `From ${row.currency} $${Number(row.brochure_fare).toLocaleString("en-AU")} pp`;
  }
  return null;
}

function formatPublicSailing(row, lineName, shipName) {
  const nightCount = Number(row.nights);
  const duration = Number.isFinite(nightCount) && nightCount > 0
    ? `${nightCount} night${nightCount === 1 ? "" : "s"}`
    : null;
  const departureDate = formatAuDate(row.departure_date);
  const returnDate = formatAuDate(row.return_date);
  const brochureFare = resolveBrochureFare(row);

  let dateLabel = null;
  if (departureDate && returnDate) {
    dateLabel = `${departureDate} – ${returnDate}`;
  } else if (departureDate) {
    dateLabel = `Departs ${departureDate}`;
  }

  const scheduleParts = [dateLabel, duration].filter(Boolean);
  const scheduleLabel = scheduleParts.join(" · ");

  return {
    id: row.id,
    cruiseLine: lineName || row.cruise_line_name || "Cruise line",
    shipName: shipName || row.ship_name || "Ship",
    duration,
    departureDate: departureDate || null,
    returnDate: returnDate || null,
    dateLabel,
    scheduleLabel,
    hasDate: Boolean(departureDate),
    itinerary: row.itinerary || "Itinerary details on official cruise page",
    brochureFare,
    hasBrochureFare: Boolean(brochureFare),
    officialUrl: row.official_url || null,
    nights: row.nights,
    departurePort: row.departure_port || null,
    currency: row.currency || null
  };
}

module.exports = {
  normaliseName,
  normaliseShipName,
  hostnameOf,
  canonicalUrl,
  parseFlexibleDate,
  extractDepartureDate,
  extractNights,
  extractFare,
  lifecycleFromValidation,
  matchShipWithAliases,
  matchShip,
  matchDestination,
  suggestShipMatch,
  suggestDestinationMatch,
  entityGroupKeyFromItem,
  groupReviewItems,
  rawShipNameFromReviewItem,
  externalKey,
  reviewFingerprint,
  dedupeReviewItems,
  validateCruise,
  validateDepartureForCandidate,
  resolveDepartureFromSource,
  extractCandidateFromText,
  buildCandidateFromSource,
  extractRawSignals,
  normaliseCandidate,
  matchEntities,
  searchOfficialCruises,
  collectFromOfficialSearchPage,
  discoverForCruiseLine,
  resolveDiscoveryDestinationTargets,
  formatPublicSailing,
  scoreSailingUrl: require("./cruise-discovery-url-score").scoreSailingUrl,
  resolveAdapter: require("./cruise-discovery-adapters").resolveAdapter
};
