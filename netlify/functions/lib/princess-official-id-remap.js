/**
 * Princess official-sailing-id remap: preserve discovered_cruise UUID when
 * ship/date/duration/port/destination already match and only the official
 * identity changed. Never insert a second voyage row.
 */

const { cruiseIdentityKey } = require("./cruise-discovery-ops");
const { princessExternalKey } = require("./princess-discovery-writes");
const { snapshotRecordForRollback } = require("./cruise-discovery-maintenance-manifests");

const OPERATIONAL_FIELDS = [
  "ship_id",
  "departure_date",
  "return_date",
  "nights",
  "departure_port",
  "destination_id"
];

const PROTECTED_UNCHANGED_FIELDS = [
  "ship_id",
  "destination_id",
  "departure_date",
  "return_date",
  "nights",
  "departure_port",
  "status"
];

function normaliseComparable(value) {
  if (value == null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

function voyageOperationalKey(row = {}) {
  return OPERATIONAL_FIELDS.map((field) => normaliseComparable(row[field])).join("|");
}

function classifyPrincessProposedInsert(insert, productionRows = []) {
  const key = voyageOperationalKey(insert);
  if (!key || key.split("|").every((part) => part === "null" || part === "")) {
    return { classification: "AMBIGUOUS", matching_production: [], reason: "incomplete_operational_identity" };
  }
  const matches = (productionRows || []).filter((row) => voyageOperationalKey(row) === key);
  if (matches.length === 0) {
    return { classification: "TRUE_NEW", matching_production: [] };
  }
  if (matches.length === 1) {
    const existing = matches[0];
    if (normaliseComparable(existing.official_sailing_id) === normaliseComparable(insert.official_sailing_id)) {
      return { classification: "TRUE_NEW", matching_production: matches, reason: "same_official_id_already_present" };
    }
    return {
      classification: "OFFICIAL_ID_REMAP",
      matching_production: matches,
      existing_uuid: existing.id,
      previous_official_sailing_id: existing.official_sailing_id,
      next_official_sailing_id: insert.official_sailing_id
    };
  }
  return { classification: "AMBIGUOUS", matching_production: matches, reason: "multiple_operational_matches" };
}

function classifyPrincessInsertSet(inserts = [], productionRows = []) {
  const classified = (inserts || []).map((insert) => ({
    ...insert,
    ...classifyPrincessProposedInsert(insert, productionRows)
  }));
  return {
    TRUE_NEW: classified.filter((row) => row.classification === "TRUE_NEW"),
    OFFICIAL_ID_REMAP: classified.filter((row) => row.classification === "OFFICIAL_ID_REMAP"),
    AMBIGUOUS: classified.filter((row) => row.classification === "AMBIGUOUS"),
    classified
  };
}

function buildPrincessRemapPatch({ existingRow, nextOfficialSailingId, nextOfficialUrl, nextItinerary, cruiseLineId, runId }) {
  if (!existingRow?.id || !nextOfficialSailingId || !cruiseLineId) {
    throw new Error("princess_remap_payload_incomplete");
  }
  const external_key = princessExternalKey(cruiseLineId, nextOfficialSailingId);
  const identity_key = cruiseIdentityKey({
    cruiseLineId,
    shipId: existingRow.ship_id,
    departureDate: existingRow.departure_date,
    officialUrl: nextOfficialUrl || existingRow.official_url,
    nights: existingRow.nights,
    returnDate: existingRow.return_date,
    officialSailingId: nextOfficialSailingId
  });
  const raw = existingRow.raw_extract && typeof existingRow.raw_extract === "object" ? { ...existingRow.raw_extract } : {};
  raw.princess_sailing_id = nextOfficialSailingId;
  if (nextItinerary) raw.princess_itinerary_name = nextItinerary;
  raw.princess_p1_official_id_remap = {
    from: existingRow.official_sailing_id,
    to: nextOfficialSailingId,
    run_id: runId || null,
    at: new Date().toISOString()
  };
  const patch = {
    official_sailing_id: nextOfficialSailingId,
    official_url: nextOfficialUrl || existingRow.official_url,
    external_key,
    identity_key,
    raw_extract: raw,
    updated_at: new Date().toISOString()
  };
  if (nextItinerary) patch.itinerary = nextItinerary;
  return patch;
}

function assertProtectedFieldsUnchanged(before, after) {
  for (const field of PROTECTED_UNCHANGED_FIELDS) {
    if (normaliseComparable(before?.[field]) !== normaliseComparable(after?.[field])) {
      return { ok: false, field, before: before?.[field], after: after?.[field] };
    }
  }
  return { ok: true };
}

async function loadCollidingPrincessRows(sb, { cruiseLineId, officialSailingId, externalKey, identityKey, excludeId }) {
  const encode = (value) => encodeURIComponent(String(value));
  const exclude = excludeId ? `&id=neq.${encode(excludeId)}` : "";
  const line = `cruise_line_id=eq.${encode(cruiseLineId)}`;
  const [official, external, identity] = await Promise.all([
    sb(`discovered_cruises?${line}&official_sailing_id=eq.${encode(officialSailingId)}${exclude}&select=id,official_sailing_id`),
    sb(`discovered_cruises?${line}&external_key=eq.${encode(externalKey)}${exclude}&select=id,external_key`),
    sb(`discovered_cruises?${line}&identity_key=eq.${encode(identityKey)}${exclude}&select=id,identity_key`)
  ]);
  return {
    official: official || [],
    external: external || [],
    identity: identity || [],
    pass: (official || []).length + (external || []).length + (identity || []).length === 0
  };
}

async function applyPrincessOfficialIdRemap(sb, { existingRow, insert, cruiseLineId, runId }) {
  const patch = buildPrincessRemapPatch({
    existingRow,
    nextOfficialSailingId: insert.official_sailing_id,
    nextOfficialUrl: insert.official_url,
    nextItinerary: insert.itinerary,
    cruiseLineId,
    runId
  });
  const collisions = await loadCollidingPrincessRows(sb, {
    cruiseLineId,
    officialSailingId: patch.official_sailing_id,
    externalKey: patch.external_key,
    identityKey: patch.identity_key,
    excludeId: existingRow.id
  });
  if (!collisions.pass) {
    return { ok: false, reason: "remap_identity_collision", collisions, discovered_cruise_id: existingRow.id };
  }
  const patched = await sb(`discovered_cruises?id=eq.${encodeURIComponent(existingRow.id)}`, {
    method: "PATCH",
    body: patch
  });
  const row = Array.isArray(patched) ? patched[0] : patched;
  const protectedCheck = assertProtectedFieldsUnchanged(existingRow, row || patch);
  if (!protectedCheck.ok) {
    return { ok: false, reason: "protected_field_changed", ...protectedCheck, discovered_cruise_id: existingRow.id };
  }
  return {
    ok: true,
    discovered_cruise_id: existingRow.id,
    official_sailing_id: patch.official_sailing_id,
    previous_official_sailing_id: existingRow.official_sailing_id,
    created: false,
    result_action: "updated",
    rollback_before: snapshotRecordForRollback(existingRow),
    before_values: snapshotRecordForRollback(existingRow),
    after_values: {
      official_sailing_id: patch.official_sailing_id,
      official_url: patch.official_url,
      external_key: patch.external_key,
      identity_key: patch.identity_key,
      itinerary: patch.itinerary || existingRow.itinerary
    },
    row
  };
}

module.exports = {
  OPERATIONAL_FIELDS,
  PROTECTED_UNCHANGED_FIELDS,
  voyageOperationalKey,
  classifyPrincessProposedInsert,
  classifyPrincessInsertSet,
  buildPrincessRemapPatch,
  assertProtectedFieldsUnchanged,
  loadCollidingPrincessRows,
  applyPrincessOfficialIdRemap
};
