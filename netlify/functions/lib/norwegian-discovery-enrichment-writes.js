/**
 * Norwegian Cruise Line Phase 5B — controlled itinerary enrichment writes.
 * Enriches existing genuine voyage rows only; never inserts voyages or changes core identity.
 */

const source = require("./norwegian-discovery-source");
const {
  extractCompleteItineraryFromHtml,
  parseEnrichedItinerary,
  classifyPortResolution,
  resolveNorwegianDeparturePort,
  isGenuineInventoryRow,
  isLegacyGenericDiscoveryRow
} = require("./norwegian-discovery-adapter");
const { resolveRawPortText } = require("./discovery-departure-port");
const poc = require("./norwegian-port-of-call-mappings");
const { resolveNorwegianDestinationAssignment } = require("./norwegian-destination-mapping");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");

const NCL_LINE_ID = "c5f5361f-ebe5-4ff4-babe-7eb07f609bae";
const NCL_LINE_SLUG = "norwegian-cruise-line";
const CONTROLLED_ENRICHMENT_LOCK_KEY = `${NCL_LINE_SLUG}:controlled_enrichment`;
const FETCH_DELAY_MS = 300;

const IMMUTABLE_CORE_FIELDS = new Set([
  "official_sailing_id",
  "external_key",
  "identity_key",
  "ship_id",
  "departure_date",
  "cruise_line_id",
  "status",
  "nights"
]);

const KNOWN_PORT_CASES = [
  { pattern: /great stirrup cay/i, expect: "Great Stirrup Cay", not: "CocoCay" },
  { pattern: /ward cove/i, expect: "Ketchikan", note: "Ward Cove terminal convention" },
  { pattern: /tarragona|barcelona \(tarragona\)/i, expect: "Tarragona", not: "Barcelona" },
  { pattern: /ravenna/i, expect: "Ravenna", not: "Venice" },
  { pattern: /trieste/i, expect: "Trieste", not: "Venice" },
  { pattern: /san antonio/i, expect: "San Antonio", not: "Valparaiso" },
  { pattern: /incheon|seoul \(incheon\)/i, expect: "Incheon" },
  { pattern: /yokohama/i, expect: "Yokohama" },
  { pattern: /port canaveral|orlando \(port canaveral\)/i, expect: "Port Canaveral" },
  { pattern: /southampton|london \(southampton\)/i, expect: "Southampton" },
  { pattern: /civitavecchia|rome \(civitavecchia\)/i, expect: "Civitavecchia" },
  { pattern: /piraeus|athens \(piraeus\)/i, expect: "Piraeus" }
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableJsonStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
}

function enrichmentValuesEqual(field, beforeValue, afterValue) {
  if (field === "raw_extract") {
    const stripVolatile = (raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const copy = { ...raw };
      delete copy.ncl_enrichment_at;
      return copy;
    };
    return stableJsonStringify(stripVolatile(beforeValue)) === stableJsonStringify(stripVolatile(afterValue));
  }
  return stableJsonStringify(beforeValue) === stableJsonStringify(afterValue);
}

