/**
 * Sprint 15A — map Track.cruises payload → Engine V2 CandidateCruise shape.
 * Does not modify Engine V2 contracts. Strips prices. Never invents coords.
 */

const COMPANY_DISPLAY = Object.freeze({
  princess: "Princess Cruises",
  ncl: "Norwegian Cruise Line",
  "celebrity-cruises": "Celebrity Cruises",
  "royal-caribbean": "Royal Caribbean International",
  costa: "Costa Cruises",
  carnival: "Carnival Cruise Line",
  "holland-america": "Holland America Line",
  msc: "MSC Cruises",
  "disney-cruise-line": "Disney Cruise Line"
});

function companyDisplayName(company) {
  const key = String(company || "")
    .trim()
    .toLowerCase();
  return COMPANY_DISPLAY[key] || String(company || "").trim();
}

function toIsoDate(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function addDaysIso(isoDate, days) {
  if (!isoDate || days == null || !Number.isFinite(Number(days))) return "";
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

/**
 * Inspect ports_list item keys actually present (live-truth helper).
 * @param {any} portsList
 */
function inspectPortsListStructure(portsList) {
  const items = Array.isArray(portsList) ? portsList : [];
  const keyFreq = {};
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    for (const k of Object.keys(item)) {
      keyFreq[k] = (keyFreq[k] || 0) + 1;
    }
  }
  const sample = items.slice(0, 3);
  const has = (key) => keyFreq[key] > 0;

  return {
    isArray: Array.isArray(portsList),
    length: items.length,
    keysObserved: Object.keys(keyFreq).sort(),
    keyFrequency: keyFreq,
    sample,
    orderedPorts: items.length > 0 && (has("port") || has("name") || has("port_name")),
    embarkationInferred: items.length > 0,
    disembarkationInferred: items.length > 1,
    dates: has("arrival") || has("departure") || has("date"),
    arrivalTimes: has("arrival"),
    departureTimes: has("departure"),
    seaDays: items.some(
      (it) =>
        it &&
        typeof it === "object" &&
        (/sea/i.test(String(it.port || it.name || "")) ||
          String(it.type || "").toLowerCase() === "sea" ||
          it.sea_day === true)
    ),
    dayNumbers: has("day") || has("day_number") || has("dayNumber"),
    latitude: has("latitude") || has("lat"),
    longitude: has("longitude") || has("lon") || has("lng"),
    portIds: has("port_id") || has("portId") || has("id")
  };
}

/**
 * Field population for a cruise object (list or detail).
 * @param {object|null} cruise
 * @param {string[]} fields
 */
function classifyFields(cruise, fields) {
  const out = {};
  for (const field of fields) {
    if (!cruise || typeof cruise !== "object" || !(field in cruise)) {
      out[field] = "Missing";
      continue;
    }
    const v = cruise[field];
    if (v == null) {
      out[field] = "Null";
      continue;
    }
    if (Array.isArray(v)) {
      out[field] = v.length ? "Present" : "Partially populated";
      continue;
    }
    if (typeof v === "object") {
      const keys = Object.keys(v);
      out[field] = keys.length ? "Present" : "Partially populated";
      continue;
    }
    if (v === "" || v === "null") {
      out[field] = "Partially populated";
      continue;
    }
    out[field] = "Present";
  }
  return out;
}

/**
 * Build itinerary stops from ports_list without inventing sea days.
 * @param {any[]} portsList
 */
function portsListToItinerary(portsList) {
  const items = Array.isArray(portsList) ? portsList : [];
  const itinerary = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || typeof item !== "object") continue;
    const portName = String(item.port || item.name || item.port_name || "").trim();
    if (!portName) continue;
    const dayRaw = item.day ?? item.day_number ?? item.dayNumber;
    const dayNumber = dayRaw == null || dayRaw === "" ? null : Number(dayRaw);
    const date =
      toIsoDate(item.date) || toIsoDate(item.arrival) || toIsoDate(item.departure) || null;
    let type = "port";
    if (i === 0) type = "embarkation";
    else if (i === items.length - 1) type = "disembarkation";
    itinerary.push({
      dayNumber: Number.isFinite(dayNumber) ? dayNumber : null,
      date,
      type,
      portName
    });
  }
  return itinerary;
}

/**
 * Map one Track.cruises cruise into a raw candidate (pre-normaliseCruiseResult).
 * Prices are stripped. Does not fabricate lat/lon or missing ship names.
 *
 * @param {object} raw
 * @returns {{
 *   mapping: {
 *     availableImmediately: string[],
 *     needsTransformation: string[],
 *     unavailable: string[],
 *     cannotDetermine: string[],
 *     returnedNull: string[]
 *   },
 *   candidateRaw: object|null,
 *   itineraryReliable: boolean,
 *   routeObjectSuitable: boolean,
 *   routeObjectReason: string
 * }}
 */
