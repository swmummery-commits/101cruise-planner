/**
 * Norwegian Cruise Line — read-only discovery adapter (Phase 2).
 *
 * Official source: NCL browse v1 itineraries + schedule-page completeItinerary enrichment.
 * No production writes in this module.
 */

const crypto = require("crypto");
const { resolveShipForLine } = require("./discovery-ship-resolver");
const { resolveRawPortText } = require("./discovery-departure-port");
const embarkPorts = require("./norwegian-embark-port-mappings");
const source = require("./norwegian-discovery-source");
const {
  daysUntilDeparture,
  partitionByPublicBookingCutoff,
  publicBookingCutoffDate,
  publicBookingMinimumDepartureDate,
  perthCalendarDate,
  PUBLIC_BOOKING_CUTOFF_DAYS
} = require("./public-discovered-cruise-inventory");

const ADAPTER_ID = source.ADAPTER_ID;
const ADAPTER_VERSION = source.ADAPTER_VERSION;
const SOURCE_CONTRACT = source.SOURCE_CONTRACT;

const LAND_TOUR_PREFIX_RE = /^(NB|SB)[A-Z0-9]/;
const CRUISETOUR_TOKEN_RE = /CRUISETOUR/i;

const NCL_SHIP_CODE_TO_NAME = Object.freeze({
  AQUA: "Norwegian Aqua",
  AURA: "Norwegian Aura",
  BLISS: "Norwegian Bliss",
  BREAKAWAY: "Norwegian Breakaway",
  DAWN: "Norwegian Dawn",
  ENCORE: "Norwegian Encore",
  EPIC: "Norwegian Epic",
  ESCAPE: "Norwegian Escape",
  GEM: "Norwegian Gem",
  GETAWAY: "Norwegian Getaway",
  JADE: "Norwegian Jade",
  JEWEL: "Norwegian Jewel",
  JOY: "Norwegian Joy",
  LUNA: "Norwegian Luna",
  PEARL: "Norwegian Pearl",
  PRIDE_AMER: "Pride of America",
  PRIMA: "Norwegian Prima",
  SKY: "Norwegian Sky",
  SPIRIT: "Norwegian Spirit",
  STAR: "Norwegian Star",
  SUN: "Norwegian Sun",
  VIVA: "Norwegian Viva"
});

const ENRICHMENT_SAMPLE_CODES = Object.freeze([
  "GETAWAY2MIANPIMIA",
  "GETAWAY3MIANPINASMIA",
  "SPIRIT16VANKTNJNUICYSITOGGNWKKOAITOHNL",
  "PRIMA3PCVPOPSJU",
  "PRIMA7SJUTOVBASPHIBGISTTSJU",
  "PRIDE_AMER7HNLOGGITOKOANWKHNL",
  "BLISS7SEAKTNJNUICYVICSEA",
  "VIVA10ISTKUSJTRJMKPIRKAKMLACTASALLIVCIV",
  "BREAKAWAY7BOSWRFBOS",
  "JADE9YOKSMZNGOKOBKCZHSMKOJNGSJJUINC",
  "STAR7CPHHAMIJMZEELEHSOU",
  "AQUA6MIAPOPSJUNPIMIA",
  "SUN7RAVZADDBVKOTCFUMSNSALCIV",
  "DAWN10BCNMRSLIVSPECIVSALCTAIBZPMIBCN"
]);

const PORT_ANALYSIS_SAMPLES = Object.freeze([
  "Great Stirrup Cay, Bahamas",
  "Orlando (Port Canaveral), Florida",
  "London (Southampton), United Kingdom",
  "Rome (Civitavecchia), Italy",
  "Athens (Piraeus), Greece",
  "Barcelona, Spain",
  "Barcelona (Tarragona), Spain",
  "Venice (Ravenna)",
  "Venice (Trieste)",
  "Ketchikan (Ward Cove), Alaska",
  "Honolulu, Oahu",
  "Nāwiliwili, Kaua'i",
  "Québec City, Canada",
  "Santiago (San Antonio), Chile",
  "Seoul (Incheon)",
  "Tokyo",
  "Tokyo (Yokohama)"
]);

function officialProductKey(row) {
  if (row?.official_product_key) return row.official_product_key;
  return source.officialProductKey(row?.itinerary_code, row?.departure_date);
}

function norwegianExternalKey(cruiseLineId, productKey) {
  const basis = `${ADAPTER_ID}|${cruiseLineId}|${productKey}`;
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 40);
}

function classifyNorwegianItinerary(record) {
  const itineraryCode = source.itineraryCodeFromRecord(record);
  const shipCode = String(record?.shipCode || "").trim().toUpperCase();

  if (!itineraryCode) {
    return {
      category: "ambiguous",
      reason: "missing_itinerary_code",
      itinerary_code: null,
      ship_code: shipCode || null
    };
  }

  if (CRUISETOUR_TOKEN_RE.test(itineraryCode)) {
    return {
      category: "cruisetour_package",
      reason: "explicit_cruisetour_token",
      itinerary_code: itineraryCode,
      ship_code: shipCode || null
    };
  }

  if (shipCode && itineraryCode.startsWith(shipCode)) {
    return {
      category: "ocean",
      reason: "itinerary_code_starts_with_ship_code",
      itinerary_code: itineraryCode,
      ship_code: shipCode
    };
  }

  if (LAND_TOUR_PREFIX_RE.test(itineraryCode)) {
    return {
      category: "cruisetour_package",
      reason: "land_tour_prefix_nb_or_sb",
      itinerary_code: itineraryCode,
      ship_code: shipCode || null
    };
  }

  if (shipCode) {
    return {
      category: "cruisetour_package",
      reason: "itinerary_code_missing_ship_prefix",
      itinerary_code: itineraryCode,
      ship_code: shipCode
    };
  }

  return {
    category: "ambiguous",
    reason: "missing_ship_code_for_prefix_check",
    itinerary_code: itineraryCode,
    ship_code: null
  };
}

