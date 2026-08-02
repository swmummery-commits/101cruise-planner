/**
 * Discovery automation orchestrator — resolves review items and candidates without writes.
 * Used by dry-run simulation and (when deployed) ingestion pipeline.
 */

const { classifyNonSailingSource, guessLooksNonSailing, provesIndividualSailing } = require("./discovery-non-sailing-filter");
const {
  resolveDepartureFromSource,
  resolveRawPortText,
  loadPortsCatalogue
} = require("./discovery-departure-port");
const { validateCruise, extractDepartureDate } = require("./cruise-discovery");
const { evaluateDiscoveryConfidence } = require("./discovery-confidence");
const {
  resolveShipForLine,
  buildAliasProposal,
  AUTO_RESOLVE_MIN_CONFIDENCE
} = require("./discovery-ship-resolver");
const { resolveDestination } = require("./discovery-destination-resolver");

const AUTO_RESOLVER_VERSION = "2026-08-02.auto2";

const ACTION = {
  AUTO_PUBLISH: "auto_publish",
  AUTO_REJECT: "auto_reject",
  AUTO_RESOLVE: "auto_resolve",
  SHIP_MAINTENANCE: "ship_catalogue_maintenance",
  LINE_CONFIG: "cruise_line_configuration",
  CLOSE_OBSOLETE: "close_obsolete",
  HUMAN_REVIEW: "human_review"
};

const SUBTYPE = {
  AUTO_NOW: "A_automatically_resolvable_now",
  AUTO_AFTER_RULE: "B_automatically_resolvable_after_rule",
  CATALOGUE: "C_catalogue_level_problem",
  LINE_CONFIG: "D_cruise_line_configuration",
  GENUINE: "E_genuine_ambiguous_sailing",
  CLOSE: "F_invalid_or_obsolete"
};

function reviewItemToInput(item, context = {}) {
  const payload = item.payload || {};
  const extract = payload.extract || {};
  const line = context.linesById?.[item.cruise_line_id] || {};
  return {
    reviewItemId: item.id,
    itemType: item.item_type,
    cruiseLineId: item.cruise_line_id,
    cruiseLine: line,
    cruiseLineName: line.name || context.lineNameById?.[item.cruise_line_id] || "",
    url: item.source_url || payload.official_url || "",
    title: extract.title || item.title,
    description: extract.description || item.detail,
    payload,
    externalKey: payload.external_key,
    suggestedShip: payload.suggested_ship_id
      ? {
          ship_id: payload.suggested_ship_id,
          ship_name: payload.suggested_ship_name,
          confidence: payload.suggested_confidence
        }
      : null,
    rawShipName: payload.raw_ship_name || payload.diagnostics?.ship_name_guesses?.[0] || null,
    departureDate: payload.diagnostics?.departure_date || null,
    nights: payload.diagnostics?.nights || null,
    destinationId: item.destination_id || payload.diagnostics?.destination_id || null,
    shipId: payload.ship_id || payload.diagnostics?.ship_id || null,
    entityGroupKey: item.entity_group_key || payload.entity_group_key
  };
}

function reextractFields(input, ports) {
  const blob = [input.title, input.description, input.payload?.extract?.description]
    .filter(Boolean)
    .join("\n");
  const departureRetry = resolveDepartureFromSource({
    title: input.title,
    description: input.description,
    excerpt: input.payload?.extract?.description,
    shipNames: input.payload?.diagnostics?.ship_name_guesses,
    shipName: input.rawShipName,
    destinationName: input.destinationName
  });
  let departure_date = input.departureDate;
  let departure_date_method = departure_date ? "existing" : null;
  if (!departure_date && departureRetry.status === "resolved" && departureRetry.departureDate) {
    departure_date = departureRetry.departureDate;
    departure_date_method = departureRetry.method || "reextract";
  }
  if (!departure_date) {
    const iso = extractDepartureDate(blob);
    if (iso) {
      departure_date = iso;
      departure_date_method = "title_date_pattern";
    }
  }

  let departure_port = null;
  let departure_port_meta = null;
  let departure_port_method = null;
  if (departureRetry.status === "resolved" && departureRetry.canonicalPortName) {
    const portResolved = resolveRawPortText(departureRetry.canonicalPortName, ports);
    if (portResolved.status === "resolved") {
      departure_port = portResolved.canonicalPortName;
      departure_port_meta = portResolved;
      departure_port_method = departureRetry.method || "reextract";
    }
  } else {
    const portFromSource = resolveDepartureFromSource({
      title: input.title,
      description: blob,
      shipName: input.rawShipName
    });
    if (portFromSource.status === "resolved" && portFromSource.canonicalPortName) {
      const portResolved = resolveRawPortText(portFromSource.canonicalPortName, ports);
      if (portResolved.status === "resolved") {
        departure_port = portResolved.canonicalPortName;
        departure_port_meta = portResolved;
        departure_port_method = portFromSource.method || "reextract";
      }
    }
  }

  return { departure_date, departure_date_method, departure_port, departure_port_meta, departure_port_method };
}

