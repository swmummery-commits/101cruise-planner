/**
 * Public Living Destination page payload.
 *
 * GET /.netlify/functions/public-destination?slug=alaska
 *
 * Returns presentation-ready destination DTO from:
 *   destinations → research_content (published) → media_library → destination_ports
 *
 * Security:
 * - Only status = published destinations
 * - Only published research
 * - Active media only
 * - Service role server-side only
 */

const {
  cleanSlug,
  buildDestinationPageDto,
  buildCruiseCatalog,
  mediaDto
} = require("./lib/destination-page.js");

function jsonResponse(statusCode, body, cacheControl = "public, max-age=300, stale-while-revalidate=86400") {
  const empty = body === "" || body == null;
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": empty ? "text/plain" : "application/json",
      "Cache-Control": cacheControl
    },
    body: empty ? "" : JSON.stringify(body)
  };
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
    const detail =
      (data && (data.message || data.error || data.hint || data.details)) ||
      text ||
      `Supabase HTTP ${response.status}`;
    const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    err.statusCode = response.status;
    throw err;
  }
  return data || [];
}

async function loadMediaMap(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;

  // PostgREST `in` filter
  const filter = unique.join(",");
  const rows = await supabaseGet(
    `media_library?id=in.(${filter})&is_active=eq.true` +
      `&select=id,title,alt_text,public_url,width,height`
  );
  for (const row of rows || []) {
    if (row?.id) map.set(row.id, row);
  }
  return map;
}

async function loadPublishedResearch(destination) {
  if (destination.research_content_id) {
    const byId = await supabaseGet(
      `research_content?id=eq.${encodeURIComponent(destination.research_content_id)}` +
        `&content_status=eq.published` +
        `&select=id,entity_type,entity_key,entity_name,content_json,summary_text,seo_title,meta_description,canonical_slug,media_id,published_at,refresh_after,content_status` +
        `&limit=1`
    );
    if (Array.isArray(byId) && byId[0]) return byId[0];
  }

  const slug = cleanSlug(destination.slug);
  if (!slug) return null;

  const bySlug = await supabaseGet(
    `research_content?entity_type=eq.destination&content_status=eq.published` +
      `&or=(canonical_slug.eq.${encodeURIComponent(slug)},entity_key.eq.${encodeURIComponent(slug)})` +
      `&select=id,entity_type,entity_key,entity_name,content_json,summary_text,seo_title,meta_description,canonical_slug,media_id,published_at,refresh_after,content_status` +
      `&limit=1`
  );
  return Array.isArray(bySlug) ? bySlug[0] || null : null;
}

