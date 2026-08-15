/**
 * Disney Phase 2D — voyage endpoint evidence model.
 * Explicit title/structured endpoints must not be overridden by harvest filter provenance.
 */

const crypto = require("crypto");
const { resolveRawPortText } = require("./discovery-departure-port");

const ENDPOINT_TIER = Object.freeze({
  STRUCTURED: 1,
  PRODUCT_TITLE: 2,
  PRODUCT_ID_SLUG: 3,
  CITY_FILTER_PROVENANCE: 4,
  ITINERARY_INFERENCE: 5
});

const DISNEY_EMBARK_PRODUCT_ID_MAP = Object.freeze({
  port_canaveral: "Port Canaveral (Orlando), Florida",
  fort_lauderdale: "Fort Lauderdale (Port Everglades), Florida",
  singapore: "Singapore",
  vancouver: "Vancouver, Canada",
  san_diego: "San Diego, California",
  galveston: "Galveston, Texas",
  southampton: "Southampton, England",
  barcelona: "Barcelona, Spain",
  civitavecchia: "Civitavecchia (Rome), Italy",
  san_juan: "San Juan, Puerto Rico",
  rome: "Civitavecchia (Rome), Italy",
  benoa: "Benoa, Bali"
});

const DISNEY_EMBARK_PORT_ALIASES = Object.freeze({
  "port canaveral": "Port Canaveral (Orlando), Florida",
  "fort lauderdale": "Fort Lauderdale (Port Everglades), Florida",
  "san diego": "San Diego, California",
  "port everglades": "Fort Lauderdale (Port Everglades), Florida",
  southampton: "Southampton, England"
});

const DISNEY_CITY_FILTER_EMBARK = Object.freeze({
  PCV: "Port Canaveral (Orlando), Florida",
  FLL: "Fort Lauderdale (Port Everglades), Florida",
  SIN: "Singapore",
  VAN: "Vancouver, Canada",
  SAN: "San Diego, California",
  GAL: "Galveston, Texas",
  SOU: "Southampton, England",
  BCN: "Barcelona, Spain",
  CVV: "Civitavecchia (Rome), Italy",
  SJU: "San Juan, Puerto Rico"
});

function normalisePortLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function titleHasExplicitTwoEndpoints(productName) {
  const text = String(productName || "");
  return /\bCruise from\s+.+\s+(?:ending in|to)\s+/i.test(text);
}

function parseDisneyProductTitleEndpoints(productName) {
  const text = String(productName || "").trim();
  if (!text) return null;

  const fromTo = text.match(/\bCruise from\s+(.+?)\s+to\s+(.+?)(?:\s+with\b.*)?$/i);
  if (fromTo) {
    return {
      embark: fromTo[1].trim(),
      arrival: fromTo[2].trim(),
      method: "product_name_cruise_from_to_pattern",
      tier: ENDPOINT_TIER.PRODUCT_TITLE,
      evidence: productName
    };
  }

  const endingIn = text.match(/\bCruise from\s+(.+?)\s+ending in\s+(.+?)(?:\s+with\b.*)?$/i);
  if (endingIn) {
    return {
      embark: endingIn[1].trim(),
      arrival: endingIn[2].trim(),
      method: "product_name_cruise_from_ending_in_pattern",
      tier: ENDPOINT_TIER.PRODUCT_TITLE,
      evidence: productName
    };
  }

  const themed = text.match(/\bCruise from\s+(.+?)(?:\s+with\b.*)?$/i);
  if (themed) {
    return {
      embark: themed[1].trim(),
      arrival: null,
      method: "product_name_cruise_from_pattern",
      tier: ENDPOINT_TIER.PRODUCT_TITLE,
      evidence: productName
    };
  }

  const simple = text.match(/^\d+-Night(?:\s+Cruise)?\s+from\s+(.+)$/i);
  if (simple) {
    return {
      embark: simple[1].trim(),
      arrival: null,
      method: "product_name_simple_from",
      tier: ENDPOINT_TIER.PRODUCT_TITLE,
      evidence: productName
    };
  }
  return null;
}

