/**
 * Cruise Finder — departure port matching for Discovery catalogue results.
 * Uses canonical ports from data/ports/ports-catalogue.csv (no second port DB).
 */


const {
  normaliseName,
  matchPort,
  loadLocalCatalogues
} = require("./cruise-finder-v2/enrichment/match-entities");

/** Finder questionnaire IDs → catalogue canonical embark ports */
const FINDER_DEPARTURE_PORTS = Object.freeze({
  sydney: { label: "Sydney", canonicalName: "Sydney", country: "AU" },
  brisbane: { label: "Brisbane", canonicalName: "Brisbane", country: "AU" },
  melbourne: { label: "Melbourne", canonicalName: "Melbourne", country: "AU" },
  perth: { label: "Perth", canonicalName: "Fremantle", country: "AU" },
  adelaide: { label: "Adelaide", canonicalName: "Adelaide", country: "AU" },
  auckland: { label: "Auckland", canonicalName: "Auckland", country: "NZ" },
  anywhere: { label: "I'll fly anywhere", flexible: true }
});

const AU_COUNTRY_CODES = new Set(["AU"]);
const NZ_COUNTRY_CODES = new Set(["NZ"]);

let cachedPorts = null;

function portCountryCode(port) {
  const code = String(port?.country_code || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code;
  const name = normaliseName(port?.country || "");
  if (name === "australia") return "AU";
  if (name === "new zealand") return "NZ";
  return code || "";
}

function expandPortCandidates(portText) {
  const raw = String(portText || "").trim();
  if (!raw) return [];
  const candidates = [raw];
  const beforeComma = raw.split(",")[0].trim();
  if (beforeComma && beforeComma !== raw) candidates.push(beforeComma);

  for (const base of [beforeComma, raw]) {
    if (!base) continue;
    const paren = base.match(/^(.+?)\s*\((.+?)\)\s*$/);
    if (paren) {
      candidates.push(paren[1].trim(), paren[2].trim());
    }
  }

  return [...new Set(candidates.filter(Boolean))];
}

function matchDeparturePort(portText, ports) {
  const candidates = expandPortCandidates(portText);
  for (const candidate of candidates) {
    const hit = matchPort(candidate, ports);
    if (hit.status === "MATCHED") return hit;
  }
  return matchPort(portText, ports);
}

function loadPortsCatalogue() {
  if (cachedPorts) return cachedPorts;
  const catalogues = loadLocalCatalogues();
  cachedPorts = (catalogues.ports || []).map((port) =>
    Object.assign({}, port, {
      country_code: portCountryCode(port)
    })
  );
  return cachedPorts;
}

function resetPortsCache() {
  cachedPorts = null;
}

function isFlexibleDeparture(departureId) {
  const id = String(departureId || "")
    .trim()
    .toLowerCase();
  if (!id || id === "anywhere") return true;
  const config = FINDER_DEPARTURE_PORTS[id];
  return Boolean(config && config.flexible);
}

function getDepartureLabel(departureId) {
  const id = String(departureId || "")
    .trim()
    .toLowerCase();
  return (FINDER_DEPARTURE_PORTS[id] && FINDER_DEPARTURE_PORTS[id].label) || departureId || "";
}

function isExcludedCruiseLine(name) {
  const n = normaliseName(name);
  if (!n) return false;
  return n.includes("p o") && (n.includes("australia") || n.includes("australian"));
}

function formatPortLabel(portText) {
  const raw = String(portText || "").trim();
  if (!raw) return "another port";
  const comma = raw.split(",")[0];
  return (comma || raw).trim();
}

function findCataloguePort(canonicalName, ports) {
  const needle = normaliseName(canonicalName);
  return (ports || []).find((port) => normaliseName(port.canonical_name) === needle) || null;
}

function buildDepartureNoMatchMessage(departureId, destinationName) {
  const label = getDepartureLabel(departureId);
  const suffix = destinationName ? " that matches all your choices" : "";
  return `We couldn't find a current cruise departing from ${label}${suffix}.`;
}

/**
 * Classify one sailing's departure port against the Finder departure answer.
 * @returns {{ tier: string, matchCategory: string, departureNote: string|null, matchedCanonical: string|null }}
 */
function classifyDepartureMatch(sailingPortText, departureId, ports) {
  if (isFlexibleDeparture(departureId)) {
    return {
      tier: "flexible",
      matchCategory: "best_match",
      departureNote: null,
      matchedCanonical: null
    };
  }

  const target = FINDER_DEPARTURE_PORTS[String(departureId || "").toLowerCase()];
  if (!target) {
    return {
      tier: "unknown",
      matchCategory: "alternative",
      departureNote: null,
      matchedCanonical: null
    };
  }

  const portMatch = matchDeparturePort(sailingPortText, ports);
  if (portMatch.status !== "MATCHED") {
    return {
      tier: "unknown",
      matchCategory: "alternative",
      departureNote: sailingPortText
        ? `Departure listed as ${formatPortLabel(sailingPortText)}`
        : null,
      matchedCanonical: null
    };
  }

  const matchedCanonical = portMatch.matchedName;
  if (normaliseName(matchedCanonical) === normaliseName(target.canonicalName)) {
    return {
      tier: "exact",
      matchCategory: "best_match",
      departureNote: null,
      matchedCanonical
    };
  }

  const matchedPort = findCataloguePort(matchedCanonical, ports);
  const matchedCountry = portCountryCode(matchedPort);
  const portLabel = formatPortLabel(sailingPortText || matchedCanonical);

  if (target.country === "AU" && AU_COUNTRY_CODES.has(matchedCountry)) {
    return {
      tier: "same_country",
      matchCategory: "also_worth",
      departureNote: `Alternative departure: ${portLabel}`,
      matchedCanonical
    };
  }

  if (target.country === "NZ" && NZ_COUNTRY_CODES.has(matchedCountry)) {
    return {
      tier: "same_country",
      matchCategory: "also_worth",
      departureNote: `Alternative departure: ${portLabel}`,
      matchedCanonical
    };
  }

  return {
    tier: "overseas",
    matchCategory: "alternative",
    departureNote: `Requires travel to ${portLabel}`,
    matchedCanonical
  };
}

function sailingDepartureTimestamp(row) {
  const iso = row?.departureDateIso || row?.departure_date;
  if (iso) {
    const text = String(iso).trim();
    const parsed = Date.parse(text.includes("T") ? text : `${text}T00:00:00Z`);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const display = String(row?.departureDate || "").trim();
  if (display) {
    const parsed = Date.parse(display);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Number.MAX_SAFE_INTEGER;
}

function sortByDepartureDate(a, b) {
  const byDate = sailingDepartureTimestamp(a) - sailingDepartureTimestamp(b);
  if (byDate !== 0) return byDate;
  const byLine = String(a.cruiseLine || "").localeCompare(String(b.cruiseLine || ""), "en", {
    sensitivity: "base"
  });
  if (byLine !== 0) return byLine;
  return String(a.ship || "").localeCompare(String(b.ship || ""), "en", { sensitivity: "base" });
}

/**
 * Split Discovery sailings into Best Match / Also Worth Considering / Alternative Option buckets.
 */
function categorizeResultsByDeparture(results, departureId, options = {}) {
  const ports = options.ports || loadPortsCatalogue();
  const flexible = isFlexibleDeparture(departureId);
  const eligible = (Array.isArray(results) ? results : []).filter(
    (row) => row && !isExcludedCruiseLine(row.cruiseLine)
  );

  if (flexible) {
    const sorted = eligible.slice().sort(sortByDepartureDate);
    return {
      results: sorted.map((row) =>
        Object.assign({}, row, {
          matchCategory: "best_match",
          departureTier: "flexible",
          departureNote: null
        })
      ),
      alsoWorthConsidering: [],
      otherResults: [],
      departureSummary: {
        selected: departureId || "anywhere",
        selectedLabel: getDepartureLabel(departureId || "anywhere"),
        flexible: true,
        exactCount: sorted.length,
        sameCountryCount: 0,
        alternativeCount: 0,
        message: null
      }
    };
  }

  const buckets = {
    exact: [],
    sameCountry: [],
    overseas: []
  };

  for (const row of eligible) {
    const classification = classifyDepartureMatch(row.departurePort, departureId, ports);
    const enriched = Object.assign({}, row, {
      matchCategory: classification.matchCategory,
      departureTier: classification.tier,
      departureNote: classification.departureNote,
      matchedDepartureCanonical: classification.matchedCanonical
    });

    if (classification.tier === "exact") buckets.exact.push(enriched);
    else if (classification.tier === "same_country") buckets.sameCountry.push(enriched);
    else buckets.overseas.push(enriched);
  }

  buckets.exact.sort(sortByDepartureDate);
  buckets.sameCountry.sort(sortByDepartureDate);
  buckets.overseas.sort(sortByDepartureDate);

  const hasAny = buckets.exact.length + buckets.sameCountry.length + buckets.overseas.length > 0;
  const message =
    buckets.exact.length === 0 && hasAny
      ? buildDepartureNoMatchMessage(departureId, options.destinationName)
      : null;

  return {
    results: buckets.exact,
    alsoWorthConsidering: buckets.sameCountry,
    otherResults: buckets.overseas,
    departureSummary: {
      selected: departureId,
      selectedLabel: getDepartureLabel(departureId),
      flexible: false,
      exactCount: buckets.exact.length,
      sameCountryCount: buckets.sameCountry.length,
      alternativeCount: buckets.overseas.length,
      message
    }
  };
}

/**
 * Summarise departure_port coverage for active Discovery rows (audit helper).
 */
function summariseDepartureCoverage(rows, ports) {
  const catalogue = ports || loadPortsCatalogue();
  const stats = {
    total: 0,
    canonicalMatched: 0,
    textOnly: 0,
    noUsableDeparture: 0,
    australianByPort: Object.create(null),
    unknownSamples: []
  };

  for (const row of rows || []) {
    stats.total += 1;
    const text = String(row.departure_port || row.departurePort || "").trim();
    if (!text) {
      stats.noUsableDeparture += 1;
      continue;
    }

    const match = matchDeparturePort(text, catalogue);
    if (match.status === "MATCHED") {
      stats.canonicalMatched += 1;
      const port = findCataloguePort(match.matchedName, catalogue);
      if (port && portCountryCode(port) === "AU") {
        const key = port.canonical_name;
        stats.australianByPort[key] = (stats.australianByPort[key] || 0) + 1;
      }
    } else {
      stats.textOnly += 1;
      if (stats.unknownSamples.length < 8) stats.unknownSamples.push(text);
    }
  }

  return stats;
}

module.exports = {
  FINDER_DEPARTURE_PORTS,
  loadPortsCatalogue,
  resetPortsCache,
  isFlexibleDeparture,
  getDepartureLabel,
  isExcludedCruiseLine,
  classifyDepartureMatch,
  categorizeResultsByDeparture,
  buildDepartureNoMatchMessage,
  summariseDepartureCoverage,
  formatPortLabel,
  matchDeparturePort,
  expandPortCandidates,
  portCountryCode
};
