/**
 * Discovery — departure port extraction, validation and canonical resolution.
 * Single contract for all discovered_cruises writers. Uses data/ports/ports-catalogue.csv.
 */

const { normaliseName, loadLocalCatalogues } = require("./cruise-finder-v2/enrichment/match-entities");
const { matchDeparturePort } = require("./cruise-finder-departure-match");

const REGION_BLOCKLIST = new Set(
  [
    "alaska",
    "mediterranean",
    "caribbean",
    "europe",
    "asia",
    "south pacific",
    "pacific",
    "antarctica",
    "arctic",
    "northern europe",
    "southeast asia",
    "north america",
    "central america",
    "south america",
    "australia",
    "new zealand",
    "japan",
    "africa",
    "indian ocean",
    "bermuda",
    "bahamas",
    "hawaii",
    "panama canal",
    "transatlantic",
    "transpacific",
    "world cruise",
    "northern lights",
    "glacier majesty",
    "japanese grace",
    "the virgin way",
    "inside passage"
  ].map(normaliseName)
);

const MARKETING_BLOCKLIST = new Set(
  ["luxury cruise", "grand journey", "expedition", "cruise escape", "bucket list", "preview", "details"].map(
    normaliseName
  )
);

let cachedPorts = null;

function loadPortsCatalogue() {
  if (cachedPorts) return cachedPorts;
  cachedPorts = loadLocalCatalogues().ports || [];
  return cachedPorts;
}

function resetPortsCache() {
  cachedPorts = null;
}

