/**
 * Silversea weekly maintenance — read-only proposal engine (M1).
 * Converts discovery simulation + production index into classified maintenance proposals.
 * NO production writes.
 */

const {
  officialProductKey,
  isEligibleSilverseaCruise
} = require("./silversea-discovery-adapter");
const {
  classifyExclusiveBucket,
  isClassic,
  isExpedition
} = require("./silversea-controlled-batch");
const {
  classifyExpeditionExclusiveBucket,
  isComboSegmentProduct
} = require("./silversea-expedition-eligibility");
const {
  buildSilverseaUpsertCandidate,
  buildExpeditionUpsertCandidate,
  buildItineraryPorts,
  isLegacyHiddenRow
} = require("./silversea-discovery-writes");
const {
  buildExpectedClassicItineraryPorts,
  buildExpectedPortsFromRawExtract,
  isClassicOfficialId,
  isClassicStoredOfficialRow,
  isExpeditionStoredOfficialRow,
  classifySilverseaOfficialInventory,
  portsArrayEqual,
  normalizeStoredPorts
} = require("./silversea-classic-itinerary-ports-backfill");
const {
  buildExpectedItineraryPorts,
  isExpeditionOfficialId
} = require("./silversea-expedition-itinerary-ports-backfill");
const {
  shouldRemoveFromPublicInventory,
  daysUntilDeparture,
  PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE
} = require("./public-discovered-cruise-inventory");
const {
  MAINTENANCE_CLASSIFICATION,
  IDENTITY_RELATION,
  IMMUTABLE_FIELDS,
  MAINTAINABLE_FIELDS,
  LIFECYCLE_FIELDS,
  SOURCE_ABSENCE_POLICY,
  PROPOSED_ACTION_CEILINGS,
  M0E_DRIFT_CASE_IDS,
  SOURCE_ABSENCE_FIXTURE_ID,
  snapshotFingerprint,
  evaluateItineraryPortsUpdateSafety,
  assessSourcePopulationAnomaly,
  classifySourceOnlyBucketToMaintenance,
  proposalChecksum
} = require("./silversea-weekly-maintenance-policy");

function stableJson(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(stableJson);
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableJson(value[key]);
  }
  return out;
}

function extractRawExtractBusinessFingerprint(raw) {
  if (!raw || typeof raw !== "object") return null;
  const stops = Array.isArray(raw.itinerary_stops)
    ? raw.itinerary_stops.map((stop) => ({
        kind: stop?.kind || null,
        date: stop?.date || null,
        port_name: stop?.port_name || stop?.port_resolution?.canonicalPortName || null,
        sequence: stop?.sequence || null
      }))
    : null;
  return stableJson({
    silversea_cruise_code: raw.silversea_cruise_code || null,
    silversea_cruise_type: raw.silversea_cruise_type || null,
    silversea_code_kind: raw.silversea_code_kind || null,
    source_duration: raw.source_duration ?? null,
    calculated_nights: raw.calculated_nights ?? null,
    duration_matches_dates: raw.duration_matches_dates ?? null,
    destination_key: raw.destination_key || null,
    destination_raw: raw.destination_raw || null,
    departure_port_raw: raw.departure_port_raw || null,
    arrival_port_raw: raw.arrival_port_raw || null,
    full_path: raw.full_path || null,
    structured_source: raw.structured_source || null,
    itinerary_stops: stops
  });
}

function normalizeRawExtractForMaintenanceCompare(raw) {
  return extractRawExtractBusinessFingerprint(raw);
}

function compareSemanticRawExtract(a, b) {
  return JSON.stringify(normalizeRawExtractForMaintenanceCompare(a)) ===
    JSON.stringify(normalizeRawExtractForMaintenanceCompare(b));
}

function productKind(normalised) {
  const raw = normalised?.raw || {};
  if (isExpedition(raw)) return "expedition";
  if (isClassic(raw)) return "classic";
  return "other";
}

