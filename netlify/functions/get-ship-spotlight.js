/**
 * Public Ship Spotlight lookup.
 * GET /.netlify/functions/get-ship-spotlight?slug=<public-slug>
 */
function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": statusCode === 200 ? "public, max-age=120" : "no-store"
    },
    body: JSON.stringify(body)
  };
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function supabaseGet(path) {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_CONFIGURATION_MISSING");
  const response = await fetch(`${url}/rest/v1/${path}`, {
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
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error((data && data.message) || `SUPABASE_HTTP_${response.status}`);
  }
  return data;
}

function publicDeckPlanUrl(ship) {
  if (ship?.deck_plan_status !== "approved") return null;
  return (
    String(ship.deck_plan_url || ship.deck_plan_pdf_url || ship.deck_plan_page_url || "").trim() ||
    null
  );
}

function mapShip(row) {
  const line = row?.ci_cruise_lines || {};
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    cruise_line_id: row.cruise_line_id,
    cruise_line_name: line.name || null,
    cruise_line_logo_url: line.logo_url || null,
    ship_class: row.ship_class || null,
    passenger_capacity: row.passenger_capacity,
    crew_count: row.crew_count,
    deck_count: row.deck_count,
    stateroom_count: row.stateroom_count,
    stateroom_types: row.cabin_type_summary,
    stateroom_breakdown: row.stateroom_breakdown,
    length_meters: row.length_metres,
    gross_tonnage: row.gross_tonnage,
    beam_metres: row.beam_metres,
    cruising_speed_knots: row.cruising_speed_knots,
    year_built: row.year_built,
    year_refurbished: row.year_refurbished,
    facilities: row.facilities,
    hero_image_url: row.hero_image_url || null,
    image_gallery: Array.isArray(row.image_gallery) ? row.image_gallery : [],
    deck_plan_url: publicDeckPlanUrl(row),
    current_status: row.status || null,
    last_updated: row.updated_at || null,
    updated_date: row.updated_at || null
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { success: false, error: "METHOD_NOT_ALLOWED" });
  }

  const slug = slugify(event.queryStringParameters?.slug || "");
  if (!slug) return jsonResponse(400, { success: false, error: "SHIP_SLUG_REQUIRED" });

  try {
    const spotlightRows = await supabaseGet(
      `ship_spotlights?public_slug=eq.${encodeURIComponent(
        slug
      )}&publication_status=eq.published&active=eq.true&select=id,ship_id,eyebrow,newsletter_heading,editorial_intro,highlights,stat_keys,hero_image_url,supporting_image_urls,public_slug,publication_status,updated_at&limit=1`
    );
    const spotlight = Array.isArray(spotlightRows) ? spotlightRows[0] : null;
    if (!spotlight?.ship_id) {
      return jsonResponse(404, { success: false, error: "SHIP_SPOTLIGHT_NOT_FOUND" });
    }

    const shipRows = await supabaseGet(
      `ci_cruise_ships?id=eq.${encodeURIComponent(
        spotlight.ship_id
      )}&active=eq.true&select=id,name,slug,status,ship_class,cruise_line_id,passenger_capacity,crew_count,deck_count,stateroom_count,cabin_type_summary,stateroom_breakdown,length_metres,gross_tonnage,beam_metres,cruising_speed_knots,year_built,year_refurbished,facilities,hero_image_url,image_gallery,deck_plan_url,deck_plan_page_url,deck_plan_pdf_url,deck_plan_status,updated_at,ci_cruise_lines(id,name,slug,logo_url,active,sold_by_101cruise)&limit=1`
    );
    const shipRow = Array.isArray(shipRows) ? shipRows[0] : null;
    const line = shipRow?.ci_cruise_lines || null;
    if (!shipRow || !line || line.active !== true || line.sold_by_101cruise !== true) {
      return jsonResponse(404, { success: false, error: "SHIP_NOT_AVAILABLE" });
    }

    return jsonResponse(200, {
      success: true,
      spotlight: {
        ...spotlight,
        hero_image_url: String(spotlight.hero_image_url || shipRow.hero_image_url || "").trim() || null,
        highlights: Array.isArray(spotlight.highlights) ? spotlight.highlights : [],
        supporting_image_urls: Array.isArray(spotlight.supporting_image_urls)
          ? spotlight.supporting_image_urls
          : []
      },
      ship: mapShip(shipRow)
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ship_spotlight_public_lookup_failed",
        message: String(error?.message || "unknown").slice(0, 220)
      })
    );
    return jsonResponse(500, { success: false, error: "SHIP_SPOTLIGHT_LOAD_FAILED" });
  }
};