function normalisePortLabel(value) {
  return String(value || "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function resolvePortOfCall(sourcePort, portCode = null) {
  const cleaned = normalisePortLabel(sourcePort);
  if (!cleaned) {
    return {
      source_port: sourcePort,
      port_code: portCode,
      classification: "UNRESOLVED",
      canonical_port: null,
      status: "missing"
    };
  }

  if (portCode) {
    const codeMeta = resolveNorwegianDeparturePort({ port_of_departure_code: portCode });
    if (codeMeta.status === "resolved" || codeMeta.status === "alias") {
      return {
        source_port: cleaned,
        port_code: portCode,
        classification: "SAFE_EQUIVALENT",
        canonical_port: codeMeta.canonicalPortName,
        status: codeMeta.status,
        method: codeMeta.resolution_method || "ncl_embark_port_code_map"
      };
    }

    const pocCanonical = poc.getPortOfCallCanonicalName(portCode);
    if (pocCanonical) {
      const meta = resolveRawPortText(pocCanonical, {
        sourceField: "ncl_port_of_call_code",
        nclEmbarkPortCode: portCode
      });
      if (meta.status === "resolved" || meta.status === "alias") {
        return {
          source_port: cleaned,
          port_code: portCode,
          classification: "SAFE_EQUIVALENT",
          canonical_port: meta.canonicalPortName || pocCanonical,
          status: meta.status,
          method: "ncl_port_of_call_code_map"
        };
      }
    }
  }

  const meta = resolveRawPortText(cleaned, { sourceField: "ncl_schedule_enrichment", nclEmbarkPortCode: portCode });
  const adapterClass = classifyPortResolution(meta);
  const classification =
    adapterClass === "exact_match"
      ? "EXACT"
      : adapterClass === "existing_alias"
        ? "EXISTING_ALIAS"
        : adapterClass === "safely_resolvable"
          ? "SAFE_EQUIVALENT"
          : adapterClass === "ambiguous"
            ? "AMBIGUOUS"
            : "UNRESOLVED";

  return {
    source_port: cleaned,
    port_code: portCode,
    classification,
    canonical_port: meta.canonicalPortName || null,
    status: meta.status,
    method: meta.method || null,
    reason: meta.reason || null
  };
}

function resolveOrderedPorts(portsOfCall = []) {
  return (portsOfCall || []).map((port) => {
    const sourceName = normalisePortLabel(port?.title || port?.name || port?.code || "");
    const code = port?.code ? String(port.code).trim().toUpperCase() : null;
    return resolvePortOfCall(sourceName, code);
  });
}

function summarisePortResolution(resolvedPorts = []) {
  const summary = {
    total: resolvedPorts.length,
    exact: 0,
    existing_alias: 0,
    safe_equivalent: 0,
    unresolved: 0,
    ambiguous: 0
  };
  for (const row of resolvedPorts) {
    if (row.classification === "EXACT") summary.exact += 1;
    else if (row.classification === "EXISTING_ALIAS") summary.existing_alias += 1;
    else if (row.classification === "SAFE_EQUIVALENT") summary.safe_equivalent += 1;
    else if (row.classification === "AMBIGUOUS") summary.ambiguous += 1;
    else summary.unresolved += 1;
  }
  return summary;
}

function validateSchedulePageIdentity(dbRow, parsed, completeItinerary, itineraryCode) {
  const expectedCode = String(
    dbRow.raw_extract?.ncl_itinerary_code || dbRow.itinerary || itineraryCode || ""
  )
    .trim()
    .toUpperCase();
  const pageCode = String(completeItinerary?.code || itineraryCode || "")
    .trim()
    .toUpperCase();
  if (expectedCode && pageCode && expectedCode !== pageCode) {
    return { ok: false, reason: "itinerary_code_mismatch", expected: expectedCode, page: pageCode };
  }
  const pageDays = structuredDurationDays(parsed);
  const durationWarning =
    pageDays != null && dbRow.nights != null && pageDays !== Number(dbRow.nights)
      ? {
          expected_nights: dbRow.nights,
          page_duration_days: pageDays,
          page_duration: parsed?.duration || null
        }
      : null;
  return { ok: true, reason: null, duration_warning: durationWarning, page_duration_days: pageDays };
}

function structuredDurationDays(parsed) {
  if (!parsed?.duration) return null;
  if (typeof parsed.duration === "object" && parsed.duration.days != null) {
    return Number(parsed.duration.days);
  }
  const asNumber = Number(parsed.duration);
  return Number.isFinite(asNumber) ? asNumber : null;
}

function extractTitleDayCount(title) {
  const match = String(title || "").match(/(\d+)\s*[- ]?\s*day/i);
  return match ? Number(match[1]) : null;
}

function normalizeItineraryTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .trim();
}

