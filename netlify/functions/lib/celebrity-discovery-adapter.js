/**
 * Celebrity Cruises — Phase 1 read-only Discovery adapter.
 * Official source: RCG GraphQL POST https://www.celebritycruises.com/graph
 */

const { canonicalUrl } = require("./cruise-discovery-structured");
const { resolveShipForLine } = require("./discovery-ship-resolver");
const { resolveOperationalDestination } = require("./discovery-destination-resolver");
const { resolveRawPortText } = require("./discovery-departure-port");
const { validateCruise } = require("./cruise-discovery");
const { evaluateDiscoveryConfidence } = require("./discovery-confidence");
const { provesIndividualSailing } = require("./discovery-non-sailing-filter");
const { catalogueDestinations } = require("./holland-america-discovery-adapter");
const { fetchRcgInventoryPages, fetchRcgSearchPage, DEFAULT_SEARCH_QUERY } = require("./rcg-graphql-discovery-source");
const { resolveCelebrityDestinationHints, isCelebrityRiverProduct, CELEBRITY_RIVER_SHIP_CODES } = require("./celebrity-destination-mapping");

const ADAPTER_ID = "celebrity";
const ADAPTER_VERSION = "2026-08-03.celebrity3";
const GRAPH_URL = "https://www.celebritycruises.com/graph";
const BRAND_HOST = "https://www.celebritycruises.com";

const SOURCE_CONTRACT = {
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  primary_endpoint: GRAPH_URL,
  method: "POST",
  query_name: "CruisesSearchResults",
  pagination: "CruiseSearchPagination { count, skip }",
  authentication_required: false,
  response_format: "GraphQL JSON — cruiseSearch.results.cruises[] with sailings[]"
};

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_API_CALLS = 30;
const REQUEST_DELAY_MS = 150;

const CELEBRITY_PORT_ALIASES = Object.freeze({
  "cape liberty": "Bayonne, New Jersey",
  "benoa (bali)": "Benoa, Bali",
  benoa: "Benoa, Bali",
  "seoul (incheon)": "Incheon, South Korea",
  "baltra island": "Baltra, Galapagos",
  nuremberg: "Nuremberg, Germany",
  vilshofen: "Vilshofen, Germany",
  budapest: "Budapest, Hungary",
  vienna: "Vienna, Austria",
  basel: "Basel, Switzerland",
  regensburg: "Regensburg, Germany",
  brussels: "Brussels, Belgium",
  "bucharest (oltenita)": "Oltenita, Romania",
  oltenita: "Oltenita, Romania"
});

function isEligibleCelebrityCruise(productType) {
  return productType === "ocean_cruise" || productType === "river_cruise";
}

function isCelebrityCruisetour(productType) {
  return productType === "ocean_cruisetour" || productType === "river_cruisetour";
}

function isCelebrityRiverShip(raw) {
  const code = String(raw?.ship_code || "").toUpperCase();
  return CELEBRITY_RIVER_SHIP_CODES.has(code);
}

function officialProductKey(raw) {
  return raw?.official_sailing_id || raw?.sailing_id || null;
}

function officialGroupKey(raw) {
  return raw?.group_id || raw?.itinerary_group_id || null;
}

function classifyCelebrityProductType(raw) {
  const pre = raw?.pre_tour_duration;
  const post = raw?.post_tour_duration;
  const voyageType = String(raw?.voyage_type || "").toUpperCase();
  const nameBlob = [raw?.itinerary_name, raw?.destination_name].filter(Boolean).join(" ");
  const isRiver = voyageType === "RIVER" || isCelebrityRiverShip(raw);
  const hasBundledLand = Boolean(pre || post);
  const nameCruisetour = /quito &|land tour|cruisetour|overland|denali|yukon/i.test(nameBlob);

  if (isRiver) {
    if (hasBundledLand) {
      return {
        productType: "river_cruisetour",
        reason: "celebrity_river_land_tour_component",
        extractable_cruise_segment: false
      };
    }
    return {
      productType: "river_cruise",
      reason: "celebrity_river_sailing",
      extractable_cruise_segment: true
    };
  }

  if (hasBundledLand || nameCruisetour) {
    return {
      productType: "ocean_cruisetour",
      reason: hasBundledLand ? "celebrity_land_tour_component" : "celebrity_cruisetour_name",
      extractable_cruise_segment: false
    };
  }
  return { productType: "ocean_cruise", reason: "standard_sailing", extractable_cruise_segment: true };
}

