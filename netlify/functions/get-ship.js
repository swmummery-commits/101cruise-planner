/**
 * Production read-only ship lookup for The Ship page.
 *
 * GET /.netlify/functions/get-ship?name=<ship name>
 *
 * Uses Finder credentials only:
 *   BASE44_FINDER_APP_ID
 *   BASE44_FINDER_API_KEY
 *
 * Matching: case-insensitive, whitespace-normalised, exact after normalisation.
 * Never returns a different ship as a fallback.
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

function normaliseShipName(value) {
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

async function findCruiseShipByName(base44, shipName) {
  const target = normaliseShipName(shipName);
  if (!target) return null;

  // Prefer an exact filter first (when Base44 stores the same casing).
  try {
    const filtered = await base44.entities.CruiseShip.filter({ name: shipName }, 'name', 25, 0);
    const filteredList = Array.isArray(filtered) ? filtered : [];
    const filteredMatch = filteredList.find(
      (row) => normaliseShipName(row?.name) === target
    );
    if (filteredMatch) return filteredMatch;
  } catch (error) {
    // Fall through to paginated list matching — filter may be unavailable or strict.
    console.warn('CruiseShip filter lookup unavailable; falling back to list match');
  }

  const pageSize = 100;
  let skip = 0;

  while (skip < 2000) {
    const page = await base44.entities.CruiseShip.list('name', pageSize, skip);
    const list = Array.isArray(page) ? page : [];
    if (list.length === 0) break;

    const match = list.find((row) => normaliseShipName(row?.name) === target);
    if (match) return match;

    if (list.length < pageSize) break;
    skip += pageSize;
  }

  return null;
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

    const record = await findCruiseShipByName(base44, shipName);

    if (!record) {
      console.warn('CruiseShip not found for requested name');
      return jsonResponse(404, {
        success: false,
        error: 'SHIP_NOT_FOUND'
      });
    }

    const ship = pickShipFields(record);
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