function analyseItineraryClassification(itineraries) {
  const counts = { total: 0, ocean: 0, cruisetour_package: 0, ambiguous: 0 };
  const examples = { ocean: [], cruisetour_package: [], ambiguous: [] };
  const oceanWithoutShipPrefix = [];
  const cruisetourPassingProposedRule = [];

  for (const record of itineraries || []) {
    const classification = classifyNorwegianItinerary(record);
    counts.total += 1;
    counts[classification.category] = (counts[classification.category] || 0) + 1;

    if (examples[classification.category]?.length < 5) {
      examples[classification.category].push({
        itinerary_code: classification.itinerary_code,
        ship_code: classification.ship_code,
        reason: classification.reason
      });
    }

    const code = classification.itinerary_code;
    const ship = classification.ship_code;
    if (classification.category === "ocean" && ship && code && !code.startsWith(ship)) {
      oceanWithoutShipPrefix.push({ itinerary_code: code, ship_code: ship });
    }

    const proposedOcean =
      ship && code && code.startsWith(ship) && !CRUISETOUR_TOKEN_RE.test(code) && !LAND_TOUR_PREFIX_RE.test(code);
    if (proposedOcean && classification.category !== "ocean") {
      cruisetourPassingProposedRule.push({
        itinerary_code: code,
        ship_code: ship,
        actual_category: classification.category,
        reason: classification.reason
      });
    }
  }

  const safeToApply =
    counts.ambiguous === 0 &&
    oceanWithoutShipPrefix.length === 0 &&
    cruisetourPassingProposedRule.length === 0;

  return {
    counts,
    examples,
    validation: {
      ocean_without_ship_prefix: oceanWithoutShipPrefix,
      cruisetour_passing_proposed_rule: cruisetourPassingProposedRule,
      safe_to_apply_exclusion_rule: safeToApply,
      fail_closed: !safeToApply
    },
    final_rule: {
      ocean: "itinerary code starts with shipCode AND does not contain CRUISETOUR AND does not match NB/SB land-tour prefix",
      cruisetour_package:
        "contains CRUISETOUR OR itinerary code does not start with shipCode OR matches NB/SB land-tour prefix",
      ambiguous: "missing itinerary code or ship code prevents safe classification"
    }
  };
}

function parseRawSailingFromItinerary(record, sailingEntry) {
  const itineraryCode = source.itineraryCodeFromRecord(record);
  const parsedDate = source.parseSailingDateEntry(sailingEntry);
  const shipCode = String(record?.shipCode || "").trim().toUpperCase() || null;

  return {
    source: "ncl_browse_v1",
    itinerary_code: itineraryCode,
    ship_code: shipCode,
    ship_name: NCL_SHIP_CODE_TO_NAME[shipCode] || null,
    duration: Number(record?.duration) || null,
    port_of_departure_code: String(record?.portOfDepartureCode || "").trim().toUpperCase() || null,
    destination_codes: Array.isArray(record?.destinationCodes)
      ? record.destinationCodes.map((d) => String(d).trim().toUpperCase()).filter(Boolean)
      : [],
    departure_date: parsedDate.departure_date,
    return_date: parsedDate.return_date,
    official_product_key: source.officialProductKey(itineraryCode, parsedDate.departure_date),
    schedule_url: source.buildScheduleUrl(itineraryCode),
    raw_itinerary: record,
    raw_sailing_date: parsedDate.raw
  };
}

function buildShipMappings(filtersPayload, dbShips = []) {
  const filterShips = Array.isArray(filtersPayload?.ships?.values) ? filtersPayload.ships.values : [];
  const byName = new Map((dbShips || []).map((ship) => [String(ship.name || "").trim(), ship]));
  const mappings = [];
  const unresolved = [];

  for (const entry of filterShips) {
    const code = String(entry?.code || "").trim().toUpperCase();
    const title = String(entry?.title || "").trim();
    const expectedName = NCL_SHIP_CODE_TO_NAME[code] || title;
    const dbShip = byName.get(expectedName) || byName.get(title) || null;

    const row = {
      source_ship_code: code,
      source_ship_title: title,
      expected_db_name: expectedName,
      db_ship_id: dbShip?.id || null,
      db_ship_name: dbShip?.name || null,
      current_official_line_ship_id: dbShip?.official_line_ship_id ?? null,
      proposed_official_line_ship_id: code,
      resolved: Boolean(dbShip),
      method: dbShip ? "exact_name_match" : "unresolved"
    };

    if (dbShip) mappings.push(row);
    else unresolved.push(row);
  }

  return {
    total_source_ships: filterShips.length,
    resolved_count: mappings.length,
    unresolved_count: unresolved.length,
    mappings: mappings.sort((a, b) => a.source_ship_code.localeCompare(b.source_ship_code)),
    unresolved,
    proposed_db_updates: mappings
      .filter((row) => row.current_official_line_ship_id !== row.proposed_official_line_ship_id)
      .map((row) => ({
        ship_id: row.db_ship_id,
        ship_name: row.db_ship_name,
        current_official_line_ship_id: row.current_official_line_ship_id,
        proposed_official_line_ship_id: row.proposed_official_line_ship_id
      }))
  };
}