function cleanPortFragment(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Prose tokens that indicate a string is not a structural port route pair. */
const ROUTE_PAIR_PROSE_RE =
  /\b(cruise|voyage|journey|expedition|itinerary|welcome|through|with|during|aboard|sailing|explore|discover|days|nights|from the|to the)\b/i;

/** Trailing Azamara marketing suffixes on route endpoints (not part of port names). */
const ROUTE_PAIR_MARKETING_SUFFIX_RE = /\s+(?:GRAND VOYAGE|COMBINATION CRUISE)\s*$/i;

/** Normalise vendor port labels before catalogue lookup. */
const DISCOVERY_PORT_SYNONYMS = Object.freeze({
  "new york city": "New York",
  "gran canaria": "Las Palmas",
  "panama city fuerte amador": "Panama City",
  "fuerte amador": "Panama City"
});

function stripRoutePairMarketingSuffix(value) {
  return cleanPortFragment(String(value || "").replace(ROUTE_PAIR_MARKETING_SUFFIX_RE, ""));
}

function applyDiscoveryPortSynonym(value) {
  const raw = cleanPortFragment(value);
  if (!raw) return raw;
  const norm = normaliseName(raw);
  return DISCOVERY_PORT_SYNONYMS[norm] || raw;
}

/**
 * When source text is a structural route pair "X to Y", return embark port X.
 * Returns input unchanged when not a route pair (avoids splitting arbitrary prose).
 */
function parseRouteEmbarkPort(rawValue) {
  const raw = stripRoutePairMarketingSuffix(rawValue);
  if (!raw) return raw;
  const route = raw.match(
    /^([A-Z0-9][A-Za-z0-9 .'()/&-]{1,70}?)\s+to\s+([A-Z0-9][A-Za-z0-9 .'()/&-]{1,70})$/i
  );
  if (!route) return raw;
  const from = cleanPortFragment(route[1]);
  const to = cleanPortFragment(route[2]);
  if (!from || !to) return raw;
  if (ROUTE_PAIR_PROSE_RE.test(from) || ROUTE_PAIR_PROSE_RE.test(to)) return raw;
  if (from.length < 3 || to.length < 3) return raw;
  return from;
}

function parseRoutePortPair(rawValue) {
  const raw = stripRoutePairMarketingSuffix(rawValue);
  if (!raw) return null;
  const route = raw.match(
    /^([A-Z0-9][A-Za-z0-9 .'()/&-]{1,70}?)\s+to\s+([A-Z0-9][A-Za-z0-9 .'()/&-]{1,70})$/i
  );
  if (!route) return null;
  const from = cleanPortFragment(route[1]);
  const to = cleanPortFragment(route[2]);
  if (!from || !to) return null;
  if (ROUTE_PAIR_PROSE_RE.test(from) || ROUTE_PAIR_PROSE_RE.test(to)) return null;
  return { from, to };
}

function isRejectedPortText(value, context = {}) {
  const raw = cleanPortFragment(value);
  if (!raw) return { rejected: true, reason: "empty" };
  const norm = normaliseName(raw);
  if (norm.length < 2) return { rejected: true, reason: "too_short" };
  if (REGION_BLOCKLIST.has(norm)) return { rejected: true, reason: "region_or_theme" };
  if (MARKETING_BLOCKLIST.has(norm)) return { rejected: true, reason: "marketing_text" };
  if (/\b(cruise|voyage|journey|expedition|itinerary|majesty|grace|escape)\b/i.test(raw) && !/,/.test(raw)) {
    return { rejected: true, reason: "promotional_phrase" };
  }

  const shipNames = []
    .concat(context.shipNames || [])
    .concat(context.shipName ? [context.shipName] : [])
    .map(normaliseName)
    .filter(Boolean);
  if (shipNames.includes(norm)) return { rejected: true, reason: "ship_name" };

  const destinationName = normaliseName(context.destinationName || "");
  if (destinationName && norm === destinationName) {
    return { rejected: true, reason: "destination_region" };
  }

  return { rejected: false, reason: null };
}

function resolveRawPortText(rawValue, context = {}) {
  const raw = applyDiscoveryPortSynonym(parseRouteEmbarkPort(cleanPortFragment(rawValue)));
  if (!raw) {
    return {
      rawValue: raw,
      canonicalPortId: null,
      canonicalPortName: null,
      confidence: null,
      status: "missing",
      reason: "Missing departure port value",
      sourceField: context.sourceField || null
    };
  }

  const rejection = isRejectedPortText(raw, context);
  if (rejection.rejected) {
    return {
      rawValue: raw,
      canonicalPortId: null,
      canonicalPortName: null,
      confidence: null,
      status: "invalid",
      reason: `Invalid non-port text (${rejection.reason})`,
      sourceField: context.sourceField || null
    };
  }

  const ports = context.ports || loadPortsCatalogue();
  const match = matchDeparturePort(raw, ports);
  if (match.status === "MATCHED") {
    const port = ports.find((p) => p.canonical_name === match.matchedName);
    return {
      rawValue: raw,
      canonicalPortId: port?.id || null,
      canonicalPortName: match.matchedName,
      confidence: match.via === "alias" ? "alias" : "exact",
      status: "resolved",
      reason: null,
      sourceField: context.sourceField || null
    };
  }
  if (match.status === "AMBIGUOUS") {
    return {
      rawValue: raw,
      canonicalPortId: null,
      canonicalPortName: null,
      confidence: null,
      status: "ambiguous",
      reason: "Ambiguous departure port match",
      sourceField: context.sourceField || null,
      candidates: match.candidates || []
    };
  }

  return {
    rawValue: raw,
    canonicalPortId: null,
    canonicalPortName: null,
    confidence: null,
    status: "invalid",
    reason: "Could not resolve to a canonical port",
    sourceField: context.sourceField || null
  };
}

function extractFromTitleRoute(title) {
  const raw = String(title || "").trim();
  if (!raw) return null;
  const route = raw.match(/\s[-–|]\s*(.+?)\s+to\s+(.+?)(?:\s+on\b|\||$)/i);
  if (!route) return null;
  const from = cleanPortFragment(route[1]);
  if (!from) return null;
  return { value: from, sourceField: "title.route_from" };
}

function extractFromRoutePair(text, sourceFieldPrefix) {
  const blob = String(text || "");
  if (!blob.trim()) return null;
  const patterns = [
    /\bfrom\s+([A-Z0-9][A-Za-z0-9 .'()/&-]{2,70}?)\s+to\s+([A-Z0-9][A-Za-z0-9 .'()/&-]{2,70})(?:\s+on\b|[.,]|$)/i,
    /\bFROM\s+([A-Z0-9][A-Za-z0-9 .'()/&-]{2,70}?)\s+TO\s+([A-Z0-9][A-Za-z0-9 .'()/&-]{2,70})(?:\s+ON\b|[.,]|$)/
  ];
  for (const re of patterns) {
    const match = blob.match(re);
    if (!match) continue;
    const from = cleanPortFragment(match[1]);
    if (!from) continue;
    return { value: from, sourceField: `${sourceFieldPrefix}.route_pair`, routeTo: cleanPortFragment(match[2]) };
  }
  return null;
}

function extractFromStrongPhrases(text, sourceFieldPrefix) {
  const blob = String(text || "");
  if (!blob.trim()) return null;
  const patterns = [
    { re: /\bsailing from\s+([A-Z0-9][^.\n]{2,80}?)(?:\s+via\b|\s+on\b|[.,]|$)/i, field: "sailing_from" },
    { re: /\bdeparting from\s+([A-Z0-9][^.\n]{2,80}?)(?:\s+on\b|[.,]|$)/i, field: "departing_from" },
    { re: /\bembark(?:ation)?\s+(?:in|at|from)\s+([A-Z0-9][^.\n]{2,80}?)(?:\s+on\b|[.,]|$)/i, field: "embarkation" },
    { re: /\bsetting sail from\s+([A-Z0-9][^.\n]{2,80}?)(?:\s+on\b|[.,]|$)/i, field: "setting_sail_from" },
    {
      re: /\bluxury cruise to .+? from\s+([A-Z0-9][^.\n]{2,80}?)\s+to\b/i,
      field: "description_cruise_from"
    },
    {
      re: /\b(?:\d{1,2}[- ]?night(?:s)?\s+)?(?:cruise|voyage)\s+from\s+([A-Z0-9][^.\n]{2,80}?)(?:\s+via\b|\s+on\b|\s+to\b|[.,]|$)/i,
      field: "cruise_from"
    }
  ];

  for (const pattern of patterns) {
    const match = blob.match(pattern.re);
    if (!match) continue;
    const value = cleanPortFragment(match[1]);
    if (value) {
      return { value, sourceField: `${sourceFieldPrefix}.${pattern.field}` };
    }
  }
  return null;
}

function extractFromWeakFrom(text, sourceFieldPrefix) {
  const blob = String(text || "");
  const match = blob.match(
    /\b(?:depart(?:s|ing)?|sails?|roundtrip from|round trip from)\s+(?:the\s+port\s+of\s+)?([A-Z][A-Za-z0-9 .'()-]{2,60})(?:\s*[|,.]|\s+on\b|\s+to\b|$)/
  );
  if (!match) return null;
  const value = cleanPortFragment(match[1]);
  if (!value) return null;
  return { value, sourceField: `${sourceFieldPrefix}.weak_from` };
}

function extractFromEmbarkationStop(stops) {
  if (!Array.isArray(stops)) return null;
  for (const stop of stops) {
    const label = String(stop?.label || stop?.name || stop?.port || "").trim();
    const role = String(stop?.role || stop?.type || stop?.kind || "").toLowerCase();
    const day = Number(stop?.day || stop?.day_number || 0);
    const evidence = String(stop?.evidence || stop?.note || "").toLowerCase();
    const embark =
      /embark|depart|start/.test(role) ||
      /embark|depart|starts in|sails from/.test(evidence) ||
      (day === 1 && /embark|depart|start/.test(label.toLowerCase()));
    if (!embark || !label) continue;
    return { value: cleanPortFragment(label), sourceField: "itinerary.embarkation_stop" };
  }
  return null;
}

function extractDepartureCandidates(source = {}) {
  const candidates = [];
  const push = (item) => {
    if (!item?.value) return;
    candidates.push(item);
  };

  push(extractFromTitleRoute(source.title));
  push(extractFromRoutePair(source.description, "description"));
  push(extractFromRoutePair(source.excerpt, "excerpt"));
  push(extractFromRoutePair(source.title, "title"));
  push(extractFromStrongPhrases(source.description, "description"));
  push(extractFromStrongPhrases(source.excerpt, "excerpt"));
  push(extractFromStrongPhrases(source.title, "title"));
  push(extractFromEmbarkationStop(source.itineraryStops));
  push(extractFromWeakFrom(source.description, "description"));
  push(extractFromWeakFrom(source.excerpt, "excerpt"));
  push(extractFromWeakFrom(source.title, "title"));

  const seen = new Set();
  return candidates.filter((item) => {
    const key = normaliseName(item.value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveDepartureFromSource(source = {}) {
  const context = {
    shipNames: source.shipNames || source.ship_name_guesses || [],
    shipName: source.shipName || source.matchedShipName || null,
    destinationName: source.destinationName || source.destination_name || null
  };

  const candidates = extractDepartureCandidates(source);
  if (!candidates.length) {
    return {
      rawValue: null,
      canonicalPortId: null,
      canonicalPortName: null,
      confidence: null,
      status: "missing",
      reason: "Missing departure port",
      sourceField: null,
      attempted: []
    };
  }

  const attempted = [];
  for (const candidate of candidates) {
    const resolved = resolveRawPortText(candidate.value, {
      ...context,
      sourceField: candidate.sourceField
    });
    attempted.push(resolved);
    if (resolved.status === "resolved") return { ...resolved, attempted };
    if (resolved.status === "ambiguous") return { ...resolved, attempted };
  }

  return { ...attempted[0], attempted };
}

function isCustomerReadyDeparture(meta) {
  return Boolean(meta && meta.status === "resolved" && meta.canonicalPortName);
}

function departureReviewLabel(meta) {
  if (!meta) return "Missing departure port";
  if (meta.status === "missing") return "Missing departure port";
  if (meta.status === "invalid") return "Invalid departure value";
  if (meta.status === "ambiguous") return "Ambiguous departure port";
  if (meta.status !== "resolved") return "Departure requires review";
  return null;
}

function validateDepartureForCandidate(candidate) {
  const meta =
    candidate.departure_port_meta ||
    candidate.raw_extract?.departure_port_meta ||
    resolveDepartureFromSource({
      title: candidate.raw_extract?.title,
      description: candidate.raw_extract?.description,
      excerpt: candidate.raw_extract?.excerpt,
      shipNames: candidate.raw_extract?.ship_name_guesses,
      shipName: candidate.ship_name || candidate.matched_ship?.name,
      destinationName: candidate.destination_name || candidate.matched_destination?.name,
      itineraryStops: candidate.itinerary_stops || candidate.raw_extract?.itinerary_stops
    });

  const reasons = [];
  if (meta.status === "missing") reasons.push("Missing departure port");
  else if (meta.status === "invalid") {
    reasons.push(`Invalid departure value: ${meta.rawValue || candidate.departure_port || "unknown"}`);
  } else if (meta.status === "ambiguous") reasons.push("Ambiguous departure port");
  else if (!isCustomerReadyDeparture(meta)) reasons.push("Departure port requires review");

  return { reasons, meta };
}

const CONFIDENCE_RANK = { exact: 3, alias: 2, structured: 1 };

function mergeDeparturePortForUpsert(existing = {}, incoming = {}) {
  const prevMeta = existing.raw_extract?.departure_port_meta || {};
  const incMeta = incoming.departure_port_meta || incoming.raw_extract?.departure_port_meta || {};
  const prevResolved = isCustomerReadyDeparture(prevMeta) && existing.departure_port;
  const incResolved = isCustomerReadyDeparture(incMeta) && incoming.departure_port;

  if (prevMeta.manual && !incoming.departure_port_manual_override) {
    return {
      departure_port: existing.departure_port,
      departure_port_meta: prevMeta,
      blocked: true,
      reason: "manual_correction_protected"
    };
  }

  if (prevResolved && !incResolved) {
    return {
      departure_port: existing.departure_port,
      departure_port_meta: prevMeta,
      blocked: true,
      reason: "valid_not_overwritten_by_unresolved"
    };
  }

  if (prevResolved && incResolved) {
    const prevRank = CONFIDENCE_RANK[prevMeta.confidence] || 0;
    const incRank = CONFIDENCE_RANK[incMeta.confidence] || 0;
    if (incRank >= prevRank) {
      return {
        departure_port: incoming.departure_port,
        departure_port_meta: incMeta,
        blocked: false,
        reason: "valid_canonical_update"
      };
    }
    return {
      departure_port: existing.departure_port,
      departure_port_meta: prevMeta,
      blocked: true,
      reason: "lower_confidence_update_rejected"
    };
  }

  return {
    departure_port: incResolved ? incoming.departure_port : null,
    departure_port_meta: incMeta,
    blocked: false,
    reason: incResolved ? "new_valid_departure" : "unresolved_departure"
  };
}

function applyDepartureResolutionToCandidate(candidate, source = {}) {
  const meta = resolveDepartureFromSource({
    title: source.title ?? candidate.raw_extract?.title,
    description: source.description ?? candidate.raw_extract?.description,
    excerpt: source.excerpt ?? candidate.raw_extract?.excerpt,
    shipNames: candidate.raw_extract?.ship_name_guesses || candidate.ship_name_guesses,
    shipName: candidate.ship_name || candidate.matched_ship?.name,
    destinationName: candidate.destination_name || candidate.matched_destination?.name,
    itineraryStops: candidate.itinerary_stops || candidate.raw_extract?.itinerary_stops
  });

  return {
    ...candidate,
    departure_port: meta.status === "resolved" ? meta.canonicalPortName : null,
    departure_port_meta: meta,
    raw_extract: {
      ...(candidate.raw_extract || {}),
      departure_port_meta: meta,
      departure_port_raw: meta.rawValue || null
    }
  };
}

function classifyStoredDeparture(row, ports) {
  const current = String(row?.departure_port || "").trim();
  const meta = row?.raw_extract?.departure_port_meta || null;

  if (meta?.manual && meta.status === "resolved") {
    return { classification: "manually_corrected", meta, current };
  }
  if (!current) {
    const reResolved = resolveDepartureFromSource({
      title: row?.raw_extract?.title,
      description: row?.raw_extract?.description,
      excerpt: row?.raw_extract?.excerpt,
      shipNames: row?.raw_extract?.ship_name_guesses,
      destinationName: row?.destination_name
    });
    return {
      classification: reResolved.status === "resolved" ? "structured_source_but_unresolved" : "missing",
      meta: reResolved,
      current: null,
      proposed: reResolved
    };
  }

  const resolved = resolveRawPortText(current, {
    destinationName: row?.destination_name,
    shipNames: row?.raw_extract?.ship_name_guesses
  });
  if (resolved.status === "resolved") {
    return {
      classification: resolved.confidence === "alias" ? "canonical_alias" : "canonical_exact",
      meta: resolved,
      current,
      proposed: resolved
    };
  }
  if (resolved.status === "ambiguous") {
    return { classification: "ambiguous", meta: resolved, current, proposed: resolved };
  }
  if (isRejectedPortText(current, { destinationName: row?.destination_name }).rejected) {
    return { classification: "invalid_non_port_value", meta: resolved, current, proposed: null };
  }
  return { classification: "structured_source_but_unresolved", meta: resolved, current, proposed: null };
}

function legacyExtractDeparturePort(text) {
  const raw = String(text || "");
  const m = raw.match(
    /\b(?:depart(?:s|ing)?|sails?|from|roundtrip from|round trip from)\s+(?:the\s+port\s+of\s+)?([A-Z][A-Za-z .'-]{2,40})(?:\s*[|,.]|\s+on\b|\s+to\b|$)/
  );
  if (!m) return null;
  const port = m[1].replace(/\s+/g, " ").trim();
  if (port.length < 3 || /^(the|our|your|this|a|an)\b/i.test(port)) return null;
  return port.slice(0, 80);
}

/**
 * Compact departure audit fields for Admin list responses (no full raw_extract).
 */
function compactDepartureAudit(rawExtract = {}, row = {}) {
  const meta = rawExtract?.departure_port_meta || {};
  const merge = rawExtract?.departure_port_merge || null;
  const discovery = rawExtract?.discovery_11d2 || {};
  const hasPort = Boolean(String(row?.departure_port || "").trim());

  return {
    departure_port_raw: rawExtract?.departure_port_raw || meta.rawValue || null,
    departure_port_meta: {
      status: meta.status || (hasPort ? "resolved_legacy" : "missing"),
      reason: meta.reason || null,
      confidence: meta.confidence || null,
      canonicalPortName: meta.canonicalPortName || row?.departure_port || null,
      sourceField: meta.sourceField || null,
      manual: Boolean(meta.manual),
      manual_by: meta.manual_by || null,
      manual_at: meta.manual_at || null
    },
    departure_port_merge: merge,
    validation_status: meta.status || (hasPort ? "resolved_legacy" : "missing"),
    validation_reason: meta.reason || null,
    source_provider: discovery.adapter || null,
    source_method: discovery.source_method || null,
    source_url: row?.official_url || row?.source_url || null
  };
}

module.exports = {
  loadPortsCatalogue,
  resetPortsCache,
  isRejectedPortText,
  parseRouteEmbarkPort,
  parseRoutePortPair,
  stripRoutePairMarketingSuffix,
  applyDiscoveryPortSynonym,
  DISCOVERY_PORT_SYNONYMS,
  resolveRawPortText,
  extractDepartureCandidates,
  resolveDepartureFromSource,
  isCustomerReadyDeparture,
  departureReviewLabel,
  validateDepartureForCandidate,
  mergeDeparturePortForUpsert,
  applyDepartureResolutionToCandidate,
  classifyStoredDeparture,
  legacyExtractDeparturePort,
  compactDepartureAudit
};