async function enrichCruiseLineLogos(cruiseLines) {
  const listed = Array.isArray(cruiseLines) ? cruiseLines : [];
  if (!listed.length) return listed;

  try {
    const rows = await supabaseGet(
      `ci_cruise_lines?active=eq.true&sold_by_101cruise=eq.true` +
        `&select=id,name,slug,logo_url&order=name.asc`
    );
    const dbLines = Array.isArray(rows) ? rows : [];

    const normalise = (name) =>
      String(name || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\b(cruises?|line|international|group|ltd|limited)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    return listed.map((line) => {
      const name = typeof line === "string" ? line : line.name;
      const target = normalise(name);
      const exact = dbLines.find((row) => normalise(row.name) === target);
      const match =
        exact ||
        (() => {
          const contains = dbLines.filter((row) => {
            const n = normalise(row.name);
            return n && target && (n.includes(target) || target.includes(n));
          });
          return contains.length === 1 ? contains[0] : null;
        })();
      return {
        name: match?.name || name,
        logo: match?.logo_url || line.logo || null,
        id: match?.id || line.id || null,
        slug: match?.slug || line.slug || null,
        href: match?.slug ? `/cruise-line/${match.slug}` : null,
        source: match ? "ci_cruise_lines" : "research"
      };
    });
  } catch (error) {
    console.warn("destination cruise line logo enrich skipped", error.message || error);
    return listed.map((line) =>
      typeof line === "string"
        ? { name: line, logo: null, href: null }
        : { ...line, logo: line.logo || null, href: line.slug ? `/cruise-line/${line.slug}` : null }
    );
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, "");
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { success: false, error: "Method not allowed" }, "no-store");
  }

  try {
    const params = event.queryStringParameters || {};
    const slug = cleanSlug(params.slug || params.destination || "");
    if (!slug) {
      return jsonResponse(400, { success: false, error: "slug is required" }, "no-store");
    }

    const destinations = await supabaseGet(
      `destinations?slug=ilike.${encodeURIComponent(slug)}&status=eq.published` +
        `&select=id,name,slug,status,hero_media_id,research_content_id,primary_region,display_order,seo_title,meta_description` +
        `&limit=1`
    );
    const destination = Array.isArray(destinations) ? destinations[0] : null;
    if (!destination) {
      return jsonResponse(404, { success: false, error: "Destination not found" }, "public, max-age=60");
    }

    const research = await loadPublishedResearch(destination);
    if (!research) {
      return jsonResponse(
        404,
        { success: false, error: "Published destination research is not available yet" },
        "public, max-age=60"
      );
    }

    const ports = await supabaseGet(
      `destination_ports?destination_id=eq.${encodeURIComponent(destination.id)}` +
        `&active=eq.true` +
        `&select=id,destination_id,name,slug,short_description,hero_media_id,research_content_id,display_order,active` +
        `&order=display_order.asc`
    );

    const mediaIds = [
      destination.hero_media_id,
      research.media_id,
      ...(Array.isArray(ports) ? ports.map((p) => p.hero_media_id) : [])
    ];
    const mediaMap = await loadMediaMap(mediaIds);
    const heroMedia =
      mediaMap.get(destination.hero_media_id) || mediaMap.get(research.media_id) || null;

    const today = new Date().toISOString().slice(0, 10);
    let cruiseRows = [];
    try {
      cruiseRows = await supabaseGet(
        `discovered_cruises?destination_id=eq.${encodeURIComponent(destination.id)}` +
          `&status=eq.active` +
          `&or=(departure_date.is.null,departure_date.gte.${today})` +
          `&select=id,cruise_line_id,ship_id,destination_id,departure_date,return_date,nights,departure_port,itinerary,brochure_fare,currency,brochure_fare_display,official_url` +
          `&order=departure_date.asc.nullslast&limit=200`
      );
    } catch (cruiseError) {
      console.warn("destination cruises load skipped", cruiseError.message || cruiseError);
      cruiseRows = [];
    }

    const lineIds = [...new Set((cruiseRows || []).map((r) => r.cruise_line_id).filter(Boolean))];
    const shipIds = [...new Set((cruiseRows || []).map((r) => r.ship_id).filter(Boolean))];
    const lineNames = new Map();
    const shipNames = new Map();
    if (lineIds.length) {
      const lines = await supabaseGet(
        `ci_cruise_lines?id=in.(${lineIds.join(",")})&select=id,name`
      );
      for (const row of lines || []) lineNames.set(row.id, row.name);
    }
    if (shipIds.length) {
      const ships = await supabaseGet(
        `ci_cruise_ships?id=in.(${shipIds.join(",")})&select=id,name`
      );
      for (const row of ships || []) shipNames.set(row.id, row.name);
    }

    const cruiseCatalog = buildCruiseCatalog(cruiseRows || [], { lineNames, shipNames });

    const page = buildDestinationPageDto({
      destination,
      research,
      heroMedia,
      ports: Array.isArray(ports) ? ports : [],
      portMediaById: mediaMap,
      cruiseCatalog
    });

    page.cruiseLines = await enrichCruiseLineLogos(page.cruiseLines);
    page.heroResolved = Boolean(mediaDto(heroMedia));
    page.sections.cruiseLines = Array.isArray(page.cruiseLines) && page.cruiseLines.length > 0;
    page.sections.cruises = cruiseCatalog.totalCount > 0;

    return jsonResponse(200, {
      success: true,
      destination: page
    });
  } catch (error) {
    console.error("public-destination error", error);
    return jsonResponse(
      error.statusCode && error.statusCode < 500 ? error.statusCode : 500,
      { success: false, error: error.message || "Unable to load destination" },
      "no-store"
    );
  }
};