function resolveNorwegianShip(raw, context = {}) {
  const { cruiseLine, ships = [], shipAliases = [] } = context;
  const code = String(raw?.ship_code || "").trim().toUpperCase();
  const expectedName = NCL_SHIP_CODE_TO_NAME[code] || raw?.ship_name;

  const byOfficialId = ships.find(
    (ship) =>
      ship.cruise_line_id === cruiseLine?.id &&
      String(ship.official_line_ship_id || "").trim().toUpperCase() === code
  );
  if (byOfficialId) {
    return {
      resolved: true,
      ship: byOfficialId,
      method: "official_line_ship_id",
      confidence: "high",
      source_ship_code: code
    };
  }

  return resolveShipForLine({
    rawShipName: expectedName,
    cruiseLineId: cruiseLine?.id,
    cruiseLineName: cruiseLine?.name || "Norwegian Cruise Line",
    ships,
    aliases: shipAliases
  });
}

function buildEmbarkPortCodeMap(filtersPayload) {
  const candidates = [
    filtersPayload?.embPort?.values,
    filtersPayload?.embarkPorts?.values,
    filtersPayload?.departurePorts?.values
  ].find(Array.isArray);
  const values = candidates || [];
  return new Map(values.map((entry) => [String(entry.code || "").trim().toUpperCase(), String(entry.title || "").trim()]));
}

function resolveNorwegianDeparturePort(raw, embarkPortCodeMap = null) {
  const code = String(raw?.port_of_departure_code || "").trim().toUpperCase();
  const mappedCanonical = embarkPorts.getEmbarkPortCanonicalName(code);
  if (mappedCanonical) {
    const meta = resolveRawPortText(mappedCanonical, {
      sourceField: "ncl_embark_port_code",
      nclEmbarkPortCode: code
    });
    if (meta.status === "resolved" || meta.status === "alias") {
      return {
        ...meta,
        ncl_embark_port_code: code,
        resolution_method: "ncl_embark_port_code_map"
      };
    }
  }

  const mappedName = code && embarkPortCodeMap?.get ? embarkPortCodeMap.get(code) : null;
  const candidates = [raw?.departure_port, mappedName, raw?.port_of_departure_code].filter(Boolean);
  for (const value of candidates) {
    const meta = resolveRawPortText(value, { sourceField: "ncl_browse_v1", nclEmbarkPortCode: code || null });
    if (meta.status === "resolved" || meta.status === "alias") return meta;
  }
  return resolveRawPortText(mappedName || raw?.port_of_departure_code || raw?.departure_port, {
    sourceField: "ncl_browse_v1",
    nclEmbarkPortCode: code || null
  });
}

function classifyPortResolution(meta) {
  if (!meta) return "unresolved";
  if (meta.status === "resolved" && meta.method === "exact") return "exact_match";
  if (meta.status === "resolved" && /alias/i.test(meta.method || meta.reason || "")) return "existing_alias";
  if (meta.status === "resolved") return "safely_resolvable";
  if (meta.status === "ambiguous") return "ambiguous";
  return "unresolved";
}

function analysePortResolutionSamples(samples = PORT_ANALYSIS_SAMPLES) {
  const results = [];
  const summary = {
    exact_match: 0,
    existing_alias: 0,
    safely_resolvable: 0,
    unresolved: 0,
    ambiguous: 0
  };

  for (const value of samples) {
    const meta = resolveRawPortText(value, { sourceField: "ncl_schedule_enrichment" });
    const classification = classifyPortResolution(meta);
    summary[classification] = (summary[classification] || 0) + 1;
    results.push({
      source_port: value,
      classification,
      status: meta.status,
      method: meta.method || null,
      reason: meta.reason || null,
      canonical_port_name: meta.canonicalPortName || null,
      canonical_port_id: meta.canonicalPortId || null
    });
  }

  return {
    summary,
    results,
    unresolved_or_ambiguous: results.filter((row) => row.classification === "unresolved" || row.classification === "ambiguous")
  };
}

function normaliseNorwegianSailing(raw, context = {}) {
  const { cruiseLine, ships = [], shipAliases = [], today = perthCalendarDate(), embarkPortCodeMap = null } =
    context;
  const itineraryClassification = classifyNorwegianItinerary(raw.raw_itinerary || raw);
  const shipResolution = resolveNorwegianShip(raw, { cruiseLine, ships, shipAliases });
  const portMeta = resolveNorwegianDeparturePort(
    {
      departure_port: raw.departure_port,
      port_of_departure_code: raw.port_of_departure_code
    },
    embarkPortCodeMap
  );

  const failureReasons = [];
  if (itineraryClassification.category === "cruisetour_package") {
    failureReasons.push("cruisetour_excluded");
  } else if (itineraryClassification.category === "ambiguous") {
    failureReasons.push("ambiguous_itinerary_classification");
  }
  if (!shipResolution.resolved) failureReasons.push("unresolved_ship");
  if (!raw.departure_date) failureReasons.push("missing_departure_date");
  else if (raw.departure_date < today) failureReasons.push("past_departure");
  if (portMeta.status === "ambiguous") failureReasons.push("ambiguous_port");
  if (portMeta.status === "unresolved" || portMeta.status === "invalid" || portMeta.status === "missing") {
    failureReasons.push("unresolved_port");
  }

  const days = raw.departure_date ? daysUntilDeparture(raw.departure_date, today) : null;
  if (days != null && days <= PUBLIC_BOOKING_CUTOFF_DAYS) {
    failureReasons.push("within_21_day_exclusion");
  }

  const complete =
    itineraryClassification.category === "ocean" &&
    shipResolution.resolved &&
    Boolean(raw.departure_date) &&
    (portMeta.status === "resolved" || portMeta.status === "alias") &&
    (days == null || days > PUBLIC_BOOKING_CUTOFF_DAYS);

  return {
    raw,
    itinerary_classification: itineraryClassification,
    official_sailing_id: officialProductKey(raw),
    external_key: cruiseLine?.id && officialProductKey(raw)
      ? norwegianExternalKey(cruiseLine.id, officialProductKey(raw))
      : null,
    ship_resolution: shipResolution,
    departure_port_meta: portMeta,
    complete_eligible: complete,
    failure_reasons: [...new Set(failureReasons)]
  };
}

