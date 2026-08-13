/**
 * Royal Caribbean International — production-quality read-only Discovery adapter.
 * Source: RCG GraphQL POST https://www.royalcaribbean.com/graph
 * Reuses shared RCG fetch, Celebrity destination primitives, and line-scoped resolvers.
 * This module does not write to production.
 */

const { resolveShipForLine } = require("./discovery-ship-resolver");
const { resolveOperationalDestination } = require("./discovery-destination-resolver");
const { resolveRawPortText } = require("./discovery-departure-port");
const { validateCruise } = require("./cruise-discovery");
const { evaluateDiscoveryConfidence } = require("./discovery-confidence");
const { provesIndividualSailing } = require("./discovery-non-sailing-filter");
const { catalogueDestinations } = require("./holland-america-discovery-adapter");
const { isScenicCruisingLabel, isSeaDayLabel } = require("./cruise-finder-v2/inventory/classify-itinerary");
const { resolveRoyalCaribbeanDestinationHints } = require("./royal-caribbean-destination-mapping");
const {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  GRAPH_URL,
  CRUISE_LINE_NAME,
  officialProductKey,
  officialGroupKey,
  classifyProductType,
  classifySailingStatus,
  isSeaDayPort,
  fetchAllRoyalCaribbeanRawSailings,
  fetchRoyalCaribbeanFleet,
  summariseRoyalCaribbeanSailings
} = require("./royal-caribbean-discovery-source");
const {
  partitionByPublicBookingCutoff,
  publicBookingCutoffDate,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require("./public-discovered-cruise-inventory");
const { perthCalendarDate } = require("./cruise-discovery-maintenance");

const LINE_SLUG = "royal-caribbean-international";

const ROYAL_CARIBBEAN_PORT_ALIASES = Object.freeze({
  "perfect day cococay": "Perfect Day at CocoCay, Bahamas",
  "athens (piraeus)": "Piraeus (Athens), Greece",
  "orlando (port canaveral)": "Port Canaveral (Orlando), Florida",
  "oahu (honolulu)": "Honolulu, Hawaii",
  "tokyo (yokohama)": "Yokohama, Japan",
  "shanghai (baoshan)": "Shanghai, China",
  "ravenna (venice)": "Ravenna, Italy",
  "rome (civitavecchia)": "Civitavecchia (Rome), Italy",
  colón: "Colón, Panama",
  colon: "Colón, Panama"
});

const SUSPICIOUS_DB_SHIP_NAMES = Object.freeze([
  "International Dream",
  "Luminosa",
  "Magnifica",
  "Majesty of the Seas",
  "Monarch of the Seas"
]);

function isEligibleRoyalCaribbeanCruise(productType) {
  return productType === "ocean_cruise";
}

function isRoyalCaribbeanCruisetour(productType) {
  return productType === "ocean_cruisetour" || productType === "river_cruisetour";
}

function isScenicStopName(name) {
  const raw = String(name || "").trim();
  if (!raw) return false;
  if (isScenicCruisingLabel(raw)) return true;
  if (/\(\s*cruising\s*\)/i.test(raw)) return true;
  if (/\bcruising\b/i.test(raw) && !isSeaDayLabel(raw)) return true;
  if (/hubbard glacier/i.test(raw)) return true;
  if (/napali coast/i.test(raw)) return true;
  return false;
}

function resolveRoyalCaribbeanPortText(rawName, extraCandidates = []) {
  const normalised = String(rawName || "").trim().toLowerCase();
  const alias = ROYAL_CARIBBEAN_PORT_ALIASES[normalised];
  const candidates = [alias, rawName, ...extraCandidates].filter(Boolean);
  for (const value of candidates) {
    const meta = resolveRawPortText(value, { sourceField: "royal_caribbean_graphql" });
    if (meta.status === "resolved") {
      return {
        ...meta,
        adapter_alias: Boolean(alias && value === alias),
        classification: meta.confidence === "alias" || (alias && value === alias) ? "alias_resolved" : "exact_resolved"
      };
    }
  }
  return {
    ...resolveRawPortText(rawName, { sourceField: "royal_caribbean_graphql" }),
    adapter_alias: false,
    classification: null
  };
}

function classifyItineraryStop(port = {}) {
  const name = port.name || port.rawValue || "";
  const code = port.code || "";
  if (port.sea_day || isSeaDayPort({ code, name }) || isSeaDayLabel(name)) {
    return { classification: "sea_day", name, code };
  }
  if (isScenicStopName(name)) {
    return { classification: "scenic_cruising", name, code };
  }
  const resolved = resolveRoyalCaribbeanPortText(name, name ? [] : [code]);
  if (resolved.status === "resolved") {
    return {
      classification: resolved.classification,
      name,
      code,
      canonical_port_name: resolved.canonicalPortName,
      method: resolved.adapter_alias ? "adapter_alias" : resolved.confidence
    };
  }
  if (resolved.status === "invalid" && /region_or_theme/.test(String(resolved.reason || ""))) {
    return { classification: "scenic_cruising", name, code, reason: resolved.reason };
  }
  return {
    classification: "unresolved_conventional",
    name,
    code,
    reason: resolved.reason || "unresolved"
  };
}

function assignOceanBucket(product, { today, cutoffDate }) {
  const dep = product.raw?.departure_date || product.candidate?.departure_date || null;
  const statusClass = product.status_class || classifySailingStatus(product.raw?.sailing_status).class;
  if (statusClass === "unfamiliar_status" || statusClass === "missing_status") return "unfamiliar_status";
  if (dep && today && dep < today) return "past";
  if (!product.raw?.complete) return "incomplete";
  if (dep && cutoffDate && dep <= cutoffDate) return "within_cutoff";
  if (!product.complete_high_confidence) return "incomplete";
  return "eligible";
}

function normaliseRoyalCaribbeanProduct(raw, context = {}) {
  const {
    cruiseLine,
    ships = [],
    shipAliases = [],
    destinations = [],
    destinationAliases = []
  } = context;

  const productType = raw?.product_type || classifyProductType({
    voyageType: raw?.voyage_type,
    preTour: raw?.pre_tour_duration ? { duration: raw.pre_tour_duration } : null,
    postTour: raw?.post_tour_duration ? { duration: raw.post_tour_duration } : null
  }).productType;
  const statusMeta = classifySailingStatus(raw?.sailing_status);
  const isCruiseProduct = isEligibleRoyalCaribbeanCruise(productType);

  const shipResolution = resolveShipForLine({
    rawShipName: raw.ship_name,
    rawShipCode: raw.ship_code,
    cruiseLineId: cruiseLine?.id,
    cruiseLineName: cruiseLine?.name || CRUISE_LINE_NAME,
    ships,
    aliases: shipAliases
  });

  const portMeta = resolveRoyalCaribbeanPortText(raw.departure_port, [raw.departure_port_code]);
  const destHints = resolveRoyalCaribbeanDestinationHints(raw);

  const candidate = {
    cruise_line_id: cruiseLine?.id,
    ship_id: shipResolution.resolved ? shipResolution.ship.id : null,
    departure_date: raw.departure_date,
    return_date: raw.return_date,
    nights: raw.nights,
    departure_port: portMeta.status === "resolved" ? portMeta.canonicalPortName : null,
    departure_port_meta: portMeta,
    itinerary: raw.itinerary_name,
    official_url: raw.official_url,
    source_url: raw.official_url,
    round_trip: raw.round_trip === true,
    raw_extract: {
      itinerary_name: raw.itinerary_name,
      group_id: raw.group_id,
      sailing_id: raw.official_sailing_id,
      package_code: raw.itinerary_code,
      destination_code: raw.destination_code,
      destination_name: raw.destination_name,
      structured_source: raw.structured_source,
      voyage_type: raw.voyage_type,
      ship_code: raw.ship_code,
      sailing_status: raw.sailing_status,
      round_trip: raw.round_trip === true,
      itinerary_days: raw.itinerary_days || [],
      itinerary_ports: raw.itinerary_ports || [],
      overnight_stays: raw.overnight_stays || [],
      sea_day_count: raw.sea_day_count || 0
    }
  };

  const destResult = resolveOperationalDestination({
    title: raw.itinerary_name,
    description: [raw.destination_name, raw.destination_code].filter(Boolean).join(" "),
    itinerary: raw.itinerary_name,
    structuredDestination: destHints?.structuredDestination || raw.destination_name || null,
    departurePort: candidate.departure_port || raw.departure_port,
    arrivalPort: raw.arrival_port,
    nights: raw.nights,
    destinations,
    destinationAliases,
    preferredDestination: destHints?.slug ? { slug: destHints.slug } : null
  });

  const matchedDest = destinations.find((d) => d.slug === destResult.destinationKey);
  candidate.destination_id = matchedDest?.id || null;
  candidate.destination_key = destResult.destinationKey;

  const simDestinationId =
    candidate.destination_id ||
    (destResult.status === "resolved" && destResult.destinationKey ? `catalogue:${destResult.destinationKey}` : null);

  const validationReasons = validateCruise({
    ...candidate,
    destination_id: simDestinationId
  }).filter((r) => !/Destination not matched/i.test(r) || simDestinationId);

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
    title: raw.itinerary_name,
    shipResolution: shipResolution.resolved
      ? { ship: shipResolution.ship, method: shipResolution.method, confidence: shipResolution.confidence }
      : null,
    destinationResolution: {
      resolved: destResult.status === "resolved",
      destination_id: simDestinationId,
      destination_key: destResult.destinationKey,
      confidence: destResult.confidence === "high" ? 95 : destResult.confidence === "medium" ? 80 : 60
    },
    ship_name: shipResolution.ship?.name || raw.ship_name
  });

  const complete =
    isCruiseProduct &&
    statusMeta.public_eligible &&
    Boolean(raw.complete) &&
    individual.proven &&
    destResult.status === "resolved" &&
    validationReasons.length === 0 &&
    (confidenceEval.outcome === "auto_publish" || confidenceEval.outcome === "high_confidence");

  const failureReasons = [];
  if (!isCruiseProduct) failureReasons.push(`product_type:${productType}`);
  if (!statusMeta.public_eligible) failureReasons.push(`status:${statusMeta.class}`);
  if (!raw.complete) failureReasons.push(...(raw.completeness_issues || ["source_incomplete"]));
  if (!individual.proven) failureReasons.push("non_sailing_or_incomplete");
  if (destResult.status !== "resolved") failureReasons.push(`destination_${destResult.status}`);
  if (validationReasons.length) failureReasons.push(...validationReasons.map((r) => `validation:${r}`));
  if (confidenceEval.outcome !== "auto_publish" && confidenceEval.outcome !== "high_confidence") {
    failureReasons.push(`confidence:${confidenceEval.outcome}`);
  }

  return {
    official_product_key: officialProductKey(raw),
    official_group_id: officialGroupKey(raw),
    official_sailing_id: raw.official_sailing_id,
    product_type: productType,
    product_type_reason: raw.product_type_reason || null,
    status_class: statusMeta.class,
    sailing_status: statusMeta.status,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    adapter_confidence: complete ? "high" : confidenceEval.outcome,
    ship_resolution: shipResolution,
    departure_port_resolution: portMeta,
    destination_resolution: destResult,
    destination_mapping_method: destHints?.method || null,
    candidate,
    complete_high_confidence: complete,
    source_complete: Boolean(raw.complete),
    completeness_issues: raw.completeness_issues || [],
    failure_reasons: failureReasons,
    proposed_action: complete ? "insert_active" : "skip_incomplete",
    raw
  };
}