function fragmentToEmbarkCandidate(fragment, parsed) {
  const aliasKey = String(fragment || "").trim().toLowerCase();
  if (DISNEY_EMBARK_PORT_ALIASES[aliasKey]) {
    return {
      port: DISNEY_EMBARK_PORT_ALIASES[aliasKey],
      method: parsed.method,
      tier: parsed.tier,
      evidence: parsed.evidence,
      source: "product_title"
    };
  }
  const resolved = resolveRawPortText(fragment, { sourceField: "disney_product_name" });
  if (resolved.status === "resolved") {
    return {
      port: resolved.canonicalPortName,
      method: "product_name_port_catalogue",
      tier: parsed.tier,
      evidence: parsed.evidence,
      source: "product_title"
    };
  }
  if (/,/.test(fragment)) {
    return {
      port: fragment,
      method: parsed.method,
      tier: parsed.tier,
      evidence: parsed.evidence,
      source: "product_title",
      ambiguous: true
    };
  }
  return null;
}

function extractEmbarkFromProductId(productId) {
  const slug = String(productId || "").toLowerCase();
  for (const [key, port] of Object.entries(DISNEY_EMBARK_PRODUCT_ID_MAP)) {
    if (slug.includes(key)) {
      return {
        port,
        method: "product_id_slug",
        tier: ENDPOINT_TIER.PRODUCT_ID_SLUG,
        evidence: productId,
        source: "product_id"
      };
    }
  }
  return null;
}

function extractEmbarkCandidatesFromCityFilters(filters = []) {
  const candidates = [];
  const seenCodes = new Set();
  for (const f of filters || []) {
    const code = String(f).split(";")[0].trim().toUpperCase();
    if (!code || seenCodes.has(code)) continue;
    seenCodes.add(code);
    if (DISNEY_CITY_FILTER_EMBARK[code]) {
      candidates.push({
        port: DISNEY_CITY_FILTER_EMBARK[code],
        method: `city_filter_${code}`,
        tier: ENDPOINT_TIER.CITY_FILTER_PROVENANCE,
        evidence: f,
        source: "city_filter_provenance"
      });
    }
  }
  return candidates;
}

function classifyEmbarkConflicts(titleCandidate, productIdCandidate, filterCandidates = []) {
  const conflicts = [];
  if (!titleCandidate || titleCandidate.ambiguous) return { conflicts, unresolved: [] };

  const titlePort = normalisePortLabel(titleCandidate.port);
  if (productIdCandidate && normalisePortLabel(productIdCandidate.port) !== titlePort) {
    conflicts.push({
      type: "title_vs_product_id",
      chosen: titleCandidate.port,
      rejected: productIdCandidate.port,
      rejected_method: productIdCandidate.method
    });
  }
  for (const fc of filterCandidates) {
    if (normalisePortLabel(fc.port) !== titlePort) {
      conflicts.push({
        type: "title_vs_city_filter",
        chosen: titleCandidate.port,
        rejected: fc.port,
        rejected_method: fc.method
      });
    }
  }
  return { conflicts, unresolved: [] };
}

function resolveEmbarkCandidate(candidate) {
  if (!candidate || candidate.ambiguous) {
    return {
      status: candidate?.ambiguous ? "ambiguous" : "unresolved",
      canonicalPortName: null,
      reason: candidate?.ambiguous ? "ambiguous_product_title" : "no_candidate"
    };
  }
  const resolved = resolveRawPortText(candidate.port, { sourceField: "disney_embark" });
  if (resolved.status === "resolved") {
    return {
      ...resolved,
      evidence_method: candidate.method,
      evidence_tier: candidate.tier,
      evidence: candidate.evidence
    };
  }
  return {
    status: "unresolved",
    canonicalPortName: null,
    reason: resolved.reason || "embark_not_in_catalogue",
    proposed_port: candidate.port
  };
}

