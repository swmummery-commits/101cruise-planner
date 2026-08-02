/**
 * Production read-only ship lookup for the My Ship page.
 *
 * GET /.netlify/functions/get-ship?name=<ship name>&cruise_line=<cruise line>
 *
 * Lookup order:
 *   1. Supabase Cruise Intelligence (ci_cruise_ships)
 *   2. Base44 Finder fallback (temporary)
 *
 * Strict ordered matching (case-insensitive, whitespace-normalised), with:
 *   - deliberate cruise-line aliases (e.g. Explora Cruises → Explora Journeys)
 *   - terminal Roman ↔ Arabic numeral variants (Explora 1 ↔ EXPLORA I)
 *   - cruise_ship_aliases rows
 *
 * Multiple candidates at any step → SHIP_AMBIGUOUS (never pick one).
 */

const {
  normaliseText,
  resolveCruiseShip,
  filterSupabaseByLine,
  resolveCruiseLineAlias
} = require('./lib/resolve-cruise-ship');

const SHIP_FIELDS = [
  'id',
  'name',
  'cruise_line_id',
  'passenger_capacity',
  'crew_count',
  'deck_count',
  'stateroom_count',
  'stateroom_types',
  'stateroom_breakdown',
  'length_meters',
  'gross_tonnage',
  'beam_metres',
  'cruising_speed_knots',
  'year_built',
  'year_refurbished',
  'facilities',
  'current_status',
  'last_updated',
  'updated_date'
];

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function getHttpStatus(error) {
  return (
    error?.response?.status ||
    error?.status ||
    error?.statusCode ||
    null
  );
}

function safeErrorMessage(error) {
  const raw = String(error?.message || 'Unexpected Base44 request failure');
  return raw
    .replace(/api[_-]?key[=:\s][^\s,;]+/gi, 'api_key=[redacted]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, 240);
}

function pickShipFields(record) {
  const ship = {};
  SHIP_FIELDS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      ship[key] = record[key];
    } else {
      ship[key] = null;
    }
  });
  return ship;
}

