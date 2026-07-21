/**
 * Cruise Discovery Engine — extract candidates from official cruise-line sources only.
 * Never invent itineraries, prices, or sailing dates.
 */

const crypto = require("crypto");
const { braveSearch, getBraveApiKey } = require("./brave-search");
const { fetchSourceExcerpt } = require("./source-fetch");

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

function normaliseName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
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

function parseFlexibleDate(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const iso = raw.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = raw.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i
  );
  if (dmy) {
    const day = Number(dmy[1]);
    const month = MONTHS[dmy[2].toLowerCase().slice(0, 3)] ?? MONTHS[dmy[2].toLowerCase()];
    const year = Number(dmy[3]);
    if (month == null || !day || !year) return null;
    const dt = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
  }

  const mdy = raw.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i
  );
  if (mdy) {
    const month = MONTHS[mdy[1].toLowerCase().slice(0, 3)] ?? MONTHS[mdy[1].toLowerCase()];
    const day = Number(mdy[2]);
    const year = Number(mdy[3]);
    if (month == null || !day || !year) return null;
    const dt = new Date(Date.UTC(year, month, day));
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
  }

  return null;
}

function extractNights(text) {
  const m = String(text || "").match(/\b(\d{1,2})\s*[-–]?\s*nights?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 && n < 100 ? n : null;
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

function addDaysIso(isoDate, days) {
  if (!isoDate || !days) return null;
  const dt = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + Number(days));
  return dt.toISOString().slice(0, 10);
}

function matchShip(text, ships) {
  const hay = normaliseName(text);
  if (!hay || !ships?.length) return null;
  const ranked = [...ships].sort((a, b) => normaliseName(b.name).length - normaliseName(a.name).length);
  for (const ship of ranked) {
    const needle = normaliseName(ship.name);
    if (needle.length < 3) continue;
    if (hay.includes(needle)) return ship;
  }
  return null;
}

function matchDestination(text, destinations) {
  const hay = normaliseName(text);
  if (!hay || !destinations?.length) return null;
  const ranked = [...destinations].sort(
    (a, b) => normaliseName(b.name).length - normaliseName(a.name).length
  );
  for (const dest of ranked) {
    const name = normaliseName(dest.name);
    const slug = normaliseName(dest.slug).replace(/-/g, " ");
    if (name && hay.includes(name)) return dest;
    if (slug && hay.includes(slug)) return dest;
  }
  return null;
}

function externalKey({ cruiseLineId, officialUrl, departureDate, shipId, nights }) {
  const basis = [
    cruiseLineId || "",
    String(officialUrl || "")
      .trim()
      .toLowerCase()
      .replace(/\/$/, ""),
    departureDate || "",
    shipId || "",
    nights || ""
  ].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
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
  return reasons;
}

/**
 * Pull structured-ish cruise signals from search snippet + optional page excerpt.
 * Returns only fields found in source text — never invents.
 */
function extractCandidateFromText({
  title,
  description,
  url,
  excerpt,
  cruiseLine,
  ships,
  destinations,
  preferredDestination
}) {
  const blob = [title, description, excerpt].filter(Boolean).join("\n");
  if (!blob.trim()) return null;

  const departure_date = parseFlexibleDate(blob);
  const nights = extractNights(blob);
  const fare = extractFare(blob);
  const ship = matchShip(blob, ships);
  const destination =
    preferredDestination &&
    (normaliseName(blob).includes(normaliseName(preferredDestination.name)) ||
      normaliseName(blob).includes(normaliseName(preferredDestination.slug).replace(/-/g, " ")))
      ? preferredDestination
      : matchDestination(blob, destinations) || preferredDestination || null;

  // Itinerary: only keep arrow/path-like fragments that appear in source text
  let itinerary = null;
  const itinMatch = blob.match(
    /([A-Z][A-Za-z .'-]{2,40}(?:\s*(?:→|->|–|-|to)\s*[A-Z][A-Za-z .'-]{2,40}){2,})/
  );
  if (itinMatch) itinerary = itinMatch[1].replace(/\s+/g, " ").trim().slice(0, 400);

  const return_date = departure_date && nights ? addDaysIso(departure_date, nights) : null;

  return {
    cruise_line_id: cruiseLine.id,
    ship_id: ship?.id || null,
    ship_name_raw: ship?.name || null,
    destination_id: destination?.id || null,
    destination_name_raw: destination?.name || null,
    departure_date,
    return_date,
    nights,
    departure_port: null,
    itinerary,
    brochure_fare: fare?.brochure_fare ?? null,
    currency: fare?.currency ?? null,
    brochure_fare_display: fare?.brochure_fare_display ?? null,
    official_url: url,
    source_url: url,
    raw_extract: {
      title: title || null,
      description: description || null,
      excerpt_chars: excerpt ? excerpt.length : 0
    },
    matched_ship: ship || null,
    matched_destination: destination || null
  };
}

