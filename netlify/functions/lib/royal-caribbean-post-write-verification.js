/**
 * Post-write verification for Royal Caribbean International controlled batches.
 */

const {
  RC_LINE_ID,
  FIRST_BATCH_SAFETY_BUFFER_DAYS
} = require("./royal-caribbean-controlled-batch");
const { daysUntilDeparture, perthCalendarDate } = require("./public-discovered-cruise-inventory");
const { isLegacyHtmlDiscoveryRow } = require("./royal-caribbean-discovery-writes");

const RC_ACTIVE_ROW_SELECT =
  "id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,official_url,official_sailing_id,external_key,identity_key,status,raw_extract,created_at";

async function countGenuineRoyalCaribbeanSailings(supabase) {
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const batch = await supabase(
      `discovered_cruises?cruise_line_id=eq.${encodeURIComponent(
        RC_LINE_ID
      )}&select=id,official_sailing_id,status,official_url,raw_extract&limit=${pageSize}&offset=${offset}`
    );
    if (!batch?.length) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  const genuine = rows.filter((r) => !isLegacyHtmlDiscoveryRow(r) && r.official_sailing_id);
  const legacy = rows.filter((r) => isLegacyHtmlDiscoveryRow(r));
  return {
    total_rows: rows.length,
    genuine_sailing_count: genuine.length,
    legacy_html_count: legacy.length,
    genuine_ids: genuine.map((r) => r.id)
  };
}

async function fetchRoyalCaribbeanRowsByIds(supabase, ids = []) {
  if (!ids.length) return [];
  return supabase(`discovered_cruises?id=in.(${ids.join(",")})&select=${RC_ACTIVE_ROW_SELECT}`);
}

function verifyManifestRowsAgainstProduction(manifest, rows, today = perthCalendarDate()) {
  const issues = [];
  const bySailingId = new Map((rows || []).map((r) => [r.official_sailing_id, r]));
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
    if (row.cruise_line_id !== RC_LINE_ID) {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "wrong_line", id: row.id });
    }
    if (row.status !== "active") {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "not_active", status: row.status });
    }
    if (row.ship_id !== entry.resolved_ship_db_id) {
      issues.push({
        official_sailing_id: entry.official_sailing_id,
        issue: "ship_mismatch",
        expected: entry.resolved_ship_db_id,
        actual: row.ship_id
      });
    }
    if (String(row.departure_date).slice(0, 10) !== String(entry.departure_date).slice(0, 10)) {
      issues.push({
        official_sailing_id: entry.official_sailing_id,
        issue: "departure_date_mismatch",
        expected: entry.departure_date,
        actual: row.departure_date
      });
    }
    if (Number(row.nights) !== Number(entry.nights)) {
      issues.push({
        official_sailing_id: entry.official_sailing_id,
        issue: "nights_mismatch",
        expected: entry.nights,
        actual: row.nights
      });
    }
    if (row.destination_id !== entry.resolved_destination_id) {
      issues.push({
        official_sailing_id: entry.official_sailing_id,
        issue: "destination_mismatch",
        expected: entry.resolved_destination_id,
        actual: row.destination_id
      });
    }
    if (entry.external_key && row.external_key !== entry.external_key) {
      issues.push({
        official_sailing_id: entry.official_sailing_id,
        issue: "external_key_mismatch",
        expected: entry.external_key,
        actual: row.external_key
      });
    }
    if (entry.identity_key && row.identity_key !== entry.identity_key) {
      issues.push({
        official_sailing_id: entry.official_sailing_id,
        issue: "identity_key_mismatch",
        expected: entry.identity_key,
        actual: row.identity_key
      });
    }
    const days = daysUntilDeparture(row.departure_date, today);
    if (days != null && days < FIRST_BATCH_SAFETY_BUFFER_DAYS) {
      issues.push({ official_sailing_id: entry.official_sailing_id, issue: "inside_45_day_buffer", days });
    }
  }

  const sailingIds = rows.map((r) => r.official_sailing_id).filter(Boolean);
  if (new Set(sailingIds).size !== sailingIds.length) {
    issues.push({ issue: "duplicate_official_sailing_ids_in_db" });
  }

  return { ok: issues.length === 0, issues, verified_count: entries.length - issues.filter((i) => i.issue === "missing_row").length };
}

module.exports = {
  RC_LINE_ID,
  RC_ACTIVE_ROW_SELECT,
  countGenuineRoyalCaribbeanSailings,
  fetchRoyalCaribbeanRowsByIds,
  verifyManifestRowsAgainstProduction
};