/**
 * Simulate automation for one review queue item. No writes.
 */
function simulateReviewItemAutomation(item, context = {}) {
  const input = reviewItemToInput(item, context);
  const ports = context.ports || loadPortsCatalogue();
  const ships = context.ships || [];
  const aliases = (context.aliases || []).filter((a) => a.cruise_line_id === input.cruiseLineId);
  const destinations = context.destinations || [];
  const cruise = input.externalKey ? context.cruisesByKey?.[input.externalKey] : null;

  const result = {
    review_item_id: item.id,
    discovered_cruise_id: cruise?.id || item.cruise_id || null,
    cruise_line: input.cruiseLineName,
    item_type: item.item_type,
    source_url: input.url,
    source_title: input.title,
    extracted_ship_text: input.rawShipName,
    canonical_ship_candidates: [],
    departure_date: input.departureDate,
    departure_port: cruise?.departure_port || null,
    itinerary_evidence: input.payload?.extract?.description?.slice(0, 200) || null,
    current_problem: item.detail || item.item_type,
    proposed_action: null,
    proposed_status: null,
    subtype: null,
    confidence: null,
    automation_confidence: null,
    reasons: [],
    alias_proposal: null,
    ship_maintenance: null,
    line_config_warning: null,
    human_review_necessary: null,
    resolver_version: AUTO_RESOLVER_VERSION
  };

  const nonSailing = classifyNonSailingSource({
    url: input.url,
    title: input.title,
    description: input.description,
    ship_name_guesses: input.payload?.diagnostics?.ship_name_guesses,
    ship_id: input.shipId
  });

  if (nonSailing.rejected) {
    result.subtype = SUBTYPE.CLOSE;
    result.proposed_action = ACTION.AUTO_REJECT;
    result.proposed_status = "ignored";
    result.confidence = "high";
    result.reasons = [nonSailing.reason];
    result.human_review_necessary = false;
    return result;
  }

  if (item.item_type === "missing_url") {
    result.subtype = SUBTYPE.LINE_CONFIG;
    result.proposed_action = ACTION.LINE_CONFIG;
    result.proposed_status = "configuration_warning";
    result.line_config_warning = {
      cruise_line_id: input.cruiseLineId,
      field: "website_url_or_cruise_search_url",
      dedupe_key: `line_config|${input.cruiseLineId}|missing_url`
    };
    result.human_review_necessary = false;
    result.reasons = ["cruise_line_missing_official_search_url"];
    return result;
  }

  if (item.item_type === "missing_ship_url") {
    const shipId = item.payload?.ship_id;
    const ship = ships.find((s) => s.id === shipId);
    result.subtype = SUBTYPE.CATALOGUE;
    result.proposed_action = ACTION.SHIP_MAINTENANCE;
    result.proposed_status = "ship_catalogue_maintenance";
    result.ship_maintenance = {
      ship_id: shipId,
      ship_name: ship?.name || item.title?.replace(/^Confirm official ship URL for /, ""),
      suggested_official_ship_url: item.payload?.suggested_official_ship_url || input.url,
      dedupe_key: `missing_ship_url|${input.cruiseLineId}|ship:${shipId}`,
      block_sailing: false
    };
    result.human_review_necessary = false;
    result.reasons = ["missing_official_ship_url_is_catalogue_not_sailing_decision"];
    return result;
  }

  const reextract = reextractFields(input, ports);
  if (reextract.departure_date) {
    result.departure_date = reextract.departure_date;
    result.departure_port = reextract.departure_port;
  }

  const shipResolution = resolveShipForLine({
    rawShipName:
      input.rawShipName && !guessLooksNonSailing(input.rawShipName) && input.rawShipName.length < 50
        ? input.rawShipName
        : null,
    cruiseLineId: input.cruiseLineId,
    cruiseLineName: input.cruiseLineName,
    ships,
    aliases,
    extract: {
      ...input.payload?.extract,
      title: input.title,
      description: input.description || input.payload?.extract?.description
    },
    suggestedMatch: input.suggestedShip
      ? {
          ship_id: input.suggestedShip.ship_id,
          confidence: input.suggestedShip.confidence,
          normalised_raw: input.rawShipName
        }
      : null
  });

  if (shipResolution.resolved) {
    result.canonical_ship_candidates = [shipResolution.ship.name];
    result.extracted_ship_text = input.rawShipName || shipResolution.raw;
  } else if (shipResolution.candidates) {
    result.canonical_ship_candidates = shipResolution.candidates;
  }

  const destResolution = resolveDestination({
    title: input.title,
    description: input.description,
    itinerary: cruise?.itinerary,
    destinations,
    destinationAliases: context.destinationAliases || [],
    preferredDestination: input.destinationId
      ? destinations.find((d) => d.id === input.destinationId)
      : null
  });

  const aliasProposal = shipResolution.resolved ? buildAliasProposal(shipResolution, { sourceUrl: input.url }) : null;
  if (aliasProposal) result.alias_proposal = aliasProposal;

  const candidate = {
    cruise_line_id: input.cruiseLineId,
    ship_id: shipResolution.resolved ? shipResolution.ship.id : input.shipId,
    destination_id: destResolution.resolved ? destResolution.destination_id : input.destinationId,
    departure_date: reextract.departure_date || input.departureDate,
    departure_port: reextract.departure_port,
    departure_port_meta: reextract.departure_port_meta,
    official_url: input.url,
    itinerary: cruise?.itinerary || input.title
  };

  const validationReasons = validateCruise(candidate);
  const confidenceEval = evaluateDiscoveryConfidence({
    ...candidate,
    cruiseLine: input.cruiseLine,
    cruise_line_name: input.cruiseLineName,
    title: input.title,
    description: input.description,
    payload: input.payload,
    ships: ships.filter((s) => s.cruise_line_id === input.cruiseLineId),
    shipResolution: shipResolution.resolved
      ? { ship: shipResolution.ship, method: shipResolution.method, confidence: shipResolution.confidence }
      : null,
    destinationResolution: destResolution,
    departure_date_method: reextract.departure_date_method,
    departure_port_method: reextract.departure_port_method,
    nights: input.nights,
    ship_name: shipResolution.ship?.name
  });

  result.automation_confidence = confidenceEval;
  result.confidence = confidenceEval.confidence;

  if (confidenceEval.outcome === "auto_publish" && validationReasons.length === 0) {
    result.subtype = SUBTYPE.AUTO_NOW;
    result.proposed_action = ACTION.AUTO_PUBLISH;
    result.proposed_status = "active";
    result.human_review_necessary = false;
    result.reasons = ["high_confidence_complete_sailing"];
    return result;
  }

  if (
    shipResolution.resolved &&
    shipResolution.confidence >= AUTO_RESOLVE_MIN_CONFIDENCE &&
    validationReasons.length <= 2 &&
    validationReasons.every((r) => /Destination not matched|Departure date missing/i.test(r))
  ) {
    const afterShip = validationReasons.filter((r) => !/Ship not matched/i.test(r));
    if (destResolution.resolved && reextract.departure_date) {
      result.subtype = SUBTYPE.AUTO_NOW;
      result.proposed_action = ACTION.AUTO_RESOLVE;
      result.proposed_status = "active";
      result.human_review_necessary = false;
      result.reasons = ["ship_and_fields_resolved_by_automation"];
      return result;
    }
    if (shipResolution.resolved && afterShip.length <= 1) {
      result.subtype = SUBTYPE.AUTO_AFTER_RULE;
      result.proposed_action = ACTION.AUTO_RESOLVE;
      result.proposed_status = "match_required";
      result.human_review_necessary = false;
      result.reasons = ["ship_resolved_pending_date_or_destination"];
      return result;
    }
  }

  if (shipResolution.resolved && shipResolution.confidence >= AUTO_RESOLVE_MIN_CONFIDENCE && item.item_type === "unknown_ship") {
    result.subtype = SUBTYPE.AUTO_NOW;
    result.proposed_action = ACTION.AUTO_RESOLVE;
    result.proposed_status = "match_required";
    result.human_review_necessary = false;
    result.reasons = [`ship_resolved_via_${shipResolution.method}`];
    return result;
  }

  if (item.item_type === "validation_failure" && reextract.departure_date && reextract.departure_port) {
    result.subtype = SUBTYPE.AUTO_NOW;
    result.proposed_action = ACTION.AUTO_RESOLVE;
    result.proposed_status = "validation_failed";
    result.human_review_necessary = false;
    result.reasons = ["date_and_port_reextracted"];
    return result;
  }

  if (item.item_type === "unknown_destination" && destResolution.resolved) {
    result.subtype = SUBTYPE.AUTO_NOW;
    result.proposed_action = ACTION.AUTO_RESOLVE;
    result.proposed_status = "match_required";
    result.human_review_necessary = false;
    result.reasons = [`destination_resolved_via_${destResolution.method}`];
    return result;
  }

  const individualGate = provesIndividualSailing({
    ship_id: candidate.ship_id,
    departure_date: candidate.departure_date,
    departure_port: candidate.departure_port,
    departure_port_meta: candidate.departure_port_meta,
    shipResolution,
    ships: ships.filter((s) => s.cruise_line_id === input.cruiseLineId),
    ship_name_guess: input.rawShipName
  });

  if (!individualGate.proven) {
    result.subtype = SUBTYPE.CLOSE;
    result.proposed_action = ACTION.AUTO_REJECT;
    result.proposed_status = "ignored";
    result.confidence = "high";
    result.human_review_necessary = false;
    result.reasons = [
      individualGate.reason || "non_sailing_marketing_page",
      ...individualGate.missing.map((m) => `missing_${m}`)
    ];
    return result;
  }

  if (cruise?.status === "expired") {
    result.subtype = SUBTYPE.CLOSE;
    result.proposed_action = ACTION.CLOSE_OBSOLETE;
    result.proposed_status = "ignored";
    result.human_review_necessary = false;
    result.reasons = ["linked_cruise_expired"];
    return result;
  }

  result.subtype = SUBTYPE.GENUINE;
  result.proposed_action = ACTION.HUMAN_REVIEW;
  result.proposed_status = "pending";
  result.human_review_necessary = true;
  result.reasons = [
    ...validationReasons,
    ...(shipResolution.resolved ? [] : [shipResolution.reason || "ship_unresolved"]),
    ...(destResolution.resolved ? [] : [destResolution.reason || "destination_unresolved"])
  ];
  result.human_review_necessary_reason = explainHumanReview(result, shipResolution, destResolution, validationReasons);
  return result;
}