function analyseIdentity(sailings) {
  const byOfficial = new Map();
  const byExternal = new Map();

  for (const row of sailings || []) {
    const key = officialProductKey(row.raw || row);
    if (!key) continue;
    if (!byOfficial.has(key)) byOfficial.set(key, []);
    byOfficial.get(key).push(row);

    const external = row.external_key || null;
    if (external) {
      if (!byExternal.has(external)) byExternal.set(external, []);
      byExternal.get(external).push(key);
    }
  }

  const collisionGroups = (map) =>
    [...map.entries()]
      .filter(([, values]) => values.length > 1)
      .map(([key, values]) => ({ key, count: values.length, samples: values.slice(0, 3) }));

  return {
    total_records: sailings.length,
    unique_official_product_key: byOfficial.size,
    unique_external_key: byExternal.size,
    official_key_collisions: collisionGroups(byOfficial),
    external_key_collisions: collisionGroups(byExternal)
  };
}

function buildEligibilitySummary(normalised, today = perthCalendarDate()) {
  let pastCount = 0;
  let within21 = 0;
  let cruisetourCount = 0;
  let ambiguousCount = 0;
  let incompleteBeyondCutoff = 0;
  let publiclyEligibleOceanCount = 0;
  let importReadyCount = 0;
  let missingDateCount = 0;

  for (const row of normalised) {
    const category = row.itinerary_classification?.category;
    const dep = row.raw?.departure_date;
    const days = dep ? daysUntilDeparture(dep, today) : null;

    if (category === "cruisetour_package") {
      cruisetourCount += 1;
      continue;
    }
    if (category === "ambiguous") {
      ambiguousCount += 1;
      continue;
    }
    if (days == null) {
      missingDateCount += 1;
      continue;
    }
    if (days < 0) {
      pastCount += 1;
      continue;
    }
    if (days <= PUBLIC_BOOKING_CUTOFF_DAYS) {
      within21 += 1;
      continue;
    }

    publiclyEligibleOceanCount += 1;
    if (row.complete_eligible) importReadyCount += 1;
    else incompleteBeyondCutoff += 1;
  }

  const uniqueProducts = normalised.length;
  const incompleteCount = missingDateCount + incompleteBeyondCutoff;
  const arithmetic = {
    unique_source_sailings: uniqueProducts,
    minus_cruisetour_or_package: cruisetourCount,
    minus_ambiguous: ambiguousCount,
    minus_missing_departure_date: missingDateCount,
    minus_past_departures: pastCount,
    minus_within_21_day_exclusions: within21,
    minus_incomplete_ocean_beyond_cutoff: incompleteBeyondCutoff,
    equals_import_ready_ocean_sailings: importReadyCount,
    equals_publicly_eligible_ocean_sailings: publiclyEligibleOceanCount,
    reconciles:
      cruisetourCount +
        ambiguousCount +
        missingDateCount +
        pastCount +
        within21 +
        incompleteBeyondCutoff +
        importReadyCount ===
      uniqueProducts
  };

  return {
    as_of_date: today,
    cutoff_date: publicBookingCutoffDate(today),
    minimum_public_departure_date: publicBookingMinimumDepartureDate(today),
    cutoff_days: PUBLIC_BOOKING_CUTOFF_DAYS,
    unique_source_sailings: uniqueProducts,
    cruisetour_or_package_exclusions: cruisetourCount,
    ambiguous_itineraries: ambiguousCount,
    past_departures: pastCount,
    within_21_day_exclusions: within21,
    missing_departure_date: missingDateCount,
    incomplete_ocean_sailings: incompleteCount,
    incomplete_ocean_beyond_cutoff: incompleteBeyondCutoff,
    publicly_eligible_ocean_sailings: publiclyEligibleOceanCount,
    import_ready_ocean_sailings: importReadyCount,
    eligible_ocean_sailings: publiclyEligibleOceanCount,
    arithmetic
  };
}

function extractCompleteItineraryFromHtml(html) {
  const text = String(html || "");
  if (!text) return { ok: false, reason: "empty_html", completeItinerary: null };

  const attrMatch = text.match(/data-recently-viewed-cruise=(["'])([\s\S]*?)\1/i);
  if (attrMatch?.[2]) {
    try {
      const decoded = attrMatch[2]
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
      const payload = JSON.parse(decoded);
      if (payload?.completeItinerary) {
        return { ok: true, method: "data-recently-viewed-cruise", completeItinerary: payload.completeItinerary };
      }
    } catch {
      /* fall through */
    }
  }

  const marker = '{"completeItinerary":';
  const start = text.indexOf(marker);
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const snippet = text.slice(start, i + 1);
          try {
            const payload = JSON.parse(snippet);
            if (payload?.completeItinerary) {
              return { ok: true, method: "embedded_json_scan", completeItinerary: payload.completeItinerary };
            }
          } catch {
            return { ok: false, reason: "json_parse_failed", completeItinerary: null };
          }
          break;
        }
      }
    }
  }

  return { ok: false, reason: "complete_itinerary_not_found", completeItinerary: null };
}

