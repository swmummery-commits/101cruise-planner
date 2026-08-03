/**
 * Bulk audit helpers for controlled HAL production batches.
 */

const { getSupabaseConfig } = require("./supabase-rest.cjs");

function loadRootDir() {
  return require("path").join(__dirname, "..", "..");
}

async function fetchRowsByProductKeys(rootDir, productKeys) {
  const https = require("https");
  const { url, key } = getSupabaseConfig(rootDir);
  const keys = [...new Set((productKeys || []).filter(Boolean))];
  if (!keys.length) return [];

  function rest(path) {
    return new Promise((resolve, reject) => {
      https.get(new URL(`${url}/rest/v1/${path}`), { headers: { apikey: key, Authorization: `Bearer ${key}` } }, (res) => {
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
      }).on("error", reject);
    });
  }

  const or = keys
    .map((k) => `official_sailing_id.eq.${encodeURIComponent(k)},raw_extract->>hal_product_key.eq.${encodeURIComponent(k)}`)
    .join(",");
  const rows = await rest(
    `discovered_cruises?or=(${or})&select=id,ship_id,departure_date,return_date,nights,departure_port,destination_id,status,official_url,source_url,official_sailing_id,raw_extract,last_changed_at,last_verified_at`
  );
  const shipIds = [...new Set((rows || []).map((r) => r.ship_id).filter(Boolean))];
  const destIds = [...new Set((rows || []).map((r) => r.destination_id).filter(Boolean))];
  const ships = shipIds.length
    ? await rest(`ci_cruise_ships?id=in.(${shipIds.join(",")})&select=id,name`)
    : [];
  const dests = destIds.length
    ? await rest(`destinations?id=in.(${destIds.join(",")})&select=id,slug,name`)
    : [];
  const shipById = Object.fromEntries((ships || []).map((s) => [s.id, s.name]));
  const destById = Object.fromEntries((dests || []).map((d) => [d.id, d.slug]));

  return (rows || []).map((row) => ({
    discovered_cruise_id: row.id,
    hal_product_key: row.raw_extract?.hal_product_key || row.official_sailing_id,
    official_sailing_id: row.official_sailing_id,
    hal_itinerary_id: row.raw_extract?.hal_itinerary_id || null,
    hal_cruise_id: row.raw_extract?.hal_cruise_id || null,
    ship: shipById[row.ship_id] || null,
    departure_date: row.departure_date,
    return_date: row.return_date,
    nights: row.nights,
    departure_port: row.departure_port,
    destination: destById[row.destination_id] || null,
    source_url: row.official_url || row.source_url,
    status: row.status,
    departure_port_meta: row.raw_extract?.departure_port_meta || null,
    last_changed_at: row.last_changed_at,
    last_verified_at: row.last_verified_at
  }));
}

function activationGateIssues(row) {
  const issues = [];
  if (!row.hal_product_key && !row.official_sailing_id) issues.push("missing_identity");
  if (!row.ship) issues.push("missing_ship");
  if (!row.departure_date) issues.push("missing_departure_date");
  if (!row.departure_port) issues.push("missing_departure_port");
  if (!row.nights && !row.return_date) issues.push("missing_nights_and_return");
  if (!row.destination) issues.push("missing_destination");
  if (!row.source_url) issues.push("missing_url");
  if (row.status !== "active") issues.push("not_active");
  return issues;
}

function summariseActivationAudit(rows) {
  const summary = {
    total: rows.length,
    compliant: 0,
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
    const key = row.hal_product_key || row.official_sailing_id;
    if (key && seen.has(key)) {
      summary.identity_duplicates += 1;
      summary.breaches.push({ hal_product_key: key, issues: ["duplicate_identity"] });
      continue;
    }
    if (key) seen.add(key);
    const issues = activationGateIssues(row);
    if (!issues.length) {
      summary.compliant += 1;
      continue;
    }
    if (issues.includes("missing_departure_port")) summary.missing_departure_port += 1;
    if (issues.includes("missing_nights_and_return")) summary.missing_nights_and_return += 1;
    if (issues.includes("missing_destination")) summary.missing_destination += 1;
    if (issues.includes("missing_url")) summary.missing_url += 1;
    if (issues.some((i) => !["missing_departure_port", "missing_nights_and_return", "missing_destination", "missing_url"].includes(i))) {
      summary.other_breaches += 1;
    }
    summary.breaches.push({ hal_product_key: key, issues, row });
  }
  return summary;
}

module.exports = {
  fetchRowsByProductKeys,
  activationGateIssues,
  summariseActivationAudit
};