function explainHumanReview(result, shipResolution, destResolution, validationReasons) {
  const parts = [];
  if (!shipResolution.resolved) {
    parts.push(
      `Ship "${result.extracted_ship_text || "unknown"}" has no unique line-scoped match (candidates: ${(result.canonical_ship_candidates || []).join(", ") || "none"}).`
    );
  }
  if (validationReasons.some((r) => /Departure date/i.test(r)) && !result.departure_date) {
    parts.push("No credible future departure date could be re-extracted from structured or labelled source text.");
  }
  if (validationReasons.some((r) => /departure port/i.test(r))) {
    parts.push("Embarkation port evidence is missing or ambiguous against the canonical port catalogue.");
  }
  if (!destResolution.resolved && result.item_type === "unknown_destination") {
    parts.push("Itinerary ports do not map dominantly to one published destination.");
  }
  return parts.join(" ") || "One or more required fields remain ambiguous after automation.";
}

function simulateQueueAutomation(items, context = {}) {
  const results = (items || []).map((item) => simulateReviewItemAutomation(item, context));
  const summary = {
    total: results.length,
    auto_publish: results.filter((r) => r.proposed_action === ACTION.AUTO_PUBLISH).length,
    auto_resolve: results.filter((r) => r.proposed_action === ACTION.AUTO_RESOLVE).length,
    auto_reject: results.filter((r) => r.proposed_action === ACTION.AUTO_REJECT).length,
    ship_maintenance: results.filter((r) => r.proposed_action === ACTION.SHIP_MAINTENANCE).length,
    line_config: results.filter((r) => r.proposed_action === ACTION.LINE_CONFIG).length,
    close_obsolete: results.filter((r) => r.proposed_action === ACTION.CLOSE_OBSOLETE).length,
    human_review: results.filter((r) => r.proposed_action === ACTION.HUMAN_REVIEW).length,
    alias_proposals: results.filter((r) => r.alias_proposal).length,
    by_subtype: {}
  };
  for (const r of results) {
    summary.by_subtype[r.subtype] = (summary.by_subtype[r.subtype] || 0) + 1;
  }
  const shipMaintKeys = new Set(
    results.filter((r) => r.ship_maintenance?.dedupe_key).map((r) => r.ship_maintenance.dedupe_key)
  );
  summary.unique_ship_maintenance = shipMaintKeys.size;
  return { results, summary, resolverVersion: AUTO_RESOLVER_VERSION };
}