async function searchOfficialCruises({ cruiseLine, destination, count = 8 }) {
  const apiKey = getBraveApiKey();
  const host = hostnameOf(cruiseLine.website_url);
  if (!host) {
    const err = new Error(`${cruiseLine.name} has no official website_url`);
    err.code = "missing_website";
    throw err;
  }

  const destName = destination?.name || "cruise";
  const queries = [
    `site:${host} ${destName} cruise`,
    `site:${host} ${destName} itinerary`,
    cruiseLine.cruise_search_url
      ? `${destName} cruise site:${hostnameOf(cruiseLine.cruise_search_url) || host}`
      : null
  ].filter(Boolean);

  const seen = new Set();
  const results = [];
  for (const q of queries) {
    const hits = await braveSearch(apiKey, q, { count, country: "AU", timeoutMs: 8_000 });
    for (const hit of hits || []) {
      const url = String(hit.url || "").trim();
      if (!url || seen.has(url)) continue;
      if (!isSameSite(url, host) && !isSameSite(url, hostnameOf(cruiseLine.cruise_search_url))) {
        continue;
      }
      seen.add(url);
      results.push(hit);
    }
    if (results.length >= count) break;
  }
  return results.slice(0, count);
}

/**
 * Discover cruises for one cruise line (optionally scoped to one destination).
 * Caller persists runs / cruises / review items via supabase helper.
 */