function parseEnrichedItinerary(completeItinerary) {
  if (!completeItinerary || typeof completeItinerary !== "object") {
    return {
      ok: false,
      title: null,
      embarkation_port: null,
      disembarkation_port: null,
      ordered_ports: [],
      package_id: null,
      sail_id: null,
      official_url: null,
      supported_fields: [],
      unsupported_fields: [
        "per_port_dates",
        "arrival_times",
        "departure_times",
        "explicit_sea_days",
        "explicit_overnight_indicators"
      ]
    };
  }

  const title = completeItinerary?.titleData?.title || completeItinerary?.title || null;
  const embarkation_port =
    completeItinerary?.portsData?.embarkationPort?.title ||
    completeItinerary?.portsData?.embarkationPort?.name ||
    null;
  const disembarkation_port =
    completeItinerary?.portsData?.disembarkationPort?.title ||
    completeItinerary?.portsData?.disembarkationPort?.name ||
    null;
  const ordered_ports = (completeItinerary?.portsData?.portsOfCall || [])
    .map((port) => port?.title || port?.name || port?.code || null)
    .filter(Boolean);
  const firstSailing = Array.isArray(completeItinerary?.sailings) ? completeItinerary.sailings[0] : null;

  return {
    ok: true,
    title,
    embarkation_port,
    disembarkation_port,
    ordered_ports,
    ordered_port_count: ordered_ports.length,
    package_id: firstSailing?.packageId || completeItinerary?.packageId || null,
    sail_id: firstSailing?.sailId || completeItinerary?.sailId || null,
    official_url: completeItinerary?.url || completeItinerary?.canonicalUrl || null,
    bundle_type: completeItinerary?.bundleType || null,
    ship_name: completeItinerary?.ship?.title || completeItinerary?.ship?.name || null,
    duration: completeItinerary?.duration || null,
    supported_fields: ["title", "embarkation_port", "disembarkation_port", "ordered_ports", "packageId", "sailId"],
    unsupported_fields: [
      "per_port_dates",
      "arrival_times",
      "departure_times",
      "explicit_sea_days",
      "explicit_overnight_indicators"
    ]
  };
}

async function fetchItineraryEnrichment(itineraryCode, fetchImpl = globalThis.fetch) {
  const url = source.buildScheduleUrl(itineraryCode);
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": source.USER_AGENT,
      Referer: `${source.SITE_ORIGIN}${source.LOCALE_PREFIX}/vacations`
    }
  });

  if (!response.ok) {
    return {
      itinerary_code: itineraryCode,
      url,
      ok: false,
      status: response.status,
      extraction: { ok: false, reason: `http_${response.status}` },
      parsed: parseEnrichedItinerary(null)
    };
  }

  const html = await response.text();
  const extraction = extractCompleteItineraryFromHtml(html);
  const parsed = parseEnrichedItinerary(extraction.completeItinerary);

  return {
    itinerary_code: itineraryCode,
    url,
    ok: extraction.ok,
    status: response.status,
    extraction_method: extraction.method || extraction.reason || null,
    parsed
  };
}

async function runEnrichmentSample(fetchImpl = globalThis.fetch, sampleCodes = ENRICHMENT_SAMPLE_CODES) {
  const results = [];
  for (const code of sampleCodes) {
    results.push(await fetchItineraryEnrichment(code, fetchImpl));
  }
  return results;
}

function isLegacyGenericDiscoveryRow(row) {
  const url = String(row?.official_url || "");
  const extract = row?.raw_extract || {};
  const method = extract?.discovery_11d2?.source_method || extract?.structured_source || extract?.source || null;
  if (method && /generic|marketing|blog|destination_hub/i.test(String(method))) return true;
  if (!row?.official_sailing_id && !row?.departure_date) return true;
  if (/blog|\/destinations\/|\/vacations\?/i.test(url)) return true;
  return false;
}

function isGenuineInventoryRow(row) {
  if (!row || isLegacyGenericDiscoveryRow(row)) return false;
  return Boolean(row.official_sailing_id);
}

function indexGenuineRowsByOfficialId(genuineRows) {
  const byOfficial = new Map();
  for (const row of genuineRows || []) {
    const key = row.official_sailing_id;
    if (!key) continue;
    if (!byOfficial.has(key)) byOfficial.set(key, []);
    byOfficial.get(key).push(row);
  }
  return byOfficial;
}

function findDuplicateIdentityGroups(genuineRows, keySelector) {
  const groups = new Map();
  for (const row of genuineRows || []) {
    const key = keySelector(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.id);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, count: ids.length, ids }));
}