function stampTimeEligibility(products, today) {
  const cutoffDate = publicBookingCutoffDate(today);
  const { publiclyEligible, withinCutoff } = partitionByPublicBookingCutoff(
    products,
    (p) => p.candidate?.departure_date || p.raw?.departure_date,
    today
  );
  const eligibleIds = new Set(publiclyEligible.map((p) => p.official_sailing_id));
  const cutoffIds = new Set(withinCutoff.map((p) => p.official_sailing_id));
  for (const product of products) {
    const dep = product.candidate?.departure_date || product.raw?.departure_date;
    if (dep && dep < today) product.time_eligibility = "past";
    else if (cutoffIds.has(product.official_sailing_id)) product.time_eligibility = "within_21_day_cutoff";
    else if (eligibleIds.has(product.official_sailing_id)) product.time_eligibility = "eligible";
    else product.time_eligibility = dep ? "future" : "unknown";
    product.ocean_bucket = isEligibleRoyalCaribbeanCruise(product.product_type)
      ? assignOceanBucket(product, { today, cutoffDate })
      : null;
  }
  return { publiclyEligible, withinCutoff, cutoffDate };
}

function distributionCounts(products, fieldFn) {
  const counts = {};
  for (const p of products) {
    const key = fieldFn(p) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function auditRoyalCaribbeanShips(normalisedProducts, ships = [], fleetShips = []) {
  const lineShips = (ships || []).filter(Boolean);
  const byKey = new Map();
  for (const p of normalisedProducts) {
    const code = p.raw?.ship_code || null;
    const name = p.raw?.ship_name || null;
    if (!code && !name) continue;
    const key = code || name;
    if (!byKey.has(key)) {
      const resolved = p.ship_resolution?.resolved ? p.ship_resolution : null;
      byKey.set(key, {
        source_ship_code: code,
        source_ship_name: name,
        sailings: 0,
        resolved: Boolean(resolved?.resolved),
        db_ship_id: resolved?.ship?.id || null,
        db_ship_name: resolved?.ship?.name || null,
        current_official_line_ship_id: resolved?.ship?.official_line_ship_id || null,
        proposed_official_line_ship_id:
          resolved?.resolved && code && String(resolved.ship?.official_line_ship_id || "").toUpperCase() !== String(code).toUpperCase()
            ? code
            : null,
        resolution_method: resolved?.method || null,
        confidence: resolved?.confidence || null,
        unresolved: !resolved?.resolved
      });
    }
    const row = byKey.get(key);
    row.sailings += 1;
    if (p.ship_resolution?.resolved) {
      row.resolved = true;
      row.unresolved = false;
      row.db_ship_id = p.ship_resolution.ship?.id || row.db_ship_id;
      row.db_ship_name = p.ship_resolution.ship?.name || row.db_ship_name;
      row.current_official_line_ship_id = p.ship_resolution.ship?.official_line_ship_id || row.current_official_line_ship_id;
      row.resolution_method = p.ship_resolution.method || row.resolution_method;
      row.confidence = p.ship_resolution.confidence || row.confidence;
      if (
        code &&
        String(row.current_official_line_ship_id || "").toUpperCase() !== String(code).toUpperCase()
      ) {
        row.proposed_official_line_ship_id = code;
      }
    }
  }

  const sourceRows = [...byKey.values()].sort((a, b) => String(a.source_ship_name).localeCompare(String(b.source_ship_name)));
  const fleet = (fleetShips || []).length ? fleetShips : sourceRows.map((r) => ({ code: r.source_ship_code, name: r.source_ship_name }));
  const dbByName = new Map(lineShips.map((s) => [String(s.name || "").toLowerCase(), s]));
  const sourceNames = new Set(fleet.map((s) => String(s.name || "").toLowerCase()).filter(Boolean));

  const sourceMissingInDb = fleet
    .filter((s) => s.name && !dbByName.has(String(s.name).toLowerCase()))
    .map((s) => ({
      source_ship_code: s.code || null,
      source_ship_name: s.name,
      proposed_action: "proposed_ship_addition"
    }));

  const dbNotInSource = lineShips
    .filter((s) => s.name && !sourceNames.has(String(s.name).toLowerCase()))
    .map((s) => ({
      db_ship_id: s.id,
      db_ship_name: s.name,
      active: s.active !== false,
      official_line_ship_id: s.official_line_ship_id || null
    }));

  const suspicious = lineShips
    .filter((s) => SUSPICIOUS_DB_SHIP_NAMES.some((n) => n.toLowerCase() === String(s.name || "").toLowerCase()))
    .map((s) => ({
      db_ship_id: s.id,
      db_ship_name: s.name,
      active: s.active !== false,
      in_current_source_fleet: sourceNames.has(String(s.name).toLowerCase()),
      reason: "questionable_royal_caribbean_line_assignment"
    }));

  return {
    total_source_ships: sourceRows.length,
    resolved: sourceRows.filter((r) => r.resolved).length,
    unresolved: sourceRows.filter((r) => r.unresolved).length,
    source_ships: sourceRows,
    source_ships_missing_in_db: sourceMissingInDb,
    db_ships_absent_from_source: dbNotInSource,
    suspicious_line_assignments: suspicious,
    proposed_official_line_ship_id_assignments: sourceRows.filter((r) => r.proposed_official_line_ship_id)
  };
}

function auditRoyalCaribbeanPorts(normalisedProducts) {
  const stops = new Map();
  function addStop(key, row) {
    if (!stops.has(key)) stops.set(key, { ...row, count: 0, sample_sailing_ids: [] });
    const current = stops.get(key);
    current.count += 1;
    if (current.sample_sailing_ids.length < 5 && row.sample_sailing_id) {
      current.sample_sailing_ids.push(row.sample_sailing_id);
    }
  }

  for (const p of normalisedProducts) {
    const embark = classifyItineraryStop({
      name: p.raw?.departure_port,
      code: p.raw?.departure_port_code,
      sea_day: false
    });
    addStop(`embark:${embark.code || embark.name}`, {
      ...embark,
      role: "embarkation",
      sample_sailing_id: p.official_sailing_id
    });
    for (const port of p.raw?.itinerary_ports || []) {
      const classified = classifyItineraryStop(port);
      addStop(`${classified.classification}:${classified.code || classified.name}`, {
        ...classified,
        role: "itinerary",
        sample_sailing_id: p.official_sailing_id
      });
    }
  }

  const rows = [...stops.values()];
  return {
    exact_resolved: rows.filter((r) => r.classification === "exact_resolved"),
    alias_resolved: rows.filter((r) => r.classification === "alias_resolved"),
    unresolved_conventional: rows.filter((r) => r.classification === "unresolved_conventional"),
    scenic_cruising: rows.filter((r) => r.classification === "scenic_cruising"),
    sea_day: rows.filter((r) => r.classification === "sea_day"),
    likely_aliases: rows.filter((r) => r.classification === "unresolved_conventional" && /\(|\)/.test(String(r.name || "")))
  };
}

function auditRoyalCaribbeanDestinations(normalisedProducts) {
  const byCode = new Map();
  for (const p of normalisedProducts) {
    const code = p.raw?.destination_code || "unknown";
    if (!byCode.has(code)) {
      byCode.set(code, {
        source_code: code,
        source_name: p.raw?.destination_name || null,
        mapped_destination: p.destination_resolution?.destinationKey || null,
        mapping_method: p.destination_mapping_method || null,
        unresolved: p.destination_resolution?.status !== "resolved",
        sailings: 0
      });
    }
    const row = byCode.get(code);
    row.sailings += 1;
    if (p.destination_resolution?.status === "resolved") row.unresolved = false;
    if (!row.mapped_destination) row.mapped_destination = p.destination_resolution?.destinationKey || null;
    if (!row.mapping_method) row.mapping_method = p.destination_mapping_method || null;
  }
  const values = [...byCode.values()].sort((a, b) => String(a.source_code).localeCompare(String(b.source_code)));
  return {
    source_values: values,
    mapped_values: values.filter((v) => !v.unresolved),
    unresolved_values: values.filter((v) => v.unresolved)
  };
}

function incompletenessReasons(products) {
  const reasons = {};
  for (const p of products) {
    for (const reason of p.completeness_issues || []) {
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
  }
  return reasons;
}

async function simulateRoyalCaribbeanInventory(context = {}) {
  const today = context.today || perthCalendarDate();
  const fetchResult = await fetchAllRoyalCaribbeanRawSailings({ ...context, today });
  const fleet = context.includeFleet === false
    ? { ok: true, ships: [] }
    : await fetchRoyalCaribbeanFleet({ userAgent: context.userAgent });
  const normalised = (fetchResult.raw_sailings || []).map((raw) => normaliseRoyalCaribbeanProduct(raw, context));
  const time = stampTimeEligibility(normalised, today);
  const ocean = normalised.filter((p) => p.product_type === "ocean_cruise");
  const cruisetours = normalised.filter((p) => isRoyalCaribbeanCruisetour(p.product_type));
  const statuses = distributionCounts(normalised, (p) => p.sailing_status || p.status_class);

  return {
    ok: fetchResult.ok === true,
    read_only: true,
    writes_blocked: true,
    source: SOURCE_CONTRACT,
    cruise_line: CRUISE_LINE_NAME,
    line_slug: LINE_SLUG,
    today,
    public_booking_cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    public_booking_cutoff_date: time.cutoffDate,
    official_reported_total: fetchResult.total_official,
    itinerary_groups_fetched: fetchResult.itinerary_groups_fetched,
    sailing_records_expanded: fetchResult.raw_sailings?.length || 0,
    pagination_requests: fetchResult.pagination_requests,
    page_log: fetchResult.page_log,
    pagination: fetchResult.pagination,
    ingestion_audit: fetchResult.ingestion_audit,
    fleet: {
      ok: fleet.ok === true,
      ships: fleet.ships || []
    },
    sample_stats: summariseRoyalCaribbeanSailings(fetchResult.raw_sailings || [], { today, perthToday: today }),
    classification: {
      ordinary_ocean_cruises: ocean.length,
      ocean_cruisetours_excluded: cruisetours.length,
      unknown_products: normalised.filter((p) => p.product_type === "unknown").length,
      other_product_types: normalised.filter(
        (p) => !["ocean_cruise", "ocean_cruisetour", "unknown"].includes(p.product_type)
      ).length,
      source_complete: normalised.filter((p) => p.source_complete).length,
      source_incomplete: normalised.filter((p) => !p.source_complete).length,
      incompleteness_reasons: incompletenessReasons(normalised),
      source_statuses: statuses,
      unfamiliar_status_records: normalised.filter((p) => p.status_class === "unfamiliar_status").length
    },
    time_eligibility: {
      future_sailings: normalised.filter((p) => p.time_eligibility !== "past").length,
      more_than_21_day_eligible: time.publiclyEligible.length,
      within_21_day_cutoff: time.withinCutoff.length,
      already_departed: normalised.filter((p) => p.time_eligibility === "past").length,
      perth_cutoff_date: time.cutoffDate
    },
    ship_audit: auditRoyalCaribbeanShips(normalised, context.ships || [], fleet.ships || []),
    port_audit: auditRoyalCaribbeanPorts(ocean),
    destination_audit: auditRoyalCaribbeanDestinations(ocean),
    destination_distribution: distributionCounts(ocean, (p) => p.destination_resolution?.destinationKey),
    ship_distribution: distributionCounts(normalised, (p) => p.raw?.ship_name),
    departure_port_distribution: distributionCounts(
      normalised,
      (p) => p.candidate?.departure_port || p.raw?.departure_port
    ),
    products: normalised,
    publicly_eligible_products: time.publiclyEligible,
    within_cutoff_products: time.withinCutoff
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  GRAPH_URL,
  LINE_SLUG,
  CRUISE_LINE_NAME,
  ROYAL_CARIBBEAN_PORT_ALIASES,
  isEligibleRoyalCaribbeanCruise,
  isRoyalCaribbeanCruisetour,
  officialProductKey,
  officialGroupKey,
  classifyItineraryStop,
  resolveRoyalCaribbeanPortText,
  normaliseRoyalCaribbeanProduct,
  stampTimeEligibility,
  assignOceanBucket,
  simulateRoyalCaribbeanInventory,
  auditRoyalCaribbeanShips,
  auditRoyalCaribbeanPorts,
  auditRoyalCaribbeanDestinations,
  catalogueDestinations
};
