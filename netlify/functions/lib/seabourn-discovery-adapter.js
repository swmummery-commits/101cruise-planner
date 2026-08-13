/**
 * Seabourn Cruise Line — read-only Discovery adapter (Prompt 2).
 *
 * Official source: Carnival Solr sbncruisesearch (same platform as HAL).
 * No production writes in this module.
 */

const { canonicalUrl } = require("./cruise-discovery-structured");
const { resolveShipForLine } = require("./discovery-ship-resolver");
const { resolveOperationalDestination } = require("./discovery-destination-resolver");
const { resolveRawPortText } = require("./discovery-departure-port");
const { validateCruise } = require("./cruise-discovery");
const { evaluateDiscoveryConfidence } = require("./discovery-confidence");
const { provesIndividualSailing } = require("./discovery-non-sailing-filter");
const { OPERATIONAL_DESTINATION_CATALOGUE } = require("./destination-classification");
const carnivalSolr = require("./carnival-solr-discovery");
const source = require("./seabourn-discovery-source");
const { evaluateCarnivalStructuredSourceTrust } = require("./carnival-structured-source-trust");
const {
  daysUntilDeparture,
  publicBookingCutoffDate,
  publicBookingMinimumDepartureDate,
  perthCalendarDate,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require("./public-discovered-cruise-inventory");

const ADAPTER_ID = source.ADAPTER_ID;
const ADAPTER_VERSION = source.ADAPTER_VERSION;
const SOURCE_CONTRACT = source.SOURCE_CONTRACT;

const DEFAULT_LOCALE_PATH = source.DEFAULT_LOCALE_PATH;

const SBN_DESTINATION_CODE_SLUG = Object.freeze({
  A: "alaska",
  C: "caribbean",
  D: "northern-europe",
  E: "mediterranean",
  EN: "northern-europe",
  ER: "northern-europe",
  ET: "transatlantic",
  J: "northern-europe",
  O: "asia",
  P: "australia-new-zealand",
  S: "antarctica",
  T: "panama-canal",
  W: "world-cruise"
});

const SCENIC_PORT_RE =
  /^(scenic cruising|scenic cruise|cruising |transit |transiting |at sea|sea day|rudyerd bay)/i;
const TRANSIT_PORT_RE = /^(transit |transiting |cruising )/i;
const EXPEDITION_SIGNAL_RE =
  /expedition|kimberley|antarctica|arctic|northwest passage|zodiac|ventures by seabourn|polar/i;
const GRAND_VOYAGE_RE = /grand voyage|world cruise/i;

const SEABOURN_SHIP_CODE_TO_NAME = Object.freeze({
  SE: "Encore",
  SQ: "Quest",
  SV: "Ovation",
  PS: "Pursuit",
  VN: "Venture"
});

/** Deterministic embarkation aliases — canonical names must exist in ports-catalogue.csv */
const SEABOURN_EMBARK_PORT_ALIASES = Object.freeze({
  "st johns, newfoundland, canada": "St John's, Newfoundland"
});

const PRIMARY_EXCLUSION_ORDER = [
  "source_invalid",
  "policy_excluded_cruisetour",
  "policy_excluded_product_type",
  "past_departure",
  "within_21_day_cutoff",
  "required_ship_unresolved",
  "required_embark_port_unresolved",
  "required_destination_unresolved",
  "confidence_gate_failure"
];

function parseSeabournDelimited(value) {
  return carnivalSolr.parseCarnivalDelimited(value);
}

function parseSeabournDate(iso) {
  return carnivalSolr.parseCarnivalDate(iso);
}

function parsePortList(values) {
  return carnivalSolr.parsePortList(values);
}

function pickLocaleField(doc, base, localePrefix = "en_us") {
  return carnivalSolr.pickLocaleField(doc, base, localePrefix);
}

function buildOfficialUrl(contentPath, localePath = DEFAULT_LOCALE_PATH) {
  const raw = String(contentPath || "").trim();
  if (!raw) return null;
  const normalised = raw.startsWith("/") ? raw : `/${raw}`;
  return canonicalUrl(`https://www.seabourn.com/${localePath}${normalised}`);
}

function officialProductKey(raw) {
  const itineraryId = String(raw?.itinerary_id || "").trim();
  const cruiseId = String(raw?.cruise_id || "").trim();
  if (itineraryId && cruiseId) return `${itineraryId}|${cruiseId}`;
  return [cruiseId, raw?.departure_date || "", raw?.ship_code || ""].filter(Boolean).join("|");
}

function officialProductKeyFromDoc(doc) {
  return source.officialProductKeyFromDoc(doc);
}

function classifyPortEntry(value) {
  const parsed = parseSeabournDelimited(value);
  const name = parsed.name || String(value || "").trim();
  const code = parsed.code || null;
  if (!name) return { kind: "empty", name: null, code: null, raw: value };
  if (SCENIC_PORT_RE.test(name) || /only#@#/i.test(String(value || ""))) {
    return { kind: "scenic_or_transit", name, code, raw: value };
  }
  if (TRANSIT_PORT_RE.test(name)) {
    return { kind: "scenic_or_transit", name, code, raw: value };
  }
  if (/^\d{2,4}$/.test(String(code || name))) {
    return { kind: "numeric_code", name, code: code || name, raw: value };
  }
  if (/\bor\b/i.test(name)) {
    return { kind: "ambiguous", name, code, raw: value };
  }
  return { kind: "physical", name, code, raw: value };
}

function parseItineraryPorts(doc, localePrefix = "en_us") {
  const values =
    pickLocaleField(doc, "portOfCallIds_ss", localePrefix) ||
    doc.sortedPortNames_ss ||
    doc.portOfCallIds ||
    [];
  return (values || []).map(classifyPortEntry);
}

function classifySeabournProductType(raw) {
  const tourId = String(raw?.tour_id || "").trim();
  const titleBlob = [raw?.title, raw?.description, raw?.night_name].filter(Boolean).join(" ");
  const nights = Number(raw?.nights) || 0;
  const cruiseId = String(raw?.cruise_id || "");
  const hasSuffix = /[A-C]$/.test(cruiseId) && /\d/.test(cruiseId);

  if (tourId) {
    return {
      productType: "cruisetour",
      reason: "seabourn_tour_id",
      tour_id: tourId,
      extractable_cruise_segment: false
    };
  }
  if (EXPEDITION_SIGNAL_RE.test(titleBlob)) {
    return {
      productType: "expedition",
      reason: "expedition_title_signal",
      extractable_cruise_segment: true
    };
  }
  if (GRAND_VOYAGE_RE.test(titleBlob) || nights >= 30) {
    return {
      productType: "grand_voyage",
      reason: nights >= 30 ? "duration_30_plus" : "grand_voyage_title",
      extractable_cruise_segment: true
    };
  }
  if (hasSuffix && nights >= 14) {
    return {
      productType: "combination",
      reason: "suffix_extended_product",
      extractable_cruise_segment: true
    };
  }
  if (nights >= 14 && /day/i.test(titleBlob)) {
    return {
      productType: "extended",
      reason: "extended_duration",
      extractable_cruise_segment: true
    };
  }
  return {
    productType: "ocean",
    reason: "standard_ocean_voyage",
    extractable_cruise_segment: true
  };
}

function parseRawVoyageFromDoc(doc, localePrefix = "en_us") {
  if (!doc?.cruiseId || !doc?.departDate) return null;

  const ship = parseSeabournDelimited(doc.shipName || doc.en_us_shipName_s);
  const embark = parseSeabournDelimited(doc.embarkPortName || pickLocaleField(doc, "embarkPortName_ss", localePrefix)?.[0]);
  const disembark = parseSeabournDelimited(doc.disembarkPortName);
  const itineraryEntries = parseItineraryPorts(doc, localePrefix);
  const portNames = itineraryEntries.map((p) => p.name).filter(Boolean);

  const destinationEntries = (doc.destinationNames || doc.en_us_destinationNames_ss || []).map((d) =>
    parseSeabournDelimited(d)
  );
  const destinationLabels = destinationEntries.map((d) => d.name).filter(Boolean);
  const destinationCodes = destinationEntries.map((d) => d.code).filter(Boolean);

  const regionEntries = (doc.regionNames || doc.en_us_regionNames_ss || []).map((r) => parseSeabournDelimited(r));
  const regionLabels = regionEntries.map((r) => r.name).filter(Boolean);
  const regionCodes = regionEntries.map((r) => r.code).filter(Boolean);

  return {
    source: "sbncruisesearch",
    solr_id: String(doc.id || "").trim() || null,
    entity_id: String(doc.entityId || "").trim() || null,
    cruise_id: String(doc.cruiseId).trim(),
    itinerary_id: String(doc.itineraryId || "").trim(),
    product_code: String(doc.itineraryId || "").trim(),
    booking_code: String(doc.cruiseId || "").trim(),
    tour_id: String(doc.tourId || "").trim() || null,
    cruise_type: String(doc.cruiseType || "").trim() || null,
    content_path: doc.contentPath || null,
    official_url: buildOfficialUrl(doc.contentPath),
    title: doc.name || doc.nightName || null,
    night_name: doc.nightName || null,
    description: doc.description || doc.cruiseOverviewImageAlt || null,
    cruise_overview_image: doc.cruiseOverviewImage || null,
    map_image: doc.mapImage || null,
    cruise_line: "Seabourn Cruise Line",
    ship_name: ship.name,
    ship_code: ship.code || doc.shipId || null,
    departure_date: parseSeabournDate(doc.departDate),
    return_date: parseSeabournDate(doc.arrivalDate),
    nights: Number(doc.duration) || null,
    departure_port: embark.name || null,
    departure_port_code: embark.code || doc.embarkPortCode || null,
    arrival_port: disembark.name || doc.disembarkPortName || null,
    arrival_port_code: disembark.code || doc.disembarkPortCode || null,
    itinerary_ports: portNames,
    itinerary_port_entries: itineraryEntries,
    itinerary_text: portNames.join(", "),
    ports_of_call_codes: doc.portsOfCall || [],
    destination_labels: destinationLabels,
    destination_codes: destinationCodes,
    region_labels: regionLabels,
    region_codes: regionCodes,
    sold_out: Boolean(doc.soldOut),
    locale: doc.language_country_code_s || localePrefix.replace("_", "/"),
    structured_source: "sbncruisesearch_api",
    raw_doc_keys: Object.keys(doc).length
  };
}

function normaliseSeabournPortCandidate(value) {
  const parsed = parseSeabournDelimited(value);
  let name = parsed.name || String(value || "").trim();
  if (!name) return { name: null, code: parsed.code || null };

  name = name
    .replace(/\bB\.C\.\b/gi, "British Columbia")
    .replace(/\bU\.S\.\b/gi, "US")
    .replace(/\bU\.K\.\b/gi, "UK")
    .replace(/\s+/g, " ")
    .trim();

  const aliasKey = name.toLowerCase();
  if (SEABOURN_EMBARK_PORT_ALIASES[aliasKey]) {
    return { name: SEABOURN_EMBARK_PORT_ALIASES[aliasKey], code: parsed.code || null, alias_applied: aliasKey };
  }

  return { name, code: parsed.code || null, alias_applied: null };
}

function resolveSeabournShip(raw, context = {}) {
  const { cruiseLine, ships = [], shipAliases = [] } = context;
  const lineShips = ships.filter((s) => s.cruise_line_id === cruiseLine?.id);

  const viaStructured = resolveShipForLine({
    rawShipName: raw.ship_name,
    rawShipCode: raw.ship_code,
    cruiseLineId: cruiseLine?.id,
    cruiseLineName: cruiseLine?.name || "Seabourn Cruise Line",
    ships: lineShips,
    aliases: shipAliases
  });

  if (viaStructured.resolved && viaStructured.method === "official_line_ship_id") {
    return { ...viaStructured, resolution_tier: "official_line_ship_code" };
  }
  if (viaStructured.resolved && ["exact_name", "stored_alias"].includes(viaStructured.method)) {
    return { ...viaStructured, resolution_tier: viaStructured.method };
  }

  const mappedName = SEABOURN_SHIP_CODE_TO_NAME[String(raw.ship_code || "").trim().toUpperCase()];
  if (mappedName) {
    const exact = resolveShipForLine({
      rawShipName: mappedName,
      cruiseLineId: cruiseLine?.id,
      cruiseLineName: cruiseLine?.name || "Seabourn Cruise Line",
      ships: lineShips,
      aliases: shipAliases
    });
    if (exact.resolved) {
      return {
        ...exact,
        method: "seabourn_ship_code_map",
        confidence: 100,
        resolution_tier: "seabourn_ship_code_map",
        source_code: raw.ship_code
      };
    }
  }

  if (viaStructured.resolved) {
    return { ...viaStructured, resolution_tier: viaStructured.method };
  }

  return { ...viaStructured, resolution_tier: "unresolved" };
}

function resolveSeabournDeparturePort(raw) {
  const embark = normaliseSeabournPortCandidate(raw.departure_port || "");
  const candidates = [embark.name, raw.departure_port, raw.departure_port_code].filter(Boolean);

  for (const value of candidates) {
    const meta = resolveRawPortText(value, { sourceField: "sbncruisesearch_api" });
    if (meta.status === "resolved") {
      return {
        ...meta,
        seabourn_alias_applied: embark.alias_applied || null,
        resolution_method: meta.confidence === "alias" || embark.alias_applied ? "alias" : "exact_or_normalised"
      };
    }
  }

  const fallback = resolveRawPortText(embark.name || raw.departure_port, { sourceField: "sbncruisesearch_api" });
  return {
    ...fallback,
    seabourn_alias_applied: embark.alias_applied || null,
    resolution_method: fallback.status === "resolved" ? "exact_or_normalised" : "unresolved"
  };
}

function assessSourceValidity(raw) {
  const issues = [];
  if (!String(raw?.cruise_id || "").trim()) issues.push("missing_cruise_id");
  if (!String(raw?.itinerary_id || "").trim()) issues.push("missing_itinerary_id");
  if (!String(raw?.ship_name || "").trim()) issues.push("missing_ship");
  if (!raw?.departure_date) issues.push("missing_departure_date");
  if (!(Number(raw?.nights) > 0)) issues.push("missing_duration");
  return { valid: issues.length === 0, issues };
}

function assessProductPolicy(productType) {
  if (productType === "cruisetour") {
    return { included: false, exclusion_reason: "policy_excluded_cruisetour" };
  }
  if (!isEligibleSeabournInventory(productType)) {
    return { included: false, exclusion_reason: "policy_excluded_product_type" };
  }
  return { included: true, exclusion_reason: null };
}

function determinePrimaryExclusion(context) {
  const {
    sourceValidity,
    productPolicy,
    cutoff,
    shipResolved,
    embarkResolved,
    destinationResolved,
    publicationReady
  } = context;

  if (!sourceValidity.valid) return "source_invalid";
  if (!productPolicy.included) return productPolicy.exclusion_reason;
  if (cutoff.past) return "past_departure";
  if (cutoff.within_21) return "within_21_day_cutoff";
  if (!shipResolved) return "required_ship_unresolved";
  if (!embarkResolved) return "required_embark_port_unresolved";
  if (!destinationResolved) return "required_destination_unresolved";
  if (!publicationReady) return "confidence_gate_failure";
  return null;
}

function evaluateVoyageEligibility(row, today = perthCalendarDate()) {
  const raw = row.raw || {};
  const sourceValidity = assessSourceValidity(raw);
  const productPolicy = assessProductPolicy(row.product_type);
  const shipResolved = row.ship_resolution?.resolved === true;
  const embarkResolved = row.candidate?.departure_port_meta?.status === "resolved";
  const destinationResolved = row.destination_resolution?.status === "resolved";
  const publicationReady =
    row.confidence?.outcome === "auto_publish" || row.confidence?.outcome === "high_confidence";

  const dep = row.candidate?.departure_date;
  const days = dep ? daysUntilDeparture(dep, today) : null;
  const cutoff = {
    past: days != null && days < 0,
    within_21: days != null && days >= 0 && days <= PUBLIC_BOOKING_CUTOFF_DAYS,
    outside_cutoff: days != null && days > PUBLIC_BOOKING_CUTOFF_DAYS
  };

  const secondaryReasons = [...(row.failure_reasons || [])];
  if (row.validation_reasons?.length) secondaryReasons.push(...row.validation_reasons);
  if (row.confidence?.reasons?.length) secondaryReasons.push(...row.confidence.reasons);

  const primary_exclusion_reason = determinePrimaryExclusion({
    sourceValidity,
    productPolicy,
    cutoff,
    shipResolved,
    embarkResolved,
    destinationResolved,
    publicationReady
  });

  const production_eligible = primary_exclusion_reason === null;

  return {
    source_validity: sourceValidity,
    product_policy: productPolicy,
    reference_resolution: {
      ship: shipResolved,
      embark_port: embarkResolved,
      destination: destinationResolved
    },
    publication: {
      outcome: row.confidence?.outcome || "unknown",
      ready: publicationReady,
      structured_source_trusted: row.confidence?.structured_source_trust?.trusted === true
    },
    cutoff,
    primary_exclusion_reason,
    secondary_diagnostic_reasons: [...new Set(secondaryReasons)],
    production_eligible
  };
}

function buildEligibilityWaterfall(normalised, today = perthCalendarDate()) {
  const evaluated = normalised.map((row) => ({
    row,
    eligibility: evaluateVoyageEligibility(row, today)
  }));

  const counts = Object.fromEntries(PRIMARY_EXCLUSION_ORDER.map((k) => [k, 0]));
  counts.production_eligible = 0;

  for (const { eligibility } of evaluated) {
    if (eligibility.production_eligible) counts.production_eligible += 1;
    else if (eligibility.primary_exclusion_reason) counts[eligibility.primary_exclusion_reason] += 1;
  }

  const uniqueProducts = normalised.length;
  const arithmetic = {
    valid_unique_source_products: uniqueProducts,
    policy_excluded_cruisetours: counts.policy_excluded_cruisetour,
    past_departures: counts.past_departure,
    within_21_day_exclusions: counts.within_21_day_cutoff,
    source_invalid_voyages: counts.source_invalid,
    required_ship_unresolved: counts.required_ship_unresolved,
    required_embark_port_unresolved: counts.required_embark_port_unresolved,
    required_destination_unresolved: counts.required_destination_unresolved,
    confidence_gate_failures: counts.confidence_gate_failure,
    production_eligible_dry_run: counts.production_eligible,
    reconciles:
      counts.production_eligible +
        PRIMARY_EXCLUSION_ORDER.reduce((sum, key) => sum + (counts[key] || 0), 0) ===
      uniqueProducts
  };

  return {
    as_of_date: today,
    cutoff_date: publicBookingCutoffDate(today),
    minimum_public_departure_date: publicBookingMinimumDepartureDate(today),
    cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    waterfall: counts,
    arithmetic,
    evaluated
  };
}

function buildEligibilityByProductType(normalised, today = perthCalendarDate()) {
  const types = ["ocean", "expedition", "combination", "extended", "grand_voyage", "cruisetour", "unknown"];
  const table = {};
  for (const type of types) {
    table[type] = {
      source_valid: 0,
      policy_excluded: 0,
      cutoff_excluded: 0,
      resolution_blocked: 0,
      confidence_blocked: 0,
      eligible: 0
    };
  }

  for (const row of normalised) {
    const type = row.product_type || "unknown";
    if (!table[type]) table[type] = { source_valid: 0, policy_excluded: 0, cutoff_excluded: 0, resolution_blocked: 0, confidence_blocked: 0, eligible: 0 };
    const ev = evaluateVoyageEligibility(row, today);
    if (!ev.source_validity.valid) continue;
    table[type].source_valid += 1;
    if (ev.primary_exclusion_reason === "policy_excluded_cruisetour" || ev.primary_exclusion_reason === "policy_excluded_product_type") {
      table[type].policy_excluded += 1;
    } else if (ev.primary_exclusion_reason === "past_departure" || ev.primary_exclusion_reason === "within_21_day_cutoff") {
      table[type].cutoff_excluded += 1;
    } else if (
      ["required_ship_unresolved", "required_embark_port_unresolved", "required_destination_unresolved"].includes(
        ev.primary_exclusion_reason
      )
    ) {
      table[type].resolution_blocked += 1;
    } else if (ev.primary_exclusion_reason === "confidence_gate_failure") {
      table[type].confidence_blocked += 1;
    } else if (ev.production_eligible) {
      table[type].eligible += 1;
    }
  }

  return table;
}

function buildEligibilityByShip(normalised, today = perthCalendarDate()) {
  const table = {};
  for (const row of normalised) {
    const ship = row.raw?.ship_name || "unknown";
    if (!table[ship]) {
      table[ship] = { valid_source_products: 0, excluded: 0, unresolved: 0, eligible: 0 };
    }
    const ev = evaluateVoyageEligibility(row, today);
    if (ev.source_validity.valid) table[ship].valid_source_products += 1;
    if (ev.production_eligible) {
      table[ship].eligible += 1;
    } else if (
      ["required_ship_unresolved", "required_embark_port_unresolved", "required_destination_unresolved"].includes(
        ev.primary_exclusion_reason
      )
    ) {
      table[ship].unresolved += 1;
    } else if (ev.primary_exclusion_reason) {
      table[ship].excluded += 1;
    }
  }
  return table;
}

function analyseEmbarkationPorts(normalised) {
  const byEmbark = new Map();

  for (const row of normalised) {
    const raw = row.raw || {};
    const name = raw.departure_port || null;
    const code = raw.departure_port_code || null;
    if (!name) continue;
    const key = `${name}|${code || ""}`;
    if (!byEmbark.has(key)) {
      byEmbark.set(key, {
        source_name: name,
        source_code: code,
        cruises_total: 0,
        cruises_blocked: 0,
        initially_resolved: null,
        now_resolved: false,
        canonical_port: null,
        resolution_method: null,
        alias_applied: null
      });
    }
    const entry = byEmbark.get(key);
    entry.cruises_total += 1;
    const embarkResolved = row.candidate?.departure_port_meta?.status === "resolved";
    if (!embarkResolved && row.product_type !== "cruisetour") entry.cruises_blocked += 1;
    if (entry.initially_resolved == null) {
      const direct = resolveRawPortText(name, { sourceField: "sbncruisesearch_api" });
      entry.initially_resolved = direct.status === "resolved";
    }
    if (embarkResolved) {
      entry.now_resolved = true;
      entry.canonical_port = row.candidate.departure_port_meta?.canonicalPortName || row.candidate.departure_port;
      entry.resolution_method = row.candidate.departure_port_meta?.resolution_method || row.candidate.departure_port_meta?.confidence;
      entry.alias_applied = row.candidate.departure_port_meta?.seabourn_alias_applied || null;
    }
  }

  const all = [...byEmbark.values()].sort((a, b) => b.cruises_blocked - a.cruises_blocked || b.cruises_total - a.cruises_total);
  const unresolved = all.filter((e) => e.cruises_blocked > 0);

  return {
    unique_embarkation_values: all.length,
    unique_embarkation_codes: new Set(all.map((e) => e.source_code).filter(Boolean)).size,
    initially_resolved: all.filter((e) => e.initially_resolved).length,
    now_resolved: all.filter((e) => e.now_resolved).length,
    still_unresolved: unresolved.length,
    cruises_blocked_by_embark: unresolved.reduce((sum, e) => sum + e.cruises_blocked, 0),
    mappings_added: SEABOURN_EMBARK_PORT_ALIASES,
    unresolved_sorted: unresolved.map((e) => ({
      source_name: e.source_name,
      source_code: e.source_code,
      cruises_blocked: e.cruises_blocked,
      cruises_total: e.cruises_total,
      likely_canonical_port: e.canonical_port,
      reason: e.now_resolved ? null : "Could not resolve to a canonical port in ports-catalogue.csv",
      recommended_action: e.source_name?.includes("AIRPORT") ? "policy_review_air_embark" : "proposed_port_alias_or_catalogue_addition"
    }))
  };
}

function resolveSeabournDestinationHints(raw) {
  const codes = (raw.destination_codes || []).map((c) => String(c).toUpperCase());
  const labelBlob = [...(raw.destination_labels || []), ...(raw.region_labels || []), raw.title]
    .filter(Boolean)
    .join(" ");

  if (/antarctica/i.test(labelBlob)) return { preferredSlug: "antarctica", method: "seabourn_label_antarctica" };
  if (/kimberley/i.test(labelBlob)) return { preferredSlug: "australia-new-zealand", method: "seabourn_kimberley" };
  if (/mediterranean/i.test(labelBlob)) return { preferredSlug: "mediterranean", method: "seabourn_label_mediterranean" };
  if (/japan|yokohama|tokyo/i.test(labelBlob)) return { preferredSlug: "japan", method: "seabourn_label_japan" };
  if (/transatlantic|atlantic crossing/i.test(labelBlob)) {
    return { preferredSlug: "transatlantic", method: "seabourn_transatlantic" };
  }
  if (/transpacific|pacific crossing/i.test(labelBlob)) {
    return { preferredSlug: "transpacific", method: "seabourn_transpacific" };
  }

  for (const code of codes) {
    const slug = SBN_DESTINATION_CODE_SLUG[code];
    if (slug) return { preferredSlug: slug, method: `seabourn_destination_code_${code}` };
  }

  if (raw.destination_labels?.[0]) {
    return { structuredDestination: raw.destination_labels.join(" "), method: "seabourn_destination_labels" };
  }
  return {};
}

function isEligibleSeabournInventory(productType) {
  return ["ocean", "expedition", "extended", "combination", "grand_voyage"].includes(productType);
}

function normaliseSeabournVoyage(raw, context = {}) {
  const {
    cruiseLine,
    ships = [],
    shipAliases = [],
    destinations = [],
    destinationAliases = [],
    productMeta = null,
    today = perthCalendarDate()
  } = context;

  const product = productMeta || classifySeabournProductType(raw);
  const inventoryEligibleType = isEligibleSeabournInventory(product.productType);

  const shipResolution = resolveSeabournShip(raw, context);

  const portMeta = resolveSeabournDeparturePort(raw);
  const destHints = resolveSeabournDestinationHints(raw);

  let candidate = {
    cruise_line_id: cruiseLine?.id,
    ship_id: shipResolution.resolved ? shipResolution.ship.id : null,
    departure_date: raw.departure_date,
    return_date: raw.return_date,
    nights: raw.nights,
    departure_port: portMeta.status === "resolved" ? portMeta.canonicalPortName : null,
    departure_port_meta: portMeta,
    itinerary: raw.itinerary_text || raw.title,
    official_url: raw.official_url,
    source_url: raw.official_url,
    raw_extract: {
      title: raw.title,
      description: raw.description,
      seabourn_cruise_id: raw.cruise_id,
      seabourn_itinerary_id: raw.itinerary_id,
      seabourn_solr_id: raw.solr_id,
      structured_source: raw.structured_source,
      departure_port_raw: raw.departure_port
    }
  };

  const destResult = resolveOperationalDestination({
    title: raw.title,
    description: [raw.description, raw.destination_labels?.join(" "), raw.region_labels?.join(" ")]
      .filter(Boolean)
      .join("\n"),
    itinerary: raw.itinerary_text,
    structuredDestination: destHints.structuredDestination || raw.destination_labels?.[0] || null,
    departurePort: candidate.departure_port || raw.departure_port,
    arrivalPort: raw.arrival_port,
    nights: raw.nights,
    destinations,
    destinationAliases,
    preferredDestination: destHints.preferredSlug ? { slug: destHints.preferredSlug } : null
  });

  const matchedDest = destinations.find((d) => d.slug === destResult.destinationKey);
  candidate.destination_id = matchedDest?.id || null;
  candidate.destination_key = destResult.destinationKey;

  const simDestinationId =
    candidate.destination_id ||
    (destResult.status === "resolved" && destResult.destinationKey ? `catalogue:${destResult.destinationKey}` : null);

  const structuredSourceTrust = evaluateCarnivalStructuredSourceTrust({
    structured_source: raw.structured_source,
    cruise_id: raw.cruise_id,
    itinerary_id: raw.itinerary_id,
    departure_date: candidate.departure_date,
    nights: candidate.nights,
    departure_port_meta: portMeta,
    destination_id: simDestinationId,
    shipResolution,
    destinationResolution: destResult,
    raw_extract: candidate.raw_extract
  });

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
    cruise_id: raw.cruise_id,
    itinerary_id: raw.itinerary_id,
    structured_source: raw.structured_source,
    structuredSourceTrust,
    cruiseLine,
    cruise_line_name: cruiseLine?.name,
    title: raw.title,
    shipResolution: shipResolution.resolved
      ? { ship: shipResolution.ship, method: shipResolution.method, confidence: shipResolution.confidence, resolved: true }
      : { resolved: false },
    destinationResolution: {
      resolved: destResult.status === "resolved",
      destination_id: simDestinationId,
      destination_key: destResult.destinationKey,
      confidence: destResult.confidence === "high" ? 95 : destResult.confidence === "medium" ? 80 : 60
    },
    ship_name: shipResolution.ship?.name || raw.ship_name
  });

  const failureReasons = [];
  if (product.productType === "cruisetour") failureReasons.push("policy_excluded_cruisetour");
  else if (!inventoryEligibleType) failureReasons.push("policy_excluded_product_type");
  if (!shipResolution.resolved) failureReasons.push("required_ship_unresolved");
  if (!candidate.departure_date) failureReasons.push("missing_departure_date");
  else if (candidate.departure_date < today) failureReasons.push("past_departure");
  if (!candidate.departure_port && candidate.departure_port_meta?.status !== "resolved") {
    failureReasons.push("required_embark_port_unresolved");
  }
  if (destResult.status === "unresolved") failureReasons.push("required_destination_unresolved");
  if (destResult.status === "ambiguous") failureReasons.push("required_destination_ambiguous");
  if (confidenceEval.outcome !== "auto_publish" && confidenceEval.outcome !== "high_confidence") {
    failureReasons.push("confidence_gate_failure");
  }

  const complete =
    inventoryEligibleType &&
    individual.proven &&
    destResult.status === "resolved" &&
    validationReasons.length === 0 &&
    portMeta.status === "resolved" &&
    shipResolution.resolved &&
    (confidenceEval.outcome === "auto_publish" || confidenceEval.outcome === "high_confidence");

  const eligibility = evaluateVoyageEligibility(
    {
      raw,
      candidate,
      product_type: product.productType,
      ship_resolution: shipResolution,
      destination_resolution: destResult,
      confidence: confidenceEval,
      failure_reasons: failureReasons,
      validation_reasons: validationReasons
    },
    today
  );

  return {
    raw,
    candidate,
    official_sailing_id: officialProductKey(raw),
    product_type: product.productType,
    product_meta: product,
    ship_resolution: shipResolution,
    destination_resolution: destResult,
    validation_reasons: validationReasons,
    confidence: confidenceEval,
    structured_source_trust: structuredSourceTrust,
    individual_gate: individual,
    complete_high_confidence: complete,
    projected_activation: complete,
    failure_reasons: [...new Set(failureReasons)],
    eligibility
  };
}

