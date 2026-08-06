/**
 * Celebrity inventory counts from unique production database rows.
 */

async function headCountSupabase(supabase, table, query = "") {
  const https = require("https");
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const rows = await supabase(`${table}?select=id${query ? `&${query}` : ""}&limit=1`);
    return Array.isArray(rows) ? rows.length : 0;
  }
  return new Promise((resolve, reject) => {
    const u = new URL(`${url}/rest/v1/${table}?select=id${query ? `&${query}` : ""}`);
    https
      .request(
        u,
        { method: "HEAD", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" } },
        (res) => {
          const range = res.headers["content-range"] || "";
          const m = range.match(/\/(\d+)/);
          resolve(m ? Number(m[1]) : 0);
        }
      )
      .on("error", reject)
      .end();
  });
}

const { perthCalendarDate } = require("./cruise-discovery-maintenance");
const { publicBookingMinimumDepartureDate } = require("./public-discovered-cruise-inventory");

async function loadCelebrityDatabaseInventoryCounts(supabase, cruiseLineId) {
  const today = perthCalendarDate();
  const minPublicDeparture = publicBookingMinimumDepartureDate(today);
  const enc = encodeURIComponent(cruiseLineId);
  const [
    total,
    active,
    activeFuture,
    oceanActive,
    riverActive,
    untypedActive,
    cruisetourActive,
    inactiveHistorical,
    missingOfficialIdentityActive
  ] = await Promise.all([
    headCountSupabase(supabase, "discovered_cruises", `cruise_line_id=eq.${enc}`),
    headCountSupabase(supabase, "discovered_cruises", `cruise_line_id=eq.${enc}&status=eq.active`),
    headCountSupabase(
      supabase,
      "discovered_cruises",
      `cruise_line_id=eq.${enc}&status=eq.active&departure_date=gte.${minPublicDeparture}`
    ),
    headCountSupabase(
      supabase,
      "discovered_cruises",
      `cruise_line_id=eq.${enc}&status=eq.active&raw_extract->>celebrity_product_type=eq.ocean_cruise`
    ),
    headCountSupabase(
      supabase,
      "discovered_cruises",
      `cruise_line_id=eq.${enc}&status=eq.active&raw_extract->>celebrity_product_type=eq.river_cruise`
    ),
    headCountSupabase(
      supabase,
      "discovered_cruises",
      `cruise_line_id=eq.${enc}&status=eq.active&raw_extract->>celebrity_product_type=is.null`
    ),
    headCountSupabase(
      supabase,
      "discovered_cruises",
      `cruise_line_id=eq.${enc}&status=eq.active&or=(raw_extract->>celebrity_product_type.eq.ocean_cruisetour,raw_extract->>celebrity_product_type.eq.river_cruisetour)`
    ),
    headCountSupabase(
      supabase,
      "discovered_cruises",
      `cruise_line_id=eq.${enc}&status=in.(hidden,match_required,validation_failed,expired)`
    ),
    headCountSupabase(
      supabase,
      "discovered_cruises",
      `cruise_line_id=eq.${enc}&status=eq.active&official_sailing_id=is.null`
    )
  ]);

  const activeRows = await supabase(
    `discovered_cruises?cruise_line_id=eq.${enc}&status=eq.active&select=official_sailing_id,raw_extract`
  );
  const sailingCounts = {};
  for (const row of activeRows || []) {
    const sid = row.official_sailing_id || row.raw_extract?.celebrity_sailing_id;
    if (!sid) continue;
    sailingCounts[sid] = (sailingCounts[sid] || 0) + 1;
  }
  const duplicateOfficialIdentities = Object.values(sailingCounts).filter((c) => c > 1).length;

  return {
    cruise_line_id: cruiseLineId,
    source: "production_database_unique_rows",
    total,
    active,
    active_future: activeFuture,
    ocean_active: oceanActive,
    river_active: riverActive,
    untyped_active: untypedActive,
    cruisetours_active: cruisetourActive,
    inactive_historical: inactiveHistorical,
    missing_official_identity_active: missingOfficialIdentityActive,
    duplicate_official_identities: duplicateOfficialIdentities
  };
}

module.exports = {
  headCountSupabase,
  loadCelebrityDatabaseInventoryCounts
};
