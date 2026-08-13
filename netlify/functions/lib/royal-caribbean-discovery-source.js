/**
 * Royal Caribbean International — read-only official GraphQL source.
 *
 * Primary: POST https://www.royalcaribbean.com/graph
 * Same RCG cruiseSearch pagination contract as Celebrity; field contract
 * validated against Royal Caribbean International (brand code R), not RCG sisters.
 *
 * This module is incapable of database writes. Safe to run repeatedly.
 */

const { fetchRcgSearchPage, fetchRcgInventoryPages, USER_AGENT } = require("./rcg-graphql-discovery-source");
const { partitionByPublicBookingCutoff, publicBookingCutoffDate } = require("./public-discovered-cruise-inventory");
const { perthCalendarDate } = require("./cruise-discovery-maintenance");

const ADAPTER_ID = "royal-caribbean";
const ADAPTER_VERSION = "2026-08-13.royal2-dryrun";
const GRAPH_URL = "https://www.royalcaribbean.com/graph";
const BRAND_HOST = "https://www.royalcaribbean.com";
const BRAND_CODE = "R";
const CRUISE_LINE_NAME = "Royal Caribbean International";

const SEA_DAY_PORT_CODES = new Set(["CRU"]);
const SEA_DAY_NAME_RE = /^(cruising|at sea|sea day)$/i;
const OPEN_SAILING_STATUSES = new Set(["OPEN"]);
const DEFAULT_PAGE_SIZE = 50;
const PAGINATION_SAFETY_MAX_PAGES = 80;

const SOURCE_CONTRACT = {
  adapter_id: ADAPTER_ID,
  adapter_version: ADAPTER_VERSION,
  cruise_line: CRUISE_LINE_NAME,
  brand_code: BRAND_CODE,
  primary_endpoint: GRAPH_URL,
  fleet_endpoint: GRAPH_URL,
  method: "POST",
  query_name: "CruisesSearchResults",
  fleet_query_name: "ships",
  pagination: "CruiseSearchPagination { count, skip }",
  authentication_required: false,
  cookies_required: false,
  user_agent_required: "101cruise-discovery/1.0 (+https://101cruise.com.au) — Akamai denies curl/GitHub-Actions/python-requests UAs",
  official_identity_formula: "{itinerary.code}_{sailDate}",
  official_identity_source: "sailings[].id",
  official_group_formula: "cruiseSearch.results.cruises[].id",
  official_url_formula: "https://www.royalcaribbean.com/{productViewLink}",
  response_format: "GraphQL JSON — cruiseSearch.results.cruises[] with sailings[] and itinerary.days[]",
  writes: false
};

const SEARCH_QUERY = `
query CruisesSearchResults($filters: String, $pagination: CruiseSearchPagination) {
  cruiseSearch(filters: $filters, pagination: $pagination) {
    results {
      total
      cruises {
        id
        productViewLink
        masterSailing {
          itinerary {
            name
            code
            description
            voyageType
            sailingNights
            totalNights
            departurePort { code name }
            destination { code name }
            ship { code name }
            preTour { duration }
            postTour { duration }
            days {
              number
              type
              ports {
                arrivalTime
                departureTime
                port { code name }
              }
            }
          }
        }
        sailings {
          id
          sailDate
          startDate
          endDate
          status
        }
      }
    }
  }
}`;

const FLEET_QUERY = `query RoyalCaribbeanShips { ships { code name } }`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDate(raw) {
  const s = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return null;
}

function addDaysIso(iso, days) {
  const [y, m, d] = String(iso || "")
    .slice(0, 10)
    .split("-")
    .map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
}

function isSeaDayPort(port) {
  const code = String(port?.code || "").trim().toUpperCase();
  const name = String(port?.name || "").trim();
  return SEA_DAY_PORT_CODES.has(code) || SEA_DAY_NAME_RE.test(name);
}

function parseSailingId(sailingId) {
  const id = String(sailingId || "").trim();
  const match = id.match(/^(.+)_(\d{4}-\d{2}-\d{2})$/);
  if (!match) return { sailing_id: id || null, package_code: null, sail_date: null };
  return { sailing_id: id, package_code: match[1], sail_date: match[2] };
}