function analyseIdentity(records) {
  const byCruiseId = new Map();
  const byItineraryId = new Map();
  const byOfficial = new Map();
  const fallback = [];

  for (const row of records) {
    const raw = row.raw || row;
    const cruiseId = raw.cruise_id;
    const itineraryId = raw.itinerary_id;
    const official = officialProductKey(raw);
    if (cruiseId) {
      if (!byCruiseId.has(cruiseId)) byCruiseId.set(cruiseId, []);
      byCruiseId.get(cruiseId).push(official);
    }
    if (itineraryId) {
      if (!byItineraryId.has(itineraryId)) byItineraryId.set(itineraryId, []);
      byItineraryId.get(itineraryId).push(official);
    }
    if (official.includes("|")) {
      if (!byOfficial.has(official)) byOfficial.set(official, []);
      byOfficial.get(official).push(raw.cruise_id);
    } else {
      fallback.push(official);
    }
  }

  const collisionGroups = (map) =>
    [...map.entries()].filter(([, values]) => new Set(values).size > 1).map(([key, values]) => ({ key, values: [...new Set(values)] }));

  return {
    total_records: records.length,
    unique_cruise_id: byCruiseId.size,
    unique_itinerary_id: byItineraryId.size,
    unique_official_product_key: byOfficial.size,
    cruise_id_collisions: collisionGroups(byCruiseId),
    itinerary_id_collisions: collisionGroups(byItineraryId),
    official_key_collisions: collisionGroups(byOfficial),
    fallback_identity_count: fallback.length
  };
}

