/**
 * Public read-only endpoint for a published Ship Spotlight page.
 * Returns only curated public ship data, approved spotlight copy/media and a
 * small list of current validated sailings. No admin-only or internal fields.
 */

const { getConfig, serviceHeaders } = require("./admin-auth");

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": statusCode === 200 ? "public, max-age=300, s-maxage=900" : "no-store"
    },
    body: JSON.stringify(body)
  };
}

async function rest(path) {
  const { supabaseUrl } = getConfig();
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: { ...serviceHeaders(), Accept: "application/json" }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = data?.message || data?.error || `HTTP ${response.status}`;
    const error = new Error(detail);
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

function cleanSlug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 100);
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((v) => String(v || "").trim()).filter(Boolean))];
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "GET") return json(405, { success: false, error: "Method not allowed" });

  try {
    const slug = cleanSlug(event.queryStringParameters?.slug);
    if (!slug) return json(400, { success: false, error: "Ship slug is required." });

    const spotlightRows = await rest(
      `ship_spotlights?public_slug=eq.${encodeURIComponent(slug)}&publication_status=eq.published&active=eq.true&select=id,ship_id,eyebrow,newsletter_heading,editorial_intro,highlights,stat_keys,hero_image_url,supporting_image_urls,public_slug&limit=1`
    );
    const spotlight = Array.isArray(spotlightRows) ? spotlightRows[0] : null;
    if (!spotlight) return json(404, { success: false, error: "This ship page is not published." });

    const shipRows = await rest(
      `ci_cruise_ships?id=eq.${encodeURIComponent(spotlight.ship_id)}&active=eq.true&select=id,cruise_line_id,name,slug,ship_class,year_built,year_refurbished,passenger_capacity,crew_count,deck_count,stateroom_count,gross_tonnage,length_metres,beam_metres,cruising_speed_knots,facilities,hero_image_url,image_gallery,deck_plan_url,official_ship_url&limit=1`
    );
    const ship = Array.isArray(shipRows) ? shipRows[0] : null;
    if (!ship) return json(404, { success: false, error: "Ship information is unavailable." });

    const [lineRows, mediaRows, researchRows, sailingRows] = await Promise.all([
      rest(`ci_cruise_lines?id=eq.${encodeURIComponent(ship.cruise_line_id)}&select=id,name,slug,logo_url,description&limit=1`),
      rest(`media_library?ship_id=eq.${encodeURIComponent(ship.id)}&is_active=eq.true&media_type=eq.ship&select=id,title,alt_text,public_url,is_default&order=is_default.desc,created_at.desc&limit=24`),
      rest(`research_content?entity_type=eq.ship&entity_id=eq.${encodeURIComponent(ship.id)}&content_status=in.(published,reviewed)&select=summary_text,content_json,pauls_tip,seo_title,meta_description&order=content_version.desc&limit=1`),
      rest(`discovered_cruises?ship_id=eq.${encodeURIComponent(ship.id)}&status=eq.active&departure_date=gte.${new Date().toISOString().slice(0,10)}&select=id,departure_date,return_date,nights,departure_port,itinerary,brochure_fare_display,currency,official_url,destination_id&order=departure_date.asc&limit=12`)
    ]);

    const line = Array.isArray(lineRows) ? lineRows[0] || null : null;
    const research = Array.isArray(researchRows) ? researchRows[0] || null : null;
    const media = Array.isArray(mediaRows) ? mediaRows : [];
    const sailings = Array.isArray(sailingRows) ? sailingRows : [];

    const gallery = uniqueStrings([
      spotlight.hero_image_url,
      ...(spotlight.supporting_image_urls || []),
      ship.hero_image_url,
      ...(Array.isArray(ship.image_gallery) ? ship.image_gallery : []),
      ...media.map((row) => row.public_url)
    ]).slice(0, 18);

    const destinationIds = uniqueStrings(sailings.map((row) => row.destination_id));
    let destinations = [];
    if (destinationIds.length) {
      const filter = destinationIds.map((id) => `id.eq.${id}`).join(",");
      destinations = await rest(`destinations?or=(${encodeURIComponent(filter)})&select=id,name,slug`);
    }
    const destinationMap = new Map((Array.isArray(destinations) ? destinations : []).map((row) => [row.id, row]));

    return json(200, {
      success: true,
      spotlight: {
        eyebrow: spotlight.eyebrow,
        heading: spotlight.newsletter_heading || ship.name,
        intro: spotlight.editorial_intro || research?.summary_text || "",
        highlights: Array.isArray(spotlight.highlights) ? spotlight.highlights : [],
        hero_image_url: spotlight.hero_image_url || ship.hero_image_url || gallery[0] || "",
        public_slug: spotlight.public_slug
      },
      ship: {
        name: ship.name,
        slug: ship.slug,
        ship_class: ship.ship_class,
        year_built: ship.year_built,
        year_refurbished: ship.year_refurbished,
        passenger_capacity: ship.passenger_capacity,
        crew_count: ship.crew_count,
        deck_count: ship.deck_count,
        stateroom_count: ship.stateroom_count,
        gross_tonnage: ship.gross_tonnage,
        length_metres: ship.length_metres,
        beam_metres: ship.beam_metres,
        cruising_speed_knots: ship.cruising_speed_knots,
        facilities: ship.facilities || null,
        deck_plan_url: ship.deck_plan_url || null,
        official_ship_url: ship.official_ship_url || null
      },
      line: line ? { name: line.name, slug: line.slug, logo_url: line.logo_url, description: line.description } : null,
      editorial: {
        summary: research?.summary_text || "",
        content: research?.content_json || {},
        pauls_tip: research?.pauls_tip || "",
        seo_title: research?.seo_title || "",
        meta_description: research?.meta_description || ""
      },
      gallery: media.length
        ? media.map((row) => ({ url: row.public_url, alt: row.alt_text || row.title || ship.name, title: row.title || "" })).filter((row) => row.url)
        : gallery.map((url) => ({ url, alt: ship.name, title: "" })),
      sailings: sailings.map((row) => ({
        id: row.id,
        departure_date: row.departure_date,
        return_date: row.return_date,
        nights: row.nights,
        departure_port: row.departure_port,
        itinerary: row.itinerary,
        fare: row.brochure_fare_display,
        currency: row.currency,
        official_url: row.official_url,
        destination: destinationMap.get(row.destination_id)?.name || ""
      }))
    });
  } catch (error) {
    console.error("public-ship-spotlight", error);
    return json(500, { success: false, error: "Ship Spotlight could not be loaded." });
  }
};
