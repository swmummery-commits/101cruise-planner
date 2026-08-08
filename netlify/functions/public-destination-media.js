/**
 * Public read-only destination media from Media Library.
 *
 * GET /.netlify/functions/public-destination-media?slug=caribbean&name=Caribbean
 *
 * Returns active destination + port media with explicit destination association.
 * Read-only — no writes.
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
      "Cache-Control": "public, max-age=120, stale-while-revalidate=600"
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
    const slug = cleanQuery(event.queryStringParameters?.slug);
    const name = cleanQuery(event.queryStringParameters?.name);
    const destinationName = name || slug;
    if (!destinationName) {
      return jsonResponse(400, {
        success: false,
        error: "MISSING_DESTINATION",
        message: "Provide slug or name."
      });
    }

    const select =
      "id,title,alt_text,public_url,media_type,destination_name,port_name,is_default,is_active,created_at";
    const encodedName = encodeURIComponent(destinationName);

    const destinationMedia = await supabaseGet(
      `media_library?media_type=eq.destination&is_active=eq.true&destination_name=eq.${encodedName}` +
        `&select=${select}&order=is_default.desc,created_at.asc`
    );

    const portMedia = await supabaseGet(
      `media_library?media_type=eq.port&is_active=eq.true&destination_name=eq.${encodedName}` +
        `&select=${select}&order=created_at.asc`
    );

    return jsonResponse(200, {
      success: true,
      slug: slug || null,
      destination_name: destinationName,
      destination_media: Array.isArray(destinationMedia) ? destinationMedia : [],
      port_media: Array.isArray(portMedia) ? portMedia : []
    });
  } catch (error) {
    console.error("public-destination-media", String(error.message || error).slice(0, 160));
    return jsonResponse(500, {
      success: false,
      error: "DESTINATION_MEDIA_LOOKUP_FAILED",
      message: "Destination media could not be loaded."
    });
  }
};