function buildOfficialUrl(productViewLink, sailing = {}) {
  if (!productViewLink) return null;
  const path = String(productViewLink).replace(/^\//, "");
  const url = new URL(path, `${BRAND_HOST}/`);
  const parsed = parseSailingId(sailing.id || sailing.official_sailing_id);
  const sailDate = parsed.sail_date || isoDate(sailing.sailDate || sailing.startDate);
  const packageCode = parsed.package_code;
  if (sailDate) url.searchParams.set("sailDate", sailDate);
  if (packageCode) url.searchParams.set("packageCode", packageCode);
  return url.toString();
}

function officialProductKey(raw) {
  return raw?.official_sailing_id || raw?.sailing_id || null;
}

function officialGroupKey(raw) {
  return raw?.group_id || raw?.itinerary_group_id || null;
}

function classifySailingStatus(status) {
  const raw = String(status || "").trim();
  const normalised = raw.toUpperCase();
  if (!normalised) {
    return { class: "missing_status", public_eligible: false, status: null };
  }
  if (OPEN_SAILING_STATUSES.has(normalised)) {
    return { class: "open", public_eligible: true, status: normalised };
  }
  return { class: "unfamiliar_status", public_eligible: false, status: normalised };
}

function classifyProductType(itin) {
  if (!itin) return { productType: "unknown", reason: "missing_itinerary" };
  const voyageType = String(itin.voyageType || "").toUpperCase();
  const hasBundledLand = Boolean(itin.preTour?.duration || itin.postTour?.duration);
  if (voyageType === "RIVER") {
    return {
      productType: hasBundledLand ? "river_cruisetour" : "river_cruise",
      reason: hasBundledLand ? "royal_caribbean_river_land_tour" : "royal_caribbean_river"
    };
  }
  if (hasBundledLand) {
    return { productType: "ocean_cruisetour", reason: "royal_caribbean_land_tour_component" };
  }
  if (voyageType && voyageType !== "OCEAN") {
    return { productType: "unknown", reason: `voyage_type_${voyageType.toLowerCase()}` };
  }
  return { productType: "ocean_cruise", reason: "standard_sailing" };
}

function parseItineraryDays(itin, departureDate) {
  const days = Array.isArray(itin?.days) ? itin.days : [];
  const parsed = [];
  for (const day of days) {
    const number = Number(day?.number);
    const visits = Array.isArray(day?.ports) ? day.ports : [];
    const ports = visits.map((visit) => {
      const port = visit?.port || {};
      return {
        code: port.code || null,
        name: port.name || null,
        arrival_time: visit?.arrivalTime || null,
        departure_time: visit?.departureTime || null,
        sea_day: isSeaDayPort(port)
      };
    });
    const date = departureDate && Number.isFinite(number) ? addDaysIso(departureDate, number - 1) : null;
    const seaDay = ports.length === 0 || ports.every((p) => p.sea_day) || String(day?.type || "").toUpperCase() === "SEA";
    parsed.push({
      number: Number.isFinite(number) ? number : null,
      type: day?.type || (seaDay ? "SEA" : "PORT"),
      date,
      sea_day: seaDay,
      ports
    });
  }

  const overnight = [];
  for (let i = 1; i < parsed.length; i += 1) {
    const prev = parsed[i - 1]?.ports?.find((p) => p.code && !p.sea_day);
    const cur = parsed[i]?.ports?.find((p) => p.code && !p.sea_day);
    if (prev?.code && cur?.code && prev.code === cur.code) {
      overnight.push({ port_code: cur.code, port_name: cur.name, from_day: parsed[i - 1].number, to_day: parsed[i].number });
    }
  }

  const orderedPorts = [];
  const seen = new Set();
  for (const day of parsed) {
    for (const port of day.ports || []) {
      if (!port.code || port.sea_day) continue;
      const key = `${day.number}|${port.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      orderedPorts.push({
        day: day.number,
        date: day.date,
        code: port.code,
        name: port.name,
        arrival_time: port.arrival_time,
        departure_time: port.departure_time
      });
    }
  }

  const firstPort = orderedPorts[0] || null;
  const lastPort = orderedPorts[orderedPorts.length - 1] || null;
  const roundTrip = Boolean(firstPort?.code && lastPort?.code && firstPort.code === lastPort.code);

  return {
    days: parsed,
    ordered_ports: orderedPorts,
    overnight_stays: overnight,
    sea_day_count: parsed.filter((d) => d.sea_day).length,
    round_trip: roundTrip,
    arrival_port: lastPort?.name || null,
    arrival_port_code: lastPort?.code || null
  };
}

function completenessIssues(raw) {
  const issues = [];
  if (!raw?.official_sailing_id) issues.push("missing_sailing_id");
  if (!raw?.ship_name && !raw?.ship_code) issues.push("missing_ship");
  if (!raw?.departure_date) issues.push("missing_departure_date");
  if (raw?.nights == null || !Number.isFinite(Number(raw.nights)) || Number(raw.nights) <= 0) {
    issues.push("missing_duration");
  }
  if (!raw?.departure_port && !raw?.departure_port_code) issues.push("missing_embarkation_port");
  return issues;
}

function parseRawSailingFromGraph(doc, sailing) {
  const itin = doc?.masterSailing?.itinerary || {};
  const departureDate = isoDate(sailing?.sailDate || sailing?.startDate);
  const returnDate = isoDate(sailing?.endDate) || (departureDate && itin.sailingNights != null
    ? addDaysIso(departureDate, Number(itin.sailingNights) || 0)
    : null);
  const product = classifyProductType(itin);
  const itinerary = parseItineraryDays(itin, departureDate);
  const sailingId = sailing?.id || (itin.code && departureDate ? `${itin.code}_${departureDate}` : null);

  const raw = {
    source: "royal_caribbean_graphql",
    structured_source: "royal_caribbean_graphql",
    group_id: doc?.id || null,
    itinerary_group_id: doc?.id || null,
    itinerary_code: itin.code || null,
    itinerary_name: itin.name || null,
    itinerary_description: itin.description || null,
    official_sailing_id: sailingId,
    sailing_id: sailingId,
    sailing_status: sailing?.status || null,
    sailing_status_class: classifySailingStatus(sailing?.status).class,
    product_view_link: doc?.productViewLink || null,
    official_url: buildOfficialUrl(doc?.productViewLink, sailing),
    voyage_type: itin.voyageType || null,
    product_type: product.productType,
    product_type_reason: product.reason,
    ship_name: itin.ship?.name || null,
    ship_code: itin.ship?.code || null,
    departure_port: itin.departurePort?.name || null,
    departure_port_code: itin.departurePort?.code || null,
    arrival_port: itinerary.arrival_port || itin.departurePort?.name || null,
    arrival_port_code: itinerary.arrival_port_code || null,
    destination_code: itin.destination?.code || null,
    destination_name: itin.destination?.name || null,
    nights: itin.sailingNights ?? itin.totalNights ?? null,
    departure_date: departureDate,
    return_date: returnDate,
    pre_tour_duration: itin.preTour?.duration ?? null,
    post_tour_duration: itin.postTour?.duration ?? null,
    itinerary_days: itinerary.days,
    itinerary_ports: itinerary.ordered_ports,
    overnight_stays: itinerary.overnight_stays,
    sea_day_count: itinerary.sea_day_count,
    round_trip: itinerary.round_trip
  };
  raw.completeness_issues = completenessIssues(raw);
  raw.complete = raw.completeness_issues.length === 0;
  return raw;
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
      if (futureOnly && today && raw.departure_date < today) {
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

async function fetchRoyalCaribbeanSearchPage(options = {}) {
  return fetchRcgSearchPage({
    graphUrl: GRAPH_URL,
    skip: options.skip ?? 0,
    count: options.count ?? 25,
    filters: options.filters ?? "{}",
    query: options.query || SEARCH_QUERY,
    userAgent: options.userAgent || USER_AGENT
  });
}

async function fetchRoyalCaribbeanInventoryPages(options = {}) {
  const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || DEFAULT_PAGE_SIZE));
  const maxPages =
    options.maxPages === null
      ? PAGINATION_SAFETY_MAX_PAGES
      : options.maxPages != null
        ? Number(options.maxPages)
        : PAGINATION_SAFETY_MAX_PAGES;
  return fetchRcgInventoryPages({
    graphUrl: GRAPH_URL,
    pageSize,
    maxPages,
    maxGroups: options.maxGroups,
    startSkip: options.skipStart ?? options.startSkip ?? 0,
    requestDelayMs: options.requestDelayMs ?? 200,
    filters: options.filters ?? "{}",
    query: options.query || SEARCH_QUERY
  });
}

async function fetchRoyalCaribbeanFleet({ userAgent = USER_AGENT } = {}) {
  const response = await fetch(GRAPH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": userAgent
    },
    body: JSON.stringify({ query: FLEET_QUERY })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) {
    return {
      ok: false,
      status: response.status,
      error: body.errors?.[0]?.message || `http_${response.status}`,
      ships: []
    };
  }
  return {
    ok: true,
    status: response.status,
    ships: body.data?.ships || []
  };
}

function assessRoyalCaribbeanPagination(fetchResult = {}) {
  const pageLog = fetchResult.page_log || [];
  const pagesRequested = pageLog.length;
  const pagesSuccessful = pageLog.filter((p) => p.ok).length;
  const pagesFailed = pageLog.filter((p) => !p.ok).length;
  const totalOfficial = Number(fetchResult.total_official) || 0;
  const groupsFetched = fetchResult.groups?.length || 0;
  const last = pageLog[pageLog.length - 1] || null;
  const reachedEnd =
    pagesFailed === 0 &&
    totalOfficial > 0 &&
    (groupsFetched >= totalOfficial || (last && last.ok && (last.returned || 0) === 0) ||
      (last && last.ok && last.skip + (last.returned || 0) >= totalOfficial));
  const incompletePagination = pagesFailed > 0 || (totalOfficial > 0 && !reachedEnd);
  return {
    pages_requested: pagesRequested,
    pages_successful: pagesSuccessful,
    pages_failed: pagesFailed,
    incomplete_pagination: incompletePagination,
    fetch_failed: pagesSuccessful === 0 || pagesFailed > 0
  };
}

async function fetchAllRoyalCaribbeanRawSailings(options = {}) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const futureOnly = options.futureOnly !== false;
  let fetchResult;
  if (options.authoritativeEnumeration === true) {
    const { enumerateMultiPageSizeUnion } = require("./royal-caribbean-source-enumeration");
    const union = await enumerateMultiPageSizeUnion({
      pageSizes: options.unionPageSizes || [25, 50, 100],
      requestDelayMs: options.requestDelayMs ?? 100,
      today,
      stopAtTotal: true
    });
    fetchResult = {
      ok: true,
      total_official: union.results_total,
      groups: union.groups,
      page_log: union.passes.flatMap((pass) => pass.pages_requested ? [{ page_size: pass.page_size, ...pass }] : []),
      pagination_requests: union.passes.reduce((n, pass) => n + (pass.pages_requested || 0), 0),
      authoritative_union: true,
      union_page_sizes: union.page_sizes
    };
  } else {
    fetchResult = await fetchRoyalCaribbeanInventoryPages(options);
  }
  const expanded = expandGraphGroupsToRawSailings(fetchResult.groups, { today, futureOnly });
  const pagination = assessRoyalCaribbeanPagination(fetchResult);
  return {
    ...fetchResult,
    ok: Boolean(fetchResult.ok) && !pagination.fetch_failed && !pagination.incomplete_pagination,
    raw_sailings: expanded.products,
    ingestion_audit: expanded.audit,
    itinerary_groups_fetched: fetchResult.groups.length,
    pagination,
    today,
    read_only: true
  };
}

function summariseRoyalCaribbeanSailings(products, { today, perthToday } = {}) {
  const day = today || new Date().toISOString().slice(0, 10);
  const cutoffToday = perthToday || perthCalendarDate();
  const cutoffDate = publicBookingCutoffDate(cutoffToday);
  const partitioned = partitionByPublicBookingCutoff(
    products,
    (p) => p.departure_date,
    cutoffToday
  );

  const ships = new Set();
  const shipCodes = new Set();
  const departurePorts = new Set();
  const departurePortCodes = new Set();
  const destinations = new Set();
  const destinationCodes = new Set();
  const voyageTypes = new Set();
  const productTypes = {};
  const sailingStatuses = {};
  let earliest = null;
  let latest = null;
  let complete = 0;
  let withItinerary = 0;
  let roundTrip = 0;
  let oneWay = 0;

  for (const p of products || []) {
    if (p.complete) complete += 1;
    if (p.itinerary_ports?.length) withItinerary += 1;
    if (p.round_trip) roundTrip += 1;
    else if (p.arrival_port_code && p.departure_port_code) oneWay += 1;
    if (p.ship_name) ships.add(p.ship_name);
    if (p.ship_code) shipCodes.add(p.ship_code);
    if (p.departure_port) departurePorts.add(p.departure_port);
    if (p.departure_port_code) departurePortCodes.add(p.departure_port_code);
    if (p.destination_name) destinations.add(p.destination_name);
    if (p.destination_code) destinationCodes.add(p.destination_code);
    if (p.voyage_type) voyageTypes.add(p.voyage_type);
    productTypes[p.product_type || "unknown"] = (productTypes[p.product_type || "unknown"] || 0) + 1;
    const st = p.sailing_status || "unknown";
    sailingStatuses[st] = (sailingStatuses[st] || 0) + 1;
    if (p.departure_date) {
      if (!earliest || p.departure_date < earliest) earliest = p.departure_date;
      if (!latest || p.departure_date > latest) latest = p.departure_date;
    }
  }

  const future = (products || []).filter((p) => p.departure_date && p.departure_date >= day);

  return {
    total_records: products.length,
    unique_voyages: new Set((products || []).map((p) => p.official_sailing_id).filter(Boolean)).size,
    complete_records: complete,
    incomplete_records: products.length - complete,
    with_itinerary_ports: withItinerary,
    future_voyages: future.length,
    past_or_undated: products.length - future.length,
    publicly_eligible_after_21_day_cutoff: partitioned.publiclyEligible.length,
    within_21_day_window: partitioned.withinCutoff.length,
    public_booking_cutoff_date: cutoffDate,
    earliest_departure: earliest,
    latest_departure: latest,
    unique_ships: ships.size,
    unique_ship_codes: shipCodes.size,
    unique_departure_ports: departurePorts.size,
    unique_departure_port_codes: departurePortCodes.size,
    unique_destinations: destinations.size,
    unique_destination_codes: destinationCodes.size,
    ships: [...ships].sort(),
    ship_codes: [...shipCodes].sort(),
    departure_ports: [...departurePorts].sort(),
    destination_names: [...destinations].sort(),
    destination_codes: [...destinationCodes].sort(),
    voyage_types: [...voyageTypes].sort(),
    product_types: productTypes,
    sailing_statuses: sailingStatuses,
    round_trip: roundTrip,
    one_way: oneWay
  };
}

function inspectRoyalCaribbeanGraphBody(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "malformed_non_object" };
  }
  if (Array.isArray(body.errors) && body.errors.length) {
    return { ok: false, reason: "graphql_errors" };
  }
  if (!body.data || typeof body.data !== "object") {
    return { ok: false, reason: "malformed_missing_data" };
  }
  if (!body.data.cruiseSearch?.results) {
    return { ok: false, reason: "malformed_missing_results" };
  }
  if (!Array.isArray(body.data.cruiseSearch.results.cruises)) {
    return { ok: false, reason: "malformed_missing_cruises" };
  }
  return { ok: true, reason: null };
}

function looksLikeAkamaiDenied(status, bodyText) {
  if (status === 403 || status === 401 || status === 429) return true;
  return /access denied|captcha|attention required|akamai|reference #/i.test(String(bodyText || ""));
}

async function probeRoyalCaribbeanSource({
  maxPages = 1,
  pageSize = 5,
  includeFleet = true,
  userAgent = USER_AGENT
} = {}) {
  const started = Date.now();
  const page = await fetchRoyalCaribbeanSearchPage({ skip: 0, count: pageSize, userAgent });
  const fleet = includeFleet ? await fetchRoyalCaribbeanFleet({ userAgent }) : { ok: false, ships: [] };
  const expanded = expandGraphGroupsToRawSailings(page.cruises || [], {
    today: new Date().toISOString().slice(0, 10),
    futureOnly: false
  });
  return {
    ok: page.ok === true,
    read_only: true,
    writes: false,
    status: page.ok ? 200 : 0,
    elapsed_ms: Date.now() - started,
    source: SOURCE_CONTRACT,
    total_official_groups: page.total ?? null,
    returned_groups: page.cruises?.length || 0,
    sample_sailings: expanded.products.slice(0, 5),
    fleet_ok: fleet.ok === true,
    fleet_count: fleet.ships?.length || 0,
    error: page.error || null
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  GRAPH_URL,
  BRAND_HOST,
  BRAND_CODE,
  CRUISE_LINE_NAME,
  USER_AGENT,
  SOURCE_CONTRACT,
  SEARCH_QUERY,
  FLEET_QUERY,
  SEA_DAY_PORT_CODES,
  OPEN_SAILING_STATUSES,
  DEFAULT_PAGE_SIZE,
  PAGINATION_SAFETY_MAX_PAGES,
  classifySailingStatus,
  isoDate,
  addDaysIso,
  isSeaDayPort,
  parseSailingId,
  buildOfficialUrl,
  officialProductKey,
  officialGroupKey,
  classifyProductType,
  parseItineraryDays,
  completenessIssues,
  parseRawSailingFromGraph,
  expandGraphGroupsToRawSailings,
  fetchRoyalCaribbeanSearchPage,
  fetchRoyalCaribbeanInventoryPages,
  fetchRoyalCaribbeanFleet,
  fetchAllRoyalCaribbeanRawSailings,
  assessRoyalCaribbeanPagination,
  summariseRoyalCaribbeanSailings,
  inspectRoyalCaribbeanGraphBody,
  looksLikeAkamaiDenied,
  probeRoyalCaribbeanSource,
  sleep
};