function analyseOverlappingProducts(records) {
  const byShipDate = new Map();
  for (const row of records) {
    const raw = row.raw || row;
    const ship = raw.ship_name || "?";
    const date = raw.departure_date || "?";
    const key = `${ship}|${date}`;
    if (!byShipDate.has(key)) byShipDate.set(key, []);
    byShipDate.get(key).push({
      official_sailing_id: officialProductKey(raw),
      cruise_id: raw.cruise_id,
      itinerary_id: raw.itinerary_id,
      name: raw.title,
      nights: raw.nights,
      tour_id: raw.tour_id,
      product_type: row.product_type || classifySeabournProductType(raw).productType
    });
  }
  const overlapping = [...byShipDate.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([key, products]) => ({ key, products }));
  return {
    overlapping_ship_date_groups: overlapping.length,
    samples: overlapping.slice(0, 10)
  };
}

function analysePorts(records) {
  const unique = new Map();
  for (const row of records) {
    for (const entry of row.raw?.itinerary_port_entries || []) {
      const key = entry.raw || entry.name;
      if (!key) continue;
      unique.set(key, entry.kind);
    }
    for (const field of ["departure_port", "arrival_port"]) {
      const value = row.raw?.[field];
      if (value) unique.set(value, "physical");
    }
  }

  const resolved = [];
  const unresolved = [];
  const scenic = [];
  const ambiguous = [];
  const numeric = [];
  const proposedAliases = [];

  for (const [value, kind] of unique.entries()) {
    if (kind === "scenic_or_transit") {
      scenic.push(value);
      continue;
    }
    if (kind === "ambiguous") {
      ambiguous.push(value);
      continue;
    }
    if (kind === "numeric_code") {
      numeric.push(value);
      continue;
    }
    const meta = resolveRawPortText(parseSeabournDelimited(value).name || value, {
      sourceField: "sbncruisesearch_api"
    });
    if (meta.status === "resolved") resolved.push({ value, port: meta.canonicalPortName });
    else {
      unresolved.push({ value, reason: meta.reason || meta.status });
      proposedAliases.push({ source: value, suggested_action: "review_alias" });
    }
  }

  return {
    unique_values: unique.size,
    resolved_physical_ports: resolved.length,
    unresolved_probable_physical_ports: unresolved,
    scenic_or_transit: scenic,
    ambiguous,
    numeric_codes: numeric,
    proposed_aliases: proposedAliases.slice(0, 50)
  };
}

