/**
 * Live cruise search via Brave Search API (server-side only).
 *
 * POST /.netlify/functions/search-current-cruises
 *
 * Does not store itineraries. Short in-memory cache + rate limits only.
 * Never exposes BRAVE_SEARCH_API_KEY to the browser.
 */

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_BRAVE_QUERIES = 4;
const CACHE_TTL_MS = 20 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 8;
const RESULTS_PER_QUERY = 10;

const APPROVED_CRUISE_LINES = [
  {
    name: "Holland America",
    aliases: ["holland america line", "holland america", "hal"],
    domains: ["hollandamerica.com"]
  },
  {
    name: "Princess",
    aliases: ["princess cruises", "princess"],
    domains: ["princess.com"]
  },
  {
    name: "Celebrity",
    aliases: ["celebrity cruises", "celebrity"],
    domains: ["celebritycruises.com"]
  },
  {
    name: "Royal Caribbean",
    aliases: ["royal caribbean international", "royal caribbean", "rccl"],
    domains: ["royalcaribbean.com"]
  },
  {
    name: "MSC",
    aliases: ["msc cruises", "msc"],
    domains: ["msccruises.com", "msccruises.com.au", "msccruises.co.uk"]
  },
  {
    name: "Norwegian",
    aliases: ["norwegian cruise line", "norwegian", "ncl"],
    domains: ["ncl.com"]
  },
  {
    name: "Explora",
    aliases: ["explora journeys", "explora"],
    domains: ["explorajourneys.com"]
  },
  {
    name: "Viking",
    aliases: ["viking ocean cruises", "viking cruises", "viking"],
    domains: ["viking.com", "vikingcruises.com"]
  },
  {
    name: "Hurtigruten",
    aliases: ["hurtigruten"],
    domains: ["hurtigruten.com", "hurtigruten.com.au"]
  },
  {
    name: "Silversea",
    aliases: ["silversea cruises", "silversea"],
    domains: ["silversea.com"]
  },
  {
    name: "Seabourn",
    aliases: ["seabourn"],
    domains: ["seabourn.com"]
  },
  {
    name: "Ponant",
    aliases: ["ponant"],
    domains: ["au.ponant.com", "ponant.com"]
  },
  {
    name: "Carnival",
    aliases: ["carnival cruise line", "carnival cruises", "carnival"],
    domains: ["carnival.com", "carnival.com.au"]
  }
];

const OFFICIAL_DOMAINS = new Set(
  APPROVED_CRUISE_LINES.flatMap((line) => line.domains.map((d) => d.toLowerCase()))
);

const RETAILER_DOMAINS = new Set([
  "cruiseabout.com.au",
  "flightcentre.com.au",
  "cruiseexpress.com.au",
  "cruising.com.au",
  "seacruises.com.au",
  "phionline.com.au",
  "travelmanagers.com.au",
  "helloworld.com.au",
  "cruisecritic.com",
  "cruisemapper.com",
  "cruiseweb.com",
  "icruise.com",
  "vacations.com",
  "cruise.com",
  "cruisedirect.com",
  "cruisecompete.com",
  "sixstarcruises.co.uk",
  "cruise118.com",
  "iglucruise.com",
  "101cruise.com.au"
]);

const BLOCKED_HOST_PARTS = [
  "facebook.com",
  "fb.com",
  "twitter.com",
  "x.com",
  "pinterest.com",
  "youtube.com",
  "youtu.be",
  "reddit.com",
  "quora.com",
  "tiktok.com",
  "instagram.com",
  "linkedin.com",
  "threads.net",
  "medium.com",
  "blogspot.com",
  "wordpress.com",
  "tumblr.com",
  "pocruises.com.au",
  "archive.org",
  "webcache",
  "google.com/search"
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

const DURATION_QUERY = {
  "3-5": "3 to 5 nights",
  "6-8": "6 to 9 nights",
  "9-12": "10 to 14 nights",
  "13-16": "13 to 16 nights",
  "17-plus": "17 nights"
};

const DEPARTURE_LABELS = {
  sydney: "Sydney",
  brisbane: "Brisbane",
  melbourne: "Melbourne",
  perth: "Perth",
  adelaide: "Adelaide",
  auckland: "Auckland",
  anywhere: ""
};

/** @type {Map<string, { expires: number, payload: object }>} */
const searchCache = new Map();
/** @type {Map<string, Promise<object>>} */
const inflight = new Map();
/** @type {Map<string, number[]>} */
const rateBuckets = new Map();

function jsonResponse(statusCode, body, extraHeaders) {
  const isEmpty = body === "" || body == null;
  return {
    statusCode,
    headers: Object.assign(
      {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": isEmpty ? "text/plain" : "application/json",
        "Cache-Control": "no-store"
      },
      extraHeaders || {}
    ),
    body: isEmpty ? "" : JSON.stringify(body)
  };
}

function cleanText(value, max) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max || 200);
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch (_error) {
    return "";
  }
}