function buildExpectedMaintenanceSnapshot(normalised, cruiseLine, today) {
  const kind = productKind(normalised);
  const raw = normalised?.raw || {};
  const c = normalised.candidate || {};
  const officialId = String(normalised.official_sailing_id || officialProductKey(raw)).toUpperCase();

  let portsResult = { ok: false, ports: null, reason: "unknown" };
  if (kind === "classic") {
    portsResult = buildExpectedClassicItineraryPorts(normalised, cruiseLine);
  } else if (kind === "expedition") {
    portsResult = buildExpectedItineraryPorts(normalised, cruiseLine, today);
  }

  const candidate =
    kind === "classic"
      ? buildSilverseaUpsertCandidate(normalised, cruiseLine)
      : buildExpeditionUpsertCandidate(normalised, cruiseLine, today);

  const itinerary_ports = portsResult.ok ? portsResult.ports : candidate?.itinerary_ports || null;

  return {
    official_sailing_id: officialId,
    product_kind: kind,
    ship_id: c.ship_id || null,
    destination_id: c.destination_id || null,
    departure_date: c.departure_date || raw.departure_date || null,
    return_date: c.return_date || raw.return_date || null,
    nights: c.nights ?? raw.source_duration ?? null,
    departure_port: c.departure_port || raw.departure_port || null,
    itinerary: candidate?.itinerary || (Array.isArray(itinerary_ports) && itinerary_ports.length ? itinerary_ports.join(", ") : c.departure_port || officialId),
    itinerary_ports,
    official_url: c.official_url || raw.official_url || null,
    source_url: c.source_url || c.official_url || raw.official_url || null,
    raw_extract: candidate?.raw_extract || c.raw_extract || null,
    ports_reconstruction_ok: portsResult.ok,
    ports_reconstruction_reason: portsResult.reason || null,
    detail_enriched: raw.detail_enriched === true
  };
}

function diffMaintainableFields(productionRow, expected) {
  const changed = [];
  const before = {};
  const after = {};
  for (const field of MAINTAINABLE_FIELDS) {
    const prodVal = field === "itinerary_ports" ? normalizeStoredPorts(productionRow[field]) : productionRow[field];
    const expVal = field === "itinerary_ports" ? normalizeStoredPorts(expected[field]) : expected[field];
    let equal = false;
    if (field === "itinerary_ports") {
      equal = portsArrayEqual(prodVal, expVal);
    } else if (field === "raw_extract") {
      equal = compareSemanticRawExtract(prodVal, expVal);
    } else {
      equal = JSON.stringify(prodVal) === JSON.stringify(expVal);
    }
    if (!equal) {
      changed.push(field);
      before[field] = prodVal;
      after[field] = expVal;
    }
  }
  return { changed_fields: changed, before, after };
}

function checkImmutableIntegrity(productionRow, expected, normalised) {
  const issues = [];
  const prodId = String(productionRow.official_sailing_id || "").toUpperCase();
  const expId = String(expected.official_sailing_id || "").toUpperCase();
  if (prodId && expId && prodId !== expId) issues.push("official_sailing_id_mismatch");
  if (productionRow.cruise_line_id && expected.cruise_line_id && productionRow.cruise_line_id !== expected.cruise_line_id) {
    issues.push("cruise_line_id_mismatch");
  }
  const sourceKey = officialProductKey(normalised.raw);
  if (sourceKey && prodId && String(sourceKey).toUpperCase() !== prodId) {
    issues.push("source_identity_replacement_implied");
  }
  return issues;
}