function analyseDestinations(records) {
  const counts = {};
  const unresolved = [];
  const resolved = [];
  for (const row of records) {
    const key = row.destination_resolution?.destinationKey || "unresolved";
    counts[key] = (counts[key] || 0) + 1;
    if (row.destination_resolution?.status === "resolved") {
      resolved.push(key);
    } else {
      unresolved.push({
        title: row.raw?.title,
        labels: row.raw?.destination_labels,
        status: row.destination_resolution?.status
      });
    }
  }
  return {
    destination_counts: counts,
    resolved: [...new Set(resolved)].length,
    unresolved_samples: unresolved.slice(0, 20)
  };
}

function buildEligibilitySummary(normalised, today = perthCalendarDate()) {
  const waterfallResult = buildEligibilityWaterfall(normalised, today);
  return {
    as_of_date: waterfallResult.as_of_date,
    cutoff_date: waterfallResult.cutoff_date,
    minimum_public_departure_date: waterfallResult.minimum_public_departure_date,
    cutoff_days: waterfallResult.cutoff_days,
    unique_source_products: waterfallResult.arithmetic.valid_unique_source_products,
    past_departures: waterfallResult.waterfall.past_departure,
    within_21_day_exclusions: waterfallResult.waterfall.within_21_day_cutoff,
    incomplete_products: null,
    eligible_source_products: waterfallResult.waterfall.production_eligible,
    waterfall: waterfallResult.waterfall,
    arithmetic: waterfallResult.arithmetic,
    legacy_incomplete_products:
      waterfallResult.arithmetic.valid_unique_source_products -
      waterfallResult.waterfall.production_eligible -
      waterfallResult.waterfall.past_departure -
      waterfallResult.waterfall.within_21_day_cutoff
  };
}

