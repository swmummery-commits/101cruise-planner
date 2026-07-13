/**
 * Phase 1 — read-only Base44 connection test.
 *
 * GET /.netlify/functions/base44-test
 *
 * Requires Netlify env vars (server-side only):
 *   BASE44_APP_ID
 *   BASE44_API_KEY
 *
 * Local testing (do not commit .env):
 *   1. Create a local .env with the two vars above
 *   2. netlify env:import .env   OR pass via Netlify Dev UI / netlify.toml [dev]
 *   3. netlify dev
 *   4. curl -s http://localhost:8888/.netlify/functions/base44-test
 *
 * Deployed:
 *   https://<your-site>/.netlify/functions/base44-test
 *
 * Read-only: lists one CruiseShip. No Supabase access. No writes.
 */

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
  // Never echo secrets if they somehow appear in an error string.
  return raw
    .replace(/api[_-]?key[=:\s][^\s,;]+/gi, 'api_key=[redacted]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, 240);
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

  console.log('Base44 connection test started');

  const appId = process.env.BASE44_APP_ID;
  const apiKey = process.env.BASE44_API_KEY;

  if (!appId || !apiKey) {
    console.error('Base44 configuration missing (BASE44_APP_ID and/or BASE44_API_KEY)');
    return jsonResponse(500, {
      success: false,
      error: 'BASE44_CONFIGURATION_MISSING'
    });
  }

  try {
    // Dynamic import: @base44/sdk is ESM-only.
    const { createClient } = await import('@base44/sdk');

    const base44 = createClient({
      appId,
      headers: {
        api_key: apiKey
      }
    });

    console.log('Base44 client initialised');

    const ships = await base44.entities.CruiseShip.list('name', 1, 0);
    const list = Array.isArray(ships) ? ships : [];

    if (list.length === 0) {
      console.warn('No CruiseShip records returned');
      return jsonResponse(404, {
        success: false,
        error: 'NO_CRUISE_SHIPS_FOUND'
      });
    }

    const ship = list[0];
    const fieldCount =
      ship && typeof ship === 'object' && !Array.isArray(ship)
        ? Object.keys(ship).length
        : 0;

    console.log('CruiseShip retrieved successfully');
    console.log('Number of fields returned:', fieldCount);

    return jsonResponse(200, {
      success: true,
      ship_count_returned: list.length,
      ship,
      field_count: fieldCount
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

    if (status === 404) {
      console.warn('CruiseShip entity or record not found');
      return jsonResponse(404, {
        success: false,
        error: 'NO_CRUISE_SHIPS_FOUND'
      });
    }

    console.error('Base44 request failed:', safeErrorMessage(error));
    return jsonResponse(status && status >= 400 ? status : 500, {
      success: false,
      error: 'BASE44_REQUEST_FAILED',
      message: safeErrorMessage(error)
    });
  }
};