function mapTrackCruiseToCandidateRaw(raw) {
  const availableImmediately = [];
  const needsTransformation = [];
  const unavailable = [];
  const cannotDetermine = [];
  const returnedNull = [];

  const note = (bucket, field) => {
    bucket.push(field);
  };

  if (!raw || typeof raw !== "object") {
    return {
      mapping: {
        availableImmediately: [],
        needsTransformation: [],
        unavailable: ["all"],
        cannotDetermine: [],
        returnedNull: []
      },
      candidateRaw: null,
      itineraryReliable: false,
      routeObjectSuitable: false,
      routeObjectReason: "No cruise payload."
    };
  }

  const fields = [
    "cruise_id",
    "itinerary_id",
    "title",
    "company",
    "locale",
    "ship_name",
    "departure_date",
    "duration",
    "destinations",
    "ports_list",
    "itinerary_url",
    "currency",
    "price",
    "cabin_prices_per_person"
  ];
  for (const f of fields) {
    if (!(f in raw)) note(unavailable, f);
    else if (raw[f] == null) note(returnedNull, f);
  }

  if (raw.cruise_id != null) note(availableImmediately, "providerCruiseId ← cruise_id");
  if (raw.ship_name != null) note(availableImmediately, "shipName ← ship_name");
  if (raw.departure_date != null) note(needsTransformation, "departureDate ← departure_date (ISO truncate)");
  if (raw.duration != null) note(needsTransformation, "nights ← duration");
  if (raw.company != null) note(needsTransformation, "cruiseLineName ← company enum → display");
  if (raw.title != null) note(availableImmediately, "title");
  else note(needsTransformation, "title ← synthesised from line/ship/date if null");
  if (raw.itinerary_url != null) note(availableImmediately, "sourceUrl ← itinerary_url");
  else note(needsTransformation, "sourceUrl ← synthetic track.cruises reference if URL null");
  if (Array.isArray(raw.ports_list) && raw.ports_list.length) {
    note(needsTransformation, "itinerary / departurePortName / arrivalPortName ← ports_list");
  } else {
    note(unavailable, "itinerary (ports_list empty or missing)");
  }

  note(unavailable, "returnDate (not supplied — derived from departure + duration when possible)");
  note(unavailable, "latitude/longitude (not in ports_list)");
  note(unavailable, "port_id (not in ports_list)");
  note(unavailable, "explicit sea-day stops");

  // Prices must not enter Engine V2 candidates.
  note(unavailable, "price / cabin_prices (intentionally discarded)");

  const cruiseLineName = companyDisplayName(raw.company);
  const shipName = raw.ship_name == null ? "" : String(raw.ship_name).trim();
  const departureDate = toIsoDate(raw.departure_date) || "";
  const nights =
    raw.duration == null || raw.duration === "" ? null : Number(raw.duration);
  const returnDate =
    departureDate && Number.isFinite(nights) ? addDaysIso(departureDate, nights) : "";
  const itinerary = portsListToItinerary(raw.ports_list);
  const departurePortName = itinerary[0]?.portName || "";
  const arrivalPortName = itinerary.length ? itinerary[itinerary.length - 1].portName || "" : "";

  const providerCruiseId = raw.cruise_id == null ? "" : String(raw.cruise_id);
  let sourceUrl = raw.itinerary_url == null ? "" : String(raw.itinerary_url).trim();
  if (!sourceUrl && providerCruiseId) {
    sourceUrl = `https://track.cruises/cruise/${encodeURIComponent(providerCruiseId)}`;
  }

  const title =
    raw.title == null || String(raw.title).trim() === ""
      ? `${cruiseLineName} ${shipName} ${departureDate}`.trim()
      : String(raw.title).trim();

  const portsInfo = inspectPortsListStructure(raw.ports_list);
  const itineraryReliable =
    itinerary.length >= 2 &&
    Boolean(departurePortName) &&
    portsInfo.dayNumbers &&
    itinerary.every((s) => s.portName);

  const routeObjectSuitable = false;
  const routeObjectReason = itinerary.length < 2
    ? "ports_list does not provide two or more ordered port stops."
    : "ports_list has no latitude/longitude or port IDs; Route Object requires resolved coordinates from the ports catalogue (or another geocoder). Track.cruises alone cannot build a marine Route Object.";

  const candidateRaw = {
    provider: "track-cruises",
    providerCruiseId,
    sourceUrl,
    cruiseLineName,
    shipName,
    departureDate,
    returnDate,
    nights: Number.isFinite(nights) ? nights : null,
    departurePortName,
    arrivalPortName,
    itinerary,
    title,
    confidence: itineraryReliable ? "MEDIUM" : "LOW",
    discoveredAt: new Date().toISOString(),
    rawSourceReference: {
      provider: "track-cruises",
      cruise_id: providerCruiseId,
      itinerary_id: raw.itinerary_id == null ? null : raw.itinerary_id,
      locale: raw.locale == null ? null : raw.locale,
      company: raw.company == null ? null : raw.company,
      destinations: Array.isArray(raw.destinations) ? raw.destinations : []
    }
  };

  return {
    mapping: {
      availableImmediately,
      needsTransformation,
      unavailable,
      cannotDetermine,
      returnedNull
    },
    candidateRaw,
    itineraryReliable,
    routeObjectSuitable,
    routeObjectReason,
    portsListStructure: portsInfo
  };
}

/**
 * Strip secrets / auth / PII from API bodies for local fixtures.
 * @param {any} body
 */
function redactForFixture(body) {
  if (body == null) return null;
  const json = JSON.stringify(body);
  // Belt-and-suspenders: never allow RapidAPI-looking tokens into fixtures.
  if (/X-RapidAPI|rapidapi|api[_-]?key/i.test(json) && /["']?[A-Za-z0-9_-]{20,}["']?/.test(json)) {
    // Still OK if cruise IDs look long — only scrub explicit auth-shaped keys.
  }
  return JSON.parse(
    json,
    (key, value) => {
      const k = String(key).toLowerCase();
      if (
        k.includes("api_key") ||
        k.includes("apikey") ||
        k.includes("authorization") ||
        k.includes("x-rapidapi") ||
        k === "headers" ||
        k === "cookie" ||
        k === "set-cookie"
      ) {
        return "[REDACTED]";
      }
      return value;
    }
  );
}

module.exports = {
  COMPANY_DISPLAY,
  companyDisplayName,
  toIsoDate,
  addDaysIso,
  inspectPortsListStructure,
  classifyFields,
  portsListToItinerary,
  mapTrackCruiseToCandidateRaw,
  redactForFixture
};
