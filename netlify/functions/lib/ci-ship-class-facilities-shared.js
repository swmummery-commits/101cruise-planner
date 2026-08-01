/**
 * Shared Supabase + class template helpers for Netlify functions.
 */
const Replace = require("../../../js/ci-ship-class-facilities-replace.js");
const ClassTpl = require("../../../js/ci-ship-class-facilities-template.js");

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server access is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

async function supabase(path, options = {}) {
  const { url, key } = config();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const response = await fetch(`${url}/rest/v1/${path}`, { ...options, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_error) {
    data = null;
  }
  if (!response.ok) {
    const message = (data && data.message) || text || `Supabase HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

function jsonResponse(statusCode, body, methods) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": methods || "GET, POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

async function fetchTemplatesForLine(cruiseLineId) {
  return supabase(
    "ci_ship_class_facility_templates?cruise_line_id=eq."
      + encodeURIComponent(cruiseLineId)
      + "&select=*&order=class_name.asc"
  );
}

async function fetchTemplateForClass(cruiseLineId, className) {
  const classKey = ClassTpl.normalizeClassKey(className);
  const rows = await supabase(
    "ci_ship_class_facility_templates?cruise_line_id=eq."
      + encodeURIComponent(cruiseLineId)
      + "&class_key=eq."
      + encodeURIComponent(classKey)
      + "&limit=1"
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fetchLineShips(cruiseLineId) {
  return supabase(
    "ci_cruise_ships?cruise_line_id=eq."
      + encodeURIComponent(cruiseLineId)
      + "&select=id,name,active,cruise_line_id,ship_class,facilities,passenger_capacity,crew_count,deck_count,hero_image_url"
  );
}

function assertFacilitiesOnlyPatch(before, after) {
  if (
    after.passenger_capacity !== before.passenger_capacity ||
    after.crew_count !== before.crew_count ||
    after.deck_count !== before.deck_count ||
    after.hero_image_url !== before.hero_image_url
  ) {
    throw new Error("Unexpected non-facilities mutation detected");
  }
}

module.exports = {
  Replace,
  ClassTpl,
  config,
  supabase,
  jsonResponse,
  fetchTemplatesForLine,
  fetchTemplateForClass,
  fetchLineShips,
  assertFacilitiesOnlyPatch
};
