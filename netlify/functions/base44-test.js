/**
 * Phase 1 connection test — DISABLED after Phase 2 get-ship launch.
 * Use GET /.netlify/functions/get-ship?name=<ship name> instead.
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

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, {});
  }

  return jsonResponse(410, {
    success: false,
    error: 'BASE44_TEST_DISABLED',
    message: 'Use /.netlify/functions/get-ship instead'
  });
};
