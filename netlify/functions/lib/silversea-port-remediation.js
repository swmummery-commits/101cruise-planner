/**
 * Silversea Classic port remediation — approved alias manifest and classification helpers.
 * CSV aliases are applied via scripts/apply-silversea-port-reference-data.mjs.
 */

const { normaliseName } = require("./cruise-finder-v2/enrichment/match-entities");
const { resolveRawPortText } = require("./discovery-departure-port");

/** Deterministic Silversea-only label overrides (after shared resolver fails). */
const SILVERSEA_ADAPTER_PORT_ALIASES = Object.freeze({
  "kochi": "Kochi Japan",
  "vik": "Vik Norway",
  "st john": "St John USVI"
});

/**
 * High-confidence catalogue alias additions (canonical_name → new aliases).
 * Evidence includes Silversea port codes where available.
 */
const APPROVED_CATALOGUE_ALIAS_WRITES = Object.freeze([
  {
    canonical_name: "Moorea",
    aliases: ["Moorea Island"],
    source_port_code: "PFMOZ",
    country: "French Polynesia",
    evidence: "Silversea PFMOZ is Moorea; catalogue canonical Moorea already exists.",
    confidence: "high",
    affected_classic_sailings_estimate: 56
  },
  {
    canonical_name: "St Johns Antigua",
    aliases: ["St. John's"],
    source_port_code: "AGSJO",
    country: "Antigua and Barbuda",
    evidence: "Silversea AGSJO is St John's, Antigua — not Newfoundland.",
    confidence: "high",
    affected_classic_sailings_estimate: 39
  },
  {
    canonical_name: "St Georges Grenada",
    aliases: ["St George's"],
    source_port_code: "GDSTG",
    country: "Grenada",
    evidence: "Silversea GDSTG omits country suffix; canonical St Georges Grenada exists.",
    confidence: "high",
    affected_classic_sailings_estimate: 26
  },
  {
    canonical_name: "New York",
    aliases: ["Bayonne, New Jersey"],
    source_port_code: "USBYN",
    country: "United States",
    evidence: "USBYN is Cape Liberty cruise terminal (Bayonne NJ), NYC embark area.",
    confidence: "high",
    affected_classic_sailings_estimate: 6
  },
  {
    canonical_name: "Messina",
    aliases: ["Giardini Naxos (Sicily)", "Giardini Naxos"],
    source_port_code: "ITTAO",
    country: "Italy",
    evidence: "ITTAO is Taormina/Giardini Naxos; Messina already carries Taormina alias.",
    confidence: "high",
    affected_classic_sailings_estimate: 58
  },
  {
    canonical_name: "Raiatea",
    aliases: ["Motu Taha'a"],
    source_port_code: "PFMTH",
    country: "French Polynesia",
    evidence: "PFMTH is Tahaa (Motu Taha'a); Raiatea is the paired island port in catalogue.",
    confidence: "high",
    affected_classic_sailings_estimate: 47
  },
  {
    canonical_name: "Panama Canal Gatun Lake",
    aliases: ["Panama Canal (Transit)", "Cruising Panama Canal", "Panama Canal Transit"],
    source_port_code: "PAC81",
    country: "Panama",
    evidence: "Silversea canal-day labels; canonical Panama Canal Gatun Lake already exists.",
    confidence: "high",
    affected_classic_sailings_estimate: 30
  }
]);

const NON_PORT_SCENIC_PATTERNS = Object.freeze([
  /^tracy arm\b/i,
  /^icy bay\b/i,
  /\bcanal transit\b/i,
  /\bstrait passage\b/i,
  /\bfjord\s*&\s*glacier\b/i,
  /^suez canal transit\b/i,
  /\bcape cod canal\b/i,
  /\binside passage\b/i,
  /\bscenic cruising\b/i,
  /\bfjord cruising\b/i
]);

const EXPEDITION_GEO_EXCLUDE = Object.freeze([
  /\bantarctic\b/i,
  /\bdrake passage\b/i,
  /\bsouth shetland\b/i,
  /\bgal[aá]pagos landing\b/i,
  /\bexpedition anchorage\b/i,
  /\blanding site\b/i
]);

function isNonPortScenicItineraryLabel(portName) {
  const name = String(portName || "").trim();
  if (!name) return false;
  return NON_PORT_SCENIC_PATTERNS.some((pattern) => pattern.test(name));
}