function resolveDisneyEmbarkation(raw = {}) {
  const attempts = [];
  const titleParsed = parseDisneyProductTitleEndpoints(raw.product_name);
  const titleCandidate = titleParsed ? fragmentToEmbarkCandidate(titleParsed.embark, titleParsed) : null;
  const productIdCandidate = extractEmbarkFromProductId(raw.product_id);
  const filterCandidates = extractEmbarkCandidatesFromCityFilters(raw.discovered_via_filters || []);

  if (titleCandidate) attempts.push(titleCandidate);
  if (productIdCandidate) attempts.push(productIdCandidate);
  attempts.push(...filterCandidates);

  if (titleCandidate && !titleCandidate.ambiguous) {
    const { conflicts } = classifyEmbarkConflicts(titleCandidate, productIdCandidate, filterCandidates);
    const resolved = resolveEmbarkCandidate(titleCandidate);
    if (resolved.status === "resolved") {
      return {
        ...resolved,
        embark_method: resolved.evidence_method,
        embark_evidence: resolved.evidence,
        alternatives: attempts.filter((a) => a !== titleCandidate),
        conflicts,
        unresolved_conflicts: []
      };
    }
    if (titleCandidate.ambiguous) {
      return {
        status: "ambiguous",
        canonicalPortName: null,
        confidence: "low",
        reason: "ambiguous_product_title",
        evidence_tier: ENDPOINT_TIER.PRODUCT_TITLE,
        attempts,
        alternatives: attempts,
        conflicts: [],
        unresolved_conflicts: []
      };
    }
  }

  if (productIdCandidate) {
    const uniqueFilterPorts = [...new Set(filterCandidates.map((c) => normalisePortLabel(c.port)))];
    const filterConflicts = filterCandidates.filter(
      (fc) => normalisePortLabel(fc.port) !== normalisePortLabel(productIdCandidate.port)
    );
    if (filterConflicts.length > 0 && uniqueFilterPorts.length > 1) {
      return {
        status: "conflict",
        canonicalPortName: null,
        confidence: "low",
        reason: "product_id_vs_city_filter",
        evidence_tier: ENDPOINT_TIER.PRODUCT_ID_SLUG,
        attempts,
        alternatives: attempts,
        conflicts: filterConflicts.map((fc) => ({
          type: "product_id_vs_city_filter",
          chosen: productIdCandidate.port,
          rejected: fc.port,
          rejected_method: fc.method
        })),
        unresolved_conflicts: [
          {
            type: "product_id_vs_city_filter",
            product_id_port: productIdCandidate.port,
            filter_ports: filterCandidates.map((c) => c.port)
          }
        ]
      };
    }
    const resolved = resolveEmbarkCandidate(productIdCandidate);
    if (resolved.status === "resolved") {
      return {
        ...resolved,
        embark_method: resolved.evidence_method,
        embark_evidence: resolved.evidence,
        alternatives: filterCandidates,
        conflicts: filterConflicts.map((fc) => ({
          type: "product_id_vs_city_filter",
          chosen: productIdCandidate.port,
          rejected: fc.port,
          rejected_method: fc.method
        })),
        unresolved_conflicts: []
      };
    }
  }

  const uniqueFilterPorts = [...new Set(filterCandidates.map((c) => normalisePortLabel(c.port)))];
  if (uniqueFilterPorts.length === 1 && filterCandidates.length >= 1) {
    const resolved = resolveEmbarkCandidate(filterCandidates[0]);
    if (resolved.status === "resolved") {
      return {
        ...resolved,
        embark_method: resolved.evidence_method,
        embark_evidence: resolved.evidence,
        alternatives: filterCandidates.slice(1),
        conflicts: [],
        unresolved_conflicts: []
      };
    }
  }

  if (uniqueFilterPorts.length > 1) {
    return {
      status: "conflict",
      canonicalPortName: null,
      confidence: "low",
      reason: "multiple_city_filter_candidates",
      evidence_tier: ENDPOINT_TIER.CITY_FILTER_PROVENANCE,
      attempts,
      alternatives: filterCandidates,
      conflicts: [{ type: "multiple_city_filter_candidates", filter_ports: filterCandidates.map((c) => c.port) }],
      unresolved_conflicts: [
        { type: "multiple_city_filter_candidates", filter_ports: filterCandidates.map((c) => c.port) }
      ]
    };
  }

  return {
    status: "unresolved",
    canonicalPortName: null,
    confidence: "low",
    reason: "no_embarkation_evidence",
    evidence_tier: 6,
    attempts,
    alternatives: [],
    conflicts: [],
    unresolved_conflicts: []
  };
}