async function reconcileProductionReadOnly({ cruiseLineId, eligibleProducts, supabaseQuery, today = perthCalendarDate() }) {
  const rows =
    (await supabaseQuery?.(
      `discovered_cruises?cruise_line_id=eq.${cruiseLineId}&select=id,status,departure_date,ship_id,official_sailing_id,official_url,external_key,identity_key,itinerary,raw_extract&limit=5000`
    )) || [];

  const statusCounts = {};
  for (const row of rows) statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;

  const legacyGenericRows = rows.filter((r) => isLegacyGenericDiscoveryRow(r));
  const genuineRows = rows.filter((r) => isGenuineInventoryRow(r));
  const activeRows = rows.filter((r) => r.status === "active");
  const genuineActiveRows = genuineRows.filter((r) => r.status === "active");
  const genuineMatchRequiredRows = genuineRows.filter((r) => r.status === "match_required");
  const genuineHiddenRows = genuineRows.filter((r) => r.status === "hidden");
  const genuineOtherStatusRows = genuineRows.filter(
    (r) => !["active", "match_required", "hidden"].includes(r.status)
  );

  const eligibleByOfficial = new Map(
    eligibleProducts.map((p) => [p.official_sailing_id, p]).filter(([key]) => Boolean(key))
  );

  const genuineByOfficial = indexGenuineRowsByOfficialId(genuineRows);
  const productionOfficialIds = new Set(genuineByOfficial.keys());

  const recognised = eligibleProducts.filter((p) => productionOfficialIds.has(p.official_sailing_id));
  const outstanding = eligibleProducts.filter((p) => !productionOfficialIds.has(p.official_sailing_id));

  const recognisedActive = recognised.filter((p) =>
    (genuineByOfficial.get(p.official_sailing_id) || []).some((r) => r.status === "active")
  );
  const recognisedMatchRequired = recognised.filter((p) =>
    (genuineByOfficial.get(p.official_sailing_id) || []).some((r) => r.status === "match_required")
  );
  const recognisedOtherStatuses = recognised.filter((p) => {
    const statuses = new Set((genuineByOfficial.get(p.official_sailing_id) || []).map((r) => r.status));
    return !statuses.has("active") && !statuses.has("match_required");
  });

  const sourceAbsentExisting = genuineRows.filter(
    (r) => r.official_sailing_id && !eligibleByOfficial.has(r.official_sailing_id)
  );
  const sourceAbsentActive = sourceAbsentExisting.filter((r) => r.status === "active");

  const duplicateOfficialSailingIds = findDuplicateIdentityGroups(genuineRows, (r) => r.official_sailing_id);
  const duplicateExternalKeys = findDuplicateIdentityGroups(genuineRows, (r) => r.external_key);
  const duplicateItineraryDate = findDuplicateIdentityGroups(
    genuineRows,
    (r) => `${r.itinerary || ""}|${r.departure_date || ""}`
  );
  const duplicateIdentityKeys = findDuplicateIdentityGroups(genuineRows, (r) => r.identity_key);

  const identityCollisions =
    duplicateOfficialSailingIds.length +
    duplicateExternalKeys.length +
    duplicateItineraryDate.length +
    duplicateIdentityKeys.length;

  const publication_state = {
    active_public: genuineActiveRows.length,
    match_required_review: genuineMatchRequiredRows.length,
    hidden_genuine: genuineHiddenRows.length,
    other_genuine_statuses: genuineOtherStatusRows.length
  };

  const source_recognition = {
    recognised_existing_eligible: recognised.length,
    recognised_active: recognisedActive.length,
    recognised_match_required: recognisedMatchRequired.length,
    recognised_other_statuses: recognisedOtherStatuses.length,
    outstanding_eligible_inserts: outstanding.length,
    proposed_updates: 0,
    source_absent_existing: sourceAbsentExisting.length,
    source_absent_active: sourceAbsentActive.length,
    legacy_generic_ignored: legacyGenericRows.length
  };

  const reconciliation_arithmetic = {
    eligible_source_ocean_sailings: eligibleProducts.length,
    recognised_existing_eligible: recognised.length,
    outstanding_eligible_inserts: outstanding.length,
    proposed_updates: 0,
    source_absent_existing: sourceAbsentExisting.length,
    source_absent_active: sourceAbsentActive.length,
    legacy_generic_ignored: legacyGenericRows.length,
    duplicate_identity_groups:
      duplicateOfficialSailingIds.length +
      duplicateExternalKeys.length +
      duplicateItineraryDate.length +
      duplicateIdentityKeys.length,
    reconciles:
      recognised.length + outstanding.length === eligibleProducts.length &&
      identityCollisions === 0 &&
      sourceAbsentActive.length <= genuineActiveRows.length
  };

  return {
    status_counts: statusCounts,
    total_rows: rows.length,
    active_count: activeRows.length,
    genuine_inventory_rows: genuineRows.length,
    genuine_active_count: genuineActiveRows.length,
    legacy_generic_rows: legacyGenericRows.length,
    legacy_generic_samples: legacyGenericRows.slice(0, 9).map((r) => ({
      id: r.id,
      status: r.status,
      official_url: r.official_url,
      official_sailing_id: r.official_sailing_id,
      source_method: r.raw_extract?.discovery_11d2?.source_method || r.raw_extract?.structured_source || null
    })),
    publication_state,
    source_recognition,
    recognised_existing_eligible: recognised.length,
    outstanding_eligible_inserts: outstanding.length,
    proposed_updates: 0,
    source_absent_existing: sourceAbsentExisting.length,
    source_absent_active: sourceAbsentActive.length,
    within_21_day_exclusions_count: 0,
    non_ocean_exclusions_count: null,
    duplicate_diagnostics: {
      duplicate_official_sailing_ids: duplicateOfficialSailingIds,
      duplicate_external_keys: duplicateExternalKeys,
      duplicate_itinerary_date: duplicateItineraryDate,
      duplicate_identity_keys: duplicateIdentityKeys,
      duplicate_count:
        duplicateOfficialSailingIds.length +
        duplicateExternalKeys.length +
        duplicateItineraryDate.length +
        duplicateIdentityKeys.length
    },
    classification_counts: {
      genuine_inventory: genuineRows.length,
      legacy_generic: legacyGenericRows.length,
      active_public: genuineActiveRows.length,
      match_required_review: genuineMatchRequiredRows.length,
      hidden_genuine: genuineHiddenRows.length,
      other_genuine_statuses: genuineOtherStatusRows.length
    },
    reconciliation_arithmetic,
    as_of_date: today
  };
}