function validateSemanticEnrichment(dbRow, parsed, completeItinerary) {
  const browseNights = Number(dbRow.nights);
  const pageDays = structuredDurationDays(parsed);
  const titleDays = extractTitleDayCount(parsed?.title);
  const itineraryCode = String(dbRow.raw_extract?.ncl_itinerary_code || "").trim();
  const codeDurationMatch = itineraryCode.match(/(\d+)[A-Z]/);
  const codeDays = codeDurationMatch ? Number(codeDurationMatch[1]) : null;

  const checks = {
    itinerary_code: String(completeItinerary?.code || "").trim().toUpperCase() === itineraryCode.toUpperCase(),
    structured_duration_matches_browse: pageDays == null || !Number.isFinite(browseNights) || pageDays === browseNights,
    title_day_count_matches_browse:
      titleDays == null || !Number.isFinite(browseNights) || titleDays === browseNights,
    code_duration_matches_browse: codeDays == null || !Number.isFinite(browseNights) || codeDays === browseNights
  };

  let status = "VERIFIED";
  let reason = null;
  const conflicts = [];

  if (!checks.itinerary_code) {
    status = "IDENTITY_MISMATCH";
    reason = "itinerary_code_mismatch";
  } else if (pageDays != null && Number.isFinite(browseNights) && pageDays !== browseNights) {
    status = "SOURCE_METADATA_CONFLICT";
    reason = "structured_duration_conflicts_with_browse";
    conflicts.push({ field: "duration", browse: browseNights, page: pageDays });
  } else if (titleDays != null && Number.isFinite(browseNights) && titleDays !== browseNights) {
    status = "VERIFIED_WITH_MARKETING_TITLE_DIFFERENCE";
    reason = "marketing_title_day_count_differs_from_browse_duration";
    conflicts.push({ field: "title_day_count", browse: browseNights, title: titleDays, structured: pageDays });
  } else if (codeDays != null && Number.isFinite(browseNights) && codeDays !== browseNights) {
    status = "SOURCE_METADATA_CONFLICT";
    reason = "itinerary_code_duration_conflicts_with_browse";
    conflicts.push({ field: "code_duration", browse: browseNights, code: codeDays });
  }

  return {
    status,
    reason,
    checks,
    conflicts,
    browse_nights: browseNights,
    page_duration_days: pageDays,
    title_day_count: titleDays,
    code_duration_days: codeDays,
    trusted_for_core_identity: status !== "IDENTITY_MISMATCH" && status !== "SOURCE_METADATA_CONFLICT"
  };
}

function canonicalEmbarkFromPage(completeItinerary) {
  const code = completeItinerary?.portsData?.embarkationPort?.code || null;
  const title =
    completeItinerary?.portsData?.embarkationPort?.title ||
    completeItinerary?.portsData?.embarkationPort?.name ||
    null;
  if (code) {
    const meta = resolveNorwegianDeparturePort({ port_of_departure_code: code, departure_port: title });
    if (meta.canonicalPortName) return { canonical: meta.canonicalPortName, source: title, code };
  }
  const meta = resolveRawPortText(title, { sourceField: "ncl_schedule_enrichment" });
  return { canonical: meta.canonicalPortName || null, source: title, code };
}

function canonicalDisembarkFromPage(completeItinerary) {
  const code = completeItinerary?.portsData?.disembarkationPort?.code || null;
  const title =
    completeItinerary?.portsData?.disembarkationPort?.title ||
    completeItinerary?.portsData?.disembarkationPort?.name ||
    null;
  if (code) {
    const meta = resolveNorwegianDeparturePort({ port_of_departure_code: code, departure_port: title });
    if (meta.canonicalPortName) return { canonical: meta.canonicalPortName, source: title, code };
  }
  const meta = resolveRawPortText(title, { sourceField: "ncl_schedule_enrichment" });
  return { canonical: meta.canonicalPortName || null, source: title, code };
}

function validateEmbarkAgainstDb(dbRow, completeItinerary) {
  const pageEmbark = canonicalEmbarkFromPage(completeItinerary);
  const dbEmbark = String(dbRow.departure_port || "").trim();
  if (!pageEmbark.canonical || !dbEmbark) {
    return { ok: true, reason: "insufficient_context", pageEmbark, dbEmbark };
  }
  if (pageEmbark.canonical === dbEmbark) {
    return { ok: true, reason: "exact_match", pageEmbark, dbEmbark };
  }
  return {
    ok: false,
    reason: "embark_canonical_mismatch",
    pageEmbark,
    dbEmbark,
    note: "Marketing label differences are acceptable when canonical ports match via code map"
  };
}

function looksLikeRawItineraryCode(value) {
  return /^[A-Z0-9_]{8,}$/.test(String(value || "").trim());
}