function dedupeShips(rows) {
  const seen = new Set();
  const result = [];
  rows.forEach((row) => {
    const key = row?.id || `name:${normaliseText(row?.name)}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(row);
  });
  return result;
}

function resolveUniqueCandidates(candidates) {
  const unique = dedupeShips(candidates);
  if (unique.length === 0) return null;
  if (unique.length === 1) return { status: 'matched', ship: unique[0] };
  return { status: 'ambiguous' };
}

function mapSupabaseShip(row) {
  const line = row.ci_cruise_lines || {};
  const deckStatus = row.deck_plan_status || null;
  const deckUrl =
    deckStatus === 'approved'
      ? String(row.deck_plan_url || row.deck_plan_pdf_url || row.deck_plan_page_url || '').trim() || null
      : null;
  return {
    id: row.id,
    name: row.name,
    cruise_line_id: row.cruise_line_id,
    cruise_line_name: line.name || null,
    cruise_line_logo_url: line.logo_url || null,
    legacy_base44_id: row.legacy_base44_id || null,
    passenger_capacity: row.passenger_capacity,
    crew_count: row.crew_count,
    deck_count: row.deck_count,
    stateroom_count: row.stateroom_count,
    stateroom_types: row.cabin_type_summary,
    stateroom_breakdown: row.stateroom_breakdown,
    length_meters: row.length_metres,
    gross_tonnage: row.gross_tonnage,
    beam_metres: row.beam_metres ?? null,
    cruising_speed_knots: row.cruising_speed_knots ?? null,
    year_built: row.year_built,
    year_refurbished: row.year_refurbished,
    facilities: row.facilities,
    hero_image_url: row.hero_image_url,
    current_status: row.status,
    last_updated: row.updated_at || null,
    updated_date: row.updated_at || null,
    slug: row.slug,
    // Public safety: only expose approved URL — never status/candidates/notes
    deck_plan_url: deckUrl
  };
}

/** Columns safe before optional beam/speed migration is applied on production. */
const SUPABASE_SHIP_SELECT =
  'id,name,slug,status,cruise_line_id,legacy_base44_id,passenger_capacity,crew_count,deck_count,stateroom_count,cabin_type_summary,stateroom_breakdown,length_metres,gross_tonnage,year_built,year_refurbished,facilities,hero_image_url,deck_plan_url,deck_plan_page_url,deck_plan_pdf_url,deck_plan_status,updated_at,ci_cruise_lines(id,name,slug,logo_url)';

function formatSupabaseShipResponse(mappedShip) {
  const ship = pickShipFields(mappedShip);
  if (mappedShip.cruise_line_name) {
    ship.cruise_line_name = mappedShip.cruise_line_name;
  }
  ship.deck_plan_url = mappedShip.deck_plan_url || null;
  if (mappedShip.hero_image_url) {
    ship.hero_image_url = mappedShip.hero_image_url;
  }
  if (mappedShip.cruise_line_logo_url) {
    ship.cruise_line_logo_url = mappedShip.cruise_line_logo_url;
  }
  return ship;
}

function findCiShipByLegacyBase44Id(supabaseShips, base44ShipId) {
  if (!base44ShipId || !Array.isArray(supabaseShips)) return null;
  const needle = String(base44ShipId);
  return supabaseShips.find(function (row) {
    return String(row.legacy_base44_id || '') === needle;
  }) || null;
}

async function listSupabaseShips() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const pageSize = 200;
  let offset = 0;
  const all = [];

  while (offset < 5000) {
    const path =
      `ci_cruise_ships?select=${SUPABASE_SHIP_SELECT}&active=eq.true&order=name.asc&limit=${pageSize}&offset=${offset}`;
    const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
      method: 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
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
    const list = Array.isArray(data) ? data : [];
    if (!list.length) break;
    all.push(...list.map(mapSupabaseShip));
    if (list.length < pageSize) break;
    offset += pageSize;
  }

  return all;
}

async function listShipAliases() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [];

  try {
    const response = await fetch(
      `${url.replace(/\/$/, '')}/rest/v1/cruise_ship_aliases?select=ship_id,cruise_line_id,raw_alias,normalised_alias,active&or=(active.is.null,active.eq.true)&limit=5000`,
      {
        method: 'GET',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: 'application/json'
        }
      }
    );
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_error) {
      data = null;
    }
    if (!response.ok) return [];
    return Array.isArray(data) ? data : [];
  } catch (_error) {
    return [];
  }
}

async function listCruiseShips(base44) {
  const pageSize = 100;
  let skip = 0;
  const all = [];

  while (skip < 2000) {
    const page = await base44.entities.CruiseShip.list('name', pageSize, skip);
    const list = Array.isArray(page) ? page : [];
    if (list.length === 0) break;
    all.push(...list);
    if (list.length < pageSize) break;
    skip += pageSize;
  }

  return all;
}

async function lookupBase44(shipName, cruiseLine) {
  const appId = process.env.BASE44_FINDER_APP_ID;
  const apiKey = process.env.BASE44_FINDER_API_KEY;

  if (!appId || !apiKey) {
    return { status: 'config_missing' };
  }

  const { createClient } = await import('@base44/sdk');
  const base44 = createClient({
    appId,
    headers: {
      api_key: apiKey
    }
  });

  const ships = await listCruiseShips(base44);
  return resolveCruiseShip(ships, shipName, cruiseLine, []);
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, {});
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, {
      success: false,
      error: 'METHOD_NOT_ALLOWED'
    });
  }

  const shipName = String(
    event.queryStringParameters?.name ||
      event.queryStringParameters?.ship_name ||
      ''
  ).trim();

  const cruiseLineRaw = String(
    event.queryStringParameters?.cruise_line ||
      event.queryStringParameters?.cruiseLine ||
      ''
  ).trim();
  const cruiseLine = resolveCruiseLineAlias(cruiseLineRaw) || cruiseLineRaw;

  if (!shipName) {
    return jsonResponse(400, {
      success: false,
      error: 'SHIP_NAME_REQUIRED'
    });
  }

  console.log(
    JSON.stringify({
      event: 'ship_lookup_started',
      has_line: Boolean(cruiseLine),
      line_alias_applied: Boolean(cruiseLineRaw) && normaliseText(cruiseLineRaw) !== normaliseText(cruiseLine)
    })
  );

  let loadedSupabaseShips = null;

  try {
    let supabaseShips = null;
    let aliases = [];
    try {
      [supabaseShips, aliases] = await Promise.all([
        listSupabaseShips(),
        listShipAliases()
      ]);
      loadedSupabaseShips = supabaseShips;
    } catch (supabaseLoadError) {
      console.error(
        JSON.stringify({
          event: 'ship_lookup_supabase_load_failed',
          message: safeErrorMessage(supabaseLoadError)
        })
      );
      supabaseShips = null;
      aliases = [];
    }

    if (Array.isArray(supabaseShips) && supabaseShips.length) {
      const scoped = filterSupabaseByLine(supabaseShips, cruiseLine);
      const resolution = resolveCruiseShip(
        scoped.length ? scoped : supabaseShips,
        shipName,
        cruiseLine,
        aliases
      );

      if (resolution.status === 'ambiguous') {
        console.warn(
          JSON.stringify({ event: 'ship_lookup_ambiguous', source: 'supabase' })
        );
        return jsonResponse(409, {
          success: false,
          error: 'SHIP_AMBIGUOUS',
          source: 'supabase'
        });
      }

      if (resolution.status === 'matched' && resolution.ship) {
        const ship = formatSupabaseShipResponse(resolution.ship);
        console.log(
          JSON.stringify({
            event: 'ship_lookup_matched',
            source: 'supabase',
            has_deck_plan: Boolean(ship.deck_plan_url)
          })
        );
        return jsonResponse(200, {
          success: true,
          source: 'supabase',
          ship
        });
      }

      console.log(
        JSON.stringify({
          event: 'ship_lookup_supabase_miss',
          falling_back: 'base44'
        })
      );
    } else if (supabaseShips === null) {
      console.log(
        JSON.stringify({
          event: 'ship_lookup_supabase_unconfigured',
          falling_back: 'base44'
        })
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'ship_lookup_supabase_error',
        message: safeErrorMessage(error),
        falling_back: 'base44'
      })
    );
  }

  try {
    const resolution = await lookupBase44(shipName, cruiseLine);

    if (resolution.status === 'config_missing') {
      console.error('Base44 Finder configuration missing');
      return jsonResponse(500, {
        success: false,
        error: 'BASE44_CONFIGURATION_MISSING'
      });
    }

    if (resolution.status === 'ambiguous') {
      console.warn(
        JSON.stringify({ event: 'ship_lookup_ambiguous', source: 'base44' })
      );
      return jsonResponse(409, {
        success: false,
        error: 'SHIP_AMBIGUOUS',
        source: 'base44'
      });
    }

    if (resolution.status !== 'matched' || !resolution.ship) {
      console.warn(
        JSON.stringify({ event: 'ship_lookup_not_found', source: 'base44' })
      );
      return jsonResponse(404, {
        success: false,
        error: 'SHIP_NOT_FOUND'
      });
    }

    const ciPreferred = findCiShipByLegacyBase44Id(
      loadedSupabaseShips,
      resolution.ship.id
    );
    if (ciPreferred) {
      const ship = formatSupabaseShipResponse(ciPreferred);
      console.log(
        JSON.stringify({
          event: 'ship_lookup_matched',
          source: 'supabase',
          matched_via: 'legacy_base44_id',
          has_deck_plan: Boolean(ship.deck_plan_url)
        })
      );
      return jsonResponse(200, {
        success: true,
        source: 'supabase',
        ship
      });
    }

    const ship = pickShipFields(resolution.ship);
    console.log(
      JSON.stringify({ event: 'ship_lookup_matched', source: 'base44_fallback' })
    );

    return jsonResponse(200, {
      success: true,
      source: 'base44',
      ship
    });
  } catch (error) {
    const status = getHttpStatus(error);

    if (status === 401 || status === 403) {
      console.error('Base44 authentication failed');
      return jsonResponse(status, {
        success: false,
        error: 'BASE44_AUTHENTICATION_FAILED'
      });
    }

    console.error('Base44 ship lookup failed:', safeErrorMessage(error));
    return jsonResponse(status && status >= 400 ? status : 500, {
      success: false,
      error: 'BASE44_REQUEST_FAILED'
    });
  }
};

module.exports.__test = {
  findCiShipByLegacyBase44Id,
  formatSupabaseShipResponse,
  SUPABASE_SHIP_SELECT
};