function isExpeditionGeographyLabel(portName) {
  const name = String(portName || "").trim();
  if (!name) return false;
  return EXPEDITION_GEO_EXCLUDE.some((pattern) => pattern.test(name));
}

function portIdentityKey(sourceName, sourceCode) {
  return `${normaliseName(sourceName || "")}|${String(sourceCode || "").toUpperCase()}`;
}

function classifyUnresolvedPortIdentity(entry, ports = []) {
  const name = String(entry?.source_name || entry?.name || "").trim();
  const code = String(entry?.source_code || entry?.code || "").trim().toUpperCase();
  if (!name && !code) return "AMBIGUOUS";

  if (isNonPortScenicItineraryLabel(name)) return "NON_PORT_ITINERARY_ENTRY";
  if (isExpeditionGeographyLabel(name)) return "NON_PORT_ITINERARY_ENTRY";

  const approved = APPROVED_CATALOGUE_ALIAS_WRITES.find((row) =>
    row.aliases.some((alias) => normaliseName(alias) === normaliseName(name))
  );
  if (approved) return "EXISTING_CANONICAL_ALIAS";

  const adapterAlias = SILVERSEA_ADAPTER_PORT_ALIASES[name.toLowerCase()];
  if (adapterAlias) return "EXISTING_CANONICAL_ALIAS";

  if (name.toLowerCase() === "hubbard glacier") return "EXISTING_ALIAS_ALREADY_PRESENT_BUT_RESOLVER_FAILURE";

  const resolution = resolveRawPortText(name);
  if (resolution.status === "resolved") return "EXISTING_ALIAS_ALREADY_PRESENT_BUT_RESOLVER_FAILURE";
  if (resolution.status === "ambiguous") return "AMBIGUOUS";

  const catalogueHit = (ports || []).find((port) => {
    const labels = [port.canonical_name, port.display_name, ...(port.aliases || [])];
    return labels.some((label) => normaliseName(label) === normaliseName(name));
  });
  if (catalogueHit) return "EXISTING_ALIAS_ALREADY_PRESENT_BUT_RESOLVER_FAILURE";

  return "NEW_CANONICAL_PORT_REQUIRED";
}

function groupUnresolvedPortOccurrences(occurrences) {
  const byKey = new Map();
  for (const row of occurrences || []) {
    const key = portIdentityKey(row.source_name || row.name, row.source_code || row.code);
    if (!byKey.has(key)) {
      byKey.set(key, {
        source_name: row.source_name || row.name || null,
        source_code: row.source_code || row.code || null,
        normalized_name: normaliseName(row.source_name || row.name || ""),
        roles: new Set(),
        affected_sailing_ids: new Set(),
        occurrences: 0,
        example_cruise_codes: [],
        example_urls: [],
        destinations: new Set()
      });
    }
    const bucket = byKey.get(key);
    bucket.occurrences += 1;
    if (row.role) bucket.roles.add(row.role);
    if (row.official_sailing_id) bucket.affected_sailing_ids.add(row.official_sailing_id);
    if (row.destination) bucket.destinations.add(row.destination);
    if (bucket.example_cruise_codes.length < 5 && row.official_sailing_id) {
      bucket.example_cruise_codes.push(row.official_sailing_id);
    }
    if (bucket.example_urls.length < 3 && row.official_url) {
      bucket.example_urls.push(row.official_url);
    }
  }

  return [...byKey.values()]
    .map((row) => ({
      source_name: row.source_name,
      source_code: row.source_code,
      normalized_name: row.normalized_name,
      roles: [...row.roles],
      affected_sailings: row.affected_sailing_ids.size,
      occurrences: row.occurrences,
      example_cruise_codes: row.example_cruise_codes,
      example_urls: row.example_urls,
      destinations: [...row.destinations]
    }))
    .sort((a, b) => b.affected_sailings - a.affected_sailings || normaliseName(a.source_name).localeCompare(normaliseName(b.source_name)));
}

module.exports = {
  SILVERSEA_ADAPTER_PORT_ALIASES,
  APPROVED_CATALOGUE_ALIAS_WRITES,
  NON_PORT_SCENIC_PATTERNS,
  isNonPortScenicItineraryLabel,
  isExpeditionGeographyLabel,
  portIdentityKey,
  classifyUnresolvedPortIdentity,
  groupUnresolvedPortOccurrences
};
