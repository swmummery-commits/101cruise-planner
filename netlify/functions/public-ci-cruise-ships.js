/**
 * Public read-only Cruise Intelligence ships.
 *
 * GET /.netlify/functions/public-ci-cruise-ships?line=<slug>
 * GET /.netlify/functions/public-ci-cruise-ships?q=<name>
 * GET /.netlify/functions/public-ci-cruise-ships?slug=<ship-slug>
 *
 * Excludes admin-only / not-sold / invisible records.
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

function clean(raw, max = 80) {
  return String(raw || "")
    .trim()
    .replace(/[%_]/g, "")
    .slice(0, max);
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

function mapShip(row) {
  if (!row) return null;
  const line = row.ci_cruise_lines || null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    year_built: row.year_built,
    year_refurbished: row.year_refurbished,
    passenger_capacity: row.passenger_capacity,
    crew_count: row.crew_count,
    deck_count: row.deck_count,
    stateroom_count: row.stateroom_count,
    gross_tonnage: row.gross_tonnage,
    length_metres: row.length_metres,
    stateroom_breakdown: row.stateroom_breakdown,
    cabin_type_summary: row.cabin_type_summary,
    facilities: row.facilities,
    hero_image_url: row.hero_image_url,
    cruise_line: line
      ? {
          id: line.id,
          name: line.name,
          slug: line.slug,
          code: line.code
        }
      : null
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { success: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const slug = clean(event.queryStringParameters?.slug);
    const line = clean(event.queryStringParameters?.line || event.queryStringParameters?.cruise_line);
    const q = clean(event.queryStringParameters?.q || event.queryStringParameters?.search || event.queryStringParameters?.name);

    if (slug) {
      const rows = await supabaseGet(
        `ci_cruise_ships?select=id,name,slug,status,year_built,year_refurbished,passenger_capacity,crew_count,deck_count,stateroom_count,gross_tonnage,length_metres,stateroom_breakdown,cabin_type_summary,facilities,hero_image_url,ci_cruise_lines!inner(id,name,slug,code,active,sold_by_101cruise)&slug=eq.${encodeURIComponent(slug)}&active=eq.true&ci_cruise_lines.active=eq.true&ci_cruise_lines.sold_by_101cruise=eq.true&limit=1`
      );
      if (!rows.length) {
        return jsonResponse(404, {
          success: false,
          error: "SHIP_NOT_FOUND",
          message: "No public ship matched that slug."
        });
      }
      return jsonResponse(200, { success: true, ship: mapShip(rows[0]) });
    }

    let path =
      "ci_cruise_ships?select=id,name,slug,status,year_built,year_refurbished,passenger_capacity,crew_count,deck_count,stateroom_count,gross_tonnage,length_metres,stateroom_breakdown,cabin_type_summary,facilities,hero_image_url,ci_cruise_lines!inner(id,name,slug,code,active,sold_by_101cruise)&active=eq.true&ci_cruise_lines.active=eq.true&ci_cruise_lines.sold_by_101cruise=eq.true&order=name.asc&limit=100";

    if (line) {
      path += `&ci_cruise_lines.slug=eq.${encodeURIComponent(line)}`;
    }
    if (q) {
      path += `&name.ilike.*${encodeURIComponent(q)}*`;
    }

    if (!line && !q) {
      return jsonResponse(400, {
        success: false,
        error: "QUERY_REQUIRED",
        message: "Provide line=slug, q=name, or slug=ship-slug."
      });
    }

    const rows = await supabaseGet(path);
    return jsonResponse(200, {
      success: true,
      count: rows.length,
      ships: rows.map(mapShip)
    });
  } catch (error) {
    console.error("public-ci-cruise-ships", String(error.message || error).slice(0, 160));
    return jsonResponse(500, {
      success: false,
      error: "SHIPS_LOOKUP_FAILED",
      message: "Ships could not be loaded."
    });
  }
};