async function fetchItineraryJsonLd(url, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    headers: { Accept: "text/html", "User-Agent": carnivalSolr.DEFAULT_USER_AGENT }
  });
  if (!response.ok) return { ok: false, status: response.status, url, trip: null };
  const html = await response.text();
  const match = html.match(/<script type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/i);
  if (!match) return { ok: true, status: response.status, url, trip: null };
  try {
    const trip = JSON.parse(match[1]);
    return { ok: true, status: response.status, url, trip };
  } catch {
    return { ok: true, status: response.status, url, trip: null, parse_error: true };
  }
}

async function probeItineraryInfo(itineraryId, fetchImpl = globalThis.fetch) {
  const attempts = [
    `https://www.seabourn.com/bin/carnival/itineraryInfo?brand=sbn&country=au&locale=en&itineraryCode=${encodeURIComponent(itineraryId)}`,
    `https://www.seabourn.com/bin/carnival/itineraryInfo?brandCode=sbn&itineraryCode=${encodeURIComponent(itineraryId)}`,
    `https://www.seabourn.com/bin/carnival/itineraryInfo.sbn.au.en.json?itineraryCode=${encodeURIComponent(itineraryId)}`
  ];
  const results = [];
  for (const url of attempts) {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": carnivalSolr.DEFAULT_USER_AGENT }
    });
    const text = await response.text();
    results.push({ url, status: response.status, length: text.length, sample: text.slice(0, 120) });
  }
  return results;
}

