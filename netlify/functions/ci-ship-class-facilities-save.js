/**
 * Admin save class facilities template (does not modify ships).
 *
 * POST /.netlify/functions/ci-ship-class-facilities-save
 */
const { requireAdmin } = require("./admin-auth");
const {
  ClassTpl,
  supabase,
  jsonResponse,
  fetchTemplateForClass
} = require("./lib/ci-ship-class-facilities-shared");

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, "POST, OPTIONS");
  }
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "METHOD_NOT_ALLOWED" }, "POST, OPTIONS");
  }

  try {
    await requireAdmin(event);
  } catch (error) {
    return jsonResponse(error.statusCode || 401, {
      success: false,
      error: error.code || "UNAUTHORIZED",
      detail: error.message
    }, "POST, OPTIONS");
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_error) {
    return jsonResponse(400, { success: false, error: "INVALID_JSON" }, "POST, OPTIONS");
  }

  const cruiseLineId = String(body.cruise_line_id || "").trim();
  const className = String(body.class_name || "").trim();
  const upsert = ClassTpl.buildUpsertRecord({
    cruiseLineId: cruiseLineId,
    className: className,
    exclusiveAreas: body.exclusive_areas,
    specialtyFeatures: body.specialty_features
  });
  if (!upsert.ok) {
    return jsonResponse(400, { success: false, error: upsert.error }, "POST, OPTIONS");
  }

  try {
    const existing = await fetchTemplateForClass(cruiseLineId, className);
    let saved;
    if (existing && existing.id) {
      saved = await supabase("ci_ship_class_facility_templates?id=eq." + encodeURIComponent(existing.id), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(upsert.record)
      });
    } else {
      saved = await supabase("ci_ship_class_facility_templates", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(upsert.record)
      });
    }
    const row = Array.isArray(saved) ? saved[0] : saved;
    return jsonResponse(200, {
      success: true,
      template: row
    }, "POST, OPTIONS");
  } catch (error) {
    return jsonResponse(error.status || 500, {
      success: false,
      error: "SAVE_FAILED",
      detail: String(error.message || error)
    }, "POST, OPTIONS");
  }
};
