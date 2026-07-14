/**
 * Public read-only list of active drinks-calculator cruise lines.
 *
 * GET /.netlify/functions/public-calculator-lines
 *
 * Uses server-side Supabase service credentials only.
 * Returns selector fields for active calculator-rate rows.
 * No visitor input, no writes, no customer data.
 */

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60"
    },
    body: JSON.stringify(body)
  };
}

async function fetchActiveCalculatorLines() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase server access is not configured");
  }

  const query = new URLSearchParams({
    select: "cruise_line_id,currency,drinks_included_in_fare,last_verified_at,cruise_lines(id,name,logo_url)",
    active: "eq.true"
  });

  const response = await fetch(`${url}/rest/v1/cruise_line_calculator_rates?${query.toString()}`, {
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
    const message = data?.message || data?.error || `Supabase HTTP ${response.status}`;
    throw new Error(message);
  }

  return Array.isArray(data) ? data : [];
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mapLines(rows) {
  return rows
    .map(row => {
      const cruiseLineId = row?.cruise_line_id;
      const cruiseLineName = String(row?.cruise_lines?.name || "").trim();
      if (cruiseLineId == null || !cruiseLineName) return null;
      return {
        cruise_line_id: cruiseLineId,
        cruise_line_name: cruiseLineName,
        cruise_line_slug: slugify(cruiseLineName),
        currency: String(row?.currency || "USD").trim() || "USD",
        drinks_included_in_fare: row?.drinks_included_in_fare === true,
        last_verified_at: row?.last_verified_at || null,
        logo_url: String(row?.cruise_lines?.logo_url || "").trim() || null
      };
    })
    .filter(Boolean)
    .sort((a, b) =>
      a.cruise_line_name.localeCompare(b.cruise_line_name, undefined, { sensitivity: "base" })
    );
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { success: true });
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, {
      success: false,
      error: "METHOD_NOT_ALLOWED",
      message: "Use GET to load calculator cruise lines."
    });
  }

  try {
    const rows = await fetchActiveCalculatorLines();
    const lines = mapLines(rows);
    return jsonResponse(200, {
      success: true,
      lines
    });
  } catch (error) {
    console.error("public-calculator-lines error", error);
    return jsonResponse(500, {
      success: false,
      error: "LINES_UNAVAILABLE",
      message: "Calculator options are not available right now."
    });
  }
};