function classifyExistingPair({ normalised, productionRow, cruiseLine, today, sourceHealthy }) {
  const officialId = String(productionRow.official_sailing_id || normalised.official_sailing_id).toUpperCase();
  const expected = buildExpectedMaintenanceSnapshot(normalised, cruiseLine, today);
  const immutableIssues = checkImmutableIntegrity(productionRow, expected, normalised);
  if (immutableIssues.length) {
    return {
      official_sailing_id: officialId,
      production_uuid: productionRow.id,
      identity_relation: IDENTITY_RELATION.SOURCE_AND_PRODUCTION,
      product_kind: expected.product_kind,
      classification: MAINTENANCE_CLASSIFICATION.IDENTITY_CONFLICT,
      reason_codes: immutableIssues,
      proposed_action: "none",
      lifecycle_status: productionRow.status
    };
  }

  const diff = diffMaintainableFields(productionRow, expected);
  if (!diff.changed_fields.length) {
    return {
      official_sailing_id: officialId,
      production_uuid: productionRow.id,
      identity_relation: IDENTITY_RELATION.SOURCE_AND_PRODUCTION,
      product_kind: expected.product_kind,
      classification: MAINTENANCE_CLASSIFICATION.UNCHANGED,
      reason_codes: [],
      proposed_action: "none",
      lifecycle_status: productionRow.status
    };
  }

  if (!sourceHealthy) {
    return {
      official_sailing_id: officialId,
      production_uuid: productionRow.id,
      identity_relation: IDENTITY_RELATION.SOURCE_AND_PRODUCTION,
      product_kind: expected.product_kind,
      classification: MAINTENANCE_CLASSIFICATION.SOURCE_UNSAFE,
      reason_codes: ["unhealthy_source_blocks_update"],
      changed_fields: diff.changed_fields,
      before: diff.before,
      after: diff.after,
      proposed_action: "none",
      lifecycle_status: productionRow.status
    };
  }

  if (diff.changed_fields.includes("itinerary_ports")) {
    const portsSafety = evaluateItineraryPortsUpdateSafety({
      storedPorts: productionRow.itinerary_ports,
      expectedPorts: expected.itinerary_ports,
      raw: normalised.raw,
      candidate: normalised.candidate || {},
      productionRow
    });
    if (!expected.ports_reconstruction_ok || !portsSafety.eligible) {
      return {
        official_sailing_id: officialId,
        production_uuid: productionRow.id,
        identity_relation: IDENTITY_RELATION.SOURCE_AND_PRODUCTION,
        product_kind: expected.product_kind,
        classification: MAINTENANCE_CLASSIFICATION.UPDATE_UNSAFE,
        reason_codes: [
          expected.ports_reconstruction_reason || "ports_not_reconstructable",
          portsSafety.guard || "itinerary_guard_failed"
        ],
        changed_fields: diff.changed_fields,
        before: diff.before,
        after: diff.after,
        itinerary_ports_guard: portsSafety,
        proposed_action: "none",
        lifecycle_status: productionRow.status,
        m0e_drift_case: M0E_DRIFT_CASE_IDS.includes(officialId)
      };
    }
  }

  const unsafeReasons = [];
  if (!expected.detail_enriched && diff.changed_fields.some((f) => f === "itinerary_ports" || f === "itinerary")) {
    unsafeReasons.push("source_detail_not_enriched");
  }

  if (unsafeReasons.length) {
    return {
      official_sailing_id: officialId,
      production_uuid: productionRow.id,
      identity_relation: IDENTITY_RELATION.SOURCE_AND_PRODUCTION,
      product_kind: expected.product_kind,
      classification: MAINTENANCE_CLASSIFICATION.UPDATE_UNSAFE,
      reason_codes: unsafeReasons,
      changed_fields: diff.changed_fields,
      before: diff.before,
      after: diff.after,
      proposed_action: "none",
      lifecycle_status: productionRow.status
    };
  }

  return {
    official_sailing_id: officialId,
    production_uuid: productionRow.id,
    identity_relation: IDENTITY_RELATION.SOURCE_AND_PRODUCTION,
    product_kind: expected.product_kind,
    classification: MAINTENANCE_CLASSIFICATION.UPDATE_ELIGIBLE,
    reason_codes: ["deterministic_source_diff"],
    changed_fields: diff.changed_fields,
    before: diff.before,
    after: diff.after,
    source_evidence: {
      detail_enriched: expected.detail_enriched,
      official_url: expected.official_url
    },
    risk_classification: "low_deterministic",
    proposed_action: "proposed_update_dry_run_only",
    lifecycle_status: productionRow.status,
    m0e_drift_case: M0E_DRIFT_CASE_IDS.includes(officialId)
  };
}