function auditEmbarkPortCatalogue() {
  const { resetPortsCache } = require("./discovery-departure-port");
  resetPortsCache();

  return embarkPorts.listEmbarkPorts().map((mapping) => {
    const meta = resolveRawPortText(mapping.canonical_name, { sourceField: "ncl_embark_port_audit" });
    const titleMeta = resolveRawPortText(mapping.source_name, { sourceField: "ncl_embark_port_audit" });
    const codeMeta = resolveNorwegianDeparturePort(
      { port_of_departure_code: mapping.code },
      buildEmbarkPortCodeMap({ embPort: { values: [{ code: mapping.code, title: mapping.source_name }] } })
    );

    let liveClassification = mapping.classification;
    if (meta.status !== "resolved" && meta.status !== "alias") {
      if (mapping.classification === "NEW_PORT_REQUIRED") liveClassification = "NEW_PORT_REQUIRED";
      else liveClassification = "AMBIGUOUS";
    } else if (titleMeta.canonicalPortName && meta.canonicalPortName && titleMeta.canonicalPortName !== meta.canonicalPortName) {
      liveClassification = "DISTINCT_PORT_REQUIRED";
    } else if (codeMeta.canonicalPortName === meta.canonicalPortName) {
      liveClassification = mapping.classification;
    }

    return {
      ncl_code: mapping.code,
      ncl_source_name: mapping.source_name,
      mapped_canonical_name: mapping.canonical_name,
      resolver_canonical_name: meta.canonicalPortName,
      code_resolution_canonical_name: codeMeta.canonicalPortName || null,
      classification: liveClassification,
      proposed_action:
        liveClassification === "NEW_PORT_REQUIRED"
          ? "add_canonical_port"
          : liveClassification === "DISTINCT_PORT_REQUIRED"
            ? "use_ncl_code_map_and_alias"
            : liveClassification === "AMBIGUOUS"
              ? "manual_review"
              : "ready",
      note: mapping.note || null
    };
  });
}

function analyseBlockedVoyages(normalised, today = perthCalendarDate()) {
  const blocked = normalised.filter((row) => !row.complete_eligible);
  const byReason = {};
  const byEmbarkCode = {};

  for (const row of blocked) {
    for (const reason of row.failure_reasons || ["unknown"]) {
      byReason[reason] = (byReason[reason] || 0) + 1;
    }
    const code = row.raw?.port_of_departure_code || "unknown";
    if ((row.failure_reasons || []).some((r) => /port/i.test(r))) {
      byEmbarkCode[code] = (byEmbarkCode[code] || 0) + 1;
    }
  }

  const examples = {};
  for (const [reason, count] of Object.entries(byReason)) {
    examples[reason] = blocked
      .filter((row) => (row.failure_reasons || []).includes(reason))
      .slice(0, 3)
      .map((row) => ({
        official_sailing_id: row.official_sailing_id,
        itinerary_code: row.raw?.itinerary_code,
        ship_code: row.raw?.ship_code,
        departure_date: row.raw?.departure_date,
        embark_port_code: row.raw?.port_of_departure_code,
        embark_port_meta: row.departure_port_meta?.canonicalPortName || null
      }));
  }

  const publiclyEligibleBlocked = blocked.filter((row) => {
    if (row.itinerary_classification?.category !== "ocean") return false;
    const days = row.raw?.departure_date ? daysUntilDeparture(row.raw.departure_date, today) : null;
    return days != null && days > PUBLIC_BOOKING_CUTOFF_DAYS;
  });

  return {
    total_blocked: blocked.length,
    publicly_eligible_blocked: publiclyEligibleBlocked.length,
    by_reason: byReason,
    by_embark_port_code: Object.entries(byEmbarkCode)
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({
        embark_port_code: code,
        ncl_source_name: embarkPorts.getEmbarkPortMapping(code)?.source_name || null,
        blocked_voyage_count: count
      })),
    examples
  };
}

