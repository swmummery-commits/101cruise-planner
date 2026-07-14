/**
 * Production read-only ship lookup for The Ship page.
 *
 * GET /.netlify/functions/get-ship?name=<ship name>&cruise_line=<cruise line>
 *
 * Uses Finder credentials only:
 *   BASE44_FINDER_APP_ID
 *   BASE44_FINDER_API_KEY
 *
 * Strict ordered matching (case-insensitive, whitespace-normalised):
 *   1. Exact ship-name match
 *   2. Exact composed match: cruise_line + " " + ship name
 *   3. Unique line-aware suffix match
 *
 * Multiple candidates at any step → SHIP_AMBIGUOUS (never pick one).
 * No fuzzy / contains / edit-distance / first-result fallback.
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

/**
 * Prefix of a Base44 ship name is compatible with the booking cruise line when:
 * - they are equal after normalisation, or
 * - one is a whole-token extension of the other
 *   (e.g. "celebrity" ↔ "celebrity cruises")
 */
function linePrefixCompatible(shipPrefix, cruiseLine) {
  const prefix = normaliseText(shipPrefix);
  const line = normaliseText(cruiseLine);
  if (!prefix || !line) return false;
  if (prefix === line) return true;
  if (line.startsWith(`${prefix} `)) return true;
  if (prefix.startsWith(`${line} `)) return true;
  return false;
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

function resolveCruiseShip(ships, shipName, cruiseLine) {
  const target = normaliseText(shipName);
  const line = normaliseText(cruiseLine);

  if (!target) return { status: 'not_found' };

  // Step 1 — exact normalised ship-name match
  const exact = ships.filter((row) => normaliseText(row?.name) === target);
  const step1 = resolveUniqueCandidates(exact);
  if (step1) return step1;

  // Step 2 — exact composed match: cruise_line + " " + ship name
  if (line) {
    const composed = `${line} ${target}`;
    const composedMatches = ships.filter(
      (row) => normaliseText(row?.name) === composed
    );
    const step2 = resolveUniqueCandidates(composedMatches);
    if (step2) return step2;
  }

  // Step 3 — unique line-aware suffix match
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

  const appId = process.env.BASE44_FINDER_APP_ID;
  const apiKey = process.env.BASE44_FINDER_API_KEY;

  if (!appId || !apiKey) {
    console.error('Base44 Finder configuration missing');
    return jsonResponse(500, {
      success: false,
      error: 'BASE44_CONFIGURATION_MISSING'
    });
  }

  console.log('Base44 ship lookup started');

  try {
    const { createClient } = await import('@base44/sdk');

    const base44 = createClient({
      appId,
      headers: {
        api_key: apiKey
      }
    });

    const ships = await listCruiseShips(base44);
    const resolution = resolveCruiseShip(ships, shipName, cruiseLine);

    if (resolution.status === 'ambiguous') {
      console.warn('CruiseShip lookup ambiguous');
      return jsonResponse(409, {
        success: false,
        error: 'SHIP_AMBIGUOUS'
      });
    }

    if (resolution.status !== 'matched' || !resolution.ship) {
      console.warn('CruiseShip not found for requested name');
      return jsonResponse(404, {
        success: false,
        error: 'SHIP_NOT_FOUND'
      });
    }

    const ship = pickShipFields(resolution.ship);
    console.log('CruiseShip retrieved successfully');

    return jsonResponse(200, {
      success: true,
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
