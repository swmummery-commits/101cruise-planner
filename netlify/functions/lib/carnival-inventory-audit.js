/**
 * Carnival Cruise Line production inventory classification.
 */

const { CCL_LINE_ID } = require("./carnival-controlled-batch");
const {
  isOfficialCclStructuredRecord,
  isLegacyGenericCclRow,
  indexExistingCclRecords
} = require("./carnival-discovery-writes");
const { officialSailingId } = require("./carnival-discovery-adapter");

async function auditCclProductionInventory(supabase, { sourceSailingIds = new Set() } = {}) {
  const indexed = await indexExistingCclRecords(supabase, CCL_LINE_ID);
  const official = [];
  const legacy = [];
  const unexpected = [];

  for (const row of indexed.rows || []) {
    if (isOfficialCclStructuredRecord(row)) official.push(row);
    else if (isLegacyGenericCclRow(row)) legacy.push(row);
    else unexpected.push(row);
  }

  const officialActive = official.filter((r) => r.status === "active");
  const officialNonActive = official.filter((r) => r.status !== "active");
  const officialIds = official.map((r) => String(r.official_sailing_id));
  const duplicateOfficial = officialIds.filter((id, i) => officialIds.indexOf(id) !== i);
  const officialIdSet = new Set(officialIds);
  const sourceIds = new Set([...(sourceSailingIds || [])].map(String));

  const officialNotInSource = [...officialIdSet].filter((id) => sourceIds.size && !sourceIds.has(id));
  const sourceMissingFromProduction = [...sourceIds].filter((id) => !officialIdSet.has(id));

  const publicLegacy = legacy.filter((r) => r.status === "active");
  const legacyWithOfficialId = legacy.filter((r) => r.official_sailing_id);

  return {
    official_count: official.length,
    official_active: officialActive.length,
    official_non_active: officialNonActive.length,
    legacy_count: legacy.length,
    unexpected_count: unexpected.length,
    duplicate_official_sailing_ids: [...new Set(duplicateOfficial)],
    official_not_in_current_source: officialNotInSource,
    source_identities_missing_from_production: sourceMissingFromProduction,
    legacy_rows: legacy.map(summariseRow),
    unexpected_rows: unexpected.map(summariseRow),
    stop_required:
      unexpected.length > 0 ||
      duplicateOfficial.length > 0 ||
      publicLegacy.length > 0 ||
      legacyWithOfficialId.length > 0,
    indexed
  };
}

function summariseRow(row) {
  return {
    id: row.id,
    status: row.status,
    ship_id: row.ship_id,
    departure_date: row.departure_date,
    departure_port: row.departure_port,
    destination_id: row.destination_id,
    official_sailing_id: row.official_sailing_id,
    structured_source: row.raw_extract?.structured_source || null,
    official_url: row.official_url || null
  };
}

function buildCatchupPlan(sourceProducts, indexed, today) {
  const existingOfficial = indexed?.officialBySailingId || new Map();
  let inserts = 0;
  let updates = 0;
  let unchanged = 0;
  let conflicts = 0;
  let cutoffSkipped = 0;

  for (const row of sourceProducts || []) {
    const sailingId = officialSailingId(row.raw);
    if (!sailingId) continue;
    const existing = existingOfficial.get(sailingId);
    if (!row.eligibility?.discovery_ready) {
      cutoffSkipped += 1;
      continue;
    }
    if (!existing) {
      inserts += 1;
      continue;
    }
    unchanged += 1;
  }

  return {
    eligible_source_identities: (sourceProducts || []).filter((r) => r.eligibility?.discovery_ready).length,
    existing_official_identities: existingOfficial.size,
    inserts_required: inserts,
    updates_required: updates,
    unchanged,
    conflicts,
    cutoff_skipped: cutoffSkipped
  };
}

module.exports = {
  auditCclProductionInventory,
  buildCatchupPlan
};
