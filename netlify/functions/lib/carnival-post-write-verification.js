/**
 * Post-write verification for Carnival Cruise Line controlled batches.
 */

const { CCL_LINE_ID } = require("./carnival-controlled-batch");
const {
  isOfficialCclStructuredRecord,
  isLegacyGenericCclRow
} = require("./carnival-discovery-writes");
const {
  isCruisePubliclyBookable,
  daysUntilDeparture,
  perthCalendarDate
} = require("./public-discovered-cruise-inventory");

const CCL_ACTIVE_ROW_SELECT =
  "id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,official_url,official_sailing_id,external_key,identity_key,status,raw_extract,created_at,last_seen_at";

async function indexCclProductionRecords(supabase, cruiseLineId = CCL_LINE_ID) {
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const batch = await supabase(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
        cruiseLineId
      )}&select=${CCL_ACTIVE_ROW_SELECT}&order=id.asc&limit=${pageSize}&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  const official = rows.filter((row) => isOfficialCclStructuredRecord(row));
  const legacy = rows.filter((row) => isLegacyGenericCclRow(row));
  const officialIds = official.map((row) => row.official_sailing_id);
  const duplicateOfficial = officialIds.filter((id, index) => officialIds.indexOf(id) !== index);

  return {
    total_rows: rows.length,
    official_rows: official,
    legacy_rows: legacy,
    official_count: official.length,
    legacy_count: legacy.length,
    duplicate_official_sailing_ids: [...new Set(duplicateOfficial)],
    by_official_sailing_id: new Map(official.map((row) => [row.official_sailing_id, row]))
  };
}

async function countOfficialCclRows(supabase) {
  const indexed = await indexCclProductionRecords(supabase);
  return {
    total_carnival_rows: indexed.total_rows,
    official_ccl_rows: indexed.official_count,
    legacy_generic_rows: indexed.legacy_count,
    duplicate_official_sailing_ids: indexed.duplicate_official_sailing_ids
  };
}

async function fetchCclRowsBySailingIds(supabase, sailingIds = []) {
  const rows = [];
  for (let i = 0; i < sailingIds.length; i += 50) {
    const chunk = sailingIds.slice(i, i + 50);
    const quoted = chunk.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",");
    const batch = await supabase(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
        CCL_LINE_ID
      )}&official_sailing_id=in.(${quoted})&select=${CCL_ACTIVE_ROW_SELECT}`
    );
    rows.push(...(batch || []));
  }
  return rows;
}

function verifyManifestRowsAgainstProduction(manifest, rows, today = perthCalendarDate()) {
  const issues = [];
  const bySailingId = new Map((rows || []).map((row) => [row.official_sailing_id, row]));
  const entries = manifest?.entries || [];

  if (rows.length !== entries.length) {
    issues.push({ issue: "row_count_mismatch", expected: entries.length, actual: rows.length });
  }

  for (const entry of entries) {
    const row = bySailingId.get(entry.official_sailing_id);
    if (!row) {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "missing_row" });
      continue;
    }
    if (row.cruise_line_id !== CCL_LINE_ID) {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "wrong_cruise_line" });
    }
    if (!isOfficialCclStructuredRecord(row)) {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "not_official_structured_record" });
    }
    if (row.ship_id !== entry.canonical_ship_id) {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "ship_id_mismatch" });
    }
    if (row.departure_date !== entry.departure_date) {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "departure_date_mismatch" });
    }
    if (Number(row.nights) !== Number(entry.nights)) {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "nights_mismatch" });
    }
    if (row.destination_id !== entry.destination_id) {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "destination_id_mismatch" });
    }
    if (String(row.departure_port || "") !== String(entry.departure_port || "")) {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "departure_port_mismatch" });
    }
    if (entry.expected_status && row.status !== entry.expected_status) {
      issues.push({
        official_sailing_id: entry.official_sailing_id,
        issue: "status_mismatch",
        expected: entry.expected_status,
        actual: row.status
      });
    }
    if (!isCruisePubliclyBookable({ departureDate: row.departure_date, status: row.status, perthToday: today }) && row.status === "active") {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "unexpected_public_ineligibility" });
    }
  }

  return { ok: issues.length === 0, issues, rows, entries };
}

function verifyPublicInventoryEligibility(rows, today = perthCalendarDate()) {
  return (rows || []).map((row) => ({
    official_sailing_id: row.official_sailing_id,
    status: row.status,
    departure_date: row.departure_date,
    days_until_departure: daysUntilDeparture(row.departure_date, today),
    publicly_bookable: isCruisePubliclyBookable({
      departureDate: row.departure_date,
      status: row.status,
      perthToday: today
    })
  }));
}

module.exports = {
  CCL_ACTIVE_ROW_SELECT,
  indexCclProductionRecords,
  countOfficialCclRows,
  fetchCclRowsBySailingIds,
  verifyManifestRowsAgainstProduction,
  verifyPublicInventoryEligibility
};