function automationReviewReason(action, reasons) {
  const primary = (reasons || [])[0] || action;
  return `automation:${primary}:${AUTO_RESOLVER_VERSION}`;
}

/**
 * Gate review enqueue during ingestion. Never writes aliases.
 */
function evaluateIngestionAutomation({
  built,
  extracted,
  cruiseLine,
  ships,
  destinations,
  destinationAliases,
  aliases
}) {
  if (!built || built.skip) return { action: ACTION.AUTO_REJECT, reasons: ["skipped_non_cruise"] };
  if (built.status === "active") {
    return { action: ACTION.AUTO_PUBLISH, reasons: ["validated_active"] };
  }

  const fakeItem = {
    id: null,
    item_type: built.reasons?.some((r) => /Ship not matched/i.test(r))
      ? "unknown_ship"
      : built.reasons?.some((r) => /Destination not matched/i.test(r))
        ? "unknown_destination"
        : "validation_failure",
    cruise_line_id: cruiseLine.id,
    destination_id: extracted.destination_id,
    source_url: extracted.official_url,
    detail: built.reasons?.join("; "),
    payload: {
      extract: {
        title: extracted.raw_extract?.title,
        description: extracted.raw_extract?.description
      },
      external_key: extracted.external_key,
      raw_ship_name: extracted.ship_name_guess,
      diagnostics: {
        ship_name_guesses: extracted.raw_extract?.ship_name_guesses,
        departure_date: extracted.departure_date,
        nights: extracted.nights,
        destination_id: extracted.destination_id,
        ship_id: extracted.ship_id
      },
      suggested_ship_id: null
    }
  };

  const result = simulateReviewItemAutomation(fakeItem, {
    linesById: { [cruiseLine.id]: cruiseLine },
    lineNameById: { [cruiseLine.id]: cruiseLine.name },
    ships: ships || [],
    aliases: aliases || [],
    destinations: destinations || [],
    destinationAliases: destinationAliases || [],
    cruisesByKey: extracted.external_key ? { [extracted.external_key]: extracted } : {}
  });

  return {
    action: result.proposed_action,
    reasons: result.reasons,
    alias_proposal: result.alias_proposal,
    ship_maintenance: result.ship_maintenance,
    line_config_warning: result.line_config_warning,
    review_reason: automationReviewReason(result.proposed_action, result.reasons)
  };
}

