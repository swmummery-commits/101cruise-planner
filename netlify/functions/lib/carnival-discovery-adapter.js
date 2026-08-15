/**
 * Carnival Cruise Line — read-only Discovery adapter.
 *
 * Official source: AU cruise-search API (itinerary groups with nested sailings[]).
 * GET https://www.carnival.com.au/cruisesearch/api/search
 */

const { canonicalUrl } = require("./cruise-discovery-structured");
const { resolveShipForLine } = require("./discovery-ship-resolver");
const { resolveOperationalDestination } = require("./discovery-destination-resolver");
const { resolveRawPortText } = require("./discovery-departure-port");
const { validateCruise } = require("./cruise-discovery");
const { evaluateDiscoveryConfidence } = require("./discovery-confidence");
const { provesIndividualSailing } = require("./discovery-non-sailing-filter");
const { catalogueDestinations } = require("./holland-america-discovery-adapter");
const {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  SOURCE_ID,
  DEFAULT_BASE_URL,
  fetchCarnivalCatalogue,
  clearCarnivalFetchCache
} = require("./carnival-discovery-source");
const {
  daysUntilDeparture,
  PUBLIC_BOOKING_CUTOFF_DAYS,
  perthCalendarDate
} = require("./public-discovered-cruise-inventory");

/** Official Carnival region codes from AU search API. */
const CCL_REGION_CODE_SLUG = Object.freeze({
  A: "alaska",
  AJ: "transpacific",
  BH: "caribbean",
  BI: "british-isles",
  BM: null,
  C: "caribbean",
  CE: "caribbean",
  CP: "caribbean",
  CS: "caribbean",
  CW: "caribbean",
  E: "mediterranean",
  EN: "northern-europe",
  ES: "northern-europe",
  ET: "transatlantic",
  H: "hawaii",
  M: "mexican-riviera",
  MB: "mexican-riviera",
  ME: "mediterranean",
  MR: "mexican-riviera",
  NN: "canada-new-england",
  NO: null,
  NZ: "australia-new-zealand",
  O: "south-pacific",
  S: "south-america",
  SA: "australia-new-zealand",
  T: "panama-canal",
  TH: "transpacific",
  TP: "transpacific",
  U: "australia-new-zealand",
  X: "asia",
  XS: "asia"
});

const PRIMARY_EXCLUSION_ORDER = [
  "source_invalid",
  "past_departure",
  "within_21_day_cutoff",
  "required_ship_unresolved",
  "required_embark_port_unresolved",
  "required_destination_unresolved"
];

function parseIsoDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function cleanPortText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildOfficialUrl(path, baseUrl = DEFAULT_BASE_URL) {
  const raw = String(path || "").trim();
  if (!raw) return null;
  const normalised = raw.startsWith("/") ? raw : `/${raw}`;
  return canonicalUrl(`${baseUrl}${normalised}`);
}

function deriveNightsFromCclDuration({ dur, roundtrip, departureDate, arrivalDate }) {
  const days = Number(dur);
  let nights = null;
  if (Number.isFinite(days) && days > 0) {
    nights = roundtrip === false ? days : Math.max(0, days - 1);
  }

  let dateDerivedNights = null;
  if (departureDate && arrivalDate) {
    const dep = Date.parse(`${departureDate}T00:00:00Z`);
    const arr = Date.parse(`${arrivalDate}T00:00:00Z`);
    if (Number.isFinite(dep) && Number.isFinite(arr)) {
      dateDerivedNights = Math.round((arr - dep) / 86400000);
    }
  }

  const durationMismatch =
    nights != null &&
    dateDerivedNights != null &&
    nights !== dateDerivedNights;

  return {
    nights,
    date_derived_nights: dateDerivedNights,
    duration_mismatch: durationMismatch
  };
}

