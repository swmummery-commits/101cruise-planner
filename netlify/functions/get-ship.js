/**
 * Production read-only ship lookup for The Ship page.
 *
 * GET /.netlify/functions/get-ship?name=<ship name>&cruise_line=<cruise line>
 *
 * Lookup order:
 *   1. Supabase Cruise Intelligence (ci_cruise_ships)
 *   2. Base44 Finder fallback (temporary)
 *
 * Strict ordered matching (case-insensitive, whitespace-normalised):
 *   1. Exact ship-name match
 *   2. Exact composed match: cruise_line + " " + ship name
 *   3. Unique line-aware suffix match
 *
 * Multiple candidates at any step → SHIP_AMBIGUOUS (never pick one).
 */

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

function normaliseText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
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

function linePrefixCompatible(shipPrefix, cruiseLine) {
  const prefix = normaliseText(shipPrefix);
  const line = normaliseText(cruiseLine);
  if (!prefix || !line) return false;
  if (prefix === line) return true;
  if (line.startsWith(`${prefix} `)) return true;
  if (prefix.startsWith(`${line} `)) return true;
  return false;
}

function resolveCruiseShip(ships, shipName, cruiseLine) {
  const target = normaliseText(shipName);
  const line = normaliseText(cruiseLine);

  if (!target) return { status: 'not_found' };

  const exact = ships.filter((row) => normaliseText(row?.name) === target);
  const step1 = resolveUniqueCandidates(exact);
  if (step1) return step1;

  if (line) {
    const composed = `${line} ${target}`;
    const composedMatches = ships.filter(
      (row) => normaliseText(row?.name) === composed
    );
    const step2 = resolveUniqueCandidates(composedMatches);
    if (step2) return step2;
  }

  if (line) {
    const suffix = ` ${target}`;
    const suffixMatches = ships.filter((row) => {
      const name = normaliseText(row?.name);
      if (!name.endsWith(suffix)) return false;
      if (name === target) return false;
      const prefix = name.slice(0, name.length - suffix.length);
      return linePrefixCompatible(prefix, line);
    });
    const step3 = resolveUniqueCandidates(suffixMatches);
    if (step3) return step3;
  }

  return { status: 'not_found' };
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
    passenger_capacity: row.passenger_capacity,
    crew_count: row.crew_count,
    deck_count: row.deck_count,
    stateroom_count: row.stateroom_count,
    stateroom_types: row.cabin_type_summary,
    stateroom_breakdown: row.stateroom_breakdown,
    length_meters: row.length_metres,
    gross_tonnage: row.gross_tonnage,
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

async function listSupabaseShips() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const pageSize = 200;
  let offset = 0;
  const all = [];

  while (offset < 5000) {
    const path =
      `ci_cruise_ships?select=id,name,slug,status,cruise_line_id,passenger_capacity,crew_count,deck_count,stateroom_count,cabin_type_summary,stateroom_breakdown,length_metres,gross_tonnage,year_built,year_refurbished,facilities,hero_image_url,deck_plan_url,deck_plan_page_url,deck_plan_pdf_url,deck_plan_status,updated_at,ci_cruise_lines(id,name,slug)&active=eq.true&order=name.asc&limit=${pageSize}&offset=${offset}`;
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

function filterSupabaseByLine(ships, cruiseLine) {
  const line = normaliseText(cruiseLine);
  if (!line) return ships;
  return ships.filter((row) => {
    const name = normaliseText(row.cruise_line_name);
    if (!name) return true;
    return (
      name === line ||
      name.includes(line) ||
      line.includes(name) ||
      linePrefixCompatible(name, line)
    );
  });
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
  return resolveCruiseShip(ships, shipName, cruiseLine);
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

  const cruiseLine = String(
    event.queryStringParameters?.cruise_line ||
      event.queryStringParameters?.cruiseLine ||
      ''
  ).trim();

  if (!shipName) {
    return jsonResponse(400, {
      success: false,
      error: 'SHIP_NAME_REQUIRED'
    });
  }

  console.log(
    JSON.stringify({
      event: 'ship_lookup_started',
      has_line: Boolean(cruiseLine)
    })
  );

  try {
    const supabaseShips = await listSupabaseShips();
    if (Array.isArray(supabaseShips) && supabaseShips.length) {
      const scoped = filterSupabaseByLine(supabaseShips, cruiseLine);
      const resolution = resolveCruiseShip(scoped.length ? scoped : supabaseShips, shipName, cruiseLine);

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
        const ship = pickShipFields(resolution.ship);
        if (resolution.ship.cruise_line_name) {
          ship.cruise_line_name = resolution.ship.cruise_line_name;
        }
        console.log(
          JSON.stringify({ event: 'ship_lookup_matched', source: 'supabase' })
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
