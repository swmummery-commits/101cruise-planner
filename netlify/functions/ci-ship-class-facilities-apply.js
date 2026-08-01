/**
 * Admin apply saved class facilities template to ships in a class.
 *
 * POST /.netlify/functions/ci-ship-class-facilities-apply
 */
const { requireAdmin } = require("./admin-auth");
const {
  ClassTpl,
  supabase,
  jsonResponse,
  fetchTemplateForClass,
  fetchLineShips
} = require("./lib/ci-ship-class-facilities-shared");
const {
  assertFacilitiesOnlyPatch,
  validateApplyRequest,
  executeApplyToShip,
  Replace
} = require("./lib/ci-ship-class-facilities-apply");

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

  let storedTemplate;
  try {
    storedTemplate = await fetchTemplateForClass(cruiseLineId, className);
  } catch (error) {
    return jsonResponse(error.status || 500, {
      success: false,
      error: "TEMPLATE_FETCH_FAILED",
      detail: String(error.message || error)
    }, "POST, OPTIONS");
  }

  const validation = validateApplyRequest({
    cruiseLineId,
    className,
    storedTemplate
  });
  if (!validation.ok) {
    const status = validation.error === "MISSING_TEMPLATE" ? 404 : 400;
    return jsonResponse(status, { success: false, error: validation.error }, "POST, OPTIONS");
  }

  let ships;
  try {
    ships = await fetchLineShips(cruiseLineId);
  } catch (error) {
    return jsonResponse(error.status || 500, {
      success: false,
      error: "SHIPS_FETCH_FAILED",
      detail: String(error.message || error)
    }, "POST, OPTIONS");
  }

  const targets = ClassTpl.listShipsInClass(Array.isArray(ships) ? ships : [], cruiseLineId, className, {
    activeOnly: true
  });
  if (!targets.length) {
    return jsonResponse(400, { success: false, error: "NO_TARGETS" }, "POST, OPTIONS");
  }

  const preview = Replace.summarizeApplyPreview(targets, validation.template);
  if (!preview.aggregate.hasChanges) {
    return jsonResponse(400, { success: false, error: "NO_CHANGES" }, "POST, OPTIONS");
  }

  const updated = [];
  const unchanged = [];
  const failed = [];

  for (const ship of targets) {
    const before = {
      passenger_capacity: ship.passenger_capacity,
      crew_count: ship.crew_count,
      deck_count: ship.deck_count,
      hero_image_url: ship.hero_image_url,
      facilities: ship.facilities
    };
    const execution = executeApplyToShip(ship, validation.template);
    if (!execution.changed) {
      unchanged.push({ id: ship.id, name: ship.name });
      continue;
    }
    try {
      const saved = await supabase("ci_cruise_ships?id=eq." + encodeURIComponent(ship.id), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ facilities: execution.facilities })
      });
      const row = Array.isArray(saved) ? saved[0] : saved;
      assertFacilitiesOnlyPatch(before, row || {});
      const scalarKeys = Object.keys(before.facilities || {}).filter(function (key) {
        return key !== "exclusive_areas" && key !== "specialty_features";
      });
      scalarKeys.forEach(function (key) {
        if (before.facilities[key] !== execution.facilities[key]) {
          throw new Error("Unexpected non-facilities mutation detected");
        }
      });
      updated.push({
        id: ship.id,
        name: ship.name,
        facilities: execution.facilities
      });
    } catch (error) {
      failed.push({
        id: ship.id,
        name: ship.name,
        error: String(error.message || error)
      });
    }
  }

  const success = failed.length === 0;
  return jsonResponse(failed.length && !updated.length ? 500 : 200, {
    success: success,
    mode: "class_template_replace",
    class_name: className,
    updated: updated,
    unchanged: unchanged,
    failed: failed,
    updated_count: updated.length,
    unchanged_count: unchanged.length,
    failed_count: failed.length
  }, "POST, OPTIONS");
};