function buildOfficialUrl(productViewLink) {
  if (!productViewLink) return null;
  const path = String(productViewLink).replace(/^\//, "");
  return canonicalUrl(`${BRAND_HOST}/${path}`);
}

function parseRawSailingFromGraph(doc, sailing) {
  const itin = doc?.masterSailing?.itinerary || {};
  if (!sailing?.id) return null;

  return {
    source: "celebrity_graphql",
    group_id: doc.id || null,
    itinerary_group_id: doc.id || null,
    itinerary_code: itin.code || null,
    itinerary_name: itin.name || null,
    official_sailing_id: sailing.id,
    sailing_id: sailing.id,
    product_view_link: doc.productViewLink || null,
    official_url: buildOfficialUrl(doc.productViewLink),
    voyage_type: itin.voyageType || null,
    ship_name: itin.ship?.name || null,
    ship_code: itin.ship?.code || null,
    departure_port: itin.departurePort?.name || null,
    departure_port_code: itin.departurePort?.code || null,
    arrival_port: itin.departurePort?.name || null,
    destination_code: itin.destination?.code || null,
    destination_name: itin.destination?.name || null,
    nights: itin.sailingNights ?? itin.totalNights ?? null,
    departure_date: sailing.sailDate || sailing.startDate || null,
    return_date: sailing.endDate || null,
    pre_tour_duration: itin.preTour?.duration ?? null,
    post_tour_duration: itin.postTour?.duration ?? null,
    structured_source: "celebrity_graphql"
  };
}

function expandGraphGroupsToRawSailings(groups, { today, futureOnly = true } = {}) {
  const products = [];
  const seenSailingIds = new Set();
  const seenGroupIds = new Set();
  let duplicateSailingIds = 0;
  let duplicateGroupIds = 0;
  let pastSailings = 0;
  let malformed = 0;

  for (const doc of groups || []) {
    if (doc?.id) {
      if (seenGroupIds.has(doc.id)) duplicateGroupIds += 1;
      seenGroupIds.add(doc.id);
    }
    const sailings = doc?.sailings || [];
    if (!sailings.length) {
      malformed += 1;
      continue;
    }
    for (const sailing of sailings) {
      const raw = parseRawSailingFromGraph(doc, sailing);
      if (!raw?.official_sailing_id || !raw.departure_date) {
        malformed += 1;
        continue;
      }
      if (seenSailingIds.has(raw.official_sailing_id)) {
        duplicateSailingIds += 1;
        continue;
      }
      seenSailingIds.add(raw.official_sailing_id);
      if (futureOnly && raw.departure_date < today) {
        pastSailings += 1;
        continue;
      }
      products.push(raw);
    }
  }

  return {
    products,
    audit: {
      duplicate_sailing_ids: duplicateSailingIds,
      duplicate_group_ids: duplicateGroupIds,
      past_sailings_skipped: pastSailings,
      malformed
    }
  };
}

async function fetchCelebrityInventoryPages(options = {}) {
  const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || DEFAULT_PAGE_SIZE));
  const maxPages = options.maxPages != null ? Number(options.maxPages) : DEFAULT_MAX_API_CALLS;
  return fetchRcgInventoryPages({
    graphUrl: GRAPH_URL,
    pageSize,
    maxPages,
    maxGroups: options.maxGroups,
    requestDelayMs: options.requestDelayMs ?? REQUEST_DELAY_MS,
    query: options.query || DEFAULT_SEARCH_QUERY
  });
}

async function fetchAllCelebrityRawSailings(options = {}) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const futureOnly = options.futureOnly !== false;
  const fetchResult = await fetchCelebrityInventoryPages({ ...options, startSkip: options.skipStart ?? options.startSkip ?? 0 });
  const expanded = expandGraphGroupsToRawSailings(fetchResult.groups, { today, futureOnly });

  return {
    ...fetchResult,
    raw_sailings: expanded.products,
    ingestion_audit: expanded.audit,
    itinerary_groups_fetched: fetchResult.groups.length
  };
}