async function runItineraryEnrichmentSpike(samples, fetchImpl = globalThis.fetch) {
  const enriched = [];
  for (const row of samples) {
    const url = row.raw?.official_url || row.candidate?.official_url;
    const jsonLd = url ? await fetchItineraryJsonLd(url, fetchImpl) : null;
    const items = jsonLd?.trip?.itinerary?.itemListElement || [];
    enriched.push({
      official_sailing_id: row.official_sailing_id,
      url,
      product_type: row.product_type,
      json_ld_days: items.length,
      has_calendar_dates_on_days: items.some((i) => i?.item?.startDate || i?.item?.date),
      has_arrival_times: items.some((i) => i?.item?.arrivalTime),
      has_departure_times: items.some((i) => i?.item?.departureTime),
      sample_ports: items.slice(0, 3).map((i) => i?.item?.name).filter(Boolean)
    });
  }
  return enriched;
}

async function reconcileProductionReadOnly({ cruiseLineId, eligibleProducts, supabaseQuery }) {
  const rows =
    (await supabaseQuery?.(
      `discovered_cruises?cruise_line_id=eq.${cruiseLineId}&select=id,status,departure_date,ship_id,official_sailing_id,official_url,raw_extract&limit=5000`
    )) || [];

  const statusCounts = {};
  for (const row of rows) statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;

  const activeRows = rows.filter((r) => r.status === "active");
  const officialIds = new Set(eligibleProducts.map((p) => p.official_sailing_id).filter(Boolean));
  const productionOfficialIds = new Set(activeRows.map((r) => r.official_sailing_id).filter(Boolean));

  const recognised = eligibleProducts.filter((p) => productionOfficialIds.has(p.official_sailing_id));
  const outstanding = eligibleProducts.filter((p) => !productionOfficialIds.has(p.official_sailing_id));
  const sourceAbsentActive = activeRows.filter((r) => r.official_sailing_id && !officialIds.has(r.official_sailing_id));

  const legacy = rows.filter((r) => r.status !== "active");

  return {
    status_counts: statusCounts,
    active_count: activeRows.length,
    recognised_existing_eligible: recognised.length,
    outstanding_eligible_inserts: outstanding.length,
    proposed_updates: 0,
    source_absent_active: sourceAbsentActive.length,
    legacy_or_non_active_records: legacy.length,
    legacy_samples: legacy.slice(0, 5).map((r) => ({
      id: r.id,
      status: r.status,
      official_url: r.official_url,
      source_method: r.raw_extract?.discovery_11d2?.source_method || r.raw_extract?.structured_source || null
    })),
    reconciliation_arithmetic: {
      eligible_source_products: eligibleProducts.length,
      recognised_existing_eligible: recognised.length,
      outstanding_eligible_inserts: outstanding.length,
      source_absent_active: sourceAbsentActive.length
    }
  };
}