function domainAllowed(host) {
  if (!host) return false;
  if (BLOCKED_HOST_PARTS.some((part) => host.includes(part))) return false;
  if (OFFICIAL_DOMAINS.has(host)) return true;
  if (RETAILER_DOMAINS.has(host)) return true;
  for (const domain of OFFICIAL_DOMAINS) {
    if (host === domain || host.endsWith("." + domain)) return true;
  }
  for (const domain of RETAILER_DOMAINS) {
    if (host === domain || host.endsWith("." + domain)) return true;
  }
  return false;
}

function isOfficialHost(host) {
  if (!host) return false;
  for (const domain of OFFICIAL_DOMAINS) {
    if (host === domain || host.endsWith("." + domain)) return true;
  }
  return false;
}

function sourceNameFor(host) {
  if (!host) return "Unknown source";
  const official = APPROVED_CRUISE_LINES.find((line) =>
    line.domains.some((d) => host === d || host.endsWith("." + d))
  );
  if (official) return official.name + " (official)";
  const map = {
    "cruiseabout.com.au": "Cruiseabout",
    "flightcentre.com.au": "Flight Centre",
    "cruiseexpress.com.au": "Cruise Express",
    "cruising.com.au": "Cruising.com.au",
    "seacruises.com.au": "Sea Cruises",
    "cruisecritic.com": "Cruise Critic",
    "cruisemapper.com": "CruiseMapper",
    "cruiseweb.com": "Cruise Web",
    "icruise.com": "iCruise",
    "101cruise.com.au": "101cruise"
  };
  for (const [domain, label] of Object.entries(map)) {
    if (host === domain || host.endsWith("." + domain)) return label;
  }
  return host;
}

function mentionsPoAustralia(text) {
  return /\bp\s*&\s*o\s+cruises?\s+australia\b|\bpocruises\.com\.au\b|\bp&o\s+australia\b/i.test(
    text || ""
  );
}

function findCruiseLine(text, preferredNames) {
  const hay = String(text || "").toLowerCase();
  const preferred = new Set((preferredNames || []).map((n) => String(n).toLowerCase()));
  const ranked = APPROVED_CRUISE_LINES.slice().sort((a, b) => {
    const ap = preferred.has(a.name.toLowerCase()) ? 0 : 1;
    const bp = preferred.has(b.name.toLowerCase()) ? 0 : 1;
    return ap - bp || b.aliases[0].length - a.aliases[0].length;
  });
  for (const line of ranked) {
    for (const alias of line.aliases) {
      const re = new RegExp("\\b" + alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
      if (re.test(hay)) return line.name;
    }
  }
  return null;
}

function extractDurationNights(text) {
  const raw = String(text || "");
  const range = raw.match(/\b(\d{1,2})\s*[-–to]{1,3}\s*(\d{1,2})\s*(?:nights?|nts?)\b/i);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (a >= 2 && a <= 40 && b >= 2 && b <= 40) return a;
  }
  const single = raw.match(/\b(\d{1,2})\s*(?:nights?|nts?)\b/i);
  if (single) {
    const n = Number(single[1]);
    if (n >= 2 && n <= 40) return n;
  }
  const days = raw.match(/\b(\d{1,2})\s*[-–]?\s*days?\b/i);
  if (days) {
    const d = Number(days[1]);
    if (d >= 3 && d <= 41) return d - 1;
  }
  return null;
}

