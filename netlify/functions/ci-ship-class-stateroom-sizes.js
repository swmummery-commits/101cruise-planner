/**
 * Admin load/save ship-class room size defaults.
 * Saving propagates defaults to class ships without overwriting ship overrides.
 *
 * GET  /.netlify/functions/ci-ship-class-stateroom-sizes?cruise_line_id=&class_name=
 * POST /.netlify/functions/ci-ship-class-stateroom-sizes
 */
const { requireAdmin } = require("./admin-auth");
const {
  ClassTpl,
  supabase,
  jsonResponse,
  fetchTemplateForClass
} = require("./lib/ci-ship-class-facilities-shared");

function parseSize(raw) {
  if (raw === null || raw === undefined) return "";
  const text = String(raw).trim().replace(/[–—]/g, "-");
  if (!text) return "";

  const single = text.match(/^(\d+(?:\.\d+)?)$/);
  if (single) {
    const value = Number(single[1]);
    return Number.isFinite(value) && value > 0 ? value : "";
  }

  const range = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (!range) return null;
  const min = Number(range[1]);
  const max = Number(range[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || max < min) return null;
  return min === max ? min : `${min}-${max}`;
}

function normalizeLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeBreakdown(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }
  return [];
}

function sanitizeDefaults(rows) {
  const cleaned = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const label = String(row && row.label || "").trim();
    const key = normalizeLabel(label);
    if (!label || !key || seen.has(key)) continue;

    const sqm = parseSize(row && row.sqm);
    const balconySqm = parseSize(row && row.balcony_sqm);
    if (sqm === null || balconySqm === null) {
      return { ok: false, error: "INVALID_SIZE", label };
    }

    seen.add(key);
    const next = { label };
    if (sqm !== "") next.sqm = sqm;
    if (balconySqm !== "") next.balcony_sqm = balconySqm;
    cleaned.push(next);
  }
  return { ok: true, rows: cleaned };
}

function applyDefaultValue(row, field, sourceField, value, forceClass) {
  const current = row[field];
  const source = String(row[sourceField] || "").trim();
  const currentBlank = current === "" || current === null || current === undefined;
  const sameAsDefault = value !== "" && value !== null && value !== undefined && String(current ?? "") === String(value);
  const mayInherit = forceClass || source === "class" || (!source && (currentBlank || sameAsDefault));
  if (!mayInherit) return false;

  if (value === "" || value === null || value === undefined) {
    if (source !== "class" && !forceClass && !currentBlank) return false;
    const hadValue = Object.prototype.hasOwnProperty.call(row, field) || Object.prototype.hasOwnProperty.call(row, sourceField);
    delete row[field];
    delete row[sourceField];
    return hadValue;
  }

  const changed = String(current ?? "") !== String(value) || source !== "class";
  row[field] = value;
  row[sourceField] = "class";
  return changed;
}

function applyDefaultsToShip(ship, defaultsByLabel, sourceShipId) {
  const rows = normalizeBreakdown(ship && ship.stateroom_breakdown).map((row) => ({ ...(row || {}) }));
  let changed = false;
  const forceClass = sourceShipId && String(ship.id) === String(sourceShipId);

  for (const row of rows) {
    const defaults = defaultsByLabel.get(normalizeLabel(row.label));
    if (!defaults) continue;
    changed = applyDefaultValue(row, "sqm", "sqm_source", defaults.sqm ?? "", forceClass) || changed;
    changed = applyDefaultValue(row, "balcony_sqm", "balcony_sqm_source", defaults.balcony_sqm ?? "", forceClass) || changed;
  }

  return { changed, rows };
}

async function authorize(event, methods) {
  try {
    await requireAdmin(event);
    return null;
  } catch (error) {
    return jsonResponse(error.statusCode || 401, {
      success: false,
      error: error.code || "UNAUTHORIZED",
      detail: error.message
    }, methods);
  }
}