function assessSailingAvailability(sailing) {
  const rooms = sailing?.rooms && typeof sailing.rooms === "object" ? sailing.rooms : {};
  const categories = Object.entries(rooms).map(([category, meta]) => ({
    category,
    sold_out: meta?.soldOut === true
  }));
  const allCategoriesSoldOut =
    categories.length > 0 && categories.every((entry) => entry.sold_out === true);

  return {
    policy: "Do not exclude sailings based on cabin-category soldOut alone; no reliable sailing-wide cancellation flag observed.",
    cabin_categories: categories,
    all_categories_sold_out: allCategoriesSoldOut,
    sailing_cancelled: false,
    excluded_for_availability: false
  };
}

function officialSailingId(raw) {
  return String(raw?.official_sailing_id || raw?.sailing_id || raw?.sailingId || "").trim() || null;
}

function officialProductKey(raw) {
  const code = String(raw?.itinerary_code || raw?.itineraryCode || raw?.code || "").trim();
  const shipCode = String(raw?.ship_code || raw?.shipCode || "").trim();
  const departureDate = parseIsoDate(raw?.departure_date || raw?.departureDate);
  if (!code || !shipCode || !departureDate) return null;
  return `${code}|${shipCode}|${departureDate}`;
}

function immutableIdentitySnapshot(raw) {
  return {
    sailing_id: officialSailingId(raw),
    itinerary_code: String(raw?.itinerary_code || raw?.code || "").trim() || null,
    ship_code: String(raw?.ship_code || raw?.shipCode || "").trim() || null,
    departure_date: parseIsoDate(raw?.departure_date || raw?.departureDate),
    group_id: String(raw?.group_id || raw?.groupId || "").trim() || null
  };
}

function snapshotsEqual(a, b) {
  return (
    a.sailing_id === b.sailing_id &&
    a.itinerary_code === b.itinerary_code &&
    a.ship_code === b.ship_code &&
    a.departure_date === b.departure_date &&
    a.group_id === b.group_id
  );
}

function expandItineraryGroupsToRawSailings(groups, { baseUrl = DEFAULT_BASE_URL } = {}) {
  const products = [];
  let rawExpanded = 0;
  let groupsWithoutSailings = 0;
  let leadSailingOnlyGroups = 0;

  for (const group of groups || []) {
    const sailings = Array.isArray(group?.sailings) ? group.sailings : [];
    if (!sailings.length) {
      groupsWithoutSailings += 1;
      if (group?.leadSailing) leadSailingOnlyGroups += 1;
      continue;
    }

    for (const sailing of sailings) {
      rawExpanded += 1;
      const departure_date = parseIsoDate(sailing.departureDate);
      const arrival_date = parseIsoDate(sailing.arrivalDate);
      const duration = deriveNightsFromCclDuration({
        dur: group.dur,
        roundtrip: group.roundtrip,
        departureDate: departure_date,
        arrivalDate: arrival_date
      });

      products.push({
        source: SOURCE_ID,
        structured_source: SOURCE_ID,
        group_id: group.id || null,
        itinerary_code: group.code || null,
        itinerary_title: group.itineraryTitle || group.itineraryTitleFormatted || null,
        ship_code: group.shipCode || null,
        ship_name: group.shipName || null,
        departure_port_name: cleanPortText(group.departurePortName),
        departure_port_code: group.departurePortCode || null,
        region_code: group.regionCode || null,
        region_name: group.regionName || null,
        duration_days: group.dur ?? null,
        roundtrip: group.roundtrip === true,
        ports_to_display: group.portsToDisplay || [],
        itinerary_url: buildOfficialUrl(group.itineraryURL, baseUrl),
        sailing_id: String(sailing.sailingId || "").trim() || null,
        official_sailing_id: String(sailing.sailingId || "").trim() || null,
        departure_date,
        arrival_date,
        nights: duration.nights,
        date_derived_nights: duration.date_derived_nights,
        duration_mismatch: duration.duration_mismatch,
        official_url: buildOfficialUrl(sailing.sailingURL, baseUrl),
        availability: assessSailingAvailability(sailing),
        is_lead_sailing: sailing.isLeadSailing === true
      });
    }
  }

  return {
    products,
    expansion: {
      source_groups: (groups || []).length,
      raw_expanded_sailings: rawExpanded,
      expanded_sailings: products.length,
      groups_without_sailings: groupsWithoutSailings,
      lead_sailing_only_groups: leadSailingOnlyGroups
    }
  };
}