function extractArrivalFromProductName(productName) {
  const parsed = parseDisneyProductTitleEndpoints(productName);
  if (!parsed?.arrival) return null;
  return {
    port: parsed.arrival,
    method: parsed.method || "product_name_ending_in",
    tier: ENDPOINT_TIER.PRODUCT_TITLE,
    evidence: parsed.evidence,
    source: "product_title"
  };
}

function isNativeTitleEndpointMethod(method) {
  return (
    typeof method === "string" &&
    (method.startsWith("product_name_cruise_from") || method === "product_name_ending_in")
  );
}

function resolveDisneyArrivalPort(raw = {}, embarkPortMeta = {}, classifyItineraryPort, resolveItineraryPortText) {
  const titleCandidate = extractArrivalFromProductName(raw.product_name);
  const attempts = [];

  if (titleCandidate) {
    attempts.push(titleCandidate);
    const resolved = resolveRawPortText(titleCandidate.port, { sourceField: "disney_arrival_title" });
    if (resolved.status === "resolved") {
      const conflicts = [];
      if (raw.one_way_itinerary === true) {
        const ports = raw.ports_of_call_ordered || [];
        const lastPhysical = [...ports].reverse().find((p) => {
          const kind = classifyItineraryPort(p).kind;
          return kind === "physical_port" || kind === "private_island_physical_port";
        });
        if (lastPhysical) {
          const lastResolved = resolveItineraryPortText(lastPhysical);
          if (
            lastResolved.status === "resolved" &&
            normalisePortLabel(lastResolved.canonicalPortName) !== normalisePortLabel(resolved.canonicalPortName)
          ) {
            conflicts.push({
              type: "title_arrival_vs_itinerary_last_port",
              chosen: resolved.canonicalPortName,
              rejected: lastResolved.canonicalPortName
            });
          }
        }
      }
      return {
        ...resolved,
        round_trip: false,
        method: titleCandidate.method,
        evidence_tier: titleCandidate.tier,
        arrival_evidence: titleCandidate.evidence,
        alternatives: attempts.slice(1),
        conflicts,
        unresolved_conflicts: []
      };
    }
  }

  if (raw.one_way_itinerary === true) {
    const ports = raw.ports_of_call_ordered || [];
    const lastPhysical = [...ports].reverse().find((p) => {
      const kind = classifyItineraryPort(p).kind;
      return kind === "physical_port" || kind === "private_island_physical_port";
    });
    if (lastPhysical) {
      const resolved = resolveItineraryPortText(lastPhysical);
      if (resolved.status === "resolved") {
        return {
          ...resolved,
          round_trip: false,
          method: "itinerary_last_physical",
          evidence_tier: ENDPOINT_TIER.ITINERARY_INFERENCE,
          unresolved_conflicts: titleCandidate ? [{ type: "oneway_endpoint_conflict", reason: "title_arrival_unresolved" }] : []
        };
      }
    }
    return {
      status: "unresolved",
      round_trip: false,
      unresolved_conflicts: titleCandidate ? [{ type: "oneway_endpoint_conflict" }] : []
    };
  }

  if (raw.one_way_itinerary === false && embarkPortMeta.status === "resolved") {
    return {
      status: "resolved",
      canonicalPortName: embarkPortMeta.canonicalPortName,
      round_trip: true,
      method: "round_trip_embark_equals_disembark",
      evidence_tier: ENDPOINT_TIER.PRODUCT_TITLE,
      unresolved_conflicts: []
    };
  }

  return { status: "unknown", round_trip: null, unresolved_conflicts: [] };
}