function resolveCelebrityDeparturePort(raw) {
  const normalised = String(raw.departure_port || "").trim().toLowerCase();
  const alias = CELEBRITY_PORT_ALIASES[normalised];
  const candidates = [alias, raw.departure_port, raw.departure_port_code].filter(Boolean);
  for (const value of candidates) {
    const meta = resolveRawPortText(value, { sourceField: "celebrity_graphql" });
    if (meta.status === "resolved") return meta;
  }

  if (isCelebrityRiverProduct(raw) && alias) {
    return {
      rawValue: raw.departure_port,
      canonicalPortId: null,
      canonicalPortName: alias,
      confidence: "adapter_alias",
      status: "resolved",
      reason: null,
      sourceField: "celebrity_graphql.river_alias"
    };
  }

  return resolveRawPortText(raw.departure_port, { sourceField: "celebrity_graphql" });
}

function normaliseCelebrityProduct(raw, context = {}) {
  const {
    cruiseLine,
    ships = [],
    shipAliases = [],
    destinations = [],
    destinationAliases = [],
    productMeta = null
  } = context;

  const product = productMeta || classifyCelebrityProductType(raw);
  const isCruiseProduct = isEligibleCelebrityCruise(product.productType);

  const shipResolution = resolveShipForLine({
    rawShipName: raw.ship_name,
    rawShipCode: raw.ship_code,
    cruiseLineId: cruiseLine?.id,
    cruiseLineName: cruiseLine?.name || "Celebrity Cruises",
    ships,
    aliases: shipAliases
  });

  const portMeta = resolveCelebrityDeparturePort(raw);
  const destHints = resolveCelebrityDestinationHints(raw);

  let candidate = {
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
    raw_extract: {
      itinerary_name: raw.itinerary_name,
      group_id: raw.group_id,
      sailing_id: raw.official_sailing_id,
      destination_code: raw.destination_code,
      destination_name: raw.destination_name,
      structured_source: raw.structured_source,
      voyage_type: raw.voyage_type,
      ship_code: raw.ship_code,
      river_name: destHints?.river_name || null,
      river_region: destHints?.river_region || null
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
    individual.proven &&
    destResult.status === "resolved" &&
    validationReasons.length === 0 &&
    (confidenceEval.outcome === "auto_publish" || confidenceEval.outcome === "high_confidence");

  const failureReasons = [];
  if (!isCruiseProduct) failureReasons.push(`product_type:${product.productType}`);
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
    product_type: product.productType,
    product_type_reason: product.reason,
    adapter_id: ADAPTER_ID,
    adapter_version: ADAPTER_VERSION,
    adapter_confidence: complete ? "high" : confidenceEval.outcome,
    ship_resolution: shipResolution,
    departure_port_resolution: portMeta,
    destination_resolution: destResult,
    destination_mapping_method: destHints?.method || null,
    candidate,
    complete_high_confidence: complete,
    failure_reasons: failureReasons,
    proposed_action: complete ? "insert_active" : "skip_incomplete",
    raw
  };
}

function summariseCelebrityProducts(products, context = {}) {
  const today = context.today || new Date().toISOString().slice(0, 10);
  const stats = {
    raw_sailing_products: products.length,
    ocean_cruises: 0,
    river_cruises: 0,
    ocean_cruisetours: 0,
    river_cruisetours: 0,
    unknown_products: 0,
    genuine_cruises: 0,
    cruisetours: 0,
    with_official_identity: 0,
    future_products: 0,
    past_products: 0,
    malformed: 0,
    duplicate_identities: 0
  };
  const seen = new Set();
  for (const p of products) {
    const raw = p.raw || p;
    const id = p.official_product_key || raw.official_sailing_id;
    if (id) {
      stats.with_official_identity += 1;
      if (seen.has(id)) stats.duplicate_identities += 1;
      seen.add(id);
    } else stats.malformed += 1;
    if (p.product_type === "ocean_cruise") {
      stats.ocean_cruises += 1;
      stats.genuine_cruises += 1;
    } else if (p.product_type === "river_cruise") {
      stats.river_cruises += 1;
      stats.genuine_cruises += 1;
    } else if (p.product_type === "ocean_cruisetour") {
      stats.ocean_cruisetours += 1;
      stats.cruisetours += 1;
    } else if (p.product_type === "river_cruisetour") {
      stats.river_cruisetours += 1;
      stats.cruisetours += 1;
    } else stats.unknown_products += 1;
    if (raw.departure_date >= today) stats.future_products += 1;
    else stats.past_products += 1;
  }
  return stats;
}

function segmentMetrics(products) {
  const total = Math.max(products.length, 1);
  const shipResolved = products.filter((p) => p.ship_resolution?.resolved).length;
  const portResolved = products.filter((p) => p.departure_port_resolution?.status === "resolved").length;
  const destResolved = products.filter((p) => p.destination_resolution?.status === "resolved").length;
  const complete = products.filter((p) => p.complete_high_confidence).length;
  return {
    count: products.length,
    ship_match_rate_pct: Math.round((shipResolved / total) * 1000) / 10,
    departure_port_rate_pct: Math.round((portResolved / total) * 1000) / 10,
    destination_resolution_rate_pct: Math.round((destResolved / total) * 1000) / 10,
    complete_high_confidence: complete,
    complete_high_confidence_rate_pct: Math.round((complete / total) * 1000) / 10,
    projected_active: complete
  };
}

function computeCelebrityMetrics(normalisedProducts) {
  const oceanCruises = normalisedProducts.filter((p) => p.product_type === "ocean_cruise");
  const riverCruises = normalisedProducts.filter((p) => p.product_type === "river_cruise");
  const eligible = [...oceanCruises, ...riverCruises];
  const skipReasons = {};
  for (const p of normalisedProducts) {
    if (p.complete_high_confidence) continue;
    for (const r of p.failure_reasons || []) {
      skipReasons[r] = (skipReasons[r] || 0) + 1;
    }
  }
  const combinedComplete = eligible.filter((p) => p.complete_high_confidence).length;
  return {
    ocean_inventory: segmentMetrics(oceanCruises),
    river_inventory: segmentMetrics(riverCruises),
    combined_eligible: {
      eligible_ocean_cruises: oceanCruises.length,
      eligible_river_cruises: riverCruises.length,
      total_projected_active_inserts: combinedComplete,
      duplicate_identities: normalisedProducts.filter((p, i, arr) => {
        const id = p.official_product_key;
        return id && arr.findIndex((x) => x.official_product_key === id) !== i;
      }).length,
      incomplete_skips: normalisedProducts.length - combinedComplete,
      projected_steve_reviews: normalisedProducts.filter((p) => p.destination_resolution?.status === "ambiguous").length
    },
    ocean_cruisetours: normalisedProducts.filter((p) => p.product_type === "ocean_cruisetour").length,
    river_cruisetours: normalisedProducts.filter((p) => p.product_type === "river_cruisetour").length,
    unknown_products: normalisedProducts.filter((p) => p.product_type === "unknown").length,
    genuine_cruise_products: eligible.length,
    ship_match_rate_pct: segmentMetrics(eligible).ship_match_rate_pct,
    departure_port_rate_pct: segmentMetrics(eligible).departure_port_rate_pct,
    destination_resolution_rate_pct: segmentMetrics(eligible).destination_resolution_rate_pct,
    complete_high_confidence: combinedComplete,
    complete_high_confidence_rate_pct:
      eligible.length > 0 ? Math.round((combinedComplete / eligible.length) * 1000) / 10 : 0,
    projected_active: combinedComplete,
    projected_steve_reviews: normalisedProducts.filter((p) => p.destination_resolution?.status === "ambiguous").length,
    skip_reasons: skipReasons
  };
}

function distributionCounts(normalisedProducts, fieldFn) {
  const counts = {};
  for (const p of normalisedProducts) {
    const key = fieldFn(p) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

async function simulateCelebrityInventory(context = {}) {
  const today = context.today || new Date().toISOString().slice(0, 10);
  const fetchResult = await fetchAllCelebrityRawSailings({ ...context, today });
  const normalised = fetchResult.raw_sailings.map((raw) =>
    normaliseCelebrityProduct(raw, context)
  );
  const metrics = computeCelebrityMetrics(normalised);
  return {
    ok: fetchResult.ok,
    read_only: true,
    source: SOURCE_CONTRACT,
    official_reported_total: fetchResult.total_official,
    itinerary_groups_fetched: fetchResult.itinerary_groups_fetched,
    sailing_products_fetched: fetchResult.raw_sailings.length,
    pagination_requests: fetchResult.pagination_requests,
    page_log: fetchResult.page_log,
    ingestion_audit: fetchResult.ingestion_audit,
    sample_stats: summariseCelebrityProducts(normalised, { today }),
    cruise_metrics: metrics,
    destination_distribution: distributionCounts(
      normalised.filter((p) => isEligibleCelebrityCruise(p.product_type)),
      (p) => p.destination_resolution?.destinationKey
    ),
    ocean_destination_distribution: distributionCounts(
      normalised.filter((p) => p.product_type === "ocean_cruise"),
      (p) => p.destination_resolution?.destinationKey
    ),
    river_destination_distribution: distributionCounts(
      normalised.filter((p) => p.product_type === "river_cruise"),
      (p) => p.destination_resolution?.destinationKey
    ),
    ship_distribution: distributionCounts(normalised, (p) => p.raw?.ship_name),
    river_ship_distribution: distributionCounts(
      normalised.filter((p) => p.product_type === "river_cruise" || p.product_type === "river_cruisetour"),
      (p) => p.raw?.ship_name
    ),
    departure_port_distribution: distributionCounts(normalised, (p) => p.candidate?.departure_port || p.raw?.departure_port),
    river_departure_port_distribution: distributionCounts(
      normalised.filter((p) => p.product_type === "river_cruise" || p.product_type === "river_cruisetour"),
      (p) => p.candidate?.departure_port || p.raw?.departure_port
    ),
    products: normalised,
    writes_blocked: true
  };
}

function auditCelebrityShips(normalisedProducts, ships = []) {
  const lineShips = ships.filter(Boolean);
  const byCode = new Map();
  for (const p of normalisedProducts) {
    const code = p.raw?.ship_code;
    const name = p.raw?.ship_name;
    if (!code && !name) continue;
    const key = code || name;
    if (!byCode.has(key)) byCode.set(key, { code, name, sailings: 0, matched: false, ship_id: null });
    const row = byCode.get(key);
    row.sailings += 1;
    if (p.ship_resolution?.resolved) {
      row.matched = true;
      row.ship_id = p.ship_resolution.ship?.id || null;
      row.canonical_name = p.ship_resolution.ship?.name || null;
    }
  }
  const catalogueNames = new Set(lineShips.map((s) => String(s.name || "").toLowerCase()));
  const matched = [];
  const unmatched = [];
  for (const row of byCode.values()) {
    if (row.matched) matched.push(row);
    else unmatched.push({ ...row, in_catalogue_by_name: catalogueNames.has(String(row.name || "").toLowerCase()) });
  }
  return { matched, unmatched, total_official_ships: byCode.size };
}

function auditCelebrityPorts(normalisedProducts) {
  const unresolved = new Map();
  for (const p of normalisedProducts) {
    if (p.departure_port_resolution?.status === "resolved") continue;
    const key = p.raw?.departure_port_code || p.raw?.departure_port;
    if (!key) continue;
    if (!unresolved.has(key)) {
      unresolved.set(key, {
        official_name: p.raw?.departure_port,
        official_code: p.raw?.departure_port_code,
        sample_sailing_ids: [],
        count: 0
      });
    }
    const row = unresolved.get(key);
    row.count += 1;
    if (row.sample_sailing_ids.length < 5) row.sample_sailing_ids.push(p.official_sailing_id);
  }
  return [...unresolved.values()];
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  GRAPH_URL,
  DEFAULT_PAGE_SIZE,
  CELEBRITY_RIVER_SHIP_CODES,
  CELEBRITY_PORT_ALIASES,
  isEligibleCelebrityCruise,
  isCelebrityCruisetour,
  isCelebrityRiverShip,
  officialProductKey,
  officialGroupKey,
  classifyCelebrityProductType,
  parseRawSailingFromGraph,
  expandGraphGroupsToRawSailings,
  fetchCelebrityInventoryPages,
  fetchAllCelebrityRawSailings,
  fetchCelebritySearchPage: (opts) => fetchRcgSearchPage({ graphUrl: GRAPH_URL, ...opts }),
  normaliseCelebrityProduct,
  summariseCelebrityProducts,
  computeCelebrityMetrics,
  simulateCelebrityInventory,
  auditCelebrityShips,
  auditCelebrityPorts,
  catalogueDestinations
};
