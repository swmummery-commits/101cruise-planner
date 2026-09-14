/**
 * Norwegian match_required audit and existing-UUID enrichment plan.
 * Never invent a replacement UUID for a row that can be completed in place.
 */

const {
  missingNorwegianSourceFields,
  voyageEquivalenceKey,
  voyageKeyComplete
} = require("./norwegian-voyage-identity-classifier");

const MATCH_REQUIRED_CLASSES = Object.freeze([
  "SOURCE_NOW_COMPLETE",
  "SOURCE_STILL_INCOMPLETE",
  "DUPLICATE_ACTIVE",
  "LEGACY",
  "SOURCE_ABSENT",
  "AMBIGUOUS"
]);

function present(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

function voyageOf(row = {}) {
  return voyageEquivalenceKey({
    ship_id: row.ship_id || row.candidate?.ship_id,
    departure_date: row.departure_date || row.candidate?.departure_date,
    return_date: row.return_date || row.candidate?.return_date,
    nights: row.nights ?? row.candidate?.nights,
    departure_port: row.departure_port || row.candidate?.departure_port
  });
}

function classifyNorwegianMatchRequiredRow(row = {}, { sourceEligible = [], productionRows = [] } = {}) {
  const official = row.official_sailing_id;
  const voyage = voyageOf(row);
  const sourceHits = (sourceEligible || []).filter((item) => item.official_sailing_id && item.official_sailing_id === official);
  const sourceVoyageHits = (sourceEligible || []).filter(
    (item) => voyageKeyComplete(voyage) && voyageOf(item) === voyage
  );
  const activeDupes = (productionRows || []).filter(
    (item) =>
      item.id !== row.id &&
      item.status === "active" &&
      ((official && item.official_sailing_id === official) ||
        (voyageKeyComplete(voyage) && voyageOf(item) === voyage))
  );

  if (activeDupes.length) {
    return {
      classification: "DUPLICATE_ACTIVE",
      reason: "active_row_already_owns_identity",
      existing_uuid: row.id,
      duplicate_active_ids: activeDupes.map((item) => item.id)
    };
  }

  const sourceRow = sourceHits[0] || sourceVoyageHits[0] || null;
  if (!sourceRow) {
    const legacy = !present(official) || String(row.raw_extract?.source || "").includes("legacy");
    return {
      classification: legacy ? "LEGACY" : "SOURCE_ABSENT",
      reason: legacy ? "legacy_or_missing_official" : "official_id_absent_from_current_source",
      existing_uuid: row.id
    };
  }

  const gaps = missingNorwegianSourceFields(sourceRow);
  if (gaps.missing_required.length === 0 && present(sourceRow.official_sailing_id)) {
    return {
      classification: "SOURCE_NOW_COMPLETE",
      reason: "source_provides_required_fields",
      existing_uuid: row.id,
      source_official_sailing_id: sourceRow.official_sailing_id
    };
  }
  if (gaps.missing_required.length) {
    return {
      classification: "SOURCE_STILL_INCOMPLETE",
      reason: gaps.missing_required.join(","),
      existing_uuid: row.id
    };
  }
  return {
    classification: "AMBIGUOUS",
    reason: "source_present_but_identity_unstable",
    existing_uuid: row.id
  };
}

function buildMatchRequiredEnrichment(existingRow, sourceRow) {
  if (!existingRow?.id) {
    const err = new Error("match_required_enrichment_requires_existing_uuid");
    err.code = "match_required_enrichment_requires_existing_uuid";
    throw err;
  }
  const patch = {
    id: existingRow.id,
    official_sailing_id: sourceRow?.official_sailing_id || existingRow.official_sailing_id,
    ship_id: sourceRow?.ship_id || existingRow.ship_id,
    departure_date: sourceRow?.departure_date || existingRow.departure_date,
    return_date: sourceRow?.return_date || existingRow.return_date,
    nights: sourceRow?.nights ?? existingRow.nights,
    departure_port: sourceRow?.departure_port || existingRow.departure_port,
    destination_id: sourceRow?.destination_id || existingRow.destination_id,
    proposed_action: "enrich_existing"
  };
  assertExistingUuidPreserved(existingRow, patch);
  return patch;
}

function assertExistingUuidPreserved(existingRow, patch) {
  if (!existingRow?.id) throw new Error("existing_match_required_row_missing_uuid");
  if (patch?.id && patch.id !== existingRow.id) {
    const err = new Error("match_required_enrichment_must_preserve_uuid");
    err.code = "match_required_enrichment_must_preserve_uuid";
    throw err;
  }
  if (patch?.discovered_cruise_id && patch.discovered_cruise_id !== existingRow.id) {
    const err = new Error("match_required_enrichment_must_preserve_uuid");
    err.code = "match_required_enrichment_must_preserve_uuid";
    throw err;
  }
  return true;
}

function auditNorwegianMatchRequiredRows(matchRequiredRows = [], context = {}) {
  const classified = (matchRequiredRows || []).map((row) => ({
    id: row.id,
    official_sailing_id: row.official_sailing_id || null,
    ...classifyNorwegianMatchRequiredRow(row, context)
  }));
  const counts = Object.fromEntries(
    MATCH_REQUIRED_CLASSES.map((name) => [name, classified.filter((row) => row.classification === name).length])
  );
  return { classified, counts, total: classified.length };
}

module.exports = {
  MATCH_REQUIRED_CLASSES,
  classifyNorwegianMatchRequiredRow,
  buildMatchRequiredEnrichment,
  assertExistingUuidPreserved,
  auditNorwegianMatchRequiredRows
};