function dedupeExpandedSailings(products) {
  const bySailingId = new Map();
  const duplicateRowsRemoved = [];
  const conflictingDuplicateIds = [];

  for (const row of products || []) {
    const sailingId = officialSailingId(row);
    if (!sailingId) continue;
    const snapshot = immutableIdentitySnapshot(row);
    if (!bySailingId.has(sailingId)) {
      bySailingId.set(sailingId, { row, snapshot });
      continue;
    }
    const existing = bySailingId.get(sailingId);
    if (snapshotsEqual(existing.snapshot, snapshot)) {
      duplicateRowsRemoved.push({ sailing_id: sailingId, kept: existing.row, removed: row });
      continue;
    }
    conflictingDuplicateIds.push({
      sailing_id: sailingId,
      first: existing.snapshot,
      second: snapshot
    });
  }

  return {
    products: [...bySailingId.values()].map((entry) => entry.row),
    duplicate_rows_removed: duplicateRowsRemoved.length,
    conflicting_duplicate_sailing_ids: conflictingDuplicateIds,
    duplicate_details: duplicateRowsRemoved
  };
}

function resolveCclDestinationHints(raw) {
  const code = String(raw?.region_code || raw?.regionCode || "").trim().toUpperCase();
  const slug = code ? CCL_REGION_CODE_SLUG[code] : null;
  if (slug) return { preferredSlug: slug, method: `ccl_region_code_${code}` };

  const label = String(raw?.region_name || raw?.regionName || "").trim();
  if (label) return { structuredDestination: label, method: "ccl_region_name" };
  return {};
}

function resolveCclDeparturePort(raw) {
  const name = cleanPortText(raw?.departure_port_name || raw?.departurePortName);
  return resolveRawPortText(name || raw?.departure_port_code, { sourceField: SOURCE_ID });
}

function assessSourceValidity(raw) {
  const issues = [];
  if (!officialSailingId(raw)) issues.push("missing_sailing_id");
  if (!String(raw?.itinerary_code || "").trim()) issues.push("missing_itinerary_code");
  if (!String(raw?.ship_code || "").trim()) issues.push("missing_ship_code");
  if (!parseIsoDate(raw?.departure_date)) issues.push("missing_departure_date");
  if (!cleanPortText(raw?.departure_port_name)) issues.push("missing_departure_port");
  if (!(Number(raw?.nights) >= 0)) issues.push("missing_duration");
  return { valid: issues.length === 0, issues };
}