exports.handler = async function (event) {
  const methods = "GET, POST, OPTIONS";
  if (event.httpMethod === "OPTIONS") return jsonResponse(200, {}, methods);
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "METHOD_NOT_ALLOWED" }, methods);
  }

  const authError = await authorize(event, methods);
  if (authError) return authError;

  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters || {};
    const cruiseLineId = String(params.cruise_line_id || "").trim();
    const className = String(params.class_name || "").trim();
    if (!cruiseLineId || !className || !ClassTpl.normalizeClassKey(className)) {
      return jsonResponse(400, { success: false, error: "INVALID_CLASS" }, methods);
    }
    try {
      const template = await fetchTemplateForClass(cruiseLineId, className);
      return jsonResponse(200, {
        success: true,
        class_name: className,
        stateroom_sizes: Array.isArray(template && template.stateroom_sizes) ? template.stateroom_sizes : []
      }, methods);
    } catch (error) {
      return jsonResponse(error.status || 500, {
        success: false,
        error: "LOAD_FAILED",
        detail: String(error.message || error)
      }, methods);
    }
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_error) {
    return jsonResponse(400, { success: false, error: "INVALID_JSON" }, methods);
  }

  const cruiseLineId = String(body.cruise_line_id || "").trim();
  const className = String(body.class_name || "").trim();
  const sourceShipId = String(body.source_ship_id || "").trim();
  const classKey = ClassTpl.normalizeClassKey(className);
  if (!cruiseLineId || !className || !classKey) {
    return jsonResponse(400, { success: false, error: "INVALID_CLASS" }, methods);
  }

  const cleaned = sanitizeDefaults(body.stateroom_sizes);
  if (!cleaned.ok) {
    return jsonResponse(400, {
      success: false,
      error: cleaned.error,
      detail: cleaned.label ? `Invalid room or balcony size for ${cleaned.label}.` : "Invalid size."
    }, methods);
  }

  try {
    const existing = await fetchTemplateForClass(cruiseLineId, className);
    const record = {
      cruise_line_id: cruiseLineId,
      class_name: className,
      class_key: classKey,
      stateroom_sizes: cleaned.rows,
      updated_at: new Date().toISOString()
    };

    let saved;
    if (existing && existing.id) {
      saved = await supabase("ci_ship_class_facility_templates?id=eq." + encodeURIComponent(existing.id), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ stateroom_sizes: cleaned.rows, updated_at: record.updated_at })
      });
    } else {
      saved = await supabase("ci_ship_class_facility_templates", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          ...record,
          exclusive_areas: [],
          specialty_features: []
        })
      });
    }

    const lineShips = await supabase(
      "ci_cruise_ships?cruise_line_id=eq."
        + encodeURIComponent(cruiseLineId)
        + "&select=id,name,ship_class,stateroom_breakdown"
    );
    const classShips = (Array.isArray(lineShips) ? lineShips : []).filter((ship) =>
      ClassTpl.shipClassesMatch(ship && ship.ship_class, className)
    );
    const defaultsByLabel = new Map(cleaned.rows.map((row) => [normalizeLabel(row.label), row]));

    let updatedShips = 0;
    for (const ship of classShips) {
      const applied = applyDefaultsToShip(ship, defaultsByLabel, sourceShipId);
      if (!applied.changed) continue;
      await supabase("ci_cruise_ships?id=eq." + encodeURIComponent(ship.id), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ stateroom_breakdown: applied.rows })
      });
      updatedShips += 1;
    }

    return jsonResponse(200, {
      success: true,
      template: Array.isArray(saved) ? saved[0] : saved,
      class_name: className,
      stateroom_sizes: cleaned.rows,
      class_ship_count: classShips.length,
      updated_ship_count: updatedShips
    }, methods);
  } catch (error) {
    return jsonResponse(error.status || 500, {
      success: false,
      error: "SAVE_FAILED",
      detail: String(error.message || error)
    }, methods);
  }
};