function collectEndpointEvidence(raw = {}, embarkMeta = {}, arrivalMeta = {}) {
  const titleParsed = parseDisneyProductTitleEndpoints(raw.product_name);
  const productIdCandidate = extractEmbarkFromProductId(raw.product_id);
  const filterCandidates = extractEmbarkCandidatesFromCityFilters(raw.discovered_via_filters || []);

  return {
    official_product_key: raw.official_product_key,
    product_name: raw.product_name,
    product_id: raw.product_id,
    one_way_itinerary: raw.one_way_itinerary,
    discovered_via_filters: raw.discovered_via_filters || [],
    ports_of_call_ordered: raw.ports_of_call_ordered || [],
    title_embark: titleParsed?.embark || null,
    title_arrival: titleParsed?.arrival || null,
    product_id_embark: productIdCandidate?.port || null,
    city_filter_embarks: filterCandidates.map((c) => ({ port: c.port, method: c.method })),
    chosen_departure: embarkMeta.canonicalPortName || null,
    chosen_arrival: arrivalMeta.canonicalPortName || null,
    embark_method: embarkMeta.embark_method || embarkMeta.evidence_method || null,
    arrival_method: arrivalMeta.method || null,
    embark_conflicts: embarkMeta.conflicts || [],
    arrival_conflicts: arrivalMeta.conflicts || [],
    embark_unresolved_conflicts: embarkMeta.unresolved_conflicts || [],
    arrival_unresolved_conflicts: arrivalMeta.unresolved_conflicts || []
  };
}

function classifyEndpointConflictRecord(record) {
  const classes = [];
  for (const c of record.embark_conflicts || []) {
    if (c.type) classes.push(c.type);
  }
  for (const c of record.arrival_conflicts || []) {
    if (c.type) classes.push(c.type);
  }
  if ((record.embark_unresolved_conflicts || []).length) {
    for (const u of record.embark_unresolved_conflicts) classes.push(u.type || "other");
  }
  if ((record.arrival_unresolved_conflicts || []).length) {
    for (const u of record.arrival_unresolved_conflicts) classes.push(u.type || "other");
  }
  return [...new Set(classes)];
}

function auditEndpointEvidence(normalised = []) {
  const records = normalised.map((row) =>
    collectEndpointEvidence(row.raw || {}, row.candidate?.departure_port_meta || {}, row.candidate?.arrival_port_meta || {})
  );

  const conflictsByType = {};
  const conflictingIdentities = [];
  let explicitTitleEmbark = 0;
  let explicitTitleArrival = 0;
  let productIdEvidence = 0;
  let cityFilterEvidence = 0;
  let unresolvedConflicts = 0;

  for (const record of records) {
    if (record.title_embark) explicitTitleEmbark += 1;
    if (record.title_arrival) explicitTitleArrival += 1;
    if (record.product_id_embark) productIdEvidence += 1;
    if (record.city_filter_embarks.length) cityFilterEvidence += 1;

    const classes = classifyEndpointConflictRecord(record);
    const hasUnresolved =
      (record.embark_unresolved_conflicts || []).length > 0 || (record.arrival_unresolved_conflicts || []).length > 0;
    if (hasUnresolved) {
      unresolvedConflicts += 1;
      conflictingIdentities.push(record.official_product_key);
    } else if (classes.length > 0) {
      conflictingIdentities.push(record.official_product_key);
    }
    for (const cls of classes) {
      conflictsByType[cls] = (conflictsByType[cls] || 0) + 1;
    }
  }

  const oneWayRows = normalised.filter((r) => r.raw?.one_way_itinerary === true);
  const roundTripRows = normalised.filter((r) => r.raw?.one_way_itinerary === false);

  return {
    total_sailings: normalised.length,
    explicit_title_embark_count: explicitTitleEmbark,
    explicit_title_arrival_count: explicitTitleArrival,
    product_id_evidence_count: productIdEvidence,
    city_filter_evidence_count: cityFilterEvidence,
    any_conflict_count: conflictingIdentities.length,
    conflicts_by_type: conflictsByType,
    unresolved_conflicts: unresolvedConflicts,
    conflicting_identities: [...new Set(conflictingIdentities)],
    one_way_total: oneWayRows.length,
    one_way_conflict_total: oneWayRows.filter(
      (r) =>
        (r.candidate?.departure_port_meta?.unresolved_conflicts || []).length ||
        (r.candidate?.arrival_port_meta?.unresolved_conflicts || []).length
    ).length,
    round_trip_conflict_total: roundTripRows.filter((r) => (r.candidate?.departure_port_meta?.conflicts || []).length).length,
    records
  };
}