function classifySourceOnly({ normalised, cruiseLine, today, sourceHealthy, existingByOfficialId }) {
  const raw = normalised.raw || {};
  const officialId = String(normalised.official_sailing_id || officialProductKey(raw)).toUpperCase();
  const kind = productKind(normalised);
  const inProduction = existingByOfficialId.has(officialId);
  if (inProduction) {
    return {
      official_sailing_id: officialId,
      identity_relation: IDENTITY_RELATION.SOURCE_ONLY,
      product_kind: kind,
      classification: MAINTENANCE_CLASSIFICATION.OTHER_UNSAFE,
      reason_codes: ["already_in_production_index"],
      proposed_action: "none"
    };
  }

  const isNewComboSegment = isComboSegmentProduct(raw) || raw.code_kind === "combination" || raw.code_kind === "segment";
  let bucket;
  if (kind === "classic") {
    bucket = classifyExclusiveBucket(normalised, today, existingByOfficialId);
  } else if (kind === "expedition") {
    bucket = classifyExpeditionExclusiveBucket(normalised, today);
  } else {
    bucket = normalised.product_type === "deferred_special_voyage" ? "deferred_special_voyage" : "invalid_identity";
  }

  const classification = classifySourceOnlyBucketToMaintenance(bucket, {
    raw,
    productType: normalised.product_type,
    isNewComboSegment
  });

  const insertAllowed =
    sourceHealthy && classification === MAINTENANCE_CLASSIFICATION.INSERT_ELIGIBLE;

  const candidate =
    kind === "classic"
      ? buildSilverseaUpsertCandidate(normalised, cruiseLine)
      : buildExpeditionUpsertCandidate(normalised, cruiseLine, today);

  return {
    official_sailing_id: officialId,
    identity_relation: IDENTITY_RELATION.SOURCE_ONLY,
    product_kind: kind,
    classification: sourceHealthy ? classification : MAINTENANCE_CLASSIFICATION.SOURCE_UNSAFE,
    secondary_reason: sourceHealthy ? null : "unhealthy_source",
    source_bucket: bucket,
    reason_codes: [bucket],
    special_product_flag: isNewComboSegment || raw.deferred_special_voyage === true,
    ship_id: candidate?.ship_id || normalised.candidate?.ship_id || null,
    departure_date: candidate?.departure_date || normalised.candidate?.departure_date || null,
    return_date: candidate?.return_date || normalised.candidate?.return_date || null,
    nights: candidate?.nights || normalised.candidate?.nights || null,
    destination_id: candidate?.destination_id || normalised.candidate?.destination_id || null,
    departure_port: candidate?.departure_port || normalised.candidate?.departure_port || null,
    itinerary_ports_count: Array.isArray(candidate?.itinerary_ports) ? candidate.itinerary_ports.length : 0,
    proposed_action: insertAllowed ? "proposed_insert_dry_run_only" : "none"
  };
}

function classifyProductionOnly({
  productionRow,
  today,
  sourceHealthy,
  previousObservations = {}
}) {
  const officialId = String(productionRow.official_sailing_id || "").toUpperCase();
  if (!officialId || isLegacyHiddenRow(productionRow)) {
    return null;
  }

  const kind = isClassicOfficialId(officialId)
    ? "classic"
    : isExpeditionOfficialId(officialId)
      ? "expedition"
      : "other";
  const codeKind = productionRow.raw_extract?.silversea_code_kind || productionRow.raw_extract?.code_kind || null;
  const isHistoricalSpecial =
    codeKind === "combination" || codeKind === "segment" || productionRow.raw_extract?.special_voyage === true;

  const withinCutoff = shouldRemoveFromPublicInventory(productionRow, today);
  const days = productionRow.departure_date ? daysUntilDeparture(productionRow.departure_date, today) : null;

  if (withinCutoff || (days != null && days < PUBLIC_BOOKING_MIN_DAYS_UNTIL_DEPARTURE)) {
    return {
      official_sailing_id: officialId,
      production_uuid: productionRow.id,
      identity_relation: IDENTITY_RELATION.PRODUCTION_ONLY,
      product_kind: kind,
      classification: MAINTENANCE_CLASSIFICATION.WITHIN_21_DAY_CUTOFF,
      secondary_reason: "production_only_within_cutoff_or_expired",
      reason_codes: ["lifecycle_cutoff_not_source_absence"],
      proposed_action: "none",
      lifecycle_status: productionRow.status
    };
  }

  const prev = previousObservations[officialId] || null;
  const consecutive = prev ? Number(prev.consecutive_count || 0) + 1 : 1;

  return {
    official_sailing_id: officialId,
    production_uuid: productionRow.id,
    identity_relation: IDENTITY_RELATION.PRODUCTION_ONLY,
    product_kind: kind,
    classification: MAINTENANCE_CLASSIFICATION.SOURCE_ABSENT_OBSERVATION,
    secondary_reason: isHistoricalSpecial ? "historical_combination_metadata_present" : null,
    reason_codes: ["healthy_source_miss"],
    proposed_action: SOURCE_ABSENCE_POLICY.single_miss_action,
    lifecycle_status: productionRow.status,
    departure_date: productionRow.departure_date,
    source_snapshot_health: sourceHealthy,
    consecutive_healthy_absence_count: sourceHealthy ? consecutive : 0,
    quarantine_state:
      consecutive >= SOURCE_ABSENCE_POLICY.required_consecutive_healthy_absences
        ? "proposed_quarantine"
        : "observation_only",
    physical_delete_proposed: false,
    first_observed_absent_at: prev?.first_seen_at || null,
    current_observation_time: new Date().toISOString(),
    m0e_absence_case: officialId === SOURCE_ABSENCE_FIXTURE_ID
  };
}

