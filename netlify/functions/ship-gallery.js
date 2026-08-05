/**
 * Public ship gallery images for Client Portal dashboard.
 *
 * GET/POST /.netlify/functions/ship-gallery?ship=<name>&cruise_line=<line>
 * Optional Bearer customer session; public query by ship + cruise line is supported.
 */

const crypto = require("crypto");
const {
  normaliseText,
  resolveCruiseShip,
  filterSupabaseByLine,
  resolveCruiseLineAlias
} = require("./lib/resolve-cruise-ship");
const { filterShipGalleryMedia } = require("./lib/ship-gallery-media");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300"
    },
    body: JSON.stringify(body)
  };
}

function verifyToken(token, secret) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature || !secret) return null;
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server access is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

async function rest(path) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
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
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error((data && data.message) || `Supabase HTTP ${response.status}`);
  }
  return data;
}

function mapSupabaseShip(row) {
  const line = row.ci_cruise_lines || {};
  return {
    id: row.id,
    name: row.name,
    cruise_line_id: row.cruise_line_id,
    cruise_line_name: line.name || null,
    hero_image_url: row.hero_image_url || null
  };
}

async function listSupabaseShips() {
  const pageSize = 200;
  let offset = 0;
  const all = [];

  while (offset < 5000) {
    const path =
      `ci_cruise_ships?select=id,name,cruise_line_id,hero_image_url,ci_cruise_lines(id,name)&active=eq.true&order=name.asc&limit=${pageSize}&offset=${offset}`;
    const rows = await rest(path);
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) break;
    all.push(...list.map(mapSupabaseShip));
    if (list.length < pageSize) break;
    offset += pageSize;
  }

  return all;
}

async function listShipAliases() {
  try {
    const rows = await rest(
      "cruise_ship_aliases?select=ship_id,cruise_line_id,raw_alias,normalised_alias,active&or=(active.is.null,active.eq.true)&limit=5000"
    );
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function loadShipMedia(shipId) {
  const rows = await rest(
    `media_library?select=id,title,alt_text,public_url,media_type,ship_id,cruise_line_id,tags,is_default,is_active&ship_id=eq.${encodeURIComponent(
      shipId
    )}&is_active=eq.true&public_url=not.is.null&media_type=in.(ship,general)&order=is_default.asc,title.asc&limit=50`
  );
  return Array.isArray(rows) ? rows : [];
}

function readQuery(event) {
  const params = event.queryStringParameters || {};
  const body =
    event.body && (event.httpMethod === "POST" || event.httpMethod === "PUT")
      ? (() => {
          try {
            return JSON.parse(event.body);
          } catch {
            return {};
          }
        })()
      : {};

  return {
    ship: String(params.ship || params.name || params.ship_name || body.ship || "").trim(),
    shipId: String(params.ship_id || params.shipId || body.ship_id || body.shipId || "").trim(),
    cruiseLine: String(
      params.cruise_line || params.cruiseLine || body.cruise_line || body.cruiseLine || ""
    ).trim(),
    heroUrl: String(params.hero_url || params.heroUrl || body.hero_url || body.heroUrl || "").trim()
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {});
  }

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const secret = process.env.CUSTOMER_SESSION_SECRET || "";
    const auth = String(event.headers?.authorization || event.headers?.Authorization || "");
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const session = bearer ? verifyToken(bearer, secret) : null;

    const { ship, shipId, cruiseLine: cruiseLineRaw, heroUrl } = readQuery(event);
    const cruiseLine = resolveCruiseLineAlias(cruiseLineRaw) || cruiseLineRaw;

    if (!ship && !shipId) {
      return jsonResponse(400, {
        success: false,
        error: "SHIP_NAME_OR_ID_REQUIRED"
      });
    }

    let matchedShip = null;

    if (shipId) {
      const [supabaseShips, aliases] = await Promise.all([listSupabaseShips(), listShipAliases()]);
      const scoped = filterSupabaseByLine(supabaseShips, cruiseLine);
      matchedShip = (scoped.length ? scoped : supabaseShips).find((row) => String(row.id) === String(shipId)) || null;
      if (!matchedShip) {
        const rows = await rest(
          `ci_cruise_ships?select=id,name,cruise_line_id,hero_image_url,ci_cruise_lines(id,name)&id=eq.${encodeURIComponent(
            shipId
          )}&limit=1`
        );
        const row = Array.isArray(rows) ? rows[0] : null;
        if (row) matchedShip = mapSupabaseShip(row);
      }
    }

    if (!matchedShip && !ship) {
      return jsonResponse(200, {
        success: true,
        images: [],
        ship: null,
        reason: "ship_not_found",
        session: session ? { booking_reference: session.booking_reference || null } : null
      });
    }

    if (!matchedShip) {
      const [supabaseShips, aliases] = await Promise.all([
        listSupabaseShips(),
        listShipAliases()
      ]);

      const scoped = filterSupabaseByLine(supabaseShips, cruiseLine);
      const resolution = resolveCruiseShip(
        scoped.length ? scoped : supabaseShips,
        ship,
        cruiseLine,
        aliases
      );

      if (!resolution || resolution.status === "not_found") {
        return jsonResponse(200, {
          success: true,
          images: [],
          ship: null,
          reason: "ship_not_found",
          session: session ? { booking_reference: session.booking_reference || null } : null
        });
      }

      if (resolution.status === "ambiguous") {
        return jsonResponse(200, {
          success: true,
          images: [],
          ship: null,
          reason: "ship_ambiguous",
          session: session ? { booking_reference: session.booking_reference || null } : null
        });
      }

      matchedShip = resolution.ship;
    }

    const mediaRows = await loadShipMedia(matchedShip.id);
    const excludeHero = heroUrl || matchedShip.hero_image_url || null;
    const images = filterShipGalleryMedia(mediaRows, {
      heroUrl: excludeHero,
      limit: 8
    });

    return jsonResponse(200, {
      success: true,
      images,
      ship: {
        id: matchedShip.id,
        name: matchedShip.name
      },
      session: session ? { booking_reference: session.booking_reference || null } : null
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ship_gallery_error",
        message: String(error?.message || error).slice(0, 240)
      })
    );
    return jsonResponse(500, {
      success: false,
      error: "SERVER_ERROR"
    });
  }
};

exports.filterShipGalleryMedia = filterShipGalleryMedia;
