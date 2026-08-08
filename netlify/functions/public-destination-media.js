/**
 * Public read-only destination media from Media Library.
 *
 * GET /.netlify/functions/public-destination-media?slug=caribbean&name=Caribbean
 * Optional: &ports=Barcelona|Rome%20(Civitavecchia)|Santorini
 *
 * Returns active destination + port media with explicit destination association,
 * plus optional ports-catalogue hero images for named ports.
 * Read-only — no writes.
 */

const { resolveCatalogueMediaIds } = require("./lib/port-image-finder/resolve-public");
const { normaliseEntityKey } = require("./lib/research-normalize");

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

function parsePortNames(raw) {
  return String(raw || "")
    .split("|")
    .map((part) => decodeURIComponent(part).trim())
    .filter(Boolean)
    .slice(0, 24);
}

async function loadMediaMap(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;

  const rows = await supabaseGet(
    `media_library?id=in.(${unique.join(",")})&is_active=eq.true` +
      `&select=id,title,alt_text,public_url,media_type,source_url`
  );
  for (const row of rows || []) {
    if (row?.id) map.set(row.id, row);
  }
  return map;
}

async function resolveCataloguePortMedia(portNames) {
  const names = [...new Set((portNames || []).map((n) => String(n || "").trim()).filter(Boolean))];
  if (!names.length) return [];

  const mediaIdByName = await resolveCatalogueMediaIds(supabaseGet, names);
  const mediaMap = await loadMediaMap([...mediaIdByName.values()]);
  const out = [];

  for (const name of names) {
    const mediaId = mediaIdByName.get(normaliseEntityKey(name));
    const media = mediaId ? mediaMap.get(mediaId) : null;
    if (!media?.public_url) continue;
    out.push({
      id: media.id,
      title: media.title || name,
      alt_text: media.alt_text || `${name} port`,
      public_url: media.public_url,
      media_type: "port",
      port_name: name,
      resolved_via: "ports_catalogue",
      is_active: true
    });
  }

  return out;
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

    const requestedPorts = parsePortNames(event.queryStringParameters?.ports);
    const cataloguePortMedia = requestedPorts.length
      ? await resolveCataloguePortMedia(requestedPorts)
      : [];

    return jsonResponse(200, {
      success: true,
      slug: slug || null,
      destination_name: destinationName,
      destination_media: Array.isArray(destinationMedia) ? destinationMedia : [],
      port_media: Array.isArray(portMedia) ? portMedia : [],
      catalogue_port_media: cataloguePortMedia
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
