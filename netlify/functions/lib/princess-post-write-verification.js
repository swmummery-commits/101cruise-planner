/**
 * Post-write verification for Princess maintenance.
 * Shared by weekly manual apply and controlled catch-up batches.
 */

const PRINCESS_LINE_ID = "c19f40a7-c160-4035-a845-14dada550e1f";

const {
  publicBookingMinimumDepartureDate,
  perthCalendarDate
} = require("./public-discovered-cruise-inventory");

const PRINCESS_ACTIVE_ROW_SELECT =
  "id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,official_url,official_sailing_id,status,raw_extract";

async function fetchPrincessActiveRows(supabase, ids = null) {
  if (typeof supabase !== "function") {
    throw new Error("supabase client function required");
  }
  if (ids?.length) {
    return supabase(
      `discovered_cruises?id=in.(${ids.join(",")})&select=${PRINCESS_ACTIVE_ROW_SELECT}`
    );
  }
  return supabase(
    `discovered_cruises?cruise_line_id=eq.${PRINCESS_LINE_ID}&status=eq.active&select=${PRINCESS_ACTIVE_ROW_SELECT}&order=created_at.desc`
  );
}

function verifyInsertedRows(rows) {
  const minDep = publicBookingMinimumDepartureDate(perthCalendarDate());
  const issues = [];
  for (const row of rows || []) {
    if (row.cruise_line_id !== PRINCESS_LINE_ID) issues.push({ id: row.id, issue: "wrong_line" });
    if (!row.cruise_line_id) issues.push({ id: row.id, issue: "null_cruise_line_id" });
    if (row.status !== "active") issues.push({ id: row.id, issue: "not_active" });
    if (!row.official_sailing_id) issues.push({ id: row.id, issue: "missing_official_sailing_id" });
    if (!row.ship_id) issues.push({ id: row.id, issue: "missing_ship_id" });
    if (!row.destination_id) issues.push({ id: row.id, issue: "missing_destination_id" });
    if (!row.departure_port) issues.push({ id: row.id, issue: "missing_departure_port" });
    if (!row.official_url) issues.push({ id: row.id, issue: "missing_official_url" });
    if (String(row.departure_date).slice(0, 10) < minDep) {
      issues.push({ id: row.id, issue: "inside_21_day_cutoff", departure_date: row.departure_date, minDep });
    }
    if (row.raw_extract?.princess_product_type === "cruisetour") {
      issues.push({ id: row.id, issue: "cruisetour" });
    }
    if (!String(row.official_url || "").includes("princess.com")) {
      issues.push({ id: row.id, issue: "invalid_official_url" });
    }
  }
  return { ok: issues.length === 0, issues, minDeparture: minDep };
}

module.exports = {
  PRINCESS_LINE_ID,
  PRINCESS_ACTIVE_ROW_SELECT,
  fetchPrincessActiveRows,
  verifyInsertedRows
};
