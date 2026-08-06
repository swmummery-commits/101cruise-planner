/**
 * Bulk audit helpers for Celebrity controlled production batches.
 */

const { getSupabaseConfig } = require("./supabase-rest.cjs");

function loadRootDir() {
  return require("path").join(__dirname, "..", "..");
}

async function fetchRowsBySailingIds(rootDir, sailingIds) {
  const https = require("https");
  const { url, key } = getSupabaseConfig(rootDir);
  const ids = [...new Set((sailingIds || []).filter(Boolean))];
  if (!ids.length) return [];

  function rest(path) {
    return new Promise((resolve, reject) => {
      https
        .get(new URL(`${url}/rest/v1/${path}`), { headers: { apikey: key, Authorization: `Bearer ${key}` } }, (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              resolve(JSON.parse(data || "[]"));
            } catch (err) {
              reject(new Error(String(data).slice(0, 300)));
            }
          });
        })
        .on("error", reject);
    });
  }

  const or = ids
    .map(
      (k) =>
        `official_sailing_id.eq.${encodeURIComponent(k)},raw_extract->>celebrity_sailing_id.eq.${encodeURIComponent(k)}`
    )
    .join(",");
  const rows = await rest(
    `discovered_cruises?or=(${or})&select=id,ship_id,departure_date,return_date,nights,departure_port,destination_id,status,official_url,source_url,official_sailing_id,raw_extract,last_changed_at,last_verified_at`
  );
  const shipIds = [...new Set((rows || []).map((r) => r.ship_id).filter(Boolean))];
  const destIds = [...new Set((rows || []).map((r) => r.destination_id).filter(Boolean))];
  const ships = shipIds.length
    ? await rest(`ci_cruise_ships?id=in.(${shipIds.join(",")})&select=id,name,official_line_ship_id,ship_class`)
    : [];
  const dests = destIds.length
    ? await rest(`destinations?id=in.(${destIds.join(",")})&select=id,slug,name,status`)
    : [];
  const shipById = Object.fromEntries((ships || []).map((s) => [s.id, s]));
  const destById = Object.fromEntries((dests || []).map((d) => [d.id, d]));

  return (rows || []).map((row) => ({
    discovered_cruise_id: row.id,
    celebrity_sailing_id: row.raw_extract?.celebrity_sailing_id || row.official_sailing_id,
    celebrity_group_id: row.raw_extract?.celebrity_group_id || row.raw_extract?.group_id || null,
    product_type: row.raw_extract?.celebrity_product_type || null,
    ship: shipById[row.ship_id]?.name || null,
    ship_code: shipById[row.ship_id]?.official_line_ship_id || row.raw_extract?.ship_code || null,
    ship_class: shipById[row.ship_id]?.ship_class || null,
    departure_date: row.departure_date,
    return_date: row.return_date,
    nights: row.nights,
    departure_port: row.departure_port,
    destination: destById[row.destination_id]?.slug || null,
    destination_status: destById[row.destination_id]?.status || null,
    source_url: row.official_url || row.source_url,
    status: row.status,
    departure_port_meta: row.raw_extract?.departure_port_meta || null,
    river_name: row.raw_extract?.river_name || null,
    last_changed_at: row.last_changed_at,
    last_verified_at: row.last_verified_at
  }));
}

function activationGateIssues(row) {
  const issues = [];
  if (!row.celebrity_sailing_id && !row.official_sailing_id) issues.push("missing_identity");
  if (!row.ship) issues.push("missing_ship");
  if (!row.departure_date) issues.push("missing_departure_date");
  if (!row.departure_port) issues.push("missing_departure_port");
  if (!row.nights && !row.return_date) issues.push("missing_nights_and_return");
  if (!row.destination) issues.push("missing_destination");
  if (!row.source_url) issues.push("missing_url");
  if (row.status !== "active") issues.push("not_active");
  if (row.product_type === "ocean_cruisetour" || row.product_type === "river_cruisetour") {
    issues.push("cruisetour_product_type");
  }
  if (/hotel/i.test(String(row.departure_port || ""))) issues.push("hotel_origin_embarkation");
  if (row.product_type === "river_cruise" && row.destination !== "european-river-cruises") {
    issues.push("river_wrong_destination");
  }
  return issues;
}

function summariseActivationAudit(rows) {
  const summary = {
    total: rows.length,
    compliant: 0,
    ocean_cruises: 0,
    river_cruises: 0,
    missing_departure_port: 0,
    missing_nights_and_return: 0,
    missing_destination: 0,
    missing_url: 0,
    identity_duplicates: 0,
    other_breaches: 0,
    breaches: []
  };
  const seen = new Set();
  for (const row of rows) {
    const key = row.celebrity_sailing_id || row.official_sailing_id;
    if (key && seen.has(key)) {
      summary.identity_duplicates += 1;
      summary.breaches.push({ celebrity_sailing_id: key, issues: ["duplicate_identity"] });
      continue;
    }
    if (key) seen.add(key);
    if (row.product_type === "ocean_cruise") summary.ocean_cruises += 1;
    if (row.product_type === "river_cruise") summary.river_cruises += 1;
    const issues = activationGateIssues(row);
    if (!issues.length) {
      summary.compliant += 1;
      continue;
    }
    if (issues.includes("missing_departure_port")) summary.missing_departure_port += 1;
    if (issues.includes("missing_nights_and_return")) summary.missing_nights_and_return += 1;
    if (issues.includes("missing_destination")) summary.missing_destination += 1;
    if (issues.includes("missing_url")) summary.missing_url += 1;
    if (
      issues.some(
        (i) =>
          !["missing_departure_port", "missing_nights_and_return", "missing_destination", "missing_url"].includes(i)
      )
    ) {
      summary.other_breaches += 1;
    }
    summary.breaches.push({ celebrity_sailing_id: key, issues, row });
  }
  return summary;
}

module.exports = {
  fetchRowsBySailingIds,
  activationGateIssues,
  summariseActivationAudit
};