function extractDepartureDate(text, preferYear) {
  const raw = String(text || "");
  const months =
    "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
  const patterns = [
    new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(" + months + ")[, ]+(\\d{4})\\b", "i"),
    new RegExp("\\b(" + months + ")\\s+(\\d{1,2})(?:st|nd|rd|th)?[, ]+(\\d{4})\\b", "i"),
    /\b(\d{4})-(\d{2})-(\d{2})\b/
  ];

  for (const pattern of patterns) {
    const m = raw.match(pattern);
    if (!m) continue;
    let day;
    let monthName;
    let year;
    if (m[0].match(/^\d{4}-/)) {
      year = Number(m[1]);
      const monthNum = Number(m[2]);
      day = Number(m[3]);
      if (!year || !monthNum || !day) continue;
      if (preferYear && year !== Number(preferYear)) continue;
      return formatDisplayDate(day, monthNum, year);
    }
    if (/^\d/.test(m[1])) {
      day = Number(m[1]);
      monthName = m[2];
      year = Number(m[3]);
    } else {
      monthName = m[1];
      day = Number(m[2]);
      year = Number(m[3]);
    }
    const monthNum = monthIndex(monthName);
    if (!monthNum || !day || !year) continue;
    if (preferYear && year !== Number(preferYear)) continue;
    if (day < 1 || day > 31) continue;
    return formatDisplayDate(day, monthNum, year);
  }
  return null;
}

function monthIndex(name) {
  const key = String(name || "")
    .toLowerCase()
    .slice(0, 3);
  const map = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12
  };
  return map[key] || 0;
}

function formatDisplayDate(day, monthNum, year) {
  const month = MONTH_NAMES[monthNum - 1];
  if (!month) return null;
  return `${day} ${month} ${year}`;
}