function catalogueDestinations(dbDestinations) {
  const bySlug = Object.fromEntries((dbDestinations || []).map((d) => [d.slug, d]));
  return OPERATIONAL_DESTINATION_CATALOGUE.map((cat) => {
    const row = bySlug[cat.slug];
    return (
      row || {
        id: null,
        name: cat.name,
        slug: cat.slug,
        status: cat.public_status,
        classification_enabled: cat.classification_enabled
      }
    );
  });
}

async function fetchAndParseCatalogue(options = {}) {
  const localePrefix = options.localePrefix || "en_us";
  const fetchResult = await source.fetchSeabournCatalogue(options);
  const parsed = [];
  for (const doc of fetchResult.docs) {
    const raw = parseRawVoyageFromDoc(doc, localePrefix);
    if (raw) parsed.push(raw);
  }
  return { fetchResult, parsed };
}

async function simulateSeabournDiscovery(context = {}) {
  const today = context.today || perthCalendarDate();
  const fetchImpl = context.fetchImpl || globalThis.fetch;
  const { fetchResult, parsed } = await fetchAndParseCatalogue({
    pageSize: context.pageSize,
    maxApiCalls: context.maxApiCalls,
    fetchImpl,
    useCache: context.useCache
  });

  const normalised = parsed.map((raw) =>
    normaliseSeabournVoyage(raw, {
      ...context,
      today,
      productMeta: classifySeabournProductType(raw)
    })
  );

  const identity = analyseIdentity(normalised);
  const overlap = analyseOverlappingProducts(normalised);
  const ports = analysePorts(normalised);
  const destinations = analyseDestinations(normalised);
  const eligibility = buildEligibilitySummary(normalised, today);
  const eligibilityByProductType = buildEligibilityByProductType(normalised, today);
  const eligibilityByShip = buildEligibilityByShip(normalised, today);
  const embarkationPorts = analyseEmbarkationPorts(normalised);

  const earliest = [...normalised]
    .map((n) => n.candidate.departure_date)
    .filter(Boolean)
    .sort()[0];
  const latest = [...normalised]
    .map((n) => n.candidate.departure_date)
    .filter(Boolean)
    .sort()
    .at(-1);

  const shipNames = [...new Set(normalised.map((n) => n.raw.ship_name).filter(Boolean))].sort();

  let enrichment = [];
  let itineraryInfoProbe = [];
  if (context.runEnrichment !== false) {
    const samples = [];
    const pick = (type) => normalised.find((n) => n.product_type === type);
    for (const t of ["ocean", "expedition", "combination", "grand_voyage", "extended"]) {
      const row = pick(t);
      if (row) samples.push(row);
    }
    samples.push(...normalised.filter((n) => n.complete_high_confidence).slice(0, 2));
    const uniqueSamples = [...new Map(samples.map((s) => [s.official_sailing_id, s])).values()].slice(0, 8);
    enrichment = await runItineraryEnrichmentSpike(uniqueSamples, fetchImpl);
    if (uniqueSamples[0]?.raw?.itinerary_id) {
      itineraryInfoProbe = await probeItineraryInfo(uniqueSamples[0].raw.itinerary_id, fetchImpl);
    }
  }

  let productionReconciliation = null;
  if (typeof context.supabaseQuery === "function" && context.cruiseLine?.id) {
    const eligible = normalised.filter((n) => n.eligibility?.production_eligible === true);
    productionReconciliation = await reconcileProductionReadOnly({
      cruiseLineId: context.cruiseLine.id,
      eligibleProducts: eligible,
      supabaseQuery: context.supabaseQuery
    });
  }

  return {
    mode: "seabourn_read_only_simulation",
    writes_performed: false,
    read_only: true,
    source_contract: SOURCE_CONTRACT,
    fetch_result: fetchResult,
    num_found_official: fetchResult.numFound,
    raw_rows_fetched: fetchResult.raw_rows_fetched,
    exact_solr_duplicates_removed: fetchResult.exact_solr_duplicate_rows_removed,
    product_key_suppressed_rows: fetchResult.product_key_suppressed_rows,
    source_row_accounting: fetchResult.source_row_accounting,
    unique_source_products: normalised.length,
    api_calls: fetchResult.api_calls,
    pagination: fetchResult.pagination,
    earliest_departure: earliest || null,
    latest_departure: latest || null,
    source_ships: shipNames,
    identity,
    overlap,
    ports,
    destinations,
    eligibility,
    eligibility_by_product_type: eligibilityByProductType,
    eligibility_by_ship: eligibilityByShip,
    embarkation_ports: embarkationPorts,
    enrichment,
    itinerary_info_probe: itineraryInfoProbe,
    production_reconciliation: productionReconciliation,
    products: normalised
  };
}