function normaliseCclSailing(raw, context = {}) {
  const {
    cruiseLine,
    ships = [],
    shipAliases = [],
    destinations = [],
    destinationAliases = [],
    today = perthCalendarDate()
  } = context;

  const shipResolution = resolveShipForLine({
    rawShipName: raw.ship_name,
    rawShipCode: raw.ship_code,
    cruiseLineId: cruiseLine?.id,
    cruiseLineName: cruiseLine?.name || "Carnival Cruise Line",
    ships,
    aliases: shipAliases
  });

  const portMeta = resolveCclDeparturePort(raw);
  const destHints = resolveCclDestinationHints(raw);
  const itineraryLabel = String(raw.itinerary_title || raw.itinerary_code || "").trim();

  const candidate = {
    cruise_line_id: cruiseLine?.id,
    ship_id: shipResolution.resolved ? shipResolution.ship.id : null,
    departure_date: raw.departure_date,
    return_date: raw.arrival_date,
    nights: raw.nights,
    departure_port: portMeta.status === "resolved" ? portMeta.canonicalPortName : null,
    departure_port_meta: portMeta,
    itinerary: itineraryLabel,
    official_url: raw.official_url || raw.itinerary_url,
    source_url: raw.official_url || raw.itinerary_url,
    raw_extract: {
      ccl_sailing_id: raw.sailing_id,
      ccl_itinerary_code: raw.itinerary_code,
      ccl_group_id: raw.group_id,
      ccl_ship_code: raw.ship_code,
      ccl_region_code: raw.region_code,
      ccl_region_name: raw.region_name,
      ccl_ports_to_display: raw.ports_to_display,
      structured_source: SOURCE_ID,
      departure_port_raw: raw.departure_port_name
    }
  };

  const destResult = resolveOperationalDestination({
    title: itineraryLabel,
    description: [raw.region_name, ...(raw.ports_to_display || [])].filter(Boolean).join(" "),
    itinerary: candidate.itinerary,
    structuredDestination: destHints.structuredDestination || raw.region_name || null,
    departurePort: candidate.departure_port || raw.departure_port_name,
    arrivalPort: raw.arrival_date ? raw.departure_port_name : null,
    nights: raw.nights,
    destinations,
    destinationAliases,
    preferredDestination: destHints.preferredSlug ? { slug: destHints.preferredSlug } : null
  });

  candidate.destination_id = destResult.status === "resolved" ? destResult.destinationId : null;

  const validationReasons = validateCruise({
    ...candidate,
    destination_id: candidate.destination_id
  });

  const individual = provesIndividualSailing({
    ship_id: candidate.ship_id,
    departure_date: candidate.departure_date,
    departure_port: candidate.departure_port,
    departure_port_meta: candidate.departure_port_meta,
    shipResolution,
    ships: ships.filter((s) => s.cruise_line_id === cruiseLine?.id),
    ship_name_guess: raw.ship_name
  });

  const confidenceEval = evaluateDiscoveryConfidence({
    ...candidate,
    cruiseLine,
    cruise_line_name: cruiseLine?.name,
    title: itineraryLabel,
    url: candidate.official_url,
    official_url: candidate.official_url,
    structured_source: SOURCE_ID,
    raw_extract: candidate.raw_extract
  });

  const days = candidate.departure_date ? daysUntilDeparture(candidate.departure_date, today) : null;
  const completeHighConfidence =
    shipResolution.resolved &&
    portMeta.status === "resolved" &&
    destResult.status === "resolved" &&
    individual.proven === true &&
    validationReasons.length === 0;

  return {
    raw,
    official_sailing_id: officialSailingId(raw),
    official_product_key: officialProductKey(raw),
    product_type: "cruise",
    candidate,
    ship_resolution: shipResolution,
    destination_resolution: destResult,
    destination_hints: destHints,
    validation_reasons: validationReasons,
    individual_sailing: individual,
    confidence: confidenceEval,
    complete_high_confidence: completeHighConfidence,
    days_until_departure: days,
    availability: raw.availability,
    duration_diagnostics: {
      nights: raw.nights,
      duration_days: raw.duration_days,
      date_derived_nights: raw.date_derived_nights,
      duration_mismatch: raw.duration_mismatch === true
    }
  };
}

function determinePrimaryExclusion(context) {
  const { sourceValidity, cutoff, shipResolved, embarkResolved, destinationResolved } = context;
  if (!sourceValidity.valid) return "source_invalid";
  if (cutoff.past) return "past_departure";
  if (cutoff.within_21) return "within_21_day_cutoff";
  if (!shipResolved) return "required_ship_unresolved";
  if (!embarkResolved) return "required_embark_port_unresolved";
  if (!destinationResolved) return "required_destination_unresolved";
  return null;
}

