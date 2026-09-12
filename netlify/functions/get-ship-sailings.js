/**
 * Public upcoming sailings for a published Ship Spotlight.
 * GET /.netlify/functions/get-ship-sailings?slug=<ship-spotlight-slug>
 */
const {
  perthCalendarDate,
  publicBookingMinimumDepartureDate,
  isCruisePubliclyBookable
} = require("./lib/public-discovered-cruise-inventory");

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

function formatDateAu(value) {
  const iso = String(value || "").slice(0, 10);
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return iso;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function itineraryTitle(row, shipName) {
  const raw = row?.raw_extract && typeof row.raw_extract === "object" ? row.raw_extract : {};
  const title = String(raw.title || "").trim();
  if (title) return title;
  const itinerary = String(row?.itinerary || "").trim();
  if (itinerary && itinerary.length <= 110) return itinerary;
  const destination = String(row?.destinations?.name || "").trim();
  return destination ? `${shipName} · ${destination}` : `${shipName} sailing`;
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
      )}&publication_status=eq.published&active=eq.true&select=ship_id&limit=1`
    );
    const shipId = Array.isArray(spotlightRows) ? spotlightRows[0]?.ship_id : null;
    if (!shipId) return jsonResponse(404, { success: false, error: "SHIP_SPOTLIGHT_NOT_FOUND" });

    const shipRows = await supabaseGet(
      `ci_cruise_ships?id=eq.${encodeURIComponent(
        shipId
      )}&active=eq.true&select=id,name,ci_cruise_lines(name,active,sold_by_101cruise)&limit=1`
    );
    const ship = Array.isArray(shipRows) ? shipRows[0] : null;
    if (!ship || ship.ci_cruise_lines?.active !== true || ship.ci_cruise_lines?.sold_by_101cruise !== true) {
      return jsonResponse(404, { success: false, error: "SHIP_NOT_AVAILABLE" });
    }

    const perthToday = perthCalendarDate();
    const minimumDeparture = publicBookingMinimumDepartureDate(perthToday);
    const rows = await supabaseGet(
      `discovered_cruises?ship_id=eq.${encodeURIComponent(shipId)}` +
        `&status=eq.active` +
        `&departure_date=gte.${encodeURIComponent(minimumDeparture)}` +
        `&select=id,departure_date,return_date,nights,departure_port,itinerary,itinerary_ports,raw_extract,brochure_fare_display,currency,official_url,source_url,last_verified_at,destination_id,destinations(id,name,slug)` +
        `&order=departure_date.asc&limit=12`
    );

    const sailings = (rows || [])
      .filter((row) =>
        isCruisePubliclyBookable({
          departureDate: row.departure_date,
          status: "active",
          perthToday
        })
      )
      .map((row) => ({
        id: row.id,
        title: itineraryTitle(row, ship.name),
        departureDate: row.departure_date,
        departureDateLabel: formatDateAu(row.departure_date),
        returnDate: row.return_date || null,
        returnDateLabel: row.return_date ? formatDateAu(row.return_date) : null,
        nights: Number(row.nights) || null,
        departurePort: String(row.departure_port || "").trim() || null,
        destination: String(row.destinations?.name || "").trim() || null,
        destinationSlug: String(row.destinations?.slug || "").trim() || null,
        brochureFare: String(row.brochure_fare_display || "").trim() || null,
        currency: String(row.currency || "").trim() || null,
        officialUrl: String(row.official_url || row.source_url || "").trim() || null,
        verifiedAt: row.last_verified_at || null
      }));

    return jsonResponse(200, {
      success: true,
      ship: { id: ship.id, name: ship.name, cruiseLine: ship.ci_cruise_lines?.name || null },
      asOf: perthToday,
      minimumDeparture,
      sailings
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ship_spotlight_sailings_failed",
        message: String(error?.message || "unknown").slice(0, 220)
      })
    );
    return jsonResponse(500, { success: false, error: "SHIP_SAILINGS_LOAD_FAILED" });
  }
};
