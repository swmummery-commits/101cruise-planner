/**
 * Public read-only Cruise Intelligence cruise lines.
 *
 * GET /.netlify/functions/public-ci-cruise-lines
 * GET /.netlify/functions/public-ci-cruise-lines?q=princess
 *
 * Returns only active + sold_by_101cruise lines, alphabetically by name.
 * Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY server-side.
 */

function jsonResponse(statusCode, body) {
  const empty = body === "" || body == null;
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": empty ? "text/plain" : "application/json",
      "Cache-Control": "public, max-age=60"
    },
    body: empty ? "" : JSON.stringify(body)
  };
}

function cleanQuery(raw) {
  return String(raw || "")
    .trim()
    .replace(/[%_]/g, "")
    .slice(0, 80);
}

async function supabaseGet(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server access is not configured");

  const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_error) {
    data = null;
  }
  if (!response.ok) {
    throw new Error((data && data.message) || `Supabase HTTP ${response.status}`);
  }
  return data || [];
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { success: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const q = cleanQuery(event.queryStringParameters?.q || event.queryStringParameters?.search);
    let path =
      "ci_cruise_lines?select=id,name,slug,code,country,website_url,description,logo_url,line_type,market_segment&active=eq.true&sold_by_101cruise=eq.true&order=name.asc";
    if (q) {
      path += `&or=(name.ilike.*${encodeURIComponent(q)}*,slug.ilike.*${encodeURIComponent(q)}*,code.ilike.*${encodeURIComponent(q)}*)`;
    }
    const rows = await supabaseGet(path);
    return jsonResponse(200, {
      success: true,
      count: rows.length,
      cruise_lines: rows
    });
  } catch (error) {
    console.error("public-ci-cruise-lines", String(error.message || error).slice(0, 160));
    return jsonResponse(500, {
      success: false,
      error: "CRUISE_LINES_LOOKUP_FAILED",
      message: "Cruise lines could not be loaded."
    });
  }
};
