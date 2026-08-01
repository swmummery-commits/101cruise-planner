/**
 * Admin load class facilities templates for a cruise line.
 *
 * GET /.netlify/functions/ci-ship-class-facilities-templates?cruise_line_id=
 */
const { requireAdmin } = require("./admin-auth");
const {
  jsonResponse,
  fetchTemplatesForLine
} = require("./lib/ci-ship-class-facilities-shared");

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, "GET, OPTIONS");
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { success: false, error: "METHOD_NOT_ALLOWED" }, "GET, OPTIONS");
  }

  try {
    await requireAdmin(event);
  } catch (error) {
    return jsonResponse(error.statusCode || 401, {
      success: false,
      error: error.code || "UNAUTHORIZED",
      detail: error.message
    }, "GET, OPTIONS");
  }

  const params = event.queryStringParameters || {};
  const cruiseLineId = String(params.cruise_line_id || "").trim();
  if (!cruiseLineId) {
    return jsonResponse(400, { success: false, error: "MISSING_CRUISE_LINE" }, "GET, OPTIONS");
  }

  try {
    const templates = await fetchTemplatesForLine(cruiseLineId);
    return jsonResponse(200, {
      success: true,
      cruise_line_id: cruiseLineId,
      templates: Array.isArray(templates) ? templates : []
    }, "GET, OPTIONS");
  } catch (error) {
    return jsonResponse(error.status || 500, {
      success: false,
      error: "LOAD_FAILED",
      detail: String(error.message || error)
    }, "GET, OPTIONS");
  }
};
