/**
 * P3I NCL match_required staging classification.
 * Promote existing UUIDs only. Never invent replacement rows.
 */

const { auditNorwegianMatchRequiredRows } = require("./norwegian-match-required-audit");
const { assessPublicationEligibility } = require("./norwegian-maintenance-shared");
const { missingNorwegianSourceFields } = require("./norwegian-voyage-identity-classifier");

const P3I_STAGING_CLASSES = Object.freeze([
  "READY_TO_PROMOTE",
  "NEEDS_ENRICHMENT",
  "SOURCE_STILL_INCOMPLETE",
  "LEGACY_NO_OFFICIAL_ID",
  "DUPLICATE_ACTIVE",
  "AMBIGUOUS",
  "SOURCE_ABSENT"
]);

function classifyNorwegianP3iStagingRow(row = {}, context = {}) {
  const today = context.today;
  const sourceEligible = context.sourceEligible || [];
  const sourceEligibleOfficialIds = new Set(
    sourceEligible.map((item) => item.official_sailing_id).filter(Boolean)
  );
  const base = auditNorwegianMatchRequiredRows([row], context).classified[0] || {};
  const publication = assessPublicationEligibility(row, { today, sourceEligibleOfficialIds });
  const sourceRow = sourceEligible.find((item) => item.official_sailing_id === row.official_sailing_id);
  const gaps = sourceRow ? missingNorwegianSourceFields(sourceRow) : { missing_required: [] };

  let classification = "AMBIGUOUS";
  if (base.classification === "DUPLICATE_ACTIVE") classification = "DUPLICATE_ACTIVE";
  else if (base.classification === "LEGACY") classification = "LEGACY_NO_OFFICIAL_ID";
  else if (base.classification === "SOURCE_ABSENT") classification = "SOURCE_ABSENT";
  else if (base.classification === "SOURCE_STILL_INCOMPLETE") classification = "SOURCE_STILL_INCOMPLETE";
  else if (base.classification === "AMBIGUOUS") classification = "AMBIGUOUS";
  else if (publication.eligible) classification = "READY_TO_PROMOTE";
  else if (base.classification === "SOURCE_NOW_COMPLETE") classification = "NEEDS_ENRICHMENT";
  else classification = "SOURCE_STILL_INCOMPLETE";

  return {
    uuid: row.id,
    official_sailing_id: row.official_sailing_id || null,
    ship_id: row.ship_id || null,
    departure: row.departure_date || null,
    return: row.return_date || null,
    nights: row.nights ?? null,
    departure_port: row.departure_port || null,
    destination_id: row.destination_id || null,
    identity_key: row.identity_key || null,
    external_key: row.external_key || null,
    source_presence: Boolean(sourceRow),
    missing_fields: [
      ...(gaps.missing_required || []),
      ...(publication.exclusions || [])
    ],
    enrichment_status: row.raw_extract?.ncl_enrichment_status || null,
    publication_eligible: publication.eligible === true,
    reason_currently_match_required: publication.exclusions.join(",") || base.reason || "match_required",
    classification,
    existing_uuid: row.id
  };
}

function classifyNorwegianP3iStagingSet(rows = [], context = {}) {
  const classified = (rows || []).map((row) => classifyNorwegianP3iStagingRow(row, context));
  const counts = Object.fromEntries(P3I_STAGING_CLASSES.map((name) => [name, classified.filter((row) => row.classification === name).length]));
  return { classified, counts, total: classified.length };
}

module.exports = {
  P3I_STAGING_CLASSES,
  classifyNorwegianP3iStagingRow,
  classifyNorwegianP3iStagingSet
};