function auditOneWaySailings(normalised = []) {
  const rows = normalised
    .filter((r) => r.raw?.one_way_itinerary === true)
    .map((row) => {
      const evidence = collectEndpointEvidence(
        row.raw,
        row.candidate?.departure_port_meta || {},
        row.candidate?.arrival_port_meta || {}
      );
      const explicitTwoEndpoint = titleHasExplicitTwoEndpoints(row.raw?.product_name);
      const nativeTitleParse =
        !explicitTwoEndpoint ||
        (evidence.title_embark &&
          evidence.title_arrival &&
          !/\sto\s/i.test(evidence.title_embark) &&
          isNativeTitleEndpointMethod(evidence.embark_method) &&
          isNativeTitleEndpointMethod(evidence.arrival_method));
      const passed =
        row.candidate?.departure_port_meta?.status === "resolved" &&
        row.candidate?.arrival_port_meta?.status === "resolved" &&
        !(row.candidate?.departure_port_meta?.unresolved_conflicts || []).length &&
        !(row.candidate?.arrival_port_meta?.unresolved_conflicts || []).length &&
        nativeTitleParse;
      return {
        official_identity: row.official_sailing_id,
        ship: row.raw?.ship_name,
        title: row.raw?.product_name,
        departure_date: row.raw?.departure_date,
        return_date: row.raw?.return_date,
        nights: row.raw?.nights,
        oneWayItinerary: row.raw?.one_way_itinerary,
        explicit_two_endpoint: explicitTwoEndpoint,
        title_embark: evidence.title_embark,
        title_arrival: evidence.title_arrival,
        product_id_port: evidence.product_id_embark,
        city_filter_ports: evidence.city_filter_embarks,
        itinerary_last_physical_port: [...(row.raw?.ports_of_call_ordered || [])]
          .reverse()
          .find((p) => p) || null,
        final_embark: row.candidate?.departure_port,
        final_arrival: row.candidate?.arrival_port,
        endpoint_method_embark: evidence.embark_method,
        endpoint_method_arrival: evidence.arrival_method,
        native_title_parse: nativeTitleParse,
        conflicts: [...(evidence.embark_conflicts || []), ...(evidence.arrival_conflicts || [])],
        unresolved_conflicts: [
          ...(evidence.embark_unresolved_conflicts || []),
          ...(evidence.arrival_unresolved_conflicts || [])
        ],
        pass: passed
      };
    });

  const explicitRows = rows.filter((r) => r.explicit_two_endpoint);
  return {
    total: rows.length,
    passed: rows.filter((r) => r.pass).length,
    failed: rows.filter((r) => !r.pass).length,
    explicit_two_endpoint_total: explicitRows.length,
    explicit_two_endpoint_native_parse:
      explicitRows.length === 0 || explicitRows.every((r) => r.native_title_parse),
    rows
  };
}