function countByClassification(records) {
  const counts = {};
  for (const value of Object.values(MAINTENANCE_CLASSIFICATION)) counts[value] = 0;
  for (const row of records) {
    counts[row.classification] = (counts[row.classification] || 0) + 1;
  }
  return counts;
}

function countUpdateFields(updateEligibleRows) {
  const fieldCounts = {};
  for (const row of updateEligibleRows) {
    for (const field of row.changed_fields || []) {
      fieldCounts[field] = (fieldCounts[field] || 0) + 1;
    }
  }
  return fieldCounts;
}

function selectSafestInsertCandidate(insertRows) {
  const classic = insertRows
    .filter((r) => r.product_kind === "classic")
    .filter((r) => !r.special_product_flag)
    .filter((r) => (r.itinerary_ports_count || 0) > 0)
    .sort((a, b) => String(a.departure_date).localeCompare(String(b.departure_date)));
  return classic[0]?.official_sailing_id || insertRows[0]?.official_sailing_id || null;
}

function selectSafestUpdateCandidate(updateRows, driftIds = M0E_DRIFT_CASE_IDS) {
  const drift = updateRows.find((r) => driftIds.includes(String(r.official_sailing_id).toUpperCase()));
  if (drift) return drift.official_sailing_id;
  return updateRows.sort((a, b) => (a.changed_fields?.length || 0) - (b.changed_fields?.length || 0))[0]
    ?.official_sailing_id || null;
}