function buildDateDiagnostic(records, today = perthCalendarDate()) {
  const departures = records
    .map((r) => r.departure_date || r.raw?.departure_date || r.candidate?.departure_date)
    .filter(Boolean)
    .sort();
  const earliest20 = departures.slice(0, 20).map((date) => ({
    date,
    days_until: daysUntilDeparture(date, today),
    within_21_day_cutoff: daysUntilDeparture(date, today) != null && daysUntilDeparture(date, today) <= PUBLIC_BOOKING_CUTOFF_DAYS
  }));
  const beforeCutoff = departures.filter(
    (d) => daysUntilDeparture(d, today) != null && daysUntilDeparture(d, today) <= PUBLIC_BOOKING_CUTOFF_DAYS
  ).length;
  const onMinimum = departures.filter(
    (d) => daysUntilDeparture(d, today) === PUBLIC_BOOKING_CUTOFF_DAYS + 1
  ).length;
  const afterCutoff = departures.filter(
    (d) => daysUntilDeparture(d, today) != null && daysUntilDeparture(d, today) > PUBLIC_BOOKING_CUTOFF_DAYS
  ).length;

  return {
    as_of_date: today,
    cutoff_date: publicBookingCutoffDate(today),
    minimum_public_departure_date: publicBookingMinimumDepartureDate(today),
    earliest_departure: departures[0] || null,
    latest_departure: departures.at(-1) || null,
    earliest_20: earliest20,
    departing_before_or_on_cutoff: beforeCutoff,
    departing_on_minimum_public_date: onMinimum,
    departing_after_cutoff: afterCutoff
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  parseSeabournDelimited,
  parseRawVoyageFromDoc,
  officialProductKey,
  officialProductKeyFromDoc,
  classifySeabournProductType,
  classifyPortEntry,
  isEligibleSeabournInventory,
  normaliseSeabournPortCandidate,
  resolveSeabournShip,
  resolveSeabournDeparturePort,
  assessSourceValidity,
  evaluateVoyageEligibility,
  buildEligibilityWaterfall,
  buildEligibilityByProductType,
  buildEligibilityByShip,
  analyseEmbarkationPorts,
  normaliseSeabournVoyage,
  analyseIdentity,
  analyseOverlappingProducts,
  buildEligibilitySummary,
  buildDateDiagnostic,
  catalogueDestinations,
  SEABOURN_SHIP_CODE_TO_NAME,
  SEABOURN_EMBARK_PORT_ALIASES,
  simulateSeabournDiscovery,
  fetchItineraryJsonLd,
  probeItineraryInfo,
  reconcileProductionReadOnly,
  clearSeabournFetchCache: source.clearSeabournFetchCache
};
