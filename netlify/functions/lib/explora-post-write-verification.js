/**
 * Post-write verification for Explora Journeys maintenance.
 * Mirrors the Princess verification contract against the Explora cruise line id.
 */

const EXPLORA_LINE_ID = "8b28c83e-2bf0-44ce-9795-ec3051c34050";

const {
  publicBookingMinimumDepartureDate,
  perthCalendarDate
} = require("./public-discovered-cruise-inventory");

const EXPLORA_ACTIVE_ROW_SELECT =
  "id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,official_url,official_sailing_id,status,raw_extract";

async function fetchExploraActiveRows(supabase, ids = null) {
  if (typeof supabase !== "function") {
    throw new Error("supabase client function required");
  }
  if (ids?.length) {
    return supabase(`discovered_cruises?id=in.(${ids.join(",")})&select=${EXPLORA_ACTIVE_ROW_SELECT}`);
  }
  return supabase(
    `discovered_cruises?cruise_line_id=eq.${EXPLORA_LINE_ID}&status=eq.active&select=${EXPLORA_ACTIVE_ROW_SELECT}&order=created_at.desc`
  );
}

function verifyInsertedRows(rows) {
  const minDep = publicBookingMinimumDepartureDate(perthCalendarDate());
  const issues = [];
  for (const row of rows || []) {
    if (row.cruise_line_id !== EXPLORA_LINE_ID) issues.push({ id: row.id, issue: "wrong_line" });
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
    const productType = row.raw_extract?.explora_product_type;
    if (productType && productType !== "ocean_cruise" && productType !== "cruise") {
      issues.push({ id: row.id, issue: "non_cruise_product", product_type: productType });
    }
    if (!String(row.official_url || "").includes("explorajourneys.com")) {
      issues.push({ id: row.id, issue: "invalid_official_url" });
    }
  }
  return { ok: issues.length === 0, issues, minDeparture: minDep };
}

module.exports = {
  EXPLORA_LINE_ID,
  EXPLORA_ACTIVE_ROW_SELECT,
  fetchExploraActiveRows,
  verifyInsertedRows
};