function buildSilverseaWeeklyMaintenanceProposal(context = {}) {
  const {
    simulation,
    productionIndex,
    cruiseLine,
    today,
    previousObservations = {},
    baselineSourceSummary = null
  } = context;

  const sourceHealthy = simulation?.ok === true && simulation?.health?.ok === true;
  const products = simulation?.products || [];
  const existingByOfficialId = productionIndex?.byOfficialId || new Map();
  const productionRows = (productionIndex?.rows || []).filter((r) => r.official_sailing_id);

  const sourceById = new Map();
  for (const row of products) {
    if (row.official_sailing_id) sourceById.set(String(row.official_sailing_id).toUpperCase(), row);
  }

  const productionOfficialIds = new Set(
    productionRows.map((r) => String(r.official_sailing_id).toUpperCase()).filter(Boolean)
  );
  const sourceOfficialIds = new Set(sourceById.keys());

  const records = [];
  for (const normalised of products) {
    const officialId = String(normalised.official_sailing_id || "").toUpperCase();
    if (!officialId) continue;
    const productionRow = existingByOfficialId.get(officialId) || null;
    if (productionRow && !isLegacyHiddenRow(productionRow)) {
      records.push(
        classifyExistingPair({
          normalised,
          productionRow,
          cruiseLine,
          today,
          sourceHealthy
        })
      );
    } else {
      records.push(
        classifySourceOnly({
          normalised,
          cruiseLine,
          today,
          sourceHealthy,
          existingByOfficialId
        })
      );
    }
  }

  for (const productionRow of productionRows) {
    const officialId = String(productionRow.official_sailing_id).toUpperCase();
    if (!sourceOfficialIds.has(officialId)) {
      const row = classifyProductionOnly({
        productionRow,
        today,
        sourceHealthy,
        previousObservations
      });
      if (row) records.push(row);
    }
  }

  const counts = countByClassification(records);
  const sourceOnlyRecords = records.filter((r) => r.identity_relation === IDENTITY_RELATION.SOURCE_ONLY);
  const productionOnlyRecords = records.filter((r) => r.identity_relation === IDENTITY_RELATION.PRODUCTION_ONLY);
  const sourceAndProduction = records.filter((r) => r.identity_relation === IDENTITY_RELATION.SOURCE_AND_PRODUCTION);

  const insertEligible = records.filter((r) => r.classification === MAINTENANCE_CLASSIFICATION.INSERT_ELIGIBLE);
  const updateEligible = records.filter((r) => r.classification === MAINTENANCE_CLASSIFICATION.UPDATE_ELIGIBLE);
  const updateUnsafe = records.filter((r) => r.classification === MAINTENANCE_CLASSIFICATION.UPDATE_UNSAFE);

  const sourceOnlyPartition = {
    INSERT_ELIGIBLE: sourceOnlyRecords.filter((r) => r.classification === MAINTENANCE_CLASSIFICATION.INSERT_ELIGIBLE).length,
    WITHIN_21_DAY_CUTOFF: sourceOnlyRecords.filter((r) => r.classification === MAINTENANCE_CLASSIFICATION.WITHIN_21_DAY_CUTOFF).length,
    REFERENCE_BLOCKED: sourceOnlyRecords.filter((r) => r.classification === MAINTENANCE_CLASSIFICATION.REFERENCE_BLOCKED).length,
    SEMANTIC_BLOCKED: sourceOnlyRecords.filter((r) => r.classification === MAINTENANCE_CLASSIFICATION.SEMANTIC_BLOCKED).length,
    DURATION_BLOCKED: sourceOnlyRecords.filter((r) => r.classification === MAINTENANCE_CLASSIFICATION.DURATION_BLOCKED).length,
    DEFERRED_SPECIAL_PRODUCT: sourceOnlyRecords.filter((r) => r.classification === MAINTENANCE_CLASSIFICATION.DEFERRED_SPECIAL_PRODUCT).length,
    OTHER_UNSAFE: sourceOnlyRecords.filter(
      (r) =>
        ![
          MAINTENANCE_CLASSIFICATION.INSERT_ELIGIBLE,
          MAINTENANCE_CLASSIFICATION.WITHIN_21_DAY_CUTOFF,
          MAINTENANCE_CLASSIFICATION.REFERENCE_BLOCKED,
          MAINTENANCE_CLASSIFICATION.SEMANTIC_BLOCKED,
          MAINTENANCE_CLASSIFICATION.DURATION_BLOCKED,
          MAINTENANCE_CLASSIFICATION.DEFERRED_SPECIAL_PRODUCT
        ].includes(r.classification)
    ).length
  };
  const sourceOnlyTotal = sourceOnlyRecords.length;
  const sourceOnlyPartitionSum = Object.values(sourceOnlyPartition).reduce((a, b) => a + b, 0);

  const populationGuard = assessSourcePopulationAnomaly(simulation?.summary || {}, baselineSourceSummary);

  const writeAuthorised = {
    inserts: sourceHealthy && populationGuard.ok ? insertEligible.length : 0,
    updates: sourceHealthy && populationGuard.ok ? updateEligible.length : 0,
    source_absence_advancement: 0,
    hides: 0,
    deletes: 0
  };

  const proposal = {
    phase: "M1",
    read_only: true,
    generated_at: new Date().toISOString(),
    source_healthy: sourceHealthy,
    source_snapshot: {
      fetched_at: simulation?.fetch_result?.fetched_at || simulation?.generated_at || null,
      catalogue_url: simulation?.fetch_result?.catalogue_url || "https://www.silversea.com/page-data/cruise-catalog.html/page-data.json",
      health: simulation?.health || null,
      summary: simulation?.summary || null,
      fingerprint: snapshotFingerprint({
        health: simulation?.health,
        summary: simulation?.summary,
        product_count: products.length
      })
    },
    production_baseline: classifySilverseaOfficialInventory(productionIndex?.rows || []),
    identity_reconciliation: {
      source_and_production: sourceAndProduction.length,
      source_only: sourceOnlyRecords.length,
      production_only: productionOnlyRecords.length,
      complete: sourceAndProduction.length + sourceOnlyRecords.length >= sourceOfficialIds.size
    },
    counts,
    source_only_partition: sourceOnlyPartition,
    source_only_partition_reconciles: sourceOnlyPartitionSum === sourceOnlyTotal,
    records,
    tables: {
      insert_eligible: insertEligible,
      update_eligible: updateEligible,
      update_unsafe: updateUnsafe,
      source_absent_observations: records.filter(
        (r) => r.classification === MAINTENANCE_CLASSIFICATION.SOURCE_ABSENT_OBSERVATION
      ),
      deferred_special: sourceOnlyRecords.filter(
        (r) => r.classification === MAINTENANCE_CLASSIFICATION.DEFERRED_SPECIAL_PRODUCT
      ),
      blocked: records.filter((r) =>
        [
          MAINTENANCE_CLASSIFICATION.REFERENCE_BLOCKED,
          MAINTENANCE_CLASSIFICATION.SEMANTIC_BLOCKED,
          MAINTENANCE_CLASSIFICATION.DURATION_BLOCKED,
          MAINTENANCE_CLASSIFICATION.IDENTITY_CONFLICT,
          MAINTENANCE_CLASSIFICATION.SOURCE_UNSAFE,
          MAINTENANCE_CLASSIFICATION.IDENTITY_UNSAFE,
          MAINTENANCE_CLASSIFICATION.OTHER_UNSAFE
        ].includes(r.classification)
      )
    },
    update_field_counts: countUpdateFields(updateEligible),
    m0e_drift_cases: records.filter((r) => M0E_DRIFT_CASE_IDS.includes(String(r.official_sailing_id).toUpperCase())),
    write_authorised_if_executed: writeAuthorised,
    proposed_action_ceilings: PROPOSED_ACTION_CEILINGS,
    population_anomaly_guard: populationGuard,
    canary_preparation: {
      first_insert: selectSafestInsertCandidate(insertEligible),
      first_update: selectSafestUpdateCandidate(updateEligible),
      source_absence: productionOnlyRecords.find((r) => r.m0e_absence_case)?.official_sailing_id || SOURCE_ABSENCE_FIXTURE_ID
    },
    classic_summary: {
      insert_eligible: insertEligible.filter((r) => r.product_kind === "classic").length,
      update_eligible: updateEligible.filter((r) => r.product_kind === "classic").length,
      update_unsafe: updateUnsafe.filter((r) => r.product_kind === "classic").length,
      unchanged: records.filter(
        (r) => r.product_kind === "classic" && r.classification === MAINTENANCE_CLASSIFICATION.UNCHANGED
      ).length
    },
    expedition_summary: {
      insert_eligible: insertEligible.filter((r) => r.product_kind === "expedition").length,
      update_eligible: updateEligible.filter((r) => r.product_kind === "expedition").length,
      update_unsafe: updateUnsafe.filter((r) => r.product_kind === "expedition").length,
      unchanged: records.filter(
        (r) => r.product_kind === "expedition" && r.classification === MAINTENANCE_CLASSIFICATION.UNCHANGED
      ).length
    },
    field_contract: {
      immutable: IMMUTABLE_FIELDS,
      maintainable: MAINTAINABLE_FIELDS,
      lifecycle: LIFECYCLE_FIELDS,
      expired_row_policy: "maintainable_updates_allowed_when_deterministic; lifecycle_separate_from_weekly_source_reconciliation"
    },
    checksum: null
  };

  proposal.checksum = proposalChecksum(proposal);
  return proposal;
}

function verifyProposalIdempotency(proposalA, proposalB) {
  return proposalA.checksum === proposalB.checksum;
}

module.exports = {
  buildSilverseaWeeklyMaintenanceProposal,
  verifyProposalIdempotency,
  buildExpectedMaintenanceSnapshot,
  diffMaintainableFields,
  classifyExistingPair,
  classifySourceOnly,
  classifyProductionOnly,
  productKind,
  compareSemanticRawExtract
};