function assessPortOfCallEnrichmentNeeds(enrichment = []) {
  const { resetPortsCache } = require("./discovery-departure-port");
  resetPortsCache();

  const portNames = new Set();
  for (const row of enrichment) {
    for (const port of row.parsed?.ordered_ports || []) {
      const cleaned = String(port || "")
        .replace(/&#x27;/g, "'")
        .trim();
      if (cleaned) portNames.add(cleaned);
    }
    for (const field of ["embarkation_port", "disembarkation_port"]) {
      const value = row.parsed?.[field];
      if (value) portNames.add(String(value).trim());
    }
  }

  const results = [...portNames].sort().map((sourcePort) => {
    const meta = resolveRawPortText(sourcePort, { sourceField: "ncl_schedule_enrichment" });
    return {
      source_port: sourcePort,
      classification: classifyPortResolution(meta),
      canonical_port_name: meta.canonicalPortName || null
    };
  });

  const unresolved = results.filter((row) => row.classification === "unresolved" || row.classification === "ambiguous");

  return {
    unique_ports_of_call: results.length,
    resolved: results.filter((row) => row.classification !== "unresolved" && row.classification !== "ambiguous").length,
    unresolved_or_ambiguous: unresolved,
    recommendation:
      "Option B — allow voyage insertion once ship, embarkation port and core voyage identity resolve; enrich itinerary ports of call in a follow-up pass. NCL structured data lacks per-port dates anyway, so blocking import on every port-of-call alias would delay inventory unnecessarily.",
    rationale: [
      "Embark ports are now code-mapped and catalogue-backed.",
      "Port-of-call vocabulary largely overlaps embark naming patterns.",
      "Private destinations (Great Stirrup Cay) and terminal variants (Ward Cove) can be enriched post-insert without changing voyage identity.",
      "Cruise Finder can show voyage-level inventory before every itinerary stop is canonicalised."
    ]
  };
}

async function fetchAndParseCatalogue(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const [browse, filters] = await Promise.all([
    source.fetchNorwegianBrowseCatalogue({ ...options, fetchImpl }),
    source.fetchNorwegianFilters({ ...options, fetchImpl })
  ]);

  const expanded = source.expandBrowseCatalogue(browse.records);
  const classification = analyseItineraryClassification(expanded.itineraries);

  return {
    browse,
    filters,
    itineraries: expanded.itineraries,
    sailings: expanded.sailings,
    classification
  };
}

async function simulateNorwegianDiscovery(context = {}) {
  const today = context.today || perthCalendarDate();
  const fetchImpl = context.fetchImpl || globalThis.fetch;
  const { browse, filters, itineraries, sailings, classification } = await fetchAndParseCatalogue({
    fetchImpl,
    useCache: context.useCache
  });

  const shipMappings = buildShipMappings(filters.filters, context.ships || []);
  const embarkPortCodeMap = buildEmbarkPortCodeMap(filters.filters);
  const normalised = sailings.map((raw) =>
    normaliseNorwegianSailing(raw, {
      ...context,
      today,
      embarkPortCodeMap
    })
  );

  const oceanSailings = normalised.filter((row) => row.itinerary_classification?.category === "ocean");
  const identityOcean = analyseIdentity(oceanSailings);
  const identityAll = analyseIdentity(normalised);
  const eligibility = buildEligibilitySummary(normalised, today);
  const portAnalysis = analysePortResolutionSamples(context.portSamples || PORT_ANALYSIS_SAMPLES);
  const embarkPortAudit = auditEmbarkPortCatalogue();
  const blockedAnalysis = analyseBlockedVoyages(normalised, today);

  const departures = normalised.map((n) => n.raw?.departure_date).filter(Boolean).sort();
  const earliest = departures[0] || null;
  const latest = departures.at(-1) || null;

  let enrichment = [];
  if (context.runEnrichment !== false) {
    enrichment = await runEnrichmentSample(fetchImpl, context.enrichmentCodes || ENRICHMENT_SAMPLE_CODES);
  }

  let productionReconciliation = null;
  if (typeof context.supabaseQuery === "function" && context.cruiseLine?.id) {
    const eligible = normalised.filter((row) => {
      if (row.itinerary_classification?.category !== "ocean") return false;
      const dep = row.raw?.departure_date;
      const days = dep ? daysUntilDeparture(dep, today) : null;
      return days != null && days > PUBLIC_BOOKING_CUTOFF_DAYS;
    });
    productionReconciliation = await reconcileProductionReadOnly({
      cruiseLineId: context.cruiseLine.id,
      eligibleProducts: eligible,
      supabaseQuery: context.supabaseQuery,
      today
    });
    productionReconciliation.non_ocean_exclusions_count = eligibility.cruisetour_or_package_exclusions;
    productionReconciliation.within_21_day_exclusions_count = eligibility.within_21_day_exclusions;
  }

  const { publiclyEligible, withinCutoff } = partitionByPublicBookingCutoff(
    oceanSailings.map((row) => row.raw),
    (row) => row.departure_date,
    today
  );

  return {
    mode: "norwegian_read_only_simulation",
    writes_performed: false,
    read_only: true,
    source_contract: SOURCE_CONTRACT,
    source_timestamp: browse.fetched_at,
    browse_record_count: browse.record_count,
    raw_sailing_count: sailings.length,
    ocean_sailing_count: oceanSailings.length,
    publicly_eligible_ocean_sailings_shared_cutoff: publiclyEligible.length,
    within_cutoff_ocean_sailings_shared_cutoff: withinCutoff.length,
    earliest_departure: earliest,
    latest_departure: latest,
    classification,
    ship_mappings: shipMappings,
    identity_all: identityAll,
    identity_ocean: identityOcean,
    eligibility,
    port_analysis: portAnalysis,
    embark_port_audit: embarkPortAudit,
    blocked_voyage_analysis: blockedAnalysis,
    port_of_call_enrichment: assessPortOfCallEnrichmentNeeds(enrichment),
    enrichment,
    production_reconciliation: productionReconciliation,
    products: normalised
  };
}

module.exports = {
  ADAPTER_ID,
  ADAPTER_VERSION,
  SOURCE_CONTRACT,
  NCL_SHIP_CODE_TO_NAME,
  ENRICHMENT_SAMPLE_CODES,
  PORT_ANALYSIS_SAMPLES,
  officialProductKey,
  norwegianExternalKey,
  classifyNorwegianItinerary,
  analyseItineraryClassification,
  parseRawSailingFromItinerary,
  buildShipMappings,
  buildEmbarkPortCodeMap,
  resolveNorwegianShip,
  resolveNorwegianDeparturePort,
  classifyPortResolution,
  analysePortResolutionSamples,
  normaliseNorwegianSailing,
  analyseIdentity,
  buildEligibilitySummary,
  extractCompleteItineraryFromHtml,
  parseEnrichedItinerary,
  fetchItineraryEnrichment,
  runEnrichmentSample,
  reconcileProductionReadOnly,
  auditEmbarkPortCatalogue,
  analyseBlockedVoyages,
  assessPortOfCallEnrichmentNeeds,
  fetchAndParseCatalogue,
  simulateNorwegianDiscovery,
  isLegacyGenericDiscoveryRow,
  isGenuineInventoryRow
};