async function discoverForCruiseLine({
  cruiseLine,
  ships,
  destinations,
  destination = null,
  fetchPages = true,
  maxResults = 8
}) {
  const destList = destination ? [destination] : destinations || [];
  const stats = {
    search_hits: 0,
    candidates: 0,
    upserted_active: 0,
    upserted_review: 0,
    unchanged: 0,
    changed: 0,
    new: 0,
    review_items: 0,
    destinations_scanned: destList.length
  };
  const candidates = [];
  const reviewItems = [];

  if (!hostnameOf(cruiseLine.website_url)) {
    reviewItems.push({
      item_type: "missing_url",
      title: `${cruiseLine.name}: missing official website`,
      detail: "Set website_url (and optionally cruise_search_url) before discovery.",
      cruise_line_id: cruiseLine.id,
      payload: { cruise_line_id: cruiseLine.id }
    });
    stats.review_items = reviewItems.length;
    return { candidates, reviewItems, stats };
  }

  const targets = destList.length ? destList : [null];
  for (const dest of targets) {
    let hits = [];
    try {
      hits = await searchOfficialCruises({
        cruiseLine,
        destination: dest,
        count: maxResults
      });
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
    stats.search_hits += hits.length;

    for (const hit of hits) {
      let excerpt = "";
      if (fetchPages) {
        const fetched = await fetchSourceExcerpt(hit.url, { timeoutMs: 4_500 });
        if (fetched.ok) excerpt = fetched.excerpt || "";
      }

      const extracted = extractCandidateFromText({
        title: hit.title,
        description: hit.description,
        url: hit.url,
        excerpt,
        cruiseLine,
        ships,
        destinations: destinations || [],
        preferredDestination: dest
      });
      if (!extracted) continue;

      // Try to capture official ship URL when page looks like a ship page
      if (extracted.matched_ship && !extracted.matched_ship.official_ship_url) {
        const pageLooksLikeShip =
          normaliseName(`${hit.title} ${excerpt}`).includes(normaliseName(extracted.matched_ship.name)) &&
          /ship|vessel|deck/i.test(`${hit.title} ${hit.description || ""}`);
        if (pageLooksLikeShip) {
          extracted.suggested_official_ship_url = hit.url;
        }
      }

      const reasons = validateCruise(extracted);
      const confidence =
        reasons.length === 0 ? "high" : reasons.length <= 2 && extracted.ship_id ? "medium" : "low";
      const status = reasons.length === 0 ? "active" : "review_required";

      const key = externalKey({
        cruiseLineId: cruiseLine.id,
        officialUrl: extracted.official_url,
        departureDate: extracted.departure_date,
        shipId: extracted.ship_id,
        nights: extracted.nights
      });

      const row = {
        ...extracted,
        external_key: key,
        status,
        match_confidence: confidence,
        review_reason: reasons.length ? reasons.join("; ") : null,
        cruise_line_name: cruiseLine.name,
        ship_name: extracted.matched_ship?.name || extracted.ship_name_raw || null,
        destination_name: extracted.matched_destination?.name || extracted.destination_name_raw || null
      };
      delete row.matched_ship;
      delete row.matched_destination;
      delete row.ship_name_raw;
      delete row.destination_name_raw;

      candidates.push(row);
      stats.candidates += 1;

      if (status === "review_required") {
        const type = !extracted.ship_id
          ? "unknown_ship"
          : !extracted.destination_id
            ? "unknown_destination"
            : !extracted.official_url
              ? "missing_url"
              : "validation_failure";
        reviewItems.push({
          item_type: type,
          title: `${cruiseLine.name}: ${row.ship_name || "Unknown ship"} — ${row.departure_date || "no date"}`,
          detail: row.review_reason,
          cruise_line_id: cruiseLine.id,
          destination_id: row.destination_id,
          source_url: row.official_url,
          payload: { external_key: key, reasons, extract: row.raw_extract }
        });
      }

      if (extracted.suggested_official_ship_url && extracted.ship_id) {
        reviewItems.push({
          item_type: "missing_ship_url",
          title: `Confirm official ship URL for ${row.ship_name}`,
          detail: "Discovery found a likely ship page; confirm before saving official_ship_url.",
          cruise_line_id: cruiseLine.id,
          source_url: extracted.suggested_official_ship_url,
          payload: {
            ship_id: extracted.ship_id,
            suggested_official_ship_url: extracted.suggested_official_ship_url
          }
        });
      }
    }
  }

  stats.review_items = reviewItems.length;
  return { candidates, reviewItems, stats };
}

function formatPublicSailing(row, lineName, shipName) {
  const nights = row.nights ? `${row.nights} nights` : "—";
  let departureDate = "—";
  if (row.departure_date) {
    try {
      departureDate = new Date(`${row.departure_date}T00:00:00Z`).toLocaleDateString("en-AU", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC"
      });
    } catch {
      departureDate = row.departure_date;
    }
  }
  return {
    id: row.id,
    cruiseLine: lineName || row.cruise_line_name || "Cruise line",
    shipName: shipName || row.ship_name || "Ship",
    duration: nights,
    departureDate,
    itinerary: row.itinerary || "Itinerary details on official cruise page",
    brochureFare: row.brochure_fare_display || (row.brochure_fare && row.currency
      ? `From ${row.currency} $${Number(row.brochure_fare).toLocaleString("en-AU")} pp`
      : "See official brochure fare"),
    officialUrl: row.official_url || null,
    nights: row.nights,
    departurePort: row.departure_port || null,
    currency: row.currency || null
  };
}

module.exports = {
  normaliseName,
  hostnameOf,
  parseFlexibleDate,
  extractNights,
  extractFare,
  matchShip,
  matchDestination,
  externalKey,
  validateCruise,
  extractCandidateFromText,
  searchOfficialCruises,
  discoverForCruiseLine,
  formatPublicSailing
};