function buildReconciliationManifestEntry(item, result, cruise) {
  return {
    review_item_id: item.id,
    discovered_cruise_id: result.discovered_cruise_id || cruise?.id || item.cruise_id || null,
    cruise_line: result.cruise_line,
    source_url: result.source_url,
    source_title: result.source_title,
    current_review_type: result.item_type,
    proposed_outcome: result.proposed_action,
    classification: result.automation_confidence?.classification || null,
    confidence: result.confidence,
    evidence_summary: result.automation_confidence?.evidence || null,
    rejection_or_routing_reason: (result.reasons || []).join("; "),
    current_candidate_status: cruise?.status || null,
    proposed_candidate_status:
      result.proposed_action === ACTION.AUTO_REJECT
        ? "hidden"
        : result.proposed_action === ACTION.AUTO_PUBLISH
          ? "active"
          : cruise?.status || null,
    current_review_status: "pending",
    proposed_review_status:
      result.proposed_action === ACTION.SHIP_MAINTENANCE || result.proposed_action === ACTION.LINE_CONFIG
        ? "ignored"
        : result.proposed_status,
    alias_proposal: result.alias_proposal || null,
    ship_maintenance: result.ship_maintenance || null,
    line_config_warning: result.line_config_warning || null,
    rollback: {
      review_status: "pending",
      candidate_status: cruise?.status || null,
      review_reason: cruise?.review_reason || null
    }
  };
}

module.exports = {
  AUTO_RESOLVER_VERSION,
  ACTION,
  SUBTYPE,
  simulateReviewItemAutomation,
  simulateQueueAutomation,
  evaluateIngestionAutomation,
  buildReconciliationManifestEntry,
  automationReviewReason,
  reviewItemToInput,
  reextractFields
};