function classifyEnrichmentOutcome({ fetchOk, identityOk, parsed, portSummary, embarkValidation, semanticValidation }) {
  if (!fetchOk) return "enrichment_unavailable";
  if (semanticValidation?.status === "IDENTITY_MISMATCH") return "identity_mismatch";
  if (semanticValidation?.status === "SOURCE_METADATA_CONFLICT") return "core_source_discrepancy";
  if (!identityOk) return "identity_mismatch";
  if (embarkValidation?.ok === false && embarkValidation.reason === "embark_canonical_mismatch") {
    return "core_source_discrepancy";
  }
  if (!parsed?.ok) return "enrichment_unavailable";
  if (portSummary.ambiguous > 0) return "ambiguous_port";
  if (portSummary.unresolved > 0) return "partial_enrichment";
  if (portSummary.total === 0) return "enrichment_unavailable";
  return "enrichment_ready";
}

function buildItineraryPortsDisplay(resolvedPorts = []) {
  return resolvedPorts
    .map((port) => port.canonical_port || port.source_port)
    .filter(Boolean);
}

function buildEnrichmentPatch(dbRow, enrichment, options = {}) {
  const parsed = enrichment.parsed || {};
  const resolvedPorts = enrichment.resolved_ports || [];
  const portSummary = enrichment.port_summary || summarisePortResolution(resolvedPorts);
  const outcome = enrichment.outcome;

  const normalizedTitle = normalizeItineraryTitle(parsed.title);
  const title = normalizedTitle && !looksLikeRawItineraryCode(normalizedTitle) ? normalizedTitle : null;
  const disembark = enrichment.disembark || canonicalDisembarkFromPage(enrichment.completeItinerary || {});
  const itineraryPorts = buildItineraryPortsDisplay(resolvedPorts);

  const patch = {};
  if (title) patch.itinerary = title;
  if (itineraryPorts.length) patch.itinerary_ports = itineraryPorts;

  const raw = {
    ...(dbRow.raw_extract || {}),
    ncl_enrichment_phase: "phase5c_data_quality_completion",
    ncl_enrichment_at: enrichment.enriched_at || new Date().toISOString(),
    ncl_enrichment_status: outcome,
    ncl_enrichment_method: enrichment.extraction_method || null,
    ncl_itinerary_title: normalizedTitle || null,
    ncl_itinerary_title_raw: parsed.title || null,
    ncl_semantic_validation: enrichment.semantic_validation || null,
    ncl_disembarkation_port: disembark.canonical || parsed.disembarkation_port || null,
    ncl_disembarkation_port_source: disembark.source || parsed.disembarkation_port || null,
    ncl_disembarkation_port_code: disembark.code || null,
    ncl_ordered_ports_source: parsed.ordered_ports || [],
    ncl_ordered_ports_resolution: resolvedPorts,
    ncl_ordered_ports_summary: portSummary,
    ncl_package_id: parsed.package_id || null,
    ncl_sail_id: parsed.sail_id || null,
    ncl_supported_fields: parsed.supported_fields || [],
    ncl_unsupported_fields: parsed.unsupported_fields || [],
    ncl_page_identity_validation: enrichment.identity_validation || null,
    ncl_embark_validation: enrichment.embark_validation || null
  };

  patch.raw_extract = raw;
  if (enrichment.schedule_url) {
    patch.official_url = enrichment.schedule_url;
    patch.source_url = enrichment.schedule_url;
  }

  if (!dbRow.destination_id && options.destinations?.length) {
    const assignment = resolveNorwegianDestinationAssignment({
      destination_codes: dbRow.raw_extract?.ncl_destination_codes || [],
      dbRow: {
        ...dbRow,
        itinerary: title || dbRow.itinerary,
        itinerary_ports: itineraryPorts.length ? itineraryPorts : dbRow.itinerary_ports || []
      },
      destinations: options.destinations
    });
    if (assignment.destination_id) patch.destination_id = assignment.destination_id;
  }

  return {
    patch,
    outcome,
    port_summary: portSummary,
    proposed_fields: Object.keys(patch),
    core_identity_changes: []
  };
}

function diffPatchProposal(beforeRow, proposal) {
  const changes = {};
  for (const [field, afterValue] of Object.entries(proposal.patch || {})) {
    const beforeValue = beforeRow[field];
    if (!enrichmentValuesEqual(field, beforeValue, afterValue)) {
      changes[field] = { before: beforeValue ?? null, after: afterValue ?? null };
    }
  }
  return changes;
}