function evaluateSailingEligibility(row, today = perthCalendarDate()) {
  const raw = row.raw || {};
  const sourceValidity = assessSourceValidity(raw);
  const shipResolved = row.ship_resolution?.resolved === true;
  const embarkResolved = row.candidate?.departure_port_meta?.status === "resolved";
  const destinationResolved = row.destination_resolution?.status === "resolved";
  const dep = row.candidate?.departure_date;
  const days = dep ? daysUntilDeparture(dep, today) : null;
  const cutoff = {
    past: days != null && days < 0,
    within_21: days != null && days >= 0 && days <= PUBLIC_BOOKING_CUTOFF_DAYS,
    outside_cutoff: days != null && days > PUBLIC_BOOKING_CUTOFF_DAYS
  };

  const primary_exclusion_reason = determinePrimaryExclusion({
    sourceValidity,
    cutoff,
    shipResolved,
    embarkResolved,
    destinationResolved
  });

  return {
    source_validity: sourceValidity,
    reference_resolution: {
      ship: shipResolved,
      embark_port: embarkResolved,
      destination: destinationResolved
    },
    cutoff,
    primary_exclusion_reason,
    production_eligible: primary_exclusion_reason === null,
    discovery_ready: primary_exclusion_reason === null && row.complete_high_confidence === true
  };
}

function buildEligibilitySummary(normalised, today = perthCalendarDate()) {
  const counts = Object.fromEntries(PRIMARY_EXCLUSION_ORDER.map((k) => [k, 0]));
  counts.production_eligible = 0;
  counts.discovery_ready = 0;
  counts.past = 0;
  counts.within_21_day_exclusions = 0;
  counts.outside_cutoff = 0;
  counts.invalid_dates = 0;

  for (const row of normalised) {
    const eligibility = evaluateSailingEligibility(row, today);
    row.eligibility = eligibility;
    if (eligibility.production_eligible) counts.production_eligible += 1;
    if (eligibility.discovery_ready) counts.discovery_ready += 1;
    if (eligibility.cutoff.past) counts.past += 1;
    if (eligibility.cutoff.within_21) counts.within_21_day_exclusions += 1;
    if (eligibility.cutoff.outside_cutoff) counts.outside_cutoff += 1;
    if (!row.candidate?.departure_date) counts.invalid_dates += 1;
    else if (eligibility.primary_exclusion_reason && counts[eligibility.primary_exclusion_reason] != null) {
      counts[eligibility.primary_exclusion_reason] += 1;
    }
  }

  return {
    total_normalised: normalised.length,
    past: counts.past,
    within_21_day_exclusions: counts.within_21_day_exclusions,
    eligible_source_products: counts.production_eligible,
    cutoff_eligible_products: counts.outside_cutoff,
    discovery_ready_products: counts.discovery_ready,
    invalid_dates: counts.invalid_dates,
    waterfall: counts
  };
}

function analyseIdentity(normalised, dedupeMeta = {}) {
  const sailingIds = normalised.map((row) => row.official_sailing_id).filter(Boolean);
  const itineraryCodes = new Set(normalised.map((row) => row.raw?.itinerary_code).filter(Boolean));
  return {
    unique_sailing_ids: new Set(sailingIds).size,
    duplicate_sailing_rows_removed: dedupeMeta.duplicate_rows_removed || 0,
    conflicting_duplicate_sailing_ids: dedupeMeta.conflicting_duplicate_sailing_ids || [],
    distinct_itinerary_codes: itineraryCodes.size,
    identity_formula: "primary sailingId; composite itineraryCode|shipCode|departureDate"
  };
}