function extractShip(text, cruiseLine) {
  if (!cruiseLine) return null;
  const raw = String(text || "");
  const line = cruiseLine.toLowerCase();

  const aboard = raw.match(
    /\b(?:aboard|onboard|on board|on)\s+(?:the\s+)?([A-Z][A-Za-z0-9'’.-]+(?:\s+[A-Z][A-Za-z0-9'’.-]+){0,3})\b/
  );
  if (aboard) {
    const candidate = cleanText(aboard[1], 60);
    if (isPlausibleShip(candidate, cruiseLine)) return candidate;
  }

  if (line === "celebrity") {
    const m = raw.match(/\bCelebrity\s+([A-Z][A-Za-z0-9'’.-]+(?:\s+[A-Z][A-Za-z0-9'’.-]+)?)\b/);
    if (m && isPlausibleShip(m[1], cruiseLine)) return cleanText("Celebrity " + m[1], 60);
  }
  if (line === "princess") {
    const m = raw.match(/\b([A-Z][A-Za-z]+)\s+Princess\b/);
    if (m && isPlausibleShip(m[1] + " Princess", cruiseLine)) return cleanText(m[1] + " Princess", 60);
  }
  if (line === "royal caribbean") {
    const m = raw.match(
      /\b((?:Oasis|Allure|Symphony|Wonder|Harmony|Spectrum|Quantum|Anthem|Ovation|Independence|Freedom|Liberty|Navigator|Mariner|Explorer|Adventure|Voyager|Radiance|Serenade|Brilliance|Jewel|Vision|Enchantment|Grandeur|Rhapsody|Vision|Icon|Utopia)\s+of\s+the\s+Seas)\b/i
    );
    if (m) return cleanText(m[1], 60);
  }
  if (line === "holland america") {
    const m = raw.match(/\b(ms|ms\s)?([A-Z][a-z]+)\s+(?:of\s+the\s+)?(?:Amsterdam|Rotterdam|Nieuw|Koningsdam|Eurodam|Zuiderdam|Westerdam|Noordam|Volendam|Zaandam|Oosterdam)\b/i);
    if (m) return cleanText(m[0].replace(/^ms\s*/i, "ms "), 60);
    const m2 = raw.match(
      /\b(Nieuw\s+Amsterdam|Nieuw\s+Statendam|Koningsdam|Eurodam|Zuiderdam|Westerdam|Noordam|Volendam|Zaandam|Oosterdam|Rotterdam|Amsterdam)\b/i
    );
    if (m2) return cleanText(m2[1], 60);
  }
  if (line === "norwegian") {
    const m = raw.match(/\bNorwegian\s+([A-Z][A-Za-z0-9'’.-]+)\b/);
    if (m && isPlausibleShip(m[1], cruiseLine)) return cleanText("Norwegian " + m[1], 60);
  }
  if (line === "msc") {
    const m = raw.match(/\bMSC\s+([A-Z][A-Za-z0-9'’.-]+)\b/);
    if (m && isPlausibleShip(m[1], cruiseLine)) return cleanText("MSC " + m[1], 60);
  }
  if (line === "carnival") {
    const m = raw.match(/\bCarnival\s+([A-Z][A-Za-z0-9'’.-]+)\b/);
    if (m && isPlausibleShip(m[1], cruiseLine)) return cleanText("Carnival " + m[1], 60);
  }

  return null;
}

function isPlausibleShip(name, cruiseLine) {
  const n = cleanText(name, 60);
  if (!n || n.length < 3 || n.length > 50) return false;
  const lower = n.toLowerCase();
  const banned = [
    "cruise",
    "cruises",
    "itinerary",
    "departure",
    "october",
    "november",
    "december",
    "january",
    "february",
    "march",
    "april",
    "june",
    "july",
    "august",
    "september",
    "nights",
    "days",
    "from",
    "package",
    "deal",
    "sale",
    "japan",
    "alaska",
    "caribbean",
    "australia",
    "mediterranean"
  ];
  if (banned.includes(lower)) return false;
  if (cruiseLine && lower === cruiseLine.toLowerCase()) return false;
  if (/^\d/.test(n)) return false;
  return true;
}

function extractDeparturePort(text) {
  const raw = String(text || "");
  const patterns = [
    /\bdepart(?:ing|s|ure)?\s+(?:from\s+)?([A-Z][A-Za-z .'-]{2,40}?)(?=\s+on\b|\s+in\b|\s+\d|,|\.|$)/i,
    /\bfrom\s+([A-Z][A-Za-z .'-]{2,40}?)(?=\s+on\b|\s+to\b|\s+\d|,|\.|$)/i,
    /\bembark(?:ing|s)?\s+(?:in|at|from)\s+([A-Z][A-Za-z .'-]{2,40}?)(?=\s+on\b|\s+\d|,|\.|$)/i
  ];
  for (const pattern of patterns) {
    const m = raw.match(pattern);
    if (!m) continue;
    let port = cleanText(m[1], 40);
    port = port.replace(/\s+(Cruise|Cruises|Ship|Itinerary).*$/i, "").trim();
    if (port.length < 3) continue;
    if (/^(the|a|an|this|your)$/i.test(port)) continue;
    if (MONTH_NAMES.some((month) => month.toLowerCase() === port.toLowerCase())) continue;
    return port;
  }
  return null;
}

function extractPortsOfCall(text) {
  const raw = String(text || "");
  const m = raw.match(/\b(?:ports?(?:\s+of\s+call)?|visiting|calls?\s+at)\s*:?\s*([^.|]{8,160})/i);
  if (!m) return null;
  const parts = m[1]
    .split(/,|·|&| and /i)
    .map((p) => cleanText(p, 40))
    .filter((p) => p.length >= 3 && p.length <= 40)
    .slice(0, 8);
  return parts.length ? parts : null;
}

function timingLabel(input) {
  if (input.timingMode === "exact" && input.startDate) {
    if (input.endDate && input.endDate !== input.startDate) {
      return `${input.startDate} to ${input.endDate}`;
    }
    return input.startDate;
  }
  if (input.month) {
    const name = MONTH_NAMES[Number(input.month) - 1] || "";
    return input.year ? `${name} ${input.year}`.trim() : name;
  }
  if (input.timingMode === "school_holidays") return "school holidays";
  if (input.timingMode === "this_season") return "this season";
  if (input.timingMode === "flexible") return "flexible dates";
  return "";
}

function buildQueries(input) {
  const dest = cleanText(input.destinationName || input.destination, 60);
  const monthName = input.month ? MONTH_NAMES[Number(input.month) - 1] : "";
  const year = input.year ? String(input.year) : "";
  const when =
    input.timingMode === "exact" && input.startDate
      ? cleanText(input.startDate, 40)
      : [monthName, year].filter(Boolean).join(" ");
  const durationPhrase =
    input.durationId && input.durationId !== "flexible"
      ? DURATION_QUERY[input.durationId] || ""
      : "";
  const departureCity =
    input.departure && input.departure !== "anywhere"
      ? DEPARTURE_LABELS[input.departure] || ""
      : "";
  const lines = (input.cruiseLines || []).map((n) => cleanText(n, 40)).filter(Boolean).slice(0, 6);

  const queries = [];
  const push = (q) => {
    const cleaned = cleanText(q, 160);
    if (!cleaned || queries.includes(cleaned) || queries.length >= MAX_BRAVE_QUERIES) return;
    queries.push(cleaned);
  };

  if (when && durationPhrase) {
    push(`${dest} cruises ${when} ${durationPhrase}`);
  } else if (when) {
    push(`${dest} cruises ${when}`);
  } else {
    push(`${dest} cruises itinerary`);
  }

  if (lines[0] && when) push(`${lines[0]} ${dest} cruises ${when}`);
  if (lines[1] && when) push(`${lines[1]} ${dest} cruises ${when}`);

  if (departureCity && when) {
    push(`${departureCity} ${dest} cruise ${when}`);
  } else if (when) {
    push(`${dest} cruise itinerary ${when}${durationPhrase ? " " + durationPhrase : ""}`);
  } else if (durationPhrase) {
    push(`${dest} cruise itinerary ${durationPhrase}`);
  }

  if (queries.length < MAX_BRAVE_QUERIES && lines[2] && when) {
    push(`${lines[2]} ${dest} cruises ${when}`);
  }

  return queries.slice(0, MAX_BRAVE_QUERIES);
}

function clientKey(event) {
  const headers = event.headers || {};
  const forwarded = headers["x-forwarded-for"] || headers["X-Forwarded-For"] || "";
  const ip = String(forwarded).split(",")[0].trim() || headers["client-ip"] || "unknown";
  return cleanText(ip, 80) || "unknown";
}

function allowRequest(key) {
  const now = Date.now();
  const bucket = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (bucket.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(key, bucket);
    return false;
  }
  bucket.push(now);
  rateBuckets.set(key, bucket);
  return true;
}

function cacheKey(input) {
  return JSON.stringify({
    d: input.destination,
    tm: input.timingMode,
    m: input.month,
    y: input.year,
    sd: input.startDate,
    ed: input.endDate,
    dur: input.durationId,
    dep: input.departure,
    lines: (input.cruiseLines || []).slice(0, 6)
  });
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function normaliseRequest(body) {
  if (!body || typeof body !== "object") return { error: "Invalid JSON body." };

  const destination = cleanText(body.destination, 80).toLowerCase();
  if (!destination || !/^[a-z0-9-]{2,80}$/.test(destination)) {
    return { error: "A valid destination slug is required." };
  }

  const destinationName = cleanText(body.destinationName || destination, 80);
  const timingMode = cleanText(body.timingMode, 40);
  const month = body.month ? Number(body.month) : 0;
  const year = body.year ? Number(body.year) : 0;
  const startDate = cleanText(body.startDate, 40);
  const endDate = cleanText(body.endDate, 40);
  const durationId = cleanText(body.durationId, 20);
  const departure = cleanText(body.departure, 40).toLowerCase();
  const styles = Array.isArray(body.styles)
    ? body.styles.map((s) => cleanText(s, 40)).filter(Boolean).slice(0, 12)
    : [];
  let cruiseLines = Array.isArray(body.cruiseLines)
    ? body.cruiseLines.map((s) => cleanText(s, 40)).filter(Boolean)
    : [];
  cruiseLines = cruiseLines.filter((name) =>
    APPROVED_CRUISE_LINES.some((line) => line.name.toLowerCase() === name.toLowerCase())
  );
  if (!cruiseLines.length) {
    cruiseLines = APPROVED_CRUISE_LINES.slice(0, 4).map((l) => l.name);
  }

  if (month && (month < 1 || month > 12)) return { error: "Month must be between 1 and 12." };
  if (year && (year < 2024 || year > 2035)) return { error: "Year is out of supported range." };

  return {
    input: {
      destination,
      destinationName,
      timingMode,
      month: month || null,
      year: year || null,
      startDate: startDate || null,
      endDate: endDate || null,
      durationId: durationId || null,
      departure: departure || null,
      styles,
      cruiseLines,
      forceRefresh: Boolean(body.forceRefresh)
    }
  };
}

async function braveSearch(apiKey, query) {
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(RESULTS_PER_QUERY));
  url.searchParams.set("country", "AU");
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("result_filter", "web");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey
    }
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_error) {
    data = null;
  }

  if (!response.ok) {
    const message =
      (data && (data.message || data.error || data.error_code)) ||
      `Brave Search HTTP ${response.status}`;
    const err = new Error(String(message));
    err.status = response.status;
    throw err;
  }

  return (data && data.web && Array.isArray(data.web.results) ? data.web.results : []) || [];
}

function structureResult(raw, input, dateSearched) {
  const title = cleanText(raw.title, 180);
  const snippetExtra = Array.isArray(raw.extra_snippets)
    ? raw.extra_snippets.join(" ")
    : raw.extra_snippets || "";
  const description = cleanText(raw.description || snippetExtra, 400);
  const url = cleanText(raw.url, 500);
  const host = hostnameOf(url);
  const blob = `${title} ${description}`;

  if (!url || !domainAllowed(host)) return null;
  if (mentionsPoAustralia(blob) || mentionsPoAustralia(url)) return null;

  const cruiseLine =
    findCruiseLine(blob, input.cruiseLines) ||
    (isOfficialHost(host)
      ? APPROVED_CRUISE_LINES.find((line) =>
          line.domains.some((d) => host === d || host.endsWith("." + d))
        )?.name
      : null);

  if (!cruiseLine) return null;

  const destToken = String(input.destinationName || "")
    .toLowerCase()
    .split(/\s+/)[0];
  const destOk =
    !destToken ||
    blob.toLowerCase().includes(destToken) ||
    blob.toLowerCase().includes(String(input.destination || "").replace(/-/g, " "));

  if (!destOk && !isOfficialHost(host)) return null;

  const departureDate = extractDepartureDate(blob, input.year);
  const durationNights = extractDurationNights(blob);
  const ship = extractShip(blob, cruiseLine);
  const departurePort = extractDeparturePort(blob);
  const portsOfCall = extractPortsOfCall(blob);
  const official = isOfficialHost(host);

  let confidence = "LOW";
  const keyFields = [ship, departureDate, durationNights].filter(Boolean).length;
  if (official && ship && departureDate && durationNights) confidence = "HIGH";
  else if ((official || domainAllowed(host)) && cruiseLine && keyFields >= 2) confidence = "MEDIUM";
  else if (cruiseLine && (departureDate || durationNights || ship)) confidence = "LOW";
  else confidence = "LOW";

  if (!departureDate && !durationNights && !ship) {
    /* Too vague — keep only as LOW if destination + line clearly present */
    if (!destOk) return null;
  }

  return {
    cruiseLine,
    ship: ship || "Not confirmed",
    itineraryTitle: title || "Not confirmed",
    departureDate: departureDate || "Not confirmed",
    returnDate: null,
    durationNights: durationNights || null,
    durationLabel: durationNights ? `${durationNights} nights` : "Not confirmed",
    departurePort: departurePort || "Not confirmed",
    destination: input.destinationName || input.destination,
    portsOfCall: portsOfCall,
    sourceName: sourceNameFor(host),
    sourceUrl: url,
    dateSearched,
    confidence,
    official,
    completeness: keyFields + (departurePort ? 1 : 0) + (official ? 2 : 0)
  };
}

function dedupeKey(result) {
  return [
    String(result.cruiseLine || "").toLowerCase(),
    String(result.ship || "").toLowerCase(),
    String(result.departureDate || "").toLowerCase(),
    String(result.durationNights || ""),
    String(result.departurePort || "").toLowerCase()
  ].join("|");
}

function deduplicate(results) {
  const map = new Map();
  for (const result of results) {
    const key = dedupeKey(result);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, result);
      continue;
    }
    if (result.official && !existing.official) {
      map.set(key, result);
      continue;
    }
    if (result.official === existing.official && result.completeness > existing.completeness) {
      map.set(key, result);
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return (rank[a.confidence] - rank[b.confidence]) || b.completeness - a.completeness;
  });
}

async function runSearch(apiKey, input) {
  const queries = buildQueries(input);
  const dateSearched = new Date().toISOString().slice(0, 10);
  const rawResults = [];
  let braveCalls = 0;

  for (const query of queries) {
    const batch = await braveSearch(apiKey, query);
    braveCalls += 1;
    for (const item of batch) rawResults.push(item);
  }

  const structured = [];
  for (const item of rawResults) {
    const row = structureResult(item, input, dateSearched);
    if (row) structured.push(row);
  }

  const unique = deduplicate(structured);
  const primary = unique.filter((r) => r.confidence === "HIGH" || r.confidence === "MEDIUM");
  const other = unique.filter((r) => r.confidence === "LOW");

  console.log(
    JSON.stringify({
      event: "cruise_search",
      destination: input.destination,
      braveCalls,
      rawCount: rawResults.length,
      resultCount: unique.length,
      primaryCount: primary.length,
      otherCount: other.length
    })
  );

  return {
    ok: true,
    dateSearched,
    queriesUsed: queries,
    braveCalls,
    timingLabel: timingLabel(input),
    results: primary.map(publicResult),
    otherResults: other.map(publicResult)
  };
}

function publicResult(result) {
  return {
    cruiseLine: result.cruiseLine,
    ship: result.ship,
    itineraryTitle: result.itineraryTitle,
    departureDate: result.departureDate,
    returnDate: result.returnDate,
    durationNights: result.durationNights,
    durationLabel: result.durationLabel,
    departurePort: result.departurePort,
    destination: result.destination,
    portsOfCall: result.portsOfCall,
    sourceName: result.sourceName,
    sourceUrl: result.sourceUrl,
    dateSearched: result.dateSearched,
    confidence: result.confidence,
    statusLabel: "Currently listed online"
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(204, "");
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return jsonResponse(503, {
      ok: false,
      error: "configuration",
      message:
        "Live cruise search is not configured. Set the BRAVE_SEARCH_API_KEY Netlify environment variable."
    });
  }

  const body = parseBody(event);
  if (body === null) {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body." });
  }

  const normalised = normaliseRequest(body);
  if (normalised.error) {
    return jsonResponse(400, { ok: false, error: normalised.error });
  }

  const { input } = normalised;
  const ipKey = clientKey(event);

  if (!allowRequest(ipKey)) {
    return jsonResponse(429, {
      ok: false,
      error: "rate_limit",
      message: "Too many live searches from this connection. Please try again shortly."
    });
  }

  const key = cacheKey(input);

  if (!input.forceRefresh) {
    const cached = searchCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return jsonResponse(200, Object.assign({}, cached.payload, { cached: true }));
    }
  } else {
    searchCache.delete(key);
  }

  if (inflight.has(key)) {
    try {
      const payload = await inflight.get(key);
      return jsonResponse(200, Object.assign({}, payload, { cached: true }));
    } catch (error) {
      return jsonResponse(502, {
        ok: false,
        error: "search_failed",
        message: "We couldn’t complete the live search just now."
      });
    }
  }

  const job = runSearch(apiKey, input)
    .then((payload) => {
      searchCache.set(key, { expires: Date.now() + CACHE_TTL_MS, payload });
      return payload;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, job);

  try {
    const payload = await job;
    return jsonResponse(200, Object.assign({}, payload, { cached: false }));
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "cruise_search_error",
        destination: input.destination,
        status: error && error.status,
        message: error && error.message ? String(error.message).slice(0, 120) : "unknown"
      })
    );
    return jsonResponse(502, {
      ok: false,
      error: "search_failed",
      message: "We couldn’t complete the live search just now."
    });
  }
};