async function fetchEnrichmentForVoyage(dbRow, options = {}) {
  const itineraryCode = String(dbRow.raw_extract?.ncl_itinerary_code || dbRow.itinerary || "").trim();
  const scheduleUrl = source.buildScheduleUrl(itineraryCode);
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  let response;
  try {
    response = await fetchImpl(scheduleUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": source.USER_AGENT,
        Referer: `${source.SITE_ORIGIN}${source.LOCALE_PREFIX}/vacations`
      }
    });
  } catch (error) {
    return {
      itinerary_code: itineraryCode,
      schedule_url: scheduleUrl,
      fetch_ok: false,
      fetch_error: error.message || String(error),
      outcome: "enrichment_unavailable"
    };
  }

  if (!response.ok) {
    return {
      itinerary_code: itineraryCode,
      schedule_url: scheduleUrl,
      fetch_ok: false,
      fetch_status: response.status,
      outcome: "enrichment_unavailable"
    };
  }

  const html = await response.text();
  const extraction = extractCompleteItineraryFromHtml(html);
  const parsed = parseEnrichedItinerary(extraction.completeItinerary);
  const portsOfCall = extraction.completeItinerary?.portsData?.portsOfCall || [];
  const resolvedPorts = resolveOrderedPorts(portsOfCall);
  const portSummary = summarisePortResolution(resolvedPorts);
  const identityValidation = validateSchedulePageIdentity(
    dbRow,
    parsed,
    extraction.completeItinerary,
    itineraryCode
  );
  const embarkValidation = validateEmbarkAgainstDb(dbRow, extraction.completeItinerary || {});
  const semanticValidation = validateSemanticEnrichment(dbRow, parsed, extraction.completeItinerary || {});
  const identityOk =
    identityValidation.ok &&
    embarkValidation.ok !== false &&
    semanticValidation.trusted_for_core_identity !== false;
  const outcome = classifyEnrichmentOutcome({
    fetchOk: extraction.ok,
    identityOk,
    parsed,
    portSummary,
    embarkValidation,
    semanticValidation
  });

  return {
    itinerary_code: itineraryCode,
    schedule_url: scheduleUrl,
    fetch_ok: extraction.ok,
    fetch_status: response.status,
    extraction_method: extraction.method || extraction.reason || null,
    completeItinerary: extraction.completeItinerary || null,
    parsed,
    resolved_ports: resolvedPorts,
    port_summary: portSummary,
    identity_validation: identityValidation,
    embark_validation: embarkValidation,
    semantic_validation: semanticValidation,
    disembark: canonicalDisembarkFromPage(extraction.completeItinerary || {}),
    outcome,
    enriched_at: new Date().toISOString()
  };
}

function buildManifestEntry(manifestRow, dbRow) {
  return {
    batch_position: manifestRow.batch_position,
    discovered_cruise_id: dbRow.id,
    itinerary_code: manifestRow.itinerary_code,
    departure_date: manifestRow.departure_date,
    official_sailing_id: manifestRow.official_sailing_id,
    external_key: manifestRow.external_key,
    ship_name: manifestRow.resolved_ship_name,
    embark_port: manifestRow.resolved_departure_port,
    status: dbRow.status,
    source_url: manifestRow.source_url,
    schedule_url: source.buildScheduleUrl(manifestRow.itinerary_code)
  };
}

function assessAdminQuality(dbRow, enrichment, proposal) {
  const issues = [];
  const title = proposal?.patch?.itinerary || dbRow.itinerary;
  const destinationId = proposal?.patch?.destination_id ?? dbRow.destination_id;
  const semantic = enrichment?.semantic_validation?.status || null;

  if (looksLikeRawItineraryCode(title)) issues.push("raw_itinerary_code_displayed_as_title");
  if (!dbRow.departure_port) issues.push("missing_departure_port");
  if (!proposal?.patch?.itinerary_ports?.length && !dbRow.itinerary_ports?.length) {
    issues.push("empty_itinerary_ports");
  }
  if (enrichment.outcome === "partial_enrichment") issues.push("partial_port_resolution");
  if (enrichment.outcome === "ambiguous_port") issues.push("ambiguous_port_resolution");
  if (enrichment.outcome === "identity_mismatch" || semantic === "IDENTITY_MISMATCH") {
    issues.push("identity_mismatch");
  }
  if (enrichment.outcome === "core_source_discrepancy" || semantic === "SOURCE_METADATA_CONFLICT") {
    issues.push("source_metadata_conflict");
  }
  if (!destinationId) issues.push("destination_unassigned");
  if (dbRow.status !== "match_required") issues.push("unexpected_status");
  if (semantic === "INSUFFICIENT_EVIDENCE") issues.push("insufficient_semantic_evidence");

  let quality = "PASS";
  if (issues.some((i) => /identity_mismatch|source_metadata_conflict|unexpected_status/.test(i))) {
    quality = "FAIL";
  } else if (issues.length) {
    quality = "REVIEW";
  }

  return { quality, issues, semantic_status: semantic };
}