function analyseShips(normalised) {
  const byShip = new Map();
  for (const row of normalised) {
    const name = row.raw?.ship_name || "unknown";
    const code = row.raw?.ship_code || null;
    const key = `${name}|${code || ""}`;
    if (!byShip.has(key)) {
      byShip.set(key, {
        source_ship: name,
        source_code: code,
        candidates: 0,
        resolved_candidates: 0,
        unresolved_candidates: 0,
        resolution_method: null
      });
    }
    const entry = byShip.get(key);
    entry.candidates += 1;
    if (row.ship_resolution?.resolved) {
      entry.resolved_candidates += 1;
      entry.resolution_method = row.ship_resolution.method;
    } else {
      entry.unresolved_candidates += 1;
    }
  }

  const all = [...byShip.values()].sort((a, b) => b.unresolved_candidates - a.unresolved_candidates);
  const resolvedCandidates = normalised.filter((row) => row.ship_resolution?.resolved).length;
  const unresolvedCandidates = normalised.length - resolvedCandidates;
  const methods = {};
  for (const row of normalised) {
    const method = row.ship_resolution?.method || row.ship_resolution?.reason || "unresolved";
    methods[method] = (methods[method] || 0) + 1;
  }

  return {
    distinct_source_ships: all.length,
    resolved_candidates: resolvedCandidates,
    unresolved_candidates: unresolvedCandidates,
    resolution_percentage: normalised.length ? (resolvedCandidates / normalised.length) * 100 : 0,
    resolution_methods: methods,
    unresolved_ships: all.filter((entry) => entry.unresolved_candidates > 0)
  };
}

function analysePorts(normalised) {
  const byPort = new Map();
  for (const row of normalised) {
    const name = cleanPortText(row.raw?.departure_port_name);
    const code = row.raw?.departure_port_code || null;
    if (!name) continue;
    const key = `${name}|${code || ""}`;
    if (!byPort.has(key)) {
      byPort.set(key, {
        source_value: name,
        source_code: code,
        candidates: 0,
        resolved_candidates: 0,
        unresolved_candidates: 0,
        ambiguous_candidates: 0,
        canonical_port: null,
        resolution_method: null
      });
    }
    const entry = byPort.get(key);
    entry.candidates += 1;
    const meta = row.candidate?.departure_port_meta;
    if (meta?.status === "resolved") {
      entry.resolved_candidates += 1;
      entry.canonical_port = meta.canonicalPortName;
      entry.resolution_method = meta.resolution_method || meta.method;
    } else if (meta?.status === "ambiguous") {
      entry.ambiguous_candidates += 1;
    } else {
      entry.unresolved_candidates += 1;
    }
  }

  const all = [...byPort.values()].sort((a, b) => b.unresolved_candidates - a.unresolved_candidates);
  const resolved = normalised.filter((row) => row.candidate?.departure_port_meta?.status === "resolved").length;
  const ambiguous = normalised.filter((row) => row.candidate?.departure_port_meta?.status === "ambiguous").length;
  const unresolved = normalised.length - resolved - ambiguous;

  return {
    distinct_source_departure_ports: all.length,
    resolved_candidates: resolved,
    unresolved_candidates: unresolved,
    ambiguous_candidates: ambiguous,
    resolution_percentage: normalised.length ? (resolved / normalised.length) * 100 : 0,
    unresolved_values: all.filter((entry) => entry.unresolved_candidates > 0),
    ambiguous_values: all.filter((entry) => entry.ambiguous_candidates > 0)
  };
}

function analyseDestinations(normalised) {
  const byRegion = new Map();
  for (const row of normalised) {
    const code = row.raw?.region_code || null;
    const name = row.raw?.region_name || null;
    const key = `${code || ""}|${name || ""}`;
    if (!byRegion.has(key)) {
      byRegion.set(key, {
        region_code: code,
        region_name: name,
        candidates: 0,
        resolved_candidates: 0,
        unresolved_candidates: 0,
        canonical_result: null
      });
    }
    const entry = byRegion.get(key);
    entry.candidates += 1;
    if (row.destination_resolution?.status === "resolved") {
      entry.resolved_candidates += 1;
      entry.canonical_result = row.destination_resolution.destinationName;
    } else {
      entry.unresolved_candidates += 1;
    }
  }

  const all = [...byRegion.values()].sort((a, b) => b.unresolved_candidates - a.unresolved_candidates);
  const resolved = normalised.filter((row) => row.destination_resolution?.status === "resolved").length;
  const unresolved = normalised.length - resolved;

  return {
    distinct_source_regions: all.length,
    resolved_candidates: resolved,
    unresolved_candidates: unresolved,
    resolution_percentage: normalised.length ? (resolved / normalised.length) * 100 : 0,
    unresolved_values: all.filter((entry) => entry.unresolved_candidates > 0)
  };
}