function hashFrozenBatchCandidates(entries = [], adapterVersion = "") {
  const payload = entries
    .map((entry) => ({
      official_sailing_id: entry.official_product_key,
      ship_id: entry.ship_id,
      departure_date: entry.departure_date,
      return_date: entry.return_date,
      nights: entry.nights,
      departure_port: entry.departure_port,
      arrival_port: entry.arrival_port || null,
      destination_id: entry.destination_id,
      identity_key: entry.identity_key,
      external_key: entry.external_key,
      adapter_version: adapterVersion
    }))
    .sort((a, b) => a.official_sailing_id.localeCompare(b.official_sailing_id));
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function buildFrozenControlledBatch(normalised = [], manifest = [], context = {}) {
  const maxSize = context.maxSize || 20;
  const adapterVersion = context.adapterVersion || "";
  const disneyExternalKey = context.disneyExternalKey;
  const cruiseIdentityKeyFn = context.cruiseIdentityKey;
  const cruiseLineId = context.cruiseLineId;

  const eligible = manifest
    .filter((m) => m.action === "insert_active")
    .map((m) => ({ manifest: m, row: normalised.find((r) => r.official_sailing_id === m.official_product_key) }))
    .filter((e) => e.row && e.row.eligibility?.production_eligible)
    .filter((e) => {
      const dep = e.row.candidate?.departure_port_meta;
      const arr = e.row.candidate?.arrival_port_meta;
      return (
        !(dep?.unresolved_conflicts || []).length &&
        !(arr?.unresolved_conflicts || []).length &&
        dep?.status === "resolved" &&
        e.row.ship_resolution?.resolved &&
        e.row.destination_resolution?.status === "resolved" &&
        e.row.duration_validation?.exact_match === true
      );
    });

  const seenShip = new Set();
  const seenPort = new Set();
  const seenDest = new Set();
  const seenNights = new Set();
  const remaining = [...eligible];
  const picked = [];

  function diversityScore(row) {
    let score = 0;
    if (!seenShip.has(row.raw?.ship_name)) score += 4;
    if (!seenPort.has(row.candidate?.departure_port)) score += 4;
    if (!seenDest.has(row.candidate?.destination_key)) score += 2;
    if (!seenNights.has(row.raw?.nights)) score += 1;
    return score;
  }

  while (picked.length < maxSize && remaining.length > 0) {
    remaining.sort((a, b) => diversityScore(b.row) - diversityScore(a.row));
    const entry = remaining.shift();
    const row = entry.row;
    const productKey = row.official_sailing_id;
    const candidate = row.candidate || {};
    const externalKey = disneyExternalKey ? disneyExternalKey(cruiseLineId, productKey) : null;
    const identityKey = cruiseIdentityKeyFn
      ? cruiseIdentityKeyFn({
          cruiseLineId,
          shipId: candidate.ship_id,
          departureDate: candidate.departure_date,
          officialUrl: candidate.official_url,
          nights: candidate.nights,
          returnDate: candidate.return_date,
          officialSailingId: productKey
        })
      : null;

    picked.push({
      official_product_key: productKey,
      sailing_id: row.raw?.sailing_id,
      ship_id: candidate.ship_id,
      ship_name: row.raw?.ship_name,
      departure_date: candidate.departure_date,
      return_date: candidate.return_date,
      nights: candidate.nights,
      departure_port: candidate.departure_port,
      arrival_port: candidate.arrival_port || null,
      destination_id: candidate.destination_id,
      destination_key: candidate.destination_key,
      official_url: candidate.official_url,
      external_key: externalKey,
      identity_key: identityKey,
      adapter_version: adapterVersion,
      endpoint_unresolved_conflicts: 0,
      action: "insert_active"
    });
    seenShip.add(row.raw?.ship_name);
    seenPort.add(candidate.departure_port);
    seenDest.add(candidate.destination_key);
    seenNights.add(row.raw?.nights);
  }

  picked.sort((a, b) => a.official_product_key.localeCompare(b.official_product_key));
  const frozen_candidate_hash = hashFrozenBatchCandidates(picked, adapterVersion);

  return {
    size: picked.length,
    max_size: maxSize,
    strategy: "insert_only",
    strategy_reason:
      "Fresh frozen batch from Phase 3 corrected from-X-to-Y endpoint model. Phase 2D hash invalidated.",
    invalidates_phase2c_batch: true,
    invalidates_phase2d_batch: true,
    phase2d_batch_hash: "29eec188212e19502c910f02987d00b2be8b6478a9d12f9ea237aa347b6a548d",
    phase2c_batch_hash: null,
    action_mix: { insert_active: picked.length, update_exact_legacy_match: 0 },
    frozen_identities: picked.map((p) => p.official_product_key),
    frozen_candidate_hash,
    entries: picked,
    execution_performed: false
  };
}

module.exports = {
  ENDPOINT_TIER,
  DISNEY_EMBARK_PRODUCT_ID_MAP,
  DISNEY_CITY_FILTER_EMBARK,
  titleHasExplicitTwoEndpoints,
  isNativeTitleEndpointMethod,
  parseDisneyProductTitleEndpoints,
  extractEmbarkFromProductId,
  extractEmbarkCandidatesFromCityFilters,
  resolveDisneyEmbarkation,
  extractArrivalFromProductName,
  resolveDisneyArrivalPort,
  collectEndpointEvidence,
  auditEndpointEvidence,
  auditOneWaySailings,
  hashFrozenBatchCandidates,
  buildFrozenControlledBatch
};