async function buildDryRunManifest(manifestEntries, dbRowsById, options = {}) {
  const destinations =
    options.destinations ||
    (options.supabase
      ? await options.supabase("destinations?select=id,name,slug,status,classification_enabled&order=slug.asc")
      : []);
  const entries = [];
  const pageStats = { attempted: 0, successful: 0, failed: 0, identity_mismatches: 0 };
  const portTotals = {
    total: 0,
    exact: 0,
    existing_alias: 0,
    safe_equivalent: 0,
    unresolved: 0,
    ambiguous: 0
  };

  for (const manifestRow of manifestEntries) {
    const dbRow = dbRowsById.get(manifestRow.official_sailing_id);
    if (!dbRow) {
      entries.push({
        official_sailing_id: manifestRow.official_sailing_id,
        outcome: "missing_db_row",
        blocked: true
      });
      continue;
    }

    pageStats.attempted += 1;
    const enrichment = await fetchEnrichmentForVoyage(dbRow, options);
    if (enrichment.fetch_ok) pageStats.successful += 1;
    else pageStats.failed += 1;
    if (enrichment.outcome === "identity_mismatch") pageStats.identity_mismatches += 1;

    for (const key of Object.keys(portTotals)) {
      if (key === "total") portTotals.total += enrichment.port_summary?.total || 0;
      else portTotals[key] += enrichment.port_summary?.[key] || 0;
    }

    const blocked = ["identity_mismatch", "core_source_discrepancy", "enrichment_unavailable"].includes(
      enrichment.outcome
    );
    const proposal =
      blocked ? { patch: {}, outcome: enrichment.outcome, proposed_fields: [], core_identity_changes: [] }
        : buildEnrichmentPatch(dbRow, enrichment, { destinations });
    const fieldChanges = diffPatchProposal(dbRow, proposal);
    const admin = assessAdminQuality(dbRow, enrichment, proposal);

    entries.push({
      ...buildManifestEntry(manifestRow, dbRow),
      enrichment,
      proposal,
      field_changes: fieldChanges,
      blocked,
      admin_quality: admin.quality,
      admin_issues: admin.issues
    });

    if (options.fetchDelayMs !== 0) await sleep(options.fetchDelayMs ?? FETCH_DELAY_MS);
  }

  const outcomeCounts = entries.reduce((acc, row) => {
    const key = row.proposal?.outcome || row.enrichment?.outcome || row.outcome || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const proposedUpdates = entries.filter((row) => Object.keys(row.field_changes || {}).length > 0).length;
  const gate = {
    passed:
      entries.length === manifestEntries.length &&
      entries.every((row) => row.discovered_cruise_id) &&
      pageStats.identity_mismatches === 0 &&
      !entries.some((row) =>
        ["identity_mismatch", "core_source_discrepancy"].includes(row.enrichment?.outcome || row.outcome)
      ),
    voyage_inserts: 0,
    voyage_deletes: 0,
    activations: 0,
    core_identity_changes: 0,
    legacy_rows_touched: 0
  };

  return {
    generated_at: new Date().toISOString(),
    mode: "norwegian_phase5b_enrichment_dry_run",
    entries,
    page_stats: pageStats,
    port_totals: portTotals,
    outcome_counts: outcomeCounts,
    proposed_updates: proposedUpdates,
    dry_run_gate: gate
  };
}

async function applyEnrichmentManifest({ dryRunManifest, supabase, runId }) {
  const stats = {
    attempted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    rollback_snapshots: [],
    write_details: []
  };

  for (const entry of dryRunManifest.entries || []) {
    if (entry.blocked || !Object.keys(entry.field_changes || {}).length) {
      stats.skipped += 1;
      continue;
    }

    stats.attempted += 1;
    const before = await supabase(
      `discovered_cruises?id=eq.${encodeURIComponent(entry.discovered_cruise_id)}&select=*&limit=1`
    );
    const prev = before?.[0];
    if (!prev) {
      stats.failed += 1;
      continue;
    }

    let blockedCore = false;
    for (const field of IMMUTABLE_CORE_FIELDS) {
      if (entry.proposal.patch[field] != null && entry.proposal.patch[field] !== prev[field]) {
        blockedCore = true;
        stats.write_details.push({
          discovered_cruise_id: entry.discovered_cruise_id,
          result_action: "blocked_core_identity_change",
          field
        });
      }
    }
    if (blockedCore) {
      stats.failed += 1;
      continue;
    }

    const payload = { ...entry.proposal.patch, last_changed_at: new Date().toISOString() };
    try {
      const updated = await supabase(`discovered_cruises?id=eq.${encodeURIComponent(entry.discovered_cruise_id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: payload
      });
      const row = updated?.[0] || null;
      stats.updated += 1;
      stats.rollback_snapshots.push({
        discovered_cruise_id: entry.discovered_cruise_id,
        before: snapshotRecordForRollback(prev),
        after: row ? snapshotRecordForRollback(row) : null
      });
      stats.write_details.push({
        discovered_cruise_id: entry.discovered_cruise_id,
        official_sailing_id: entry.official_sailing_id,
        result_action: "updated",
        fields: Object.keys(entry.field_changes || {})
      });
    } catch (error) {
      stats.failed += 1;
      stats.write_details.push({
        discovered_cruise_id: entry.discovered_cruise_id,
        result_action: "failed",
        error: error.message || String(error)
      });
    }
  }

  return { run_id: runId, stats };
}

async function rollbackEnrichmentSnapshots(supabase, snapshots = []) {
  const rolledBack = [];
  for (const snap of snapshots) {
    if (!snap.before?.id) continue;
    await supabase(`discovered_cruises?id=eq.${encodeURIComponent(snap.before.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: {
        itinerary: snap.before.itinerary ?? null,
        itinerary_ports: snap.before.itinerary_ports ?? [],
        raw_extract: snap.before.raw_extract ?? {},
        official_url: snap.before.official_url,
        source_url: snap.before.source_url ?? snap.before.official_url
      }
    });
    rolledBack.push(snap.before.id);
  }
  return { rolled_back_count: rolledBack.length, rolled_back_ids: rolledBack };
}

function auditKnownPortCases(resolvedPorts = []) {
  const findings = [];
  for (const known of KNOWN_PORT_CASES) {
    for (const port of resolvedPorts) {
      const hay = `${port.source_port} ${port.canonical_port || ""}`;
      if (!known.pattern.test(hay)) continue;
      const ok = known.not
        ? port.canonical_port === known.expect && port.canonical_port !== known.not
        : port.canonical_port === known.expect || (known.expect === "San Antonio" && /San Antonio/i.test(port.canonical_port || ""));
      findings.push({
        case: known.expect,
        source_port: port.source_port,
        canonical_port: port.canonical_port,
        ok,
        note: known.note || null
      });
    }
  }
  return findings;
}

module.exports = {
  NCL_LINE_ID,
  NCL_LINE_SLUG,
  CONTROLLED_ENRICHMENT_LOCK_KEY,
  IMMUTABLE_CORE_FIELDS,
  KNOWN_PORT_CASES,
  resolvePortOfCall,
  resolveOrderedPorts,
  summarisePortResolution,
  validateSchedulePageIdentity,
  validateSemanticEnrichment,
  validateEmbarkAgainstDb,
  normalizeItineraryTitle,
  structuredDurationDays,
  extractTitleDayCount,
  classifyEnrichmentOutcome,
  buildEnrichmentPatch,
  buildItineraryPortsDisplay,
  fetchEnrichmentForVoyage,
  buildDryRunManifest,
  applyEnrichmentManifest,
  rollbackEnrichmentSnapshots,
  assessAdminQuality,
  auditKnownPortCases,
  looksLikeRawItineraryCode,
  isGenuineInventoryRow,
  isLegacyGenericDiscoveryRow,
  stableJsonStringify,
  enrichmentValuesEqual,
  diffPatchProposal
};