function analyseCandidateIntegrity(normalised, dedupeMeta = {}) {
  let missingSailingIds = 0;
  let missingItineraryCodes = 0;
  let missingShipCodes = 0;
  let missingDepartureDates = 0;
  let missingDeparturePorts = 0;
  let invalidDurations = 0;
  let malformedRecords = 0;
  let durationMismatches = 0;

  for (const row of normalised) {
    const raw = row.raw || {};
    if (!officialSailingId(raw)) missingSailingIds += 1;
    if (!raw.itinerary_code) missingItineraryCodes += 1;
    if (!raw.ship_code) missingShipCodes += 1;
    if (!raw.departure_date) missingDepartureDates += 1;
    if (!cleanPortText(raw.departure_port_name)) missingDeparturePorts += 1;
    if (!(Number(raw.nights) >= 0)) invalidDurations += 1;
    if (raw.duration_mismatch) durationMismatches += 1;
    if (!Array.isArray(raw.ports_to_display)) malformedRecords += 1;
  }

  return {
    identity_collisions: dedupeMeta.conflicting_duplicate_sailing_ids?.length || 0,
    malformed_source_records: malformedRecords,
    missing_sailing_ids: missingSailingIds,
    missing_itinerary_codes: missingItineraryCodes,
    missing_ship_codes: missingShipCodes,
    missing_departure_dates: missingDepartureDates,
    missing_departure_ports: missingDeparturePorts,
    invalid_durations: invalidDurations,
    duration_mismatches: durationMismatches
  };
}

function computeCclQualityGateMetrics(products, today = perthCalendarDate()) {
  const cutoffEligible = (products || []).filter((p) => {
    const ev = p.eligibility || evaluateSailingEligibility(p, today);
    return ev.source_validity.valid && ev.cutoff.outside_cutoff;
  });
  const total = cutoffEligible.length || 1;
  const keys = new Set();
  let dups = 0;
  for (const p of cutoffEligible) {
    const k = officialSailingId(p.raw);
    if (!k) continue;
    if (keys.has(k)) dups += 1;
    keys.add(k);
  }

  const withIdentity = cutoffEligible.filter((p) => officialSailingId(p.raw)).length;
  const discoveryReady = cutoffEligible.filter((p) => p.eligibility?.discovery_ready).length;

  return {
    eligible_total: discoveryReady,
    cutoff_eligible_total: cutoffEligible.length,
    ship_resolution_pct: (cutoffEligible.filter((p) => p.ship_resolution?.resolved).length / total) * 100,
    departure_port_resolution_pct:
      (cutoffEligible.filter((p) => p.candidate?.departure_port_meta?.status === "resolved").length / total) * 100,
    destination_resolution_pct:
      (cutoffEligible.filter((p) => p.destination_resolution?.status === "resolved").length / total) * 100,
    identity_coverage_pct: cutoffEligible.length ? (withIdentity / cutoffEligible.length) * 100 : 100,
    duplicate_official_identities: dups
  };
}

function buildOverallSummary(normalised) {
  const suitable = normalised.filter((row) => row.eligibility?.discovery_ready).length;
  const remediation = normalised.filter(
    (row) =>
      row.eligibility?.production_eligible === false &&
      ["required_ship_unresolved", "required_embark_port_unresolved", "required_destination_unresolved"].includes(
        row.eligibility?.primary_exclusion_reason
      )
  ).length;
  const rejected = normalised.length - suitable - remediation;

  const reasons = {};
  for (const row of normalised) {
    const reason = row.eligibility?.primary_exclusion_reason || "discovery_ready";
    reasons[reason] = (reasons[reason] || 0) + 1;
  }

  return {
    suitable_for_eventual_import: suitable,
    requiring_reference_data_remediation: remediation,
    rejected,
    rejection_reasons: reasons
  };
}

function buildRemediationRankings(normalised) {
  const ships = analyseShips(normalised).unresolved_ships.map((entry) => ({
    source_ship: entry.source_ship,
    source_code: entry.source_code,
    affected_candidates: entry.unresolved_candidates,
    resolution: entry.resolution_method || "unresolved"
  }));

  const ports = analysePorts(normalised).unresolved_values.map((entry) => ({
    source_port: entry.source_value,
    source_code: entry.source_code,
    affected_candidates: entry.unresolved_candidates,
    resolution: entry.resolution_method || "unresolved"
  }));

  const destinations = analyseDestinations(normalised).unresolved_values.map((entry) => ({
    region_code: entry.region_code,
    region_name: entry.region_name,
    affected_candidates: entry.unresolved_candidates,
    current_canonical_result: entry.canonical_result
  }));

  return { ships, ports, destinations };
}

async function fetchAndExpandCatalogue(options = {}) {
  const fetchResult = await fetchCarnivalCatalogue(options);
  const expanded = expandItineraryGroupsToRawSailings(fetchResult.itinerary_groups || [], {
    baseUrl: options.baseUrl
  });
  const deduped = dedupeExpandedSailings(expanded.products);
  return { fetchResult, expanded, deduped };
}

async function simulateCclDiscovery(context = {}) {
  const today = context.today || perthCalendarDate();
  const { fetchResult, expanded, deduped } = await fetchAndExpandCatalogue({
    pageSize: context.pageSize,
    maxApiCalls: context.maxApiCalls,
    fetchImpl: context.fetchImpl,
    useCache: context.useCache,
    baseUrl: context.baseUrl
  });

  const normalised = deduped.products.map((raw) =>
    normaliseCclSailing(raw, {
      ...context,
      today
    })
  );

  const eligibility = buildEligibilitySummary(normalised, today);
  const identity = analyseIdentity(normalised, deduped);
  const ships = analyseShips(normalised);
  const ports = analysePorts(normalised);
  const destinations = analyseDestinations(normalised);
  const integrity = analyseCandidateIntegrity(normalised, deduped);
  const qualityGateMetrics = computeCclQualityGateMetrics(normalised, today);
  const overall = buildOverallSummary(normalised);
  const remediation = buildRemediationRankings(normalised);

  return {
    mode: "ccl_read_only_simulation",
    writes_performed: false,
    read_only: true,
    source_contract: SOURCE_CONTRACT,
    fetch_result: fetchResult,
    expansion: {
      ...expanded.expansion,
      unique_sailing_ids: identity.unique_sailing_ids,
      duplicate_sailing_rows_removed: identity.duplicate_sailing_rows_removed,
      conflicting_duplicate_sailing_ids: identity.conflicting_duplicate_sailing_ids,
      distinct_itinerary_codes: identity.distinct_itinerary_codes
    },
    identity,
    eligibility,
    ships,
    ports,
    destinations,
    integrity,
    quality_gate_metrics: qualityGateMetrics,
    overall,
    remediation_rankings: remediation,
    products: normalised
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  SOURCE_ID,
  CCL_REGION_CODE_SLUG,
  parseIsoDate,
  cleanPortText,
  buildOfficialUrl,
  deriveNightsFromCclDuration,
  assessSailingAvailability,
  officialSailingId,
  officialProductKey,
  immutableIdentitySnapshot,
  expandItineraryGroupsToRawSailings,
  dedupeExpandedSailings,
  resolveCclDestinationHints,
  resolveCclDeparturePort,
  assessSourceValidity,
  normaliseCclSailing,
  evaluateSailingEligibility,
  buildEligibilitySummary,
  analyseIdentity,
  analyseShips,
  analysePorts,
  analyseDestinations,
  analyseCandidateIntegrity,
  computeCclQualityGateMetrics,
  buildOverallSummary,
  buildRemediationRankings,
  fetchAndExpandCatalogue,
  simulateCclDiscovery,
  catalogueDestinations,
  clearCclFetchCache: clearCarnivalFetchCache
};
